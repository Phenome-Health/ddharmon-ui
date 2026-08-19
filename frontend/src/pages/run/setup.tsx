import { useParams } from "wouter";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";

/**
 * Set up — the staged review flow's first screen.
 *
 * OWNED BY 08-13. This file exists now so the router is fixed ONCE: 08-08 sets the six page boundaries,
 * and no later screen plan has to touch `App.tsx` or re-derive the chrome. What is missing here is a
 * FUNCTIONALITY gap, not an architectural one — the route resolves, the universal chrome renders, and the
 * gate rail places the reviewer correctly.
 *
 * It says so on screen rather than rendering an empty panel, per P8-D3: an unbuilt surface that looks like
 * a built one with no data is the failure mode this project's honest-absence rule exists to prevent.
 */
export default function SetupPage() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  return (
    <GateShell
      gate="setup"
      subhead="Add a data dictionary per cohort, map its columns, and choose how the run should be priced. Nothing is charged yet — the first charge is Continue at Gate 0."
      rail={railFor("setup", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "setup"}
    >
      {/* An honest "not available" tile, not an empty state: the difference between "this screen has
          nothing to show you" and "this screen is not built yet" is one the reviewer must be able to see. */}
      <section
        data-testid="not-built-yet"
        className="flex flex-col gap-2 rounded-inner border border-dashed border-rule-on-field px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-on-field">Run setup — not built yet</h2>
        <p className="max-w-[68ch] text-sm text-on-field-muted">Uploading dictionaries, per-file column mapping, the row-count against unique-name-count check, the optional score definition, the catalogue picker and the cost estimate all land here. Until then, start a run from New run.</p>
      </section>
    </GateShell>
  );
}
