import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useParams } from "wouter";
import { toast } from "sonner";
import { CommitBar } from "@/components/gate/CommitBar";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { RulePipelineList } from "@/components/gate/RulePipelineList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { resumeRun } from "@/lib/api";
import { estimateRunCostBreakdown } from "@/lib/estimate";
import type { PreprocessReport, RunMode } from "@/types";

/**
 * Gate 0 — Load &amp; prepare — the staged review flow's second screen.
 *
 * WHAT IT IS FOR. Preprocessing had never run in the product until 08-09; now that it does, this screen's
 * job is to make its effect legible on the way to the run's FIRST CHARGE. Everything it shows is local,
 * $0 work that already happened — so the reviewer is reading a report, not authorising one.
 *
 * THE THREE STATES IT MUST KEEP APART, delegated to `RulePipelineList`: a rule that ran and changed
 * nothing, a rule that did not run, and a rule that threw. Collapsing them is the same class of error as
 * rendering an unjudged group as coherent.
 *
 * PER-COHORT STATE IS PER TAB, AND A TAB NEVER LIES ABOUT PROGRESS. Preprocessing is local but not
 * instantaneous, and the honest source of "which cohorts are done" is the run's own declared cohort list
 * MINUS the reports it has produced — a cohort with no report yet renders as pending, not as a clean
 * report with zeros. The aggregate above the tabs states the fraction rather than a total, because a
 * total across four of five cohorts implies a completeness the run has not reached.
 *
 * ITS CONTINUE IS THE RUN'S FIRST CHARGE (UI-SPEC §0.1, §8.1). Gate 0's own stages call no model, so its
 * rail column reads "local" — but pressing Continue buys concept generation, splitting and the coherence
 * judge over the whole corpus before Gate 1 can render anything. So the amount is ON the button and the
 * irreversible-spend statement is INLINE in the bar, never a modal: a modal on the primary path is met at
 * every gate, always says yes, and by the third gate is dismissed unread.
 *
 * TWO THINGS THE PIPELINE DOES NOT RECORD ARE STATED, not omitted. Which rule changed a variable is not
 * stamped anywhere, so the grouping under each rule is inferred; and the value vector is composed for
 * every variable and retrieval does not consult it. An omitted panel reads as "nothing to say here",
 * which is a claim about the product rather than about this run.
 */

/** A tab's cohort, and whether this run has actually finished preparing it. */
interface CohortTab {
  cohort: string;
  report: PreprocessReport | null;
}

/** Phases that run BEFORE preprocessing has produced anything for every cohort. */
const PRE_PREPARE_PHASES = new Set(["queued", "loading", "embedding"]);

/**
 * The row-to-vector panel: for one variable, the ONLY text the grouping stage sees.
 *
 * IT SHOWS `embedText` AND NOTHING DERIVED. That field is core's own `to_embedding_text()`, carried on the
 * wire for exactly this panel, and its precedence (`question_text or description`) is the OPPOSITE of the
 * display text elsewhere in the app. On this run's own data the two genuinely disagree — a CLSA variable's
 * cleaned description is `CR2 GNDR TRM` while the string that actually reaches the model is the question
 * it asks — so a re-derivation here would answer "why did these two group?" wrongly while looking right.
 * This is the one place that question can be answered, which is why an approximation would be worse than
 * showing nothing.
 *
 * WHICH VARIABLES ARE OFFERED, stated on screen: the ones preprocessing changed. Those are the variables
 * this run carries per-variable detail for; the rest are not withheld, they are simply not in the report.
 */
