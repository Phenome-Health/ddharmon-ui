import { useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  Calculator,
  ChevronDown,
  ChevronRight,
  Grid3x3,
  Pencil,
  Quote,
  Scissors,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { BreadthFilter } from "@/components/gate/BreadthFilter";
import {
  MEMBER_DRAG_TYPE,
  MemberChip,
  MemberDropZone,
  UNASSIGNED_GROUP_ID,
} from "@/components/gate/MemberChip";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { SourceRows, hasSourceRows } from "@/components/source-rows";
import { LedgerToolbar } from "@/components/gate/LedgerToolbar";
import { resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import { isGatePast } from "@/lib/gate-routes";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { getCheckpoint, readjudicateGroups, resumeRun } from "@/lib/api";
import { pathForGate } from "@/lib/gate-routes";
import { estimateRunCostBreakdown, formatUsd } from "@/lib/estimate";
import {
  DEFAULT_BUCKET,
  NO_FILTERS,
  applyFilters,
  activeFilterCount,
  bulkScopePlan,
  bulkScopeState,
  cohortRoster,
  groupLabel,
  effectiveMembers,
  isFlagged,
  readjudicationRequest,
  matchTerms,
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
  isParked,
  isTerminal,
  resumeTookEffect,
} from "@/lib/run-state";
import { toggleSort, type ColumnSort } from "@/lib/column-sort";
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
 * Select or deselect every VISIBLE group in one action (08-16c Task 7).
 *
 * PLAIN SELECT/DESELECT LANGUAGE, and that is the 08-16c review talking. This read "All 28 groups shown
 * are in scope." / "Put all 28 shown in scope", and Bhargav: *"this wording is confusing. just use simple
 * 'select all' 'deselect all' language."* The rows carry CHECKBOXES, so select is the verb the control
 * already has; "in scope" is what the selection MEANS and it is still said where the meaning is needed —
 * the "Going forward" filter, the sum block, the Continue bar. It is not a second vocabulary, it is the
 * plain name for the gesture. This spec's own tests had been calling it select-all all along.
 *
 * IT STILL NAMES ITS OWN SCOPE — the word SHOWN, in every string, and the count beside it. "All 117" is a
 * different promise from "all 12 in this filter", and the reviewer has to read which one before pressing
 * rather than discover it after. Simplifying the register may not cost that distinction: a control that
 * silently acted on filtered-out rows is the trap this was written to avoid.
 *
 * IT REPORTS A REAL TRI-STATE. Claiming "all" over a partially-selected set is the same class of lie as
 * a checkbox that submits while looking disabled.
 *
 * IT LOCKS WHILE IT RUNS. There is no bulk endpoint — `write`/`clear` are per-item promises — so this is
 * N sequential requests, and `use-gate-decisions`' conflict handling is written for one decision at a
 * time. A second bulk press landing mid-flight is exactly the half-succeeded burst that has no story here.
 */
function BulkScopeControl({
  count,
  state,
  busy,
  frozen = false,
  onBulk,
}: {
  count: number;
  state: "all" | "none" | "some";
  busy: boolean;
  /** The gate is a record — the control is shown so the state is readable, but it cannot act. */
  frozen?: boolean;
  onBulk: (target: "in" | "out") => void;
}) {
  const noun = count === 1 ? "group" : "groups";
  return (
    <div
      data-testid="bulk-scope"
      data-state={state}
      className="flex flex-wrap items-center gap-2 text-sm text-on-raised-muted"
    >
      <span>
        {state === "all"
          ? `All ${count} ${noun} shown are selected.`
          : state === "none"
            ? `None of the ${count} ${noun} shown are selected.`
            : `Some of the ${count} ${noun} shown are selected.`}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="bulk-scope-in"
        disabled={busy || frozen || count === 0 || state === "all"}
        onClick={() => onBulk("in")}
      >
        Select all {count} shown
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="bulk-scope-out"
        disabled={busy || frozen || count === 0 || state === "none"}
        onClick={() => onBulk("out")}
      >
        Deselect all {count} shown
      </Button>
      {busy && (
        <span role="status" data-testid="bulk-scope-busy">
          Saving…
        </span>
      )}
    </div>
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
  const generated = groupLabel(group).text;

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
      {/* `generated` and `none` carry NO mark. `generated` is the default and a pill on every row says
          nothing (08-16c review); `none` never had one, because "generated" beside "Unnamed group"
          would claim the pipeline produced that string, which it did not. */}
      {label.source === "reviewer" && (
        <span
          data-testid="generated-name-kept"
          className="truncate text-xs text-on-raised-muted"
        >
          ddharmon called it {generated}
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
      <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
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
   * The leftovers as the grid's own shape. `UnassignedField` carries the run's text for a variable the
   * clustering dropped, and `SourceRows` already accepts that as `memberDetails` — so a run whose
   * `fieldIndex` covers these rows renders them as full evidence, and one whose does not falls back to
   * chips by the grid's OWN test rather than by a second guess here.
   */
  const pipelineIds = fromPipeline.map((f) => `${f.cohort}:${f.variable}`);
  const pipelineDetails = fromPipeline.map((f) => ({
    id: `${f.cohort}:${f.variable}`,
    cohort: f.cohort,
    name: f.variable,
    text: f.text,
  }));
  // Every variable in the reviewer's half is there BECAUSE they moved it — the you-changed-it register is
  // the whole half, not a subset of it.
  const movedHere = new Set(reviewerRemoved);
  // Asked of the same expression the grid itself uses, so the two cannot drift — the rule `ExpandedGroup`
  // already follows. A grid that declines to render would otherwise leave a section with no members in it.
  const reviewerGrid = hasSourceRows(reviewerRemoved, undefined, fieldIndex);
  const pipelineGrid = hasSourceRows(pipelineIds, pipelineDetails, fieldIndex);
  const showTray = !readOnly && destinations.length > 0;
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
            <h2 className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
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
                {reviewerRemoved.length > 0 && (
                  <section
                    data-testid="pool-reviewer"
                    className="flex min-w-0 flex-col gap-1"
                  >
                    <h3 className="text-xs font-semibold text-on-raised">
                      You took these out{" "}
                      <span className="font-mono font-normal tabular-nums text-on-raised-muted">
                        {reviewerRemoved.length}
                      </span>
                    </h3>
                    {reviewerGrid ? (
                      <SourceRows
                        memberIds={reviewerRemoved}
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
                        {reviewerRemoved.map((memberId) => {
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

                {fromPipeline.length > 0 && (
                  <section
                    data-testid="pool-pipeline"
                    className="flex min-w-0 flex-col gap-1"
                  >
                    <h3 className="text-xs font-semibold text-on-raised">
                      The clustering never placed these{" "}
                      <span className="font-mono font-normal tabular-nums text-on-raised-muted">
                        {fromPipeline.length}
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
                        {fromPipeline.map((f) => {
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
}: {
  group: ConceptGroup;
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
}) {
  const [ignored, setIgnored] = useState(false);
  const emptied = canRegroup && members.length === 0;
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
        {isFlagged(group) && !ignored && (
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
              <p className="text-xs font-bold uppercase tracking-eyebrow text-on-warn">
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
            <span className="w-full text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">
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
}: {
  realized: number;
  inScopeTotal: number;
  wholeCorpus: number;
  nInScope: number;
  nGroups: number;
}) {
  return (
    <div data-testid="sum-block" className="flex flex-col gap-1">
      <p
        data-sum-line="realized"
        className="text-sm font-semibold text-on-raised"
      >
        {realized > 0 ? (
          <>
            Already spent to reach this gate:{" "}
            <span className="font-mono tabular-nums">
              {formatUsd(realized)}
            </span>{" "}
            — naming the concepts, dividing them, and checking them.
          </>
        ) : (
          <>
            Already spent to reach this gate: nothing — this run is a saved
            replay, so it was not billed.
          </>
        )}
      </p>
      <p
        data-sum-line="in-scope"
        className="text-sm font-normal text-on-raised"
      >
        {nInScope} of {nGroups} {nGroups === 1 ? "group" : "groups"} in scope —{" "}
        <span className="font-mono tabular-nums">
          {formatUsd(inScopeTotal)}
        </span>{" "}
        to match them against common data elements at Gate 2.
      </p>
      <p
        data-sum-line="whole-corpus"
        className="text-sm font-normal text-on-raised-faint"
      >
        All {nGroups} {nGroups === 1 ? "group" : "groups"} would be{" "}
        <span className="font-mono tabular-nums">{formatUsd(wholeCorpus)}</span>
        .
      </p>
    </div>
  );
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
  price,
  count,
  inScope,
  changed,
  selected,
  readOnly,
  renamedTo,
  onSelect,
  onScopeChange,
  onDropMember,
}: {
  group: ConceptGroup;
  /** The declared-score component(s) this group is matched onto, when the run has a composite — rendered
   *  as a tag and the reason this row is pinned to the top of the queue. */
  scoreTag?: string[];
  price: number;
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
        "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 border-l-4 px-4 py-2.5 text-left",
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
      <div className="mt-0.5" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          data-testid="queue-scope"
          checked={inScope}
          disabled={readOnly}
          onCheckedChange={(v) => onScopeChange(v === true)}
          aria-label={`Send ${label.text} to Gate 2`}
        />
      </div>
      <div className="min-w-0">
        {scoreTag && scoreTag.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1">
            {scoreTag.map((name) => (
              <span
                key={name}
                data-testid="queue-score-tag"
                className="inline-flex max-w-full items-center gap-1 rounded-pill border border-accent-action px-2 py-0.5 text-xs font-semibold text-accent-on-raised"
                title={`Matched to the “${name}” component of a declared score`}
              >
                <Calculator className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{name}</span>
              </span>
            ))}
          </div>
        )}
        <div
          className={cn(
            "line-clamp-2 text-sm font-semibold leading-snug",
            selected ? "text-accent-on-raised" : "text-on-raised",
          )}
          title={label.text}
        >
          <span data-label-source={label.source}>{label.text}</span>
          {label.source === "reviewer" && <RenamedMark />}
          {label.source === "judge" && <BorrowedMark />}
          {changed && (
            <span className="ml-1 text-xs font-normal text-status-warn">
              · edited
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <CoherenceMark state={group.coherence} />
          {group.matrixSuspect &&
            (group.coherence === "not_judged" ||
              group.coherence === "single") && (
              <TemplateSuspicion judged={group.coherence === "single"} />
            )}
          {count >= BIG_GROUP_MIN && <LargeGroupMark count={count} />}
          <span className="flex flex-wrap gap-1">
            {group.cohorts.map((c) => (
              <span
                key={c}
                className="rounded bg-surface-inset px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-on-inset-muted"
              >
                {c}
              </span>
            ))}
          </span>
          <span className="text-xs text-on-raised-faint">
            {count} {count === 1 ? "var" : "vars"}
          </span>
        </div>
      </div>
      <span className="whitespace-nowrap pt-0.5 font-mono text-xs tabular-nums text-on-raised-muted">
        {formatUsd(price)}
      </span>
    </div>
  );
}

/**
 * The queue's sort control — the review-queue's sortable columns, condensed to a header strip above a card
 * list. Same shared `ColumnSort`/`toggleSort` the old ledger headers used, so the two surfaces order a
 * group the same way.
 */
function QueueSortHeader({
  sort,
  onSort,
}: {
  sort: ColumnSort<LedgerSortKey> | null;
  onSort: (key: LedgerSortKey) => void;
}) {
  const cols: { k: LedgerSortKey; label: string }[] = [
    { k: "concept", label: "Concept" },
    { k: "verdict", label: "State" },
    { k: "cohorts", label: "# cohorts" },
    { k: "vars", label: "Vars" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-faint">
      <span className="mr-auto">Sort</span>
      {cols.map((c) => (
        <button
          key={c.k}
          type="button"
          data-testid={`sort-${c.k}`}
          onClick={() => onSort(c.k)}
          className={cn(
            "hover:text-accent-on-raised",
            sort?.key === c.k && "text-accent-on-raised",
          )}
        >
          {c.label}
          {sort?.key === c.k ? (sort.dir === "asc" ? " ↑" : " ↓") : " ⇅"}
        </button>
      ))}
    </div>
  );
}

/**
 * The detail-pane WRAPPER around a selected group: its header (name, rename pencil, coherence, scope) and
 * the demoted generated ideal, above the reused `ExpandedGroup` (members, source rows, carve, drag).
 *
 * THE IDEAL IS DEMOTED AND STALE-AWARE. `generate(ideal)` runs once, before the split, and is never
 * regenerated on a membership move — so a description presented as the group's live definition would lie
 * the moment a variable is dragged out. It sits collapsed, labelled "from the original grouping", and
 * opens with a stale warning once the reviewer has edited this group.
 */
function GroupDetail({
  group,
  count,
  readOnly,
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
  renamedTo?: string;
  onRename: (next: string) => void;
  inScope: boolean;
  onScopeChange: (inScope: boolean) => void;
  /** True when the reviewer has changed this group's membership, so the generated ideal is out of date. */
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
                className="text-xl font-semibold leading-tight text-on-raised"
                title={label.text}
              >
                {label.text}
              </h2>
            )}
            {label.source === "reviewer" && !editing && <RenamedMark />}
            {label.source === "judge" && !editing && <BorrowedMark />}
            {!readOnly && !editing && (
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
          className="rounded-inner border border-rule-on-raised"
          open={stale}
        >
          <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Generated ideal CDE{" "}
            <span className="font-normal normal-case tracking-normal text-on-raised-faint">
              — from the original grouping
            </span>
            {stale && (
              <span className="ml-2 rounded-pill border border-status-warn px-2 py-0.5 text-xs normal-case tracking-normal text-status-warn">
                stale — membership changed
              </span>
            )}
          </summary>
          {stale && (
            <p className="px-4 pt-2 text-xs leading-relaxed text-status-warn">
              You changed this group&rsquo;s membership. The description below
              was generated once, before the split, and is not updated by
              reassignment — it now describes a grouping that no longer exists.
              It is regenerated only when the group is re-adjudicated (paid) or
              at Gate 2 on the finalized membership.
            </p>
          )}
          <p className="max-w-[90ch] px-4 py-3 text-sm leading-relaxed text-on-raised-muted">
            {group.idealCde}
          </p>
        </details>
      )}

      {/* SAME FRAME, LATER GATES (mockup parity). The queue on the left and this detail pane are the shell
          every gate reuses; naming what slots in here next is the mockup's own note, kept verbatim in tone. */}
      <div className="rounded-inner border border-dashed border-rule-on-raised bg-surface-inset px-4 py-3 text-xs text-on-inset-muted">
        <span className="font-semibold text-on-inset">
          Same layout, later gates:
        </span>{" "}
        Gate 2 slots a ranked CDE-candidate panel into this pane (score ·
        collection · endorsement · select) plus the cosine to the chosen
        element; Gate 3 adds a transform spec per source row. The left queue and
        this detail frame do not change.
      </div>
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
  const [resuming, setResuming] = useState(false);

  // Cross-cohort-only replaces the bucket partition: on = the harmonization subset, off = every group.
  const [xcOnly, setXcOnly] = useState(false);
  // Master-detail selection. `selectedId` names the group in the detail pane; `poolSelected` swaps the
  // pane to the "In no group" holding area instead.
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  // groupId → group, so the declared-score panel can name a match's concept group and link into its detail.
  const groupsById = useMemo(
    () => new Map(groups.map((g) => [g.groupId, g])),
    [groups],
  );
  // groupId → the declared-score component(s) this run matched onto it, from the latest derived spec. Drives
  // the queue's "pinned to the top + tagged" treatment: a reviewer building a score wants its groups first
  // and named. Empty when the run has no composite, so the queue's order and rows are unchanged without one.
  const scoreTagByGroup = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const match of jobState?.composites?.at(-1)?.matches ?? []) {
      if (!match.conceptId) continue;
      const arr = m.get(match.conceptId) ?? [];
      arr.push(match.component);
      m.set(match.conceptId, arr);
    }
    return m;
  }, [jobState?.composites]);
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
  /**
   * The run has moved PAST this gate, so the screen is a record (08-16c Task 2).
   *
   * Passed into every decision hook below, where `write`/`clear` refuse outright. The refusal is at the
   * WRITE PATH rather than only in the rendering, because a disabled-looking control that still submits is
   * worse than an enabled one — and these decisions have already been consumed by the pipeline.
   */
  const frozen = isGatePast(
    "gate1",
    (jobState?.gatePosition ?? null) as GatePosition | null,
  );
  const scope = useGateDecisions(jobId, "gate1_group_scope", {
    pinned,
    frozen,
  });
  const regroups = useGateDecisions(jobId, "gate1_regroup", { pinned, frozen });
  const renames = useGateDecisions(jobId, "gate1_rename", { pinned, frozen });
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

  // Default IN. A reviewer who scopes nothing continues with everything, which is what "nothing blocks
  // Continue" has to mean; the checkbox REMOVES a group rather than admitting one.
  const isInScope = (groupId: string) =>
    scope.decisions[groupId]?.chosen !== OUT_OF_SCOPE;

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
  const hasScopeDecision = (groupId: string) => groupId in scope.decisions;
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
    // Confirm the move (mockup parity) — a drag has no other acknowledgement, and a member that lands in a
    // collapsed group off-screen is otherwise a change with no visible consequence.
    const { variable } = memberParts(memberId, fieldIndex);
    const destGroup = groups.find((g) => g.groupId === toGroupId);
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
      unplacedFields(
        unassigned,
        moves,
        groups.map((g) => g.groupId),
      ),
    [unassigned, moves, groups],
  );
  const poolCount = membership.unassigned.length + poolFromPipeline.length;

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
      : {
          claim: "deferred" as const,
          reason:
            "Matching needs this run's concepts to have been matched against common data elements, which " +
            "happens at Gate 2. Declare the components now — it is free and it is saved — and the verdict " +
            "fills in once the run has got that far.",
        };

  const [accepting, setAccepting] = useState("");
  async function acceptCarve(groupId: string) {
    setAccepting(groupId);
    try {
      // EXACTLY ONE ID, built by a named function so the prohibition has somewhere to be asserted.
      const { groupIds } = readjudicationRequest(groupId);
      await readjudicateGroups(jobId, groupIds);
      toast.success("Re-split that group — its parts are below");
    } catch (e) {
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
  const inScopeGroups = groups.filter(
    (g) => isInScope(g.groupId) && memberCount(g) > 0,
  );

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
    const plan = bulkScopePlan(ids, target, isInScope, hasScopeDecision);
    if (plan.clear.length === 0 && plan.write.length === 0) return;
    setBulkBusy(true);
    try {
      for (const id of plan.clear) await scope.clear({ groupId: id });
      for (const id of plan.write) {
        await scope.write(
          { groupId: id },
          { chosen: OUT_OF_SCOPE, alternatives: SCOPE_OPTIONS },
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
    setResuming(true);
    try {
      const { target } = await resumeRun(jobId);
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
      const after = await getCheckpoint(jobId).catch(() => null);
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
        spec={jobState?.composites?.at(-1) ?? null}
        matchRefusal={matchRefusal}
        groupsById={groupsById}
        fieldIndex={jobState?.result?.fieldIndex}
        onOpenGroup={(groupId) => {
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
          THE UNIFIED GATE-1 LAYOUT (08-16f). The prod master-detail (workbench) frame with the sidebar on
          the LEFT: the left aside is the scannable / filterable / sortable queue (review-queue), and the
          right section is the depth for the selected group (review-workbench). Each later gate slots its
          own columns and controls into this same frame — Gate 2 the CDE candidates, Gate 3 the specs.
        */
        <div
          data-testid="ledger"
          className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(340px,384px)_minmax(0,1fr)] lg:items-start"
        >
          <aside
            data-testid="gate1-queue"
            className="flex flex-col gap-3 overflow-hidden rounded-card bg-surface-raised py-4 shadow-card lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]"
          >
            <div className="px-4">
              <LedgerToolbar
                search={
                  <input
                    type="search"
                    data-testid="term-search"
                    value={query}
                    onChange={(e) => {
                      const v = e.target.value;
                      setQuery(v);
                      setTerms(v.trim() ? [v.trim()] : null);
                    }}
                    placeholder="Search concept, variable, cohort…"
                    aria-label="Filter concept groups"
                    className="h-8 min-w-[11rem] flex-1 rounded-inner border border-rule-control-on-raised bg-surface-raised px-2.5 text-sm text-on-raised placeholder:text-on-raised-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                }
                count={visible.length}
                total={groups.length}
                crossCohortOnly={xcOnly}
                onCrossCohortOnlyChange={setXcOnly}
                verdict={
                  (filters.verdicts[0] ?? "all") as CoherenceState | "all"
                }
                onVerdictChange={(v) =>
                  setFilters({ ...filters, verdicts: v === "all" ? [] : [v] })
                }
              />
            </div>
            <QueueSortHeader
              sort={colSort}
              onSort={(key) => setColSort((cur) => toggleSort(cur, key))}
            />
            <div className="px-4">
              <BulkScopeControl
                frozen={frozen}
                count={visible.length}
                state={bulkScopeState(
                  visible.map((g) => g.groupId),
                  isInScope,
                )}
                busy={bulkBusy}
                onBulk={(t) => void onBulkScope(t)}
              />
            </div>
            <div
              data-testid="gate1-rows"
              className="flex-1 divide-y divide-rule-quiet-on-raised overflow-y-auto border-y border-rule-quiet-on-raised"
            >
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
                    group={g}
                    scoreTag={scoreTagByGroup.get(g.groupId)}
                    price={price}
                    count={memberCount(g)}
                    inScope={isInScope(g.groupId)}
                    changed={isChanged(g.groupId)}
                    selected={
                      !poolSelected &&
                      g.groupId === (detailGroup?.groupId ?? null)
                    }
                    readOnly={frozen}
                    renamedTo={renamedOf(g.groupId)}
                    onSelect={() => {
                      setSelectedId(g.groupId);
                      setPoolSelected(false);
                    }}
                    onScopeChange={(next) =>
                      void scope.write(
                        { groupId: g.groupId },
                        {
                          chosen: next ? IN_SCOPE : OUT_OF_SCOPE,
                          alternatives: SCOPE_OPTIONS,
                        },
                      )
                    }
                    onDropMember={(memberId) =>
                      void moveMember(memberId, g.groupId)
                    }
                  />
                ))
              )}
            </div>
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
                <span className="text-xs font-bold uppercase tracking-eyebrow">
                  In no group
                </span>
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
            <div className="px-4">
              <SumBlock
                realized={costSoFar}
                inScopeTotal={price * inScopeGroups.length}
                wholeCorpus={price * groups.length}
                nInScope={inScopeGroups.length}
                nGroups={groups.length}
              />
            </div>
          </aside>

          <section
            ref={detailPaneRef}
            data-testid="gate1-detail"
            className="min-w-0 rounded-card bg-surface-raised p-5 shadow-card lg:p-6"
          >
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
            ) : detailGroup ? (
              <GroupDetail
                group={detailGroup}
                count={memberCount(detailGroup)}
                readOnly={frozen}
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
                      This costs money. Re-splitting this group and re-assigning
                      its parts is paid work — about {formatUsd(price * 2)} for
                      a group this size — and it starts as soon as you press the
                      button. Your spend so far updates when it finishes.
                    </>
                  }
                  accepting={accepting === detailGroup.groupId}
                  onAcceptCarve={() => void acceptCarve(detailGroup.groupId)}
                  onIgnoreCarve={() => undefined}
                />
              </GroupDetail>
            ) : (
              <p className="py-16 text-center text-sm text-on-raised-muted">
                Select a concept group on the left.
              </p>
            )}
          </section>
        </div>
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
        // A closed gate buys nothing: the run is already past the charge this bar describes.
        disabled={inScopeGroups.length === 0 || frozen}
      />
    </GateShell>
  );
}
