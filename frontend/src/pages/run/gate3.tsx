import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommitBar } from "@/components/gate/CommitBar";
import { GATE_LABELS } from "@/components/gate/GateRail";
import { GateShell, railFor, realizedRailArgs } from "@/components/gate/GateShell";
import {
  ConceptWorkbench,
  ConceptQueueRow,
  ConceptDetailHeader,
  VerdictPill,
  InheritedPanel,
} from "@/components/gate/ConceptWorkbench";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { RecodeDetail, transformSummary } from "@/components/gate/RecodeDetail";
import {
  SpecMappingEditor,
  seedRecommendedMapping,
  codeMapToBuckets,
} from "@/components/gate/SpecMappingEditor";
import { SpecNumberMap } from "@/components/gate/SpecNumberMap";
import { SpecBinning } from "@/components/gate/SpecBinning";
import { SourceRows } from "@/components/source-rows";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import { getCheckpoint, resumeRun } from "@/lib/api";
import { isGatePast, pathForGate } from "@/lib/gate-routes";
import { isTerminal, resumeTookEffect } from "@/lib/run-state";
import {
  conceptMatchState,
  recodeShape,
  routesToReview,
  seedBinning,
  seedNumberMap,
  specForm,
  specRowsFor,
  type BinRule,
  type NumberMapEntry,
} from "@/lib/gate23";
import { cn } from "@/lib/utils";
import { permissibleValueLabels, sourceValueLabels } from "@/types";
import type { JobResult, UIRecord, GatePosition } from "@/types";

