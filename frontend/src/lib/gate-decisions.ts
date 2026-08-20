import type { ArtifactStaleRef } from "@/types";

/**
 * The gate-decision ALGEBRA: the registered kinds, their identity rule, the content keys, the hydration
 * merge and the staleness derivation. Every function here is pure.
 *
 * WHY IT IS NOT IN THE HOOK. Two reasons, both load-bearing. (1) These are the properties that have to be
 * ASSERTED — the identity table matching the backend's, a content key matching the backend's byte for byte,
 * a merge that cannot revert a local write, a staleness comparison that never double-applies — and a hook
 * can only be asserted by rendering something. `frontend/` has no component test runner, so logic reachable
 * only through React is logic that ships unasserted. (2) The hook imports the API client, which reads
 * `import.meta.env` at module scope and therefore cannot be imported outside a bundle at all.
 *
 * `hooks/use-gate-decisions.ts` re-exports all of it, so a screen still has one import.
 */

// --- the registered kinds, mirrored from backend/artifact_kinds.py -------------------------------------

/** The seven gate-decision kinds. Spelled out, exactly as the backend registry spells them out. */
export const GATE_DECISION_KINDS = [
  "gate1_group_scope",
  "gate1_regroup",
  "gate2_candidate_pick",
  "gate2_relation",
  "gate3_spec_edit",
  "gate4_export_selection",
  "composite_swap",
] as const;
export type GateDecisionKind = (typeof GATE_DECISION_KINDS)[number];

/**
 * How each kind derives its item key: the payload fields, in order, that name THE THING DECIDED.
 *
 * A table rather than seven closures, because "does each kind key on the thing decided" is the one
 * property a reader of this file needs to check. It mirrors `_DECISION_IDENTITY_FIELDS` in
 * `backend/artifact_kinds.py` field for field and order for order — a client that computed a different
 * item key would write a second row for the same decision instead of replacing it, so
 * `tests/test_content_drift.py::test_the_gate_decision_identity_table_matches_the_frontend` pins the two
 * together.
 */
export const DECISION_IDENTITY_FIELDS: Record<GateDecisionKind, readonly string[]> = {
  gate1_group_scope: ["groupId"],
  gate1_regroup: ["memberId"], // the VARIABLE moved: two variables moved in two tabs are two rows
  gate2_candidate_pick: ["groupId"],
  gate2_relation: ["groupId", "targetId"], // a group legitimately relates to several targets
  gate3_spec_edit: ["sourceVariable"],
  gate4_export_selection: ["recordId"],
  composite_swap: ["scoreName", "componentName"],
};

/** The shared option-space payload every gate decision carries, plus its kind's own identity fields. */
export interface GateDecision {
  /** Content key over the identifiers that WERE available. */
  optionSetKey: string;
  /** The identifier currently taken. `""` means "none of these". */
  chosen: string;
  /** Identifiers only — the full payloads already live in the run result. */
  alternatives: string[];
  /** What this decision was made downstream OF, and the upstream's content key AT THAT TIME. */
  upstream?: { kind: GateDecisionKind; itemKey: string; contentKey: string };
  [field: string]: unknown;
}

/** What `GET /jobs/{id}/artifacts` returns under `artifacts`, narrowed to the decision kinds. */
export type GroupedDecisions = Partial<Record<GateDecisionKind, GateDecision[]>> | null | undefined;

/** kind → itemKey → decision. The shape every screen reads. */
export type DecisionIndex = Record<string, Record<string, GateDecision>>;

// --- sha256, by hand ----------------------------------------------------------------------------------

/**
 * SHA-256 over UTF-8, synchronous.
 *
 * Hand-written for one reason: the keys have to match the BACKEND's byte for byte (the server compares a
 * client-written `upstream.contentKey` against its own `content_key` of the upstream row, so a different
 * hash would mark every downstream decision stale forever), and the platform's `crypto.subtle.digest` is
 * ASYNC — which would force staleness to be awaited and therefore stored, the exact defect guard 4 exists
 * to prevent. `tests/e2e/gate-decisions.spec.ts` asserts it against `node:crypto` on five inputs, and
 * pins two real keys against the Python functions by literal. Same reasoning as 08-11's hand-written ULID:
 * fifteen lines beats a dependency for a well-specified primitive.
 */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + choose + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + next[i]) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

// --- the keys -----------------------------------------------------------------------------------------

const UNIT_SEPARATOR = "\x1f";

/**
 * A content key over the identifiers that were AVAILABLE, independent of their order.
 *
 * Order-independent because a retrieval returning the same candidates in a different order is the same
 * option space, and marking every downstream decision stale for a re-ranking nobody acted on is the noise
 * that teaches a reviewer to ignore the notice.
 */
export function optionSetKey(alternatives: Iterable<unknown>): string {
  const ids = [...new Set([...alternatives].map((a) => String(a).trim()).filter(Boolean))].sort();
  return sha256Hex(ids.join(UNIT_SEPARATOR)).slice(0, 16);
}

