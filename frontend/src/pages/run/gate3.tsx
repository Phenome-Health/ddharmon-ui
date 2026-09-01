import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { SpecEditor } from "@/components/gate/SpecEditor";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import {
  conceptMatchState,
  routesToReview,
  specForm,
  specRowsFor,
  type UnmappedOutcome,
} from "@/lib/gate23";
import { cn } from "@/lib/utils";
import type { JobResult, UIRecord, UITransform } from "@/types";

/**
 * Gate 3 - Transform specs. Where the reviewer corrects how values get to the target.
 *
 * -- WHAT THIS SCREEN REFUSES TO COLLAPSE ---------------------------------------------------------------
 *
 * Four pairs of states look identical if you only test for emptiness, and each wrong reading makes the tool
 * claim something no stage established:
 *
 *   failed vs not-generated   the stage ran and produced nothing / the run never bought the stage
 *   no-transform vs failed    nothing needed changing / we tried and could not
 *   concept-check clear vs not-enabled   the check passed / nobody checked
 *   unmapped 1 vs unmapped n  one value being dropped / a plural that hides it
 *
 * The classifications live in `lib/gate23.ts` so they can be asserted without going through the DOM.
 *
 * -- ARITHMETIC IS A CATEGORY OF RISK ------------------------------------------------------------------
 *
 * Every arithmetic spec routes to review unconditionally and is reachable through a STANDING FILTER rather
 * than a per-row chip. A per-row marker asks the reviewer to find them; a filter lets them ask for them.
 * The difference matters because an arithmetic recode that is wrong still produces plausible numbers.
 *
 * -- STALENESS IS DERIVED ON READ ----------------------------------------------------------------------
 *
 * A spec whose upstream Gate 2 pick changed arrives flagged stale, and the flag is computed by comparing
 * the spec decision's persisted upstream key against the current pick - never held in component state. The
 * shipped workbench holds its equivalent flag in `useState` and loses it on reload, which R6 forbids.
 */

const REJECT_CONFIRMATION =
  "Reject this recode? It will be excluded from the notebook and the mapping table, and recorded as " +
  "rejected in the decision log.";

function conceptLabel(r: UIRecord): string {
  return r.gencde?.preferredName || r.concept || r.idealCde || r.groupId;
}

