import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Grid3x3, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GATE_LABELS } from "@/components/gate/GateRail";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { GATE1_LEDGER_COLUMNS, Ledger } from "@/components/gate/Ledger";
import { LedgerRow } from "@/components/gate/LedgerRow";
import { CoherenceMark } from "@/components/gate/CoherenceMark";
import { CohortCoverage } from "@/components/gate/CohortCoverage";
import { CommitBar } from "@/components/gate/CommitBar";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { CarveProposal } from "@/components/gate/CarveProposal";
import { DeclaredScorePanel } from "@/components/gate/DeclaredScorePanel";
import { GroupingStrip } from "@/components/gate/GroupingStrip";
import { MemberChip, MemberDropZone, UNASSIGNED_GROUP_ID } from "@/components/gate/MemberChip";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { SourceRows, hasSourceRows } from "@/components/source-rows";
import { LedgerToolbar } from "@/components/gate/LedgerToolbar";
import { TermSearch } from "@/components/gate/TermSearch";
import { resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { readjudicateGroups, resumeRun } from "@/lib/api";
import { pathForGate } from "@/lib/gate-routes";
import { estimateRunCostBreakdown, formatUsd } from "@/lib/estimate";
import {
  DEFAULT_BUCKET,
  NO_FILTERS,
  applyFilters,
  activeFilterCount,
  effectiveMembers,
  isFlagged,
  readjudicationRequest,
  matchTerms,
  partitionByBreadth,
  pricePerGroup,
  sortGroupsBy,
  type Bucket,
  type LedgerFilters,
  type SortKey,
} from "@/lib/ledger";
import { isInFlight, isParked, isTerminal } from "@/lib/run-state";
import type { ConceptGroup, FieldDetail, GatePosition, RunMode } from "@/types";

/**
 * Gate 1 — the ledger. The load-bearing screen: where the reviewer scopes and reshapes before the BULK of
 * the money is spent.
 *
 * A ROW IS A POST-SPLIT CONCEPT GROUP (UI-SPEC §0.1, reversed at plan review on 2026-08-17), read from
 * `result.conceptGroups`. Deliberately NOT `previewClusters`: that field is preview run mode's shape — a
 * $0 run that calls no model — and reading it here would render the wrong granularity. A group names its
 * own parent cluster, which is where provenance comes from.
 *
 * THE NAME IS GENERATED, AND SAYS SO. `concept` is what `generate(ideal)` produced, already paid for by
 * the time this screen renders. Three nouns stay separate and the copy contract is binding: a **CDE** is
 * an existing catalog element; a **GenCDE** is one ddharmon mints much later, at the `gencde` stage, and
 * only for `novel` records; and this label is NEITHER — it is the generated concept anchor. So it carries
 * a generated marker and no catalog badge, no identifier link and no endorsement of any kind (T-08-89a).
 * Under the post-split reversal the label is a real generated name rather than a machine-derived one,
 * which makes it MORE plausible as a catalog element and the marking correspondingly more load-bearing.
 *
 * REACHED BY SPENDING, NOT BEFORE IT. Concept generation, splitting and the coherence judge are all paid
 * to produce what this screen shows, so the sum block LEADS with a realized figure. A screen that opened
 * with a forecast would imply the reviewer is scoping before any money moved. What is still true, and is
 * the honest claim, is that they scope before the *bulk*: assignment is 77% of the run.
 *
 * NO CLUSTER-SIZE CONTROL, EVER. See `GroupingStrip` for the three reasons.
 */

/** The two things a scope decision can say. Written out so the payload and the UI cannot disagree. */
const IN_SCOPE = "in";
const OUT_OF_SCOPE = "out";
const SCOPE_OPTIONS = [IN_SCOPE, OUT_OF_SCOPE];

/**
 * The $0 template detector's mark — DELIBERATELY WEAKER THAN A VERDICT.
 *
 * It is a deterministic frequent-template/rare-slot suspicion, not an adjudication, and it must never be
 * mistaken for the judge having run. Two things enforce that: it renders ONLY on rows the judge did not
 * score (so it never sits beside a verdict), and it says in words that it is a pattern rather than a
 * finding. It earns its place because it fires from 2 members up — exactly the range the judge skips,
 * where a row would otherwise carry no signal at all.
 */
function TemplateSuspicion() {
  return (
    <span
      data-testid="template-suspicion"
      data-signal="deterministic"
      title="A cheap, local check noticed these variables share one question template with different fillers. That often means a matrix of separate items rather than one concept — but it is a pattern, not a judgement, and the coherence judge was not asked about this group."
      className="inline-flex items-center gap-1 text-xs text-on-raised-muted"
    >
      <Grid3x3 aria-hidden="true" className="h-3 w-3 shrink-0" />
      repeating template
    </span>
  );
}

/** The generated-name marker. Icon PLUS text: an icon-only provenance claim is not a claim. */
function GeneratedMark() {
  return (
    <span
      data-testid="generated-mark"
      title="ddharmon wrote this name from the variables in the group. It is not an entry in the NIH catalog, and no catalog element has been chosen yet."
      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-inset px-2 py-0.5 text-xs font-normal text-on-inset-muted"
    >
      <Sparkles aria-hidden="true" className="h-3 w-3" />
      generated
    </span>
  );
}

function GroupRow({
  group,
  allCohorts,
  price,
  count,
  inScope,
  onScopeChange,
  changed,
  onDropMember,
  children,
}: {
  group: ConceptGroup;
  allCohorts: string[];
  price: number;
  /** The membership size AFTER the reviewer's moves, which is what the row reports. */
  count: number;
  inScope: boolean;
  onScopeChange: (inScope: boolean) => void;
  changed: boolean;
  onDropMember: (memberId: string) => void;
  children: React.ReactNode;
}) {
  const judged = group.coherence !== "not_judged";
  return (
    <LedgerRow
      rowId={group.groupId}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate" title={group.concept}>
            {group.concept || "Unnamed group"}
          </span>
          <GeneratedMark />
        </span>
      }
      subtitle={
        <span data-testid="row-provenance" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* Provenance is the group's OWN cluster id — never the preview-cluster field. */}
          <span>from cluster {group.clusterId || "—"}</span>
          {/* Only where the judge did NOT score the group: a verdict always leads on its own. */}
          {!judged && group.matrixSuspect && (
            <>
              <span aria-hidden="true">·</span>
              <TemplateSuspicion />
            </>
          )}
        </span>
      }
      coherence={<CoherenceMark state={group.coherence} />}
      coverage={<CohortCoverage cohorts={group.cohorts} allCohorts={allCohorts} />}
      count={
        <>
          {/* The TRUE member count, even when the collapsed sample is capped — regrouping against a
              partial sample would silently drop the members it never showed (T-08-89) — and updated by
              the reviewer's own moves, so the row never reports a size it no longer has. */}
          {count}
          {/* The column header is `Vars`, which a reviewer reads once and a screen-reader user hears
              never: the row announces its own unit so the number is not a bare digit. */}
          <span className="sr-only"> {count === 1 ? "variable" : "variables"}</span>
        </>
      }
      cost={price}
      selected={inScope}
      onSelectedChange={onScopeChange}
      unresolved={isFlagged(group)}
      changed={changed}
      // Every row is a drop destination, which is what makes the ledger itself the list of places a
      // variable can go — see `LedgerRow.onDropMember`.
      onDropMember={onDropMember}
    >
      {children}
    </LedgerRow>
  );
}

