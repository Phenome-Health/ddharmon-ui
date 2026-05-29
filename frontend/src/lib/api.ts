// Tiny typed fetch client for the ddharmon harmonization API (replaces Orval codegen).
import type { JobResult, JobSummary, RunConfig } from "@/types";

const BASE = "/api/harmonize";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { detail?: string }).detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function detectRoles(columns: string[]): Promise<{ columnRoles: Record<string, string>; confidence: number }> {
  return json(
    await fetch(`${BASE}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns }),
    }),
  );
}

export async function startHarmonize(files: File[], config: RunConfig): Promise<{ jobId: string }> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  fd.append("config", JSON.stringify(config));
  return json(await fetch(`${BASE}/batch`, { method: "POST", body: fd }));
}

export async function getResult(jobId: string): Promise<JobResult> {
  return json(await fetch(`${BASE}/result/${jobId}`));
}

export async function listJobs(): Promise<JobSummary[]> {
  return json(await fetch(`${BASE}/jobs`));
}

export async function deleteJob(jobId: string): Promise<void> {
  await fetch(`${BASE}/jobs/${jobId}`, { method: "DELETE" });
}

export async function submitVerdict(
  jobId: string,
  subClusterId: string,
  decision: "approve" | "refine" | "reject",
  note = "",
): Promise<void> {
  await json(
    await fetch(`${BASE}/jobs/${jobId}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subClusterId, decision, note }),
    }),
  );
}

export function exportUrl(jobId: string, format: "eitl_tsv" | "buckets_json" | "decisions_csv"): string {
  return `${BASE}/jobs/${jobId}/export?format=${format}`;
}