export default function Gate3Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState, cancel } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  const records: UIRecord[] = useMemo(() => jobState?.result?.records ?? [], [jobState?.result?.records]);
  const runConfig = jobState?.config as Record<string, unknown> | undefined;
  const pinned = resolvePinned(runConfig);
  const specs = useGateDecisions(jobId, "gate3_spec_edit", { pinned });
  const picks = useGateDecisions(jobId, "gate2_candidate_pick", { pinned });

  /**
   * Whether spec generation ran at all for this run.
   *
   * DEFAULTS TO TRUE ONLY WHEN THE RUN SAYS NOTHING, because the pipeline's own default is on and a run
   * that carries transforms plainly ran it. Getting this backwards would relabel every real spec
   * "not generated".
   */
  const specsGenerated =
    runConfig?.genTransformSpecs !== false || records.some((r) => (r.transforms?.length ?? 0) > 0);
  const conceptGateOn = Boolean(runConfig?.conceptGate ?? runConfig?.concept_gate);

  const [arithmeticOnly, setArithmeticOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  /** Draft note, TAGGED WITH ITS SPEC. See the same pattern on Gate 2 - no effect, so no reset to misorder. */
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      records.map((record) => ({
        record,
        rows: specRowsFor(record, { specsGenerated }),
      })),
    [records, specsGenerated],
  );

  const visible = groups
    .map((g) => ({
      ...g,
      rows: arithmeticOnly ? g.rows.filter((r) => r.transform?.kind === "arithmetic") : g.rows,
    }))
    .filter((g) => g.rows.length > 0);

  const anyRow = groups.some((g) => g.rows.length > 0);

  if (!anyRow) {
    return (
      <Shell jobState={jobState} cancel={cancel} costSoFar={costSoFar}>
        <GateEmptyState
          heading="No transform specs to review"
          nextStep="Continue to Gate 4 to export what this run produced."
        >
          Every concept you approved was an adopt - the target&apos;s values already match, so nothing needs
          recoding.
        </GateEmptyState>
      </Shell>
    );
  }

  async function saveNote(record: UIRecord, sourceVariable: string, value: string) {
    await specs.write(
      { sourceVariable },
      {
        chosen: sourceVariable,
        alternatives: [sourceVariable],
        // The pair that makes the staleness cascade real: this spec records WHICH Gate 2 pick it was made
        // downstream of, and the derivation compares that key to the current one. One direction only -
        // a Gate 2 change makes this stale, never the reverse.
        upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
        extra: { note: value },
      },
    );
    setDraft(null);
  }

  return (
    <Shell jobState={jobState} cancel={cancel} costSoFar={costSoFar}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3">
          {/* A STANDING FILTER, not a per-row chip: arithmetic is a category of risk, so the reviewer asks
              for the category rather than hunting for its members. */}
          <Button
            data-testid="arithmetic-filter"
            data-active={arithmeticOnly}
            variant={arithmeticOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setArithmeticOnly((v) => !v)}
          >
            {arithmeticOnly ? "Showing arithmetic recodes only" : "Show arithmetic recodes only"}
          </Button>
          <span className="text-xs text-on-raised-muted">
            Every arithmetic recode is routed to review, always - a wrong formula still produces plausible
            numbers.
          </span>
        </div>

        {/* The concept-match check: a real flag on an opted-in run, an honest NAMED absence otherwise.
            Never a silent pass, and never a permanent product gap - the capability exists and this run did
            not buy it (UI-SPEC 9 row 7). */}
        {!conceptGateOn && (
          <NotAvailable slug="concept-gate" thing="Concept-match check" claim="not-enabled">
            A second model pass can check whether an assigned element measures the same concept, not just the
            same values. It is off by default so no run pays for it unless it asks. Start a new run with it
            enabled to include the check.
          </NotAvailable>
        )}

        {!specsGenerated && (
          <NotAvailable slug="specgen" thing="Transform spec generation" claim="not-enabled">
            This run did not generate transform specs, so the rows below show which variables would need one
            rather than what the recode is. That is different from a spec the pipeline tried and failed to
            produce.
          </NotAvailable>
        )}

        {visible.map(({ record, rows }) => {
          const matchState = conceptMatchState(record, { optedIn: conceptGateOn });
          const active = selectedId ? record.groupId === selectedId : true;
          return (
            <section
              key={record.groupId}
              data-testid="spec-group"
              data-concept-id={record.groupId}
              className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card"
            >
              <button
                type="button"
                data-testid="spec-concept"
                data-concept-id={record.groupId}
                onClick={() => setSelectedId(record.groupId)}
                className="flex w-full flex-wrap items-center gap-2 text-left"
              >
                <h2 className="text-sm font-semibold text-on-raised">{conceptLabel(record)}</h2>
                <span className="text-xs text-on-raised-muted">
                  {rows.length} source variable{rows.length === 1 ? "" : "s"}
                </span>
                {matchState === "flagged" && (
                  <span
                    data-testid="concept-match-flag"
                    className="rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs text-on-raised"
                  >
                    concept-match flag - the values line up but the element may measure something else
                  </span>
                )}
              </button>

              {active &&
                rows.map(({ sourceVariable, transform, state }) => {
                  const itemKey = specs.itemKey({ sourceVariable });
                  const decision = specs.decisions[itemKey];
                  const review =
                    state === "failed" ||
                    matchState === "flagged" ||
                    (transform ? routesToReview(transform) : false);
                  const noteValue =
                    draft?.key === itemKey
                      ? draft.value
                      : typeof decision?.note === "string"
                        ? decision.note
                        : "";
                  return (
                    <div
                      key={sourceVariable}
                      data-testid="spec-row"
                      data-source={sourceVariable}
                      data-state={state}
                      data-form={transform ? specForm(transform.kind) : "none"}
                      data-review={String(review)}
                      data-stale={String(specs.isStale(itemKey))}
                      data-concept-mismatch={String(matchState === "flagged")}
                      className={cn(
                        "flex flex-col gap-2 rounded-inner border px-6 py-4",
                        review ? "border-l-4 border-l-accent-action border-rule-on-raised" : "border-rule-on-raised",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-on-raised">{sourceVariable}</span>
                        <span className="rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs text-on-raised-muted">
                          {transform ? transform.kind : state}
                        </span>
                        {specs.isStale(itemKey) && (
                          <span
                            data-testid="stale-badge"
                            className="rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs text-on-raised"
                          >
                            stale - the target changed at Gate 2 after this was decided
                          </span>
                        )}
                        {review && (
                          <span className="rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs text-on-raised">
                            routed to review
                          </span>
                        )}
                      </div>

                      {/* A FAILED spec is shown, and shown AS failed. Omitting it removes the only evidence
                          the variable was ever in scope; showing it as complete is worse still. */}
                      {state === "failed" && (
                        <p className="max-w-[68ch] text-xs text-on-raised-muted">
                          Spec generation ran for this run and did not generate a recode for this variable.
                          It is routed to review rather than dropped - the variable is still in scope and
                          still needs an answer.
                        </p>
                      )}

                      {state === "not-generated" && (
                        <p className="max-w-[68ch] text-xs text-on-raised-muted">
                          No transform spec was generated for this run, so nothing has been attempted for this
                          variable.
                        </p>
                      )}

                      {state === "no-transform" && (
                        <p className="max-w-[68ch] text-xs text-on-raised-muted">
                          No transform required - the source values already match the target&apos;s value
                          domain.
                        </p>
                      )}

                      {transform && state === "ok" && (
                        <SpecEditor
                          transform={transform}
                          unmappedChoice={
                            (decision?.unmapped as Record<string, UnmappedOutcome> | undefined) ?? undefined
                          }
                          onUnmappedChoice={(code, outcome) =>
                            void specs.write(
                              { sourceVariable },
                              {
                                chosen: sourceVariable,
                                alternatives: [sourceVariable],
                                upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
                                extra: {
                                  ...(typeof decision?.note === "string" ? { note: decision.note } : {}),
                                  unmapped: {
                                    ...((decision?.unmapped as Record<string, string> | undefined) ?? {}),
                                    [code]: outcome,
                                  },
                                },
                              },
                            )
                          }
                        />
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          data-testid="spec-note-input"
                          aria-label={`Note on the recode for ${sourceVariable}`}
                          placeholder="Your note on this recode"
                          value={noteValue}
                          onChange={(e) => setDraft({ key: itemKey, value: e.target.value })}
                          className="max-w-96 text-xs"
                        />
                        <Button
                          data-testid="spec-save"
                          size="sm"
                          variant="outline"
                          onClick={() => void saveNote(record, sourceVariable, noteValue)}
                        >
                          Save
                        </Button>
                        <Button
                          data-testid="spec-reject"
                          size="sm"
                          variant="outline"
                          onClick={() => setRejecting(itemKey)}
                        >
                          Reject
                        </Button>
                      </div>

                      {rejecting === itemKey && (
                        <div
                          data-testid="reject-confirm"
                          role="alertdialog"
                          aria-label="Reject this recode"
                          className="flex flex-col gap-2 rounded-inner border border-rule-on-raised px-6 py-3"
                        >
                          <p className="max-w-[68ch] text-xs text-on-raised">{REJECT_CONFIRMATION}</p>
                          <div className="flex gap-2">
                            <Button
                              data-testid="reject-accept"
                              size="sm"
                              onClick={() => {
                                void specs.write(
                                  { sourceVariable },
                                  {
                                    chosen: "",
                                    alternatives: [sourceVariable],
                                    upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
                                    extra: { rejected: true },
                                  },
                                );
                                setRejecting(null);
                              }}
                            >
                              Reject
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setRejecting(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
            </section>
          );
        })}

        {/* Read only to keep the upstream hook mounted, so a Gate 2 change is visible here without a
            second fetch. Rendering the count makes the dependency observable rather than implicit. */}
        <p className="text-xs text-on-raised-muted">
          {Object.keys(picks.decisions).length} target{Object.keys(picks.decisions).length === 1 ? "" : "s"}{" "}
          re-picked at Gate 2 on this run.
        </p>
      </div>
    </Shell>
  );
}

function Shell({
  jobState,
  cancel,
  costSoFar,
  children,
}: {
  jobState: JobResult | null;
  cancel: (mode: "keep" | "discard") => Promise<void> | void;
  costSoFar: number;
  children: React.ReactNode;
}) {
  return (
    <GateShell
      gate="gate3"
      subhead="One recode per source variable, grouped by concept. Arithmetic recodes always come to you for review."
      rail={railFor("gate3", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      job={jobState}
      onStop={cancel}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate3"}
    >
      <span data-testid="run-status" data-status={jobState?.status ?? "unknown"} className="sr-only">
        Run status: {jobState?.status ?? "unknown"}
      </span>
      {children}
    </GateShell>
  );
}