/**
 * The key a DOWNSTREAM decision persists in order to detect that this decision changed.
 *
 * Covers the option set AND the chosen value, because both are corrections a downstream decision must
 * notice: a re-retrieval that changes the candidates, and a re-pick among the same candidates. The second
 * is the commonest correction there is.
 */
export function contentKey(decision: { chosen?: unknown; alternatives?: unknown }): string {
  const chosen = String(decision.chosen ?? "");
  const alternatives = Array.isArray(decision.alternatives) ? decision.alternatives : [];
  return sha256Hex(optionSetKey(alternatives) + UNIT_SEPARATOR + chosen).slice(0, 16);
}

/** The item key for one decision — the thing decided, never the gate it was decided at. */
export function decisionItemKey(kind: GateDecisionKind, payload: Record<string, unknown>): string {
  return DECISION_IDENTITY_FIELDS[kind]
    .map((field) => {
      const value = String(payload[field] ?? "").trim();
      if (!value) throw new Error(`a ${kind} decision needs a ${field}`);
      return value;
    })
    .join("|");
}

// --- reading, hydrating, deriving ---------------------------------------------------------------------

/** Group the server's payload lists into kind → itemKey → decision. A row with no identity is skipped. */
export function indexDecisions(grouped: GroupedDecisions): DecisionIndex {
  const index: DecisionIndex = {};
  for (const kind of GATE_DECISION_KINDS) {
    for (const payload of grouped?.[kind] ?? []) {
      try {
        (index[kind] ??= {})[decisionItemKey(kind, payload)] = payload;
      } catch {
        continue; // a row written under a different shape — never raise on a read
      }
    }
  }
  return index;
}

/** GUARD 2 — the local value wins, so a click made before the payload arrived is not reverted. */
export function mergeDecisionIndex(server: DecisionIndex, local: DecisionIndex): DecisionIndex {
  const merged: DecisionIndex = {};
  for (const kind of new Set([...Object.keys(server), ...Object.keys(local)])) {
    merged[kind] = { ...server[kind], ...local[kind] };
  }
  return merged;
}

/** GUARD 3 — an empty payload carries nothing, so hydrating from it would only clear real state. */
export function isEmptyDecisionPayload(grouped: GroupedDecisions): boolean {
  return !GATE_DECISION_KINDS.some((kind) => (grouped?.[kind] ?? []).length > 0);
}

/** GUARD 1 — once per run, not once per progress frame. */
export function shouldHydrate({
  jobId,
  hydratedJobId,
  payload,
}: {
  jobId: string;
  hydratedJobId: string | null;
  payload: GroupedDecisions;
}): boolean {
  if (!jobId || hydratedJobId === jobId) return false;
  return !isEmptyDecisionPayload(payload);
}

/**
 * Which stored decisions are stale, DERIVED by comparison. Never a column, never a flag.
 *
 * An upstream row that is ABSENT is not reported: the reviewer may simply have cleared it, and absence is
 * not evidence of change — a notice fired on a deletion nobody made is how a reviewer learns to ignore
 * the notice.
 */
export function deriveStaleness(index: DecisionIndex): ArtifactStaleRef[] {
  const currentKeys = new Map<string, string>();
  for (const [kind, byItem] of Object.entries(index)) {
    for (const [itemKey, payload] of Object.entries(byItem)) {
      currentKeys.set(`${kind} ${itemKey}`, contentKey(payload));
    }
  }
  const stale: ArtifactStaleRef[] = [];
  for (const [kind, byItem] of Object.entries(index)) {
    for (const [itemKey, payload] of Object.entries(byItem)) {
      const upstream = payload.upstream;
      if (!upstream) continue;
      const now = currentKeys.get(`${upstream.kind} ${upstream.itemKey}`);
      if (now === undefined || now === upstream.contentKey) continue;
      stale.push({
        kind,
        itemKey,
        upstreamKind: upstream.kind,
        upstreamItemKey: upstream.itemKey,
        reason: "the upstream decision changed after this one was made",
      });
    }
  }
  return stale;
}

/** The item keys of one kind that are stale — what a screen renders as "this decision is out of date". */
export function staleItemKeys(stale: ArtifactStaleRef[], kind: GateDecisionKind): string[] {
  return stale.filter((s) => s.kind === kind).map((s) => s.itemKey);
}

/** Which items of a kind the reviewer has decided. DERIVED, so it survives a reload (R6). */
export function touchedItemKeys(index: DecisionIndex, kind: GateDecisionKind): string[] {
  return Object.keys(index[kind] ?? {});
}

/**
 * Whether a write stays in the browser rather than reaching the store.
 *
 * `pinned === undefined` routes to the SANDBOX, deliberately. The demo flag is still false on the first
 * render (the stream hook's first `jobState` has an empty `config`), and the safe default for an unknown
 * run is the one that cannot write to somebody else's shared row.
 */
export function writesGoToSandbox({ pinned, isStatic }: { pinned?: boolean; isStatic: boolean }): boolean {
  return isStatic || pinned !== false;
}
