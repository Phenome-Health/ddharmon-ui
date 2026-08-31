import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { Grid3x3, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { GATE1_LEDGER_COLUMNS, Ledger } from "@/components/gate/Ledger";
import { LedgerRow } from "@/components/gate/LedgerRow";
import { CoherenceMark } from "@/components/gate/CoherenceMark";
import { CohortCoverage } from "@/components/gate/CohortCoverage";
import { CommitBar } from "@/components/gate/CommitBar";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { GroupingStrip } from "@/components/gate/GroupingStrip";
import { LedgerToolbar } from "@/components/gate/LedgerToolbar";
import { TermSearch } from "@/components/gate/TermSearch";
import { useGateDecisions } from "@/hooks/use-gate-decisions";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { resumeRun } from "@/lib/api";
import { estimateRunCostBreakdown, formatUsd } from "@/lib/estimate";
import {
  DEFAULT_BUCKET,
  NO_FILTERS,
  applyFilters,
  activeFilterCount,
  isFlagged,
  matchTerms,
  partitionByBreadth,
  pricePerGroup,
  sortGroupsBy,
  type Bucket,
  type LedgerFilters,
  type SortKey,
} from "@/lib/ledger";
import { isParked } from "@/lib/run-state";
import type { ConceptGroup, RunMode } from "@/types";

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
  inScope,
  onScopeChange,
  changed,
}: {
  group: ConceptGroup;
  allCohorts: string[];
  price: number;
  inScope: boolean;
  onScopeChange: (inScope: boolean) => void;
  changed: boolean;
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
              partial sample would silently drop the members it never showed (T-08-89). */}
          {group.nMembers}
          {/* The column header is `Vars`, which a reviewer reads once and a screen-reader user hears
              never: the row announces its own unit so the number is not a bare digit. */}
          <span className="sr-only"> {group.nMembers === 1 ? "variable" : "variables"}</span>
        </>
      }
      cost={price}
      selected={inScope}
      onSelectedChange={onScopeChange}
      unresolved={isFlagged(group)}
      changed={changed}
    >
      {/* The expanded body is 08-15 Task 3's. Until then the row still expands and still says something
          true, rather than opening onto nothing. */}
      <p className="text-sm text-on-raised-muted">
        {group.nMembers} {group.nMembers === 1 ? "variable" : "variables"} from{" "}
        {group.cohorts.join(", ") || "no cohort recorded"}.
      </p>
      {group.coherenceSummary && (
        <p className="max-w-[80ch] text-sm text-on-raised">{group.coherenceSummary}</p>
      )}
    </LedgerRow>
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

  // The shared demo is one read-only run, so its decisions stay in the browser. `pinned` is read from the
  // run's own config rather than guessed; the hook's own guard handles the first render, where it is still
  // undefined because the stream's opening frame carries an empty config.
  const pinned = (jobState?.config as { demo?: boolean } | undefined)?.demo;
  const scope = useGateDecisions(jobId, "gate1_group_scope", { pinned });
  const regroups = useGateDecisions(jobId, "gate1_regroup", { pinned });

  // What Gate 2 is forecast to cost for THIS run, divided across its rows. `assign` runs once per
  // post-split group, so the row count is the call count and every row buys the same call.
  const variables = groups.reduce((n, g) => n + g.nMembers, 0);
  const mode = ((jobState?.config as { mode?: string } | undefined)?.mode ?? "batch") as RunMode;
  const gate2Forecast = useMemo(
    () => estimateRunCostBreakdown(variables, allCohorts.length, mode, true).byGate.gate2.forecast,
    [variables, allCohorts.length, mode],
  );
  const price = pricePerGroup(gate2Forecast, groups.length);

  // Default IN. A reviewer who scopes nothing continues with everything, which is what "nothing blocks
  // Continue" has to mean; the checkbox REMOVES a group rather than admitting one.
  const isInScope = (groupId: string) => scope.decisions[groupId]?.chosen !== OUT_OF_SCOPE;
  const inScopeGroups = groups.filter((g) => isInScope(g.groupId));

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

  // The progress readout's numerator. Counted over the WHOLE corpus rather than the visible bucket: a
  // reviewer who worked the single-cohort tab has reviewed those groups, and a figure that reset when
  // they switched tabs would report the wrong thing. DERIVED from persisted decisions on every read, so
  // it is unchanged by a reload (R6) — a counter in `useState` is the defect this avoids.
  const reviewedCount = groups.filter((g) => isChanged(g.groupId)).length;

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
  const filteredToNothing = visible.length === 0 && groups.length > 0 && activeFilterCount(filters) > 0;
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

  async function onContinue() {
    setResuming(true);
    try {
      await resumeRun(jobId);
      toast.success("Continuing to Gate 2");
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

      <GroupingStrip
        nGroups={groups.length}
        nClusters={clusters}
        nVariables={variables}
        nCrossCohort={nCrossCohort}
      />

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
        {groups.length === 0 ? (
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
              inScope={isInScope(g.groupId)}
              changed={isChanged(g.groupId)}
              onScopeChange={(next) =>
                void scope.write(
                  { groupId: g.groupId },
                  { chosen: next ? IN_SCOPE : OUT_OF_SCOPE, alternatives: SCOPE_OPTIONS },
                )
              }
            />
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
