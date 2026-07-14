// Tiny typed fetch client for the ddharmon harmonization API (replaces Orval codegen).
// With VITE_STATIC=1 the client reads bundled fixtures under <base>/static-data instead of /api,
// so the SPA runs fully static (sample runs + exports, no backend, no key) for a preview deploy.
import type { DemosResponse, ExportFormat, JobResult, JobSummary, ModelInfo, RunConfig } from "@/types";

const BASE = "/api/harmonize";
export const IS_STATIC = import.meta.env.VITE_STATIC === "1";
const STATIC_BASE = `${import.meta.env.BASE_URL}static-data`;

// Whether the Clerk SSO gate is configured for this build (single source of truth; src/auth.tsx re-exports
// it). Lets calls distinguish a signed-out "guest" (gate on, no token) from "no auth at all" (static/dev).
export const AUTH_ENABLED =
  Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) &&
  !(import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS_AUTH === "true");

const STATIC_MSG = "This is a static preview — new runs are disabled. Explore the sample runs under Runs.";
const EXPORT_EXT: Record<ExportFormat, string> = {
  eitl_tsv: "eitl.tsv",
  decisions_csv: "decisions.csv",
  records_json: "records.json",
  notebook_py: "py.ipynb",
  notebook_r: "r.ipynb",
};

// --- auth (Clerk SSO) ----------------------------------------------------------------------------
// The auth layer (src/auth.tsx) injects a token getter here when the SSO gate is active. When it is
// null — the static/marketing build, local dev, or any deploy without a Clerk key — every call below
// behaves EXACTLY as before: no Authorization header, no ?token, no change.
let _tokenGetter: (() => Promise<string | null>) | null = null;
let _lastToken: string | null = null; // freshest token, kept current by the bridge for synchronous href use

export function setTokenGetter(fn: (() => Promise<string | null>) | null): void {
  _tokenGetter = fn;
}
export function setLastToken(token: string | null): void {
  _lastToken = token;
}

/** Merge an `Authorization: Bearer` header when the gate is active; a no-op (returns `base`) otherwise. */
async function authed(base: Record<string, string> = {}): Promise<Record<string, string>> {
  if (!_tokenGetter) return base;
  const token = await _tokenGetter();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

/** Append `?token=` for URLs used where a header can't be set (SSE EventSource). No-op when the gate is off. */
export async function appendAuthToken(url: string): Promise<string> {
  if (!_tokenGetter) return url;
  const token = await _tokenGetter();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { detail?: string }).detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function detectRoles(columns: string[]): Promise<{ columnRoles: Record<string, string>; confidence: number }> {
  if (IS_STATIC) return { columnRoles: {}, confidence: 0 };
  return json(
    await fetch(`${BASE}/detect`, {
      method: "POST",
      headers: await authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ columns }),
    }),
  );
}

// Built-in fallback catalog for the model picker — used in static preview (no backend) and mirrors the
// backend's fallback when no LiteLLM proxy is configured. Kept small and provider-diverse so the picker
// is visibly multi-provider even without a proxy.
const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8" },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o" },
  { id: "gemini/gemini-1.5-pro", provider: "gemini", label: "Gemini 1.5 Pro" },
];

export async function listModels(): Promise<{ models: ModelInfo[]; source: string }> {
  // The picker's catalog: the backend proxies GET /model/info from the LiteLLM proxy when one is
  // configured, else returns a built-in fallback. In static preview there is no backend, so serve the
  // same fallback client-side.
  if (IS_STATIC) return { models: FALLBACK_MODELS, source: "static" };
  return json(await fetch(`${BASE}/models`, { headers: await authed() }));
}

export async function startHarmonize(
  _files: File[],
  _config: RunConfig,
  _provider?: string,
  _apiKey?: string,
): Promise<{ jobId: string }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  const fd = new FormData();
  for (const f of _files) fd.append("files", f);
  fd.append("config", JSON.stringify(_config));
  // BYOK: the key rides as a transport-only header, never in the config body (which is persisted as the
  // job's run_config). The backend reads it per-request and holds it in memory for the job only — never
  // written to disk/logs. Not set for preview runs / local models (no provider key needed). Don't set
  // Content-Type here: fetch derives the multipart boundary from the FormData body. `authed()` adds the
  // Clerk Bearer when the gate is on. `x-provider` tells the backend which provider the key is for; the
  // engine still routes on the model tag in the config.
  const extra: Record<string, string> = {};
  if (_apiKey) extra["x-provider-key"] = _apiKey;
  if (_provider) extra["x-provider"] = _provider;
  const headers = await authed(extra);
  return json(await fetch(`${BASE}/batch`, { method: "POST", body: fd, headers }));
}

