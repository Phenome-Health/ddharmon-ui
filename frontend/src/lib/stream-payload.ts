import type { JobResult } from "@/types";

/**
 * The keys the thin SSE frame does NOT carry, and which therefore come from the fetched `/result` payload.
 *
 * A LIVE build folds them into the frame KEY BY KEY (`useHarmonizeStream`), so a key the server sends but this list
 * does not name never reaches a screen — while the static build, which hands the screens its whole fixture, shows it
 * anyway. That split is how the shared demo's shipped score (`demoScore`) could pass every static e2e and still be
 * dropped on the live site; naming it here is the fix, and `demo-score.spec.ts` pins it.
 */
export type StreamPayload = Pick<
  JobResult,
  "result" | "decisions" | "analysisIdeas" | "composites" | "config" | "dictionaries" | "demoScore"
>;

/**
 * The fetched payload as the frame takes it. The six payload keys are ALWAYS present, defaulted, even before the
 * first fetch lands: consumers read `jobState.config.demo` and `jobState.decisions` unguarded, so an object missing
 * those keys would turn a thinner frame into a runtime crash. `demoScore` is the shared demo's alone — present only
 * when the server sent one, absent on every other run.
 */
export function streamPayload(fetched: JobResult | null | undefined): StreamPayload {
  return {
    result: fetched?.result ?? null,
    decisions: fetched?.decisions ?? {},
    analysisIdeas: fetched?.analysisIdeas ?? null,
    composites: fetched?.composites ?? null,
    config: fetched?.config ?? {},
    // The run's own column mapping (backend projection of dict_specs). Only /result carries it — the SSE frame does
    // not — so it must ride in the fetched payload or the back-to-Setup replay reads nothing.
    dictionaries: fetched?.dictionaries ?? [],
    ...(fetched?.demoScore ? { demoScore: fetched.demoScore } : {}),
  };
}
