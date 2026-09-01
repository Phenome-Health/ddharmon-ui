import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { IS_STATIC, deleteArtifact, listArtifacts, putArtifact } from "@/lib/api";
import {
  UNIT_SEPARATOR,
  contentKey,
  decisionItemKey,
  deriveStaleness,
  indexDecisions,
  mergeDecisionIndex,
  optionSetKey,
  shouldHydrate,
  staleItemKeys,
  writesGoToSandbox,
  type DecisionIndex,
  type GateDecision,
  type GateDecisionKind,
  type GroupedDecisions,
} from "@/lib/gate-decisions";
import { gateDecisionsOf, readSandbox, withGateDecision, writeSandbox } from "@/lib/sandbox";

/**
 * The ONE decision layer all six gate screens sit on.
 *
 * WHY IT IS ONE HOOK. The shipped workbench discovered three hydration guards the hard way, and it still
 * carries a fourth defect (its staleness lives in `useState` and is lost on reload). Six gates would
 * multiply that surface six times, so the guards live here once and every screen composes from them. The
 * hook knows nothing about ledgers, candidates or specs: it takes a run, a registered kind and the thing
 * decided, and that is all.
 *
 * THE FOUR GUARDS, each of which exists because of a real bug:
 *
 *  1. **Hydrate once per run.** The progress stream re-pushes the whole job every half second; a
 *     re-hydrate on every frame would fight the reviewer's clicks.
 *  2. **Merge with the LOCAL value winning.** A decision clicked before the payload arrives must survive
 *     the merge instead of being reverted to its saved value.
 *  3. **Skip an EMPTY payload.** This is what keeps the demo safe WITHOUT testing a demo flag that is
 *     still false on the first render — the stream hook's first `jobState` has an empty `config`, which is
 *     the trap that made the original sandbox hydration miss. A pinned run resolves to no artifacts, so
 *     its payload is always empty and the sandbox is never overwritten.
 *  4. **Staleness and touched-state are DERIVED, never stored.** R6 requires a correction to be visible
 *     after reload, and a flag in component state is gone the moment the page reloads. Both are computed
 *     from the persisted decisions on every read — which is the shipped workbench's open defect, fixed
 *     here rather than ported.
 *
 * The algebra it is built on lives in `lib/gate-decisions.ts` and is re-exported below, so a screen has one
 * import and the logic still has a test.
 */
export * from "@/lib/gate-decisions";

// --- the hook -----------------------------------------------------------------------------------------

/** The two-tab notice, as the backend returns it (UI-SPEC §8.4 copy, verbatim, server-side). */
export interface GateDecisionConflict {
  replacedUpdatedAt: number;
  message: string;
  /**
   * Whether this client told the server which version it was replacing.
   *
   * `false` means the write was blind — which the server reports as a conflict by design, and which is
   * also what every first write after a reload looks like, because `GET .../artifacts` serves payloads
   * without their `updatedAt`. A screen should treat a blind conflict as weaker evidence than a
   * versioned one rather than showing the same alarm for both.
   */
  sentBase: boolean;
}

export interface WriteOptions {
  /** The identifier taken. `""` means "none of these". */
  chosen: string;
  /** The identifiers that were available. */
  alternatives: string[];
  /** The decision this one was made downstream of; its content key is resolved from what is held here. */
  upstream?: { kind: GateDecisionKind; itemKey: string };
  /** Anything else the kind's payload carries (a note, an edited spec). */
  extra?: Record<string, unknown>;
}

/** What a refused write says. One sentence, so every screen reports the same reason. */
export const FROZEN_GATE_MESSAGE =
  "This gate is a record — the run has already moved past it, so its decisions can no longer be changed.";

export interface UseGateDecisions {
  /** itemKey → decision, for the requested kind. */
  decisions: Record<string, GateDecision>;
  /** Every kind's decisions, for a screen that reads an upstream gate's choices. */
  all: DecisionIndex;
  itemKey(fields: Record<string, unknown>): string;
  isStale(itemKey: string): boolean;
  staleItemKeys: string[];
  isTouched(itemKey: string): boolean;
  touchedCount: number;
  /** True while this run's persisted decisions are still loading. */
  loading: boolean;
  /** True when writes stay in the browser (a pinned demo, or a backend-less build). */
  local: boolean;
  /** True when the run has moved past this gate: the screen is a record and every write refuses. */
  frozen: boolean;
  write(fields: Record<string, unknown>, options: WriteOptions): Promise<void>;
  clear(fields: Record<string, unknown>): Promise<void>;
  conflict: GateDecisionConflict | null;
  dismissConflict(): void;
}

