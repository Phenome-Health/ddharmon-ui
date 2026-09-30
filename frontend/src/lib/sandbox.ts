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

// --- reading: a missing, corrupt or cleared entry is a NORMAL state, not an error ---------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A `Record<string, string>` section, or undefined when it is anything else. */
function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/**
 * A sandbox state from whatever storage held, PURE — `{}` for anything that is not one.
 *
 * Shape-checked rather than cast, because the next reader is the decision hook's first render: a stored `null`
 * or a gate section that is not an object would throw THERE, inside React, and take the gate screen down with
 * it. Storage is written by this file, but it is also cleared by the browser, edited by a curious visitor and
 * left behind by an older build — so "whatever is there" is the honest input, and "nothing held" is always a
 * valid answer (08-18: cleared mid-walk continues from empty).
 */
export function sandboxStateFrom(raw: string | null | undefined): SandboxState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: SandboxState = {};
  for (const field of ["decisions", "transformDecisions", "gencdeDecisions", "notes"] as const) {
    const m = stringMap(parsed[field]);
    if (m) out[field] = m;
  }
  if (isRecord(parsed.gateDecisions)) {
    const gate: SandboxGateDecisions = {};
    for (const [kind, byItem] of Object.entries(parsed.gateDecisions)) {
      if (!isRecord(byItem)) continue;
      gate[kind] = Object.fromEntries(
        Object.entries(byItem).filter((e): e is [string, Record<string, unknown>] => isRecord(e[1])),
      );
    }
    out.gateDecisions = gate;
  }
  return out;
}

export function readSandbox(jobId: string): SandboxState {
  if (!jobId) return {};
  try {
    return sandboxStateFrom(sessionStorage.getItem(key(jobId)));
  } catch {
    return {};
  }
}

// --- writing, and telling whoever displays it --------------------------------------------------------------

/**
 * The window event a sandbox write or clear raises, so a banner shows the CURRENT count.
 *
 * Why an event and not a prop: the gate screens write through several decision hooks, none of which knows the
 * banner exists, and the banner lives in the shell. Reading storage on render instead is the shipped workbench
 * banner's "one click behind, forever" bug (USER-DATA-PERSISTENCE-PLAN §14) — the write lands after the render.
 */
export const SANDBOX_EVENT = "ddharmon:sandbox";

function announce(jobId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(SANDBOX_EVENT, { detail: { jobId } }));
  } catch {
    /* no window (a Node test) — nothing is displaying it */
  }
}

