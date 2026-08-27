import { useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { InputQualitySignals } from "@/components/gate/InputQualitySignals";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { RulePipelineList } from "@/components/gate/RulePipelineList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { preparedExportUrl } from "@/lib/api";
import { preflightRead, type PreflightRead } from "@/lib/preprocess-report";
import type { JobResult, PreprocessReport } from "@/types";

/**
 * The free PRE-FLIGHT on Setup — what preparation found, read before anything is bought.
 *
 * WHAT IT IS FOR, and why it is a panel rather than a screen. This was Gate 0, the staged flow's second
 * screen, until `08-DECISION-GATE0.md` (2026-08-26) demoted it: a gate whose only control is Continue is a
 * receipt, not a gate, and on a clean dictionary half of what it reports is invisible by construction. The
 * PREPARATION ITSELF IS UNTOUCHED (D-1) — same eight rules, same order, same output. A screen was retired,
 * not a stage.
 *
 * IT IS FREE BECAUSE THE RUN PARKS BEFORE THE FIRST PAID STAGE. The backend boundary added on 2026-08-26
 * is kept exactly as built (D-3): the run loads, preprocesses and embeds, then stops BEFORE
 * `harmonize_leanb` is ever called. So everything here is local, $0 work that has already happened, and
 * the reader is deciding whether to FIX THEIR INPUT BEFORE SPENDING rather than authorising what they are
 * looking at. The control that does the spending is Setup's own, beside this panel — not in it.
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
 * THE FROZEN AUDIT TRAIL IS REACHABLE, NOT DELETED (pre-build question Q2, answered 2026-08-26). The rule
 * pipeline, the worked before/after examples and the row-to-vector panel sit under a collapsed disclosure
 * below the findings. No further work goes into them — they are frozen as built — but the app stays the
 * one place the cleaning can be audited, and the ~30 rendered assertions over them keep a home. The
 * accepted cost, stated at decision time: ~600 lines of frozen UI stay in the bundle.
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
          {/* PROSE KEEPS ITS MEASURE; DATA GETS THE ROOM. The picker is a control and needs a control's
              width; the string beside it is the thing the screen exists to show, and capping it at a
              prose measure left half the card empty while the value it holds was the part being read. */}
          <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:items-start">
            <label className="flex flex-col gap-1 text-xs text-on-raised-muted">
              Variable
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="w-full rounded border border-rule-control-on-raised bg-surface-raised px-3 py-2 text-sm text-on-raised"
              >
                {rows.map((r) => (
                  <option key={r.variableName} value={r.variableName}>
                    {r.variableName}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-xs font-semibold text-on-raised-muted">What the grouping stage embeds</p>
              {row.embedText ? (
                /* SCROLLS, NEVER CLAMPS (review 2026-08-26). This was `line-clamp-3`, so a long value ended
                   mid-word with no scrollbar and no control to reveal the rest — and `title` is not a
                   reading surface for a paragraph. The box is bounded so it cannot push the rest of the
                   card off screen, and the bound is reachable. */
                <p
                  data-testid="embed-text"
                  tabIndex={0}
                  className="max-h-[11rem] overflow-y-auto whitespace-pre-wrap break-words rounded-inner bg-surface-inset px-3 py-2 text-sm text-on-inset"
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
              {/* THE LENGTH, STATED. The box is bounded so it cannot push the card off screen, and macOS
                  hides its scrollbar until you touch it — so a long value looks the same as a short one
                  that happens to end there. The count is how the reader knows there is more, and how much,
                  without having to discover the scroll. Characters rather than words: this is a machine
                  string being inspected, not prose being read. */}
              {row.embedText && (
                <p
                  data-testid="embed-text-length"
                  data-chars={String(row.embedText.length)}
                  className="text-xs text-on-raised-muted"
                >
                  {row.embedText.length.toLocaleString()} characters
                  {row.embedText.length > 320 ? " — scroll the box to read the rest." : ""}
                </p>
              )}
              {row.embedNameSuppressed && (
                <p className="text-xs text-on-raised-muted">
                  This variable&rsquo;s name is not part of that text: the description already contained
                  it, so repeating it would weight the same words twice.
                </p>
              )}
            </div>
          </div>
        </>
      )}

    </section>
  );
}

/**
 * The column roles this run recorded for one cohort, or null when it recorded none.
 *
 * Null is NOT "clean". The demo path persists dataset ids rather than a mapping, and a run started before
 * the mapping was persisted has none either — so the honest answer for those is that the question cannot
 * be answered from the run, which `preflightRead` renders as a declared gap.
 */
function rolesForCohort(run: JobResult | null, cohort: string): Record<string, string> | null {
  const declared = ((run?.config ?? {}) as Record<string, unknown>).dictionaries;
  if (!Array.isArray(declared)) return null;
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const match = (declared as { cohortName?: string; columnRoles?: Record<string, string> }[]).find(
    (d) => fold(d.cohortName ?? "") === fold(cohort),
  );
  return match?.columnRoles ?? null;
}

/**
 * What preparation FOUND — the panel's headline, and the reason it is worth reading before spending.
 *
 * ORDERED BY WHAT THE READER CAN DO. The count that only running the rules could produce leads; what the
 * rules DID follows it as context; the classes the report cannot answer are DECLARED at the bottom with
 * the reason and a pointer, never omitted. An omitted panel reads as "nothing to say here", which is a
 * claim about the product rather than about this run.
 *
 * A CLEAN DICTIONARY GETS A POSITIVE STATEMENT, not an empty region. "Nothing to flag" is a finding; a
 * blank space is a bug the reader cannot distinguish from one.
 */
function PreflightFindings({ read }: { read: PreflightRead }) {
  return (
    <div
      data-testid="preflight-findings"
      data-nothing-to-flag={String(read.nothingToFlag)}
      className="flex flex-col gap-3 px-6 py-4"
    >
      {read.nothingToFlag && (
        <p data-testid="preflight-all-clear" className="max-w-[68ch] text-sm text-on-raised">
          <span className="font-semibold">Nothing to flag in this dictionary.</span> Every variable
          composes text to embed, and the wording the model reads is the wording you mapped.
        </p>
      )}

      {read.findings.map((f) => (
        <p
          key={f.id}
          data-testid="preflight-finding"
          data-finding={f.id}
          data-count={String(f.count)}
          data-of={String(f.of)}
          data-concern={String(f.concern)}
          className="max-w-[68ch] text-sm text-on-raised-muted"
        >
          <span className="font-semibold text-on-raised">
            {f.count.toLocaleString()} of {f.of.toLocaleString()} {f.denominator} — {f.label}
          </span>{" "}
          {f.detail}
          {f.needsRestart && (
            <span data-testid="needs-restart" className="ml-1 font-semibold text-on-raised">
              Acting on this means starting a fresh run, not changing this one.
            </span>
          )}
        </p>
      ))}

      {/* WHAT THE RULES DID, per cohort and never averaged across them: a mean over cohorts hides which
          cohort is the problem, which is the same defect that got the composite score rejected. */}
      <p
        data-testid="preflight-summary"
        data-count={String(read.summary.count)}
        data-of={String(read.summary.of)}
        className="max-w-[68ch] text-sm text-on-raised-muted"
      >
        <span className="font-semibold text-on-raised">
          {read.summary.count.toLocaleString()} of {read.summary.of.toLocaleString()}{" "}
          {read.summary.denominator} {read.summary.label}
        </span>{" "}
        {read.summary.detail}
      </p>

      {read.gaps.map((g) => (
        <p
          key={g.id}
          data-testid="preflight-gap"
          data-gap={g.id}
          className="max-w-[68ch] border-t border-rule-quiet-on-raised pt-2 text-xs text-on-raised-muted"
        >
          <span className="font-semibold text-on-raised">Not available — {g.label}.</span> {g.reason}{" "}
          {g.pointer}
        </p>
      ))}
    </div>
  );
}

/**
 * The prepared-dictionary export, as a PRIMARY affordance rather than a footnote.
 *
 * ITS SHARE OF THIS PANEL'S VALUE WENT UP. `08-DECISION-GATE0.md` D-5 already called it the one part of
 * this surface a reviewer can actually use; with the headline recommendation removed by Q3 — it ships
 * pre-Start, where it is fixable in place — this is now the answer to two of the three classes the report
 * cannot supply on its own. It is also structurally more reliable than the screen: it re-reads and
 * re-prepares the file locally rather than reading the run's capped diff, so it returns EVERY row.
 */
function PreparedExport({ jobId, cohort }: { jobId: string; cohort: string }) {
  const href = preparedExportUrl(jobId, cohort);
  return (
    <div
      data-testid="prepared-export"
      className="flex flex-col gap-2 border-t border-rule-on-raised px-6 py-4"
    >
      <h3 className="text-sm font-semibold text-on-raised">Check the whole dictionary yourself</h3>
      {href ? (
        <a
          data-testid="prepared-export-link"
          href={href}
          download
          className="self-start rounded-inner border border-rule-control-on-raised px-3 py-2 text-sm font-semibold text-link-on-raised underline underline-offset-2"
        >
          Download this dictionary with the prepared columns (CSV)
        </a>
      ) : (
        <p data-testid="prepared-export-unavailable" className="text-sm font-semibold text-on-raised-muted">
          Download of the prepared dictionary is unavailable in this preview
        </p>
      )}
      <p className="max-w-[68ch] text-xs text-on-raised-muted">
        {href
          ? "Your original file, unchanged and in its own column order, with ddharmon_variable_name, ddharmon_description and ddharmon_embedding_text appended for EVERY variable — not only the ones that changed, and not only the sample this screen carries. It is re-read and re-prepared on request, so it costs nothing and nothing above it stops being true."
          : "This preview has no server to re-read your upload from. Start a run to export the prepared dictionary."}
      </p>
    </div>
  );
}

/**
 * The frozen audit trail — the rule pipeline, its worked before/after examples, and the row-to-vector
 * panel — behind ONE collapsed disclosure, below the findings.
 *
 * COLLAPSED, NOT DELETED (pre-build question Q2, answered 2026-08-26 by the user; the decision recommended
 * it). Everything inside is FROZEN as built: no further work goes into it. It stays reachable for two
 * reasons that outlived the screen it was built for. The app is the only place the cleaning can be
 * audited at all — an export shows you the result, not which rule produced it. And the spec assertion
 * *"every rule the backend reports has a declared facet"* keeps its subject: `RULE_FACETS` is a HAND-KEPT
 * map, so a rule added to core and not added to it renders ZERO examples, which reads as "this rule
 * changed nothing". That assertion is the only thing standing between a new core rule and a silent
 * misreport (D-6's retired hazard), and deleting this surface would delete what it asserts against.
 *
 * BELOW THE FINDINGS, DELIBERATELY. What preparation DID is provenance; what it FOUND is what the reader
 * is here to act on. Leading with the provenance is what made the retired screen a receipt.
 */
function FrozenAuditTrail({ report }: { report: PreprocessReport }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="frozen-audit-trail"
      data-open={String(open)}
      className="border-t border-rule-on-raised"
    >
      <CollapsibleTrigger
        aria-label={open ? "Hide what preparation changed" : "Show what preparation changed"}
        className="flex w-full items-center justify-between gap-2 px-6 py-3 text-left"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            What preparation changed
          </span>
          {/* VISIBLE WITHOUT EXPANDING A ROW. The pipeline does not stamp which rule changed a variable,
              so which examples sit under which rule is inferred — and an honesty label behind a
              disclosure is not a label. It is stated a second time inside each expanded rule, where the
              inference is actually made, and once more as a tile. */}
          <span className="text-xs font-normal normal-case text-on-raised-muted">
            Every rule that ran, a worked example of each, and the exact text one variable embeds.
            Examples are grouped under rules as inferred, not reported.
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-on-raised-muted transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <RulePipelineList report={report} />
        <RowToVector report={report} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * How far preparation has actually got, derived ONCE and read by both this panel and Setup.
 *
 * TWO SURFACES, ONE DERIVATION. Setup needs `allPrepared` to know whether the run may be committed and
 * `variables` to price it from this run's own corpus rather than the pre-upload guess; this panel needs
 * the tab list and the same fraction. Deriving it twice is how two readings of one number end up
 * disagreeing on the same screen — the defect `@setup the variable count on screen is the same one the
 * estimate is priced from` was written to catch.
 */
export interface PreflightProgress {
  /** DECLARED cohorts first — see `tabs`. */
  tabs: CohortTab[];
  /** How many of them have produced a report. */
  prepared: number;
  /** True only when every declared cohort is done AND the run is past the pre-preparation phases. */
  allPrepared: boolean;
  /** Variables across the FINISHED reports. Only a total for the run when `allPrepared`. */
  variables: number;
}

export function preflightProgress(run: JobResult | null): PreflightProgress {
  const reports: PreprocessReport[] = run?.result?.preprocessing ?? [];
  const byCohort = new Map(reports.map((r) => [r.cohort, r]));
  const declared: string[] = run?.result?.summary?.cohorts ?? [];
  // DECLARED cohorts first, so a cohort the run knows about but has not prepared yet gets a tab in the
  // pending state rather than being invisible — an absent tab is indistinguishable from a cohort that was
  // never in the run.
  const order = [...declared, ...reports.map((r) => r.cohort).filter((c) => !declared.includes(c))];
  const tabs: CohortTab[] = order.map((cohort) => ({ cohort, report: byCohort.get(cohort) ?? null }));
  const prepared = tabs.filter((t) => t.report).length;
  return {
    tabs,
    prepared,
    allPrepared:
      tabs.length > 0 && prepared === tabs.length && !PRE_PREPARE_PHASES.has(run?.phase ?? ""),
    variables: reports.reduce((n, r) => n + r.nUniqueVariableNames, 0),
  };
}

/**
 * @param run    the run this pre-flight is about, straight off Setup's OWN stream subscription. Passed in
 *               rather than fetched: a second subscription beside the page's is two sources for one run's
 *               state, which is the defect the shell's stop control was written to avoid.
 * @param jobId  the run's id, for the prepared-dictionary export link.
 */
export function PreFlightPanel({ run, jobId }: { run: JobResult | null; jobId: string }) {
  const reports: PreprocessReport[] = run?.result?.preprocessing ?? [];
  const { tabs, prepared, allPrepared } = useMemo(() => preflightProgress(run), [run]);
  const [active, setActive] = useState<string>("");
  const current = active || tabs[0]?.cohort || "";

  return (
    <section data-testid="preflight" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-on-field">Before you spend</h2>
        <p className="max-w-[68ch] text-sm text-on-field-muted">
          Your dictionaries have been loaded, prepared and grouped on this machine. Nothing has been
          charged for any of it. What follows is what preparation found — read it before committing the
          run&rsquo;s first charge.
        </p>
      </div>

      {tabs.length === 0 ? (
        /* NOT an empty panel, and not a "not built yet" notice: this run genuinely carries no preparation
           report, which is a fact about the RUN. A run recorded before preprocessing existed is this. */
        <div className="rounded-card bg-surface-raised shadow-card">
          <GateEmptyState
            heading="No preparation report for this run"
            nextStep="Start a new run to see what the preparation rules do to your dictionaries."
          >
            This run carries no record of the preparation step, so nothing here can say what the rules
            changed. That is different from a run where the rules found nothing to change — that run would
            list every rule with a count of zero.
          </GateEmptyState>
        </div>
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
                      What preparation found · {t.cohort}
                    </h2>
                  </div>
                  {t.report ? (
                    <>
                      {/* The pre-spend read on the INPUT, per cohort and never averaged across them. It
                          sits under this cohort's tab rather than above the tabs for exactly that
                          reason: a cross-cohort mean would be the composite the panel refuses to be. */}
                      <PreflightFindings read={preflightRead(t.report, rolesForCohort(run, t.cohort))} />
                      <InputQualitySignals report={t.report} />
                      <PreparedExport jobId={jobId} cohort={t.cohort} />
                      <FrozenAuditTrail report={t.report} />
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

        </>
      )}
    </section>
  );
}
