import { Fragment, useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, CircleDashed } from "lucide-react";
import { DisclosureChevron, DisclosureLabel, FOLD_BOX, disclosureRow } from "@/components/ui/disclosure";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cohortRoster, type NamedGroup } from "@/lib/ledger";
import { SCORE_CUTOFF_MAX, SCORE_CUTOFF_MIN, parseCutoff } from "@/lib/score-cutoff";
import {
  countsForCard,
  keptCohorts,
  searchCoverage,
  type GroupScopeWhy,
  type SuggestionCard,
  type SuggestionCardGroup,
} from "@/lib/score-suggestion-cards";
import { cn } from "@/lib/utils";
import type { FieldDetail } from "@/types";

/**
 * A list's suggestion counts, for its header: how many of its concepts the search suggested a group for, and how many
 * distinct groups it suggested across them (round 6's count, now on the list that owns it).
 */
export function suggestionCounts(cards: SuggestionCard[]): { nWith: number; nGroups: number } {
  return {
    nWith: cards.filter((c) => c.nSuggested > 0).length,
    nGroups: new Set(cards.flatMap((c) => c.groups.filter((g) => g.suggested).map((g) => g.groupId))).size,
  };
}

/**
 * The score builder's per-component cards on GATE 1, drawn from the FREE search (08-28, option A).
 *
 * THE OLD LOOK, THE SCOPING HALF. `pages/composite.tsx`'s cards drew from the paid match, which decision Q5 moved to
 * Gate 4 — so a live Gate 1 fell back to a list of names. These keep that card's shape (icon · name · figure, the
 * always-visible spread, the groups behind the chevron with their checkboxes) and feed it what Gate 1 has: the
 * groups each component's search reached.
 *
 * THREE THINGS IT MUST NOT BLUR, because each would be a claim the free search cannot make:
 *   1. The figure is a SEARCH SIMILARITY (a dense cosine), labelled "best similarity" — never in the judge's
 *      "mean best / cohort" slot, which is a different scale. The verdict is Gate 4's.
 *   2. Variables and cohorts count what is IN the groups — membership, not a match (the "cataracts" lesson: an
 *      over-merged group's cohorts over-claim). Gate 4's match says which of them measure the component.
 *   3. Nothing suggested is a RESULT of this search, not a finding about the cohorts — never "missing".
 *
 * THE CHECKBOX IS GATE 1 SCOPE — the ledger checkbox's own path (`onGroupScopeChange`), so the two cannot disagree
 * and a check survives a reload. Scope is ONE set for the whole gate, so a group can be in it for a reason other than
 * this component's suggestion: such a row stays checked but is drawn neutral, says why ("In scope for Migraine",
 * "In scope — your choice"), and is not counted in this card's spread (`countsForCard`). A group BELOW the cut-off is listed under a divider so the reviewer can catch a miss
 * (the paid judge picked 8 groups the 0.62 cut-off did not); checking it puts it in scope like any other.
 *
 * ON A PREVIEW (08-31) THERE IS NO SCOPE AND NO MATCH. A Preview sends nothing on to Gate 2 and never reaches Gate 4,
 * so the cards are the free search alone: no checkbox, no "Gate 2 ✓", no "in scope" count or reason, no word of a
 * verdict to come. A card counts what the search SUGGESTED (above the cut-off) — which groups hold the items listed.
 * That a Preview cannot match is said once, by the panel's refusal, not here.
 */
