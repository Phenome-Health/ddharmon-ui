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

/** Exported so a test can assert the storage contract without re-deriving the key format. */
export const SANDBOX_PREFIX = "ddharmon.sandbox.";
const PREFIX = SANDBOX_PREFIX;

/** kind → itemKey → the registered gate-decision payload. */
export type SandboxGateDecisions = Record<string, Record<string, Record<string, unknown>>>;

/** One tab's unsaved work on a demo run — the same axes the workbench tracks. */
export type SandboxState = {
  decisions?: Record<string, string>;
  transformDecisions?: Record<string, string>;
  gencdeDecisions?: Record<string, string>;
  notes?: Record<string, string>;
  /**
   * The six gate screens' decisions.
   *
   * Nested by kind rather than flattened into one map because that IS the shape the registered-kind
   * artifact route takes, so `sandboxArtifacts` hands them to `POST /jobs/{id}/clone` unchanged — which is
   * what makes "sign in, then keep my work" need no server-side guest session.
   */
  gateDecisions?: SandboxGateDecisions;
};

function key(jobId: string): string {
  return `${PREFIX}${jobId}`;
}

/**
 * A sandbox state with one gate decision set, or removed when `payload` is null. PURE — no storage.
 *
 * Separated from the storage wrapper so the reader and the writer are assertable without a browser: the
 * decision layer's whole demo path is this function plus `gateDecisionsOf`, and a test that can only reach
 * them through `sessionStorage` proves the medium rather than the logic.
 */
export function withGateDecision(
  state: SandboxState,
  kind: string,
  itemKey: string,
  payload: Record<string, unknown> | null,
): SandboxState {
  const byKind = { ...(state.gateDecisions?.[kind] ?? {}) };
  if (payload === null) delete byKind[itemKey];
  else byKind[itemKey] = payload;
  return { ...state, gateDecisions: { ...state.gateDecisions, [kind]: byKind } };
}

/** The gate decisions a sandbox state holds. */
export function gateDecisionsOf(state: SandboxState): SandboxGateDecisions {
  return state.gateDecisions ?? {};
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

/** How many gate decisions are held locally, across every kind. */
function gateDecisionCount(state: SandboxState): number {
  return Object.values(state.gateDecisions ?? {}).reduce((n, byItem) => n + Object.keys(byItem).length, 0);
}

/** Whether this run has any unsaved sandbox work — drives "clone with my changes" vs "clone fresh". */
export function hasSandboxWork(jobId: string): boolean {
  const s = readSandbox(jobId);
  return (
    [s.decisions, s.transformDecisions, s.gencdeDecisions].some((m) => m && Object.keys(m).length > 0) ||
    gateDecisionCount(s) > 0
  );
}

/** How many verdicts are held locally — shown so "your changes" is a concrete number, not a vague promise. */
export function sandboxVerdictCount(jobId: string): number {
  const s = readSandbox(jobId);
  return (
    Object.keys(s.decisions ?? {}).length +
    Object.keys(s.transformDecisions ?? {}).length +
    Object.keys(s.gencdeDecisions ?? {}).length +
    // Gate decisions count too: they are the same reviewer's work, and a count that omitted them would
    // offer "clone with my changes" while under-reporting what is carried.
    gateDecisionCount(s)
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
  // Gate decisions go out UNCHANGED: each is already a registered kind's payload, and the clone route
  // stores `{kind, payload}` through the same generic upsert the live write path uses. Re-shaping them here
  // would put a second copy of the identity rule in the one place nothing tests it.
  for (const [kind, byItem] of Object.entries(s.gateDecisions ?? {})) {
    for (const payload of Object.values(byItem)) out.push({ kind, payload });
  }
  return out;
}
