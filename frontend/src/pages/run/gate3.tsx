import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommitBar } from "@/components/gate/CommitBar";
import { RunKeyField } from "@/components/gate/RunKeyField";
import { GATE_LABELS } from "@/components/gate/GateRail";
import { GateShell } from "@/components/gate/GateShell";
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
import { SpecMappingEditor } from "@/components/gate/SpecMappingEditor";
import { CombineRuleControl } from "@/components/gate/CombineRule";
import { CatalogLink } from "@/components/gate/CatalogLink";
import { SpecNumberMap } from "@/components/gate/SpecNumberMap";
import { SpecBinning } from "@/components/gate/SpecBinning";
import { SourceRows } from "@/components/source-rows";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { inheritedGate1Scope, resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import { getCheckpoint, resumeRun } from "@/lib/api";
import { heldRunKey, isPreviewRun, keyAskFor, type KeyRefusal } from "@/lib/run-key";
import { isGatePast, nextRailGate, pathForGate } from "@/lib/gate-routes";
import { isGateLocked } from "@/lib/review-mode";
import { frozenContinue, realizedRailArgs } from "@/lib/gate-rail";
import { conceptTitle } from "@/lib/ledger";
import { DEMO_CONTINUE_NOTE } from "@/lib/sandbox";
import { isInFlight, isParkedAt, isTerminal, resumeTookEffect } from "@/lib/run-state";
import {
  conceptMatchState,
  recodeShape,
  mergeSpecEdit,
  routesToReview,
  seedBinning,
  seedNumberMap,
  specForm,
  specRowsFor,
  specTargetMismatch,
  specUnproduced,
  targetValuesFromSpecs,
  type BinRule,
  type NumberMapEntry,
} from "@/lib/gate23";
import {
  catalogTargetValues,
  generatedTargetValues,
  mappingHeadline,
  mappingInCodes,
  mappingSummary,
  recommendedMapping,
  rowTargetValues,
  withModelTargets,
  type TargetValue,
} from "@/lib/value-map";
import { combineAlternatives, combineChoice, combineGroups } from "@/lib/combine-rules";
import {
  canRemoveMember,
  cohortsLeft,
  removalWrite,
  removedMembersOf,
  withoutRemovedMembers,
} from "@/lib/member-exclusion";
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
  const position = (jobState?.gatePosition ?? null) as GatePosition | null;
  const past = isGatePast("gate3", position);
  // Locked = a record that can no longer change. A gate a person continued is one; a gate Full auto committed was
  // never reviewed, so it stays open to review (08-30) — the server's `_refuse_past_gate` draws the same line.
  const frozen = isGateLocked("gate3", position, runConfig, "gate3_spec_edit");

  // The commit bar past Gate 3 (08-23b Task 1). Same paid-resume idiom as Gate 1/2, but continuing to Gate 4
  // BUYS NOTHING — Gate 4 is a pure read the backend carries forward without a worker — so the bar quotes no
  // amount. A refused/failed continue leaves the reviewer here to retry.
  const [, navigate] = useLocation();
  const [resuming, setResuming] = useState(false);
  // Set when the server refused Continue for want of a BYOK key (08-28): the bar then asks for one inline. The
  // hop to Gate 4 is a free read the server never refuses for a key; a Retry of a failed leg may be paid.
  const [keyAsk, setKeyAsk] = useState<KeyRefusal | null>(null);
  const parkedHere =
    jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate3";
  const failedLeg =
    !!jobState && isTerminal(jobState.status) && jobState.status !== "complete";
  const continueAction = failedLeg ? "Retry — continue this run" : "Continue to Gate 4";
  // A passed Gate 3 keeps its bar, but says what its Continue did instead of offering it again (O2). Not on the
  // shared demo: it is WALKED (08-18), so even a demo parked further on keeps the walk forward on this bar.
  const pastBar =
    past && pinned !== true
      ? frozenContinue("gate3", realizedRailArgs(jobState?.result?.cost, costSoFar).realizedByGate)
      : null;

  async function onContinue() {
    // The shared demo is walked, not resumed (08-18) — see Gate 1's `onContinue`.
    if (pinned === true) {
      navigate(pathForGate(jobId, nextRailGate("gate3") ?? "gate4"));
      return;
    }
    setResuming(true);
    try {
      // The tab's held key rides every Continue (08-28); with none, the server decides.
      const { target } = await resumeRun(jobId, heldRunKey());
      setKeyAsk(null);
      const after = await getCheckpoint(jobId, heldRunKey()).catch(() => null);
      if (after && !resumeTookEffect(after, target)) {
        toast.error(
          "The server accepted Continue, but this run has not started — it is still parked at this gate. Nothing was charged. Please report this run id.",
        );
        return;
      }
      toast.success(`Continuing to ${GATE_LABELS[target as GatePosition] ?? target}`);
      navigate(pathForGate(jobId, target));
    } catch (e) {
      setKeyAsk(keyAskFor(e, { pinned: !!pinned, preview: isPreviewRun(runConfig) }));
      toast.error(e instanceof Error ? e.message : "Could not continue this run");
    } finally {
      setResuming(false);
    }
  }

  const specs = useGateDecisions(jobId, "gate3_spec_edit", { pinned, frozen });
  // 08-28 1d (Q4): how several of one cohort's variables on one target column combine.
  const combines = useGateDecisions(jobId, "gate3_combine_rule", { pinned, frozen });
  // Review round 2: a variable the reviewer REMOVED from a concept (a rogue member). Its own kind, keyed on the
  // (group, variable) pair; the export leaves it out of that concept everywhere. Undo deletes the row.
  const exclusions = useGateDecisions(jobId, "gate3_member_exclusion", { pinned, frozen });
  const removedIn = (groupId: string) => removedMembersOf(exclusions.decisions, groupId);
  const picks = useGateDecisions(jobId, "gate2_candidate_pick", {
    pinned,
    frozen,
  });
  // Read-only inheritance from Gate 1: only in-scope groups reach this screen.
  const scope = useGateDecisions(jobId, "gate1_group_scope", { pinned });
  // A concept is titled by its Gate 1 GROUP name — the reviewer's rename if any (08-27 option C), else the name
  // Gate 1 showed — never by its target's name, the same rule as Gate 2 (phase-8 final review; `conceptTitle`).
  const renames = useGateDecisions(jobId, "gate1_rename", { pinned });
  const labelOf = (r: UIRecord) => conceptTitle(r, renames.decisions[r.groupId]);
  // The scope Gate 1 SHOWED, frozen by its Continue (08-27 #3); legacy default-in without one.
  const inScope = inheritedGate1Scope(runConfig, scope.decisions);

  const specsGenerated =
    runConfig?.genTransformSpecs !== false ||
    allRecords.some((r) => (r.transforms?.length ?? 0) > 0);
  const conceptGateOn = Boolean(
    runConfig?.conceptGate ?? runConfig?.concept_gate,
  );

  const [arithmeticOnly, setArithmeticOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  // Unsaved note text PER ROW — a single draft slot lost row A's text the moment row B was typed in.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  // Rejected rows the reviewer has OPENED to look at the mapping they turned down (H10) — a view toggle, never saved.
  const [openRejected, setOpenRejected] = useState<Record<string, true>>({});
  // Rows whose last save this session LANDED (08-26 #12). Set only off `write`'s resolved value — never
  // off having pressed Save — so the confirmation is evidence the store took the decision.
  const [savedKeys, setSavedKeys] = useState<Record<string, true>>({});
  const markSaved = (sourceVariable: string, ok: boolean) => {
    if (!ok) return;
    const key = specs.itemKey({ sourceVariable });
    setSavedKeys((prev) => ({ ...prev, [key]: true }));
  };
  const unmarkSaved = (itemKey: string) =>
    setSavedKeys((prev) => {
      if (!prev[itemKey]) return prev;
      const next = { ...prev };
      delete next[itemKey];
      return next;
    });

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
      .filter((g) => !q || labelOf(g.record).toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, arithmeticOnly, query, renames.decisions]);

  // The columns several of one cohort's in-scope variables write (a rejected recode writes nothing) — the only
  // places the combine control appears. Across records, as the notebook groups them.
  const combineList = useMemo(() => {
    const rejected = new Set(
      Object.values(specs.decisions)
        .filter((d) => d.rejected === true)
        .map((d) => String(d.sourceVariable ?? "")),
    );
    // A removed variable writes no column, so it is no one's combine partner — the export's own reading.
    return combineGroups(
      withoutRemovedMembers(
        groups.map((g) => g.record),
        exclusions.decisions,
      ),
      rejected,
    );
  }, [groups, specs.decisions, exclusions.decisions]);

  const anyRow = groups.some((g) => g.rows.length > 0);
  const selected =
    visible.find((g) => g.record.groupId === selectedId) ?? visible[0];

  // A leg STILL RUNNING is not "no specs" (08-28 F4): mid-leg the screen holds an EARLIER checkpoint, whose
  // records carry no transform specs yet, so an empty list is no evidence that every concept was an adopt.
  if (!anyRow && isInFlight(jobState?.status)) {
    return (
      <Shell
        jobId={jobId}
        jobState={jobState}
        cancel={cancel}
        costSoFar={costSoFar}
      >
        <GateEmptyState
          heading="This run is still running"
          nextStep="Nothing to do yet. You can close this tab — the run keeps going and parks at the next gate for you."
        >
          <span data-testid="gate3-running">
            It is{" "}
            <span className="font-semibold">
              {jobState?.phase || jobState?.status}
            </span>{" "}
            right now. Transform specs are written in the leg after Gate 2;
            they appear here on their own when the run reaches this gate —
            no reload needed.
          </span>
        </GateEmptyState>
      </Shell>
    );
  }

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

  /**
   * THE one Gate 3 write (08-27 audit B1). The store replaces a decision row on write, so every control patches
   * its OWN field onto the persisted decision (`mergeSpecEdit`) instead of sending a partial payload — a note
   * save no longer wipes the value map, Reject no longer wipes the note, and an edit never drops `rejected`.
   * `chosen` is "" exactly while the recode is rejected.
   */
  async function saveSpec(
    record: UIRecord,
    sourceVariable: string,
    patch: Parameters<typeof mergeSpecEdit>[1],
  ): Promise<boolean> {
    const key = specs.itemKey({ sourceVariable });
    const extra = mergeSpecEdit(specs.decisions[key] as Record<string, unknown> | undefined, patch);
    const ok = await specs.write(
      { sourceVariable },
      {
        chosen: extra.rejected === true ? "" : sourceVariable,
        alternatives: [sourceVariable],
        upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
        extra,
      },
    );
    markSaved(sourceVariable, ok);
    return ok;
  }

  /** Remove one variable from one concept (review round 2). A write of its own kind, through the one decision hook. */
  async function removeMember(record: UIRecord, sourceVariable: string) {
    const { fields, options } = removalWrite(record.groupId, sourceVariable);
    const ok = await exclusions.write(fields, options);
    if (ok) {
      toast.success(
        `Removed ${sourceVariable} from “${labelOf(record)}”${exclusions.local ? " (kept in this browser)" : ""}`,
      );
    }
  }

  /** Undo a removal: the row is deleted, and the variable is back in the concept and every export. */
  async function restoreMember(record: UIRecord, sourceVariable: string) {
    const ok = await exclusions.clear({ groupId: record.groupId, memberId: sourceVariable });
    if (ok) toast.success(`${sourceVariable} is back in “${labelOf(record)}”`);
  }

  async function saveNote(record: UIRecord, sourceVariable: string, value: string) {
    const ok = await saveSpec(record, sourceVariable, { note: value });
    // Keep the typed text on a failed write — the rollback restores the stored note, not the reviewer's draft.
    if (!ok) return;
    const key = specs.itemKey({ sourceVariable });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    toast.success(specs.local ? "Recode note saved in this browser" : "Recode note saved to the decision log");
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
          const removed = removedIn(record.groupId);
          return (
            <ConceptQueueRow
              key={record.groupId}
              id={record.groupId}
              testid="gate3-concept"
              label={labelOf(record)}
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
              cohorts={cohortsLeft(record, removed)}
              count={rows.filter((r) => !removed.has(r.sourceVariable)).length}
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
              // The concept as the export carries it: removed variables are out of its count, its cohorts and its
              // source rows, and each folds to a removed line in the value mapping below (with its Undo).
              const removed = removedIn(record.groupId);
              const activeCount = rows.filter((r) => !removed.has(r.sourceVariable)).length;
              const cohorts = cohortsLeft(record, removed);
              const keptMembers = record.members.filter((m) => !removed.has(m));
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
              // The catalog element's tinyId, for its repository link (review round 2): the pick's own when it
              // recorded one (a repeated name is told apart by it, 08-28 F13), else the candidate's, else the
              // record's CDE. A generated target has none — `CatalogLink` never links it.
              const targetExternalId = targetIsOwn
                ? ""
                : (typeof pick?.externalId === "string" ? pick.externalId.trim() : "") ||
                  chosenCandidate?.cdeExternalId ||
                  (record.cde?.id === chosenTargetId ? record.cde.externalId : "") ||
                  "";
              // The target's value domain (08-16g) — carried into Gate 3 so recodes can be built and judged
              // against it. Adopt -> the chosen catalog candidate's enriched metadata; own/novel -> the GenCDE.
              // A TABLE of code + label (08-28 1c): a GenCDE's codes differ from its labels, and the recodes
              // are written in codes; a catalog CDE's value is its own code.
              const targetTable: TargetValue[] = targetIsOwn
                ? generatedTargetValues(record.gencde?.permissibleValues)
                : catalogTargetValues(chosenCandidate?.permissibleValues);
              const targetPVs: string[] = targetTable.map((v) => v.label);
              const targetDataType = targetIsOwn
                ? record.gencde?.dataType
                : chosenCandidate?.dataType;
              // #7: when the target's own value list never reached the wire (no catalog metadata on this
              // run's candidates), recover the buckets from the specs' code maps into it, so a coded
              // categorical recode is edited as one instead of falling onto the numeric editor. Only when the
              // TYPE is also unknown — a declared type with no list is taken at its word.
              const inferredPVs =
                targetPVs.length === 0 && !targetDataType?.trim()
                  ? targetValuesFromSpecs(
                      record.transforms,
                      targetIsOwn
                        ? (record.gencde?.gencdeId ?? chosenTargetId)
                        : chosenTargetId,
                    )
                  : [];
              const recodeTable: TargetValue[] =
                targetTable.length > 0 ? targetTable : catalogTargetValues(inferredPVs);
              const targetUnits = targetIsOwn
                ? record.gencde?.units
                : chosenCandidate?.units;
              // 08-27b: a Gate 2 pick's specs are regenerated for the pick on the way here; a run that crossed
              // before that fix still carries the model's, and must say so rather than wear the pick's label.
              const expectedTarget = targetIsOwn
                ? (record.gencde?.gencdeId ?? "")
                : chosenTargetId;
              const specsBuiltFor = pick
                ? specTargetMismatch(
                    record.transforms,
                    expectedTarget,
                    !targetIsOwn && record.gencde && record.cde?.id === chosenTargetId
                      ? [record.gencde.gencdeId]
                      : [],
                  )
                : [];
              return (
                <div className="flex flex-col gap-4">
                  <ConceptDetailHeader
                    title={labelOf(record)}
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
                          {activeCount}
                        </span>{" "}
                        source {activeCount === 1 ? "variable" : "variables"} ·{" "}
                        {cohorts.join(", ")}
                        {removed.size > 0 && (
                          <>
                            {" "}
                            ·{" "}
                            <span data-testid="gate3-removed-count">
                              {removed.size} removed
                            </span>
                          </>
                        )}
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
                    detail={`${keptMembers.length} ${keptMembers.length === 1 ? "variable" : "variables"} · ${cohorts.join(", ")}${removed.size > 0 ? ` · ${removed.size} removed here` : ""}`}
                    testid="inherited-source-rows"
                  >
                    <SourceRows
                      memberIds={keptMembers}
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
                          {/* An adopt's / a refine's catalog CDE links to its repository page; a
                              generated target stays plain text (review round 2). */}
                          <CatalogLink
                            name={targetName}
                            externalId={targetExternalId}
                            generated={targetIsOwn}
                            className="text-sm font-semibold text-on-raised"
                          />
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
                        {specsBuiltFor.length > 0 && (
                          <p
                            data-testid="spec-target-mismatch"
                            role="status"
                            className="max-w-[80ch] rounded-inner border border-status-warn px-2 py-1 text-xs text-on-warn"
                          >
                            The transform specs below were generated for{" "}
                            <span className="font-mono">
                              {specsBuiltFor.map((id) => id || "no target").join(", ")}
                            </span>
                            , not your pick (
                            {targetIsOwn
                              ? targetName
                              : chosenTargetId || "none of these"}
                            ). This run reached Gate 3 before a Gate 2 pick
                            regenerated its specs, so judge each recode against
                            the target above.
                          </p>
                        )}
                        {record.reviewerPick?.reason && (
                          <p
                            data-testid="reviewer-pick-reason"
                            className="max-w-[80ch] text-xs text-on-raised-muted"
                          >
                            {record.reviewerPick.reason}
                          </p>
                        )}
                        {targetPVs.length > 0 && (
                          <div data-testid="target-permissible-values">
                            <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">
                              Permissible values ({targetPVs.length})
                            </span>
                            <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                              {targetTable.map((v, i) => (
                                <span
                                  key={i}
                                  className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-on-raised"
                                >
                                  {v.code !== v.label ? `${v.code} = ${v.label}` : v.label}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {inferredPVs.length > 0 && (
                          <p
                            data-testid="target-values-inferred"
                            className="max-w-[80ch] text-xs text-on-raised-muted"
                          >
                            This run did not carry the element&apos;s own value
                            list, so the recode buckets below are the values the
                            generated recodes map into:{" "}
                            {inferredPVs.join(", ")}. Check them against the
                            catalog entry.
                          </p>
                        )}
                      </div>
                    </div>
                  </InheritedPanel>

                  {/* 08-28 1d: only where a cohort has two or more variables on one target column. */}
                  {combineList
                    .filter((g) => g.members.some((m) => record.members.includes(m)))
                    .map((g) => {
                      const key = combines.itemKey({ cohort: g.cohort, targetId: g.targetId });
                      return (
                        <CombineRuleControl
                          key={key}
                          group={g}
                          choice={combineChoice(combines.decisions[key], g.members)}
                          // The COLUMN is the target, so it is named as the target — the generated element's own
                          // name — not by the concept's (group) title.
                          targetLabel={
                            record.gencde && g.targetId === record.gencde.gencdeId
                              ? record.gencde.preferredName || labelOf(record)
                              : undefined
                          }
                          readOnly={frozen}
                          onChoose={(chosen) =>
                            void combines.write(
                              { cohort: g.cohort, targetId: g.targetId },
                              {
                                chosen,
                                alternatives: combineAlternatives(g.members),
                                upstream: { kind: "gate2_candidate_pick", itemKey: record.groupId },
                              },
                            )
                          }
                        />
                      );
                    })}

                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold text-on-raised">
                      Value mapping ({activeCount})
                    </h3>
                    {rows.map(({ sourceVariable, transform, state }) => {
                      // REMOVED from this concept (review round 2): the recode is not built and no export carries
                      // the variable, so the row folds to one line that says so — and offers the Undo.
                      if (removed.has(sourceVariable)) {
                        return (
                          <div
                            key={sourceVariable}
                            data-testid="removed-row"
                            data-source={sourceVariable}
                            className="flex flex-wrap items-center gap-2 rounded-inner border border-dashed border-rule-on-raised px-4 py-2"
                          >
                            <span className="font-mono text-xs text-on-raised-muted line-through">
                              {sourceVariable}
                            </span>
                            <span className="text-xs text-on-raised-muted">
                              Removed from this concept — it is left out of the
                              transform specs and every export.
                            </span>
                            <Button
                              data-testid="spec-remove-undo"
                              size="sm"
                              variant="outline"
                              disabled={frozen}
                              onClick={() => void restoreMember(record, sourceVariable)}
                            >
                              Undo
                            </Button>
                          </div>
                        );
                      }
                      const removable = canRemoveMember(record.members, removed, sourceVariable);
                      const itemKey = specs.itemKey({ sourceVariable });
                      const decision = specs.decisions[itemKey];
                      const review =
                        state === "failed" ||
                        matchState === "flagged" ||
                        (transform ? routesToReview(transform) : false);
                      const rejected = decision?.rejected === true;
                      // H10 (Bhargav 2026-10-05, "build as proposed"): a rejected recode folds its surface away —
                      // the reviewer opens it to see what was turned down, read-only — and the row says what
                      // rejecting did instead of reading as if the recode will be exported.
                      const showRecode = !rejected || !!openRejected[itemKey];
                      const noteValue =
                        itemKey in drafts
                          ? drafts[itemKey]
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
                      // The value table THIS row maps into (08-28 1c): the target its spec writes — a refine
                      // record's specs write its derived element, with its own codes — else the shown target.
                      const rowValues = rowTargetValues({
                        transform,
                        gencde: record.gencde,
                        candidates: record.candidates,
                        fallback: recodeTable,
                      });
                      const rowCandidate = transform
                        ? record.candidates.find((c) => c.cdeId === transform.targetCdeId)
                        : undefined;
                      const rowDataType = toGenCDE
                        ? record.gencde?.dataType
                        : (rowCandidate?.dataType ?? targetDataType);
                      const rowLabels = rowValues.map((v) => v.label);
                      // The editor opens on the MODEL's code map, placed by target code (F19); only a spec with
                      // no code map is seeded from the $0 label heuristic, and the screen says which.
                      const recommended = recommendedMapping(
                        sourceOptions,
                        rowValues,
                        transform?.codeMap,
                      );
                      const persistedMapping = decision?.mapping as
                        Record<string, string> | undefined;
                      // A mapping saved in LABELS before the fix is shown in codes, as the export applies it (F18).
                      const mappingValue = persistedMapping
                        ? mappingInCodes(persistedMapping, rowValues)
                        : recommended.mapping;
                      const mappingBuckets = withModelTargets(
                        rowValues,
                        recommended.mapping,
                        mappingValue,
                      );
                      // The recode SURFACE follows the target type, not the source's coded options: a coded
                      // source on a NUMERIC target is a code→number table (②), a numeric source on a banded
                      // target is a range table (③), a coded source on a categorical target is the drag-drop
                      // value map (①), and everything else keeps its read-only detail (④). `recodeShape`
                      // owns the decision so the render stays a switch.
                      const shape = recodeShape({
                        targetDataType: rowDataType,
                        targetValues: rowLabels,
                        hasSourceOptions: hasOptions,
                        kind: transform?.kind,
                      });
                      const recommendedNumberMap = seedNumberMap(sourceOptions);
                      const numberMapValue = seedNumberMap(
                        sourceOptions,
                        decision?.numberMap as
                          Record<string, NumberMapEntry> | undefined,
                      );
                      const recommendedBins = seedBinning(rowLabels);
                      const binsValue = seedBinning(
                        rowLabels,
                        decision?.bins as BinRule[] | undefined,
                      );
                      // The row header describes what will be EXPORTED: the reviewer's mapping once there is
                      // one (F19's "3 mapped, 1 unmapped, 75%" kept describing the model's after an edit).
                      const editedSummary =
                        shape === "value-map" && persistedMapping
                          ? mappingSummary(
                              sourceOptions.map((o) => o.code),
                              mappingValue,
                            )
                          : null;
                      const headline = editedSummary
                        ? mappingHeadline(editedSummary)
                        : decision?.numberMap && shape === "code-to-number"
                          ? "your code → number table"
                          : decision?.bins && shape === "binning"
                            ? "your value bands"
                            : transform
                              ? transformSummary(transform)
                              : "";
                      const coverage = editedSummary
                        ? editedSummary.coverage
                        : (decision?.numberMap && shape === "code-to-number") ||
                            (decision?.bins && shape === "binning")
                          ? null
                          : (transform?.coverage ?? null);
                      const unproduced = specUnproduced(transform);
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
                          data-rejected={String(rejected)}
                          data-stale={String(specs.isStale(itemKey))}
                          data-concept-mismatch={String(
                            matchState === "flagged",
                          )}
                          className={cn(
                            "flex flex-col gap-2 rounded-inner border px-4 py-3",
                            review
                              ? "border-l-4 border-l-accent-action border-rule-on-raised"
                              : "border-rule-on-raised",
                            // H10: a rejected row is drawn dashed — present, but not part of what is exported.
                            rejected && "border-dashed",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-on-inset-muted">
                              {transform ? transform.kind : state}
                            </span>
                            <span className="font-mono text-xs text-on-raised">
                              {sourceVariable}
                            </span>
                            {headline && (
                              <>
                                <span className="text-on-raised-faint">→</span>
                                <span
                                  data-testid="spec-row-summary"
                                  className={cn(
                                    "text-xs",
                                    rejected ? "text-on-raised-muted" : "text-on-raised",
                                  )}
                                >
                                  {/* A rejected recode is not exported, so its header never describes what it would map. */}
                                  {rejected ? "not exported — rejected" : headline}
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
                            {coverage !== null && !rejected && (
                              <span
                                data-testid="spec-row-coverage"
                                className="text-xs text-on-raised-muted"
                              >
                                {`coverage ${(coverage * 100).toFixed(0)}%`}
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
                            {/* A STANDING mark, read off the store (so it survives a reload): this block
                                carries a reviewer decision, not only the pipeline's recommendation (#12). */}
                            {specs.isTouched(itemKey) && (
                              <span
                                data-testid="spec-edited-badge"
                                className={cn(
                                  "rounded-pill border px-2 py-0.5 text-xs",
                                  decision?.rejected
                                    ? "border-status-warn text-on-warn"
                                    : "border-rule-on-raised text-on-raised-muted",
                                )}
                              >
                                {decision?.rejected ? "rejected" : "edited"}
                              </span>
                            )}
                          </div>

                          {rejected && (
                            <div className="flex flex-col gap-1">
                              <p
                                data-testid="spec-rejected-note"
                                className="max-w-[68ch] text-xs text-on-raised"
                              >
                                <span className="font-semibold">Rejected.</span> This recode is left out of
                                the notebook and the mapping table, and logged as rejected in the decision log.
                                Un-reject brings it back exactly as it was.
                              </p>
                              <button
                                type="button"
                                data-testid="spec-rejected-toggle"
                                aria-expanded={showRecode}
                                onClick={() =>
                                  setOpenRejected((prev) => {
                                    const next = { ...prev };
                                    if (next[itemKey]) delete next[itemKey];
                                    else next[itemKey] = true;
                                    return next;
                                  })
                                }
                                className="w-fit text-left text-xs font-semibold text-link-on-raised underline underline-offset-2"
                              >
                                {showRecode
                                  ? "Hide the rejected mapping ▴"
                                  : "Show the rejected mapping (read-only) ▾"}
                              </button>
                            </div>
                          )}

                          {showRecode && (
                            <div className={cn("flex flex-col gap-2", rejected && "opacity-75")}>
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
                              {/* 08-28 1c (F16): the model could not produce this recode. Never "no transform
                                  required" — that reading exported raw codes as if they already fit. */}
                              {state === "needs-you" && (
                                <p
                                  data-testid="spec-needs-you"
                                  className="max-w-[68ch] text-xs text-on-raised"
                                >
                                  <span className="font-semibold text-on-warn">
                                    {unproduced} — needs you.
                                  </span>{" "}
                                  {transform?.kind === "unit"
                                    ? `No unit conversion could be authored (${transform.sourceUnit ?? "?"} → ${transform.targetUnit ?? "?"}), so the notebook leaves this variable as a REVIEW REQUIRED stub rather than a no-op conversion.`
                                    : persistedMapping
                                      ? "The model could not map any of this variable's values; your mapping below is what the export applies."
                                      : shape === "value-map"
                                        ? "The model could not map any of this variable's values onto the target, so nothing is exported for it until you place its values below."
                                        : "The model could not map any of this variable's values onto the target, so the notebook leaves it as a REVIEW REQUIRED stub — nothing is copied across."}
                                </p>
                              )}

                              {/* The recode surface is chosen by the TARGET type (see `recodeShape`), so a coded
                              source landing on a numeric CDE gets a code→number table instead of chips with
                              nowhere to drop. Each surface renders for an OK spec AND a FAILED one (seeded from a
                              $0 heuristic), so a reviewer fixes the recode rather than only annotating it. */}
                              {shape === "value-map" && (
                                <SpecMappingEditor
                                  sourceOptions={sourceOptions}
                                  targetValues={mappingBuckets}
                                  value={mappingValue}
                                  recommended={recommended.mapping}
                                  recommendedFrom={recommended.from}
                                  readOnly={frozen || rejected}
                                  onChange={(m) =>
                                    void saveSpec(record, sourceVariable, { mapping: m })
                                  }
                                />
                              )}
                              {shape === "code-to-number" && (
                                <SpecNumberMap
                                  sourceOptions={sourceOptions}
                                  targetUnits={targetUnits}
                                  value={numberMapValue}
                                  recommended={recommendedNumberMap}
                                  readOnly={frozen || rejected}
                                  onChange={(m) =>
                                    void saveSpec(record, sourceVariable, { numberMap: m })
                                  }
                                />
                              )}
                              {shape === "binning" && (
                                <SpecBinning
                                  value={binsValue}
                                  recommended={recommendedBins}
                                  readOnly={frozen || rejected}
                                  onChange={(b) =>
                                    void saveSpec(record, sourceVariable, { bins: b })
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
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              data-testid="spec-note-input"
                              aria-label={`Note on the recode for ${sourceVariable}`}
                              placeholder={rejected ? "Why was it rejected? (optional)" : "Your note on this recode"}
                              value={noteValue}
                              disabled={frozen}
                              onChange={(e) => {
                                // Typing again means the confirmation no longer describes what is on screen.
                                unmarkSaved(itemKey);
                                const value = e.target.value;
                                setDrafts((prev) => ({ ...prev, [itemKey]: value }));
                              }}
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
                              {/* It only ever saved the note; on a rejected row, where nothing else is editable, say so. */}
                              {rejected ? "Save note" : "Save"}
                            </Button>
                            {rejected ? (
                              <Button
                                data-testid="spec-unreject"
                                size="sm"
                                variant="outline"
                                disabled={frozen}
                                onClick={() => void saveSpec(record, sourceVariable, { rejected: false })}
                              >
                                Un-reject
                              </Button>
                            ) : (
                              <Button
                                data-testid="spec-reject"
                                size="sm"
                                variant="outline"
                                disabled={frozen}
                                onClick={() => setRejecting(itemKey)}
                              >
                                Reject
                              </Button>
                            )}
                            {/* Review round 2: take a ROGUE variable out of this concept. Free, nothing re-runs, and
                                Undo is right there on the removed line — so no confirmation step. Last in the
                                strip, so on a narrow pane it is the one that wraps. */}
                            <Button
                              data-testid="spec-remove"
                              size="sm"
                              variant="outline"
                              disabled={frozen || !removable}
                              title={
                                removable
                                  ? "Take this variable out of this concept: it leaves the transform specs and every export. You can undo it until you continue."
                                  : "A concept keeps at least one variable — reject this recode instead to leave it out of the notebook."
                              }
                              onClick={() => void removeMember(record, sourceVariable)}
                            >
                              Remove from this concept
                            </Button>
                            {/* The save LANDED (`write` resolved true) — shown in the row it describes. A
                                failed write rolls back and toasts instead, so this never claims a miss. */}
                            {savedKeys[itemKey] && (
                              <span
                                data-testid="spec-saved"
                                role="status"
                                className="inline-flex items-center gap-1 text-xs text-on-raised-muted"
                              >
                                <Check
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5 text-status-ok"
                                />
                                {specs.local ? "Saved in this browser" : "Saved"}
                              </span>
                            )}
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
                                    void saveSpec(record, sourceVariable, { rejected: true });
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
        action={pastBar ? pastBar.action : continueAction}
        done={pastBar?.note}
        actionTestId="gate3-continue"
        spentHere={costSoFar}
        recheckNotice={
          failedLeg
            ? "The last attempt to continue this run did not finish. Nothing further was charged — press Retry to run the same step again."
            : undefined
        }
        assurance={
          pastBar
            ? undefined
            : pinned === true
              ? DEMO_CONTINUE_NOTE
              : "Continuing to Gate 4 buys nothing — Gate 4 is a read of what this run already produced."
        }
        keyField={keyAsk ? <RunKeyField reason={keyAsk} action={continueAction} /> : undefined}
        onCommit={onContinue}
        busy={resuming}
        disabled={(past && pinned !== true) || (pinned !== true && !parkedHere && !failedLeg)}
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
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      job={jobState}
      onStop={cancel}
      resumed={isParkedAt(jobState, "gate3")}
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
