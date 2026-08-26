import { useParams } from "wouter";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { RulePipelineList } from "@/components/gate/RulePipelineList";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import type { PreprocessReport } from "@/types";

/**
 * Gate 0 — Load &amp; prepare — the staged review flow's second screen.
 *
 * WHAT IT IS FOR. Preprocessing had never run in the product until 08-09; now that it does, this screen's
 * job is to make its effect legible on the way to the run's first charge. Everything it shows is local,
 * $0 work that has already happened — so the reviewer is reading a report, not authorising one.
 *
 * THE THREE STATES IT MUST KEEP APART, delegated to `RulePipelineList`: a rule that ran and changed
 * nothing, a rule that did not run, and a rule that threw. Collapsing them is the same class of error as
 * rendering an unjudged group as coherent.
 */
export default function Gate0Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;
  const reports: PreprocessReport[] = jobState?.result?.preprocessing ?? [];

  return (
    <GateShell
      gate="gate0"
      subhead="Every preparation rule that ran on your dictionaries, and what each one changed. Pressing Continue here is the run's first charge — it pays for naming and dividing the concept groups."
      rail={railFor("gate0", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate0"}
    >
      {reports.length === 0 ? (
        /* NOT an empty panel, and not a "not built yet" notice: this run genuinely carries no preparation
           report, which is a fact about the RUN rather than about the screen. A run recorded before
           preprocessing existed in the product is exactly this case. */
        <section className="rounded-card bg-surface-raised shadow-card">
          <GateEmptyState
            heading="No preparation report for this run"
            nextStep="Start a new run to see what the preparation rules do to your dictionaries."
          >
            This run carries no record of the preparation step, so nothing here can say what the rules
            changed. That is different from a run where the rules found nothing to change — that run would
            list every rule with a count of zero.
          </GateEmptyState>
        </section>
      ) : (
        <section className="rounded-card bg-surface-raised shadow-card">
          <h2 className="border-b border-rule-on-raised px-6 py-3 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Preparation rules · {reports[0].cohort}
          </h2>
          <RulePipelineList report={reports[0]} />
        </section>
      )}
    </GateShell>
  );
}