/**
 * Why accepting a carve is not available on THIS run — or `null` when it is.
 *
 * Three refusals, in the order the backend applies them, so the copy on screen matches the reason the
 * server would actually give. Each is rendered as an honest `NotAvailable` naming its own cause rather
 * than as a hidden control or a bare disabled button: hiding it means the reviewer never learns the
 * capability exists, and a disabled button tells them they cannot do something without telling them why.
 */
function readjudicationRefusal(
  { pinned, optedIn }: { pinned: boolean; optedIn: boolean },
): { claim: "failed" | "not-enabled"; reason: React.ReactNode } | null {
  if (pinned) {
    return {
      claim: "not-enabled",
      reason:
        "This is the shared sample run, which everyone sees, so it cannot be re-split — and it replays in " +
        "your browser and spends nothing, so there would be nothing to charge. Start a run of your own to " +
        "use it. Ignoring the proposal or editing it by hand still works here.",
    };
  }
  if (!optedIn) {
    return {
      claim: "not-enabled",
      reason:
        "Accepting a division re-splits the group and re-assigns its parts, which costs money, so it is " +
        "off unless a run asks for it. Turn it on at Set up when you start a run to enable it. Ignoring " +
        "the proposal or editing it by hand still works.",
    };
  }
  // NO BUILD-MODE ARM HERE, deliberately. A backend-less static build only ever serves the PINNED sample
  // run, which the first refusal above already catches — so a third arm for it would be unreachable copy
  // describing a state no reviewer can be in. If a request is somehow attempted without a server, the API
  // client refuses it and the failure is surfaced as itself rather than pre-empted by a guess.
  return null;
}

/**
 * The group's own members: a real drop destination when a drop can be honoured, and a plain container when
 * it cannot. Declared at module scope for the same remount reason as everything else that renders a chip.
 */
function MemberList({
  groupId,
  label,
  onDropMember,
  children,
}: {
  groupId: string;
  label: string;
  onDropMember?: (memberId: string) => void;
  children: React.ReactNode;
}) {
  if (!onDropMember) {
    return (
      <div role="group" aria-label={label} className="flex flex-wrap gap-1 rounded-inner border border-rule-on-raised p-3">
        {children}
      </div>
    );
  }
  return (
    <MemberDropZone groupId={groupId} label={label} onDropMember={(memberId) => onDropMember(memberId)}>
      {children}
    </MemberDropZone>
  );
}

/**
 * The expanded row — the FULL membership, the evidence behind it, and the judge's proposal.
 *
 * DECLARED AT MODULE SCOPE, LIKE `MemberChip`, AND FOR THE SAME REASON. A component defined inside the
 * page is a new component type on every render, so React unmounts and remounts its whole subtree on each
 * state change — which cancels any drag in flight. That trap was found on the drag prototype branch; it is
 * recorded on `MemberChip` and it applies to everything that renders one.
 */
