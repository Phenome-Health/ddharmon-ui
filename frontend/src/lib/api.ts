// Tiny typed fetch client for the ddharmon harmonization API (replaces Orval codegen).
// With VITE_STATIC=1 the client reads bundled fixtures under <base>/static-data instead of /api,
// so the SPA runs fully static (sample runs + exports, no backend, no key) for a preview deploy.
import type { DemosResponse, ExportFormat, JobResult, JobSummary, RunConfig } from "@/types";

const BASE = "/api/harmonize";
export const IS_STATIC = import.meta.env.VITE_STATIC === "1";
const STATIC_BASE = `${import.meta.env.BASE_URL}static-data`;

const STATIC_MSG = "This is a static preview — new runs are disabled. Explore the sample runs under Runs.";
const EXPORT_EXT: Record<ExportFormat, string> = {
  eitl_tsv: "eitl.tsv",
  decisions_csv: "decisions.csv",
  records_json: "records.json",
  notebook_py: "py.ipynb",
  notebook_r: "r.ipynb",
};

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns }),
    }),
  );
}

export async function startHarmonize(
  _files: File[],
  _config: RunConfig,
  _apiKey?: string,
): Promise<{ jobId: string }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  const fd = new FormData();
  for (const f of _files) fd.append("files", f);
  fd.append("config", JSON.stringify(_config));
  // BYOK: the key rides as a transport-only header, never in the config body (which is persisted as the
  // job's run_config). The backend is expected to read it per-request and hold it in memory for the job
  // only — never write it to disk/logs. Not set for preview runs (no LLM). Don't set Content-Type here:
  // fetch derives the multipart boundary from the FormData body.
  const headers: Record<string, string> = {};
  if (_apiKey) headers["x-anthropic-key"] = _apiKey;
  return json(await fetch(`${BASE}/batch`, { method: "POST", body: fd, headers }));
}

export async function getResult(jobId: string): Promise<JobResult> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/result-${jobId}.json`));
  return json(await fetch(`${BASE}/result/${jobId}`));
}

export async function listJobs(): Promise<JobSummary[]> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/jobs.json`));
  return json(await fetch(`${BASE}/jobs`));
}

export async function deleteJob(jobId: string): Promise<void> {
  if (IS_STATIC) return;
  await fetch(`${BASE}/jobs/${jobId}`, { method: "DELETE" });
}

export async function submitVerdict(
  jobId: string,
  recordId: string,
  decision: "approve" | "refine" | "reject",
  note = "",
): Promise<void> {
  if (IS_STATIC) return; // preview: decisions are not persisted
  await json(
    await fetch(`${BASE}/jobs/${jobId}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordId, decision, note }),
    }),
  );
}

export function exportUrl(jobId: string, format: ExportFormat): string {
  if (IS_STATIC) return `${STATIC_BASE}/exports/${jobId}.${EXPORT_EXT[format]}`;
  return `${BASE}/jobs/${jobId}/export?format=${format}`;
}

export async function listDemos(): Promise<DemosResponse> {
  if (IS_STATIC) return json(await fetch(`${STATIC_BASE}/demos.json`));
  return json(await fetch(`${BASE}/demos`));
}

export async function startDemo(_datasets: string[]): Promise<{ jobId: string }> {
  if (IS_STATIC) throw new Error(STATIC_MSG);
  return json(
    await fetch(`${BASE}/demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasets: _datasets }),
    }),
  );
}
