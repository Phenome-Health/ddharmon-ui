import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GateShell, railFor } from "@/components/gate/GateShell";
import {
  ConceptWorkbench,
  ConceptQueueRow,
  ConceptSortHeader,
  ConceptDetailHeader,
  VerdictPill,
  InheritedPanel,
} from "@/components/gate/ConceptWorkbench";
import { CandidateTable } from "@/components/gate/CandidateTable";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { SourceRows } from "@/components/source-rows";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import { isGatePast } from "@/lib/gate-routes";
import { type ColumnSort, toggleSort } from "@/lib/column-sort";
import {
  affectedSpecCount,
  candidateAlternatives,
  candidateListState,
  needsRepickConfirmation,
  repickConfirmation,
} from "@/lib/gate23";
import type { JobResult, UIRecord, GatePosition } from "@/types";

/**
 * Gate 2 — Concepts to elements. Where the reviewer chooses the target for each concept the run passed on.
 *
 * -- IT INHERITS GATE 1's SCOPE ------------------------------------------------------------------------
 *
 * Gate 1 records a pass/skip per group as `gate1_group_scope` (`in`/`out`). This screen shows ONLY the
 * in-scope groups — a group the reviewer skipped was never sent to assign, so matching it here would offer
 * a decision the run cannot honour. A group with no scope decision defaults to in, matching Gate 1.
 *
 * -- THE SAME MASTER-DETAIL FRAME AS GATE 1 (08-16g) ---------------------------------------------------
 *
 * The queue on the left and the detail on the right are `ConceptWorkbench`, the shell extracted from Gate 1.
 * Gate 2 slots the ranked CDE-candidate table into the detail pane; the frame does not change.
 *
 * -- THE REVIEWER IS NOT BOUND TO THE MODEL's PICK -----------------------------------------------------
 *
 * Bhargav: *"gate 2 should allow for user to repick CDE from list at will, edit genCDE, or even forgo a
 * good CDE match to make up their own CDE. all edits should persist and be tracked."* So: every candidate
 * row is re-pickable; the generated anchor is fully editable (name, definition, units, values); and a
 * "None fit — use my own CDE" control forgoes the catalogue entirely. Each writes a tracked
 * `gate2_candidate_pick` — `chosen: ""` is the schema's "none of these", the generated element's id is
 * "my own". No edit lives only in component state.
 *
 * -- THE ANCHOR CAN LAG THE MEMBERSHIP ------------------------------------------------------------------
 *
 * The generated ideal/GenCDE is produced before Gate 1, on the ORIGINAL grouping. If the reviewer moved
 * variables at Gate 1 (`gate1_regroup`), the anchor describes a grouping that no longer exists. That is
 * flagged here, and — per the 08-16g decision — the backend regenerates the anchor for changed groups when
 * the reviewer continues. Until it lands, the reviewer can also correct the anchor by hand below.
 *
 * TWO PANES, ADAPTED FROM CDEMapper (Wang et al., JAMIA 2025;32:1130-1139, doi:10.1093/jamia/ocaf064,
 * Fig. 4) AND CREDITED ON SCREEN. The framing is fixed: convergent method, extended scope — never a recall
 * claim. `UICandidate` carries only rank/id/definition/cosine, so catalog collection, endorsement, question
 * text and permissible values are a NAMED absence, not a silent one.
 */

type Gate2SortKey = "concept" | "verdict" | "vars";

function conceptLabel(r: UIRecord): string {
  return r.gencde?.preferredName || r.concept || r.idealCde || r.groupId;
}

/** The reviewer's in-progress edit to the anchor, tagged with the concept it belongs to (Gate 2/3 pattern:
 *  no effect, so no reset to mis-order the draft when the selection changes). */
interface AnchorDraft {
  id: string;
  name: string;
  definition: string;
  units: string;
  values: string;
}

