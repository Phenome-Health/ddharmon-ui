// Demo sandbox — where work done on the canonical demo lives.
//
// The demo is one shared, read-only run: the server refuses every write to it (403), because a single row
// that every user can see cannot hold any one user's work without showing it to the rest. So demo edits
// stay in the browser, and keeping them means cloning the demo into a run of your own.
//
// sessionStorage, not localStorage, is the deliberate choice: the promise is "nothing is saved", and a
// tab-lifetime store keeps that literally true — close the tab and it is gone, with no caveat to explain.
// It survives a refresh, which is the only thing an in-memory-only sandbox gets wrong.
//
// Everything here is best-effort. sessionStorage throws in private-mode Safari and when a quota is hit, and
// a demo doodle is never worth breaking the page over.

const PREFIX = "ddharmon.sandbox.";

/** One tab's unsaved work on a demo run — the same axes the workbench tracks. */
export type SandboxState = {
  decisions?: Record<string, string>;
  transformDecisions?: Record<string, string>;
  gencdeDecisions?: Record<string, string>;
  notes?: Record<string, string>;
};

function key(jobId: string): string {
  return `${PREFIX}${jobId}`;
}

export function readSandbox(jobId: string): SandboxState {
  if (!jobId) return {};
  try {
    return JSON.parse(sessionStorage.getItem(key(jobId)) || "{}") as SandboxState;
  } catch {
    return {};
  }
}

/** Merge a patch into this run's sandbox. Returns silently if storage is unavailable or full. */
export function writeSandbox(jobId: string, patch: SandboxState): void {
  if (!jobId) return;
  try {
    sessionStorage.setItem(key(jobId), JSON.stringify({ ...readSandbox(jobId), ...patch }));
  } catch {
    /* private mode / quota — the sandbox is a convenience, never a requirement */
  }
}

export function clearSandbox(jobId: string): void {
  try {
    sessionStorage.removeItem(key(jobId));
  } catch {
    /* ignore */
  }
}

/** Whether this run has any unsaved sandbox work — drives "clone with my changes" vs "clone fresh". */
export function hasSandboxWork(jobId: string): boolean {
  const s = readSandbox(jobId);
  return [s.decisions, s.transformDecisions, s.gencdeDecisions].some((m) => m && Object.keys(m).length > 0);
}

/** How many verdicts are held locally — shown so "your changes" is a concrete number, not a vague promise. */
export function sandboxVerdictCount(jobId: string): number {
  const s = readSandbox(jobId);
  return (
    Object.keys(s.decisions ?? {}).length +
    Object.keys(s.transformDecisions ?? {}).length +
    Object.keys(s.gencdeDecisions ?? {}).length
  );
}

/**
 * The sandbox as clone-request artifacts — the payload shape `POST /jobs/{id}/clone` accepts.
 *
 * This is what makes "sign in, then keep my work" need no server-side guest session and no identity merge:
 * the browser has been holding the edits all along, so it simply posts them with the clone.
 */
export function sandboxArtifacts(jobId: string): { kind: string; payload: Record<string, unknown> }[] {
  const s = readSandbox(jobId);
  const notes = s.notes ?? {};
  const out: { kind: string; payload: Record<string, unknown> }[] = [];

  for (const [recordId, decision] of Object.entries(s.decisions ?? {})) {
    out.push({ kind: "verdict", payload: { recordId, axis: "match", decision, note: notes[recordId] ?? "" } });
  }
  for (const [composite, decision] of Object.entries(s.transformDecisions ?? {})) {
    // The workbench keys transform verdicts `${recordId}:${sourceVariable}`, and a source variable is itself
    // "cohort:var" — so split on the FIRST colon only.
    const at = composite.indexOf(":");
    if (at < 0) continue;
    out.push({
      kind: "verdict",
      payload: {
        recordId: composite.slice(0, at),
        axis: "transform",
        sourceVariable: composite.slice(at + 1),
        decision,
        note: "",
      },
    });
  }
  for (const [recordId, decision] of Object.entries(s.gencdeDecisions ?? {})) {
    out.push({ kind: "verdict", payload: { recordId, axis: "gencde", decision, note: notes[recordId] ?? "" } });
  }
  return out;
}