export async function rerunJob(jobId: string, apiKey?: string): Promise<{ jobId: string }> {
  // Re-execute a past run from its server-retained uploads as a NEW owned run. BYOK: batch/sync runs need
  // the key re-supplied (it's never persisted, so the Runs page can't have it cached) — sent transport-only,
  // exactly like startHarmonize; preview runs need none. Guests (gate on, no token) must sign in first.
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to re-run.");
  const headers = await authed(apiKey ? { "x-anthropic-key": apiKey } : {});
  return json(await fetch(`${BASE}/jobs/${jobId}/rerun`, { method: "POST", headers }));
}

export async function generateAnalysisIdeas(
  jobId: string,
  apiKey?: string,
  regenerate = false,
): Promise<{ ideas: import("@/types").AnalysisIdea[]; cached: boolean; nConcepts?: number }> {
  // Opt-in, BYOK LLM pass suggesting downstream analyses (metadata-only; suggests, never runs). The key is
  // sent transport-only for this one call, exactly like startHarmonize; never persisted.
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to generate analysis ideas.");
  const q = regenerate ? "?regenerate=true" : "";
  const headers = await authed(apiKey ? { "x-anthropic-key": apiKey } : {});
  return json(await fetch(`${BASE}/jobs/${jobId}/analysis-ideas${q}`, { method: "POST", headers }));
}

export async function getResult(jobId: string): Promise<JobResult> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/result-${jobId}.json`));
  return json(await fetch(`${BASE}/result/${jobId}`, { headers: await authed() }));
}

export async function listJobs(): Promise<JobSummary[]> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/jobs.json`));
  return json(await fetch(`${BASE}/jobs`, { headers: await authed() }));
}

export async function deleteJob(jobId: string): Promise<void> {
  if (IS_STATIC) return;
  await fetch(`${BASE}/jobs/${jobId}`, { method: "DELETE", headers: await authed() });
}

export async function submitVerdict(
  jobId: string,
  recordId: string,
  decision: "approve" | "refine" | "reject",
  note = "",
  axis: "match" | "transform" | "gencde" = "match",
  sourceVariable?: string,
): Promise<void> {
  // Three-axis verdict body: { recordId, decision, note, axis, sourceVariable? }. axis="match" is the
  // concept→CDE verdict; axis="transform" is a PER-SOURCE-VARIABLE recode-spec verdict, so it also carries
  // the "cohort:var" `sourceVariable` it applies to (required server-side for the transform axis); axis="gencde"
  // is the verdict on the synthesized GenCDE itself (novel route, once per record, no sourceVariable). All axes
  // take the full approve|refine|reject triad. Kept out of types.ts on purpose (decisions' keys are optional).
  if (IS_STATIC) return; // preview: decisions are not persisted
  // Guest (gate on, no token): the demo is read-only — saving verdicts needs a sign-in. Fail with a clear
  // message instead of a raw 401 from the gated endpoint.
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to save decisions.");
  await json(
    await fetch(`${BASE}/jobs/${jobId}/verdict`, {
      method: "POST",
      headers: await authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ recordId, decision, note, axis, sourceVariable }),
    }),
  );
}

export function exportUrl(jobId: string, format: ExportFormat): string {
  if (IS_STATIC) return `${STATIC_BASE}/exports/${jobId}.${EXPORT_EXT[format]}`;
  const base = `${BASE}/jobs/${jobId}/export?format=${format}`;
  // A download href can't set an Authorization header; when the SSO gate is on, ride the freshest cached
  // token as a query param (the backend accepts ?token= for the same reason the SSE endpoint does).
  return _lastToken ? `${base}&token=${encodeURIComponent(_lastToken)}` : base;
}

export async function listDemos(): Promise<DemosResponse> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/demos.json`));
  return json(await fetch(`${BASE}/demos`, { headers: await authed() }));
}

export async function startDemo(_datasets: string[]): Promise<{ jobId: string }> {
  // Static preview (Netlify): no backend. The demo is a bundled snapshot replayed client-side (see
  // useHarmonizeStream). Return the deterministic demo job id that maps to static-data/result-<id>.json —
  // matches the backend's stable id scheme so the same route works with or without a server.
  if (IS_STATIC) return { jobId: "demo-" + [..._datasets].map((d) => d.toLowerCase()).sort().join("_") };
  return json(
    await fetch(`${BASE}/demo`, {
      method: "POST",
      headers: await authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ datasets: _datasets }),
    }),
  );
}