function RowToVector({ report }: { report: PreprocessReport }) {
  const rows = report.diff;
  const [selected, setSelected] = useState<string>(rows[0]?.variableName ?? "");
  const row = rows.find((r) => r.variableName === selected) ?? rows[0];

  return (
    <section data-testid="row-to-vector" className="flex flex-col gap-3 border-t border-rule-on-raised px-6 py-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-on-raised">From a row to a vector</h3>
        <p className="max-w-[68ch] text-xs text-on-raised-muted">
          The only text the grouping stage sees for one variable. Everything else on its row — answer
          options, data type, units — is deliberately kept out of this text and used in the prompts
          instead. Choose from the {rows.length.toLocaleString()}{" "}
          {rows.length === 1 ? "variable" : "variables"} preparation changed, which are the ones this run
          carries per-variable detail for.
        </p>
      </div>

      {rows.length === 0 || !row ? (
        <p className="max-w-[68ch] text-xs text-on-raised-muted">
          Preparation changed no variable in this dictionary, so the run carries no per-variable detail to
          show here. The text the grouping stage sees is each variable&rsquo;s own wording, unaltered.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs text-on-raised-muted">
            Variable
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full max-w-[24rem] rounded border border-rule-control-on-raised bg-surface-raised px-3 py-2 text-sm text-on-raised"
            >
              {rows.map((r) => (
                <option key={r.variableName} value={r.variableName}>
                  {r.variableName}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <p className="text-xs font-semibold text-on-raised-muted">What the grouping stage embeds</p>
            {row.embedText ? (
              /* Escaped text child. `title` carries the full value so a long one is clamped, not lost. */
              <p
                data-testid="embed-text"
                title={row.embedText}
                className="line-clamp-3 max-w-[68ch] rounded-inner bg-surface-inset px-3 py-2 text-sm text-on-inset"
              >
                {row.embedText}
              </p>
            ) : (
              <p data-testid="embed-text" className="max-w-[68ch] text-sm text-on-raised">
                {""}
                <span className="text-on-raised-muted">
                  Nothing. This variable composes no text at all, so it embeds nothing and reaches no
                  concept group — a silent loss rather than a visible failure.
                </span>
              </p>
            )}
          </div>
          {row.embedNameSuppressed && (
            <p className="max-w-[68ch] text-xs text-on-raised-muted">
              This variable&rsquo;s name is not part of that text: the description already contained it, so
              repeating it would weight the same words twice.
            </p>
          )}
        </>
      )}

      {/* The nothing-to-embed count, stated with its denominator. */}
      <p
        data-testid="nothing-to-embed"
        data-count={String(report.nNothingToEmbed)}
        className="max-w-[68ch] text-xs text-on-raised-muted"
      >
        <span className="font-semibold text-on-raised">
          {report.nNothingToEmbed.toLocaleString()} of {report.nUniqueVariableNames.toLocaleString()}{" "}
          variables compose no text to embed
        </span>{" "}
        {report.nNothingToEmbed === 0
          ? "— every variable in this dictionary reaches the grouping stage with something to say."
          : "— they appear in every listing and reach no concept group, so they are a silent loss rather than a visible failure."}
      </p>
    </section>
  );
}

export default function Gate0Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState, error, reconnecting } = useHarmonizeStream(jobId, true, true);
  const [resuming, setResuming] = useState(false);

  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;
  const reports: PreprocessReport[] = jobState?.result?.preprocessing ?? [];

  /**
   * The tab list. DECLARED cohorts first, so a cohort the run knows about but has not prepared yet gets a
   * tab in the pending state rather than being invisible — an absent tab is indistinguishable from a
   * cohort that was never in the run.
   */
  const tabs: CohortTab[] = useMemo(() => {
    const byCohort = new Map(reports.map((r) => [r.cohort, r]));
    const declared: string[] = jobState?.result?.summary?.cohorts ?? [];
    const order = [...declared, ...reports.map((r) => r.cohort).filter((c) => !declared.includes(c))];
    return order.map((cohort) => ({ cohort, report: byCohort.get(cohort) ?? null }));
  }, [reports, jobState?.result?.summary?.cohorts]);

  const prepared = tabs.filter((t) => t.report).length;
  const allPrepared = tabs.length > 0 && prepared === tabs.length && !PRE_PREPARE_PHASES.has(jobState?.phase ?? "");
  const [active, setActive] = useState<string>("");
  const current = active || tabs[0]?.cohort || "";

  /**
   * What Continue buys, priced off THIS RUN'S OWN corpus rather than the pre-upload guess.
   *
   * The variable counts on screen are the real ones — the rules have already run — so they are a better
   * denominator than the `est_fields` the New-Run form stored before a file was parsed. `firstCharge` is
   * the estimator's own name for what Gate 0's Continue buys, so the figure the reviewer reads here and
   * the one Setup quoted come from one function rather than two.
   */
  const firstCharge = useMemo(() => {
    const variables = reports.reduce((n, r) => n + r.nUniqueVariableNames, 0);
    const config = (jobState?.config ?? {}) as Record<string, unknown>;
    const fields =
      variables > 0 ? variables : typeof config.est_fields === "number" ? config.est_fields : 0;
    const cohorts =
      tabs.length > 0 ? tabs.length : typeof config.est_cohorts === "number" ? config.est_cohorts : 0;
    if (fields <= 0) return undefined;
    const mode = (typeof config.run_mode === "string" ? config.run_mode : "batch") as RunMode;
    return estimateRunCostBreakdown(fields, cohorts, mode, true).firstCharge;
  }, [reports, tabs.length, jobState?.config]);

  async function onContinue() {
    setResuming(true);
    try {
      await resumeRun(jobId);
      toast.success("Continuing to Gate 1");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not continue this run");
    } finally {
      setResuming(false);
    }
  }

  return (
    <GateShell
      gate="gate0"
      subhead="Every preparation rule that ran on your dictionaries, and what each one changed. Pressing Continue here is the run's first charge — it pays for naming and dividing the concept groups."
      rail={railFor("gate0", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate0"}
    >
      {reconnecting && (
        <p role="status" data-testid="stream-reconnecting" className="text-sm font-semibold text-status-warn">
          Lost contact with the server — reconnecting. The figures below are from the last update, not live.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-status-danger">
          {error.message}
        </p>
      )}

      {tabs.length === 0 ? (
        /* NOT an empty panel, and not a "not built yet" notice: this run genuinely carries no preparation
           report, which is a fact about the RUN. A run recorded before preprocessing existed is this. */
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
        <>
          {/* THE AGGREGATE, which never implies completeness it has not reached. */}
          <p
            data-testid="prepare-aggregate"
            data-complete={String(allPrepared)}
            data-prepared={String(prepared)}
            data-declared={String(tabs.length)}
            className="text-sm text-on-field-muted"
          >
            {allPrepared ? (
              <>
                <span className="font-semibold text-on-field">
                  All {tabs.length} {tabs.length === 1 ? "dictionary" : "dictionaries"} prepared
                </span>{" "}
                — {reports.reduce((n, r) => n + r.nUniqueVariableNames, 0).toLocaleString()} variables in
                all. Every rule ran locally on this machine and nothing has been charged for it.
              </>
            ) : (
              <>
                <span className="font-semibold text-on-field">
                  {prepared} of {tabs.length} {tabs.length === 1 ? "dictionary" : "dictionaries"} prepared
                </span>{" "}
                — the rest are still being prepared, so the counts below cover only the finished ones and
                are not a total for the run.
              </>
            )}
          </p>

          <Tabs value={current} onValueChange={setActive}>
            <TabsList className="flex h-auto flex-wrap justify-start gap-1 rounded-pill border border-rule-on-field bg-transparent p-1">
              {tabs.map((t) => (
                <TabsTrigger
                  key={t.cohort}
                  value={t.cohort}
                  // Radix consumes `value` and does not forward it to the DOM, so the cohort is named as
                  // its own attribute — matching the panel's, so a tab and its panel can be checked to
                  // agree rather than assumed to.
                  data-cohort={t.cohort}
                  data-progress={t.report ? "prepared" : "pending"}
                  className="rounded-pill px-3 py-1 text-xs text-on-field-muted data-[state=active]:bg-surface-raised data-[state=active]:text-on-raised"
                >
                  {t.cohort}
                  {!t.report && <span className="ml-1.5 font-normal">· preparing</span>}
                </TabsTrigger>
              ))}
            </TabsList>

            {tabs.map((t) => (
              <TabsContent key={t.cohort} value={t.cohort} className="mt-4">
                <section
                  data-testid="cohort-panel"
                  data-cohort={t.cohort}
                  data-state-kind={t.report ? "report" : "pending"}
                  className="rounded-card bg-surface-raised shadow-card"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule-on-raised px-6 py-3">
                    <h2 className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                      Preparation rules · {t.cohort}
                    </h2>
                    {/* VISIBLE WITHOUT EXPANDING A ROW. The pipeline does not stamp which rule changed a
                        variable, so which examples sit under which rule is inferred — and an honesty
                        label behind a disclosure is not a label. It is stated a second time inside each
                        expanded rule, where the inference is actually made, and once more as a tile. */}
                    {t.report && (
                      <p className="text-xs font-normal normal-case text-on-raised-muted">
                        Examples are grouped under rules as inferred, not reported
                      </p>
                    )}
                  </div>
                  {t.report ? (
                    <>
                      <RulePipelineList report={t.report} />
                      <RowToVector report={t.report} />
                    </>
                  ) : (
                    /* A tab must NEVER show a completed report while its cohort is still running. No rule
                       list, no counts — those would be zeros read as findings. */
                    <p role="status" className="flex items-center gap-2 px-6 py-8 text-sm text-on-raised-muted">
                      <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
                      Still preparing {t.cohort}. Nothing is shown for it yet, because a count of zero here
                      would read as a finding rather than as work not finished.
                    </p>
                  )}
                </section>
              </TabsContent>
            ))}
          </Tabs>

          {/* THE TWO DEFERRED CAPABILITIES (UI-SPEC §9 items 2 and 3). They render — an omitted panel
              reads as "nothing to say here", which is a claim about the product, not about this run. */}
          <NotAvailable thing="Which rule changed a variable" claim="deferred" className="bg-surface-raised">
            The report shows before and after per variable, but the pipeline does not stamp which rule
            fired. The grouping above is inferred, not reported.
          </NotAvailable>
          <NotAvailable thing="The value vector" claim="deferred" className="bg-surface-raised">
            A second vector describing answer structure is composed for every variable, and retrieval does
            not use it. Whether it should is an open research question, not a setting.
          </NotAvailable>

          {/* THE SPEND GATE. Inline statement, no modal — see the file docstring. */}
          <CommitBar
            action="Continue to Gate 1"
            total={firstCharge}
            firstCharge
            scopeLabel={`${reports.reduce((n, r) => n + r.nUniqueVariableNames, 0).toLocaleString()} variables`}
            onCommit={onContinue}
            busy={resuming}
            disabled={!allPrepared}
            recheckNotice={
              allPrepared ? undefined : "Some dictionaries are still being prepared. Continue once they finish."
            }
          />
        </>
      )}
    </GateShell>
  );
}
