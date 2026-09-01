import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { GateTwoLayout } from "@/components/gate/GateTwoLayout";
import { CandidateCard } from "@/components/gate/CandidateCard";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { RelationControl } from "@/components/gate/RelationControl";
import { RetrievalHistogram } from "@/components/gate/RetrievalHistogram";
import { SourceRows } from "@/components/source-rows";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import {
  affectedSpecCount,
  candidateAlternatives,
  candidateListState,
  needsRepickConfirmation,
  repickConfirmation,
  suggestedRelation,
  type SkosRelation,
} from "@/lib/gate23";
import { cn } from "@/lib/utils";
import type { JobResult, UICandidate, UIRecord } from "@/types";

/**
 * Gate 2 — Concepts to elements. Where the reviewer chooses the target for each concept.
 *
 * TWO PANES, ADAPTED FROM CDEMapper (Wang et al., JAMIA 2025;32:1130-1139, doi:10.1093/jamia/ocaf064,
 * Fig. 4) AND CREDITED ON SCREEN. The credit is a requirement, not a courtesy, and its WORDING is the part
 * that matters: we do not beat CDEMapper on recall and the credit must not read as though we do. Convergent
 * method, extended scope.
 *
 * -- THE RE-PICK, AND WHY THE SHIPPED WORKBENCH DOES NOT HAVE ONE ---------------------------------------
 *
 * `workbench.tsx:1-5` states that candidate alternatives are read-only "since our backend records one
 * decision per group rather than a free re-pick". THAT WAS TRUE OF THE WORKBENCH AND IS NO LONGER TRUE OF
 * THE PRODUCT. It describes the `verdict` artifact kind, which validates to approve|refine|reject and has
 * no field naming a different element - so under it, "choose a different CDE" was genuinely unrepresentable.
 *
 * 08-12 added `gate2_candidate_pick`, whose payload REQUIRES `chosen` (the identifier taken) alongside
 * `alternatives` and `optionSetKey`. A free re-pick is exactly what that shape records, the generic
 * `PUT /artifacts/{kind}` route persists it, and three backend tests already pin the behaviour
 * (`test_repick_makes_no_llm_call`, `..._leaves_it_finished_and_derives_stale_specs`, and the
 * nothing-downstream case). The constraint is lifted; the workbench's comment is stale documentation of
 * its own kind, not of this one.
 *
 * -- WHAT THE WIRE DOES NOT CARRY, SAID OUT LOUD --------------------------------------------------------
 *
 * `UICandidate` is `{rank, cdeId, cdeExternalId, definition, cosine, isChosen, llmSuggested}` and NOTHING
 * ELSE - no collection, no endorsement level, no question text, no permissible values. The plan asks for
 * all four on the card; adding them means extending the contract, which is a backend change and out of
 * scope here. So they are rendered as a NAMED ABSENCE rather than quietly dropped: a reviewer who cannot
 * see an endorsement badge must be able to tell whether this element is unendorsed or whether the badge
 * simply is not on the wire. Those are different facts and only one of them is about the element.
 */

/** UI-SPEC 7.4. The framing is fixed: convergent method, extended scope - never a recall claim. */
const CDEMAPPER_CREDIT =
  "Two-pane layout adapted from CDEMapper (Wang et al., JAMIA 2025;32:1130-1139, doi:10.1093/jamia/ocaf064, Fig. 4). " +
  "A convergent method applied to a different scope - cross-cohort dictionary harmonization rather than " +
  "single-study element lookup. We do not report stronger retrieval than CDEMapper and this adaptation makes no such claim.";

function conceptLabel(r: UIRecord): string {
  return r.gencde?.preferredName || r.concept || r.idealCde || r.groupId;
}

