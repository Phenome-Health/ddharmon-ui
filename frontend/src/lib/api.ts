// Tiny typed fetch client for the ddharmon harmonization API (replaces Orval codegen).
// With VITE_STATIC=1 the client reads bundled fixtures under <base>/static-data instead of /api,
// so the SPA runs fully static (sample runs + exports, no backend, no key) for a preview deploy.
import type {
  ArtifactListResponse,
  ArtifactWriteResponse,
  CheckpointState,
  CompositeSpec,
  DemosResponse,
  GatePosition,
  ExportFormat,
  GenCDE,
  JobResult,
  JobSummary,
  ModelInfo,
  RunConfig,
  ScoreDefinition,
  UIRecord,
} from "@/types";

const BASE = "/api/harmonize";
/** The six screens in order — the client-side half of contract.py's `GatePosition` literal. */
export const GATE_ORDER: GatePosition[] = ["setup", "gate0", "gate1", "gate2", "gate3", "gate4"];
export const IS_STATIC = import.meta.env.VITE_STATIC === "1";

// Setup's post-Start destination lives one file over, in `lib/gate-routes.ts`, and is re-exported here so
// it is found beside `GATE_ORDER` where it belongs by subject. It cannot be DEFINED here: this module
// reads `import.meta.env` two lines up, which makes it unimportable from a Playwright spec, and the whole
// point of that helper is that a test can assert it. See `gate-routes.ts` for the measurement.
export { RETIRED_GATE, setupPathFor, startedPathFor } from "./gate-routes";
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