export function useGateDecisions(
  jobId: string,
  kind: GateDecisionKind,
  {
    pinned,
    enabled = true,
    frozen = false,
  }: {
    pinned?: boolean;
    enabled?: boolean;
    /**
     * The run has already PASSED this gate, so the screen is a RECORD (08-16c Task 2).
     *
     * ENFORCED HERE, not merely rendered as disabled controls. "A disabled-looking control that still
     * submits is worse than an enabled one": a past gate's decisions have already been consumed by the
     * pipeline, so a write that got through would either fail confusingly or silently corrupt a finished
     * stage. This hook is the ONE path every gate decision takes, which makes it the one place the
     * guarantee can be made once instead of re-asserted on each screen's every control.
     */
    frozen?: boolean;
  } = {},
): UseGateDecisions {
  const local = writesGoToSandbox({ pinned, isStatic: IS_STATIC });

  // Seeded UNCONDITIONALLY from the sandbox, not behind `pinned`: `pinned` is still undefined on the
  // render where `useState` captures its initial value, and gating on it is what made the original
  // sandbox hydration miss and then write empty state over the saved work.
  const [index, setIndex] = useState<DecisionIndex>(
    // The sandbox stores payloads as plain records (it is storage, not a schema), so the narrowing to
    // `GateDecision` happens here, on the way in.
    () => gateDecisionsOf(readSandbox(jobId)) as DecisionIndex,
  );
  const [conflict, setConflict] = useState<GateDecisionConflict | null>(null);
  const hydratedRef = useRef<string | null>(null);
  /** The `updatedAt` this client last saw per identity — a ref, because no render depends on it. */
  const baseRef = useRef<Record<string, number>>({});

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["gate-decisions", jobId],
    queryFn: () => listArtifacts(jobId),
    enabled: enabled && !!jobId && !local,
    // Fetched once per run and refetched only after a write. `useHarmonizeStream` pushes a frame twice a
    // second; anything keyed on that would refetch a whole payload 120 times a minute.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const serverStale = useMemo(() => data?.stale ?? [], [data]);

  useEffect(() => {
    const payload = data?.artifacts as GroupedDecisions;
    if (!shouldHydrate({ jobId, hydratedJobId: hydratedRef.current, payload })) return;
    hydratedRef.current = jobId;
    setIndex((prev) => mergeDecisionIndex(indexDecisions(payload), prev));
  }, [jobId, data]);

  const stale = useMemo(() => {
    const derived = deriveStaleness(index);
    const seen = new Set(derived.map((s) => `${s.kind}${UNIT_SEPARATOR}${s.itemKey}`));
    // The server derives the same comparison over the persisted rows; this client can additionally see a
    // write it has made but not yet round-tripped. Neither is a superset of the other.
    return [...derived, ...serverStale.filter((s) => !seen.has(`${s.kind}${UNIT_SEPARATOR}${s.itemKey}`))];
  }, [index, serverStale]);

  const staleKeys = useMemo(() => staleItemKeys(stale, kind), [stale, kind]);

  const persist = useCallback(
    async (itemKey: string, payload: GateDecision | null, previous: GateDecision | undefined) => {
      if (local) {
        // The demo is one shared, read-only run, so its edits stay in the browser and are kept by cloning
        // it into a run of your own. Routed here rather than at each call site, because a call site that
        // forgets is a write to somebody else's row.
        writeSandbox(jobId, withGateDecision(readSandbox(jobId), kind, itemKey, payload));
        return;
      }
      try {
        if (payload === null) {
          await deleteArtifact(jobId, kind, itemKey);
          delete baseRef.current[itemKey];
        } else {
          const sentBase = baseRef.current[itemKey];
          const stored = await putArtifact(jobId, kind, payload, sentBase);
          baseRef.current[itemKey] = stored.updatedAt;
          if (stored.conflict) setConflict({ ...stored.conflict, sentBase: sentBase !== undefined });
        }
        await refetch();
      } catch (e) {
        // Reconcile the optimistic state rather than leaving the screen showing a decision the store never
        // took, and surface the failure — a write reported successful but dropped is the defect the store's
        // own honesty rule exists to prevent.
        setIndex((prev) => {
          const byItem = { ...(prev[kind] ?? {}) };
          if (previous === undefined) delete byItem[itemKey];
          else byItem[itemKey] = previous;
          return { ...prev, [kind]: byItem };
        });
        toast.error(e instanceof Error ? e.message : "Could not save that decision");
      }
    },
    [jobId, kind, local, refetch],
  );

  const write = useCallback(
    async (fields: Record<string, unknown>, { chosen, alternatives, upstream, extra }: WriteOptions) => {
      // REFUSE BEFORE MUTATING ANYTHING — before the optimistic `setIndex`, so a frozen screen cannot even
      // briefly show a change it will not keep.
      if (frozen) throw new Error(FROZEN_GATE_MESSAGE);
      const itemKey = decisionItemKey(kind, fields);
      const upstreamPayload = upstream ? index[upstream.kind]?.[upstream.itemKey] : undefined;
      const payload: GateDecision = {
        ...fields,
        ...extra,
        chosen,
        alternatives,
        optionSetKey: optionSetKey(alternatives),
        // Recorded only when the upstream decision is actually held: a content key invented for a row
        // nobody has written would report staleness the moment that row appeared.
        ...(upstream && upstreamPayload
          ? { upstream: { ...upstream, contentKey: contentKey(upstreamPayload) } }
          : {}),
      };
      const previous = index[kind]?.[itemKey];
      setIndex((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? {}), [itemKey]: payload } }));
      await persist(itemKey, payload, previous);
    },
    [index, kind, persist, frozen],
  );

  const clear = useCallback(
    async (fields: Record<string, unknown>) => {
      if (frozen) throw new Error(FROZEN_GATE_MESSAGE);
      const itemKey = decisionItemKey(kind, fields);
      const previous = index[kind]?.[itemKey];
      setIndex((prev) => {
        const byItem = { ...(prev[kind] ?? {}) };
        delete byItem[itemKey];
        return { ...prev, [kind]: byItem };
      });
      await persist(itemKey, null, previous);
    },
    [index, kind, persist, frozen],
  );

  const decisions = useMemo(() => index[kind] ?? {}, [index, kind]);

  return {
    decisions,
    all: index,
    itemKey: (fields) => decisionItemKey(kind, fields),
    isStale: (itemKey) => staleKeys.includes(itemKey),
    staleItemKeys: staleKeys,
    isTouched: (itemKey) => itemKey in decisions,
    touchedCount: Object.keys(decisions).length,
    loading: isLoading,
    local,
    frozen,
    write,
    clear,
    conflict,
    dismissConflict: () => setConflict(null),
  };
}