export default function Gate2Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState, cancel } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  const records: UIRecord[] = useMemo(() => jobState?.result?.records ?? [], [jobState?.result?.records]);
  const fieldIndex = jobState?.result?.fieldIndex ?? {};

  // Resolved through the SHARED helper, never `config.demo`. A real run's config carries no `demo` key, so
  // reading the flag directly leaves `pinned` undefined forever and confines every decision on every real
  // run to sessionStorage - silently, with no error. That is the 08-15 bug, and it is not re-made here.
  const runConfig = jobState?.config as Record<string, unknown> | undefined;
  const pinned = resolvePinned(runConfig);
  const picks = useGateDecisions(jobId, "gate2_candidate_pick", { pinned });
  const relations = useGateDecisions(jobId, "gate2_relation", { pinned });
  // Read-only here: Gate 3's decisions are what a re-pick would invalidate, so the confirmation's count
  // comes from them. Writing them is Gate 3's job.
  const specs = useGateDecisions(jobId, "gate3_spec_edit", { pinned });

  const [selectedId, setSelectedId] = useState<string>("");
  /**
   * The reviewer's in-progress edit to a generated element, TAGGED WITH THE CONCEPT IT BELONGS TO.
   *
   * THE TAG IS THE FIX, and it is why there is no `useEffect` here. The recorded bug is a detail card whose
   * effect re-seeds its draft from the prop when the selected id changes, so switching away and back
   * repaints the stale original over the reviewer's edit. Keying the draft to a concept makes a draft for
   * another concept simply not apply - there is no reset to mis-order, because there is no reset.
   */
  const [draft, setDraft] = useState<{ id: string; value: string } | null>(null);
  /** A pending re-pick held while the reviewer reads the confirmation. */
  const [pendingPick, setPendingPick] = useState<{ candidate: UICandidate; affected: number } | null>(null);

  const record = records.find((r) => r.groupId === selectedId) ?? records[0];

  if (!record) {
    return (
      <Shell jobState={jobState} cancel={cancel} costSoFar={costSoFar}>
        <GateEmptyState
          heading="Nothing was sent to Gate 2"
          nextStep="Go back to Gate 1 and choose at least one group."
        >
          No group was ticked at Gate 1, so the assign stage had nothing to match. This screen has nothing
          to show rather than nothing to say.
        </GateEmptyState>
      </Shell>
    );
  }

  const groupId = record.groupId;
  const listState = candidateListState(record);
  const alternatives = candidateAlternatives(record.candidates);
  const pick = picks.decisions[groupId];
  const chosenId =
    (typeof pick?.chosen === "string" && pick.chosen) ||
    record.candidates.find((c) => c.isChosen)?.cdeId ||
    "";

  const persistedDefinition = typeof pick?.gencdeDefinition === "string" ? pick.gencdeDefinition : undefined;
  const definitionValue =
    draft?.id === groupId ? draft.value : (persistedDefinition ?? record.gencde?.definition ?? "");

  const relationKey = relations.itemKey({ groupId, targetId: chosenId || "none" });
  const storedRelation = relations.decisions[relationKey]?.chosen;
  const relation = typeof storedRelation === "string" ? (storedRelation as SkosRelation) : undefined;

  async function writePick(candidate: UICandidate, extra?: Record<string, unknown>) {
    await picks.write(
      { groupId },
      {
        chosen: candidate.cdeId,
        alternatives,
        // Carried on the pick rather than in a kind of its own: the edit is part of what this group's
        // decision IS, and a separate row would have to be kept in step with the pick by hand.
        extra: {
          ...(persistedDefinition !== undefined ? { gencdeDefinition: persistedDefinition } : {}),
          ...extra,
        },
      },
    );
  }

  function onChoose(candidate: UICandidate) {
    if (candidate.cdeId === chosenId) return;
    const affected = affectedSpecCount(
      specs.decisions as Record<string, { upstream?: { kind: string; itemKey: string } }>,
      groupId,
    );
    // Nothing downstream => no confirmation and no regeneration step. Offering to regenerate zero specs is
    // a dead control, and a confirmation reading "0 specs" teaches the reviewer the number is noise.
    if (!needsRepickConfirmation(affected)) {
      void writePick(candidate);
      return;
    }
    setPendingPick({ candidate, affected });
  }

  async function saveDefinition() {
    const current = record.candidates.find((c) => c.cdeId === chosenId) ?? record.candidates[0];
    if (!current) return;
    await writePick(current, { gencdeDefinition: definitionValue });
    // The draft is dropped only AFTER the write, so the displayed value falls through to the persisted one
    // rather than blinking back to the original.
    setDraft(null);
  }

  const gencde = record.gencde;

  return (
    <Shell jobState={jobState} cancel={cancel} costSoFar={costSoFar}>
      <GateTwoLayout
        masterLabel="Concepts in this run"
        detailLabel="The chosen target for this concept"
        master={
          <ul className="flex flex-col">
            {records.map((r) => {
              const active = r.groupId === groupId;
              return (
                <li key={r.groupId}>
                  <button
                    type="button"
                    data-testid="gate2-concept"
                    data-concept-id={r.groupId}
                    aria-current={active ? "true" : undefined}
                    onClick={() => setSelectedId(r.groupId)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 border-l-4 px-6 py-3 text-left",
                      active ? "border-l-accent-action bg-surface-inset" : "border-l-transparent",
                    )}
                  >
                    <span className="text-sm font-semibold text-on-raised">{conceptLabel(r)}</span>
                    <span className="text-xs text-on-raised-muted">
                      {r.verdict} - {r.nMembers} variable{r.nMembers === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        }
        detail={
          <>
            {/* The credit leads the pane: an adaptation states its source before it shows its work. */}
            <aside
              data-testid="cdemapper-credit"
              className="border-l-2 border-accent-2-on-raised bg-surface-raised px-6 py-3 text-xs text-on-raised-muted"
            >
              {CDEMAPPER_CREDIT}
            </aside>

            {/* THE ANCHOR, FIRST. It is the target the candidates are judged against; rendering it after
                them inverts the reasoning. Already generated before Gate 1 (UI-SPEC 0.1) and its name is
                the Gate 1 row label - this is the SAME artifact in more depth, and nothing here re-pays
                for it. */}
            <section
              data-testid="ideal-anchor"
              className="flex flex-col gap-2 rounded-card bg-surface-raised px-6 py-4 shadow-card"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-on-raised">
                  What this concept needs: {conceptLabel(record)}
                </h2>
                <span className="rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs text-on-raised-muted">
                  generated by ddharmon - the target, not a catalog element
                </span>
              </div>
              <p className="max-w-[68ch] text-sm text-on-raised-muted">
                {gencde?.definition || record.idealCde || "No anchor description was produced for this concept."}
              </p>
              {gencde && (
                <dl className="flex flex-wrap gap-x-8 gap-y-1 text-xs text-on-raised-muted">
                  <div>
                    <dt className="inline font-semibold">Value structure: </dt>
                    <dd className="inline">{gencde.dataType || "unstated"}</dd>
                  </div>
                  {gencde.units && (
                    <div>
                      <dt className="inline font-semibold">Units: </dt>
                      <dd className="inline">{gencde.units}</dd>
                    </div>
                  )}
                  {gencde.permissibleValues?.length > 0 && (
                    <div className="w-full">
                      <dt className="inline font-semibold">Permissible values: </dt>
                      {/* Scrolls WITHIN the card. A long value list must not grow the page (T-08-99). */}
                      <dd className="mt-1 max-h-32 overflow-y-auto font-mono">
                        {gencde.permissibleValues.map((v) => `${v.code}=${v.label}`).join(" / ")}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              {gencde && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="gencde-definition" className="text-xs font-semibold text-on-raised">
                    Correct this definition
                  </label>
                  <Textarea
                    id="gencde-definition"
                    data-testid="gencde-definition-input"
                    value={definitionValue}
                    onChange={(e) => setDraft({ id: groupId, value: e.target.value })}
                    className="min-h-20 text-sm"
                  />
                  <Button
                    data-testid="gencde-save"
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => void saveDefinition()}
                  >
                    Save definition
                  </Button>
                </div>
              )}
            </section>

            {/* THE THREE CANDIDATE-LIST STATES. A blank pane is never acceptable for any of them, and the
                two empty ones are OPPOSITE claims: one says retrieval ran and nothing fit, the other says
                we never got an answer. */}
            {listState === "ranked" && (
              <section data-testid="candidate-list" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold text-on-raised">
                    Ranked candidates ({record.candidates.length})
                  </h2>
                  {(record.floored || record.candidates.length === 1) && (
                    <span data-testid="adopt-floor-note" className="text-xs text-on-raised-muted">
                      The adopt floor still applies - a candidate is not adopted just because it is the only
                      one retrieved.
                    </span>
                  )}
                </div>

                {/* The generated element sits IN the list because it is one of the things the reviewer may
                    choose - but it is marked so it can never be read as a catalog element. */}
                {gencde && (
                  <CandidateCard
                    id={gencde.gencdeId}
                    name={gencde.preferredName || gencde.title}
                    question={gencde.questionText}
                    values={gencde.permissibleValues?.map((v) => `${v.code}=${v.label}`)}
                    generated
                    chosen={chosenId === gencde.gencdeId}
                    onChoose={() =>
                      onChoose({
                        rank: 0,
                        cdeId: gencde.gencdeId,
                        cdeExternalId: "",
                        definition: gencde.definition,
                        cosine: 0,
                        isChosen: false,
                        llmSuggested: false,
                      })
                    }
                  />
                )}

                <ScrollArea className="max-h-[42vh]">
                  <div className="flex flex-col gap-3">
                    {record.candidates.map((c) => (
                      <CandidateCard
                        key={c.cdeId}
                        id={c.cdeId}
                        name={c.definition || c.cdeId}
                        identifier={c.cdeExternalId || undefined}
                        link={!!c.cdeExternalId}
                        score={c.cosine}
                        chosen={chosenId === c.cdeId}
                        suggested={c.llmSuggested}
                        onChoose={() => onChoose(c)}
                      />
                    ))}
                  </div>
                </ScrollArea>

                {/* A named absence, not a silent one: four catalog attributes the plan asks for are simply
                    not on the wire, and a missing endorsement badge must not read as "unendorsed". */}
                <NotAvailable
                  slug="candidate-attributes"
                  thing="Catalog collection, endorsement, question text and permissible values"
                  claim="deferred"
                >
                  The run contract carries a candidate&apos;s rank, identifier, definition and retrieval score
                  and no other catalog attribute, so those four cannot be shown per candidate. The identifier
                  links out to the catalog&apos;s own page for the element instead.
                </NotAvailable>
              </section>
            )}

            {listState === "novel" && (
              <section
                data-testid="novel-path"
                className="flex flex-col gap-2 rounded-card bg-surface-raised px-6 py-4 shadow-card"
              >
                <h2 className="text-sm font-semibold text-on-raised">No catalog element fits - the novel path</h2>
                <p className="max-w-[68ch] text-sm text-on-raised-muted">
                  Retrieval ran for this concept and nothing cleared the floor, so ddharmon generated a target
                  for it instead. The generated element above is what this concept maps to.
                </p>
              </section>
            )}

            {listState === "failed" && (
              // NOT "no match exists". Retrieval never returned an assessment for this concept, so the one
              // claim this state must never make is the one an empty list looks like.
              <div data-testid="retrieval-failed">
                <NotAvailable slug="retrieval" thing="Retrieval for this concept" claim="failed">
                  Nothing came back and the pipeline recorded no verdict, so this concept was never assessed.
                  That is a different thing from a concept the catalogue has nothing for. Re-run the assign
                  stage for this run to get an answer.
                </NotAvailable>
              </div>
            )}

            <RelationControl
              value={relation}
              suggested={suggestedRelation(record)}
              onChange={(r) =>
                void relations.write(
                  { groupId, targetId: chosenId || "none" },
                  { chosen: r, alternatives: [...(relation ? [relation] : []), r] },
                )
              }
            />

            {/* UI-SPEC 9 row 1 - a permanent absence, stated rather than omitted. */}
            <NotAvailable slug="knowledge-graph" thing="Knowledge-graph context" claim="deferred">
              ddharmon has no query path into KRAKEN yet, so node presence, same-as clique size and assesses
              edge counts cannot be shown. The element&apos;s identifier links out instead.
            </NotAvailable>

            {/* The concept-match decision the 08-24 amendment moved here. It renders as an ABSENCE and not
                as a control, because no route can add a paid stage to a run that already exists - see the
                plan summary's blocker. A button here would 409. */}
            <NotAvailable slug="concept-gate" thing="Concept-match check" claim="not-enabled">
              A second model pass can check whether an assigned element measures the same concept, not just
              the same values. This run did not include it, and it cannot be added to a run that has already
              started - start a new run with it enabled to get the check.
            </NotAvailable>

            {/* The evidence layer under every derived claim on this screen - the SAME grid Gate 1 renders. */}
            <SourceRows memberIds={record.members} memberDetails={record.memberDetails} fieldIndex={fieldIndex} />

            {/* Where the retrieval floor is cutting - the one analytics view this screen's decision needs. */}
            <RetrievalHistogram records={records} />

            {pendingPick && (
              <div
                data-testid="repick-confirm"
                role="alertdialog"
                aria-label="Change the target for this concept"
                className="flex flex-col gap-3 rounded-card border border-rule-on-raised bg-surface-raised px-6 py-4"
              >
                <p className="max-w-[68ch] text-sm text-on-raised">{repickConfirmation(pendingPick.affected)}</p>
                <div className="flex gap-2">
                  <Button
                    data-testid="repick-accept"
                    size="sm"
                    onClick={() => {
                      void writePick(pendingPick.candidate);
                      setPendingPick(null);
                    }}
                  >
                    Change target
                  </Button>
                  <Button
                    data-testid="repick-cancel"
                    size="sm"
                    variant="outline"
                    onClick={() => setPendingPick(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        }
      />
    </Shell>
  );
}

/** The chrome, hoisted so the empty state and the built screen cannot drift apart. */
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
      gate="gate2"
      subhead="One concept at a time: the target ddharmon generated for it, the ranked catalogue candidates it was judged against, and the one you choose."
      rail={railFor("gate2", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      job={jobState}
      onStop={cancel}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate2"}
    >
      {/* Re-deciding never changes the run's status. Rendered so the invariant is observable rather than
          only asserted: buying more work is a later phase and is not reachable from this screen. */}
      <span data-testid="run-status" data-status={jobState?.status ?? "unknown"} className="sr-only">
        Run status: {jobState?.status ?? "unknown"}
      </span>
      {children}
    </GateShell>
  );
}
