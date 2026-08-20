import { useParams } from "wouter";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";

/**
 * Gate 0 — Load &amp; prepare — the staged review flow's second screen.
 *
 * OWNED BY 08-14. This file exists now so the router is fixed ONCE: 08-08 sets the six page boundaries,
 * and no later screen plan has to touch `App.tsx` or re-derive the chrome. What is missing here is a
 * FUNCTIONALITY gap, not an architectural one — the route resolves, the universal chrome renders, and the
 * gate rail places the reviewer correctly.
 *
 * It says so on screen rather than rendering an empty panel, per P8-D3: an unbuilt surface that looks like
 * a built one with no data is the failure mode this project's honest-absence rule exists to prevent.
 */
export default function Gate0Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  return (
    <GateShell
      gate="gate0"
      subhead="Every preparation rule that ran on your dictionaries, and what each one changed. Pressing Continue here is the run's first charge — it pays for naming and dividing the concept groups."
      rail={railFor("gate0", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate0"}
    >
      {/* An honest "not available" tile, not an empty state: the difference between "this screen has
          nothing to show you" and "this screen is not built yet" is one the reviewer must be able to see. */}
      <section
        data-testid="not-built-yet"
        className="flex flex-col gap-2 rounded-inner border border-dashed border-rule-on-field px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-on-field">The preparation report — not built yet</h2>
        <p className="max-w-[68ch] text-sm text-on-field-muted">The per-cohort rule list &mdash; including rules that changed nothing, so a rule that did not apply stays distinguishable from one that never ran &mdash; plus a before-and-after example per rule that fired, the row-to-vector panel and the nothing-to-embed count all land here.</p>
      </section>
    </GateShell>
  );
}
