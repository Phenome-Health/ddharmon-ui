// SSE hook for live harmonization-run progress.
// Adapted from biomapper-ui's use-mapping-stream.ts (same EventSource + exponential-backoff
// retry + terminal-status close), pointed at /api/harmonize/stream and typed to JobResult.
//
// TWO CHANNELS, AS OF 08-08 (D-03). The SSE frame is THIN — live fields plus a `resultVersion` token —
// and the payload (`result`, `decisions`, `analysisIdeas`, `composites`, `config`) is fetched separately
// from /result, which is already owner- and demo-scoped. The frame used to carry the whole job twice a
// second, which was free only while `result` stayed null until terminal; a checkpointed run has a
// multi-megabyte partial from Gate 2 onward, so the same code would have shipped ~6.8 MB at 2 Hz.
//
// Consumers still read ONE object: `jobState` is the frame merged with the latest fetched payload, so
// `jobState.result` / `.decisions` / `.config` mean what they always did.
//
// The refetch fires exactly once per version change BY CONSTRUCTION, not by a guard: the React Query key
// includes the version, so a repeated version resolves from cache and a new one is a new key. That is why
// the backend asserts the token does NOT move on a progress tick — a ticking token would make "once per
// change" mean "twice a second".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { JobResult } from "@/types";
import { IS_STATIC, appendAuthToken, cancelJob, getResult } from "@/lib/api";

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1500;

export interface StreamError {
  message: string;
}

/** The keys the thin frame does NOT carry, and which therefore come from the fetched payload. */
type Payload = Pick<JobResult, "result" | "decisions" | "analysisIdeas" | "composites" | "config">;

/** Statuses at which the stream closes: terminal, plus a gate pause (which has no worker to report). */
function isClosing(status: JobResult["status"]): boolean {
  return status === "complete" || status === "error" || status === "cancelled" || status === "awaiting_review";
}

