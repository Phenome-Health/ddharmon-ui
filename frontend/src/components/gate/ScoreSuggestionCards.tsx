import { Fragment, useState } from "react";
import { CheckCircle2, ChevronDown, CircleDashed } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { NamedGroup } from "@/lib/ledger";
import { countsForCard, type GroupScopeWhy, type SuggestionCard, type SuggestionCardGroup } from "@/lib/score-suggestion-cards";
import { cn } from "@/lib/utils";
import type { FieldDetail } from "@/types";

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
 */
export function ScoreSuggestionCards({
  cards,
  threshold,
  groupsById,
  fieldIndex,
  isGroupInScope,
  groupScopeWhy,
  onGroupScopeChange,
  onOpenGroup,
}: {
  cards: SuggestionCard[];
  /** The payload's own cut-off (core's calibrated value). */
  threshold: number;
  groupsById?: Map<string, NamedGroup>;
  fieldIndex?: Record<string, FieldDetail>;
  isGroupInScope?: (groupId: string) => boolean;
  /** Why a group is in scope, so a card counts only its own (see `countsForCard`). */
  groupScopeWhy?: (groupId: string) => GroupScopeWhy;
  /** Absent on a frozen gate → the checkboxes are read-only. */
  onGroupScopeChange?: (groupId: string, inScope: boolean) => void;
  onOpenGroup?: (groupId: string, matchedIds?: string[]) => void;
}) {
  const nWith = cards.filter((c) => c.nSuggested > 0).length;
  return (
    <Card data-testid="score-suggestions">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Components → this run&rsquo;s groups</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          data-testid="score-suggestion-info"
          className="rounded-md border border-border bg-surface-raised px-3 py-2.5 text-xs"
        >
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Score builder · how suggestions work
          </p>
          <ul className="flex flex-col gap-1 text-on-raised-muted">
            <li>
              <span className="font-semibold text-on-raised">Free search.</span> Each component is searched against
              this run&rsquo;s variables by meaning — retrieval only, no model call, $0.
            </li>
            <li>
              <span className="font-semibold text-on-raised">The figure.</span> How close a group&rsquo;s
              best-matching variable is to the component (0–1 similarity). A search score, not a judgement — the
              verdict is Gate 4&rsquo;s match.
            </li>
            <li>
              <span className="font-semibold text-on-raised">Variables · cohorts.</span> Everything in this
              component&rsquo;s suggested groups that are in scope — group membership, not a match. Gate 4 says which
              of them measure it. Other in-scope groups the search reached say why they are in scope.
            </li>
            {/* SAID ONCE, HERE (Bhargav 2026-10-05): on a 49-item score this caveat repeated on every unsuggested card. */}
            <li>
              <span className="font-semibold text-on-raised">Nothing suggested.</span> This search reached no group at
              the cut-off — not a finding about your cohorts. Gate 4&rsquo;s match decides.
            </li>
          </ul>
          <p className="mt-2 border-t border-rule-quiet-on-raised pt-2 text-on-raised-muted">
            Every group scoring <span className="font-mono text-on-raised">{threshold.toFixed(2)}</span> or higher
            starts in scope and is tagged Suggested — one cut-off for every component. Your checks always win.
          </p>
        </div>
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            <span>
              Components · {nWith}/{cards.length} with a suggestion
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2">
            {cards.map((card) => (
              <SuggestionRow
                key={card.component}
                card={card}
                threshold={threshold}
                groupsById={groupsById}
                fieldIndex={fieldIndex}
                isGroupInScope={isGroupInScope}
                groupScopeWhy={groupScopeWhy}
                onGroupScopeChange={onGroupScopeChange}
                onOpenGroup={onOpenGroup}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
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
  card,
  threshold,
  groupsById,
  fieldIndex,
  isGroupInScope,
  groupScopeWhy,
  onGroupScopeChange,
  onOpenGroup,
}: {
  card: SuggestionCard;
  threshold: number;
  groupsById?: Map<string, NamedGroup>;
  fieldIndex?: Record<string, FieldDetail>;
  isGroupInScope?: (groupId: string) => boolean;
  groupScopeWhy?: (groupId: string) => GroupScopeWhy;
  onGroupScopeChange?: (groupId: string, inScope: boolean) => void;
  onOpenGroup?: (groupId: string, matchedIds?: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const inScope = (gid: string) => isGroupInScope?.(gid) ?? false;
  const counts = (g: SuggestionCardGroup) => countsForCard(g, inScope(g.groupId));
  const scoped = card.groups.filter(counts);
  // What is IN the groups in scope — membership, counted from Gate 1's own groups (never inferred as a match).
  const scopedGroups = scoped.map((g) => groupsById?.get(g.groupId)?.group).filter((g) => g != null);
  const spreadVars = scopedGroups.reduce((s, g) => s + g.nMembers, 0);
  const spreadCohorts = [...new Set(scopedGroups.flatMap((g) => g.cohorts))];
  const suggested = card.nSuggested > 0;
  const nBelow = card.groups.length - card.nSuggested;

  const header = (
    <>
      {suggested ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-status-ok" />
      ) : (
        <CircleDashed className="h-4 w-4 shrink-0 text-on-raised-muted" />
      )}
      <span className="min-w-0 flex-1 text-sm font-semibold text-on-raised">{card.component}</span>
      {card.best != null && (
        <span className="flex shrink-0 items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted/70">
            best similarity
          </span>
          <span data-testid="score-suggestion-similarity" className="font-mono text-xs tabular-nums text-on-raised">
            {card.best.toFixed(2)}
          </span>
        </span>
      )}
    </>
  );

  const renderGroup = (g: SuggestionCardGroup) => {
    const named = groupsById?.get(g.groupId);
    const label = named?.name?.trim() || "Unnamed group";
    const sel = inScope(g.groupId);
    const counted = counts(g);
    // In scope, but not as THIS component's suggestion: checked, neutral, and saying why.
    const why = groupScopeWhy?.(g.groupId);
    const scopeReason =
      sel && !counted
        ? why?.by === "score"
          ? `In scope for ${why.components.join(", ")}`
          : why?.by === "made"
            ? "In scope — your group"
            : "In scope — your choice"
        : null;
    const ci = g.bestMember.indexOf(":");
    const cohort = ci >= 0 ? g.bestMember.slice(0, ci) : "";
    return (
      <div
        data-testid="score-suggestion-group"
        data-group={g.groupId}
        data-suggested={g.suggested ? "true" : "false"}
        data-in-scope={sel ? "true" : "false"}
        data-counted={counted ? "true" : "false"}
        className={cn(
          "rounded-md border",
          counted ? "border-rule-ok bg-surface-ok" : "border-border bg-surface-raised",
          !sel && "opacity-80",
        )}
      >
        <div className="flex items-start gap-2 px-2.5 py-2">
          <input
            type="checkbox"
            data-testid="score-suggestion-group-toggle"
            checked={sel}
            disabled={!onGroupScopeChange}
            onChange={() => onGroupScopeChange?.(g.groupId, !sel)}
            aria-label={`Include the group ${label} in Gate 1's scope`}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer text-status-ok accent-current"
          />
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
              title="In Gate 1's scope, but not as this component's suggestion — so it is not counted on this card. Scope is one set for the gate: unchecking it here takes it out everywhere."
              className="shrink-0 rounded-full border border-dashed border-rule-on-raised px-1.5 py-0.5 text-[10px] font-semibold text-on-raised-muted"
            >
              {scopeReason}
            </span>
          ) : (
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
      className="rounded-md border border-border"
      data-testid="score-suggestion"
      data-component={card.component}
      data-suggested={suggested ? "true" : "false"}
    >
      {card.groups.length > 0 ? (
        <button
          type="button"
          data-testid="score-suggestion-expand"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        >
          {header}
          <ChevronDown
            aria-hidden="true"
            className={cn("h-4 w-4 shrink-0 text-on-raised-muted transition-transform", open && "rotate-180")}
          />
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-2.5">{header}</div>
      )}

      <div className="flex flex-col gap-1.5 px-3 pb-2.5 pl-9 text-xs">
        {!suggested && (
          // ONE short line: what "nothing suggested" means is said once, in the info strip above.
          <p data-testid="score-suggestion-none" className="max-w-[80ch] text-[11px] text-on-raised-muted">
            <span className="font-semibold text-on-raised">Nothing suggested</span>
            {nBelow > 0
              ? ` — ${nBelow} group${nBelow === 1 ? "" : "s"} reached below the cut-off; open to check ${nBelow === 1 ? "it" : "them"}.`
              : " — the search reached no group."}
          </p>
        )}
        {(suggested || scoped.length > 0) && (
          <div
            data-testid="score-suggestion-spread"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-rule-info bg-surface-info px-3 py-2 text-on-raised"
          >
            <span>
              <span className="font-semibold">{card.nSuggested}</span> group{card.nSuggested === 1 ? "" : "s"}{" "}
              suggested
            </span>
            <span className="text-on-raised-muted">·</span>
            <span>
              <span className="font-semibold">{scoped.length}</span> in scope
              {scoped.length > 0 && ":"}
            </span>
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
                <span className="ml-auto text-[11px] font-semibold text-link-on-raised">→ continues to Gate 2</span>
              </>
            )}
          </div>
        )}
      </div>

      {open && card.groups.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2.5 pl-9 text-xs">
          <div className="flex flex-col gap-1.5">
            {card.groups.map((g, i) => (
              <Fragment key={g.groupId}>
                {i > 0 && card.groups[i - 1]!.suggested && !g.suggested && (
                  <div
                    data-testid="score-suggestion-cutoff"
                    className="flex items-center gap-2 py-0.5 text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted"
                  >
                    <span className="h-px flex-1 bg-border" />
                    below the suggestion cut-off {threshold.toFixed(2)}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {renderGroup(g)}
              </Fragment>
            ))}
          </div>
          <p className="mt-2 border-t border-rule-quiet-on-raised pt-2 text-[11px] text-on-raised-muted">
            Checked groups are in Gate 1&rsquo;s scope and continue to Gate 2 — the same checkbox as the list below.
            Refine a group&rsquo;s membership via its <span className="font-semibold">↗</span> link.
          </p>
        </div>
      )}
    </div>
  );
}
