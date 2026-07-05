// SSE hook for live harmonization-run progress.
// Adapted from biomapper-ui's use-mapping-stream.ts (same EventSource + exponential-backoff
// retry + terminal-status close), pointed at /api/harmonize/stream and typed to JobResult.
import { useEffect, useRef, useState } from "react";
import type { JobResult } from "@/types";
import { IS_STATIC, getResult } from "@/lib/api";

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1500;

export interface StreamError {
  message: string;
}

export function useHarmonizeStream(jobId: string, enabled = true) {
  const [jobState, setJobState] = useState<JobResult | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<StreamError | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !jobId) return;

    // Static preview (Netlify): no SSE. Load the bundled result; for a DEMO fixture, pace it through the
    // phases client-side (using the real per-phase wall-clock captured at build time) so it feels like a
    // live run — and progressively REVEAL the records so the metric cards + charts build up as it runs
    // (mirroring biomapper-ui's live demo), then settle on the full result. Non-demo runs load instantly.
    if (IS_STATIC) {
      const timers: ReturnType<typeof setTimeout>[] = [];
      getResult(jobId)
        .then((full) => {
          if (!mountedRef.current) return;
          const isDemo = !!(full.config as { demo?: boolean } | undefined)?.demo;
          if (!isDemo || !full.result) {
            setJobState(full);
            setDone(true);
            return;
          }
          const PHASES = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "specs"];
          const p = full.result.prompts;
          const counts: Record<string, number> = {
            generating: p?.ideal ?? 0,
            splitting: p?.split ?? 0,
            assigning: p?.groupAssign ?? 0,
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

    function connect(retryCount: number) {
      if (!mountedRef.current) return;
      const es = new EventSource(`/api/harmonize/stream/${jobId}`);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        if (!mountedRef.current) return;
        try {
          const data: JobResult = JSON.parse((e as MessageEvent).data);
          setJobState(data);
          if (data.status === "complete") {
            setDone(true);
            es.close();
          } else if (data.status === "error") {
            setError({ message: data.errorMessage ?? "Harmonization failed" });
            setDone(true);
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
          const delay = BASE_RETRY_MS * Math.pow(2, retryCount);
          retryTimerRef.current = setTimeout(() => connect(retryCount + 1), delay);
        } else {
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
  }, [jobId, enabled]);

  return { jobState, done, error };
}