/** Call `onChange` whenever this run's sandbox is written or cleared in this tab. Returns the unsubscribe. */
export function onSandboxChange(jobId: string, onChange: () => void): () => void {
  const listener = (e: Event) => {
    if ((e as CustomEvent<{ jobId?: string }>).detail?.jobId === jobId) onChange();
  };
  try {
    window.addEventListener(SANDBOX_EVENT, listener);
    return () => window.removeEventListener(SANDBOX_EVENT, listener);
  } catch {
    return () => {};
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
  announce(jobId);
}

export function clearSandbox(jobId: string): void {
  try {
    sessionStorage.removeItem(key(jobId));
  } catch {
    /* ignore */
  }
  announce(jobId);
}

// --- how much is held --------------------------------------------------------------------------------------

/**
 * How many edits a sandbox state holds — verdicts plus gate decisions, across every kind. PURE.
 *
 * Notes are not counted: a note rides a verdict and is carried with it, so counting it too would offer "clone
 * with my changes" for a sandbox whose only content is carried by nothing.
 */
export function sandboxWorkCount(state: SandboxState): number {
  const verdicts = [state.decisions, state.transformDecisions, state.gencdeDecisions].reduce(
    (n, m) => n + Object.keys(m ?? {}).length,
    0,
  );
  const gate = Object.values(state.gateDecisions ?? {}).reduce((n, byItem) => n + Object.keys(byItem).length, 0);
  return verdicts + gate;
}

/** Whether this run has any unsaved sandbox work — drives "clone with my changes" vs "clone fresh". */
export function hasSandboxWork(jobId: string): boolean {
  return sandboxWorkCount(readSandbox(jobId)) > 0;
}

/** How many edits are held locally — shown so "your changes" is a concrete number, not a vague promise. */
export function sandboxVerdictCount(jobId: string): number {
  // Gate decisions count too: they are the same reviewer's work, and a count that omitted them would offer
  // "clone with my changes" while under-reporting what is carried.
  return sandboxWorkCount(readSandbox(jobId));
}

/**
 * Every run this tab holds unsaved work for, most work first — what the sign-in prompt looks through.
 *
 * Found by the storage PREFIX rather than a remembered list, because the prompt runs after a sign-in that may
 * have reloaded the page (an OAuth round trip does), and a tab-lifetime key is the only thing that survives it.
 */
export function sandboxJobsWithWork(): { jobId: string; count: number }[] {
  const out: { jobId: string; count: number }[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const count = sandboxWorkCount(sandboxStateFrom(sessionStorage.getItem(k)));
      if (count > 0) out.push({ jobId: k.slice(PREFIX.length), count });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.count - a.count || a.jobId.localeCompare(b.jobId));
}

// --- the clone bridge ----------------------------------------------------------------------------------------

/** One clone-request artifact: exactly the `{kind, payload}` the registered-kind upsert takes. */
export type SandboxArtifact = { kind: string; payload: Record<string, unknown> };

/**
 * A sandbox state as clone-request artifacts — the payload shape `POST /jobs/{id}/clone` accepts. PURE.
 *
 * This is what makes "sign in, then keep my work" need no server-side guest session and no identity merge:
 * the browser has been holding the edits all along, so it simply posts them with the clone.
 */
export function sandboxArtifactsOf(s: SandboxState): SandboxArtifact[] {
  const notes = s.notes ?? {};
  const out: SandboxArtifact[] = [];

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
  // Gate decisions go out UNCHANGED and for EVERY kind held — iterated, never listed. Each is already a
  // registered kind's payload, and the clone route validates it with the same registry the live write path uses
  // (08-18: all-or-nothing, before the copy exists). A hand-list of kinds here is exactly how a kind added later
  // (`gate2_relation`, mid-phase) would be dropped at sign-in with no error anywhere; `sandbox.spec.ts` checks
  // this against the backend registry itself.
  for (const [kind, byItem] of Object.entries(s.gateDecisions ?? {})) {
    for (const payload of Object.values(byItem)) out.push({ kind, payload });
  }
  return out;
}

/** This run's sandbox as clone-request artifacts. */
export function sandboxArtifacts(jobId: string): SandboxArtifact[] {
  return sandboxArtifactsOf(readSandbox(jobId));
}

/** The two explicit ways to keep the demo. There is no third, implicit one (no fork-on-write). */
export type CloneFlavour = "fresh" | "changes";

/** The body `cloneJob` posts for a flavour. PURE — `fresh` carries nothing, `changes` carries everything held. */
export function cloneRequestFor(
  flavour: CloneFlavour,
  state: SandboxState,
  displayName: string,
): { displayName: string; artifacts: SandboxArtifact[] } {
  return { displayName: displayName.trim(), artifacts: flavour === "changes" ? sandboxArtifactsOf(state) : [] };
}

const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Whether a proposed run name is already one of the caller's runs (case- and spacing-insensitive). */
export function cloneNameTaken(name: string, existing: Iterable<string>): boolean {
  const n = normName(name);
  return [...existing].some((e) => normName(e) === n);
}

/**
 * The clone's default name, and whether the obvious one was already taken. PURE.
 *
 * A collision is REPORTED, not only avoided: the server keys runs by id, so two "(my copy)" runs never overwrite
 * one another — but two identical names on the Runs page is a silent confusion, and quietly renaming the copy is
 * a silent decision. So the dialog says which name was taken and proposes the next free one, editable.
 */
export function uniqueCloneName(
  sourceName: string,
  existing: Iterable<string>,
): { name: string; collided: boolean; taken: string | null } {
  const names = [...existing];
  const candidate = (n: number) => `${sourceName} (my copy${n > 1 ? ` ${n}` : ""})`;
  const first = candidate(1);
  if (!cloneNameTaken(first, names)) return { name: first, collided: false, taken: null };
  let n = 2;
  while (cloneNameTaken(candidate(n), names)) n++;
  return { name: candidate(n), collided: true, taken: first };
}

/**
 * Where the reviewer lands after cloning: the same screen, on their own copy. PURE.
 *
 * Only a path that names the SOURCE run is rewritten — anything else lands on the copy's run page, never on a
 * screen of an unrelated run that merely shares the route shape.
 */
export function clonedPathFor(currentPath: string, sourceJobId: string, newJobId: string): string {
  const m = currentPath.match(/^\/(run|job)\/([^/?#]+)(\/[^?#]*)?/);
  if (m && decodeURIComponent(m[2]) === sourceJobId) return `/${m[1]}/${newJobId}${m[3] ?? ""}`;
  return `/job/${newJobId}`;
}

// --- sign-in: offer both flavours when there is work, and nothing at all when there is none --------------------

/**
 * The tab-lifetime marker that THIS tab browsed as a guest. What makes a sign-in recognisable as "the guest just
 * signed in" — the React state that knew is gone after an OAuth round trip; a tab-lifetime key is not.
 */
export const GUEST_SESSION_KEY = "ddharmon.guest-session";

export function markGuestSession(): void {
  try {
    sessionStorage.setItem(GUEST_SESSION_KEY, "1");
  } catch {
    /* best-effort: without it the sign-in prompt is simply not offered; the banner still is */
  }
}

export function wasGuestSession(): boolean {
  try {
    return sessionStorage.getItem(GUEST_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearGuestSession(): void {
  try {
    sessionStorage.removeItem(GUEST_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Whether signing in should offer the clone, and for which run. PURE — null means "no prompt at all".
 *
 * Only for a FULL-access sign-in by a tab that was a guest, holding work on a run that IS a demo:
 *  - no work → no prompt (UI-SPEC §8.5; a prompt with nothing to carry teaches the reviewer to dismiss the one
 *    that matters);
 *  - a read-only account is still a guest here — it cannot own a copy, so offering one would fail;
 *  - `demoJobIds` filters out a stray entry for a real run, which `writesGoToSandbox` can leave on a run's first
 *    render: "cloning" it would fork a run the reviewer already owns.
 * The offer is a question; nothing is posted until the reviewer picks a flavour.
 */
export function signInCloneOffer({
  authEnabled,
  isAuthed,
  isGuest,
  wasGuest,
  withWork,
  demoJobIds,
}: {
  authEnabled: boolean;
  isAuthed: boolean;
  isGuest: boolean;
  wasGuest: boolean;
  withWork: { jobId: string; count: number }[];
  demoJobIds: ReadonlySet<string>;
}): { jobId: string; count: number } | null {
  if (!authEnabled || !isAuthed || isGuest || !wasGuest) return null;
  const offer = withWork.filter((w) => w.count > 0 && demoJobIds.has(w.jobId)).sort((a, b) => b.count - a.count)[0];
  return offer ?? null;
}

// --- the contract's copy (UI-SPEC §8.4, §8.5) -----------------------------------------------------------------

/** The persistent banner's sentence, verbatim from UI-SPEC §8.5 ("Leaving the demo sandbox"). */
export const SANDBOX_BANNER_COPY =
  "This is the shared demo. Your changes are yours alone, are not saved, and disappear when you close the tab — clone it to keep them.";

/**
 * What a guest reads at an action that genuinely needs an account (UI-SPEC §8.4), naming THAT action — every
 * gate is walkable on the demo without one, so the copy must not read as "you cannot use this".
 */
export function guestAuthCopy(action: string): { title: string; body: string } {
  return {
    title: "Sign in to do this.",
    body: `You can walk every gate on the demo without an account — ${action} needs one.`,
  };
}