export default function Gate2Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState, cancel, error } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  const allRecords: UIRecord[] = useMemo(() => jobState?.result?.records ?? [], [jobState?.result?.records]);
  const fieldIndex = jobState?.result?.fieldIndex ?? {};

  const runConfig = jobState?.config as Record<string, unknown> | undefined;
  const pinned = resolvePinned(runConfig);
  const frozen = isGatePast("gate2", (jobState?.gatePosition ?? null) as GatePosition | null);

  const picks = useGateDecisions(jobId, "gate2_candidate_pick", { pinned, frozen });
  // Read-only here: Gate 3's decisions are what a re-pick would invalidate, so the confirmation's count
  // comes from them. Writing them is Gate 3's job.
  const specs = useGateDecisions(jobId, "gate3_spec_edit", { pinned });
  // Read-only inheritance from Gate 1: scope decides which groups reach this screen; regroups decide which
  // groups' anchors lag their membership. Neither is written here.
  const scope = useGateDecisions(jobId, "gate1_group_scope", { pinned });
  const regroups = useGateDecisions(jobId, "gate1_regroup", { pinned });

  const inScope = (groupId: string) => scope.decisions[groupId]?.chosen !== "out";
  const touchedAtGate1 = useMemo(() => {
    const byGroup = new Set<string>();
    for (const d of Object.values(regroups.decisions)) {
      if (typeof d.chosen === "string" && d.chosen) byGroup.add(d.chosen);
      if (typeof d.fromGroupId === "string" && d.fromGroupId) byGroup.add(d.fromGroupId);
    }
    return byGroup;
  }, [regroups.decisions]);

  const records = useMemo(
    () => allRecords.filter((r) => inScope(r.groupId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRecords, scope.decisions],
  );

  const [selectedId, setSelectedId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<"all" | "adopt" | "refine" | "novel">("all");
  const [colSort, setColSort] = useState<ColumnSort<Gate2SortKey> | null>(null);
  const [draft, setDraft] = useState<AnchorDraft | null>(null);
  const [pendingPick, setPendingPick] = useState<{ chosenId: string; affected: number } | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = records;
    if (q) {
      rows = rows.filter((r) => {
        const hay = `${conceptLabel(r)} ${r.cohorts?.join(" ") ?? ""} ${r.members?.join(" ") ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    if (verdictFilter !== "all") rows = rows.filter((r) => r.verdict === verdictFilter);
    if (colSort) {
      const dir = colSort.dir === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        if (colSort.key === "vars") return (a.nMembers - b.nMembers) * dir;
        if (colSort.key === "verdict") return (a.verdict ?? "").localeCompare(b.verdict ?? "") * dir;
        return conceptLabel(a).localeCompare(conceptLabel(b)) * dir;
      });
    }
    return rows;
  }, [records, query, verdictFilter, colSort]);

  const record = visible.find((r) => r.groupId === selectedId) ?? visible[0] ?? records[0];

  // "Nothing in scope" is a claim about the LOADED result — the reviewer scoped every group out at Gate 1.
  // An unloaded result (the /result fetch has not landed, or failed with a 401 after a key cleared, or the
  // run is still computing) is a different fact and must not be blamed on the scope: `records` is empty then
  // too, but for the opposite reason. Distinguish them by whether the result actually loaded.
  const resultLoaded = jobState?.result != null;
  if (!resultLoaded) {
    return (
      <Shell jobId={jobId} jobState={jobState} cancel={cancel} costSoFar={costSoFar}>
        <GateEmptyState
          heading={error ? "This run's result didn't load" : "Loading this run…"}
          nextStep={
            error
              ? "Reload the page — your gate state is saved. If your API key cleared on reload, re-enter it and press Continue."
              : "One moment while the Gate 2 result loads."
          }
        >
          {error
            ? error.message
            : "Fetching the assignment result. If this persists, reload — nothing here is lost."}
        </GateEmptyState>
      </Shell>
    );
  }

  if (records.length === 0) {
    return (
      <Shell jobId={jobId} jobState={jobState} cancel={cancel} costSoFar={costSoFar}>
        <GateEmptyState
          heading="Nothing was passed from Gate 1"
          nextStep="Go back to Gate 1 and tick at least one group to send on."
        >
          Every group was left out of scope at Gate 1, so the assign stage had nothing to match. This screen
          has nothing to show rather than nothing to say.
        </GateEmptyState>
      </Shell>
    );
  }

  const groupId = record.groupId;
  const gencde = record.gencde;
  const listState = candidateListState(record);
  const alternatives = candidateAlternatives(record.candidates);
  const pick = picks.decisions[groupId];
  const chosenId =
    (typeof pick?.chosen === "string" ? pick.chosen : undefined) ??
    record.candidates.find((c) => c.isChosen)?.cdeId ??
    "";
  const targetIsOwn = chosenId === "" || (!!gencde && chosenId === gencde.gencdeId);
  const anchorLags = touchedAtGate1.has(groupId);

  // Prod parity: the model's pick is pre-selected (chosenId falls back to the isChosen candidate), and the
  // rerank note fires when that pick is NOT the highest-cosine one — concept fit over raw similarity.
  const chosenCand = record.candidates.find((c) => c.cdeId === chosenId);
  const bestCos = record.candidates.reduce((m, c) => Math.max(m, c.cosine), -Infinity);
  const reranked = !!chosenCand && Number.isFinite(bestCos) && chosenCand.cosine < bestCos - 1e-9;

  const gencdeEdit = (pick?.gencdeEdit as Partial<AnchorDraft> | undefined) ?? undefined;
  const anchor: Omit<AnchorDraft, "id"> = {
    name:
      draft?.id === groupId ? draft.name : (gencdeEdit?.name ?? gencde?.preferredName ?? gencde?.title ?? ""),
    // No `idealCde` fallback: that string is the CLUSTER-level pre-split ideal and describes concepts not
    // in this group (a polluted anchor). Until the backend regenerates a per-group ideal (todo), the anchor
    // is the GenCDE for a novel/own target, else empty for the reviewer to author.
    definition: draft?.id === groupId ? draft.definition : (gencdeEdit?.definition ?? gencde?.definition ?? ""),
    units: draft?.id === groupId ? draft.units : (gencdeEdit?.units ?? gencde?.units ?? ""),
    values:
      draft?.id === groupId
        ? draft.values
        : (gencdeEdit?.values ?? gencde?.permissibleValues?.map((v) => `${v.code}=${v.label}`).join(" / ") ?? ""),
  };
  const editAnchor = (patch: Partial<Omit<AnchorDraft, "id">>) => setDraft({ id: groupId, ...anchor, ...patch });

  async function writePick(nextChosen: string, extra?: Record<string, unknown>) {
    await picks.write(
      { groupId },
      {
        chosen: nextChosen,
        alternatives,
        extra: {
          ...(gencdeEdit ? { gencdeEdit } : {}),
          ...extra,
        },
      },
    );
  }

  function choose(nextChosen: string) {
    if (nextChosen === chosenId) return;
    const affected = affectedSpecCount(
      specs.decisions as Record<string, { upstream?: { kind: string; itemKey: string } }>,
      groupId,
    );
    if (!needsRepickConfirmation(affected)) {
      void writePick(nextChosen);
      return;
    }
    setPendingPick({ chosenId: nextChosen, affected });
  }

  async function saveAnchor() {
    // Keep the current target (the generated element / "my own"), and persist the edited fields on the pick.
    const keepChosen = targetIsOwn ? chosenId : gencde?.gencdeId ?? "";
    await writePick(keepChosen, { gencdeEdit: { ...anchor } });
    setDraft(null);
  }

  return (
    <Shell jobId={jobId} jobState={jobState} cancel={cancel} costSoFar={costSoFar}>
      <ConceptWorkbench
        gate="gate2"
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              data-testid="term-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search concept, variable, cohort…"
              aria-label="Filter concepts"
              className="h-8 min-w-[11rem] flex-1 rounded-inner border border-rule-control-on-raised bg-surface-raised px-2.5 text-sm text-on-raised placeholder:text-on-raised-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <Select value={verdictFilter} onValueChange={(v) => setVerdictFilter(v as typeof verdictFilter)}>
              <SelectTrigger className="h-8 w-36" data-testid="verdict-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All verdicts</SelectItem>
                <SelectItem value="adopt">adopt</SelectItem>
                <SelectItem value="refine">refine</SelectItem>
                <SelectItem value="novel">novel</SelectItem>
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs text-on-raised-muted">
              <span className="font-mono tabular-nums text-on-raised">{records.length}</span>{" "}
              {records.length === 1 ? "concept" : "concepts"}
              {visible.length < records.length && (
                <span className="text-on-raised-faint">
                  {" · "}
                  <span className="font-mono tabular-nums">{visible.length}</span> shown
                </span>
              )}
            </span>
          </div>
        }
        sortHeader={
          <ConceptSortHeader<Gate2SortKey>
            cols={[
              { k: "concept", label: "Concept" },
              { k: "verdict", label: "Verdict" },
              { k: "vars", label: "Vars" },
            ]}
            sort={colSort}
            onSort={(key) => setColSort((cur) => toggleSort(cur, key))}
          />
        }
        rows={
          visible.length === 0 ? (
            <p data-testid="search-empty" className="px-4 py-6 text-sm text-on-raised-muted">
              No concept matches your search or filter.{" "}
              <button
                type="button"
                data-testid="clear-search-inline"
                onClick={() => {
                  setQuery("");
                  setVerdictFilter("all");
                }}
                className="font-semibold text-link-on-raised underline underline-offset-2"
              >
                Clear it
              </button>{" "}
              to see all {records.length}.
            </p>
          ) : (
            visible.map((r) => (
              <ConceptQueueRow
                key={r.groupId}
                id={r.groupId}
                testid="gate2-concept"
                label={conceptLabel(r)}
                badges={<VerdictPill verdict={r.verdict} />}
                cohorts={r.cohorts}
                count={r.nMembers}
                selected={r.groupId === groupId}
                onSelect={() => setSelectedId(r.groupId)}
              />
            ))
          )
        }
        detail={
          <div className="flex flex-col gap-4">
            <ConceptDetailHeader
              title={conceptLabel(record)}
              badges={<VerdictPill verdict={record.verdict} />}
              meta={
                <>
                  <span className="font-semibold text-on-raised">{record.nMembers}</span>{" "}
                  {record.nMembers === 1 ? "variable" : "variables"} · {record.cohorts?.join(", ")}
                  {record.route ? <> · route {record.route}</> : null} ·{" "}
                  <span data-testid="current-target">
                    target: {targetIsOwn ? "your own CDE" : chosenId || "none chosen"}
                  </span>
                </>
              }
            />

            {/* INHERITED FROM GATE 1: the variables this concept pooled — the evidence the CDE choice is
                judged against. Read-only here; regrouping is Gate 1's job. Open by default because it is the
                context for the active decision below. */}
            <InheritedPanel
              from="Gate 1"
              label="source variables"
              detail={`${record.nMembers} ${record.nMembers === 1 ? "variable" : "variables"} · ${record.cohorts?.join(", ")}`}
              defaultOpen
              testid="inherited-source-rows"
            >
              <SourceRows memberIds={record.members} memberDetails={record.memberDetails} fieldIndex={fieldIndex} />
            </InheritedPanel>

            {/* WHY THIS CDE — the model's rationale (prod parity). The pick is PRE-SELECTED: `chosenId` falls
                back to the isChosen candidate, so the model's choice is the default target, re-pickable below. */}
            {record.rationale && (
              <div data-testid="model-rationale" className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                  Why this CDE — model rationale
                </span>
                <p className="border-l-2 border-rule-control-on-raised pl-3 text-sm italic text-on-raised">
                  {record.rationale}
                </p>
              </div>
            )}
            {listState === "ranked" && reranked && chosenCand && (
              <div
                data-testid="rerank-note"
                className="flex items-start gap-2 rounded-inner border border-rule-info bg-surface-info px-3 py-2 text-xs text-on-raised"
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-on-raised" />
                <span>
                  The model chose a candidate at cos{" "}
                  <span className="tabular-nums">{chosenCand.cosine.toFixed(3)}</span> over a higher-cosine one
                  at <span className="tabular-nums">{bestCos.toFixed(3)}</span> — it ranks concept fit above raw
                  embedding similarity (see the rationale above).
                </span>
              </div>
            )}

            {/* THE RANKED CANDIDATES — the model's best is pre-selected; click a row to inspect its metadata,
                Select to change the pick. Its three states are opposite claims; none may render as a blank pane. */}
            {listState === "ranked" && (
              <section data-testid="candidate-list" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-on-raised">
                    Ranked candidates ({record.candidates.length})
                  </h3>
                  {(record.floored || record.candidates.length === 1) && (
                    <span data-testid="adopt-floor-note" className="text-xs text-on-raised-muted">
                      The adopt floor still applies — a candidate is not adopted just because it is the only one
                      retrieved.
                    </span>
                  )}
                </div>
                <CandidateTable
                  candidates={record.candidates}
                  chosenId={chosenId}
                  onPick={(c) => choose(c.cdeId)}
                  readOnly={frozen}
                />
              </section>
            )}

            {listState === "novel" && (
              <section
                data-testid="novel-path"
                className="flex flex-col gap-2 rounded-card border border-rule-on-raised bg-surface-inset px-5 py-4"
              >
                <h3 className="text-sm font-semibold text-on-raised">No catalog element fits — the novel path</h3>
                <p className="max-w-[68ch] text-sm text-on-raised-muted">
                  Retrieval ran for this concept and nothing cleared the floor, so ddharmon generated a target
                  for it instead. The generated CDE below is what this concept maps to — edit it if it is not right.
                </p>
              </section>
            )}

            {listState === "failed" && (
              <div data-testid="retrieval-failed">
                <NotAvailable slug="retrieval" thing="Retrieval for this concept" claim="failed">
                  Nothing came back and the pipeline recorded no verdict, so this concept was never assessed.
                  That is a different thing from a concept the catalogue has nothing for. Re-run the assign
                  stage for this run to get an answer.
                </NotAvailable>
              </div>
            )}

            {/* AUTHOR / EDIT THE TARGET — for a NOVEL concept this IS the target; for adopt/refine it is the
                escape hatch when no catalogue element fits. No cluster-level ideal is shown as an anchor (#66):
                that string describes the whole pre-split cluster, not this group. */}
            <section
              data-testid="ideal-anchor"
              className="flex flex-col gap-3 rounded-card border border-rule-on-raised bg-surface-inset px-5 py-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-on-raised">
                  {targetIsOwn ? "Your target — generated CDE (editable)" : "None of these fit? Author your own CDE"}
                </h3>
                <span className="rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs text-on-raised-muted">
                  generated by ddharmon — the target, not a catalog element
                </span>
              </div>

              {anchorLags && (
                <p
                  data-testid="anchor-refresh-pending"
                  className="rounded-inner border-l-4 border-l-status-warn bg-surface-warn px-3 py-2 text-xs text-on-warn"
                >
                  This target was built on the original grouping. You changed this concept&apos;s members at
                  Gate 1, so it is regenerated when you continue — or correct it yourself below.
                </p>
              )}

              <div className="flex flex-col gap-1">
                <label htmlFor="gencde-name" className="text-xs font-semibold text-on-raised">
                  Name
                </label>
                <Input
                  id="gencde-name"
                  data-testid="gencde-name-input"
                  value={anchor.name}
                  disabled={frozen}
                  onChange={(e) => editAnchor({ name: e.target.value })}
                  className="text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="gencde-definition" className="text-xs font-semibold text-on-raised">
                  Definition
                </label>
                <Textarea
                  id="gencde-definition"
                  data-testid="gencde-definition-input"
                  value={anchor.definition}
                  disabled={frozen}
                  onChange={(e) => editAnchor({ definition: e.target.value })}
                  className="min-h-20 text-sm"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor="gencde-units" className="text-xs font-semibold text-on-raised">
                    Units
                  </label>
                  <Input
                    id="gencde-units"
                    data-testid="gencde-units-input"
                    value={anchor.units}
                    disabled={frozen}
                    onChange={(e) => editAnchor({ units: e.target.value })}
                    placeholder="unstated"
                    className="text-sm"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="gencde-values" className="text-xs font-semibold text-on-raised">
                    Permissible values
                  </label>
                  <Input
                    id="gencde-values"
                    data-testid="gencde-values-input"
                    value={anchor.values}
                    disabled={frozen}
                    onChange={(e) => editAnchor({ values: e.target.value })}
                    placeholder="code=label / code=label"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              {!frozen && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button data-testid="gencde-save" variant="outline" size="sm" onClick={() => void saveAnchor()}>
                    Save anchor edits
                  </Button>
                  {!targetIsOwn && (
                    <Button
                      data-testid="author-own-cde"
                      variant="outline"
                      size="sm"
                      onClick={() => choose(gencde?.gencdeId ?? "")}
                    >
                      None fit — use my own CDE
                    </Button>
                  )}
                </div>
              )}
            </section>

            <NotAvailable slug="concept-gate" thing="Concept-match check" claim="not-enabled">
              A second model pass can check whether an assigned element measures the same concept, not just the
              same values. This run did not include it, and it cannot be added to a run that has already
              started — start a new run with it enabled to get the check.
            </NotAvailable>

            {pendingPick && (
              <div
                data-testid="repick-confirm"
                role="alertdialog"
                aria-label="Change the target for this concept"
                className="flex flex-col gap-3 rounded-card border border-rule-on-raised bg-surface-raised px-5 py-4"
              >
                <p className="max-w-[68ch] text-sm text-on-raised">{repickConfirmation(pendingPick.affected)}</p>
                <div className="flex gap-2">
                  <Button
                    data-testid="repick-accept"
                    size="sm"
                    onClick={() => {
                      void writePick(pendingPick.chosenId);
                      setPendingPick(null);
                    }}
                  >
                    Change target
                  </Button>
                  <Button data-testid="repick-cancel" size="sm" variant="outline" onClick={() => setPendingPick(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        }
      />
    </Shell>
  );
}

/** The chrome, hoisted so the empty state and the built screen cannot drift apart. */
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
      gate="gate2"
      jobId={jobId}
      subhead="One concept at a time: the target ddharmon generated for it, the ranked catalogue candidates it was judged against, and the one you choose — or your own."
      rail={railFor("gate2", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      job={jobState}
      onStop={cancel}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate2"}
    >
      <span data-testid="run-status" data-status={jobState?.status ?? "unknown"} className="sr-only">
        Run status: {jobState?.status ?? "unknown"}
      </span>
      {children}
    </GateShell>
  );
}
