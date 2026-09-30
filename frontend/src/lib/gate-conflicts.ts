import type { ArtifactWriteResponse } from "@/types";
import {
  GATE_DECISION_KINDS,
  decisionItemKey,
  type GateDecision,
  type GateDecisionKind,
} from "@/lib/gate-decisions";

/**
 * Two tabs on one run: the client half of "last write wins, WITH a notice" (UI-SPEC §8.4, 08-28 3f).
 *
 * The server replaces a decision whatever version the writer names, and reports it (`conflict` on the PUT) when
 * the writer named a version other than the one stored — or none. So the whole client contract is: remember
 * which version of each decision this tab was SHOWN, send it with the next save, and show the reviewer the
 * report when one comes back. Two defects sat on it (audit Theme C): the read served no version, so the first
 * save after every reload was blind and came back "conflicted"; and no screen showed a conflict at all.
 *
 * PURE, AND NOT IN THE HOOK, for the reason `lib/gate-decisions.ts` gives: `frontend/` has no component test
 * runner, and the hook imports the API client (which reads `import.meta.env` at module scope), so logic reachable
 * only through it ships unasserted. `tests/e2e/gate-conflicts.spec.ts` runs two writers through this file.
 */

/** A row's stored version, as `GET .../artifacts` serves it on every row (`backend/artifacts.py::UPDATED_AT`). */
export const UPDATED_AT = "updatedAt";

/** The two-tab notice, as the backend returns it (UI-SPEC §8.4 copy, verbatim, server-side). */
export interface GateDecisionConflict {
  replacedUpdatedAt: number;
  message: string;
  /**
   * Whether this tab named the version it was replacing.
   *
   * `false` means the save was BLIND: it replaced a decision this tab never loaded — one another tab or session
   * made after this page's read. Since the read serves each row's version, that is the only way a blind save
   * over an existing decision happens, so it is a real conflict, not the reload artefact it used to be.
   */
  sentBase: boolean;
  /** Which decision the save replaced, when the writer knows (the notice's `data-kind`, for a bug report). */
  kind?: GateDecisionKind;
  itemKey?: string;
}

/** What travels on the window event: the conflict plus the run it happened on. */
export interface GateConflictDetail extends GateDecisionConflict {
  jobId: string;
}

// --- the read: every row's version, split off its payload -------------------------------------------------

/**
 * Split each served row's `updatedAt` off its payload: the payloads the screens index, and kind → itemKey →
 * version for the bases.
 *
 * The version is the ROW's, never a decision field. Left in the payload it would ride into the next save's body
 * (a caller that spreads a decision into `extra` would echo it) — the server strips it, but the index would still
 * hold two answers to "which version is this". Only the gate-decision kinds are split: they are the kinds with an
 * identity rule here, and the only ones the server reports conflicts for.
 */
export function splitServedRows(grouped: Record<string, unknown> | null | undefined): {
  rows: Record<string, unknown>;
  versions: Partial<Record<GateDecisionKind, Record<string, number>>>;
} {
  const rows: Record<string, unknown> = { ...(grouped ?? {}) };
  const versions: Partial<Record<GateDecisionKind, Record<string, number>>> = {};
  for (const kind of GATE_DECISION_KINDS) {
    const list = rows[kind];
    if (!Array.isArray(list)) continue;
    rows[kind] = list.map((row) => {
      if (!row || typeof row !== "object") return row;
      const { [UPDATED_AT]: version, ...payload } = row as Record<string, unknown>;
      if (typeof version === "number") {
        try {
          (versions[kind] ??= {})[decisionItemKey(kind, payload)] = version;
        } catch {
          // a row written under a different shape has no identity to key a base on — never raise on a read
        }
      }
      return payload;
    });
  }
  return { rows, versions };
}

/**
 * Seed this tab's bases from a read, WITHOUT replacing one it already holds.
 *
 * A base this tab holds came from its own save, which is newer than any read that landed after it was issued; the
 * read's older version in its place would make this tab's next save of that decision look like a conflict.
 */
export function seedBases(
  bases: Record<string, number>,
  versions: Record<string, number> | undefined,
): Record<string, number> {
  const seeded = { ...bases };
  for (const [itemKey, version] of Object.entries(versions ?? {})) {
    if (!(itemKey in seeded)) seeded[itemKey] = version;
  }
  return seeded;
}

// --- the write: name the version shown, remember the one produced -------------------------------------------

/**
 * Save one decision naming the version this tab holds, and record the version the save produced.
 *
 * `bases` is MUTATED (it is the hook's ref: no render depends on it). Resolves to the conflict to show, or null.
 * Throws whatever `put` throws — the caller rolls back and toasts, as for any failed save.
 */
export async function writeAgainstBase(
  put: (payload: GateDecision, base: number | undefined) => Promise<ArtifactWriteResponse>,
  bases: Record<string, number>,
  itemKey: string,
  payload: GateDecision,
  { kind }: { kind?: GateDecisionKind } = {},
): Promise<GateDecisionConflict | null> {
  const sentBase = bases[itemKey];
  const stored = await put(payload, sentBase);
  bases[itemKey] = stored.updatedAt;
  if (!stored.conflict) return null;
  return {
    ...stored.conflict,
    sentBase: sentBase !== undefined,
    ...(kind ? { kind } : {}),
    itemKey,
  };
}

// --- the notice: one per screen, fed by every decision hook on it -------------------------------------------

/**
 * The window event a decision hook announces a conflict on, and the one notice in `GateShell` listens for.
 *
 * AN EVENT, NOT A CONTEXT OR A STORE, because the writers are many and scattered: Gate 1 alone mounts five decision
 * hooks (and the score panel a sixth), each holding its own conflict. One notice has to hear all of them without
 * every gate page threading a provider — and a DOM event is also the one channel the static e2e suite, whose
 * backend-less build can never produce a real conflict, can drive to prove the notice renders on every screen.
 */
export const GATE_CONFLICT_EVENT = "ddharmon:gate-decision-conflict";

/** Announce a conflict to the screen's notice. A no-op where there is no window (Node). */
export function announceConflict(jobId: string, conflict: GateDecisionConflict): void {
  if (typeof window === "undefined") return;
  const detail: GateConflictDetail = { ...conflict, jobId };
  window.dispatchEvent(new CustomEvent<GateConflictDetail>(GATE_CONFLICT_EVENT, { detail }));
}

/** The conflict an event carries IF it is this run's — a notice answers to its own run only. */
export function conflictForJob(event: { detail?: unknown }, jobId: string): GateConflictDetail | null {
  const d = event.detail as Partial<GateConflictDetail> | null | undefined;
  if (!d || typeof d !== "object" || !jobId || d.jobId !== jobId) return null;
  if (typeof d.message !== "string") return null;
  return d as GateConflictDetail;
}