// `instant` shows the finished result immediately, skipping the demo replay animation — used by the demo
// page's "skip to results" deep-link (?results=1). Live/backend runs ignore it (a complete job streams its
// final state at once anyway).
export function useHarmonizeStream(jobId: string, enabled = true, instant = false) {
  const [jobState, setJobState] = useState<JobResult | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<StreamError | null>(null);
  // Set when the transport drops and a retry is pending. Rendered as a notice by the run views: a frozen
  // readout that still looks live is indistinguishable from a stalled run, which is the worse failure.
  const [reconnecting, setReconnecting] = useState(false);
  // The version token the newest frame announced. 0 = nothing to fetch yet.
  const [resultVersion, setResultVersion] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Pending timers for the static (Netlify) client-side replay — held in a ref so cancel() can stop them.
  const staticTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // The payload channel. Keyed BY VERSION, so each announced version is fetched once and a repeat is a
  // cache hit — "exactly once per change" is a property of the key, not of a hand-rolled guard.
  // Disabled in the static build, whose branch below loads the whole fixture in one shot.
  const payloadQuery = useQuery({
    queryKey: ["harmonize-result", jobId, resultVersion],
    queryFn: () => getResult(jobId),
    enabled: enabled && !!jobId && !IS_STATIC && resultVersion > 0,
    staleTime: Infinity,
  });

  useEffect(() => {
    mountedRef.current = true;
    setReconnecting(false);
    if (!enabled || !jobId) return;

    // Static preview (Netlify): no SSE. Load the bundled result; for a DEMO fixture, pace it through the
    // phases client-side (using the real per-phase wall-clock captured at build time) so it feels like a
    // live run — and progressively REVEAL the records so the metric cards + charts build up as it runs
    // (mirroring biomapper-ui's live demo), then settle on the full result. Non-demo runs load instantly.
    if (IS_STATIC) {
      staticTimersRef.current = [];
      const timers = staticTimersRef.current;
      getResult(jobId)
        .then((full) => {
          if (!mountedRef.current) return;
          const isDemo = !!(full.config as { demo?: boolean } | undefined)?.demo;
          if (instant || !isDemo || !full.result) {
            // "skip to results" (or a non-demo fixture): settle on the full result with no replay pacing.
            setJobState(full);
            setDone(true);
            return;
          }
          const PHASES = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "gencde", "specs"];
          const p = full.result.prompts;
          const counts: Record<string, number> = {
            generating: p?.ideal ?? 0,
            splitting: p?.split ?? 0,
            assigning: p?.groupAssign ?? 0,
            gencde: p?.gencde ?? 0,
            specs: p?.specgen ?? 0,
          };
          const weights = PHASES.map((ph) => Math.max(0.05, full.phaseTimings?.[ph] ?? 1));
          const sum = weights.reduce((a, b) => a + b, 0);
          // cumulative end-fraction of each phase, and the fraction at which record-producing phases begin
          // (after loading+embedding+clustering) — records ramp in from there to the end.
          let acc = 0;
          const cumEnd = weights.map((w) => (acc += w) / sum);
          const genStart = weights.slice(0, 3).reduce((a, b) => a + b, 0) / sum;
          const allRecords = full.result.records ?? [];
          const N = allRecords.length;
          const TOTAL_MS = 13000; // snappy but clearly live
          const STEPS = 30;
          for (let s = 1; s <= STEPS; s++) {
            const f = s / STEPS;
            let pi = cumEnd.findIndex((c) => f <= c);
            if (pi < 0) pi = PHASES.length - 1;
            const ph = PHASES[pi];
            const total = counts[ph] ?? 0;
            const revealFrac = f <= genStart ? 0 : (f - genStart) / (1 - genStart);
            const k = Math.min(N, Math.round(N * revealFrac));
            timers.push(
              setTimeout(() => {
                if (!mountedRef.current) return;
                // partial result: records revealed so far, atlas withheld until the end (it's static field
                // space — no value building it, and it keeps the live phase light).
                const partial = k > 0 ? { ...full.result!, records: allRecords.slice(0, k), atlas: [] } : null;
                setJobState({ ...full, status: ph as JobResult["status"], phase: ph, completed: total, total, result: partial });
              }, f * TOTAL_MS),
            );
          }
          timers.push(
            setTimeout(() => {
              if (!mountedRef.current) return;
              setJobState(full);
              setDone(true);
            }, TOTAL_MS + 250),
          );
        })
        .catch(() => mountedRef.current && setError({ message: "Sample run not found" }));
      return () => {
        mountedRef.current = false;
        timers.forEach(clearTimeout);
      };
    }

    async function connect(retryCount: number) {
      if (!mountedRef.current) return;
      // EventSource can't set an Authorization header, so the Clerk token (when the SSO gate is on) rides
      // as ?token=; appendAuthToken is a no-op when auth is disabled (static/dev). Await it before opening.
      const url = await appendAuthToken(`/api/harmonize/stream/${jobId}`);
      if (!mountedRef.current) return;
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        if (!mountedRef.current) return;
        try {
          const data: JobResult = JSON.parse((e as MessageEvent).data);
          setReconnecting(false);
          setJobState(data);
          // Announce the payload version. Bumping this state changes the query key, which fetches it once.
          setResultVersion((prev) => (data.resultVersion && data.resultVersion !== prev ? data.resultVersion : prev));
          if (data.status === "error") {
            setError({ message: data.errorMessage ?? "Harmonization failed" });
          }
          if (isClosing(data.status)) {
            // `awaiting_review` closes too: a gate pause is an EXIT (08 D-01), so there is no worker left
            // to report progress and holding the stream open would poll a dead run forever. It is NOT
            // terminal, though — `done` stays false so a resumed leg reconnects normally.
            if (data.status !== "awaiting_review") setDone(true);
            es.close();
          }
        } catch (err) {
          console.error("[SSE] error parsing progress payload", err);
        }
      });

      es.onerror = () => {
        es.close();
        if (!mountedRef.current) return;
        if (retryCount < MAX_RETRIES) {
          setReconnecting(true);
          const delay = BASE_RETRY_MS * Math.pow(2, retryCount);
          retryTimerRef.current = setTimeout(() => connect(retryCount + 1), delay);
        } else {
          setReconnecting(false);
          setError({ message: "Connection to harmonization service lost after multiple retries" });
          setDone(true);
        }
      };
    }

    connect(0);
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      esRef.current?.close();
    };
  }, [jobId, enabled, instant]);

  // Stop an in-progress run. `mode` is "discard" (hard abort, no results) or "keep" (finish the current stage
  // → partial results, skip the rest). Backend: ask the server to cancel — the SSE stream delivers the terminal
  // "cancelled" state and closes. Static preview (no backend): stop the client-side replay timers and settle on
  // a cancelled state locally (mode is moot — a replay has no cost). Safe to call when nothing is running.
  const cancel = useCallback(async (mode: "keep" | "discard" = "discard") => {
    if (IS_STATIC) {
      staticTimersRef.current.forEach(clearTimeout);
      staticTimersRef.current = [];
      setJobState((prev) => (prev ? { ...prev, status: "cancelled", phase: "cancelled" } : prev));
      setDone(true);
      return;
    }
    try {
      await cancelJob(jobId, mode); // server flags the run; the SSE tick above flips it to cancelled and closes
    } catch {
      // request failed — leave the run as-is; the next stream tick reflects its true state
    }
  }, [jobId]);

  // The single object every consumer reads: the thin frame with the fetched payload folded in.
  //
  // The payload is only ever ADDED to a frame, never allowed to overwrite a live field — a fetch that
  // lands a tick late would otherwise rewind `status`/`phase`/`costSoFar` to the moment it was issued and
  // make the readout visibly jump backwards. The static branch already carries its own payload, so
  // spreading nothing over it is what keeps a checkpointed fixture from being double-applied.
  const merged = useMemo<JobResult | null>(() => {
    if (!jobState) return null;
    if (IS_STATIC) return jobState;
    const fetched = payloadQuery.data;
    // The five payload keys are ALWAYS present, defaulted, even before the first fetch lands. Consumers
    // read `jobState.config.demo` and `jobState.decisions` unguarded, so handing them an object missing
    // those keys would turn a thinner frame into a runtime crash — the defect a purely subtractive change
    // would have shipped.
    const payload: Payload = {
      result: fetched?.result ?? null,
      decisions: fetched?.decisions ?? {},
      analysisIdeas: fetched?.analysisIdeas ?? null,
      composites: fetched?.composites ?? null,
      config: fetched?.config ?? {},
    };
    return { ...payload, ...jobState };
  }, [jobState, payloadQuery.data]);

  return { jobState: merged, done, error, cancel, reconnecting };
}