/**
 * Gate 3 — Transform specs. Where the reviewer corrects how values get to the target.
 *
 * -- SAME FRAME, SAME INHERITANCE (08-16g) -------------------------------------------------------------
 *
 * The stacked full-width sections were replaced by Gate 1's master-detail frame (`ConceptWorkbench`): the
 * concepts are a scannable queue on the left, one concept's recodes fill the detail on the right. Like Gate
 * 2 it shows ONLY the groups Gate 1 passed (`gate1_group_scope` != "out"), and it now renders the source
 * dictionary rows — the evidence layer under every recode, the same grid Gate 1 and Gate 2 show.
 *
 * -- WHAT THIS SCREEN REFUSES TO COLLAPSE -------------------------------------------------------------
 *
 * Four pairs of states look identical if you only test for emptiness, and each wrong reading makes the tool
 * claim something no stage established: failed vs not-generated, no-transform vs failed, concept-check clear
 * vs not-enabled, unmapped-1 vs unmapped-n. The classifications live in `lib/gate23.ts` so they can be
 * asserted without the DOM.
 *
 * -- ARITHMETIC IS A CATEGORY OF RISK -----------------------------------------------------------------
 *
 * Every arithmetic spec routes to review unconditionally, reachable through a STANDING FILTER rather than a
 * per-row chip — a wrong formula still produces plausible numbers.
 *
 * -- STALENESS IS DERIVED ON READ ---------------------------------------------------------------------
 *
 * A spec whose upstream Gate 2 pick changed arrives flagged stale, computed by comparing the spec's
 * persisted upstream key against the current pick — never held in component state (R6).
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
  const costSoFar =
    jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  const allRecords: UIRecord[] = useMemo(
    () => jobState?.result?.records ?? [],
    [jobState?.result?.records],
  );
  const fieldIndex = jobState?.result?.fieldIndex ?? {};
  const runConfig = jobState?.config as Record<string, unknown> | undefined;
  const pinned = resolvePinned(runConfig);
  const frozen = isGatePast(
    "gate3",
    (jobState?.gatePosition ?? null) as GatePosition | null,
  );

  // The commit bar past Gate 3 (08-23b Task 1). Same paid-resume idiom as Gate 1/2, but continuing to Gate 4
  // BUYS NOTHING — Gate 4 is a pure read the backend carries forward without a worker — so the bar quotes no
  // amount. A refused/failed continue leaves the reviewer here to retry.
  const [, navigate] = useLocation();
  const [resuming, setResuming] = useState(false);
  const parkedHere =
    jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate3";
  const failedLeg =
    !!jobState && isTerminal(jobState.status) && jobState.status !== "complete";

  async function onContinue() {
    setResuming(true);
    try {
      const { target } = await resumeRun(jobId);
      const after = await getCheckpoint(jobId).catch(() => null);
      if (after && !resumeTookEffect(after, target)) {
        toast.error(
          "The server accepted Continue, but this run has not started — it is still parked at this gate. Nothing was charged. Please report this run id.",
        );
        return;
      }
      toast.success(`Continuing to ${GATE_LABELS[target as GatePosition] ?? target}`);
      navigate(pathForGate(jobId, target));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not continue this run");
    } finally {
      setResuming(false);
    }
  }

  const specs = useGateDecisions(jobId, "gate3_spec_edit", { pinned, frozen });
  const picks = useGateDecisions(jobId, "gate2_candidate_pick", {
    pinned,
    frozen,
  });
  // Read-only inheritance from Gate 1: only in-scope groups reach this screen.
  const scope = useGateDecisions(jobId, "gate1_group_scope", { pinned });
  const inScope = (groupId: string) =>
    scope.decisions[groupId]?.chosen !== "out";

  const specsGenerated =
    runConfig?.genTransformSpecs !== false ||
    allRecords.some((r) => (r.transforms?.length ?? 0) > 0);
  const conceptGateOn = Boolean(
    runConfig?.conceptGate ?? runConfig?.concept_gate,
  );

  const [arithmeticOnly, setArithmeticOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(
    null,
  );
  const [rejecting, setRejecting] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      allRecords
        .filter((r) => inScope(r.groupId))
        .map((record) => ({
          record,
          rows: specRowsFor(record, { specsGenerated }),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRecords, specsGenerated, scope.decisions],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        rows: arithmeticOnly
          ? g.rows.filter((r) => r.transform?.kind === "arithmetic")
          : g.rows,
      }))
      .filter((g) => g.rows.length > 0)
      .filter((g) => !q || conceptLabel(g.record).toLowerCase().includes(q));
  }, [groups, arithmeticOnly, query]);

  const anyRow = groups.some((g) => g.rows.length > 0);
  const selected =
    visible.find((g) => g.record.groupId === selectedId) ?? visible[0];

  if (!anyRow) {
    return (
      <Shell
        jobId={jobId}
        jobState={jobState}
        cancel={cancel}
        costSoFar={costSoFar}
      >
        <GateEmptyState
          heading="No transform specs to review"
          nextStep="Continue to Gate 4 to export what this run produced."
        >
          Every concept you passed was an adopt — the target&apos;s values
          already match, so nothing needs recoding.
        </GateEmptyState>
      </Shell>
    );
  }

  async function saveNote(
    record: UIRecord,
    sourceVariable: string,
    value: string,
  ) {
    await specs.write(
      { sourceVariable },
      {
        chosen: sourceVariable,
        alternatives: [sourceVariable],
        upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
        extra: { note: value },
      },
    );
    setDraft(null);
  }

  // A value-mapping edit persists immediately, the way a Gate 1 move does — the reviewer's mapping survives
  // a reload (R6). The existing note/unmapped on the decision are preserved.
  async function saveMapping(
    record: UIRecord,
    sourceVariable: string,
    mapping: Record<string, string>,
    prev: Record<string, unknown> | undefined,
  ) {
    await specs.write(
      { sourceVariable },
      {
        chosen: sourceVariable,
        alternatives: [sourceVariable],
        upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
        extra: {
          ...(typeof prev?.note === "string" ? { note: prev.note } : {}),
          mapping,
        },
      },
    );
  }

  // ② A code→number edit (categorical source, numeric target) persists the same way; other decision fields
  // on the record (note, an unrelated mapping) are preserved.
  async function saveNumberMap(
    record: UIRecord,
    sourceVariable: string,
    numberMap: Record<string, NumberMapEntry>,
    prev: Record<string, unknown> | undefined,
  ) {
    await specs.write(
      { sourceVariable },
      {
        chosen: sourceVariable,
        alternatives: [sourceVariable],
        upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
        extra: {
          ...(typeof prev?.note === "string" ? { note: prev.note } : {}),
          numberMap,
        },
      },
    );
  }

  // ③ A binning edit (numeric source, categorical target) persists the reviewer's band boundaries.
  async function saveBins(
    record: UIRecord,
    sourceVariable: string,
    bins: BinRule[],
    prev: Record<string, unknown> | undefined,
  ) {
    await specs.write(
      { sourceVariable },
      {
        chosen: sourceVariable,
        alternatives: [sourceVariable],
        upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
        extra: {
          ...(typeof prev?.note === "string" ? { note: prev.note } : {}),
          bins,
        },
      },
    );
  }

  return (
    <Shell
      jobId={jobId}
      jobState={jobState}
      cancel={cancel}
      costSoFar={costSoFar}
    >
      <ConceptWorkbench
        gate="gate3"
        toolbar={
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                data-testid="term-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search concept…"
                aria-label="Filter concepts"
                className="h-8 min-w-[11rem] flex-1 rounded-inner border border-rule-control-on-raised bg-surface-raised px-2.5 text-sm text-on-raised placeholder:text-on-raised-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />
              <span className="ml-auto text-xs text-on-raised-muted">
                <span className="font-mono tabular-nums text-on-raised">
                  {visible.length}
                </span>{" "}
                {visible.length === 1 ? "concept" : "concepts"}
              </span>
            </div>
            {/* A STANDING FILTER, not a per-row chip: the reviewer asks for the risk category. */}
            <Button
              data-testid="arithmetic-filter"
              data-active={arithmeticOnly}
              variant={arithmeticOnly ? "default" : "outline"}
              size="sm"
              className="w-fit"
              onClick={() => setArithmeticOnly((v) => !v)}
            >
              {arithmeticOnly
                ? "Showing arithmetic recodes only"
                : "Show arithmetic recodes only"}
            </Button>
          </div>
        }
        rows={visible.map(({ record, rows }) => {
          const matchState = conceptMatchState(record, {
            optedIn: conceptGateOn,
          });
          return (
            <ConceptQueueRow
              key={record.groupId}
              id={record.groupId}
              testid="gate3-concept"
              label={conceptLabel(record)}
              badges={
                <>
                  <VerdictPill verdict={record.verdict} />
                  {matchState === "flagged" && (
                    <span
                      data-testid="concept-match-flag"
                      className="rounded-pill border border-status-warn px-2 py-0.5 text-xs text-on-warn"
                    >
                      concept-match flag
                    </span>
                  )}
                </>
              }
              cohorts={record.cohorts}
              count={rows.length}
              selected={record.groupId === (selected?.record.groupId ?? null)}
              onSelect={() => setSelectedId(record.groupId)}
            />
          );
        })}
        footer={
          <p className="text-xs text-on-raised-muted">
            {Object.keys(picks.decisions).length} target
            {Object.keys(picks.decisions).length === 1 ? "" : "s"} re-picked at
            Gate 2 on this run.
          </p>
        }
        detail={
          selected ? (
            (() => {
              const { record, rows } = selected;
              const matchState = conceptMatchState(record, {
                optedIn: conceptGateOn,
              });
              const tgtLabels = permissibleValueLabels(
                record.gencde?.permissibleValues,
              );
              // INHERITED FROM GATE 2: the target the reviewer chose there (a catalog CDE, the synthesized
              // GenCDE, or their own) — resolved read-only from the persisted pick, so Gate 3 shows what the
              // recodes map INTO. This is what makes Gate 3 the full workbench.
              const pick = picks.decisions[record.groupId];
              const chosenTargetId =
                (typeof pick?.chosen === "string" ? pick.chosen : undefined) ??
                record.candidates.find((c) => c.isChosen)?.cdeId ??
                "";
              const chosenCandidate = record.candidates.find(
                (c) => c.cdeId === chosenTargetId,
              );
              const gencdeEdit =
                (pick?.gencdeEdit as
                  { name?: string; definition?: string } | undefined) ??
                undefined;
              const targetIsOwn =
                chosenTargetId === "" ||
                (!!record.gencde && chosenTargetId === record.gencde.gencdeId);
              const targetName = targetIsOwn
                ? (gencdeEdit?.name ??
                  record.gencde?.preferredName ??
                  record.gencde?.title ??
                  "your own CDE")
                : (chosenCandidate?.cdeId ?? chosenTargetId ?? "none chosen");
              const targetDef = targetIsOwn
                ? (gencdeEdit?.definition ?? record.gencde?.definition ?? "")
                : (chosenCandidate?.definition ?? "");
              // The target's value domain (08-16g) — carried into Gate 3 so recodes can be built and judged
              // against it. Adopt -> the chosen catalog candidate's enriched metadata; own/novel -> the GenCDE.
              const targetPVs: string[] = targetIsOwn
                ? (record.gencde?.permissibleValues?.map(
                    (v) => v.label || v.code,
                  ) ?? [])
                : (chosenCandidate?.permissibleValues ?? []);
              const targetDataType = targetIsOwn
                ? record.gencde?.dataType
                : chosenCandidate?.dataType;
              const targetUnits = targetIsOwn
                ? record.gencde?.units
                : chosenCandidate?.units;
              return (
                <div className="flex flex-col gap-4">
                  <ConceptDetailHeader
                    title={conceptLabel(record)}
                    badges={
                      <>
                        <VerdictPill verdict={record.verdict} />
                        {matchState === "flagged" && (
                          <span
                            data-testid="concept-match-flag"
                            className="rounded-pill border border-status-warn px-2 py-0.5 text-xs text-on-warn"
                          >
                            concept-match flag — the values line up but the
                            element may measure something else
                          </span>
                        )}
                      </>
                    }
                    meta={
                      <>
                        <span className="font-semibold text-on-raised">
                          {rows.length}
                        </span>{" "}
                        source {rows.length === 1 ? "variable" : "variables"} ·{" "}
                        {record.cohorts?.join(", ")}
                      </>
                    }
                  />

                  {/* Global not-available tiles for the run, shown in-pane so the reviewer sees them per concept. */}
                  {!conceptGateOn && (
                    <NotAvailable
                      slug="concept-gate"
                      thing="Concept-match check"
                      claim="not-enabled"
                    >
                      A second model pass can check whether an assigned element
                      measures the same concept, not just the same values. It is
                      off by default so no run pays for it unless it asks. Start
                      a new run with it enabled to include the check.
                    </NotAvailable>
                  )}
                  {!specsGenerated && (
                    <NotAvailable
                      slug="specgen"
                      thing="Transform spec generation"
                      claim="not-enabled"
                    >
                      This run did not generate transform specs, so the rows
                      below show which variables would need one rather than what
                      the recode is. That is different from a spec the pipeline
                      tried and failed to produce.
                    </NotAvailable>
                  )}

                  {/* INHERITED FROM GATE 1: the source variables — collapsed; one click for the raw encodings. */}
                  <InheritedPanel
                    from="Gate 1"
                    label="source variables"
                    detail={`${record.nMembers} ${record.nMembers === 1 ? "variable" : "variables"} · ${record.cohorts?.join(", ")}`}
                    testid="inherited-source-rows"
                  >
                    <SourceRows
                      memberIds={record.members}
                      memberDetails={record.memberDetails}
                      fieldIndex={fieldIndex}
                    />
                  </InheritedPanel>

                  {/* INHERITED FROM GATE 2: the chosen/synthesized target + the generated ideal — what the
                      recodes below map INTO. Open by default: a transform is judged against its target. */}
                  <InheritedPanel
                    from="Gate 2"
                    label="chosen target"
                    detail={targetName}
                    defaultOpen
                    testid="inherited-target"
                  >
                    <div className="flex flex-col gap-3">
                      <div
                        data-testid="chosen-target"
                        className="flex flex-col gap-1"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">
                            {targetIsOwn ? "Synthesized CDE" : "Selected CDE"}
                          </span>
                          <span className="text-sm font-semibold text-on-raised">
                            {targetName}
                          </span>
                          <VerdictPill verdict={record.verdict} />
                        </div>
                        {targetDef && (
                          <p className="max-w-[80ch] text-sm text-on-raised-muted">
                            {targetDef}
                          </p>
                        )}
                        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-on-raised-muted">
                          {targetDataType && (
                            <div>
                              <dt className="inline font-semibold">
                                Data type:{" "}
                              </dt>
                              <dd className="inline">{targetDataType}</dd>
                            </div>
                          )}
                          {targetUnits && (
                            <div>
                              <dt className="inline font-semibold">Units: </dt>
                              <dd className="inline">{targetUnits}</dd>
                            </div>
                          )}
                        </dl>
                        {targetPVs.length > 0 && (
                          <div data-testid="target-permissible-values">
                            <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">
                              Permissible values ({targetPVs.length})
                            </span>
                            <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                              {targetPVs.map((v, i) => (
                                <span
                                  key={i}
                                  className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-on-raised"
                                >
                                  {v}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </InheritedPanel>

                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold text-on-raised">
                      Value mapping ({rows.length})
                    </h3>
                    {rows.map(({ sourceVariable, transform, state }) => {
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
                      const srcLabels = sourceValueLabels(
                        fieldIndex[sourceVariable],
                      );
                      const toGenCDE =
                        !!record.gencde &&
                        transform?.targetCdeId === record.gencde.gencdeId;
                      // The editable mapping: source response options -> target permissible values. Built even
                      // when generation FAILED, from the source options + the target's PVs, seeded with the
                      // model's code map where it produced one. Persisted edits win over the recommendation.
                      const sourceOptions = Object.entries(srcLabels).map(
                        ([code, label]) => ({ code, label }),
                      );
                      const hasOptions = sourceOptions.length > 0;
                      const recommendedMapping = seedRecommendedMapping(
                        sourceOptions,
                        targetPVs,
                        codeMapToBuckets(transform?.codeMap, targetPVs),
                      );
                      const persistedMapping = decision?.mapping as
                        Record<string, string> | undefined;
                      const mappingValue =
                        persistedMapping ?? recommendedMapping;
                      // The recode SURFACE follows the target type, not the source's coded options: a coded
                      // source on a NUMERIC target is a code→number table (②), a numeric source on a banded
                      // target is a range table (③), a coded source on a categorical target is the drag-drop
                      // value map (①), and everything else keeps its read-only detail (④). `recodeShape`
                      // owns the decision so the render stays a switch.
                      const shape = recodeShape({
                        targetDataType,
                        targetValues: targetPVs,
                        hasSourceOptions: hasOptions,
                        kind: transform?.kind,
                      });
                      const recommendedNumberMap = seedNumberMap(sourceOptions);
                      const numberMapValue = seedNumberMap(
                        sourceOptions,
                        decision?.numberMap as
                          Record<string, NumberMapEntry> | undefined,
                      );
                      const recommendedBins = seedBinning(targetPVs);
                      const binsValue = seedBinning(
                        targetPVs,
                        decision?.bins as BinRule[] | undefined,
                      );
                      return (
                        <div
                          key={sourceVariable}
                          data-testid="spec-row"
                          data-source={sourceVariable}
                          data-state={state}
                          data-form={
                            transform ? specForm(transform.kind) : "none"
                          }
                          data-review={String(review)}
                          data-stale={String(specs.isStale(itemKey))}
                          data-concept-mismatch={String(
                            matchState === "flagged",
                          )}
                          className={cn(
                            "flex flex-col gap-2 rounded-inner border px-4 py-3",
                            review
                              ? "border-l-4 border-l-accent-action border-rule-on-raised"
                              : "border-rule-on-raised",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-on-inset-muted">
                              {transform ? transform.kind : state}
                            </span>
                            <span className="font-mono text-xs text-on-raised">
                              {sourceVariable}
                            </span>
                            {transform && (
                              <>
                                <span className="text-on-raised-faint">→</span>
                                <span className="text-xs text-on-raised">
                                  {transformSummary(transform)}
                                </span>
                              </>
                            )}
                            {toGenCDE && (
                              <span className="rounded-pill border border-rule-info px-2 py-0.5 text-xs text-accent-on-raised">
                                {record.gencde?.parentCdeId
                                  ? "→ Refined CDE"
                                  : "→ Proposed GenCDE"}
                              </span>
                            )}
                            {transform && (
                              <span className="text-xs text-on-raised-muted">
                                coverage {(transform.coverage * 100).toFixed(0)}
                                %
                              </span>
                            )}
                            {transform?.needsUnits && (
                              <span className="rounded-pill border border-status-warn px-2 py-0.5 text-xs text-on-warn">
                                units
                              </span>
                            )}
                            {transform?.needsData && (
                              <span className="rounded-pill border border-status-warn px-2 py-0.5 text-xs text-on-warn">
                                data
                              </span>
                            )}
                            {specs.isStale(itemKey) && (
                              <span
                                data-testid="stale-badge"
                                className="rounded-pill border border-status-warn px-2 py-0.5 text-xs text-on-warn"
                              >
                                stale — the target changed at Gate 2 after this
                                was decided
                              </span>
                            )}
                            {review && (
                              <span className="rounded-pill border border-accent-action px-2 py-0.5 text-xs text-accent-on-raised">
                                routed to review
                              </span>
                            )}
                          </div>

                          {state === "failed" && (
                            <p className="max-w-[68ch] text-xs text-on-raised-muted">
                              Spec generation ran for this run and did not
                              generate a recode for this variable. It is routed
                              to review rather than dropped — the variable is
                              still in scope and still needs an answer.
                            </p>
                          )}
                          {state === "not-generated" && (
                            <p className="max-w-[68ch] text-xs text-on-raised-muted">
                              No transform spec was generated for this run, so
                              nothing has been attempted for this variable.
                            </p>
                          )}
                          {state === "no-transform" && (
                            <p className="max-w-[68ch] text-xs text-on-raised-muted">
                              No transform required — the source values already
                              match the target&apos;s value domain.
                            </p>
                          )}

                          {/* The recode surface is chosen by the TARGET type (see `recodeShape`), so a coded
                          source landing on a numeric CDE gets a code→number table instead of chips with
                          nowhere to drop. Each surface renders for an OK spec AND a FAILED one (seeded from a
                          $0 heuristic), so a reviewer fixes the recode rather than only annotating it. */}
                          {shape === "value-map" && (
                            <SpecMappingEditor
                              sourceOptions={sourceOptions}
                              targetValues={targetPVs}
                              value={mappingValue}
                              recommended={recommendedMapping}
                              readOnly={frozen}
                              onChange={(m) =>
                                void saveMapping(
                                  record,
                                  sourceVariable,
                                  m,
                                  decision,
                                )
                              }
                            />
                          )}
                          {shape === "code-to-number" && (
                            <SpecNumberMap
                              sourceOptions={sourceOptions}
                              targetUnits={targetUnits}
                              value={numberMapValue}
                              recommended={recommendedNumberMap}
                              readOnly={frozen}
                              onChange={(m) =>
                                void saveNumberMap(
                                  record,
                                  sourceVariable,
                                  m,
                                  decision,
                                )
                              }
                            />
                          )}
                          {shape === "binning" && (
                            <SpecBinning
                              value={binsValue}
                              recommended={recommendedBins}
                              readOnly={frozen}
                              onChange={(b) =>
                                void saveBins(
                                  record,
                                  sourceVariable,
                                  b,
                                  decision,
                                )
                              }
                            />
                          )}
                          {shape === "recode-detail" &&
                            transform &&
                            state === "ok" && (
                              <RecodeDetail
                                t={transform}
                                srcLabels={srcLabels}
                                tgtLabels={tgtLabels}
                              />
                            )}

                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              data-testid="spec-note-input"
                              aria-label={`Note on the recode for ${sourceVariable}`}
                              placeholder="Your note on this recode"
                              value={noteValue}
                              disabled={frozen}
                              onChange={(e) =>
                                setDraft({
                                  key: itemKey,
                                  value: e.target.value,
                                })
                              }
                              className="max-w-96 text-xs"
                            />
                            <Button
                              data-testid="spec-save"
                              size="sm"
                              variant="outline"
                              disabled={frozen}
                              onClick={() =>
                                void saveNote(record, sourceVariable, noteValue)
                              }
                            >
                              Save
                            </Button>
                            <Button
                              data-testid="spec-reject"
                              size="sm"
                              variant="outline"
                              disabled={frozen}
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
                              className="flex flex-col gap-2 rounded-inner border border-rule-on-raised px-4 py-3"
                            >
                              <p className="max-w-[68ch] text-xs text-on-raised">
                                {REJECT_CONFIRMATION}
                              </p>
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
                                        upstream: {
                                          kind: "gate2_candidate_pick",
                                          itemKey: record.groupId,
                                        },
                                        extra: { rejected: true },
                                      },
                                    );
                                    setRejecting(null);
                                  }}
                                >
                                  Reject
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setRejecting(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()
          ) : (
            <p className="py-16 text-center text-sm text-on-raised-muted">
              Select a concept on the left.
            </p>
          )
        }
      />
      <CommitBar
        action={failedLeg ? "Retry — continue this run" : "Continue to Gate 4"}
        actionTestId="gate3-continue"
        spentHere={costSoFar}
        recheckNotice={
          failedLeg
            ? "The last attempt to continue this run did not finish. Nothing further was charged — press Retry to run the same step again."
            : undefined
        }
        assurance="Continuing to Gate 4 buys nothing — Gate 4 is a read of what this run already produced."
        onCommit={onContinue}
        busy={resuming}
        disabled={frozen || (!parkedHere && !failedLeg)}
      />
    </Shell>
  );
}

function Shell({
  jobId,
  jobState,
  cancel,
  costSoFar,
  children,
}: {
  jobId: string;
  jobState: JobResult | null;
  cancel: (mode: "keep" | "discard") => Promise<void> | void;
  costSoFar: number;
  children: React.ReactNode;
}) {
  return (
    <GateShell
      gate="gate3"
      jobId={jobId}
      subhead="One recode per source variable, grouped by concept. Arithmetic recodes always come to you for review."
      rail={railFor("gate3", realizedRailArgs(jobState?.result?.cost, costSoFar))}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      job={jobState}
      onStop={cancel}
      resumed={
        jobState?.status === "awaiting_review" &&
        jobState?.gatePosition === "gate3"
      }
    >
      <span
        data-testid="run-status"
        data-status={jobState?.status ?? "unknown"}
        className="sr-only"
      >
        Run status: {jobState?.status ?? "unknown"}
      </span>
      {children}
    </GateShell>
  );
}
