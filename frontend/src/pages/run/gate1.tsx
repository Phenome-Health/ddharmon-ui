import { useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  Calculator,
  ChevronDown,
  ChevronRight,
  Grid3x3,
  Pencil,
  Plus,
  Quote,
  Scissors,
  Search,
  Trash2,
  Undo2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DisclosureChevron, DisclosureLabel } from "@/components/ui/disclosure";
import { Highlight } from "@/components/ui/highlight";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { GATE_LABELS } from "@/components/gate/GateRail";
import { GateShell } from "@/components/gate/GateShell";
import { GATE1_LEDGER_COLUMNS, Ledger } from "@/components/gate/Ledger";
import { LedgerRow } from "@/components/gate/LedgerRow";
import { COHERENCE_COPY, CoherenceMark } from "@/components/gate/CoherenceMark";
import { ConceptWorkbench } from "@/components/gate/ConceptWorkbench";
import { CohortCoverage } from "@/components/gate/CohortCoverage";
import { CommitBar } from "@/components/gate/CommitBar";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { CarveProposal } from "@/components/gate/CarveProposal";
import { DeclaredScorePanel } from "@/components/gate/DeclaredScorePanel";
import { BreadthFilter } from "@/components/gate/BreadthFilter";
import {
  MEMBER_DRAG_TYPE,
  MemberChip,
  MemberDropZone,
  UNASSIGNED_GROUP_ID,
} from "@/components/gate/MemberChip";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { RunKeyField } from "@/components/gate/RunKeyField";
import { SourceRows, hasSourceRows } from "@/components/source-rows";
import {
  CohortLegend,
  FilterCheck,
  FilterChips,
  FilterSection,
  QueueRowFacts,
  QueueSearch,
  SegmentedSort,
  SelectAllShown,
  type FilterChip,
} from "@/components/gate/QueueControls";
import { tickedOfShown } from "@/lib/queue-controls";
import { gate1BillableGroups, gate1ScopePayload, resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import { isGatePast } from "@/lib/gate-routes";
import { isGateLocked } from "@/lib/review-mode";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { getCheckpoint, getScoreSuggestions, readjudicateGroups, resumeRun } from "@/lib/api";
import { nextRailGate, pathForGate } from "@/lib/gate-routes";
import { frozenContinue, realizedRailArgs } from "@/lib/gate-rail";
import { heldRunKey, isPreviewRun, keyAskFor, type KeyRefusal } from "@/lib/run-key";
import { estimateRunCostBreakdown, formatUsd, newGroupIdealUsd } from "@/lib/estimate";
import {
  DEFAULT_BUCKET,
  NO_FILTERS,
  applyFilters,
  activeFilterCount,
  bulkScopePlan,
  cohortRoster,
  groupLabel,
  effectiveMembers,
  gate1QuoteUsd,
  isFlagged,
  isReviewerGroupId,
  newReviewerGroupId,
  readjudicationRequest,
  reshapedGroupIds,
  reviewerGroupRows,
  matchTerms,
  namedGroupsById,
  partitionByBreadth,
  pricePerGroup,
  sortDestinations,
  unplacedFields,
  sortGroupsByColumn,
  type Bucket,
  type LedgerFilters,
  type LedgerSortKey,
} from "@/lib/ledger";
import {
  isInFlight,
  isParkedAt,
  isTerminal,
  resumeTookEffect,
} from "@/lib/run-state";
import { toggleSort, type ColumnSort } from "@/lib/column-sort";
import { SUGGESTION_TAG_COPY, scoreScopeInput, scoreSeededGroups, scoreTaggedGroups } from "@/lib/score-scope";
import type { GroupScopeWhy } from "@/lib/score-suggestion-cards";
import { GATE1_MATCH_DEFERRED, declaredScores } from "@/lib/score-match";
import { cn } from "@/lib/utils";
import type {
  CoherenceState,
  ConceptGroup,
  FieldDetail,
  GatePosition,
  RunMode,
  UnassignedField,
} from "@/types";

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
 * NO CLUSTER-SIZE CONTROL, EVER (D-17), for three independent reasons any one of which would be sufficient:
 *   1. Re-clustering INVALIDATES THE FROZEN SUBSTRATE. UMAP + HDBSCAN is not bit-reproducible, so a partition
 *      cannot be recovered by re-running with the same parameters — the run would be a different run.
 *   2. It RE-PAYS the clustering step and strands every decision already made: a scope or a regroup is keyed
 *      to a group that no longer exists under the new partition.
 *   3. The public design page publishes a hand-tuned cluster size as the REJECTED alternative; a slider here
 *      would contradict a live public claim about how the tool works.
 * A group is reshaped by moving variables into or out of it. (The four-figure grouping strip that carried this
 * note was removed on 2026-10-06: its totals moved into the queue header, beside the list they count.)
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
function TemplateSuspicion({ judged = false }: { judged?: boolean }) {
  return (
    <span
      data-testid="template-suspicion"
      data-signal="deterministic"
      // ELEVATED ONTO JUDGED GROUPS (Bhargav: coherent ≠ harmonizable). The original constraint kept this
      // off scored rows so it could never be read as a verdict; that intent is preserved by the copy —
      // when `judged`, it states plainly that the judge DID call it one concept and that this is a separate
      // $0 pattern check, not a second adjudication — while still surfacing the battery risk the judge misses.
      title={
        judged
          ? "The coherence judge called this one concept — and along one axis it is. But a cheap, local check sees a repeating question template with different fillers, which usually means a multi-item battery (a symptom scale, say), not a single variable. A battery rarely collapses to one CDE. This is a $0 pattern check, not the judge."
          : "A cheap, local check noticed these variables share one question template with different fillers. That often means a matrix of separate items rather than one concept — but it is a pattern, not a judgement, and the coherence judge was not asked about this group."
      }
      className="inline-flex items-center gap-1 text-xs text-on-raised-muted"
    >
      <Grid3x3 aria-hidden="true" className="h-3 w-3 shrink-0" />
      repeating template
    </span>
  );
}

/** At or above this many variables, a group is hard to review by hand without at least one re-split. */
const BIG_GROUP_MIN = 10;

/**
 * A "large group" nudge (Bhargav: a 10+-variable group is hard to tackle without at least one re-split, so
 * mark them especially). PURELY LOCAL — member count, no model call — so it is a prioritisation hint, not a
 * judgement: it marks the groups worth spending an "Accept this division" / auto-refine pass on before the
 * manual work begins.
 */
function LargeGroupMark({ count }: { count: number }) {
  return (
    <span
      data-testid="large-group-mark"
      title={`${count} variables — a large group. These usually need at least one re-split before they resolve cleanly at Gate 2; a good candidate for "Accept this division" or an auto-refine pass before hand-editing.`}
      className="inline-flex items-center gap-1 rounded-pill bg-surface-warn px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-on-warn"
    >
      <Scissors aria-hidden="true" className="h-3 w-3 shrink-0" />
      large
    </span>
  );
}

/**
 * THE PROVENANCE PILLS MARK THE EXCEPTIONS, NOT THE RULE (08-16c review).
 *
 * There used to be a third one, `GeneratedMark`, reading "generated" — and Bhargav, looking at a real
 * run: *"if everything has this generated tag then it has no value, right?"* He is right, and the reason
 * is mechanical: a generated name is the DEFAULT, so on an untouched run every single row carried the
 * pill, and a column whose value is the same on every row carries no information. It is the same test
 * `source-rows.tsx` applies with `showDesc`.
 *
 * So a pill now appears only where the name is NOT what the pipeline produced: BORROWED from the judge,
 * or given by the REVIEWER. A generated name shows nothing, which is what "nothing to report" should
 * look like.
 *
 * THE GENERATED STATE ITSELF IS UNTOUCHED. `groupLabel` still returns `source: "generated"`, the row
 * still exposes it as `data-label-source`, and a renamed row still shows "ddharmon called it <name>"
 * beneath the reviewer's — Task 3 keeps the original recoverable and that is a different requirement
 * from labelling the default.
 */

/**
 * A label the group did NOT produce (08-16c Task 1).
 *
 * A reviewer must never mistake the two. "generated" says ddharmon wrote this name FROM the group; this
 * one says the group has no name and what is standing in its place is the coherence judge's description
 * of the group's CORE — a sample of it, not all of it. Same shape and position as the generated pill so
 * the eye finds the provenance in the same place on every row, different word so it reads differently.
 */
/**
 * The provenance pill for a name the REVIEWER gave (08-16c Task 3). Same shape and place as the other
 * two, different word: a reviewer must be able to tell at a glance whose name they are reading.
 */
function RenamedMark() {
  return (
    <span
      data-testid="renamed-mark"
      title="You renamed this group. The name ddharmon generated for it is kept and is shown beneath — renaming is your annotation, not a change to what the pipeline produced."
      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-inset px-2 py-0.5 text-xs font-normal text-on-inset-muted"
    >
      <Pencil aria-hidden="true" className="h-3 w-3" />
      your name
    </span>
  );
}

/**
 * The provenance pill for a group the REVIEWER made (08-28 Wave 2). It replaces the coherence cell on the row:
 * the judge was never asked about a New group, and a "not judged" cell there would read as a finding.
 */
function NewGroupMark() {
  return (
    <span
      data-testid="new-group-mark"
      title="You made this group. ddharmon did not cluster, split or judge it: it is matched at Gate 2 exactly as you filled it, after writing one ideal description for it."
      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-inset px-2 py-0.5 text-xs font-normal text-on-inset-muted"
    >
      <UserRound aria-hidden="true" className="h-3 w-3" />
      your group
    </span>
  );
}

function BorrowedMark() {
  return (
    <span
      data-testid="borrowed-mark"
      title="This group has no generated name. The text shown is the coherence judge's description of the group's CORE — a sample of its members, not the whole group — borrowed so the row can be identified. It is not a name ddharmon produced, and no catalog element has been chosen."
      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-inset px-2 py-0.5 text-xs font-normal text-on-inset-muted"
    >
      <Quote aria-hidden="true" className="h-3 w-3" />
      judge&rsquo;s summary
    </span>
  );
}

/**
 * The provenance pill for a re-split CHILD (08-23b Task 2). A reviewer accepted the division of an
 * over-merged group at Gate 1, and this row is one of the child concept-groups carved out of it. Same
 * shape and place as the other provenance pills, a different word — and it names the parent so the origin
 * is legible on the row. A re-split is a GROUPING change: the child is NOT yet assigned to a CDE — that
 * happens at Gate 2 — which is exactly what distinguishes "accept the division" from an assign.
 */
function ReSplitMark({ parent }: { parent: string }) {
  return (
    <span
      data-testid="resplit-mark"
      data-parent={parent}
      title={`Re-split from ${parent}. A reviewer accepted the division of an over-merged group, and this is one of the child concept-groups carved out of it. It is not yet assigned to a CDE — that happens at Gate 2.`}
      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-inset px-2 py-0.5 text-xs font-normal text-on-inset-muted"
    >
      <Scissors aria-hidden="true" className="h-3 w-3" />
      re-split
    </span>
  );
}

/**
 * The row's name, and the way to change it (08-16c Task 3).
 *
 * Bhargav renames a group to be able to FIND IT AGAIN, so the rename is a reviewer annotation and is
 * marked as one — it never overwrites `concept`. The generated name stays on the run result and is shown
 * beneath the reviewer's, which is what makes "the original remains recoverable" visible rather than
 * merely true in the artifact store.
 *
 * EDIT IN PLACE, COMMIT ON BLUR OR ENTER, ABANDON ON ESCAPE. The draft is local state — the only place in
 * this screen where that is correct, because it is an uncommitted keystroke buffer rather than a decision;
 * the moment it commits it goes through the decision hook like everything else, and what the row RENDERS
 * is always read back from the persisted decisions.
 */
function GroupTitle({
  group,
  label,
  readOnly,
  onRename,
}: {
  group: ConceptGroup;
  label: ReturnType<typeof groupLabel>;
  readOnly: boolean;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const own = groupLabel(group);

  if (editing) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <input
          data-testid="rename-input"
          autoFocus
          value={draft}
          aria-label={`Rename ${label.text}`}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              onRename(draft);
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          onBlur={() => {
            onRename(draft);
            setEditing(false);
          }}
          className="min-w-0 flex-1 rounded border border-rule-control-on-raised bg-surface-raised px-2 py-0.5 text-sm text-on-raised"
        />
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* `truncate` keeps a long judge sentence from breaking the row; the full text stays reachable
          through the title attribute, so nothing is lost — only folded. */}
      <span
        className="truncate"
        data-label-source={label.source}
        title={label.text}
      >
        {label.text}
      </span>
      {label.source === "reviewer" && <RenamedMark />}
      {label.source === "judge" && <BorrowedMark />}
      {/* `generated`, `leftover` and `none` carry NO mark. `generated` is the default and a pill on every row
          says nothing (08-16c review); the two placeholders never had one, because "generated" beside
          "Unnamed group" would claim the pipeline produced that string, which it did not. */}
      {label.source === "reviewer" && (
        <span
          data-testid="generated-name-kept"
          className="truncate text-xs text-on-raised-muted"
        >
          {/* A leftover was never named, so its placeholder is kept as itself, not as what ddharmon "called it". */}
          {own.source === "leftover" ? own.text : `ddharmon called it ${own.text}`}
        </span>
      )}
      {!readOnly && (
        <button
          type="button"
          data-testid="rename-group"
          aria-label={`Rename ${label.text}`}
          title="Rename this group"
          onClick={(e) => {
            e.stopPropagation();
            setDraft(label.source === "reviewer" ? label.text : "");
            setEditing(true);
          }}
          className="shrink-0 rounded p-1 text-on-raised-muted hover:text-accent-on-raised"
        >
          <Pencil aria-hidden="true" className="h-3 w-3" />
        </button>
      )}
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
  readOnly,
  renamedTo,
  onRename,
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
  readOnly: boolean;
  /** The reviewer's own name for this group, if any (08-16c Task 3). */
  renamedTo?: string;
  onRename: (next: string) => void;
  onDropMember: (memberId: string) => void;
  children: React.ReactNode;
}) {
  const judged = group.coherence !== "not_judged";
  const label = groupLabel(group, renamedTo);
  return (
    <LedgerRow
      rowId={group.groupId}
      title={
        <GroupTitle
          group={group}
          label={label}
          readOnly={readOnly}
          onRename={onRename}
        />
      }
      subtitle={
        <span
          data-testid="row-provenance"
          className="flex flex-wrap items-center gap-x-2 gap-y-1"
        >
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
      coverage={
        <CohortCoverage cohorts={group.cohorts} allCohorts={allCohorts} />
      }
      count={
        <>
          {/* The TRUE member count, even when the collapsed sample is capped — regrouping against a
              partial sample would silently drop the members it never showed (T-08-89) — and updated by
              the reviewer's own moves, so the row never reports a size it no longer has. */}
          {count}
          {/* The column header is `Vars`, which a reviewer reads once and a screen-reader user hears
              never: the row announces its own unit so the number is not a bare digit. */}
          <span className="sr-only">
            {" "}
            {count === 1 ? "variable" : "variables"}
          </span>
        </>
      }
      cost={price}
      selected={inScope}
      readOnly={readOnly}
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
function readjudicationRefusal({
  pinned,
  optedIn,
}: {
  pinned: boolean;
  optedIn: boolean;
}): { claim: "failed" | "not-enabled"; reason: React.ReactNode } | null {
  if (pinned) {
    return {
      claim: "not-enabled",
      reason:
        "This is the shared sample run, which everyone sees, so it cannot be re-split — and it replays in " +
        "your browser and spends nothing, so there would be nothing to charge. Start a run of your own to " +
        "use it. Ignoring the proposal or editing it by hand still works here.",
    };
  }
  // ONLY AN OLD RUN REACHES THIS (final review round 1): every new run records re-splitting ON, so `optedIn` is false
  // only for a run created before that, which recorded the old Setup opt-in as off and replays as recorded. There is
  // no Setup control to point at any more, so the copy points at a new run instead.
  if (!optedIn) {
    return {
      claim: "not-enabled",
      reason:
        "Re-splitting is not enabled for this run: it was created before re-splitting became available on " +
        "every run, and recorded it as off. Start a new run to re-split a group — every new run can. " +
        "Ignoring the proposal or editing it by hand still works.",
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
      <div
        role="group"
        aria-label={label}
        className="flex flex-wrap gap-1 rounded-inner border border-rule-on-raised p-3"
      >
        {children}
      </div>
    );
  }
  return (
    <MemberDropZone
      groupId={groupId}
      label={label}
      onDropMember={(memberId) => onDropMember(memberId)}
    >
      {children}
    </MemberDropZone>
  );
}

/**
 * A member id split into the two things a reader needs, in ONE place.
 *
 * A member id is `cohort:variable`. `fieldIndex` carries the variable's dictionary NAME but not its
 * cohort, so the cohort comes from the id — which is where it came from in the first place — and the name
 * from the index when the run has one. This was written out inline at each site that renders a member;
 * the tray's members list (08-16c review) would have been the fourth copy, so it is one function now.
 */
function memberParts(
  memberId: string,
  fieldIndex: Record<string, FieldDetail>,
): { cohort: string; variable: string } {
  const separator = memberId.indexOf(":");
  const cohort = separator > 0 ? memberId.slice(0, separator) : "";
  const raw = separator > 0 ? memberId.slice(separator + 1) : memberId;
  return { cohort, variable: fieldIndex[memberId]?.name || raw };
}

/**
 * ONE TRAY ENTRY: a live drop destination that can also be OPENED to show what is already in it
 * (08-16c review).
 *
 * Bhargav: *"clicking on one of these should open a mini drop down of its members or take you to the
 * group in the main view."* Two designs, and only the first is built.
 *
 * WHY NOT THE NAVIGATION. The tray exists to support a drag out of the group that is open RIGHT NOW —
 * that is the whole reason Task 6 put it here, since expanding one group pushes every other group's drop
 * zone off the viewport. Navigating to the destination would collapse the source and scroll it away,
 * destroying exactly the context the tray was built to serve. The question a reviewer has while holding a
 * variable is "is this the right target?", and a list of what is already in the group answers it without
 * them losing their place.
 *
 * THE DISCLOSURE IS INSIDE THE DROP ZONE, NOT IN A PORTAL, and that is load-bearing rather than
 * incidental. An open list COVERS the destination it describes, so a reviewer mid-drag will aim at it; a
 * portalled popover renders outside the zone, so that drop would land on nothing and the move would be
 * lost silently — the same defect the `stopPropagation` note on `MemberDropZone` records. Rendered inside,
 * a drop anywhere on the list bubbles to the zone's own handler and means what it looks like it means.
 *
 * A `<button>`, so it is keyboard-reachable for free, and explicitly NOT draggable: a control that could
 * also start a drag is a control that fights the gesture it sits inside.
 */
function DestinationEntry({
  group,
  members,
  sampleOnly,
  fieldIndex,
  onMove,
}: {
  group: ConceptGroup;
  /** The destination's membership AFTER the reviewer's moves — the same list the ledger counts. */
  members: string[];
  /** True when the run recorded only a capped sample of this group, so the list below is partial. */
  sampleOnly: boolean;
  fieldIndex: Record<string, FieldDetail>;
  onMove: (memberId: string, toGroupId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = groupLabel(group);
  const listId = `destination-members-${group.groupId}`;
  const count = sampleOnly ? group.nMembers : members.length;
  return (
    <MemberDropZone
      groupId={group.groupId}
      label={`Move into ${label.text}`}
      onDropMember={(memberId) => onMove(memberId, group.groupId)}
      className="flex-col items-start gap-0.5 bg-surface-inset py-2"
    >
      <button
        type="button"
        data-testid="destination-members-toggle"
        data-group-id={group.groupId}
        draggable={false}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left"
      >
        <span
          data-testid="destination-entry"
          data-group-id={group.groupId}
          className="w-full truncate text-xs font-semibold text-on-inset"
          title={label.text}
        >
          {label.text}
        </span>
        <span className="flex items-center gap-1 text-xs text-on-inset-muted">
          {count} {count === 1 ? "variable" : "variables"}
          {label.source === "judge" && " · judge's summary"}
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3 w-3", open && "rotate-180")}
          />
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          data-testid="destination-members"
          data-group-id={group.groupId}
          className="flex w-full flex-col gap-0.5 pt-1"
        >
          {members.map((memberId) => {
            const { cohort, variable } = memberParts(memberId, fieldIndex);
            return (
              <li
                key={memberId}
                data-testid="destination-member"
                data-member-id={memberId}
                className="flex min-w-0 items-baseline gap-1"
              >
                <span className="shrink-0 font-mono text-xs font-semibold text-accent-2-on-inset">
                  {cohort}
                </span>
                <span
                  className="truncate text-xs text-on-inset-muted"
                  title={variable}
                >
                  {variable}
                </span>
              </li>
            );
          })}
          {/* T-08-89 AGAIN, AND FOR THE SAME REASON. Where the run recorded a capped sample, the list
              cannot be presented as the group's membership — the count above is the contract's true
              figure and this says which of the two the reviewer is looking at. */}
          {sampleOnly && (
            <li
              data-testid="destination-members-partial"
              className="pt-1 text-xs text-on-inset-muted"
            >
              This run recorded only these {members.length} of the group&rsquo;s{" "}
              {group.nMembers} variables, so the rest are not listed here.
            </li>
          )}
          {members.length === 0 && (
            <li className="text-xs text-on-inset-muted">
              Nothing is in this group right now.
            </li>
          )}
        </ul>
      )}
    </MemberDropZone>
  );
}

/**
 * The other groups, alongside an expanded one, as live drop destinations (08-16c Task 6).
 *
 * Bhargav: *"when a group is expanded, it's hard to see what other groups there are to drag vars to. the
 * rest of the groups should show up on the right hand side of the screen in a sidebar (~1/3 of the screen)
 * so it's easier to drag from the main group under consideration to any group in the scrollable sidebar."*
 *
 * THIS IS A SECOND SITE FOR DESTINATIONS THAT ALREADY EXIST, NOT A SECOND DRAG SYSTEM. Nothing about
 * MOVING a variable was missing: `MemberDropZone` wraps every collapsed `LedgerRow` and is wired to
 * `moveMember`. What was missing is that expanding one group pushes every other group's drop zone off the
 * viewport, so the affordance was real and unreachable at the exact moment it was wanted. Each entry here
 * is the SAME `MemberDropZone` taking the SAME handler the collapsed row takes — two drop paths is how
 * "your moves are saved as you make them" quietly stops being true on one of them.
 *
 * IT SCROLLS ON ITS OWN. `max-h` + `overflow-y-auto` on this column only, so reaching a distant
 * destination does not scroll the source grid out from under the drag.
 *
 * AND IT HAS ITS OWN SEARCH (08-16c review). Bhargav: *"mini search bar here so user doesnt have to
 * scroll if there are a lot of groups to pick from."* A real run carries 54 groups, so the destination
 * list is a long scroll at exactly the moment the reviewer is holding a variable.
 *
 * IT IS NOT `TermSearch`, AND THE TWO ARE NOT SHARED. The ledger's search takes a LIST of terms and
 * reports a term that matches nothing as a COVERAGE FINDING about the run — "nothing here measures
 * smoking" — which is a claim about the corpus. This one answers "where is the group I want to drop this
 * into", and a miss here means the reviewer typed a name that is not among the destinations, which is not
 * a finding about anything. One control serving both questions would have to lie about one of them.
 *
 * A PLAIN SUBSTRING MATCH over the label already on screen, deliberately: the reviewer is reading these
 * entries as they type, so the rule has to be the one they can see working.
 *
 * THE EXPANDED GROUP IS NOT IN THE LIST. Dropping a member into the group it is already in is not a move,
 * and offering it would report one.
 */
function DestinationTray({
  groups,
  membersOf,
  sampleOnly,
  fieldIndex,
  onMove,
  heading = "Move to another group",
  label = "Other groups — drop a variable to move it there",
}: {
  groups: ConceptGroup[];
  /**
   * The tray's own eyebrow, and its accessible name. NAMEABLE SINCE 08-16c's ITEM A, because the pool
   * renders the same tray and "another group" would be false there: a variable in the pool is in NO
   * group, so there is no other one for it to move to. The component is shared and the WORD is not —
   * copying the component to change three words is how two drag paths start to drift.
   */
  heading?: string;
  label?: string;
  /** A destination's membership after the reviewer's moves — read, never recomputed here. */
  membersOf: (groupId: string) => string[];
  /** Whether that membership is only the capped sample this run recorded. */
  sampleOnly: (group: ConceptGroup) => boolean;
  fieldIndex: Record<string, FieldDetail>;
  onMove: (memberId: string, toGroupId: string) => void;
}) {
  // LOCAL STATE, AND THAT IS CORRECT HERE. R6's "derive, never remember" governs DECISIONS — a scope, a
  // rename, a move — because those have to survive a reload. A filter over a list is not a decision; it is
  // where the reviewer is looking right now, and persisting it would restore a narrowed tray to someone
  // who had forgotten they narrowed it. Same reasoning as `TermSearch`'s own state.
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  // Matched against the label the entry actually SHOWS, so the rule is the one the reviewer can see
  // working. `groupLabel` is the same function the entry renders with, so the two cannot disagree.
  const shown = needle
    ? groups.filter((g) => groupLabel(g).text.toLowerCase().includes(needle))
    : groups;
  return (
    <aside
      data-testid="destination-tray"
      aria-label={label}
      className="flex min-w-0 flex-col gap-2"
    >
      <span className="text-sm font-semibold text-on-raised">
        {heading}
      </span>
      <input
        type="search"
        data-testid="tray-search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Filter ${groups.length} destinations`}
        aria-label="Filter the destination groups by name"
        className="min-h-8 w-full rounded-inner border border-rule-control-on-raised bg-surface-raised px-2 py-1 text-xs text-on-raised"
      />
      <div className="flex max-h-[32rem] min-w-0 flex-col gap-1 overflow-y-auto pr-1">
        {/* A FILTER THAT MATCHES NOTHING SAYS SO. An empty box under a heading reading "Move to another
            group" is indistinguishable from "there are no other groups" — which is the state Task 6
            exists to deny — so the reason is stated and the way out is named. */}
        {shown.length === 0 && (
          <p
            data-testid="tray-search-empty"
            className="text-xs text-on-raised-muted"
          >
            No destination matches &ldquo;{filter.trim()}&rdquo;. Clear the
            filter to see all {groups.length}{" "}
            {groups.length === 1 ? "group" : "groups"} again — they are all
            still there, and all still take a drop.
          </p>
        )}
        {shown.map((g) => (
          <DestinationEntry
            key={g.groupId}
            group={g}
            members={membersOf(g.groupId)}
            sampleOnly={sampleOnly(g)}
            fieldIndex={fieldIndex}
            onMove={onMove}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * THE ONE POOL OF UNPLACED VARIABLES — and, since 08-16c's item A, A GROUP LIKE ANY OTHER.
 *
 * Bhargav asked for the "IN NO GROUP" idea to be centralised, and the state it replaces is worth naming
 * because it was two half-answers rather than one:
 *
 *  1. Each EXPANDED GROUP had its own list, filtered to the variables that had STARTED in that group. So
 *     one conceptual place had 54 renderings, and a variable pulled out of group A could not be seen —
 *     let alone recovered — from group B.
 *  2. The clustering's OWN leftovers (`result.unassignedFields`) were rendered once, in a section gated
 *     on `groups.length === 0`. On every run that produced groups they were simply unreachable.
 *
 * ONE SECTION NOW HOLDS BOTH, and it is a HOLDING AREA rather than a bin: every entry is draggable back
 * into any group, so nothing here is a one-way exclusion. The copy says that instead of the old flat
 * "it will not be matched against a common data element", which described a finality the screen never had.
 *
 * IT OPENS LIKE A LEDGER ROW, AND THAT IS A FIX RATHER THAN A PREFERENCE (item A). Bhargav: *"this should
 * operate the same way as any other group - dropdown with full rows and sidebar with groups to be dragged
 * to."* The flat chip list it replaces had a MEASURED defect: a native HTML5 drag CANNOT BEGIN FROM AN
 * OFF-VIEWPORT SOURCE, and with a group expanded the pool sat below the whole ledger — zero drag events
 * fired and `elementFromPoint` at a chip's centre returned `null`. The only destinations were the ledger
 * rows, a scroll-length away. Giving the pool a group's own shape — a disclosure onto the evidence grid,
 * and its own `DestinationTray` beside it — makes dragging out an ORDINARY between-groups drag over a few
 * hundred pixels, so the limitation dissolves rather than being worked around.
 *
 * THE KEYBOARD PATH STAYS REGARDLESS. This screen holds that a drag with no keyboard equivalent is a
 * regression, not a simplification, and that does not stop being true because the drag got easier. It is
 * now the grid's own row verb (`SourceRowsDrag.action`, kind `restore`) rather than a button beside a
 * chip, which is the same place a group's row verb lives.
 *
 * THE COUNT DOES NOT GO BEHIND THE DISCLOSURE. What is parked outside every group is part of what the
 * reviewer is deciding when they buy assignment for the rest, so the total and both origin counts stay on
 * screen closed; only the LISTING is what opening reveals.
 *
 * THE TWO ORIGINS ARE LABELLED AND NEVER MERGED. This is the load-bearing constraint, not presentation:
 * "you took this out" is the reviewer's own decision, "the clustering never placed this" is a property of
 * the run. One undifferentiated list would report the pipeline's leftovers as the reviewer's doing — and
 * on a run where the clustering dropped 300 variables it would read as 300 corrections nobody made. They
 * are two sections, each counted, each saying whose doing it is. `data-moved` on the rows and chips
 * carries the same distinction to anything reading the DOM. It is also why the leftovers get NO put-back:
 * they were never in a group, so there is nowhere to put them back TO.
 *
 * IT IS ITSELF A DROP TARGET, on the same `UNASSIGNED_GROUP_ID` as the in-row door, so the two are one
 * destination reached from two places rather than two code paths that could drift.
 */
// Above this many variables the pool needs a search: the pipeline half can be thousands, and SourceRows
// caps the DOM at 100 rows, so without search a specific variable past the cap is unreachable in-app.
const POOL_SEARCH_MIN = 12;

function UnassignedPool({
  reviewerRemoved,
  fromPipeline,
  destinations,
  membersOf,
  sampleOnly,
  fieldIndex,
  onMove,
  onRestoreMember,
  readOnly = false,
  defaultOpen = false,
}: {
  /** Variables the REVIEWER took out of a group — reversible by putting them back. */
  reviewerRemoved: string[];
  /** Variables the CLUSTERING never placed, minus any the reviewer has since placed. */
  fromPipeline: UnassignedField[];
  /** The groups a variable here can be dragged into — the same visible, ordered set a group's tray gets. */
  destinations: ConceptGroup[];
  /** A destination's membership after the reviewer's moves — read, never recomputed here. */
  membersOf: (groupId: string) => string[];
  /** Whether that membership is only the capped sample this run recorded. */
  sampleOnly: (group: ConceptGroup) => boolean;
  fieldIndex: Record<string, FieldDetail>;
  onMove: (memberId: string, toGroupId: string) => void;
  /** Undo ONE reviewer removal, returning that variable to the group it came from. */
  onRestoreMember: (memberId: string) => void;
  /** A passed gate is a record: the pool is still readable, but nothing here can be moved. */
  readOnly?: boolean;
  /**
   * OPEN FROM THE START, on a run where this is the only thing on the screen.
   *
   * Found by a test the disclosure broke, and it is a real one rather than a fixture detail. On a run
   * where the clustering placed NOTHING, the ledger's empty state says *"Every variable was left
   * unassigned by the clustering — N variables, listed below"* — a promise the screen then has to keep.
   * A collapsed pool makes that copy false, and it hides the only evidence the reviewer has for the
   * finding it is reporting. With groups on screen the pool is one section among many, exactly like a
   * ledger row, and closed is right; with no groups it IS the screen.
   */
  defaultOpen?: boolean;
}) {
  /**
   * THE REVIEWER'S CHOICE, OR — UNTIL THEY MAKE ONE — THE DEFAULT, RE-READ EVERY RENDER.
   *
   * `useState(defaultOpen)` is what this was, and it was WRONG in a way only a test caught. The initial
   * value of `useState` is captured at MOUNT, and this component mounts on the stream's opening frame —
   * when the run has delivered no groups yet, so `defaultOpen` is momentarily true for every run. It
   * latched open and stayed open once the 54 groups arrived. (The early `return null` below does not save
   * it: a component returning null is still mounted, and its hooks have already run.)
   *
   * A THIRD STATE FIXES IT HONESTLY. `null` means "the reviewer has not said", and the default is then
   * derived from the data on every render rather than remembered from the worst possible moment. The
   * moment they open or close it, their choice outranks the default and keeps outranking it.
   */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? defaultOpen;
  const total = reviewerRemoved.length + fromPipeline.length;
  /**
   * THE POOL SEARCH — filter BEFORE the render cap, not after.
   *
   * `SourceRows` caps the DOM at 100 rows; the pipeline half can be thousands. Filtering here, upstream of
   * that cap, is what lets a reviewer find a specific variable (drag "Country of birth" onto its group)
   * that would otherwise sit at row 5000, unreachable. The haystack is the same text the evidence grid
   * shows — cohort, variable name, the run's text, and any description/question the fieldIndex carries.
   */
  const [poolQuery, setPoolQuery] = useState("");
  const q = poolQuery.trim().toLowerCase();
  // Token-AND, not a single substring: a reviewer typing "country of birth" must match a variable named
  // `country_of_birth` (underscores) whose text reads "In what country were you born?" — no contiguous
  // "country of birth" exists in either. Requiring every query WORD to appear keeps that forgiving while
  // still excluding rows that miss any term.
  const queryTokens = q.split(/\s+/).filter(Boolean);
  const poolMatches = (
    cohort: string,
    variable: string,
    text: string | undefined,
    detail: FieldDetail | undefined,
  ) => {
    if (!queryTokens.length) return true;
    const hay = [cohort, variable, text ?? "", detail?.description ?? "", detail?.questionText ?? ""]
      .join(" ")
      .toLowerCase();
    return queryTokens.every((tok) => hay.includes(tok));
  };
  const filteredReviewer = q
    ? reviewerRemoved.filter((id) => {
        const { cohort, variable } = memberParts(id, fieldIndex);
        return poolMatches(cohort, variable, undefined, fieldIndex[id]);
      })
    : reviewerRemoved;
  const filteredPipeline = q
    ? fromPipeline.filter((f) =>
        poolMatches(f.cohort, f.variable, f.text, fieldIndex[`${f.cohort}:${f.variable}`]),
      )
    : fromPipeline;
  /**
   * The leftovers as the grid's own shape. `UnassignedField` carries the run's text for a variable the
   * clustering dropped, and `SourceRows` already accepts that as `memberDetails` — so a run whose
   * `fieldIndex` covers these rows renders them as full evidence, and one whose does not falls back to
   * chips by the grid's OWN test rather than by a second guess here.
   */
  const pipelineIds = filteredPipeline.map((f) => `${f.cohort}:${f.variable}`);
  const pipelineDetails = filteredPipeline.map((f) => ({
    id: `${f.cohort}:${f.variable}`,
    cohort: f.cohort,
    name: f.variable,
    text: f.text,
  }));
  // Every variable in the reviewer's half is there BECAUSE they moved it — the you-changed-it register is
  // the whole half, not a subset of it.
  const movedHere = new Set(filteredReviewer);
  // Asked of the same expression the grid itself uses, so the two cannot drift — the rule `ExpandedGroup`
  // already follows. A grid that declines to render would otherwise leave a section with no members in it.
  const reviewerGrid = hasSourceRows(filteredReviewer, undefined, fieldIndex);
  const pipelineGrid = hasSourceRows(pipelineIds, pipelineDetails, fieldIndex);
  const showTray = !readOnly && destinations.length > 0;
  const showSearch = total > POOL_SEARCH_MIN;
  const noMatches = q.length > 0 && filteredReviewer.length === 0 && filteredPipeline.length === 0;
  if (total === 0) return null;
  return (
    <MemberDropZone
      groupId={UNASSIGNED_GROUP_ID}
      label="Variables in no group"
      onDropMember={(memberId) => onMove(memberId, UNASSIGNED_GROUP_ID)}
      className="flex-col items-start gap-3 rounded-card border-none bg-surface-raised px-6 py-4 shadow-card"
    >
      <Collapsible open={open} onOpenChange={setChosen} asChild>
        <div
          data-testid="unassigned-pool"
          className="flex w-full flex-col gap-3"
        >
          <div className="flex w-full flex-wrap items-baseline gap-2">
            <h2 className="text-sm font-semibold text-on-raised">
              In no group
            </h2>
            {/* THE COUNT, where a reviewer meets it on the way to Continue — what is parked outside every
                group is part of what they are deciding when they buy assignment for the rest. It stays
                OUTSIDE the disclosure for that reason: closing the pool must not close the figure. */}
            <span
              data-testid="pool-count"
              className="font-mono text-xs tabular-nums text-on-raised"
            >
              {total}
            </span>
            <span className="text-xs text-on-raised-muted">
              {total === 1 ? "variable is" : "variables are"} in no group, so
              nothing will be matched for
              {total === 1 ? " it" : " them"} at Gate 2. Open this to read
              {total === 1 ? " it" : " them"} and drag
              {total === 1 ? " it" : " them"} back onto a group.
            </span>
            <CollapsibleTrigger
              // An icon-only control names the ACTION AND ITS OBJECT, exactly as a ledger row's does.
              aria-label={`${open ? "Collapse" : "Expand"} the variables in no group`}
              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-on-raised-muted"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-4 w-4 transition-transform",
                  open && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
          </div>

          <CollapsibleContent>
            {/* THE POOL SEARCH — mirrors the ledger's own search affordance. Filtering happens upstream of
                the 100-row render cap, so a match past the cap still surfaces and stays draggable. */}
            {showSearch && (
              <div className="relative mb-3">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-raised-muted"
                />
                <input
                  type="search"
                  data-testid="pool-search"
                  value={poolQuery}
                  onChange={(e) => setPoolQuery(e.target.value)}
                  placeholder="Search these variables — name, description, question or cohort"
                  aria-label="Search the variables in no group"
                  className="w-full rounded-md border border-rule-on-raised bg-surface-inset py-1.5 pl-7 pr-2 text-xs text-on-raised placeholder:text-on-raised-faint"
                />
              </div>
            )}
            {noMatches && (
              <p data-testid="pool-no-matches" className="mb-3 text-xs text-on-raised-muted">
                No variable in this pool matches &ldquo;{poolQuery.trim()}&rdquo;.
              </p>
            )}
            {/*
              TWO COLUMNS ONLY WHEN THERE IS A TRAY, and only above `lg` — the same rule, and the same
              tracks, as an expanded group's body. `minmax(0,…)` on BOTH is what stops the evidence grid
              forcing the page into horizontal overflow.
            */}
            <div
              data-testid="pool-body"
              className={cn(
                "flex w-full flex-col gap-3",
                showTray &&
                  "lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start lg:gap-4",
              )}
            >
              <div className="flex min-w-0 flex-col gap-3">
                {filteredReviewer.length > 0 && (
                  <section
                    data-testid="pool-reviewer"
                    className="flex min-w-0 flex-col gap-1"
                  >
                    <h3 className="text-xs font-semibold text-on-raised">
                      You took these out{" "}
                      <span className="font-mono font-normal tabular-nums text-on-raised-muted">
                        {filteredReviewer.length}
                        {q ? ` of ${reviewerRemoved.length}` : ""}
                      </span>
                    </h3>
                    {reviewerGrid ? (
                      <SourceRows
                        memberIds={filteredReviewer}
                        fieldIndex={fieldIndex}
                        drag={
                          readOnly
                            ? undefined
                            : {
                                groupId: UNASSIGNED_GROUP_ID,
                                label: "Variables you took out of a group",
                                onDropMember: (memberId) =>
                                  onMove(memberId, UNASSIGNED_GROUP_ID),
                                // THE ROW VERB HERE IS THE OPPOSITE ONE. It UNDOES rather than choosing a
                                // destination: the regroup decision is cleared, so the variable returns to
                                // the group it came from. No picker, and nothing invented — the origin is
                                // the one destination that needs no decision from the reviewer.
                                action: {
                                  kind: "restore",
                                  onAct: onRestoreMember,
                                },
                                movedMembers: movedHere,
                              }
                        }
                      />
                    ) : (
                      /* The grid declined — this run carries no descriptive field for these variables — so
                         the chips are the whole membership view, and the put-back comes back with them. */
                      <div className="flex flex-wrap gap-1">
                        {filteredReviewer.map((memberId) => {
                          const { cohort, variable } = memberParts(
                            memberId,
                            fieldIndex,
                          );
                          return (
                            <span
                              key={memberId}
                              className="inline-flex max-w-full items-center gap-1"
                            >
                              <MemberChip
                                memberId={memberId}
                                cohort={cohort}
                                variable={variable}
                                draggable={!readOnly}
                                moved
                              />
                              {!readOnly && (
                                <button
                                  type="button"
                                  data-testid="pool-put-back"
                                  data-member-id={memberId}
                                  aria-label={`Put ${variable} back in the group it came from`}
                                  title="Put this back in the group it came from"
                                  onClick={() => onRestoreMember(memberId)}
                                  className="shrink-0 rounded p-1 text-on-raised-muted hover:text-accent-on-raised"
                                >
                                  <Undo2
                                    aria-hidden="true"
                                    className="h-3 w-3"
                                  />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </section>
                )}

                {filteredPipeline.length > 0 && (
                  <section
                    data-testid="pool-pipeline"
                    className="flex min-w-0 flex-col gap-1"
                  >
                    <h3 className="text-xs font-semibold text-on-raised">
                      The clustering never placed these{" "}
                      <span className="font-mono font-normal tabular-nums text-on-raised-muted">
                        {filteredPipeline.length}
                        {q ? ` of ${fromPipeline.length}` : ""}
                      </span>
                    </h3>
                    {/* NOT the reviewer's doing, and said so: these fell out of the clustering, which is a
                        fact about the run. `data-moved="false"` on each row carries the same distinction
                        in the DOM.

                        NO ROW VERB HERE, and the asymmetry is the honest one: these were never in a group,
                        so there is nowhere to put them back TO. They are placed by dragging them onto a
                        group, which is a choice only the reviewer can make. */}
                    {pipelineGrid ? (
                      <SourceRows
                        memberIds={pipelineIds}
                        memberDetails={pipelineDetails}
                        fieldIndex={fieldIndex}
                        drag={
                          readOnly
                            ? undefined
                            : {
                                groupId: UNASSIGNED_GROUP_ID,
                                label: "Variables the clustering never placed",
                                onDropMember: (memberId) =>
                                  onMove(memberId, UNASSIGNED_GROUP_ID),
                                movedMembers: EMPTY_MEMBERS,
                              }
                        }
                      />
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {filteredPipeline.map((f) => {
                          const memberId = `${f.cohort}:${f.variable}`;
                          return (
                            <li
                              key={memberId}
                              className="flex min-w-0 flex-wrap items-baseline gap-2"
                            >
                              <MemberChip
                                memberId={memberId}
                                cohort={f.cohort}
                                variable={f.variable}
                                draggable={!readOnly}
                              />
                              {/* The run's own text for the variable — what makes "should this have been
                                  grouped?" answerable without leaving the screen. */}
                              <span className="min-w-0 text-xs text-on-raised-muted">
                                {f.text}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                )}
              </div>

              {showTray && (
                <DestinationTray
                  groups={destinations}
                  membersOf={membersOf}
                  sampleOnly={sampleOnly}
                  fieldIndex={fieldIndex}
                  onMove={onMove}
                  // "ANOTHER group" would be false here: a variable in the pool is in no group at all.
                  heading="Put it in a group"
                  label="Groups — drop a variable to put it in one"
                />
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </MemberDropZone>
  );
}

/** No row in the pipeline half is the reviewer's doing, so the moved register there is empty — and one
 *  frozen Set is allocated once rather than on every render. */
const EMPTY_MEMBERS: ReadonlySet<string> = new Set<string>();

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
  otherGroups,
  membersOf,
  sampleOnly,
  members,
  poolCount,
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
  carveKeyField,
  highlightIds,
  divisionParts = [],
  onUndoDivision,
}: {
  group: ConceptGroup;
  /** The parts this group was divided into when the reviewer accepted its division (08-28 follow-up #1). */
  divisionParts?: ConceptGroup[];
  onUndoDivision?: () => void;
  /** Every OTHER group, as drop destinations beside this one (08-16c Task 6). */
  otherGroups: ConceptGroup[];
  /** A destination group's membership after the reviewer's moves — for the tray's members list. */
  membersOf: (groupId: string) => string[];
  /** Whether a destination group's membership is only the capped sample this run recorded. */
  sampleOnly: (group: ConceptGroup) => boolean;
  /** The group's membership AFTER the reviewer's moves — uncapped. */
  members: string[];
  /** How many variables are in the shared pool — what the door reports, not a per-group slice. */
  poolCount: number;
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
  /** The inline key field, after the server refused this group's division for want of a BYOK key (08-28). */
  carveKeyField?: React.ReactNode;
  /** The score builder's matched variables, when this group was opened from the score panel. */
  highlightIds?: ReadonlySet<string>;
}) {
  const [ignored, setIgnored] = useState(false);
  const emptied = canRegroup && members.length === 0;
  // DIVIDED: the reviewer accepted the judge's division and every variable went to its parts. Said as that, not
  // as "you moved every variable out" — and the proposal is gone, because it has been acted on.
  const divided = emptied && divisionParts.length > 0;
  // Does the evidence grid render for this group? If it does it IS the membership view and the tile strip
  // is redundant; if it does not, the chips are the only thing standing between the reviewer and a group
  // with no visible members. Asked of the same expression the grid itself uses, so the two cannot drift.
  const gridCarriesMembers = hasSourceRows(members, undefined, fieldIndex);

  const showTray = canRegroup && otherGroups.length > 0;
  return (
    /*
      TWO COLUMNS ONLY WHEN THERE IS A TRAY, and only above `lg`. Below that the tray gives way and stacks
      rather than squeezing the seven-column source grid — the grid is already at `min-width: 0` on its
      track, so taking a third of a narrow viewport away from it is what would make the evidence
      unreadable. `minmax(0,…)` on BOTH tracks is what stops the grid forcing horizontal overflow.
    */
    <div
      className={cn(
        "flex flex-col gap-3",
        showTray &&
          "lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start lg:gap-4",
      )}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {!canRegroup ? (
          /* T-08-89 MADE MECHANICAL. This run carries only a capped SAMPLE of this group's members, so the
           screen cannot see past the cap — and a move written against a partial list would silently drop
           every member it never showed. The verb is withdrawn and the reason is stated, rather than the
           move being offered over an incomplete list. */
          <NotAvailable thing="Moving variables in this group" claim="failed">
            This run recorded only the first {members.length} of its{" "}
            {group.nMembers} variables for this group, so the rest are not on
            this screen. Moving one now would quietly drop the ones you cannot
            see, so the move is withheld rather than offered over a partial
            list. The variables below are the sample that was recorded.
          </NotAvailable>
        ) : divided ? (
          /* AN ACCEPTED DIVISION. The parts are New groups of the reviewer's, listed at the top of the queue and in
           scope; this group keeps its row so the change stays visible and can be undone in one step. */
          <div
            data-testid="group-divided"
            className="flex flex-col gap-2 rounded-inner border-l-4 border-l-accent-action bg-surface-inset px-4 py-3"
          >
            <p className="text-sm font-semibold text-on-inset">
              You accepted the division of this group into {divisionParts.length} parts.
            </p>
            <ul className="list-disc pl-5 text-sm text-on-inset">
              {divisionParts.map((p) => (
                <li key={p.groupId}>
                  {p.concept}{" "}
                  <span className="text-on-inset-muted">
                    ({p.nMembers} {p.nMembers === 1 ? "variable" : "variables"})
                  </span>
                </li>
              ))}
            </ul>
            <p className="max-w-[80ch] text-sm text-on-inset-muted">
              Each part is now a group of its own, at the top of the list (sent
              to Gate 2 unless you untick it): there it is matched and gets an
              ideal description of its own. This group is empty, so it will not go
              on to Gate 2.
            </p>
            {onUndoDivision && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={onUndoDivision}>
                  Undo the division
                </Button>
              </div>
            )}
          </div>
        ) : emptied ? (
          /* THE LAST VARIABLE LEFT. The row must NOT silently vanish — a reviewer has to be able to see what
           they did and undo it, and a group that disappeared on the move it was emptied by is a change
           with no visible consequence. */
          <div
            data-testid="group-emptied"
            className="flex flex-col gap-2 rounded-inner border-l-4 border-l-accent-action bg-surface-inset px-4 py-3"
          >
            <p className="text-sm font-semibold text-on-inset">
              You moved every variable out of this group.
            </p>
            <p className="max-w-[80ch] text-sm text-on-inset-muted">
              It is empty, so it will not go on to Gate 2 and nothing will be
              matched for it. The row stays here so you can see the change and
              undo it.
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRestore}
              >
                Put them back
              </Button>
            </div>
          </div>
        ) : null}

        {/* THE COHERENCE JUDGEMENT — ABOVE the evidence rows (mockup parity). For a flagged group this is the
          judge's carve proposal with its accept / edit / ignore action; for the rest it is the judge's read,
          stated plainly so an unjudged group never reads as one the judge approved. */}
        {isFlagged(group) && !ignored && !divided && (
          <div className="flex flex-col gap-2">
            <CarveProposal
              state={group.coherence}
              subConcepts={group.coherenceDistinctValues.map((label, i) => ({
                id: `${group.groupId}#sub${i}`,
                label,
              }))}
              axis={group.coherenceAxis || undefined}
              summary={group.coherenceSummary || undefined}
              readjudicationEnabled={refusal === null}
              notAvailable={
                refusal && (
                  <NotAvailable
                    thing="Accepting the division"
                    claim={refusal.claim}
                    className="bg-surface-raised"
                  >
                    {refusal.reason}
                  </NotAvailable>
                )
              }
              acceptPrice={carvePrice}
              accepting={accepting}
              acceptGroupIds={readjudicationRequest(group.groupId).groupIds}
              keyField={carveKeyField}
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
            Proposal ignored — the grouping is unchanged. The judge&rsquo;s flag
            stays on the row, because ignoring a proposal is not the same as
            resolving what it was about.
          </p>
        )}
        {/* QUALIFY is advisory, not flagged — so it never reached CarveProposal and its axis/KINDS went
          unshown (the gap Bhargav caught). It gets the SAME finding block, in advisory mode: the blue
          eyebrow, the theme sentence, the "Axis of difference" line and the KIND pills, but none of the
          split's accept/edit/ignore machinery, because there is no proposed division to act on. */}
        {!isFlagged(group) && group.coherence === "qualify" && (
          <CarveProposal
            state={group.coherence}
            advisory
            subConcepts={group.coherenceDistinctValues.map((label, i) => ({
              id: `${group.groupId}#sub${i}`,
              label,
            }))}
            axis={group.coherenceAxis || undefined}
            summary={group.coherenceSummary || undefined}
            readjudicationEnabled={false}
          />
        )}
        {!isFlagged(group) && group.coherence === "not_judged" && (
          <div
            data-testid="coherence-finding"
            className="rounded-inner border-l-4 border-l-rule-on-inset bg-surface-inset px-4 py-3"
          >
            <p className="text-sm font-semibold text-on-inset">Not judged</p>
            <p className="mt-0.5 max-w-[80ch] text-sm text-on-inset-muted">
              Groups under six variables are not sent to the coherence judge —
              silence here is &ldquo;not asked&rdquo;, not &ldquo;passed&rdquo;.
            </p>
          </div>
        )}
        {/* A CHECKED group that trips the $0 template detector is COHERENT BUT PROBABLY A BATTERY (Bhargav:
          coherent ≠ harmonizable — a symptom scale is one concept but many items, and won't collapse to one
          CDE). Show the amber caution instead of the reassuring green, so it is not waved through to Gate 2.
          The copy keeps the judge's verdict honest and marks this as a separate pattern check. */}
        {!isFlagged(group) &&
          group.coherence === "single" &&
          group.matrixSuspect && (
            <div
              data-testid="coherence-finding"
              data-battery-suspect="true"
              className="rounded-inner border-l-4 border-l-status-warn bg-surface-warn px-4 py-3"
            >
              <p className="text-sm font-semibold text-on-warn">
                Checked — but likely a battery
              </p>
              <p className="mt-1 max-w-[80ch] text-sm text-on-warn">
                The judge read these variables together and called them one
                coherent concept — and along one axis they are. But a separate
                $0 check sees a repeating question template with different
                fillers, which usually means a multi-item battery (a symptom
                scale, say), not a single variable. A battery rarely collapses
                to one CDE: split it into items, or route it to a
                scale/composite at Gate 2. This is a pattern check, not the
                coherence judge.
              </p>
            </div>
          )}
        {!isFlagged(group) &&
          group.coherence === "single" &&
          !group.matrixSuspect && (
            <div
              data-testid="coherence-finding"
              className="rounded-inner border-l-4 border-l-status-ok bg-surface-ok px-4 py-3"
            >
              <p className="text-sm font-semibold text-on-ok">Checked</p>
              <p className="mt-0.5 max-w-[80ch] text-sm text-on-ok">
                The judge read this group&rsquo;s variables together and found a
                single coherent concept.
              </p>
            </div>
          )}

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
            onDropMember={
              canRegroup
                ? (memberId) => onMove(memberId, group.groupId)
                : undefined
            }
          >
            {members.map((memberId) => {
              const { cohort, variable } = memberParts(memberId, fieldIndex);
              return (
                <MemberChip
                  key={memberId}
                  memberId={memberId}
                  cohort={cohort}
                  variable={variable}
                  moved={movedMembers.has(memberId)}
                  draggable={canRegroup}
                />
              );
            })}
          </MemberList>
        )}

        {canRegroup && (
          <p className="text-xs text-on-raised-muted">
            Drag a {gridCarriesMembers ? "row" : "variable"} onto a group in the
            list on the left to move it there, or onto &ldquo;In no group&rdquo;
            to take it out of every group.
            {gridCarriesMembers &&
              " Without a mouse, use the × beside a row's drag handle to take that variable out of this group."}{" "}
            Your moves are saved as you make them.
          </p>
        )}

        {/*
        THE DOOR ONTO THE POOL — a real destination with its own identifier, not a sentinel special-cased
        at each call site, which is what lets "take this out of every group" be the same verb as "put it
        in that one" rather than a second code path.

        IT NO LONGER LISTS ANYTHING (08-16c review). It used to render the variables that had started in
        THIS group and were now out, which made one conceptual place have 54 renderings — a variable
        pulled out of group A was invisible from group B, and the clustering's own leftovers appeared in
        none of them. The list now lives once, in `UnassignedPool` below the ledger; this stays because
        the GESTURE needs a target within reach while a group is open. So it reports the shared pool's
        size rather than a per-group slice of it.
      */}
        {canRegroup && (
          <MemberDropZone
            groupId={UNASSIGNED_GROUP_ID}
            label="Take a variable out of every group"
            onDropMember={(memberId) => onMove(memberId, UNASSIGNED_GROUP_ID)}
            className="bg-surface-inset"
          >
            <span className="w-full text-sm font-semibold text-on-inset">
              In no group
              {poolCount > 0 && (
                <span className="ml-2 font-mono normal-case tracking-normal">
                  {poolCount}
                </span>
              )}
            </span>
            <span className="text-xs text-on-inset-muted">
              Drop a variable here to take it out of every group. It goes to the
              pool below the ledger, where you can read it and drag it back into
              any group.
            </span>
          </MemberDropZone>
        )}

        {/* THE EVIDENCE LAYER (lifted from the workbench by the 2026-08-31 inherited-UI audit). The judgement
          this screen asks for — is this really one concept? — is made against the dictionary rows, and
          asking it from a generated name and a row of chips leaves them a screen away. Returns null when
          the run carries no field detail, in which case the chips above are the whole membership view. */}
        {highlightIds && highlightIds.size > 0 && (
          <p data-testid="score-highlight-note" role="note" className="text-xs text-on-raised-muted">
            Highlighted: the {highlightIds.size} {highlightIds.size === 1 ? "variable" : "variables"} the score
            matched for this group.
          </p>
        )}
        <SourceRows
          memberIds={members}
          fieldIndex={fieldIndex}
          highlightIds={highlightIds}
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
                  // In a GROUP the row verb takes the variable OUT of it. The pool's own grid names the
                  // opposite verb from the same register — see `SourceRowsDrag.action`.
                  action: {
                    kind: "remove",
                    onAct: (memberId) => onMove(memberId, UNASSIGNED_GROUP_ID),
                  },
                  movedMembers,
                }
              : undefined
          }
        />

        {/* The coherence finding used to render HERE, below the rows; it now leads the pane (above the rows),
          see the CoherenceFinding block near the top of this column. */}
      </div>
      {showTray && (
        <DestinationTray
          groups={otherGroups}
          membersOf={membersOf}
          sampleOnly={sampleOnly}
          fieldIndex={fieldIndex}
          onMove={onMove}
        />
      )}
    </div>
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
  nIdeals = 0,
  idealsUsd = 0,
}: {
  realized: number;
  inScopeTotal: number;
  wholeCorpus: number;
  nInScope: number;
  nGroups: number;
  /** How many of the groups sent buy a generated ideal (New or reshaped), and what those calls cost. */
  nIdeals?: number;
  idealsUsd?: number;
}) {
  // SAID ONCE, BRIEFLY (review round 1 on the live build: "verbose and redundant"). The lab's footer register —
  // "N ticked · $X to match them at Gate 2" — for the purchase; the realized spend first and in its own weight;
  // the whole-corpus comparison only while it differs from the purchase, since "all 55 would be $0.61" under
  // "55 of 55 · $0.61" says the same number twice.
  return (
    <div data-testid="sum-block" className="flex flex-col gap-0.5">
      <p data-sum-line="realized" className="text-sm font-semibold text-on-raised">
        Spent so far:{" "}
        {realized > 0 ? (
          <span className="font-mono tabular-nums">{formatUsd(realized)}</span>
        ) : (
          "nothing — a saved replay"
        )}
      </p>
      <p data-sum-line="in-scope" className="text-sm font-normal text-on-raised">
        {nInScope} of {nGroups} {nGroups === 1 ? "group" : "groups"} ticked ·{" "}
        <span className="font-mono tabular-nums">{formatUsd(inScopeTotal)}</span> to match at Gate 2
      </p>
      {nIdeals > 0 && (
        /* Named rather than folded in silently: these are calls the reviewer's own edits bought (a New group has
           no description yet; a reshaped one's was written for other members), so the quote says so. */
        <p data-sum-line="ideals" className="text-xs font-normal text-on-raised-muted">
          {nIdeals} new ideal {nIdeals === 1 ? "description" : "descriptions"} included (
          <span className="font-mono tabular-nums">{formatUsd(idealsUsd)}</span>), for groups you made or changed
        </p>
      )}
      {nInScope < nGroups && (
        <p data-sum-line="whole-corpus" className="text-sm font-normal text-on-raised-faint">
          All {nGroups} {nGroups === 1 ? "group" : "groups"}:{" "}
          <span className="font-mono tabular-nums">{formatUsd(wholeCorpus)}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The State section of the filter menu (08-30b): the four coherence states in triage order, as boxes — tick
 * several, tick none and every state shows, so there is no "All states" entry. Labels come from the one register
 * the row's tag reads (`COHERENCE_COPY`), sentence-cased for a menu.
 */
const STATE_FILTER_ORDER: CoherenceState[] = ["split", "qualify", "not_judged", "single"];

function stateLabel(state: CoherenceState): string {
  const label = COHERENCE_COPY[state].label;
  return label[0].toUpperCase() + label.slice(1);
}

/**
 * ONE ROW IN THE QUEUE (the left sidebar of the unified Gate 1 layout).
 *
 * The scannable half of the workbench+queue synthesis: name, coherence state, cohorts, size and price on
 * one compact two-line row, selectable to open its depth on the right. It is NOT a `LedgerRow` — that was
 * the table cell of the old single-column ledger; this is the master list of a master-detail.
 */
function QueueRow({
  group,
  scoreTag,
  scoreTagSource = "match",
  roster,
  count,
  inScope,
  changed,
  selected,
  readOnly,
  renamedTo,
  reviewer = false,
  query,
  onSelect,
  onScopeChange,
  onDropMember,
}: {
  group: ConceptGroup;
  /** The queue's search, so the row can highlight what it matched in the name (review round 3). */
  query?: string;
  /** The declared-score component(s) this group is matched onto, when the run has a composite — rendered
   *  as a tag and the reason this row is pinned to the top of the queue. */
  scoreTag?: string[];
  /** Where `scoreTag` came from: the Gate 4 MATCH (a verdict), or Gate 1's free SUGGESTION (08-28 Decision 6) —
   *  drawn differently, and saying so, because a suggestion is not a finding that the group measures it. */
  scoreTagSource?: "match" | "suggestion";
  /** A New group the reviewer made (08-28 Wave 2): marked as theirs, never with a coherence cell. */
  reviewer?: boolean;
  /** Every cohort in the run, in its fixed order — the strip's columns, under the queue's one legend. */
  roster: string[];
  count: number;
  inScope: boolean;
  changed: boolean;
  selected: boolean;
  readOnly: boolean;
  renamedTo?: string;
  onSelect: () => void;
  onScopeChange: (inScope: boolean) => void;
  /** Drop a dragged source-row variable onto this row to reassign it into this group (the sidebar IS the
   *  destination list now — the old in-detail "move to another group" tray was removed). */
  onDropMember: (memberId: string) => void;
}) {
  const label = groupLabel(group, renamedTo);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="ledger-row"
      data-group-id={group.groupId}
      data-row-id={group.groupId}
      data-search-label={label.text}
      data-reviewer={reviewer ? "true" : undefined}
      data-spine={
        isFlagged(group) ? "unresolved" : changed ? "changed" : "none"
      }
      aria-current={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      data-drop-over={over ? "true" : undefined}
      onDragOver={
        readOnly
          ? undefined
          : (e) => {
              if (!e.dataTransfer.types.includes(MEMBER_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(true);
            }
      }
      onDragLeave={(e) => {
        // Only clear when the cursor actually leaves the row, not on every child crossing.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={
        readOnly
          ? undefined
          : (e) => {
              e.preventDefault();
              setOver(false);
              const memberId = e.dataTransfer.getData(MEMBER_DRAG_TYPE);
              if (memberId) onDropMember(memberId);
            }
      }
      className={cn(
        "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 border-l-4 px-4 py-2.5 text-left",
        isFlagged(group)
          ? "border-l-status-warn"
          : changed
            ? "border-l-accent-action"
            : "border-l-transparent",
        selected
          ? "bg-surface-info shadow-[inset_3px_0_0_var(--rule-info)]"
          : "hover:bg-surface-inset",
        over &&
          "bg-surface-info [outline:2px_dashed_var(--accent)] [outline-offset:-2px]",
      )}
    >
      <div className="mt-px" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          data-testid="queue-scope"
          checked={inScope}
          disabled={readOnly}
          onCheckedChange={(v) => onScopeChange(v === true)}
          aria-label={`Send ${label.text} to Gate 2`}
        />
      </div>
      {/* THE NAME HAS THE LEFT COLUMN TO ITSELF (08-30b, lab round 5): up to three lines, and a short name makes
          a short row. What is unusual about the group — a score it feeds, a re-split, a template suspicion, an
          outsized membership — still rides under it; the routine facts moved right. */}
      <div className="min-w-0">
        {scoreTag && scoreTag.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1">
            {scoreTag.map((name) =>
              scoreTagSource === "suggestion" ? (
                // A SUGGESTION, drawn by form (dashed) and named as one: a free search reached this group, and the
                // verdict is still Gate 4's. The title carries the whole claim, the face carries "Suggested".
                <span
                  key={name}
                  data-testid="queue-score-tag"
                  data-tag-source="suggestion"
                  className="inline-flex max-w-full items-center gap-1 rounded-pill border border-dashed border-accent-action px-2 py-0.5 text-xs font-semibold text-accent-on-raised"
                  title={`${SUGGESTION_TAG_COPY} (the “${name}” component)`}
                >
                  <Search className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">Suggested · {name}</span>
                </span>
              ) : (
                <span
                  key={name}
                  data-testid="queue-score-tag"
                  data-tag-source="match"
                  className="inline-flex max-w-full items-center gap-1 rounded-pill border border-accent-action px-2 py-0.5 text-xs font-semibold text-accent-on-raised"
                  title={`Matched to the “${name}” component of a declared score`}
                >
                  <Calculator className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{name}</span>
                </span>
              ),
            )}
          </div>
        )}
        <div
          className={cn(
            "line-clamp-3 text-sm font-semibold leading-snug",
            selected ? "text-accent-on-raised" : "text-on-raised",
          )}
          title={label.text}
        >
          <span data-label-source={label.source}>
            <Highlight text={label.text} query={query} mode="word-prefix" />
          </span>
          {label.source === "reviewer" && <RenamedMark />}
          {label.source === "judge" && <BorrowedMark />}
          {changed && !reviewer && (
            <span className="ml-1 text-xs font-normal text-status-warn">
              · edited
            </span>
          )}
        </div>
        {(group.readjudicatedFrom ||
          (group.matrixSuspect && (group.coherence === "not_judged" || group.coherence === "single")) ||
          count >= BIG_GROUP_MIN) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {group.readjudicatedFrom && (
              <ReSplitMark parent={group.readjudicatedFrom} />
            )}
            {group.matrixSuspect &&
              (group.coherence === "not_judged" ||
                group.coherence === "single") && (
                <TemplateSuspicion judged={group.coherence === "single"} />
              )}
            {count >= BIG_GROUP_MIN && <LargeGroupMark count={count} />}
          </div>
        )}
      </div>
      {/* The facts column: cohort strip, then the variable count and the state. The per-row price is gone
          (lab round 2: "repetitive") — the sum block under the list says it once. */}
      <QueueRowFacts
        cohorts={group.cohorts}
        roster={roster}
        vars={count}
        state={reviewer ? <NewGroupMark /> : <CoherenceMark state={group.coherence} variant="tag" />}
      />
    </div>
  );
}

/**
 * "New group" (08-28 Wave 2): a button that opens an inline name field. Enter creates the group; Escape, or an
 * empty name, creates nothing. The group starts empty — the reviewer fills it by dragging variables onto its
 * row, the same verb every other group takes.
 */
function NewGroupControl({ onCreate }: { onCreate: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const finish = (create: boolean) => {
    if (create && draft.trim()) onCreate(draft.trim());
    setDraft("");
    setNaming(false);
  };
  if (!naming) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="new-group"
        onClick={() => setNaming(true)}
        className="w-full justify-start gap-1.5"
      >
        <Plus aria-hidden="true" className="h-4 w-4" />
        New group
      </Button>
    );
  }
  return (
    <input
      autoFocus
      data-testid="new-group-name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      placeholder="Name the new group, then press Enter"
      aria-label="Name the new group"
      className="h-8 w-full rounded-inner border border-rule-control-on-raised bg-surface-raised px-2.5 text-sm text-on-raised placeholder:text-on-raised-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    />
  );
}

/**
 * The detail pane for a NEW group the reviewer made (08-28 Wave 2). Not `GroupDetail` + `ExpandedGroup`: those
 * speak for a group the pipeline formed — its cluster, its judge's verdict, its generated ideal, "you moved
 * every variable out" — and none of that is true of a group the reviewer made. This says what IS true: it is
 * theirs, it holds exactly what they put in it, and what Gate 2 will do with it.
 */
function ReviewerGroupDetail({
  group,
  members,
  fieldIndex,
  movedMembers,
  readOnly,
  inScope,
  onScopeChange,
  onRename,
  onDelete,
  onMove,
  dividedFrom,
}: {
  group: ConceptGroup;
  members: string[];
  fieldIndex: Record<string, FieldDetail>;
  movedMembers: Set<string>;
  readOnly: boolean;
  inScope: boolean;
  onScopeChange: (inScope: boolean) => void;
  onRename: (next: string) => void;
  onDelete: () => void;
  onMove: (memberId: string, toGroupId: string) => void;
  /** For a PART of an accepted division: the display name of the group it was divided out of. */
  dividedFrom?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const count = members.length;
  const gridCarriesMembers = hasSourceRows(members, undefined, fieldIndex);
  const label = `Variables in ${group.concept || group.groupId}`;
  return (
    <div data-testid="new-group-detail" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule-on-raised pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onRename(draft);
                    setEditing(false);
                  }
                  if (e.key === "Escape") setEditing(false);
                }}
                onBlur={() => {
                  onRename(draft);
                  setEditing(false);
                }}
                aria-label="Rename group"
                className="min-w-[18rem] rounded-inner border border-rule-control-on-raised bg-surface-raised px-2 py-1 text-xl font-semibold text-on-raised"
              />
            ) : (
              <h2 data-testid="concept-title" className="text-xl font-semibold leading-tight text-on-raised" title={group.concept}>
                <Highlight text={group.concept} />
              </h2>
            )}
            {!editing && <NewGroupMark />}
            {!editing && group.readjudicatedFrom && <ReSplitMark parent={group.readjudicatedFrom} />}
            {!readOnly && !editing && (
              <button
                type="button"
                data-testid="rename-group"
                aria-label={`Rename ${group.concept}`}
                title="Rename this group"
                onClick={() => {
                  setDraft(group.concept);
                  setEditing(true);
                }}
                className="shrink-0 rounded p-1 text-on-raised-muted hover:text-accent-on-raised"
              >
                <Pencil aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="mt-1.5 text-xs text-on-raised-muted">
            <span className="font-semibold text-on-raised">{count}</span> {count === 1 ? "variable" : "variables"}
            {group.cohorts.length > 0 && <> · {group.cohorts.join(", ")}</>} ·{" "}
            {dividedFrom ? (
              <span data-testid="divided-from">
                divided out of &ldquo;{dividedFrom}&rdquo; when you accepted its division
              </span>
            ) : (
              "made by you"
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-on-raised-muted">
            <input
              type="checkbox"
              checked={inScope}
              disabled={readOnly}
              onChange={(e) => onScopeChange(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            Send to Gate 2
          </label>
          {!readOnly && count === 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="delete-new-group"
              onClick={onDelete}
              className="gap-1.5"
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      <p className="max-w-[80ch] text-sm text-on-raised-muted">
        {count === 0
          ? "It is empty. Drag variables onto its row in the list on the left — from any group, or from “In no group” — to fill it. An empty group does not go on to Gate 2; delete it if you no longer want it."
          : "Drag more variables onto its row in the list on the left to add them, or drag a row here out of it. At Gate 2 ddharmon writes one ideal description for this group — one model call, included in the price — and matches it against common data elements like any other group."}
      </p>

      {count > 0 && !gridCarriesMembers && (
        <MemberList
          groupId={group.groupId}
          label={label}
          onDropMember={readOnly ? undefined : (memberId) => onMove(memberId, group.groupId)}
        >
          {members.map((memberId) => {
            const { cohort, variable } = memberParts(memberId, fieldIndex);
            return (
              <MemberChip
                key={memberId}
                memberId={memberId}
                cohort={cohort}
                variable={variable}
                moved={movedMembers.has(memberId)}
                draggable={!readOnly}
              />
            );
          })}
        </MemberList>
      )}
      <SourceRows
        memberIds={members}
        fieldIndex={fieldIndex}
        drag={
          readOnly
            ? undefined
            : {
                groupId: group.groupId,
                label,
                onDropMember: (memberId) => onMove(memberId, group.groupId),
                action: { kind: "remove", onAct: (memberId) => onMove(memberId, UNASSIGNED_GROUP_ID) },
                movedMembers,
              }
        }
      />
    </div>
  );
}

/**
 * The detail-pane WRAPPER around a selected group: its header (name, rename pencil, coherence, scope) and
 * the demoted generated ideal, above the reused `ExpandedGroup` (members, source rows, carve, drag).
 *
 * THE IDEAL IS DEMOTED AND CHANGE-AWARE. `generate(ideal)` runs once, before the split, on the original
 * grouping — so a description presented as the group's live definition would lie the moment a variable is
 * dragged out. It sits collapsed, labelled "from the original grouping". Once the reviewer has edited this
 * group it opens and says what happens next (Option B, 2026-09-18): Continue REGENERATES it for the members as
 * they are left here — one model call, in the Continue quote — and Gate 2 judges the group against the new one.
 */
function GroupDetail({
  group,
  count,
  readOnly,
  renameReadOnly = readOnly,
  renamedTo,
  onRename,
  inScope,
  onScopeChange,
  stale,
  children,
}: {
  group: ConceptGroup;
  /** Effective member count after the reviewer's moves (the sidebar row's number). */
  count: number;
  readOnly: boolean;
  /** Whether the NAME is read-only too — it can stay open when the rest is not (an auto-accepted Gate 1, 08-30). */
  renameReadOnly?: boolean;
  renamedTo?: string;
  onRename: (next: string) => void;
  inScope: boolean;
  onScopeChange: (inScope: boolean) => void;
  /** True when the reviewer has changed this group's membership, so the generated ideal is regenerated. */
  stale: boolean;
  children: React.ReactNode;
}) {
  const label = groupLabel(group, renamedTo);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule-on-raised pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onRename(draft);
                    setEditing(false);
                  }
                  if (e.key === "Escape") setEditing(false);
                }}
                onBlur={() => {
                  onRename(draft);
                  setEditing(false);
                }}
                aria-label="Rename group"
                className="min-w-[18rem] rounded-inner border border-rule-control-on-raised bg-surface-raised px-2 py-1 text-xl font-semibold text-on-raised"
              />
            ) : (
              <h2
                data-testid="concept-title"
                className="text-xl font-semibold leading-tight text-on-raised"
                title={label.text}
              >
                <Highlight text={label.text} />
              </h2>
            )}
            {label.source === "reviewer" && !editing && <RenamedMark />}
            {label.source === "judge" && !editing && <BorrowedMark />}
            {!renameReadOnly && !editing && (
              <button
                type="button"
                data-testid="rename-group"
                aria-label={`Rename ${label.text}`}
                title="Rename this group"
                onClick={() => {
                  setDraft(label.source === "reviewer" ? label.text : "");
                  setEditing(true);
                }}
                className="shrink-0 rounded p-1 text-on-raised-muted hover:text-accent-on-raised"
              >
                <Pencil aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
            <CoherenceMark state={group.coherence} />
          </div>
          <p className="mt-1.5 text-xs text-on-raised-muted">
            <span className="font-semibold text-on-raised">{count}</span>{" "}
            {count === 1 ? "variable" : "variables"} ·{" "}
            {group.cohorts.join(", ")} ·{" "}
            <span data-testid="row-provenance">
              from cluster{" "}
              <span className="font-mono">{group.clusterId || "—"}</span>
            </span>
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-semibold text-on-raised-muted">
          <input
            type="checkbox"
            checked={inScope}
            disabled={readOnly}
            onChange={(e) => onScopeChange(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Send to Gate 2
        </label>
      </div>

      {/* THE COHERENCE FINDING SITS ABOVE THE ROWS AND THE GENERATED IDEAL BELOW THEM (mockup parity): the
          judge's read frames the evidence you are about to scan, and the ideal — a pre-split artefact — is
          demoted beneath it. `children` (the ExpandedGroup) leads with the finding and carries the rows. */}
      {children}

      {group.idealCde && (
        <details
          className="group rounded-inner border border-rule-on-raised"
          open={stale}
        >
          {/* The shared disclosure header (08-30b): whole row lights on hover, trailing chevron. */}
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-inner px-4 py-2.5 transition-colors hover:bg-surface-inset group-open:rounded-b-none [&::-webkit-details-marker]:hidden">
            <DisclosureLabel ground="raised">Generated ideal CDE</DisclosureLabel>
            <span className="text-xs text-on-raised-faint">
              from the original grouping
            </span>
            {stale && (
              <span
                data-testid="ideal-regenerated"
                className="ml-2 rounded-pill border border-accent-action px-2 py-0.5 text-xs normal-case tracking-normal text-accent-on-raised"
              >
                membership changed — regenerated at Gate 2
              </span>
            )}
            <DisclosureChevron ground="raised" className="ml-auto group-open:rotate-180" />
          </summary>
          {stale && (
            <p className="px-4 pt-2 text-xs leading-relaxed text-on-raised-muted">
              You changed this group&rsquo;s membership, so the description
              below — written once, before the split, for the original grouping
              — is regenerated for the members as you leave them here when you
              continue. That is one model call, included in the Continue quote
              while the group is in scope, and Gate 2 judges the group against
              the new description.
            </p>
          )}
          <p className="max-w-[90ch] px-4 py-3 text-sm leading-relaxed text-on-raised-muted">
            {/* Searched (searchableText), so a match here is highlighted too (review round 4). */}
            <Highlight text={group.idealCde} />
          </p>
        </details>
      )}

    </div>
  );
}

export default function Gate1Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState, error, reconnecting, cancel } = useHarmonizeStream(
    jobId,
    true,
    true,
  );
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [resuming, setResuming] = useState(false);
  /**
   * The server refused a paid press for want of a BYOK key (08-28) — Continue, or one group's division — so the
   * key field shows where it was pressed. The tab's key is shared (`lib/run-key.ts`): entered at either place,
   * it is what both presses send next.
   */
  const [continueKeyAsk, setContinueKeyAsk] = useState<KeyRefusal | null>(null);
  const [carveKeyAsk, setCarveKeyAsk] = useState<{ groupId: string; reason: KeyRefusal } | null>(null);

  // Cross-cohort-only replaces the bucket partition: on = the harmonization subset, off = every group.
  const [xcOnly, setXcOnly] = useState(false);
  // Master-detail selection. `selectedId` names the group in the detail pane; `poolSelected` swaps the
  // pane to the "In no group" holding area instead.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The score builder's matched variables for the group its link opened (todo 2026-09-23). Keyed on the group
  // so selecting any other group from the queue drops it — the highlight belongs to that one navigation.
  const [scoreHighlight, setScoreHighlight] = useState<{ groupId: string; ids: Set<string> } | null>(null);
  const [poolSelected, setPoolSelected] = useState(false);
  // The detail pane, so the score panel's "open this group" can scroll it into view after selecting.
  const detailPaneRef = useRef<HTMLElement>(null);
  // Drag-over cue for the sidebar's "In no group" drop target.
  const [poolOver, setPoolOver] = useState(false);
  /**
   * ONE sort state for both controls (08-16c Task 10). `null` = the ledger's own documented order
   * (verdict, breadth, size, id) — click-to-sort is opted into on top of the default, never instead of it.
   */
  const [colSort, setColSort] = useState<ColumnSort<LedgerSortKey> | null>(
    null,
  );
  const [filters, setFilters] = useState<LedgerFilters>(NO_FILTERS);
  /** The terms the reviewer last searched. `null` means they have not searched — not "searched and got 0". */
  const [terms, setTerms] = useState<string[] | null>(null);
  /** The live search text — filters the queue AS THE REVIEWER TYPES (mockup parity), driving `terms`. */
  const [query, setQuery] = useState("");

  const groups: ConceptGroup[] = useMemo(
    () => jobState?.result?.conceptGroups ?? [],
    [jobState?.result?.conceptGroups],
  );
  // variableId ("cohort:var") → its concept groupId, from the run's FULL membership lists. Lets the score
  // panel roll a variable-level retrieval candidate (a missing component's shortlist is variable-level) up
  // to the ONE group it belongs to — so eight look-alike cancer-type variables collapse to a single group
  // that links, instead of eight dead rows that don't. Uses conceptGroupMembers (untruncated), not the
  // group rows' capped memberVariableNames sample.
  const groupByVariable = useMemo(() => {
    const m = new Map<string, string>();
    const members = jobState?.result?.conceptGroupMembers ?? {};
    for (const [groupId, vars] of Object.entries(members)) {
      for (const v of vars) if (!m.has(v)) m.set(v, groupId);
    }
    return m;
  }, [jobState?.result?.conceptGroupMembers]);
  /**
   * The coverage column's denominator. `summary.cohorts` is EMPTY at a Gate 1 park on a real run, so
   * reading it directly drew a column of nothing — see `cohortRoster` for the measurement and the
   * precedence rule.
   */
  const allCohorts = useMemo(
    () => cohortRoster(jobState?.result?.summary?.cohorts, groups),
    [jobState?.result?.summary?.cohorts, groups],
  );
  const unassigned = jobState?.result?.unassignedFields ?? [];
  const costSoFar =
    jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

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
  const position = (jobState?.gatePosition ?? null) as GatePosition | null;
  /** The run has moved PAST this gate. */
  const past = isGatePast("gate1", position);
  /**
   * The run has moved PAST this gate, so the screen is a record (08-16c Task 2).
   *
   * Passed into every decision hook below, where `write`/`clear` refuse outright. The refusal is at the
   * WRITE PATH rather than only in the rendering, because a disabled-looking control that still submits is
   * worse than an enabled one — and these decisions have already been consumed by the pipeline.
   *
   * Never on the shared demo, though it is parked at Gate 4: a guest practises every control there, and the hooks hold
   * the edits in the tab without sending them (`isGateLocked`).
   */
  const frozen = isGateLocked("gate1", position, runConfig);
  /**
   * 08-30: a Gate 1 Full auto committed was never reviewed, so its group NAMES stay open (the export applies a rename
   * without re-running anything). Its grouping does not: scope, moves and new groups were consumed by the paid steps
   * after it, and changing them would need those groups re-run, which is not available — `frozen` keeps them as
   * committed. The server's `_refuse_past_gate` draws the same line (`AUTO_REVISABLE_KINDS`).
   */
  const renameFrozen = isGateLocked("gate1", position, runConfig, "gate1_rename");
  // What a frozen Gate 1's bar says in place of the purchase (O2): the step is done, and what it bought. Not on the
  // shared demo: it is WALKED (08-18), so even a demo parked further on keeps the walk forward on this bar.
  const pastBar =
    frozen && pinned !== true
      ? frozenContinue("gate1", realizedRailArgs(jobState?.result?.cost, costSoFar).realizedByGate)
      : null;
  const scope = useGateDecisions(jobId, "gate1_group_scope", {
    pinned,
    frozen,
  });
  const regroups = useGateDecisions(jobId, "gate1_regroup", { pinned, frozen });
  const renames = useGateDecisions(jobId, "gate1_rename", { pinned, frozen: renameFrozen });
  /** The reviewer's own groups (08-28 Wave 2), filled by ordinary regroup moves whose destination is their id. */
  const newGroups = useGateDecisions(jobId, "gate1_new_group", { pinned, frozen });
  const reviewerIds = useMemo(
    () => Object.keys(newGroups.decisions).filter(isReviewerGroupId),
    [newGroups.decisions],
  );
  /**
   * The declared score's rows — ONE hook instance, handed to the score panel, so a declaration made there is seen
   * here at once (a second instance would hydrate once and never see the panel's later writes).
   */
  const swaps = useGateDecisions(jobId, "composite_swap", { pinned, frozen });
  const declared = useMemo(() => declaredScores(swaps.all), [swaps.all]);
  const latestSpec = jobState?.composites?.at(-1) ?? null;
  /**
   * Gate 1's FREE score suggestions (08-28 Decision 6, option A): the retrieval half of the match, $0, no judge.
   *
   * The paid match is on Gate 4, after this gate is continued, so a live Gate 1 has no match to seed from. Asked for
   * only while it can matter — a declaration exists, no Gate 4 match does, and this gate is still open (a PASSED
   * Gate 1 shows the scope it sent, so a suggestion could only contradict the record). Keyed on everything that
   * changes the answer: the declarations, the reviewer's moves and their New groups; the server reads those rows
   * itself. A failure is silent — no suggestion is the same as no evidence, never a claim.
   */
  const suggestionKey = useMemo(
    () =>
      JSON.stringify([
        declared,
        Object.entries(regroups.decisions)
          .map(([member, d]) => [member, d.chosen])
          .sort(),
        [...reviewerIds].sort(),
      ]),
    [declared, regroups.decisions, reviewerIds],
  );
  const suggestionsQuery = useQuery({
    queryKey: ["score-suggestions", jobId, suggestionKey],
    queryFn: () => getScoreSuggestions(jobId),
    // `result` first: until the run's payload has landed, neither "is there a Gate 4 match?" nor "is this gate
    // passed?" has an answer, and asking early would fetch for a screen that then never uses the reply. And only
    // on a run that is DEFINITELY the reviewer's own (`pinned === false`): the shared demo keeps its declaration in
    // this browser, which the server never sees, and nothing a guest does there leaves the browser.
    enabled:
      !!jobId && !!jobState?.result && pinned === false && !frozen && !latestSpec && declared.length > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    // A move re-asks (the key changes); until the new answer lands, keep the last one rather than un-seeding every
    // suggested group for the length of a request.
    placeholderData: keepPreviousData,
  });
  /**
   * THE ONE INPUT to the score-seeded scope and the queue's score tags: the Gate 4 match when the run has one, else
   * the free suggestions (`scoreScopeInput`). Both go through `scoreSeededGroups`, each at its own scale's cut-off.
   * Every OFFERED group is tagged and pinned to the top; only the auto-selected subset (`scoreSeed`) starts in scope
   * — for a suggestion the two are the same set. No declaration and no match → nothing changes in the queue.
   */
  const scoreInput = useMemo(
    () =>
      scoreScopeInput(
        latestSpec,
        frozen || latestSpec ? null : suggestionsQuery.data,
      ),
    [latestSpec, frozen, suggestionsQuery.data],
  );
  const scoreTagByGroup = useMemo(() => scoreTaggedGroups(scoreInput.matches), [scoreInput]);
  const scoreSeed = useMemo(
    () => scoreSeededGroups(scoreInput.matches, scoreInput.threshold),
    [scoreInput],
  );
  /** What the score panel says about the suggestions, when they are the input (or could not be made). */
  const suggestionNote = useMemo(() => {
    const s = !frozen && !latestSpec ? suggestionsQuery.data : undefined;
    // No score searched for: the server holds no declaration for this run (the shared demo keeps its declaration in
    // this browser, which the server never sees) — so there is nothing to say, not "nothing was found".
    if (!s || s.scores.length === 0) return null;
    if (!s.scored) return { nGroups: 0, nComponents: 0, unavailable: s.reason };
    return {
      nGroups: scoreSeed.size,
      nComponents: scoreInput.source === "suggestion" ? scoreInput.matches.length : 0,
      unavailable: "",
    };
  }, [frozen, latestSpec, suggestionsQuery.data, scoreSeed, scoreInput]);
  /** The reviewer's own name for a group, or undefined. Read straight off the persisted decisions. */
  const renamedOf = (groupId: string): string | undefined => {
    const chosen = renames.decisions[groupId]?.chosen;
    return typeof chosen === "string" && chosen.trim() ? chosen : undefined;
  };
  /**
   * Record a rename, or CLEAR it to restore the generated name.
   *
   * Follows `gate1_regroup` exactly — same hook, same kind registry, same persistence path. A new decision
   * kind that invented its own route is how the two halves drift apart. `alternatives` carries the
   * pipeline's own label beside the reviewer's, so the original is recoverable from the decision record
   * itself and Gate 4's export can show both.
   */
  async function onRename(group: ConceptGroup, next: string) {
    const trimmed = next.trim();
    const generated = groupLabel(group).text;
    try {
      if (!trimmed || trimmed === generated) {
        // An empty or whitespace-only rename is REFUSED as a rename and read as "undo it" — restoring the
        // generated name rather than producing a nameless group.
        if (renamedOf(group.groupId))
          await renames.clear({ groupId: group.groupId });
        return;
      }
      await renames.write(
        { groupId: group.groupId },
        {
          chosen: trimmed,
          alternatives: [generated, trimmed],
          extra: { generatedName: generated },
        },
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not rename this group",
      );
    }
  }

  // What Gate 2 is forecast to cost for THIS run, divided across its rows. `assign` runs once per
  // post-split group, so the row count is the call count and every row buys the same call.
  const variables = groups.reduce((n, g) => n + g.nMembers, 0);
  const mode = ((runConfig?.mode as string | undefined) ?? "batch") as RunMode;
  const gate2Forecast = useMemo(
    () =>
      estimateRunCostBreakdown(variables, allCohorts.length, mode, true).byGate
        .gate2.forecast,
    [variables, allCohorts.length, mode],
  );
  const price = pricePerGroup(gate2Forecast, groups.length);

  // DEFAULT OUT — selecting is the deliberate act (08-23b subset). Opting 1234 groups in by default was
  // both the wrong default (most runs scope a subset) and the source of the deselect-everything grind. An
  // explicit decision always wins; absent one, a group is in scope ONLY when the SCORE BUILDER matched it
  // (those are the ones a reviewer building a score cares about). No composite -> nothing is pre-selected,
  // and Continue stays disabled until the reviewer scopes something (the empty-in-scope guard already does
  // this). The checkbox now ADMITS a group rather than removing one.
  /**
   * A PASSED Gate 1 shows the scope its Continue SENT (`config.gate1_scope`), never a re-derivation of it.
   *
   * Found answering "is the auto-select threshold functional?" (final review round 1, item 3): the score-seeded
   * default below reads the LATEST derived score, and since 08-28 1f a score is matched at Gate 4 — AFTER Gate 1 was
   * continued. Re-deriving on a passed Gate 1 therefore printed groups the later score reached as "in scope" at
   * Gate 1, which Gate 1 never sent and Gate 2 never received. The frozen list is exactly what the reviewer saw at
   * Continue, score-seeded defaults included. A run that passed Gate 1 before 08-27 carries no list and keeps the
   * old derivation.
   *
   * On the shared demo the sent list is where practice STARTS: the guest's own ticks sit on top of it, in the tab.
   */
  const sentScope = useMemo(() => {
    const sent = past ? runConfig?.gate1_scope : undefined;
    return Array.isArray(sent) ? new Set(sent.filter((g): g is string => typeof g === "string")) : null;
  }, [past, runConfig]);
  const isInScope = (groupId: string) => {
    if (frozen && sentScope) return sentScope.has(groupId);
    const chosen = scope.decisions[groupId]?.chosen;
    if (chosen === IN_SCOPE) return true;
    if (chosen === OUT_OF_SCOPE) return false;
    // A New group is IN by default: making one is already the deliberate act (08-28 Wave 2).
    if (isReviewerGroupId(groupId)) return true;
    if (sentScope) return sentScope.has(groupId);
    return scoreSeed.has(groupId);
  };
  /**
   * WHY a group is in scope — the same branches as `isInScope`, kept beside it so they cannot drift — for the score
   * panel's cards, which count only the groups in scope for THEIR component (a group seeded by another component's
   * suggestion is in scope, but not this card's).
   */
  const scopeWhy = (groupId: string): GroupScopeWhy => {
    if (frozen && sentScope) return { by: sentScope.has(groupId) ? "chosen" : "none", components: [] };
    const chosen = scope.decisions[groupId]?.chosen;
    if (chosen === IN_SCOPE) return { by: "chosen", components: [] };
    if (chosen === OUT_OF_SCOPE) return { by: "none", components: [] };
    if (isReviewerGroupId(groupId)) return { by: "made", components: [] };
    if (sentScope) return { by: sentScope.has(groupId) ? "chosen" : "none", components: [] };
    const seededBy = scoreSeed.get(groupId);
    return seededBy ? { by: "score", components: seededBy } : { by: "none", components: [] };
  };
  /** Write one group's scope — the ONE path, shared by the ledger checkbox and the score panel's. */
  const setGroupScope = (groupId: string, next: boolean) =>
    void scope.write(
      { groupId },
      { chosen: next ? IN_SCOPE : OUT_OF_SCOPE, alternatives: SCOPE_OPTIONS },
    );

  // "You changed it" is DERIVED from persisted decisions, never from component state — R6 requires the
  // correction to be visible after a reload, and a flag in `useState` is gone the moment the page reloads.
  const touchedByRegroup = useMemo(() => {
    const byGroup = new Set<string>();
    for (const d of Object.values(regroups.decisions)) {
      if (typeof d.chosen === "string" && d.chosen) byGroup.add(d.chosen);
      if (typeof d.fromGroupId === "string" && d.fromGroupId)
        byGroup.add(d.fromGroupId);
    }
    return byGroup;
  }, [regroups.decisions]);
  const isChanged = (groupId: string) =>
    groupId in scope.decisions ||
    groupId in renames.decisions ||
    touchedByRegroup.has(groupId);
  const [bulkBusy, setBulkBusy] = useState(false);

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

  /**
   * When the reviewer last moved a variable INTO each group — the tray's order (08-16c review).
   *
   * Read straight off the persisted decisions beside `moves` itself, so it survives a reload exactly as
   * the moves do (R6). A decision written before `movedAt` existed contributes nothing rather than
   * counting as the epoch.
   */
  const lastMovedInto = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of Object.values(regroups.decisions)) {
      const to = typeof d.chosen === "string" ? d.chosen : "";
      const at = typeof d.movedAt === "number" ? d.movedAt : 0;
      if (!to || !at) continue;
      if (at > (out[to] ?? 0)) out[to] = at;
    }
    return out;
  }, [regroups.decisions]);

  const membersByGroup = jobState?.result?.conceptGroupMembers ?? {};
  const membership = useMemo(
    () => effectiveMembers(groups, membersByGroup, moves, reviewerIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, jobState?.result?.conceptGroupMembers, moves, reviewerIds],
  );
  /** The reviewer's New groups as queue rows, newest first, sized by what has been dragged into them. */
  const reviewerRows = useMemo(
    () => reviewerGroupRows(newGroups.decisions, (id) => membership.byGroup[id] ?? []),
    [newGroups.decisions, membership],
  );
  /**
   * groupId → group, NAMED as this screen names it, so the declared-score panel can name a match's concept group
   * and link into its detail. Every group the queue shows — the reviewer's own included — under the reviewer's
   * name where they gave one (phase-8 final review: renamed and New groups read "Unnamed group" there).
   */
  const groupsById = useMemo(
    () => namedGroupsById(groups, reviewerRows, renamedOf),
    // `renamedOf` reads `renames.decisions`; the map is rebuilt whenever a rename lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, reviewerRows, renames.decisions],
  );
  /**
   * The pipeline groups the reviewer RESHAPED (Option B, 2026-09-18). Continue regenerates each one's ideal
   * description for its final members — one paid call — so Gate 2 judges it against what it now holds. Derived
   * from the persisted moves on every read (R6), by the same rule core applies.
   */
  const reshaped = useMemo(
    () => reshapedGroupIds(groups, membersByGroup, membership.byGroup),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, jobState?.result?.conceptGroupMembers, membership],
  );
  /** Does this group buy a generated ideal at Continue? A New group always; a reshaped one that still has members. */
  const needsIdeal = (groupId: string) =>
    isReviewerGroupId(groupId) || (reshaped.has(groupId) && (membership.byGroup[groupId]?.length ?? 0) > 0);
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
    const movedIn = Object.values(moves).filter(
      (to) => to === g.groupId,
    ).length;
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
      for (const memberId of byGroup[g.groupId] ?? g.memberVariableNames)
        out[memberId] = g.groupId;
    }
    return out;
  }, [groups, jobState?.result?.conceptGroupMembers]);

  /** Record one move, with no acknowledgement — the shared half of a drag and of undoing a division. */
  async function placeMember(memberId: string, toGroupId: string): Promise<boolean> {
    const from = originalGroupOf[memberId] ?? "";
    if (toGroupId === from) {
      // Back where it started, so the decision is CLEARED rather than written as a no-op. A stored
      // "moved to where it already was" would keep the row marked as changed forever.
      await regroups.clear({ memberId });
      return false;
    }
    await regroups.write(
      { memberId, fromGroupId: from },
      {
        chosen: toGroupId,
        // WHEN, so the tray can lead with the groups just filled (08-16c review) WITHOUT remembering it in
        // component state. It goes through `extra` because the decision payload carried no timestamp and
        // the server's `updatedAt` is not served back on read — see `sortDestinations`. Clearing a move
        // removes the row, so a reverted move stops counting as recency on its own.
        extra: { movedAt: Date.now() },
        // The destinations offered FOR THIS VARIABLE at the moment of the move: where it was, the no-group
        // tray, and where it went. Deliberately NOT every group in the run — that would be honest about
        // the option space but would mark every regroup decision stale the moment any group id changed,
        // including the ones a re-adjudication elsewhere had nothing to do with, and a notice that fires
        // on unrelated changes is a notice reviewers learn to ignore.
        alternatives: [
          ...new Set([from, UNASSIGNED_GROUP_ID, toGroupId].filter(Boolean)),
        ],
      },
    );
    return true;
  }

  async function moveMember(memberId: string, toGroupId: string) {
    if (!(await placeMember(memberId, toGroupId))) return;
    // Confirm the move (mockup parity) — a drag has no other acknowledgement, and a member that lands in a
    // collapsed group off-screen is otherwise a change with no visible consequence.
    const { variable } = memberParts(memberId, fieldIndex);
    const destGroup = [...reviewerRows, ...groups].find((g) => g.groupId === toGroupId);
    const dest =
      toGroupId === UNASSIGNED_GROUP_ID
        ? "In no group"
        : destGroup
          ? groupLabel(destGroup, renamedOf(toGroupId)).text
          : "another group";
    toast.success(
      `Moved ${variable} → ${dest.length > 44 ? dest.slice(0, 44) + "…" : dest}`,
    );
  }

  /**
   * Undo ONE move — the pool's keyboard path back into the group a variable came from.
   *
   * `clear` rather than a write, which is what makes it an UNDO: the regroup decision is removed, so the
   * variable returns to its original membership and the row stops being marked as changed on its account.
   * Writing "back to where it started" instead would leave a stored decision saying a move happened.
   */
  async function restoreMember(memberId: string) {
    await regroups.clear({ memberId });
  }

  /**
   * Make a New group (08-28 Wave 2). Its id is minted HERE, once, and never changes: Continue freezes it, core
   * forms the group under it, and every later gate and export names it by it. `createdAt` rides in the payload
   * (like `movedAt`) so the queue can list the newest first after a reload.
   */
  async function createGroup(name: string) {
    const groupId = newReviewerGroupId();
    try {
      await newGroups.write(
        { groupId },
        { chosen: name, alternatives: [name], extra: { name, createdAt: Date.now() } },
      );
      setSelectedId(groupId);
      setPoolSelected(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not make that group");
    }
  }

  /** Rename a New group: its OWN decision is rewritten (there is no generated name to annotate). */
  async function renameGroup(groupId: string, next: string) {
    const name = next.trim();
    const d = newGroups.decisions[groupId];
    if (!name || !d || name === String(d.name ?? d.chosen ?? "")) return;
    try {
      await newGroups.write(
        { groupId },
        { chosen: name, alternatives: [name], extra: { name, createdAt: d.createdAt } },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename this group");
    }
  }

  /** Delete a New group — offered only while it is EMPTY, so no move is ever left pointing at nothing. */
  async function deleteGroup(groupId: string) {
    if ((membership.byGroup[groupId]?.length ?? 0) > 0) return;
    try {
      await newGroups.clear({ groupId });
      if (groupId in scope.decisions) await scope.clear({ groupId });
      if (selectedId === groupId) setSelectedId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete this group");
    }
  }

  /**
   * Undo an accepted division: every variable in its parts goes back into the divided group, and the (then
   * empty) parts are deleted. Decisions only — nothing is bought, and the paid re-split is not refunded.
   */
  async function undoDivision(parentId: string) {
    const parts = reviewerRows.filter((g) => g.readjudicatedFrom === parentId);
    try {
      for (const part of parts) {
        for (const memberId of membership.byGroup[part.groupId] ?? []) await placeMember(memberId, parentId);
      }
      for (const part of parts) {
        await newGroups.clear({ groupId: part.groupId });
        if (part.groupId in scope.decisions) await scope.clear({ groupId: part.groupId });
      }
      if (parts.some((part) => part.groupId === selectedId)) setSelectedId(parentId);
      toast.success("Division undone — its variables are back in the group");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not undo the division");
    }
  }

  /** Undo every move out of one group — the "put them back" the emptied state offers. */
  async function restoreGroup(groupId: string) {
    const strayed = Object.entries(moves).filter(
      ([memberId]) => originalGroupOf[memberId] === groupId,
    );
    await Promise.all(
      strayed.map(([memberId]) => regroups.clear({ memberId })),
    );
  }

  /**
   * THE POOL'S TWO HALVES, derived (08-16c review). Both come off the same persisted decisions the rest of
   * this screen reads, so the pool survives a reload exactly as the moves do (R6).
   *
   * `membership.unassigned` is every variable that STARTED in some group and is now out — the reviewer's
   * own doing, across ALL groups rather than the expanded one. `unplacedFields` is the clustering's
   * leftovers minus any the reviewer has since dragged into a real group, so nothing is listed twice.
   */
  const poolFromPipeline = useMemo(
    () =>
      unplacedFields(unassigned, moves, [
        ...groups.map((g) => g.groupId),
        ...reviewerIds,
      ]),
    [unassigned, moves, groups, reviewerIds],
  );
  const poolCount = membership.unassigned.length + poolFromPipeline.length;

  /** Member ids the reviewer has moved — what makes a chip render in the you-changed-it register. */
  const movedMemberIds = useMemo(() => new Set(Object.keys(moves)), [moves]);

  /** Why accepting is unavailable on this run, resolved once rather than per row. */
  const refusalFor = readjudicationRefusal({
    pinned: pinned === true,
    optedIn: Boolean(runConfig?.readjudication),
  });

  /**
   * Why matching the declared components does not run HERE — the honest not-available, pointing at where it
   * does, rather than a dead control.
   *
   * MATCHING IS HOSTED ON GATE 4 (decision Q5, 08-28 1f). A run parked at Gate 1 has no assigned records, so
   * `match_components` has nothing to match onto; and Gate 4 is where the concepts are FINAL — scope, renames,
   * picks and edits applied. The old copy promised "the verdict fills in once the run has got that far" while
   * no later screen ever offered the match (live verify 3 F20). Unconditional, so a run that does carry
   * records never shows a Match button with nothing behind it.
   *
   * The declaration itself still belongs here: it is free, it is where a reviewer scoping a run is thinking
   * about it, and the per-component group hints stay as the scoping aid.
   */
  const matchRefusal = { claim: "deferred" as const, reason: GATE1_MATCH_DEFERRED };

  const [accepting, setAccepting] = useState("");
  async function acceptCarve(groupId: string) {
    setAccepting(groupId);
    try {
      // EXACTLY ONE ID, built by a named function so the prohibition has somewhere to be asserted.
      const { groupIds } = readjudicationRequest(groupId);
      // The tab's held key rides the re-split (08-28); with none, the server decides.
      const res = await readjudicateGroups(jobId, groupIds, heldRunKey());
      setCarveKeyAsk(null);
      // THE DIVISION IS THE REVIEWER'S OWN DECISIONS NOW (08-28 follow-up #1): a New group per part and a move
      // per variable, written server-side in the same request as the paid re-split, and returned with their
      // versions. The decision hooks hydrate once per run, so they are absorbed here — the parts appear at once,
      // and a later edit of one saves against the version the server stored (no false two-tab notice).
      newGroups.absorb(res.decisions?.gate1_new_group);
      regroups.absorb(res.decisions?.gate1_regroup);
      // The re-split was billed to this gate: refetch so the spend readout moves.
      await queryClient.invalidateQueries({ queryKey: ["harmonize-result", jobId] });
      const parts = res.parts ?? [];
      if (parts.length > 0) {
        setSelectedId(parts[0].groupId);
        setPoolSelected(false);
        toast.success(
          `Divided into ${parts.length} groups — they lead the list, in scope for Gate 2`,
        );
      } else {
        toast.info(
          "The re-split found a single concept, so the group was kept whole — nothing changed.",
        );
      }
    } catch (e) {
      // No preview exemption here: a division is a paid re-split whatever mode the run was started in.
      const reason = keyAskFor(e, { pinned: pinned === true });
      setCarveKeyAsk(reason ? { groupId, reason } : null);
      toast.error(
        e instanceof Error ? e.message : "Could not re-split that group",
      );
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
  const inScopeGroups = gate1BillableGroups([...reviewerRows, ...groups], isInScope, memberCount);

  const clusters = new Set(groups.map((g) => g.clusterId)).size;
  // A filled New group (08-28 Wave 2), and a group whose membership the reviewer changed (Option B), buy ONE
  // ideal description beside their match — in every figure below.
  const idealPerGroup = newGroupIdealUsd(variables, allCohorts.length, mode, clusters);
  const quote = gate1QuoteUsd(inScopeGroups, price, idealPerGroup, needsIdeal);
  const nIdeals = inScopeGroups.filter((g) => needsIdeal(g.groupId)).length;
  const filledReviewerRows = reviewerRows.filter((g) => memberCount(g) > 0);
  const nCrossCohort = groups.filter((g) => g.crossCohort).length;
  // The filter menu's figures: how many groups each cohort box would keep on its own.
  const cohortCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) for (const c of g.cohorts) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  }, [groups]);

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
  const search = useMemo(
    () =>
      terms && terms.length > 0 ? matchTerms(groups, terms, renamedOf) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, terms, renames.decisions],
  );

  const visible = useMemo(() => {
    let rows = xcOnly ? buckets["cross-cohort"] : groups;
    if (search) rows = rows.filter((g) => search.ids.has(g.groupId));
    rows = applyFilters(rows, filters, { isTouched: isChanged, isInScope });
    const sorted = sortGroupsByColumn(rows, colSort, renamedOf);
    // Pin the score-linked groups to the top (stable — the column sort still orders within each partition),
    // so a reviewer following a declared score meets its concept groups first. No composite → no reorder.
    if (scoreTagByGroup.size === 0) return sorted;
    const linked = sorted.filter((g) => scoreTagByGroup.has(g.groupId));
    const rest = sorted.filter((g) => !scoreTagByGroup.has(g.groupId));
    return [...linked, ...rest];
    // `isChanged`/`isInScope` close over the decision maps, which is what the two entries below track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    buckets,
    xcOnly,
    groups,
    search,
    filters,
    colSort,
    scope.decisions,
    touchedByRegroup,
    renames.decisions,
    scoreTagByGroup,
  ]);

  // Variables per SHOWN group, for the select-all counts (ticked of shown).
  const visibleVars = new Map(visible.map((g) => [g.groupId, memberCount(g)]));

  // Every filter that is on, as a removable chip under the search (08-30b) — Cross-cohort only first, then the
  // cohorts, then the states, in the order the menu lists them.
  const filterChips: FilterChip[] = [
    ...(xcOnly ? [{ key: "xc", label: "Cross-cohort only", onRemove: () => setXcOnly(false) }] : []),
    ...filters.cohorts.map((c) => ({
      key: `co:${c}`,
      label: c,
      onRemove: () => setFilters({ ...filters, cohorts: filters.cohorts.filter((x) => x !== c) }),
    })),
    ...filters.verdicts.map((st) => ({
      key: `st:${st}`,
      label: stateLabel(st),
      onRemove: () => setFilters({ ...filters, verdicts: filters.verdicts.filter((x) => x !== st) }),
    })),
  ];

  /**
   * Apply a bulk scope change to the VISIBLE rows, one request at a time.
   *
   * SEQUENTIAL, NOT PARALLEL, and deliberately. N is the row count, `write`/`clear` are per-item promises,
   * and `use-gate-decisions`' conflict surface is written for a single decision — so an unbounded burst
   * that half-succeeds is precisely the state it has no way to report. A failure part-way through stops
   * the run and leaves the PERSISTED decisions as the only source of truth; nothing here paints a
   * checkbox optimistically, because `isInScope` reads `scope.decisions` and always has.
   */
  async function onBulkScope(target: "in" | "out") {
    const ids = visible.map((g) => g.groupId);
    const plan = bulkScopePlan(ids, target, isInScope);
    if (plan.clear.length === 0 && plan.write.length === 0) return;
    const value = target === "in" ? IN_SCOPE : OUT_OF_SCOPE;
    setBulkBusy(true);
    try {
      for (const id of plan.clear) await scope.clear({ groupId: id });
      for (const id of plan.write) {
        await scope.write(
          { groupId: id },
          { chosen: value, alternatives: SCOPE_OPTIONS },
        );
      }
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "Could not change the scope of every group — some may be unchanged",
      );
    } finally {
      setBulkBusy(false);
    }
  }

  // Nothing in the bucket matched — say which of the two reasons it was. A filter the reviewer set is
  // their own doing and is cleared; a search term that matched nothing is a finding about the corpus and
  // is reported by `TermSearch` instead.
  const filteredToNothing =
    visible.length === 0 &&
    groups.length > 0 &&
    activeFilterCount(filters) > 0 &&
    !search;
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
  const searchCause: "search" | "both" =
    search && search.ids.size === 0 ? "search" : "both";
  /**
   * The DEFAULT bucket is empty and the other one is not.
   *
   * A real dead end, found in test: a run whose groups are all single-cohort opens on an empty
   * cross-cohort tab, and "no rows here" is indistinguishable from "no rows at all" — which would be the
   * coverage lie the partition exists to avoid, arrived at from the opposite direction. The default is
   * NOT changed (the cross-cohort bucket leads on purpose); the empty view names the other bucket, says
   * what it holds, and goes there in one click.
   */
  // The group whose depth is in the detail pane — the selected one, or the first visible as default.
  const selectedReviewer = reviewerRows.find((g) => g.groupId === selectedId) ?? null;
  const detailGroup =
    visible.find((g) => g.groupId === selectedId) ?? visible[0] ?? null;

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
  const awaitingRun =
    groups.length === 0 && (!jobState || isInFlight(jobState.status));
  /**
   * The run ENDED before it produced anything.
   *
   * `complete` is excluded: a finished run with no groups is the genuine corpus finding, and the existing
   * copy for it is correct. This branch is for the run that failed or was stopped — where the screen
   * would otherwise wait for groups that are never coming.
   */
  const stoppedBeforeGate =
    groups.length === 0 &&
    !!jobState &&
    isTerminal(jobState.status) &&
    jobState.status !== "complete";

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
    // THE SHARED DEMO IS WALKED, NOT RESUMED (08-18). It is precomputed and immutable server-side — the resume
    // route refuses it — so its Continue is a step to the next screen: no request, no charge (T-08-109).
    if (pinned === true) {
      navigate(pathForGate(jobId, nextRailGate("gate1") ?? "gate2"));
      return;
    }
    setResuming(true);
    try {
      const { target } = await resumeRun(
        jobId,
        // The tab's held key rides every Continue (08-28); with none, the server decides.
        heldRunKey(),
        // the SAME list the commit bar prices (08-27 audit B3)
        gate1ScopePayload(
          inScopeGroups.map((g) => g.groupId),
          isInScope,
        ),
      );
      setContinueKeyAsk(null);
      /**
       * CONFIRM BEFORE MOVING. A 200 from this route is not proof the run advanced — see
       * `resumeTookEffect` for the defect and its reproduction. Navigating on the body alone would land
       * the reviewer on a Gate 2 for a run still parked at Gate 1: an empty screen that reads as success,
       * which is strictly worse than the stranding this task set out to fix.
       *
       * ONE FETCH, NOT A POLL: whichever way a resume takes effect, it has already done so by the time
       * the response is sent. FAIL-OPEN if the check itself cannot be made — a transient GET failure is
       * not evidence that the resume failed, and the server did say yes.
       */
      const after = await getCheckpoint(jobId, heldRunKey()).catch(() => null);
      if (after && !resumeTookEffect(after, target)) {
        toast.error(
          "The server accepted Continue, but this run has not started — it is still parked at this gate. Nothing was charged. Please report this run id.",
        );
        return;
      }
      toast.success(
        `Continuing to ${GATE_LABELS[target as GatePosition] ?? target}`,
      );
      navigate(pathForGate(jobId, target));
    } catch (e) {
      setContinueKeyAsk(keyAskFor(e, { pinned: !!pinned, preview: isPreviewRun(runConfig) }));
      toast.error(
        e instanceof Error ? e.message : "Could not continue this run",
      );
    } finally {
      setResuming(false);
    }
  }

  return (
    <GateShell
      gate="gate1"
      // The rail navigates backwards from here (08-16c Task 2); a shell with no jobId renders it inert.
      jobId={jobId}
      subhead="Each row is a group of variables that mean the same thing, named by ddharmon."
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      // Inherited from the shell (08-14 Task 4): the stop control is placed ONCE in `GateShell`, so a
      // gate's whole part in it is handing over the run and the stream's own `cancel(mode)`.
      job={jobState}
      onStop={cancel}
      // Parked HERE, not merely parked: a run waiting at Gate 4 must not say "Paused at Gate 1" on a frozen
      // Gate 1 (O3). The shared predicate, not a local copy.
      resumed={isParkedAt(jobState, "gate1")}
    >
      {reconnecting && (
        <p
          role="status"
          data-testid="stream-reconnecting"
          className="text-sm font-semibold text-status-warn"
        >
          Lost contact with the server — reconnecting. The figures below are
          from the last update, not live.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-status-danger">
          {error.message}
        </p>
      )}

      {/*
        THE DECLARED-SCORE PANEL, NEAR THE TOP AND CLOSED (08-16c review, item E). Bhargav: *"the
        placement is weird — it's below everything"*, settled as *"move score panel near top as a dropdown
        for now."* It rendered between the ledger and the commit bar, 3035px down, expanded to 651px.

        DIRECTLY UNDER THE HOW-TO STRIP that `GateShell` renders, and in that strip's own register, so the
        two collapsed strips read as one band of things the reviewer can open rather than as a fourth
        panel competing with the ledger for the top of the screen. It costs the ledger ~56px, on a screen
        where the first row already begins 1155px down — see the SUMMARY, which reports that budget rather
        than burying it.

        Still never its own screen, a step before Gate 1, or a modal: a pre-gate screen would interrupt a
        purchase decision to pitch an add-on.
      */}
      <DeclaredScorePanel
        jobId={jobId}
        pinned={pinned}
        swaps={swaps}
        suggestionNote={suggestionNote}
        // The free search's answer, only while it IS the score input (`scoreInput`): no Gate 4 match, gate open.
        suggestions={!frozen && !latestSpec ? (suggestionsQuery.data ?? null) : null}
        spec={latestSpec}
        matchRefusal={matchRefusal}
        groupsById={groupsById}
        groupByVariable={groupByVariable}
        fieldIndex={jobState?.result?.fieldIndex}
        isGroupInScope={isInScope}
        groupScopeWhy={scopeWhy}
        onGroupScopeChange={frozen ? undefined : setGroupScope}
        frozen={frozen}
        onOpenGroup={(groupId: string, matchedIds?: string[]) => {
          // Option coverage units carry a "#opt=<label>" suffix; the detail pane's rows are the variable.
          setScoreHighlight(
            matchedIds?.length ? { groupId, ids: new Set(matchedIds.map((id) => id.split("#opt=")[0])) } : null,
          );
          // Select the matched group in the detail pane, bring the sidebar QUEUE row for it into view
          // (08-16g review #6 — selecting the detail alone left the row scrolled off in the queue), then
          // bring the detail pane itself into view — the score panel sits at the top of Gate 1 and the
          // detail is a full scroll below it.
          setPoolSelected(false);
          setSelectedId(groupId);
          requestAnimationFrame(() => {
            // Match by dataset value (not a selector) so a group id containing "#" needs no escaping.
            const row = Array.from(
              window.document.querySelectorAll(
                '[data-testid="gate1-rows"] [data-group-id]',
              ),
            ).find((el) => (el as HTMLElement).dataset.groupId === groupId);
            row?.scrollIntoView({ block: "nearest" });
            detailPaneRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          });
        }}
      />

      {/* No groups to lay out — waiting, stopped, or an all-outliers run. Full width, not a pane. */}
      {awaitingRun ? (
        <GateEmptyState
          heading="Waiting for this run to reach Gate 1"
          nextStep={
            <span data-testid="gate1-waiting-next">
              Nothing to do yet — the groups appear here on their own as soon as
              the run gets to them, with no need to reload. You can close this
              tab; the run keeps going and will be waiting at this gate when you
              come back.
            </span>
          }
          className="[&]:block"
        >
          <span data-testid="gate1-waiting">
            This run is{" "}
            {jobState?.phase ? (
              <span className="font-semibold">{jobState.phase}</span>
            ) : (
              "still working"
            )}
            . Concept groups are formed after three stages finish: ddharmon
            describes the ideal element for each cluster, splits clusters that
            hold more than one concept, and runs the coherence judge over the
            result. The first rows land here when the third one does.
          </span>
        </GateEmptyState>
      ) : stoppedBeforeGate ? (
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
              , or open{" "}
              <Link
                href="/jobs"
                className="font-semibold text-link-on-raised underline underline-offset-2"
              >
                Runs
              </Link>{" "}
              to pick up a different one.
            </>
          }
          className="[&]:block"
        >
          <span data-testid="gate1-run-stopped">
            No concept groups were produced, so there is nothing to review here.
            This is not a finding about your dictionaries — the run ended before
            it got far enough to have one.
          </span>
        </GateEmptyState>
      ) : groups.length === 0 ? (
        unassigned.length > 0 ? (
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
                and check that the description column is mapped, or add a
                dictionary that overlaps these.
              </>
            }
          >
            Every variable was left unassigned by the clustering —{" "}
            {unassigned.length}{" "}
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
            Every variable was left unassigned. That usually means the
            dictionaries share too little text to group.
          </GateEmptyState>
        )
      ) : (
        /*
          THE UNIFIED GATE-1 LAYOUT (08-16f), on the shared frame since the recurring-controls redesign (08-30b).
          The prod master-detail (workbench) frame with the sidebar on the LEFT: the left aside is the scannable /
          filterable / sortable queue (review-queue), and the right section is the depth for the selected group
          (review-workbench). Gates 2 and 3 wear the same `ConceptWorkbench` and the same `QueueControls`.
        */
        <ConceptWorkbench
          gate="gate1"
          testid="ledger"
          search={{ query, mode: "word-prefix" }}
          detailRef={detailPaneRef}
          toolbar={
            <section
              data-testid="ledger-toolbar"
              aria-label="Narrow the concept groups"
              className="flex flex-col gap-2"
            >
              <QueueSearch
                value={query}
                onChange={(v) => {
                  setQuery(v);
                  setTerms(v.trim() ? [v.trim()] : null);
                }}
                placeholder="Search concept, variable, cohort…"
                ariaLabel="Filter concept groups"
                activeFilters={filterChips.length}
                filters={
                  <>
                    <FilterSection
                      first
                      title="Cohorts"
                      columns={2}
                      lead={
                        <FilterCheck
                          testid="cross-cohort-toggle"
                          checked={xcOnly}
                          onChange={setXcOnly}
                          label="Cross-cohort only"
                          count={nCrossCohort}
                          countTestid="cross-cohort-count"
                        />
                      }
                      hint="Spanning every cohort ticked"
                    >
                      {allCohorts.map((c) => (
                        <FilterCheck
                          key={c}
                          testid={`filter-cohort-${c}`}
                          checked={filters.cohorts.includes(c)}
                          onChange={(on) =>
                            setFilters({
                              ...filters,
                              cohorts: on ? [...filters.cohorts, c] : filters.cohorts.filter((x) => x !== c),
                            })
                          }
                          label={c}
                          count={cohortCounts.get(c) ?? 0}
                        />
                      ))}
                    </FilterSection>
                    <FilterSection title="State">
                      {STATE_FILTER_ORDER.map((st) => (
                        <FilterCheck
                          key={st}
                          testid={`filter-state-${st}`}
                          checked={filters.verdicts.includes(st)}
                          onChange={(on) =>
                            setFilters({
                              ...filters,
                              verdicts: on ? [...filters.verdicts, st] : filters.verdicts.filter((x) => x !== st),
                            })
                          }
                          label={stateLabel(st)}
                          count={groups.filter((g) => g.coherence === st).length}
                          countTestid={`filter-state-${st}-count`}
                        />
                      ))}
                    </FilterSection>
                  </>
                }
              />
              <FilterChips
                chips={filterChips}
                onClear={() => {
                  setXcOnly(false);
                  setFilters(NO_FILTERS);
                }}
              />
            </section>
          }
          tools={
            <>
              <SelectAllShown
                counts={tickedOfShown(
                  visible.map((g) => g.groupId),
                  isInScope,
                  (id) => visibleVars.get(id) ?? 0,
                )}
                busy={bulkBusy}
                frozen={frozen}
                onToggle={(t) => void onBulkScope(t)}
              />
              <SegmentedSort<LedgerSortKey>
                cols={[
                  { k: "concept", label: "Concept" },
                  { k: "verdict", label: "State" },
                  { k: "cohorts", label: "Cohorts" },
                  { k: "vars", label: "Vars" },
                ]}
                sort={colSort}
                onSort={(key) => setColSort((cur) => toggleSort(cur, key))}
                onFlip={() => setColSort((cur) => (cur ? toggleSort(cur, cur.key) : cur))}
              />
            </>
          }
          aboveList={
            !frozen && (
              <div className="px-4">
                <NewGroupControl onCreate={(name) => void createGroup(name)} />
              </div>
            )
          }
          legend={<CohortLegend roster={allCohorts} />}
          rows={
            <>
              {/* The reviewer's own groups lead the list, outside the search and filters: there are a handful,
                  they were just made, and they are where the next drag is going. */}
              {reviewerRows.map((g) => (
                <QueueRow
                  key={g.groupId}
                  query={query}
                  group={g}
                  reviewer
                  scoreTag={scoreTagByGroup.get(g.groupId)}
                  scoreTagSource={scoreInput.source === "suggestion" ? "suggestion" : "match"}
                  roster={allCohorts}
                  count={memberCount(g)}
                  inScope={isInScope(g.groupId)}
                  changed
                  selected={!poolSelected && selectedReviewer?.groupId === g.groupId}
                  readOnly={frozen}
                  onSelect={() => {
                    setSelectedId(g.groupId);
                    setPoolSelected(false);
                  }}
                  onScopeChange={(next) => setGroupScope(g.groupId, next)}
                  onDropMember={(memberId) => void moveMember(memberId, g.groupId)}
                />
              ))}
              {searchEmptied ? (
                <p
                  data-testid="search-empty"
                  data-cause={searchCause}
                  className="px-4 py-6 text-sm text-on-raised-muted"
                >
                  {searchCause === "search"
                    ? "Your search matched no group in this run. "
                    : "Your search matched groups, but the filters or Cross-cohort only are hiding them. "}
                  <button
                    type="button"
                    data-testid="clear-search-inline"
                    onClick={() => setTerms(null)}
                    className="font-semibold text-link-on-raised underline underline-offset-2"
                  >
                    Clear the search to see all {groups.length}{" "}
                    {groups.length === 1 ? "group" : "groups"}.
                  </button>
                </p>
              ) : filteredToNothing ? (
                <p
                  data-testid="filter-empty"
                  className="px-4 py-6 text-sm text-on-raised-muted"
                >
                  No group matches this filter.{" "}
                  <button
                    type="button"
                    data-testid="clear-filters-inline"
                    onClick={() => setFilters(NO_FILTERS)}
                    className="font-semibold text-link-on-raised underline underline-offset-2"
                  >
                    Clear it
                  </button>{" "}
                  to see all {groups.length}{" "}
                  {groups.length === 1 ? "group" : "groups"}.
                </p>
              ) : visible.length === 0 ? (
                <p className="px-4 py-6 text-sm text-on-raised-muted">
                  {xcOnly ? (
                    <>
                      No cross-cohort groups.{" "}
                      <button
                        type="button"
                        onClick={() => setXcOnly(false)}
                        className="font-semibold text-link-on-raised underline underline-offset-2"
                      >
                        Show all {groups.length}
                      </button>
                      .
                    </>
                  ) : (
                    "No groups to show."
                  )}
                </p>
              ) : (
                visible.map((g) => (
                  <QueueRow
                    key={g.groupId}
                    query={query}
                    group={g}
                    scoreTag={scoreTagByGroup.get(g.groupId)}
                    scoreTagSource={scoreInput.source === "suggestion" ? "suggestion" : "match"}
                    roster={allCohorts}
                    count={memberCount(g)}
                    inScope={isInScope(g.groupId)}
                    changed={isChanged(g.groupId)}
                    selected={
                      !poolSelected &&
                      !selectedReviewer &&
                      g.groupId === (detailGroup?.groupId ?? null)
                    }
                    readOnly={frozen}
                    renamedTo={renamedOf(g.groupId)}
                    onSelect={() => {
                      setSelectedId(g.groupId);
                      setPoolSelected(false);
                    }}
                    onScopeChange={(next) => setGroupScope(g.groupId, next)}
                    onDropMember={(memberId) =>
                      void moveMember(memberId, g.groupId)
                    }
                  />
                ))
              )}
            </>
          }
          belowList={
            <button
              type="button"
              data-testid="gate1-pool-entry"
              aria-current={poolSelected}
              onClick={() => setPoolSelected(true)}
              data-drop-over={poolOver ? "true" : undefined}
              onDragOver={
                frozen
                  ? undefined
                  : (e) => {
                      if (!e.dataTransfer.types.includes(MEMBER_DRAG_TYPE))
                        return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setPoolOver(true);
                    }
              }
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setPoolOver(false);
              }}
              onDrop={
                frozen
                  ? undefined
                  : (e) => {
                      e.preventDefault();
                      setPoolOver(false);
                      const memberId = e.dataTransfer.getData(MEMBER_DRAG_TYPE);
                      if (memberId)
                        void moveMember(memberId, UNASSIGNED_GROUP_ID);
                    }
              }
              className={cn(
                // A CARD, not a section label (Bhargav: "not clear this is clickable"). It reads as a
                // control — bordered, hover-fills, a chevron that says "opens a view" — and its dual role
                // (click to review / drop to unassign) is spelled out on the second line rather than guessed.
                "mx-4 mt-2 flex flex-col gap-0.5 rounded-inner border px-3 py-2.5 text-left transition-colors",
                poolSelected
                  ? "border-rule-info bg-surface-info text-accent-on-raised"
                  : "border-rule-on-raised bg-surface-inset text-on-raised hover:border-rule-info hover:bg-surface-info",
                poolOver &&
                  "bg-surface-info [outline:2px_dashed_var(--accent)] [outline-offset:-2px]",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">In no group</span>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {poolCount}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 opacity-70"
                  />
                </span>
              </span>
              <span className="text-xs font-normal normal-case tracking-normal text-on-raised-muted">
                Click to review · or drop a variable here
              </span>
            </button>
          }
          footer={
            <SumBlock
              realized={costSoFar}
              inScopeTotal={quote}
              nIdeals={nIdeals}
              idealsUsd={nIdeals * idealPerGroup}
              wholeCorpus={gate1QuoteUsd([...filledReviewerRows, ...groups], price, idealPerGroup, needsIdeal)}
              nInScope={inScopeGroups.length}
              nGroups={groups.length + filledReviewerRows.length}
            />
          }
          detail={
            <>
              {poolSelected ? (
                <UnassignedPool
                  reviewerRemoved={membership.unassigned}
                  fromPipeline={poolFromPipeline}
                  destinations={[]}
                  membersOf={(id) => membership.byGroup[id] ?? []}
                  sampleOnly={(o) => !hasFullMembership(o)}
                  fieldIndex={fieldIndex}
                  onMove={(memberId, toGroupId) =>
                    void moveMember(memberId, toGroupId)
                  }
                  onRestoreMember={(memberId) => void restoreMember(memberId)}
                  readOnly={frozen}
                  defaultOpen
                />
              ) : selectedReviewer ? (
                <ReviewerGroupDetail
                  group={selectedReviewer}
                  members={membership.byGroup[selectedReviewer.groupId] ?? []}
                  fieldIndex={fieldIndex}
                  movedMembers={movedMemberIds}
                  readOnly={frozen}
                  inScope={isInScope(selectedReviewer.groupId)}
                  onScopeChange={(next) => setGroupScope(selectedReviewer.groupId, next)}
                  onRename={(next) => void renameGroup(selectedReviewer.groupId, next)}
                  onDelete={() => void deleteGroup(selectedReviewer.groupId)}
                  onMove={(memberId, toGroupId) => void moveMember(memberId, toGroupId)}
                  dividedFrom={(() => {
                    const parent = groups.find((g) => g.groupId === selectedReviewer.readjudicatedFrom);
                    return parent ? groupLabel(parent, renamedOf(parent.groupId)).text : undefined;
                  })()}
                />
              ) : detailGroup ? (
                <GroupDetail
                  group={detailGroup}
                  count={memberCount(detailGroup)}
                  readOnly={frozen}
                  renameReadOnly={renameFrozen}
                  renamedTo={renamedOf(detailGroup.groupId)}
                  onRename={(next) => void onRename(detailGroup, next)}
                  inScope={isInScope(detailGroup.groupId)}
                  onScopeChange={(next) =>
                    void scope.write(
                      { groupId: detailGroup.groupId },
                      {
                        chosen: next ? IN_SCOPE : OUT_OF_SCOPE,
                        alternatives: SCOPE_OPTIONS,
                      },
                    )
                  }
                  stale={touchedByRegroup.has(detailGroup.groupId)}
                >
                  <ExpandedGroup
                    highlightIds={scoreHighlight?.groupId === detailGroup.groupId ? scoreHighlight.ids : undefined}
                    group={detailGroup}
                    otherGroups={[]}
                    membersOf={(id) => membership.byGroup[id] ?? []}
                    sampleOnly={(o) => !hasFullMembership(o)}
                    members={membership.byGroup[detailGroup.groupId] ?? []}
                    poolCount={poolCount}
                    fieldIndex={fieldIndex}
                    movedMembers={movedMemberIds}
                    onMove={(memberId, toGroupId) =>
                      void moveMember(memberId, toGroupId)
                    }
                    onRestore={() => void restoreGroup(detailGroup.groupId)}
                    canRegroup={hasFullMembership(detailGroup)}
                    refusal={refusalFor}
                    carvePrice={
                      <>
                        This costs money. Re-splitting this group into distinct
                        concepts is paid work — at most about {formatUsd(price * 2)}{" "}
                        for a group this size — and it starts as soon as you press
                        the button. Each part then joins the list as a group of its
                        own, in scope: at Gate 2 it is matched and gets an ideal
                        description of its own, about{" "}
                        {formatUsd(price + idealPerGroup)} a part, which the Continue
                        quote shows before you commit. Your spend so far updates when
                        the re-split finishes.
                      </>
                    }
                    accepting={accepting === detailGroup.groupId}
                    carveKeyField={
                      carveKeyAsk?.groupId === detailGroup.groupId ? (
                        <RunKeyField reason={carveKeyAsk.reason} action="Accept this division" />
                      ) : undefined
                    }
                    onAcceptCarve={() => void acceptCarve(detailGroup.groupId)}
                    onIgnoreCarve={() => undefined}
                    divisionParts={reviewerRows.filter((g) => g.readjudicatedFrom === detailGroup.groupId)}
                    onUndoDivision={frozen ? undefined : () => void undoDivision(detailGroup.groupId)}
                  />
                </GroupDetail>
              ) : (
                <p className="py-16 text-center text-sm text-on-raised-muted">
                  Select a concept group on the left.
                </p>
              )}
            </>
          }
        />
      )}

      {/* The pool renders full-width when the run grouped nothing — there is no sidebar to host it then. */}
      {groups.length === 0 && (
        <UnassignedPool
          reviewerRemoved={membership.unassigned}
          fromPipeline={poolFromPipeline}
          destinations={[]}
          membersOf={(id) => membership.byGroup[id] ?? []}
          sampleOnly={(o) => !hasFullMembership(o)}
          fieldIndex={fieldIndex}
          onMove={(memberId, toGroupId) => void moveMember(memberId, toGroupId)}
          onRestoreMember={(memberId) => void restoreMember(memberId)}
          readOnly={frozen}
          defaultOpen
        />
      )}

      <CommitBar
        action={pastBar ? pastBar.action : "Continue to Gate 2"}
        // A frozen Gate 1 keeps its bar, but says what its Continue did instead of offering it again (O2).
        done={pastBar?.note}
        keyField={
          continueKeyAsk ? <RunKeyField reason={continueKeyAsk} action="Continue to Gate 2" /> : undefined
        }
        // No amount on the shared demo: its Continue buys nothing (see `onContinue`), and quoting the next gate's
        // cost there would claim a purchase that does not happen.
        total={pinned !== true && groups.length > 0 ? quote : undefined}
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
        // A closed gate buys nothing: the run is already past the charge this bar describes.
        disabled={inScopeGroups.length === 0 || (frozen && pinned !== true)}
      />
    </GateShell>
  );
}