export async function cancelJob(jobId: string, mode: "keep" | "discard" = "discard"): Promise<{ cancelled: boolean }> {
  // Request a stop for an in-flight run. `mode` chooses what happens to work in flight: "discard" (default)
  // aborts at the next checkpoint with no results; "keep" lets the current stage finish (delivering its
  // partial result) and skips the rest. Either way the run ends "cancelled"; the SSE stream delivers that
  // terminal state and closes. In static preview there's no backend — the caller (the stream hook) stops the
  // client-side replay instead (mode is moot: a replay has no cost).
  if (IS_STATIC) return { cancelled: true };
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to stop a run.");
  return json(await fetch(`${BASE}/jobs/${jobId}/cancel?mode=${mode}`, { method: "POST", headers: await authed() }));
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

/**
 * Copy a run into one you own — how work done on the read-only demo is kept.
 *
 * `artifacts` carries the browser's sandbox edits (see lib/sandbox.ts), which is why "clone with my
 * changes" needs no server-side guest session: the client has held them all along and simply posts them.
 * Requires an account; the copy has to belong to someone.
 */
export async function cloneJob(
  jobId: string,
  body: { displayName?: string; artifacts?: { kind: string; payload: Record<string, unknown> }[] } = {},
): Promise<{ jobId: string }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to keep a copy of this run.");
  return json(
    await fetch(`${BASE}/jobs/${jobId}/clone`, {
      method: "POST",
      headers: await authed({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Derive a composite/derived-variable spec against this run's concepts (opt-in, BYOK, metadata-only).
 *
 * Supply the score's definition ONE of three ways: `sourceText` (pasted methods/component table),
 * `sourceRef` (a URL, bare DOI, or GitHub repo — fetched and bounded server-side), or `definition` (a
 * previous response's definition, re-derived without paying for extraction again). `overrides` pins a
 * component to a concept id or drops it with null; with every component pinned the re-derive makes NO LLM
 * call, so the reviewer's accept/swap/drop loop is free.
 */
export async function deriveComposite(
  jobId: string,
  body: {
    sourceText?: string;
    sourceRef?: string;
    definition?: ScoreDefinition;
    overrides?: Record<string, string | null>;
    hybrid?: boolean;
  },
  apiKey?: string,
): Promise<CompositeSpec> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to derive a composite variable.");
  const headers = await authed({
    "content-type": "application/json",
    ...(apiKey ? { "x-anthropic-key": apiKey } : {}),
  });
  return json(await fetch(`${BASE}/jobs/${jobId}/composite`, { method: "POST", headers, body: JSON.stringify(body) }));
}

/**
 * Extract text from an uploaded PDF or Word (.docx) document ($0 — no LLM call), so it can be reviewed
 * BEFORE a derivation is paid for. Publisher PDFs are often an access-check interstitial, and a component
 * table may not survive extraction at all; finding that out should be free. Word matters because a score's
 * item table usually lives in the supplement, and supplements are routinely .docx.
 */
export async function extractCompositeDocument(
  jobId: string,
  file: File,
): Promise<{ text: string; provenance: string; sha256: string; nChars: number }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to read a document.");
  const form = new FormData();
  form.append("file", file);
  return json(
    await fetch(`${BASE}/jobs/${jobId}/composite/extract`, { method: "POST", headers: await authed(), body: form }),
  );
}

/**
 * Extract a score's definition text from a document with NO RUN REQUIRED ($0, no LLM call).
 *
 * The job-independent sibling of `extractCompositeDocument`, added by 08-11 and consumed at Setup. Setup
 * needs it precisely because there is no run yet: the whole value of the extraction step is finding out
 * for free whether the document you have can define the score you want, and a publisher PDF is often an
 * access-check interstitial whose component table does not survive extraction at all. Requiring a run id
 * would mean starting a run to discover that.
 *
 * Returns the document's TEXT, not its components: transcribing text into components is one model call
 * (core's `extract_score_definition`), which is not free and therefore does not belong on the screen whose
 * promise is that nothing has been charged yet.
 */
export async function extractScoreDocument(
  file: File,
): Promise<{ text: string; provenance: string; sha256: string; nChars: number }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to read a document.");
  const form = new FormData();
  form.append("file", file);
  return json(await fetch(`${BASE}/score/extract`, { method: "POST", headers: await authed(), body: form }));
}

/**
 * Re-adjudicate EXACTLY the concept groups a human named (STGD-16) — the one gate action that STARTS PAID
 * WORK. Every other gate decision rides the generic artifact route, because recording a decision is storage.
 *
 * `groupIds` is required and must be non-empty, and this client never widens it. The backend refuses an
 * empty list too, but the prohibition is a UI-layer one as much as a backend one: re-splitting every
 * flagged group BECAUSE it was flagged is an auto-resolution of an over-merge with no human decision
 * behind it, which core's own `readjudicate` docstring forbids the pipeline from doing.
 *
 * The server carries three refusals — a pinned demo outright, a run that did not opt in at creation, and
 * an empty id list — and the opt-in refusal names itself so the caller can render the honest
 * "not enabled for this run" state instead of a generic error.
 */
export async function readjudicateGroups(
  jobId: string,
  groupIds: string[],
  apiKey?: string,
): Promise<{ jobId: string; groupIds: string[]; nRecords: number }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (groupIds.length === 0) throw new Error("Name the concept groups to re-adjudicate.");
  const headers = await authed({
    "content-type": "application/json",
    ...(apiKey ? { "x-anthropic-key": apiKey } : {}),
  });
  return json(
    await fetch(`${BASE}/jobs/${jobId}/readjudicate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ groupIds }),
    }),
  );
}

export async function getResult(jobId: string): Promise<JobResult> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/result-${jobId}.json`));
  return json(await fetch(`${BASE}/result/${jobId}`, { headers: await authed() }));
}

/**
 * Where a run is parked and what it is parked with — the gate screens' entry read.
 *
 * In the static build there is no backend, so this is DERIVED from the bundled result fixture rather than
 * faked: a fixture that carries `gatePosition` describes a paused run, and one that does not describes a
 * finished one. Inventing a paused state the fixture does not claim would make the e2e walk assert against
 * something no real run produces.
 */
export async function getCheckpoint(jobId: string): Promise<CheckpointState> {
  if (IS_STATIC) {
    const job = await getResult(jobId);
    const gate = job.result?.gatePosition ?? job.gatePosition ?? null;
    return {
      jobId,
      status: job.status,
      gatePosition: gate,
      resumeGate: gate ?? "setup",
      nextGate: gate ? (GATE_ORDER[GATE_ORDER.indexOf(gate) + 1] ?? null) : null,
      resultVersion: job.resultVersion ?? job.result?.resultVersion ?? 0,
      costSoFar: job.costSoFar ?? job.result?.cost?.actualUsd ?? 0,
      result: job.result,
    };
  }
  return json(await fetch(`${BASE}/checkpoint/${jobId}`, { headers: await authed() }));
}

/**
 * Commit the current gate and continue the run to the next boundary — the Continue action.
 *
 * Disabled in the static build for the same reason `startHarmonize` is: this is the SPEND path, and a
 * preview with no backend has nothing to spend against. The gate walk itself is fully explorable there.
 */
export async function resumeRun(jobId: string, apiKey?: string): Promise<{ jobId: string; target: string }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  const extra: Record<string, string> = {};
  if (apiKey) extra["x-anthropic-key"] = apiKey;
  return json(await fetch(`${BASE}/resume/${jobId}`, { method: "POST", headers: await authed(extra) }));
}

export async function listJobs(): Promise<JobSummary[]> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/jobs.json`));
  return json(await fetch(`${BASE}/jobs`, { headers: await authed() }));
}

export async function deleteJob(jobId: string): Promise<void> {
  if (IS_STATIC) return;
  await fetch(`${BASE}/jobs/${jobId}`, { method: "DELETE", headers: await authed() });
}

// --- user artifacts (the generic registered-kind route) -----------------------------------------------
// One surface for every kind of user-generated work attached to a run, mirroring the backend: a new
// persisted feature registers its kind in `backend/artifact_kinds.py` and is reachable here immediately.
// The gate-decision layer (`hooks/use-gate-decisions.ts`) is the only caller today, and it deliberately
// does NOT get an endpoint of its own per gate — six bespoke write paths would be six new unauthenticated
// surfaces to police instead of one.

/**
 * Everything the caller has stored against this run, grouped by kind, plus which of it is stale.
 *
 * `stale` is DERIVED server-side on every read, never a stored field. A pinned demo resolves to `{}` by
 * design — a shared row holds nobody's work — so a demo's decisions are read from the browser sandbox.
 */
export async function listArtifacts(jobId: string): Promise<ArtifactListResponse> {
  if (IS_STATIC) return { kinds: [], artifacts: {}, stale: [] };
  return json(await fetch(`${BASE}/jobs/${jobId}/artifacts`, { headers: await authed() }));
}

/**
 * Upsert one artifact. Its identity — and so what it replaces — is derived server-side from its kind.
 *
 * `base` is the `updatedAt` this client last saw for that identity. Supplying it is what lets the response
 * distinguish "your write created this" from "your write replaced a value written by another session";
 * omitting it over an existing gate decision is itself reported as a conflict, because a client that
 * cannot say what it replaced has replaced something blind.
 */
export async function putArtifact(
  jobId: string,
  kind: string,
  payload: Record<string, unknown>,
  base?: number,
): Promise<ArtifactWriteResponse> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to save decisions.");
  const query = base === undefined ? "" : `?base=${encodeURIComponent(base)}`;
  return json(
    await fetch(`${BASE}/jobs/${jobId}/artifacts/${encodeURIComponent(kind)}${query}`, {
      method: "PUT",
      headers: await authed({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    }),
  );
}

/** Remove one artifact — the "I have no decision here" state, distinct from a decision of "none of these". */
export async function deleteArtifact(jobId: string, kind: string, itemKey: string): Promise<void> {
  if (IS_STATIC) return;
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to save decisions.");
  const res = await fetch(
    `${BASE}/jobs/${jobId}/artifacts/${encodeURIComponent(kind)}/${encodeURIComponent(itemKey)}`,
    { method: "DELETE", headers: await authed() },
  );
  if (!res.ok && res.status !== 204) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { detail?: string }).detail || `${res.status} ${res.statusText}`);
  }
}

export async function submitVerdict(
  jobId: string,
  recordId: string,
  decision: "approve" | "refine" | "reject" | "clear",
  note = "",
  axis: "match" | "transform" | "gencde" = "match",
  sourceVariable?: string,
  edited?: Partial<GenCDE>,
): Promise<void> {
  // Three-axis verdict body: { recordId, decision, note, axis, sourceVariable?, edited? }. axis="match" is the
  // concept→CDE verdict; axis="transform" is a PER-SOURCE-VARIABLE recode-spec verdict, so it also carries
  // the "cohort:var" `sourceVariable` it applies to (required server-side for the transform axis); axis="gencde"
  // is the verdict on the synthesized GenCDE itself (novel route, once per record, no sourceVariable). A gencde
  // "refine" may carry the reviewer's corrected GenCDE fields in `edited` (merged into the run's GenCDE
  // server-side). All axes take the full approve|refine|reject triad, plus "clear" to un-set a previously-recorded
  // verdict (toggle-off undo). Kept out of types.ts on purpose (decisions' keys are optional).
  if (IS_STATIC) return; // preview: decisions are not persisted
  // Guest (gate on, no token): the demo is read-only — saving verdicts needs a sign-in. Fail with a clear
  // message instead of a raw 401 from the gated endpoint.
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to save decisions.");
  await json(
    await fetch(`${BASE}/jobs/${jobId}/verdict`, {
      method: "POST",
      headers: await authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ recordId, decision, note, axis, sourceVariable, edited }),
    }),
  );
}

export async function regenerateSpecs(jobId: string, recordId: string, apiKey?: string): Promise<{ record: UIRecord }> {
  // Refine → regen: after a GenCDE's value domain is corrected, its member→GenCDE recodes go stale. This
  // re-runs JUST those recodes for the one record (a targeted one-off LLM pass over the corrected domain) and
  // returns the record with fresh transforms. BYOK: the key is sent transport-only for this call, exactly
  // like generateAnalysisIdeas — never persisted. Guests (gate on, no token) must sign in first.
  if (IS_STATIC) throw new Error(STATIC_MSG);
  if (AUTH_ENABLED && !_tokenGetter) throw new Error("Sign in to regenerate recodes.");
  const headers = await authed(apiKey ? { "x-anthropic-key": apiKey } : {});
  // recordId is a group id (e.g. "c9#g0") — encode it so the "#" isn't parsed as a URL fragment.
  const rid = encodeURIComponent(recordId);
  return json(await fetch(`${BASE}/jobs/${jobId}/records/${rid}/regenerate-specs`, { method: "POST", headers }));
}

export function exportUrl(jobId: string, format: ExportFormat): string {
  if (IS_STATIC) return `${STATIC_BASE}/exports/${jobId}.${EXPORT_EXT[format]}`;
  const base = `${BASE}/jobs/${jobId}/export?format=${format}`;
  // A download href can't set an Authorization header; when the SSO gate is on, ride the freshest cached
  // token as a query param (the backend accepts ?token= for the same reason the SSE endpoint does).
  return _lastToken ? `${base}&token=${encodeURIComponent(_lastToken)}` : base;
}

/**
 * The pre-flight's prepared-dictionary export: ONE uploaded dictionary, returned with the preparation step's
 * output appended to the reviewer's own columns.
 *
 * Returns `null` in the static preview, which has no backend to re-read the upload from. A dead link that
 * downloads a 404 page named `.csv` is worse than a control that says why it is unavailable, so the caller
 * renders the reason instead of the button.
 */
export function preparedExportUrl(jobId: string, cohort: string): string | null {
  if (IS_STATIC) return null;
  const base = `${BASE}/jobs/${jobId}/prepared.csv?cohort=${encodeURIComponent(cohort)}`;
  // Same reason as `exportUrl`: a download href cannot carry an Authorization header.
  return _lastToken ? `${base}&token=${encodeURIComponent(_lastToken)}` : base;
}

/**
 * One mapped dictionary, as it is described to the pre-Start export endpoints.
 *
 * The SAME payload shape `/batch` takes, deliberately: an export that accepts a mapping the run would
 * reject (or the reverse) sends a reviewer a clean-looking download for a file that cannot be run.
 */
export interface MappedDictionary {
  file: File;
  cohortName: string;
  columnRoles: Record<string, string>;
}

/** What a pre-Start export hands back: the bytes, the filename to save under, and the load-time counts. */
export interface EmbeddingDownload {
  blob: Blob;
  filename: string;
  /** Data rows in the reviewer's own file. */
  rows: number;
  /** Variables the loader produced. Lower than `rows` means names repeated and rows were collapsed. */
  variables: number;
  collapsed: number;
  nothingToEmbed: number;
  repeatedNames: string[];
}

/**
 * A FILENAME FROM THE RESPONSE, not from the request. The server rebuilds it from a safe alphabet
 * (the upload name is user-supplied), so echoing our own guess back would drop that sanitisation on the
 * floor — and a download is exactly the wrong place to write an unsanitised name to disk.
 */
function filenameFrom(res: Response, fallback: string): string {
  const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
  return match?.[1] || fallback;
}

async function failureOf(res: Response, fallback: string): Promise<never> {
  // The endpoints answer a bad mapping or an unreadable file with a STATED reason, and that reason is the
  // only actionable thing the reviewer gets — so it is surfaced rather than replaced with a status code.
  let detail = "";
  try {
    detail = String(((await res.json()) as { detail?: unknown }).detail ?? "");
  } catch {
    detail = "";
  }
  throw new Error(detail || fallback);
}

/**
 * ONE dictionary's own rows with the exact clustering input appended — before any run exists, for $0.
 *
 * A POST rather than a link, because the file has not been uploaded yet: it lives in the browser until
 * Start, so it rides in the request body. That also means no `<a href download>` can fetch it and the
 * caller works with a Blob.
 */
export async function embeddingCsv(dict: MappedDictionary): Promise<EmbeddingDownload> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  const fd = new FormData();
  fd.append("files", dict.file, dict.file.name);
  fd.append(
    "config",
    JSON.stringify({
      dictionaries: [
        { filename: dict.file.name, cohortName: dict.cohortName, columnRoles: dict.columnRoles },
      ],
    }),
  );
  const res = await fetch(`${BASE}/dictionary/embedding.csv`, {
    method: "POST",
    body: fd,
    headers: await authed(),
  });
  if (!res.ok) await failureOf(res, "This dictionary could not be exported");
  const num = (h: string): number => Number(res.headers.get(h) ?? 0) || 0;
  const repeated = (res.headers.get("x-ddharmon-repeated-names") ?? "").split(",").filter(Boolean);
  return {
    blob: await res.blob(),
    filename: filenameFrom(res, `${dict.cohortName}_embedding.csv`),
    rows: num("x-ddharmon-rows"),
    variables: num("x-ddharmon-variables"),
    collapsed: num("x-ddharmon-collapsed"),
    nothingToEmbed: num("x-ddharmon-nothing-to-embed"),
    repeatedNames: repeated,
  };
}

/** Every mapped dictionary as ONE workbook, a sheet each. Same computation as `embeddingCsv`, N files. */
export async function embeddingWorkbook(dicts: MappedDictionary[]): Promise<{ blob: Blob; filename: string }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  const fd = new FormData();
  for (const d of dicts) fd.append("files", d.file, d.file.name);
  fd.append(
    "config",
    JSON.stringify({
      dictionaries: dicts.map((d) => ({
        filename: d.file.name,
        cohortName: d.cohortName,
        columnRoles: d.columnRoles,
      })),
    }),
  );
  const res = await fetch(`${BASE}/dictionary/embedding.xlsx`, {
    method: "POST",
    body: fd,
    headers: await authed(),
  });
  if (!res.ok) await failureOf(res, "The workbook could not be built");
  return { blob: await res.blob(), filename: filenameFrom(res, "ddharmon_embedding_text.xlsx") };
}

/** Hand a Blob to the browser as a saved file, then release the object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick, not immediately: Safari has not started the download when `click()` returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