function ExpandedGroup({
  group,
  members,
  unassignedFromHere,
  fieldIndex,
  movedMembers,
  onMove,
  onRestore,
  canRegroup,
  refusal,
  carvePrice,
  onAcceptCarve,
  onIgnoreCarve,
  accepting,
}: {
  group: ConceptGroup;
  /** The group's membership AFTER the reviewer's moves — uncapped. */
  members: string[];
  /**
   * Variables that STARTED in this group and are now in no group.
   *
   * The tray has to show them. Without this the drop destination accepted a chip and then rendered
   * nothing, so a variable dragged out simply vanished — a correction with no visible consequence, which
   * is the same defect as a row that disappears when it is emptied.
   */
  unassignedFromHere: string[];
  fieldIndex: Record<string, FieldDetail>;
  /** Member ids the reviewer has moved, so a chip can say so. */
  movedMembers: Set<string>;
  onMove: (memberId: string, toGroupId: string) => void;
  onRestore: () => void;
  /** False when the run carries only a capped sample of this group — see `hasFullMembership`. */
  canRegroup: boolean;
  refusal: ReturnType<typeof readjudicationRefusal>;
  carvePrice: React.ReactNode;
  onAcceptCarve: () => void;
  onIgnoreCarve: () => void;
  accepting: boolean;
}) {
  const [ignored, setIgnored] = useState(false);
  const emptied = canRegroup && members.length === 0;
  // Does the evidence grid render for this group? If it does it IS the membership view and the tile strip
  // is redundant; if it does not, the chips are the only thing standing between the reviewer and a group
  // with no visible members. Asked of the same expression the grid itself uses, so the two cannot drift.
  const gridCarriesMembers = hasSourceRows(members, undefined, fieldIndex);

  return (
    <>
      {!canRegroup ? (
        /* T-08-89 MADE MECHANICAL. This run carries only a capped SAMPLE of this group's members, so the
           screen cannot see past the cap — and a move written against a partial list would silently drop
           every member it never showed. The verb is withdrawn and the reason is stated, rather than the
           move being offered over an incomplete list. */
        <NotAvailable thing="Moving variables in this group" claim="failed">
          This run recorded only the first {members.length} of its {" "}
          {group.nMembers} variables for this group, so the rest are not on this screen. Moving one now
          would quietly drop the ones you cannot see, so the move is withheld rather than offered over a
          partial list. The variables below are the sample that was recorded.
        </NotAvailable>
      ) : emptied ? (
        /* THE LAST VARIABLE LEFT. The row must NOT silently vanish — a reviewer has to be able to see what
           they did and undo it, and a group that disappeared on the move it was emptied by is a change
           with no visible consequence. */
        <div
          data-testid="group-emptied"
          className="flex flex-col gap-2 rounded-inner border-l-4 border-l-accent-action bg-surface-inset px-4 py-3"
        >
          <p className="text-sm font-semibold text-on-inset">You moved every variable out of this group.</p>
          <p className="max-w-[80ch] text-sm text-on-inset-muted">
            It is empty, so it will not go on to Gate 2 and nothing will be matched for it. The row stays
            here so you can see the change and undo it.
          </p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={onRestore}>
              Put them back
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        THE TILE STRIP IS NOW A FALLBACK, NOT THE PRIMARY VIEW (08-14h Task 5).

        Bhargav, on the live run: *"the draggable var tiles + the spreadsheet style rows are redundant…
        have the tiles be embedded into the spreadsheet layout such that the user can drag from the row
        directly rather than have to look at both."* The reviewer was being asked to hold two renderings
        of the same variable in their head and match them up.

        THE GRID IS THE SURVIVOR: it came from `source-rows.tsx`, the production evidence layer, and it
        carries the metadata a coherence judgement actually needs; the tiles carried only a name. So the
        chips render ONLY where the grid declines to — a run that predates `fieldIndex`, or one whose
        members carry no descriptive field. Without that fallback such a group would show no members at
        all, which is why `hasSourceRows` is asked here rather than inferred from a null render.
      */}
      {(canRegroup ? !emptied : true) && !gridCarriesMembers && (
        <MemberList
          groupId={group.groupId}
          label={`Variables in ${group.concept || group.groupId}`}
          // A drop DESTINATION only where a drop can be honoured. A zone that announced itself as a
          // destination and then rejected everything is a dead control with an accessible name.
          onDropMember={canRegroup ? (memberId) => onMove(memberId, group.groupId) : undefined}
        >
          {members.map((memberId) => {
            // A member id is `cohort:variable`. `fieldIndex` carries the variable's dictionary NAME but
            // not its cohort, so the cohort comes from the id — which is where it came from in the first
            // place — and the name from the index when the run has one.
            const separator = memberId.indexOf(":");
            const cohort = separator > 0 ? memberId.slice(0, separator) : "";
            const variable = separator > 0 ? memberId.slice(separator + 1) : memberId;
            return (
              <MemberChip
                key={memberId}
                memberId={memberId}
                cohort={cohort}
                variable={fieldIndex[memberId]?.name || variable}
                moved={movedMembers.has(memberId)}
                draggable={canRegroup}
              />
            );
          })}
        </MemberList>
      )}

      {canRegroup && (
        <p className="text-xs text-on-raised-muted">
          Drag a {gridCarriesMembers ? "row" : "variable"} onto another group to move it there, or onto the
          tray below to take it out of every group.
          {gridCarriesMembers && " Without a mouse, use the × beside a row's drag handle to take that variable out of this group."}{" "}
          Your moves are saved as you make them.
        </p>
      )}

      {/* The no-group tray. A REAL DESTINATION with its own identifier, not a sentinel special-cased at
          each call site — which is what lets "take this out of every group" be the same verb as "put it in
          that one" rather than a second code path. */}
      {canRegroup && (
        <MemberDropZone
          groupId={UNASSIGNED_GROUP_ID}
          label="Variables in no group"
          onDropMember={(memberId) => onMove(memberId, UNASSIGNED_GROUP_ID)}
          className="bg-surface-inset"
        >
          <span className="w-full text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">
            In no group
            {unassignedFromHere.length > 0 && (
              <span className="ml-2 font-mono normal-case tracking-normal">{unassignedFromHere.length}</span>
            )}
          </span>
          {unassignedFromHere.length === 0 ? (
            <span className="text-xs text-on-inset-muted">
              Drop a variable here to take it out of every group. It will not be matched against a common
              data element.
            </span>
          ) : (
            unassignedFromHere.map((memberId) => {
              const separator = memberId.indexOf(":");
              return (
                <MemberChip
                  key={memberId}
                  memberId={memberId}
                  cohort={separator > 0 ? memberId.slice(0, separator) : ""}
                  variable={
                    fieldIndex[memberId]?.name ||
                    (separator > 0 ? memberId.slice(separator + 1) : memberId)
                  }
                  moved
                />
              );
            })
          )}
        </MemberDropZone>
      )}

      {/* THE EVIDENCE LAYER (lifted from the workbench by the 2026-08-31 inherited-UI audit). The judgement
          this screen asks for — is this really one concept? — is made against the dictionary rows, and
          asking it from a generated name and a row of chips leaves them a screen away. Returns null when
          the run carries no field detail, in which case the chips above are the whole membership view. */}
      <SourceRows
        memberIds={members}
        fieldIndex={fieldIndex}
        // ONLY WHERE A MOVE CAN BE HONOURED. `canRegroup` is false when the run recorded a capped sample
        // of this group (T-08-89), and a drag written against a partial list would silently drop every
        // member it never showed — so the grid stays pure evidence there, exactly as the withdrawn verb
        // above says it does.
        drag={
          canRegroup
            ? {
                groupId: group.groupId,
                label: `Variables in ${group.concept || group.groupId}`,
                onDropMember: (memberId) => onMove(memberId, group.groupId),
                onRemoveMember: (memberId) => onMove(memberId, UNASSIGNED_GROUP_ID),
                movedMembers,
              }
            : undefined
        }
      />

      {/* The carve proposal, ONLY where the judge flagged an over-merge. The pipeline flags and never
          re-groups, so nothing here is applied until the reviewer acts. */}
      {isFlagged(group) && !ignored && (
        <div className="flex flex-col gap-2">
          <CarveProposal
            subConcepts={group.coherenceDistinctValues.map((label, i) => ({
              id: `${group.groupId}#sub${i}`,
              label,
            }))}
            axis={group.coherenceAxis || undefined}
            summary={group.coherenceSummary || undefined}
            readjudicationEnabled={refusal === null}
            notAvailable={
              refusal && (
                <NotAvailable thing="Accepting the division" claim={refusal.claim} className="bg-surface-raised">
                  {refusal.reason}
                </NotAvailable>
              )
            }
            acceptPrice={carvePrice}
            accepting={accepting}
            acceptGroupIds={readjudicationRequest(group.groupId).groupIds}
            onAccept={onAcceptCarve}
            onIgnore={() => {
              setIgnored(true);
              onIgnoreCarve();
            }}
          />
        </div>
      )}
      {isFlagged(group) && ignored && (
        <p className="text-sm text-on-raised-muted">
          Proposal ignored — the grouping is unchanged. The judge&rsquo;s flag stays on the row, because
          ignoring a proposal is not the same as resolving what it was about.
        </p>
      )}
    </>
  );
}

/**
 * The sum block, in three lines and in this order.
 *
 * REALIZED FIRST, and visually distinct. The first line is money already gone; the two below it are
 * forecasts. They are told apart by WEIGHT as well as position, because after the post-split reversal the
 * reviewer is standing downstream of real spend and a block that rendered both in one voice would invite
 * reading a forecast as a receipt.
 *
 * THE WHOLE-CORPUS LINE IS WHAT MAKES SCOPING LEGIBLE. "This costs $4.10" means nothing on its own; "this
 * costs $4.10 of the $9.80 the whole run would" is a decision.
 */
function SumBlock({
  realized,
  inScopeTotal,
  wholeCorpus,
  nInScope,
  nGroups,
}: {
  realized: number;
  inScopeTotal: number;
  wholeCorpus: number;
  nInScope: number;
  nGroups: number;
}) {
  return (
    <div data-testid="sum-block" className="flex flex-col gap-1">
      <p data-sum-line="realized" className="text-sm font-semibold text-on-raised">
        {realized > 0 ? (
          <>
            Already spent to reach this gate:{" "}
            <span className="font-mono tabular-nums">{formatUsd(realized)}</span> — naming the concepts,
            dividing them, and checking them.
          </>
        ) : (
          <>Already spent to reach this gate: nothing — this run is a saved replay, so it was not billed.</>
        )}
      </p>
      <p data-sum-line="in-scope" className="text-sm font-normal text-on-raised">
        {nInScope} of {nGroups} {nGroups === 1 ? "group" : "groups"} in scope —{" "}
        <span className="font-mono tabular-nums">{formatUsd(inScopeTotal)}</span> to match them against
        common data elements at Gate 2.
      </p>
      <p data-sum-line="whole-corpus" className="text-sm font-normal text-on-raised-faint">
        All {nGroups} {nGroups === 1 ? "group" : "groups"} would be{" "}
        <span className="font-mono tabular-nums">{formatUsd(wholeCorpus)}</span>.
      </p>
    </div>
  );
}

export default function Gate1Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState, error, reconnecting, cancel } = useHarmonizeStream(jobId, true, true);
  const [, navigate] = useLocation();
  const [resuming, setResuming] = useState(false);

  const [bucket, setBucket] = useState<Bucket>(DEFAULT_BUCKET);
  const [sort, setSort] = useState<SortKey>("verdict");
  const [filters, setFilters] = useState<LedgerFilters>(NO_FILTERS);
  /** The terms the reviewer last searched. `null` means they have not searched — not "searched and got 0". */
  const [terms, setTerms] = useState<string[] | null>(null);

  const groups: ConceptGroup[] = useMemo(
    () => jobState?.result?.conceptGroups ?? [],
    [jobState?.result?.conceptGroups],
  );
  const allCohorts = jobState?.result?.summary?.cohorts ?? [];
  const unassigned = jobState?.result?.unassignedFields ?? [];
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  /**
   * Whether this run is the shared demo — and therefore whether decisions stay in the browser.
   *
   * RESOLVED TO A DEFINITE BOOLEAN ONCE THE RUN'S CONFIG HAS ARRIVED, and that is the whole point. The
   * hook routes an UNDEFINED `pinned` to the sandbox on purpose: the safe default for an unknown run is
   * the one that cannot write to somebody else's shared row. But a real run's config carries no `demo`
   * key at all, so reading the flag straight off it leaves `pinned` undefined FOREVER — and every
   * decision on every real run is then confined to sessionStorage and never reaches the store.
   *
   * Found by driving the wired build against a live backend: the Gate 1 route issued no `/artifacts`
   * call at all. The static e2e suite cannot see this — it is backend-less, so every persistence
   * assertion in it exercises the sandbox by construction, which is exactly the trap this phase has
   * already recorded once.
   *
   * The guard is kept intact rather than removed: while the config is still EMPTY — the stream's opening
   * frame — this stays undefined and the sandbox default holds. It becomes `false` only once the run has
   * actually told us what it is.
   */
  const runConfig = jobState?.config as Record<string, unknown> | undefined;
  const pinned = resolvePinned(runConfig);
  const scope = useGateDecisions(jobId, "gate1_group_scope", { pinned });
  const regroups = useGateDecisions(jobId, "gate1_regroup", { pinned });

  // What Gate 2 is forecast to cost for THIS run, divided across its rows. `assign` runs once per
  // post-split group, so the row count is the call count and every row buys the same call.
  const variables = groups.reduce((n, g) => n + g.nMembers, 0);
  const mode = ((runConfig?.mode as string | undefined) ?? "batch") as RunMode;
  const gate2Forecast = useMemo(
    () => estimateRunCostBreakdown(variables, allCohorts.length, mode, true).byGate.gate2.forecast,
    [variables, allCohorts.length, mode],
  );
  const price = pricePerGroup(gate2Forecast, groups.length);

  // Default IN. A reviewer who scopes nothing continues with everything, which is what "nothing blocks
  // Continue" has to mean; the checkbox REMOVES a group rather than admitting one.
  const isInScope = (groupId: string) => scope.decisions[groupId]?.chosen !== OUT_OF_SCOPE;

  // "You changed it" is DERIVED from persisted decisions, never from component state — R6 requires the
  // correction to be visible after a reload, and a flag in `useState` is gone the moment the page reloads.
  const touchedByRegroup = useMemo(() => {
    const byGroup = new Set<string>();
    for (const d of Object.values(regroups.decisions)) {
      if (typeof d.chosen === "string" && d.chosen) byGroup.add(d.chosen);
      if (typeof d.fromGroupId === "string" && d.fromGroupId) byGroup.add(d.fromGroupId);
    }
    return byGroup;
  }, [regroups.decisions]);
  const isChanged = (groupId: string) => groupId in scope.decisions || touchedByRegroup.has(groupId);

  /**
   * The reviewer's moves, as `memberId -> destination group id`, read straight off the persisted decisions.
   * `chosen` IS the destination (`__unassigned__` is one), so no second map is stored anywhere.
   */
  const moves = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [memberId, d] of Object.entries(regroups.decisions)) {
      if (typeof d.chosen === "string" && d.chosen) out[memberId] = d.chosen;
    }
    return out;
  }, [regroups.decisions]);

  const membersByGroup = jobState?.result?.conceptGroupMembers ?? {};
  const membership = useMemo(
    () => effectiveMembers(groups, membersByGroup, moves),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, jobState?.result?.conceptGroupMembers, moves],
  );
  const fieldIndex = jobState?.result?.fieldIndex ?? {};

  /**
   * Whether this group's FULL membership is on the wire — and therefore whether it may be regrouped.
   *
   * T-08-89, and it is the reason the check exists rather than a defensive habit. `memberVariableNames` is
   * a capped SAMPLE when `membersTruncated`, so a run that carries no `conceptGroupMembers` entry gives
   * this screen no way to see the members past the cap. Writing a regroup against that sample would
   * silently drop every member it never showed, and the row would go on reporting the sample's length as
   * the group's size. So the row keeps reporting `nMembers`, and the expanded row says plainly that it
   * cannot offer the move.
   */
  const hasFullMembership = (g: ConceptGroup) =>
    Array.isArray(membersByGroup[g.groupId]) || !g.membersTruncated;

  /**
   * The size the row reports. The effective membership where it is knowable; otherwise the contract's
   * TRUE count adjusted by the moves that touched this group — never the length of a capped sample.
   */
  const memberCount = (g: ConceptGroup) => {
    if (hasFullMembership(g)) return membership.byGroup[g.groupId]?.length ?? 0;
    const movedIn = Object.values(moves).filter((to) => to === g.groupId).length;
    return g.nMembers + movedIn;
  };

  /**
   * Where a member started, so a move can record what it is a move FROM and a restore can put it back.
   * Built from the ORIGINAL membership rather than the effective one — otherwise a second move would
   * record the first move's destination as the origin, and "put them back" would undo one step.
   */
  const originalGroupOf = useMemo(() => {
    const out: Record<string, string> = {};
    const byGroup = jobState?.result?.conceptGroupMembers ?? {};
    for (const g of groups) {
      for (const memberId of byGroup[g.groupId] ?? g.memberVariableNames) out[memberId] = g.groupId;
    }
    return out;
  }, [groups, jobState?.result?.conceptGroupMembers]);

  async function moveMember(memberId: string, toGroupId: string) {
    const from = originalGroupOf[memberId] ?? "";
    if (toGroupId === from) {
      // Back where it started, so the decision is CLEARED rather than written as a no-op. A stored
      // "moved to where it already was" would keep the row marked as changed forever.
      await regroups.clear({ memberId });
      return;
    }
    await regroups.write(
      { memberId, fromGroupId: from },
      {
        chosen: toGroupId,
        // The destinations offered FOR THIS VARIABLE at the moment of the move: where it was, the no-group
        // tray, and where it went. Deliberately NOT every group in the run — that would be honest about
        // the option space but would mark every regroup decision stale the moment any group id changed,
        // including the ones a re-adjudication elsewhere had nothing to do with, and a notice that fires
        // on unrelated changes is a notice reviewers learn to ignore.
        alternatives: [...new Set([from, UNASSIGNED_GROUP_ID, toGroupId].filter(Boolean))],
      },
    );
  }

  /** Undo every move out of one group — the "put them back" the emptied state offers. */
  async function restoreGroup(groupId: string) {
    const strayed = Object.entries(moves).filter(([memberId]) => originalGroupOf[memberId] === groupId);
    await Promise.all(strayed.map(([memberId]) => regroups.clear({ memberId })));
  }

  /** Member ids the reviewer has moved — what makes a chip render in the you-changed-it register. */
  const movedMemberIds = useMemo(() => new Set(Object.keys(moves)), [moves]);

  /** Why accepting is unavailable on this run, resolved once rather than per row. */
  const refusalFor = readjudicationRefusal({
    pinned: pinned === true,
    optedIn: Boolean(runConfig?.allowReadjudication),
  });

  /**
   * Why matching the declared components cannot run HERE — the honest not-available, rather than a dead
   * control.
   *
   * A RUN PARKED AT GATE 1 HAS NO ASSIGNED RECORDS. `match_components` runs over the run's harmonized
   * concepts, which the assign stage produces at Gate 2; the backend's own derive route refuses a run
   * with no records for exactly that reason. So the concept GROUPS this screen renders are not yet what
   * matching consumes, and saying so plainly is better than offering a button that would 409.
   *
   * The declaration itself still belongs here: it is free, it is where a reviewer scoping a run is
   * thinking about it, and the verdict becomes derivable the moment the matching evidence exists.
   */
  const matchRefusal =
    (jobState?.result?.records?.length ?? 0) > 0
      ? null
      : ({
          claim: "deferred" as const,
          reason:
            "Matching needs this run's concepts to have been matched against common data elements, which " +
            "happens at Gate 2. Declare the components now — it is free and it is saved — and the verdict " +
            "fills in once the run has got that far.",
        });

  const [accepting, setAccepting] = useState("");
  async function acceptCarve(groupId: string) {
    setAccepting(groupId);
    try {
      // EXACTLY ONE ID, built by a named function so the prohibition has somewhere to be asserted.
      const { groupIds } = readjudicationRequest(groupId);
      await readjudicateGroups(jobId, groupIds);
      toast.success("Re-split that group — its parts are below");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not re-split that group");
    } finally {
      setAccepting("");
    }
  }

  // The progress readout's numerator. Counted over the WHOLE corpus rather than the visible bucket: a
  // reviewer who worked the single-cohort tab has reviewed those groups, and a figure that reset when
  // they switched tabs would report the wrong thing. DERIVED from persisted decisions on every read, so
  // it is unchanged by a reload (R6) — a counter in `useState` is the defect this avoids.
  const reviewedCount = groups.filter((g) => isChanged(g.groupId)).length;

  // An EMPTIED group buys nothing at Gate 2 — there is no membership left to assign — so it drops out of
  // the price without the reviewer having to also untick it. The row still renders and still says what
  // happened; what it no longer does is quote a charge for work that cannot be done.
  const inScopeGroups = groups.filter((g) => isInScope(g.groupId) && memberCount(g) > 0);

  const clusters = new Set(groups.map((g) => g.clusterId)).size;
  const nCrossCohort = groups.filter((g) => g.crossCohort).length;

  // PARTITION FIRST, then search, then filter, then sort. The order matters: the partition is a structural
  // fact about the corpus and the other three are the reviewer's own narrowing, so a bucket count must not
  // move when they type in the search box.
  const buckets = useMemo(() => partitionByBreadth(groups), [groups]);
  const bucketCounts = {
    "cross-cohort": buckets["cross-cohort"].length,
    "single-cohort": buckets["single-cohort"].length,
  };
  // Searched across the WHOLE corpus, not the visible bucket: "no cohort in this run measures gait speed"
  // is a claim about the run, and deriving it from a filtered view would make it a claim about the filter.
  const search = useMemo(() => (terms && terms.length > 0 ? matchTerms(groups, terms) : null), [groups, terms]);

  const visible = useMemo(() => {
    let rows = buckets[bucket];
    if (search) rows = rows.filter((g) => search.ids.has(g.groupId));
    rows = applyFilters(rows, filters, { isTouched: isChanged, isInScope });
    return sortGroupsBy(rows, sort);
    // `isChanged`/`isInScope` close over the decision maps, which is what the two entries below track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, bucket, search, filters, sort, scope.decisions, touchedByRegroup]);

  // Nothing in the bucket matched — say which of the two reasons it was. A filter the reviewer set is
  // their own doing and is cleared; a search term that matched nothing is a finding about the corpus and
  // is reported by `TermSearch` instead.
  const filteredToNothing =
    visible.length === 0 && groups.length > 0 && activeFilterCount(filters) > 0 && !search;
  /**
   * THE SEARCH EMPTIED THE LEDGER — and WHICH of search and filters is responsible (08-14h Task 7).
   *
   * Bhargav, on the live run: *"i searched for a term and I think now all concepts have dissapeared?"*
   * The "I think" is the bug. Nothing was lost; nothing matched. But a search that hid every row fell
   * through every empty state this ledger had — `filteredToNothing` required an active filter and
   * `emptyBucket` required no search — so it mapped an empty list and rendered a BLANK BODY, leaving the
   * reviewer to infer why their concepts had gone.
   *
   * THE CAUSE IS COMPUTED, NOT GUESSED, because the two have different recoveries and sending a reviewer
   * to the wrong one is worse than saying nothing. `search.ids` is matched over the WHOLE corpus, so:
   * an empty `ids` means the terms genuinely match nothing in this run and the search is responsible; a
   * non-empty `ids` with no visible rows means the terms DID match and this bucket or the filters are
   * hiding the matches, so both are named and both ways back are offered.
   */
  const searchEmptied = visible.length === 0 && groups.length > 0 && !!search;
  const searchCause: "search" | "both" = search && search.ids.size === 0 ? "search" : "both";
  /**
   * The DEFAULT bucket is empty and the other one is not.
   *
   * A real dead end, found in test: a run whose groups are all single-cohort opens on an empty
   * cross-cohort tab, and "no rows here" is indistinguishable from "no rows at all" — which would be the
   * coverage lie the partition exists to avoid, arrived at from the opposite direction. The default is
   * NOT changed (the cross-cohort bucket leads on purpose); the empty view names the other bucket, says
   * what it holds, and goes there in one click.
   */
  const otherBucket: Bucket = bucket === "cross-cohort" ? "single-cohort" : "cross-cohort";
  const emptyBucket =
    visible.length === 0 && groups.length > 0 && activeFilterCount(filters) === 0 && !search;

  /**
   * HAS THIS RUN EVEN REACHED GATE 1 YET? (08-14h Task 3)
   *
   * THE DEFECT THIS ANSWERS. An empty ledger and a not-yet-populated ledger looked identical and meant
   * opposite things. "No groups formed — every variable was left unassigned. That usually means the
   * dictionaries share too little text to group." is a CLAIM ABOUT THE REVIEWER'S CORPUS, and a run that
   * is still splitting has produced no evidence for it. Since 08-14f made Start land directly here, that
   * false claim was the first thing a reviewer saw on every run they started.
   *
   * DERIVED FROM THE STREAMED STATUS, EVERY RENDER — never held in component state. That is what makes
   * the ledger self-populating: `useHarmonizeStream` already delivers the park, so the moment the status
   * changes these go false and the rows appear with no reload. A `useState` seeded on first render would
   * strand the reviewer on a waiting screen over a run that had already arrived.
   *
   * AN ABSENT `jobState` COUNTS AS WAITING, deliberately. The run's payload has not landed, so the screen
   * knows nothing about the corpus — and "No groups formed" is exactly as false then as it is mid-run.
   * A stream failure is reported by the `error` alert above rather than by this branch.
   */
  const awaitingRun = groups.length === 0 && (!jobState || isInFlight(jobState.status));
  /**
   * The run ENDED before it produced anything.
   *
   * `complete` is excluded: a finished run with no groups is the genuine corpus finding, and the existing
   * copy for it is correct. This branch is for the run that failed or was stopped — where the screen
   * would otherwise wait for groups that are never coming.
   */
  const stoppedBeforeGate =
    groups.length === 0 && !!jobState && isTerminal(jobState.status) && jobState.status !== "complete";

  /**
   * Commit this gate and GO. The second half is the one that was missing (08-16c Task 8).
   *
   * Until 2026-09-01 this awaited `resumeRun`, discarded the result and toasted a hardcoded "Continuing to
   * Gate 2" — so the press spent the run's money and then left the reviewer standing on the screen they
   * had just committed, with a success message telling them they had moved. Bhargav read that live: "I
   * clicked continue to gate 2 but not working."
   *
   * THE DESTINATION IS THE SERVER'S, not this screen's guess. `resumeRun` returns `{ jobId, target }`
   * where `target = next_gate(gate_position)` — the backend's own answer to "which gate next" — and Gate 1
   * is not the only thing that decides what follows it (Gate 4 is a pure read the backend carries forward
   * without a worker). Hardcoding `gate2` here would be the same class of error as the hardcoded toast,
   * and it would go wrong silently the first time the boundary moved. The label follows the same value, so
   * the sentence and the destination cannot drift apart.
   *
   * NAVIGATION IS DOWNSTREAM OF THE AWAIT, deliberately. A refused Continue — the route carries six
   * distinct 409s — must leave the reviewer here, holding the screen whose state the refusal is about.
   * `gate1.spec.ts`'s "a refused continue leaves the reviewer on Gate 1" is the guard on that ordering.
   *
   * The error arm repeats the SERVER'S sentence rather than a generic one: `json()` in `lib/api.ts`
   * unpacks FastAPI's `detail` into the Error message, so each of those 409s reaches the reviewer as
   * itself. The fallback string is only for a throw that is not an Error at all.
   */
  async function onContinue() {
    setResuming(true);
    try {
      const { target } = await resumeRun(jobId);
      toast.success(`Continuing to ${GATE_LABELS[target as GatePosition] ?? target}`);
      navigate(pathForGate(jobId, target));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not continue this run");
    } finally {
      setResuming(false);
    }
  }

  return (
    <GateShell
      gate="gate1"
      subhead="Each row is a group of variables that mean the same thing, with the name ddharmon generated for it. Choose which ones go on to be matched against common data elements."
      rail={railFor("gate1", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      // Inherited from the shell (08-14 Task 4): the stop control is placed ONCE in `GateShell`, so a
      // gate's whole part in it is handing over the run and the stream's own `cancel(mode)`.
      job={jobState}
      onStop={cancel}
      // The shared answer to "is this run parked?", not a fourth local copy of the predicate.
      resumed={isParked(jobState?.status)}
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

      {/* FOUR ZEROES ARE A CLAIM TOO. "0 concept groups · 0 parent clusters · 0 variables" reads as
          "this run measured nothing", which is the same lie as the empty ledger and just as loud, so the
          strip is withheld until the run has actually produced figures. */}
      {!awaitingRun && !stoppedBeforeGate && (
        <GroupingStrip
          nGroups={groups.length}
          nClusters={clusters}
          nVariables={variables}
          nCrossCohort={nCrossCohort}
        />
      )}

      {groups.length > 0 && (
        <>
          <LedgerToolbar
            counts={bucketCounts}
            bucket={bucket}
            onBucketChange={setBucket}
            sort={sort}
            onSortChange={setSort}
            filters={filters}
            onFiltersChange={setFilters}
            allCohorts={allCohorts}
            // Across BOTH buckets: a reviewer who has worked the single-cohort tab has reviewed those
            // groups, and a readout that reset when they switched tabs would report the wrong thing.
            reviewed={reviewedCount}
            inScope={inScopeGroups.length}
          />
          <TermSearch
            onSearch={(next) => setTerms(next.length > 0 ? next : null)}
            noMatches={search?.noMatches ?? []}
            missingTokens={search?.missingTokens ?? {}}
          />
        </>
      )}

      <Ledger
        columns={GATE1_LEDGER_COLUMNS}
        caption="Concept groups"
        sum={
          groups.length > 0 ? (
            <SumBlock
              realized={costSoFar}
              inScopeTotal={price * inScopeGroups.length}
              wholeCorpus={price * groups.length}
              nInScope={inScopeGroups.length}
              nGroups={groups.length}
            />
          ) : undefined
        }
      >
        {awaitingRun ? (
          /* WAITING — the run has not got here yet, so the screen says so and names what it is waiting
             for. The stage comes verbatim from the stream, and the list below it is what has to finish
             before a single row can exist: it is exactly what reaching Gate 1 pays for (`lib/estimate.ts`
             — generate-ideal, split, and the coherence judge). */
          <GateEmptyState
            heading="Waiting for this run to reach Gate 1"
            nextStep={
              <span data-testid="gate1-waiting-next">
                Nothing to do yet — the groups appear here on their own as soon as the run gets to them,
                with no need to reload. You can close this tab; the run keeps going and will be waiting
                at this gate when you come back.
              </span>
            }
            className="[&]:block"
          >
            <span data-testid="gate1-waiting">
              This run is {jobState?.phase ? <span className="font-semibold">{jobState.phase}</span> : "still working"}.
              Concept groups are formed after three stages finish: ddharmon describes the ideal element
              for each cluster, splits clusters that hold more than one concept, and runs the coherence
              judge over the result. The first rows land here when the third one does.
            </span>
          </GateEmptyState>
        ) : stoppedBeforeGate ? (
          /* THE RUN DIED. Without this, a failed run leaves the gate waiting for groups that are never
             coming — the failure mode that makes a waiting state worse than an empty one. */
          <GateEmptyState
            heading={
              jobState?.status === "cancelled"
                ? "This run was stopped before it reached Gate 1"
                : "This run failed before it reached Gate 1"
            }
            nextStep={
              <>
                Start again from{" "}
                <Link
                  href={`/run/${jobId}/setup`}
                  className="font-semibold text-link-on-raised underline underline-offset-2"
                >
                  Set up
                </Link>
                , or open <Link href="/jobs" className="font-semibold text-link-on-raised underline underline-offset-2">Runs</Link>{" "}
                to pick up a different one.
              </>
            }
            className="[&]:block"
          >
            <span data-testid="gate1-run-stopped">
              No concept groups were produced, so there is nothing to review here. This is not a finding
              about your dictionaries — the run ended before it got far enough to have one.
            </span>
          </GateEmptyState>
        ) : groups.length === 0 ? (
          unassigned.length > 0 ? (
            /* ALL OUTLIERS — a different finding from "no groups formed". The clustering ran; everything
               fell out of it. Listing what fell out is what makes "nothing can be scoped" actionable. */
            <GateEmptyState
              heading="Nothing grouped above the threshold"
              nextStep={
                <>
                  Nothing can be scoped until at least one group forms. Go back to{" "}
                  <Link
                    href={`/run/${jobId}/setup`}
                    className="font-semibold text-link-on-raised underline underline-offset-2"
                  >
                    Set up
                  </Link>{" "}
                  and check that the description column is mapped, or add a dictionary that overlaps these.
                </>
              }
            >
              Every variable was left unassigned by the clustering — {unassigned.length}{" "}
              {unassigned.length === 1 ? "variable" : "variables"}, listed below.
            </GateEmptyState>
          ) : (
            <GateEmptyState
              heading="No groups formed"
              nextStep={
                <>
                  Go back to{" "}
                  <Link
                    href={`/run/${jobId}/setup`}
                    className="font-semibold text-link-on-raised underline underline-offset-2"
                  >
                    Set up
                  </Link>{" "}
                  and check the column mapping, or add a dictionary.
                </>
              }
            >
              Every variable was left unassigned. That usually means the dictionaries share too little text
              to group.
            </GateEmptyState>
          )
        ) : emptyBucket ? (
          <GateEmptyState
            heading={
              bucket === "cross-cohort"
                ? "No group in this run spans more than one cohort"
                : "Every group in this run spans more than one cohort"
            }
            nextStep={
              <button
                type="button"
                data-testid="go-to-other-bucket"
                onClick={() => setBucket(otherBucket)}
                className="text-left font-semibold text-link-on-raised underline underline-offset-2"
              >
                Show the {bucketCounts[otherBucket]}{" "}
                {bucketCounts[otherBucket] === 1 ? "group" : "groups"}{" "}
                {otherBucket === "cross-cohort" ? "that span two or more cohorts" : "from a single cohort"}.
              </button>
            }
          >
            {bucket === "cross-cohort"
              ? "Nothing pooled across your dictionaries this time. The run still produced results — every group maps variables from one cohort to a common data element — and they are on the other tab."
              : "Every group here draws on two or more of your dictionaries, so there is nothing in the single-cohort view."}
          </GateEmptyState>
        ) : searchEmptied ? (
          /* A SEARCH THAT HID EVERYTHING. Say the term, say it matched nothing, say the groups are still
             here, and give the way back — the four things whose absence let a reviewer doubt whether his
             concepts had been destroyed. */
          <GateEmptyState
            heading={
              searchCause === "search"
                ? "Your search matched no group in this run"
                : "Your search matched groups, but a filter is hiding them"
            }
            nextStep={
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <button
                  type="button"
                  data-testid="clear-search-inline"
                  onClick={() => setTerms(null)}
                  className="text-left font-semibold text-link-on-raised underline underline-offset-2"
                >
                  Clear the search to see all {groups.length} {groups.length === 1 ? "group" : "groups"}.
                </button>
                {/* BOTH WAYS BACK when both are responsible: either one alone may be the one the
                    reviewer wants kept, and choosing for them is how a recovery becomes a second
                    surprise. */}
                {searchCause === "both" && activeFilterCount(filters) > 0 && (
                  <button
                    type="button"
                    data-testid="clear-filters-inline"
                    onClick={() => setFilters(NO_FILTERS)}
                    className="text-left font-semibold text-link-on-raised underline underline-offset-2"
                  >
                    Or clear the {activeFilterCount(filters) === 1 ? "filter" : "filters"} and keep the
                    search.
                  </button>
                )}
              </span>
            }
            className="[&]:block"
          >
            <span data-testid="search-empty" data-cause={searchCause}>
              {/* THE TERMS ARE ECHOED AS ESCAPED TEXT CHILDREN — never raw HTML. A surface that reflects
                  user input back is exactly where an injection would land; JSX children are escaped by
                  construction, which is why this is a rule about what NOT to reach for. */}
              Nothing has been lost — every group is still here, and{" "}
              {(terms ?? []).length === 1 ? "your term is" : "your terms are"} hiding{" "}
              {groups.length === 1 ? "it" : "them"}:{" "}
              {(terms ?? []).map((t, i) => (
                <span key={t}>
                  {i > 0 && ", "}
                  <span className="font-semibold">&ldquo;{t}&rdquo;</span>
                </span>
              ))}
              .{" "}
              {searchCause === "search"
                ? "No group's text contains those words, which is a finding about this run rather than a failed search — the detail is in the search box above."
                : `Some groups do match, but the ${
                    activeFilterCount(filters) === 1 ? "filter" : "filters"
                  } you have on, or the tab you are viewing, exclude every one of them.`}
            </span>
          </GateEmptyState>
        ) : filteredToNothing ? (
          /* A FILTER matching nothing — the reviewer's own doing, and clearing it is the fix. Different
             copy from a search term that matched nothing, which is a finding about the corpus and is
             reported above by `TermSearch`. */
          <GateEmptyState
            heading="No group matches this filter"
            nextStep={
              <button
                type="button"
                data-testid="clear-filters-inline"
                onClick={() => setFilters(NO_FILTERS)}
                className="text-left font-semibold text-link-on-raised underline underline-offset-2"
              >
                Clear the filter to see all {groups.length} {groups.length === 1 ? "group" : "groups"}.
              </button>
            }
            className="[&]:block"
          >
            <span data-testid="filter-empty">
              Clear the filter to see all {groups.length} {groups.length === 1 ? "group" : "groups"} in
              this run.
            </span>
          </GateEmptyState>
        ) : (
          visible.map((g) => (
            <GroupRow
              key={g.groupId}
              group={g}
              allCohorts={allCohorts}
              price={price}
              count={memberCount(g)}
              inScope={isInScope(g.groupId)}
              changed={isChanged(g.groupId)}
              onDropMember={(memberId) => void moveMember(memberId, g.groupId)}
              onScopeChange={(next) =>
                void scope.write(
                  { groupId: g.groupId },
                  { chosen: next ? IN_SCOPE : OUT_OF_SCOPE, alternatives: SCOPE_OPTIONS },
                )
              }
            >
              <ExpandedGroup
                group={g}
                members={membership.byGroup[g.groupId] ?? []}
                unassignedFromHere={membership.unassigned.filter((m) => originalGroupOf[m] === g.groupId)}
                fieldIndex={fieldIndex}
                movedMembers={movedMemberIds}
                onMove={(memberId, toGroupId) => void moveMember(memberId, toGroupId)}
                onRestore={() => void restoreGroup(g.groupId)}
                canRegroup={hasFullMembership(g)}
                refusal={refusalFor}
                carvePrice={
                  <>
                    This costs money. Re-splitting this group and re-assigning its parts is paid work —
                    about {formatUsd(price * 2)} for a group this size — and it starts as soon as you press
                    the button. Your spend so far updates when it finishes.
                  </>
                }
                accepting={accepting === g.groupId}
                onAcceptCarve={() => void acceptCarve(g.groupId)}
                onIgnoreCarve={() => undefined}
              />
            </GroupRow>
          ))
        )}
      </Ledger>

      {groups.length === 0 && unassigned.length > 0 && (
        <section
          aria-label="Variables the clustering left unassigned"
          className="flex flex-col gap-2 rounded-card bg-surface-raised px-6 py-4 shadow-card"
        >
          <h2 className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Left unassigned
          </h2>
          <ul className="flex flex-col gap-1">
            {unassigned.map((f) => (
              <li
                key={`${f.cohort}:${f.variable}`}
                data-testid="unassigned-variable"
                className="flex flex-wrap items-baseline gap-2 text-sm"
              >
                <span className="font-mono text-xs font-semibold text-accent-2-on-raised">{f.cohort}</span>
                <span className="font-mono text-xs text-on-raised">{f.variable}</span>
                <span className="min-w-0 text-on-raised-muted">{f.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        THE DECLARED-SCORE PANEL (the 2026-08-25 amendment). A SECTION of this screen's body — below the
        ledger, above the commit bar — and never its own screen, a step before Gate 1, or a modal: a
        pre-gate screen would interrupt a purchase decision to pitch an add-on.
      */}
      <DeclaredScorePanel
        jobId={jobId}
        pinned={pinned}
        spec={jobState?.composites?.at(-1) ?? null}
        matchRefusal={matchRefusal}
      />

      <CommitBar
        action="Continue to Gate 2"
        total={groups.length > 0 ? price * inScopeGroups.length : undefined}
        // `spentHere` is DELIBERATELY OMITTED here, and only on this screen. The ledger's sum block
        // directly above already leads with the realized figure — that placement is the requirement, not
        // a preference — so passing it to the bar as well rendered the same fact twice, in two different
        // wordings ("$0" against "nothing"), a few pixels apart. Two amounts for one fact that disagree
        // is worse than one amount stated once.
        scopeLabel={`${inScopeGroups.length} ${inScopeGroups.length === 1 ? "group" : "groups"}`}
        onCommit={onContinue}
        busy={resuming}
        // Nothing gates Continue on a REVIEW count — how much to triage is the reviewer's call (D-09
        // revised). What does gate it is having something to buy at all.
        disabled={inScopeGroups.length === 0}
      />
    </GateShell>
  );
}