export function ScoreSuggestionCards({
  preview = false,
  cards,
  threshold,
  groupsById,
  cohorts,
  fieldIndex,
  isGroupInScope,
  groupScopeWhy,
  onGroupScopeChange,
  onOpenGroup,
}: {
  /** A Preview run: the free search alone — no scope, and no later gate named. */
  preview?: boolean;
  cards: SuggestionCard[];
  /** The cut-off the cards are split at: THIS list's (`gate1_score_cutoff` for the list), else the payload's own. */
  threshold: number;
  groupsById?: Map<string, NamedGroup>;
  /** The run's cohorts (Gate 1's roster) — the reached-by-search table's columns. Absent → the groups' own cohorts. */
  cohorts?: readonly string[];
  fieldIndex?: Record<string, FieldDetail>;
  isGroupInScope?: (groupId: string) => boolean;
  /** Why a group is in scope, so a card counts only its own (see `countsForCard`). */
  groupScopeWhy?: (groupId: string) => GroupScopeWhy;
  /** Absent on a frozen gate → the checkboxes are read-only. */
  onGroupScopeChange?: (groupId: string, inScope: boolean) => void;
  onOpenGroup?: (groupId: string, matchedIds?: string[]) => void;
}) {
  const nWith = cards.filter((c) => c.nSuggested > 0).length;
  const coverage = searchCoverage(
    cards,
    cohorts ?? cohortRoster(null, [...(groupsById?.values() ?? [])].map((n) => n.group)),
    (gid) => groupsById?.get(gid)?.group.cohorts,
    // No scope on a Preview: every suggested group counts, which is what the table then shows.
    preview ? () => true : (gid) => isGroupInScope?.(gid) ?? false,
  );
  // Every item under the cut-off (user test 2026-11-03): nothing is ticked, and counts alone read as "nothing
  // happened" — so the cards lead with it and name the closest items, best first.
  const closest =
    nWith === 0
      ? cards
          .map((c) => ({ item: c.component, best: Math.max(...c.groups.map((g) => g.score)) }))
          .filter((c) => Number.isFinite(c.best))
          .sort((a, b) => b.best - a.best)
      : [];
  // A table link opens its card and brings it into view (review round 7). The table sits inside the list's own fold,
  // so a link can only be clicked while the list is open.
  const [openRequest, setOpenRequest] = useState<{ component: string; n: number } | null>(null);
  const goToCard = (component: string) => setOpenRequest((cur) => ({ component, n: (cur?.n ?? 0) + 1 }));
  return (
    // NO FOLD OF ITS OWN (Bhargav, 2026-11-08 round 2: "the block should be collapsible at this level"): the LIST is
    // the one fold (`SpotlightList` in DeclaredScorePanel), headed by its name and these counts — a fold inside it
    // would be a dropdown inside a dropdown.
    <div data-testid="score-suggestions" className="space-y-2">
        {nWith === 0 && cards.length > 0 && (
          <p data-testid="score-suggestions-none-cleared" className="max-w-[80ch] text-sm text-on-raised">
            <span className="font-semibold">
              None of your {cards.length} concept{cards.length === 1 ? "" : "s"} reached the {threshold.toFixed(2)}{" "}
              cut-off
            </span>
            {/* A Preview ticks nothing, so it says only that nothing was suggested (08-31). */}
            {preview ? ", so nothing was suggested." : ", so nothing was ticked for you."}
            {closest.length > 0 && (
              <> Closest: {closest.map((c) => `${c.item} ${c.best.toFixed(2)}`).join(", ")}.</>
            )}{" "}
            {/* The list's own cut-off sits just above this, in the same fold (2026-11-08: one per list). */}
            {preview
              ? "Lower this list’s cut-off above, or open a concept to see its closest groups."
              : "Lower this list’s cut-off above, or open a concept to see its closest groups and tick them yourself."}
          </p>
        )}
        <Collapsible data-testid="search-coverage" className="border-t border-rule-quiet-on-raised pt-2">
          <CollapsibleTrigger data-testid="search-coverage-toggle" className={disclosureRow("raised", "group")}>
            <DisclosureLabel ground="raised">Per-cohort coverage · reached by search</DisclosureLabel>
            <DisclosureChevron ground="raised" className="group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-on-raised-muted">
                    <th scope="col" className="py-1.5 pr-3 font-semibold">
                      Concept
                    </th>
                    {coverage.cohorts.map((c) => (
                      <th
                        key={c}
                        scope="col"
                        data-testid="search-coverage-cohort"
                        className="px-2 py-1.5 text-center font-semibold"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {coverage.rows.map((r) => (
                    <tr
                      key={r.component}
                      data-testid="search-coverage-row"
                      data-component={r.component}
                      className="border-b border-border/60 last:border-0"
                    >
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        <button
                          type="button"
                          data-testid="search-coverage-component"
                          onClick={() => goToCard(r.component)}
                          title={`Open the ${r.component} card below`}
                          className="text-left text-link-on-raised underline decoration-rule-control-on-raised underline-offset-2"
                        >
                          {r.component}
                        </button>
                      </th>
                      {coverage.cohorts.map((c) => {
                        const hit = r.reached.includes(c);
                        return (
                          <td
                            key={c}
                            data-testid="search-coverage-cell"
                            data-cohort={c}
                            data-reached={String(hit)}
                            className="px-2 py-1.5 text-center"
                          >
                            {hit ? (
                              <span role="img" aria-label={`Reached in ${c}`} className="inline-flex">
                                <Circle aria-hidden="true" className="h-2.5 w-2.5 fill-current text-on-raised" />
                              </span>
                            ) : (
                              <span className="sr-only">Not reached by this search</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t border-border font-semibold">
                    <th scope="row" className="py-1.5 pr-3 text-left text-on-raised">
                      Reached
                    </th>
                    {coverage.cohorts.map((c) => (
                      <td
                        key={c}
                        data-testid="search-coverage-total"
                        className="px-2 py-1.5 text-center font-mono tabular-nums text-on-raised"
                      >
                        {coverage.reachedPerCohort[c]}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p data-testid="search-coverage-note" className="mt-2 text-[11px] text-on-raised-muted">
              {/* A Preview keeps no scope and has no Gate 4 table to point to (08-31). */}
              {preview ? (
                <>
                  A dot: one of the concept&rsquo;s suggested groups (similarity {threshold.toFixed(2)} or higher) holds a
                  variable from that cohort &mdash; group membership, not a match. A blank is what this search reached,
                  not a finding about the cohort; lowering the cut-off widens it.
                </>
              ) : (
                <>
                  A dot: one of the concept&rsquo;s suggested groups (similarity {threshold.toFixed(2)} or higher, kept in
                  scope) holds a variable from that cohort &mdash; group membership, not a match. A blank is what this
                  search reached, not a finding about the cohort; lowering the cut-off widens it. Gate 4&rsquo;s match
                  says which variables measure each concept, in its own table.
                </>
              )}
            </p>
          </CollapsibleContent>
        </Collapsible>
        {/* SAID ONCE (round 6): the figure's label heads the column instead of riding on every row. */}
        <div
          data-testid="score-suggestion-columns"
          className="flex items-center justify-between pl-9 pr-9 text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted"
        >
          <span>Concept</span>
          <span>Best similarity</span>
        </div>
        {cards.map((card) => (
          <SuggestionRow
            key={card.component}
            preview={preview}
            card={card}
            openRequest={openRequest?.component === card.component ? openRequest.n : 0}
            threshold={threshold}
            groupsById={groupsById}
            fieldIndex={fieldIndex}
            isGroupInScope={isGroupInScope}
            groupScopeWhy={groupScopeWhy}
            onGroupScopeChange={onGroupScopeChange}
            onOpenGroup={onOpenGroup}
          />
        ))}
    </div>
  );
}

/**
 * How a Spotlight suggestion is made — said once for the panel, above the lists, rather than once per list. It carries
 * NO cut-off (2026-11-08, "implement per list cutoff"): each list has its own, in its own fold (`ScoreCutoffLine`).
 */
export function ScoreSuggestionGuide({ preview = false }: { preview?: boolean }) {
  return (
    <div data-testid="score-suggestion-guide" className="flex flex-col gap-2">
      {/* A FOLD, open until closed (review round 6, Bhargav: "collapsible"). */}
      <Collapsible defaultOpen data-testid="score-suggestion-info" className={FOLD_BOX}>
        <CollapsibleTrigger
          data-testid="score-suggestion-info-toggle"
          className={disclosureRow("raised", "group")}
        >
          <DisclosureLabel ground="raised">Concept Spotlight · how suggestions work</DisclosureLabel>
          <DisclosureChevron ground="raised" className="group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1.5">
        <ul className="flex flex-col gap-1 text-on-raised-muted">
          <li>
            <span className="font-semibold text-on-raised">Free search.</span> Each concept is searched against
            this run&rsquo;s variables by meaning — retrieval only, no model call, $0.
          </li>
          {/* Named as the column names it (review round 7: "The figure." was ambiguous). */}
          {/* ON A PREVIEW (08-31) each line keeps what the search is and drops what a later gate does with it: there
              is no Gate 2 to send a scope to and no Gate 4 match — the panel's refusal says that, once. */}
          <li>
            <span className="font-semibold text-on-raised">Best similarity.</span> How close a group&rsquo;s
            best-matching variable is to the concept (0–1).{" "}
            {preview ? (
              "A search score, not a judgement."
            ) : (
              <>A search score, not a judgement — the verdict is Gate 4&rsquo;s match.</>
            )}
          </li>
          <li>
            <span className="font-semibold text-on-raised">Variables · cohorts.</span>{" "}
            {preview ? (
              <>Everything in this concept&rsquo;s suggested groups — group membership, not a match.</>
            ) : (
              <>
                Everything in this concept&rsquo;s suggested groups that are in scope — group membership, not a match.
                Gate 4 says which of them measure it. Other in-scope groups the search reached say why they are in
                scope.
              </>
            )}
          </li>
          {/* SAID ONCE, HERE (round 5 sweep): "→ continues to Gate 2" sat on every card with a group in scope. */}
          {!preview && (
            <li>
              <span className="font-semibold text-on-raised">In scope.</span> A concept&rsquo;s ticked groups continue
              to Gate 2 with the rest of your scope.
            </li>
          )}
          {/* SAID ONCE, HERE (Bhargav 2026-10-05, again round 6): the per-card sentence repeated on every unsuggested
              card, so a card says it with its dashed marker alone. */}
          <li>
            <span className="font-semibold text-on-raised">Nothing suggested</span> (a dashed circle). This search
            reached no group at its list&rsquo;s cut-off — not a finding about your cohorts.
            {preview ? "" : <> Gate 4&rsquo;s match decides.</>} Open the concept to check the groups under the cut-off.
          </li>
        </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * ONE SPOTLIGHT LIST'S CUT-OFF (2026-11-08, Bhargav on the Lavish review: "implement per list cutoff"), at the head of
 * that list's fold, above its coverage table and its concepts — the things it splits. It is the list's alone: its
 * concepts' cards, coverage dots and headline, and the queue tags and scope it seeds, all split at it; another list's
 * concepts are split at theirs.
 *
 * Reset deletes THIS list's row only, so it is offered only when the list has a row of its own that differs from what
 * the list would read without it — the run-wide cut-off a run may already hold, else core's default — and it names
 * that value. Absent `onChange` (a passed gate) → the value is shown, not editable.
 */
export function ScoreCutoffLine({
  preview = false,
  listName,
  value,
  resetTo,
  onChange,
}: {
  preview?: boolean;
  /** The list it belongs to — named to assistive tech, so two lists' fields are told apart. */
  listName: string;
  value: number;
  /** What reset returns this list to, when it has a row of its own to delete; `null` → nothing to reset. */
  resetTo: number | null;
  /** Set (a number) or reset (`null`) this list's cut-off. Absent → read-only. */
  onChange?: (next: number | null) => void;
}) {
  return (
    <p data-testid="score-cutoff-line" className="text-xs text-on-raised-muted">
      Every group scoring{" "}
      {onChange ? (
        <CutoffInput value={value} onCommit={onChange} label={`Suggestion cut-off for ${listName}`} />
      ) : (
        <span data-testid="score-cutoff-value" className="font-mono text-on-raised">
          {value.toFixed(2)}
        </span>
      )}{" "}
      {/* A Preview has no scope for a suggestion to start in, and no checks to win (08-31). */}
      {preview
        ? "or higher for this list’s concepts is suggested and marked in the queue."
        : "or higher for this list’s concepts starts in scope, marked as a suggestion in the queue. Your checks always win."}
      {onChange && resetTo != null && Math.abs(value - resetTo) > 1e-9 && (
        <>
          {" "}
          <button
            type="button"
            data-testid="score-cutoff-reset"
            onClick={() => onChange(null)}
            className="font-semibold text-link-on-raised underline underline-offset-2"
          >
            reset to {resetTo.toFixed(2)}
          </button>
        </>
      )}
    </p>
  );
}

/** The panel's folds share one outlined box (review round 7: each section "should have an outline"). */

/**
 * The suggestion cut-off, editable in place (review round 6 — Bhargav: "should be user-selectable with default 0.62").
 *
 * A number field in the sentence it governs, so the control and what it does are read together. Enter or leaving the
 * field applies it at once; typing a valid value applies it after a short pause (ArrowUp/ArrowDown included). A value
 * outside [0.30, 0.95] is marked invalid and never applied; leaving the field then puts the applied value back, so the
 * field never shows a cut-off the screen is not using.
 */
function CutoffInput({
  value,
  onCommit,
  label = "Suggestion cut-off",
}: {
  value: number;
  onCommit: (next: number) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState(value.toFixed(2));
  const [invalid, setInvalid] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Follow the applied value (a reset, a reload, another tab's write) — the draft is only ever a pending edit of it.
  useEffect(() => {
    setDraft(value.toFixed(2));
    setInvalid(false);
  }, [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const commit = (text: string, revertIfInvalid: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    const next = parseCutoff(text);
    if (next === null) {
      if (revertIfInvalid) {
        setDraft(value.toFixed(2));
        setInvalid(false);
      } else setInvalid(true);
      return;
    }
    setInvalid(false);
    if (Math.abs(next - value) > 1e-9) onCommit(next);
  };
  return (
    <input
      type="number"
      data-testid="score-cutoff-input"
      aria-label={label}
      aria-invalid={invalid}
      title={`The similarity a group must reach to be suggested — between ${SCORE_CUTOFF_MIN.toFixed(2)} and ${SCORE_CUTOFF_MAX.toFixed(2)}.`}
      min={SCORE_CUTOFF_MIN}
      max={SCORE_CUTOFF_MAX}
      step={0.01}
      value={draft}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (timer.current) clearTimeout(timer.current);
        if (parseCutoff(text) !== null) timer.current = setTimeout(() => commit(text, false), 400);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value, false);
      }}
      onBlur={(e) => commit(e.currentTarget.value, true)}
      // WIDE ENOUGH FOR ITS VALUE (review round 7: "poorly formatted" — the spin arrows ate the last digit). The
      // native arrows go; ArrowUp/ArrowDown still step it, and typing applies after the pause.
      className="mx-0.5 inline-block h-6 w-14 rounded-inner border border-rule-control-on-raised bg-surface-raised px-1.5 py-0 text-center align-middle font-mono text-xs text-on-raised [appearance:textfield] aria-[invalid=true]:border-status-danger [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

/** A variable's readable label: its question text (tags stripped), else its name — never the raw "cohort:var" id. */
function variableLabel(id: string, fieldIndex?: Record<string, FieldDetail>): string {
  const fd = fieldIndex?.[id];
  const raw = (fd?.questionText || fd?.text || fd?.name || "").trim();
  const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text) return text;
  const ci = id.indexOf(":");
  return ci >= 0 ? id.slice(ci + 1) : id;
}

function SuggestionRow({
  preview = false,
  card,
  openRequest = 0,
  threshold,
  groupsById,
  fieldIndex,
  isGroupInScope,
  groupScopeWhy,
  onGroupScopeChange,
  onOpenGroup,
}: {
  /** A Preview run (08-31): no checkbox, no scope count or reason, no Gate 2 — the card counts what was suggested. */
  preview?: boolean;
  card: SuggestionCard;
  /** A link into this card from the coverage table (review round 7): each new number opens it and brings it into view. */
  openRequest?: number;
  threshold: number;
  groupsById?: Map<string, NamedGroup>;
  fieldIndex?: Record<string, FieldDetail>;
  isGroupInScope?: (groupId: string) => boolean;
  groupScopeWhy?: (groupId: string) => GroupScopeWhy;
  onGroupScopeChange?: (groupId: string, inScope: boolean) => void;
  onOpenGroup?: (groupId: string, matchedIds?: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [belowOpen, setBelowOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openRequest) return;
    setOpen(true);
    // After the list (and this card) have laid out, so the scroll lands on the card's real position.
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: "center" }));
  }, [openRequest]);
  // No scope on a Preview (08-31): every group is taken as kept, so a card counts exactly what the search suggested.
  const inScope = (gid: string) => (preview ? true : (isGroupInScope?.(gid) ?? false));
  const counts = (g: SuggestionCardGroup) => countsForCard(g, inScope(g.groupId));
  const scoped = card.groups.filter(counts);
  // What is IN the groups in scope — membership, counted from Gate 1's own groups (never inferred as a match). The
  // cohorts come from `keptCohorts`, as the reached-by-search table's do, so the card and the table cannot disagree.
  const scopedGroups = scoped.map((g) => groupsById?.get(g.groupId)?.group).filter((g) => g != null);
  const spreadVars = scopedGroups.reduce((s, g) => s + g.nMembers, 0);
  const spreadCohorts = keptCohorts(card, (gid) => groupsById?.get(gid)?.group.cohorts, inScope);
  const suggested = card.nSuggested > 0;
  const nBelow = card.groups.length - card.nSuggested;

  const header = (
    <>
      {suggested ? (
        <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-status-ok" />
      ) : (
        <span data-testid="score-suggestion-none" role="img" aria-label="Nothing suggested" title="Nothing suggested">
          <CircleDashed aria-hidden="true" className="h-4 w-4 shrink-0 text-on-raised-muted" />
        </span>
      )}
      <span className="min-w-0 flex-1 text-sm font-semibold text-on-raised">{card.component}</span>
      {card.best != null && (
        <span
          data-testid="score-suggestion-similarity"
          className={cn("shrink-0 font-mono text-xs tabular-nums", suggested ? "text-on-raised" : "text-on-raised-muted")}
        >
          {card.best.toFixed(2)}
        </span>
      )}
    </>
  );

  const renderGroup = (g: SuggestionCardGroup) => {
    const named = groupsById?.get(g.groupId);
    const label = named?.name?.trim() || "Unnamed group";
    const sel = inScope(g.groupId);
    const counted = counts(g);
    // In scope, but not as THIS component's suggestion: checked, neutral, and saying why. Never on a Preview, which
    // has no scope for a group to be in (08-31).
    const why = groupScopeWhy?.(g.groupId);
    const scopeReason =
      !preview && sel && !counted
        ? why?.by === "score"
          ? `In scope for ${why.components.join(", ")}`
          : why?.by === "made"
            ? "In scope — your group"
            : why?.by === "auto"
              ? "In scope — sent by Full auto"
              : "In scope — your choice"
        : null;
    const ci = g.bestMember.indexOf(":");
    const cohort = ci >= 0 ? g.bestMember.slice(0, ci) : "";
    return (
      <div
        data-testid="score-suggestion-group"
        data-group={g.groupId}
        data-suggested={g.suggested ? "true" : "false"}
        data-in-scope={preview ? undefined : sel ? "true" : "false"}
        data-counted={counted ? "true" : "false"}
        className={cn(
          "rounded-md border",
          counted ? "border-rule-ok bg-surface-ok" : "border-border bg-surface-raised",
          // A Preview dims what the search left below the cut-off, as a paid card dims what is out of scope.
          (preview ? !counted : !sel) && "opacity-80",
        )}
      >
        <div className="flex items-start gap-2 px-2.5 py-2">
          {/* The box is Gate 1 scope; a Preview has none, so the row is the search's answer and its link (08-31). */}
          {!preview && (
            <input
              type="checkbox"
              data-testid="score-suggestion-group-toggle"
              checked={sel}
              disabled={!onGroupScopeChange}
              onChange={() => onGroupScopeChange?.(g.groupId, !sel)}
              aria-label={`Include the group ${label} in Gate 1's scope`}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer text-status-ok accent-current"
            />
          )}
          <div className="min-w-0 flex-1">
            {onOpenGroup ? (
              <button
                type="button"
                data-testid="score-open-group"
                data-group={g.groupId}
                onClick={() => onOpenGroup(g.groupId, g.bestMember ? [g.bestMember] : [])}
                className="text-left text-xs font-semibold text-link-on-raised underline decoration-rule-control-on-raised underline-offset-2"
                title="Open this concept group on Gate 1"
              >
                {label} ↗
              </button>
            ) : (
              <span className="text-xs font-semibold text-on-raised">{label}</span>
            )}
            {named?.generatedName && (
              <span className="block text-[11px] text-on-raised-muted">ddharmon called it {named.generatedName}</span>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-on-raised-muted">
              <span className="font-mono tabular-nums text-on-raised">{g.score.toFixed(2)}</span>
              {named && (
                <span>
                  {named.group.nMembers} variable{named.group.nMembers === 1 ? "" : "s"} ·{" "}
                  {named.group.cohorts.join(", ")}
                </span>
              )}
            </div>
            {g.bestMember && (
              <div
                data-testid="score-suggestion-best"
                className="mt-1.5 flex items-baseline gap-2 border-l border-border/60 pl-2.5 text-[11px]"
              >
                {cohort && (
                  <span className="mt-px shrink-0 rounded border border-rule-on-raised px-1 py-0.5 font-mono text-[10px] font-semibold text-on-raised-muted">
                    {cohort}
                  </span>
                )}
                <span
                  className="line-clamp-2 min-w-0 flex-1 text-on-raised-muted"
                  title={variableLabel(g.bestMember, fieldIndex)}
                >
                  <span className="font-semibold text-on-raised">Best match: </span>
                  {variableLabel(g.bestMember, fieldIndex)}
                  {g.bestOption && <span className="italic"> · “{g.bestOption}”</span>}
                </span>
              </div>
            )}
          </div>
          {scopeReason ? (
            <span
              data-testid="score-suggestion-scope-why"
              title="In Gate 1's scope, but not as this concept's suggestion — so it is not counted for it. Scope is one set for the gate: unchecking it here takes it out everywhere."
              className="shrink-0 rounded-full border border-dashed border-rule-on-raised px-1.5 py-0.5 text-[10px] font-semibold text-on-raised-muted"
            >
              {scopeReason}
            </span>
          ) : (
            // Nothing goes on to Gate 2 from a Preview (08-31).
            !preview &&
            sel && (
              <span className="shrink-0 rounded-full border border-rule-info bg-surface-info px-1.5 py-0.5 text-[10px] font-semibold text-link-on-raised">
                Gate 2 ✓
              </span>
            )
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className="rounded-md border border-border"
      data-testid="score-suggestion"
      data-component={card.component}
      data-suggested={suggested ? "true" : "false"}
    >
      {card.groups.length > 0 ? (
        // The whole row lights on hover and folds, like every other fold (round 6) — `disclosureRow`, inset by the
        // card's own padding rather than bled past it.
        <button
          type="button"
          data-testid="score-suggestion-expand"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(disclosureRow("raised"), "mx-0 my-0 w-full justify-start rounded-md px-3 py-2.5")}
        >
          {header}
          <DisclosureChevron ground="raised" open={open} />
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-2.5 pr-9">{header}</div>
      )}

      <div className="flex flex-col gap-1.5 px-3 pl-9 text-xs empty:hidden [&:not(:empty)]:pb-2.5">
        {(suggested || scoped.length > 0) && (
          <div
            data-testid="score-suggestion-spread"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-rule-info bg-surface-info px-3 py-2 text-on-raised"
          >
            <span>
              <span className="font-semibold">{card.nSuggested}</span> group{card.nSuggested === 1 ? "" : "s"}{" "}
              suggested
              {/* A Preview counts what was suggested, so the figures follow straight on (08-31). */}
              {preview && scoped.length > 0 && ":"}
            </span>
            {!preview && (
              <>
                <span className="text-on-raised-muted">·</span>
                <span>
                  <span className="font-semibold">{scoped.length}</span> in scope
                  {scoped.length > 0 && ":"}
                </span>
              </>
            )}
            {scoped.length > 0 && (
              <>
                <span>
                  <span className="font-semibold">{spreadVars}</span> variable{spreadVars === 1 ? "" : "s"}
                </span>
                <span className="text-on-raised-muted">·</span>
                <span>
                  <span className="font-semibold">{spreadCohorts.length}</span> cohort
                  {spreadCohorts.length === 1 ? "" : "s"}
                  {spreadCohorts.length > 0 && (
                    <span className="text-on-raised-muted"> ({spreadCohorts.join(", ")})</span>
                  )}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {open && card.groups.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2.5 pl-9 text-xs">
          <div className="flex flex-col gap-1.5">
            {card.groups.filter((g) => g.suggested).map((g) => (
              <Fragment key={g.groupId}>{renderGroup(g)}</Fragment>
            ))}
            {nBelow > 0 && (
              // THE CUT-OFF LINE IS THE FOLD (round 6, Bhargav: "collapsible and hidden by default"): what the search
              // reached below it is there to catch a miss, not to read every time.
              <button
                type="button"
                data-testid="score-suggestion-cutoff"
                aria-expanded={belowOpen}
                onClick={() => setBelowOpen((o) => !o)}
                className={cn(
                  disclosureRow("raised"),
                  "mx-0 my-0 w-full gap-2 py-1 text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted",
                )}
              >
                <span className="h-px flex-1 bg-border" />
                {nBelow} group{nBelow === 1 ? "" : "s"} below the cut-off {threshold.toFixed(2)}
                <span className="h-px flex-1 bg-border" />
                <DisclosureChevron ground="raised" open={belowOpen} className="h-3.5 w-3.5" />
              </button>
            )}
            {belowOpen &&
              card.groups.filter((g) => !g.suggested).map((g) => <Fragment key={g.groupId}>{renderGroup(g)}</Fragment>)}
          </div>
          <p className="mt-2 border-t border-rule-quiet-on-raised pt-2 text-[11px] text-on-raised-muted">
            {/* No checkbox on a Preview, so only the way into a group is left to say (08-31). */}
            {!preview && (
              <>Checked groups are in Gate 1&rsquo;s scope and continue to Gate 2 — the same checkbox as the list below. </>
            )}
            Refine a group&rsquo;s membership via its <span className="font-semibold">↗</span> link.
          </p>
        </div>
      )}
    </div>
  );
}
