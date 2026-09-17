import { Button } from "@/components/ui/button";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { COHERENCE_COPY } from "@/components/gate/CoherenceMark";
import { cn } from "@/lib/utils";
import type { CoherenceState } from "@/types";

/**
 * The finding block's tint, keyed on the judge's state (Bhargav, on the mockup: show the split KINDS and
 * the qualify axis, and colour them the mockup's way). `split` is amber — a real over-merge to resolve;
 * `qualify` is blue — an advisory modifier, not a defect. The other two states never reach this component
 * (only flagged groups do), but are mapped so the record is total.
 */
const FINDING_STYLE: Record<CoherenceState, { border: string; surface: string; ink: string }> = {
  split: { border: "border-l-status-warn", surface: "bg-surface-warn", ink: "text-on-warn" },
  qualify: { border: "border-l-status-info", surface: "bg-surface-info", ink: "text-on-info" },
  single: { border: "border-l-status-ok", surface: "bg-surface-ok", ink: "text-on-ok" },
  not_judged: { border: "border-l-rule-on-inset", surface: "bg-surface-inset", ink: "text-on-inset-muted" },
};

/**
 * The judge's proposed division of an over-merged group — a PROPOSAL, never an action already taken.
 *
 * THE STANDING PROHIBITION: an over-merged group is never auto-split or auto-resolved without human
 * review. The pipeline FLAGS; a human resolves. So this renders the proposed sub-concepts and offers three
 * verbs — accept, edit, ignore — and applies none of them on its own.
 *
 * ACCEPT IS THE HUMAN TRIGGER FOR RE-ADJUDICATION (UI-SPEC §0.3, STGD-16), which re-splits the group into
 * distinct child concept-groups (split-only — the parts are assigned later, at Gate 2), and therefore
 * COSTS MONEY. It is opt-in per run and off by default. When the run
 * did not opt in, accept renders as an honest `NotAvailable` naming the reason — not hidden, and not a
 * disabled control with no explanation:
 *
 *   - HIDING it understates what the product can do; the reviewer never learns the capability exists.
 *   - A BARE DISABLED BUTTON tells them they cannot do something without telling them why.
 *
 * Edit and ignore stay live either way: both are free, and both are how a reviewer resolves the flag by
 * hand when the paid path is off.
 */

export interface CarveProposalProps {
  /** The judge's state for this group — `split` (amber) or `qualify` (blue). Sets the finding's tint and label. */
  state: CoherenceState;
  /**
   * ADVISORY mode (qualify): render the finding — eyebrow, theme sentence, axis, KIND pills — but NONE of
   * the split machinery: no "nothing has been changed" truth-claim, no price, no accept/edit/ignore. A
   * `qualify` is one concept with a modifier, advisory not a defect (`isFlagged` excludes it), so there is
   * no proposed division to accept — only the judge's read to show. Off by default: a `split` is a proposal.
   */
  advisory?: boolean;
  /**
   * The judge's proposed sub-concepts, in the order it proposed them.
   *
   * `memberIds` IS OPTIONAL, and its absence is the common case rather than a degraded one. The contract
   * carries the axis the group is fused along and the distinct values on it, but NOT which member belongs
   * to which value — core does not attribute them, because the attribution is what a re-split computes.
   * So a count is rendered only when the caller actually has one; inventing "0 variables" beside a real
   * sub-concept would be a fabricated fact on the screen whose whole job is judging one.
   */
  subConcepts: { id: string; label: string; memberIds?: string[] }[];
  /** One sentence: what axis the judge thinks the group is fused along. */
  axis?: string;
  /** The judge's theme sentence for the group — what it read the members as being about. */
  summary?: string;
  /** Whether accepting is available on THIS RUN. False (the default) is not an error state. */
  readjudicationEnabled: boolean;
  /**
   * What to render in accept's place when it is unavailable. Supplied by the caller because the REASON is
   * the caller's to know — opt-in off, shared demo, no server — and one generic sentence covering three
   * different causes tells the reviewer nothing about which applies to them.
   */
  notAvailable?: React.ReactNode;
  /** The inline price statement, shown BEFORE accept runs and never behind a modal. */
  acceptPrice?: React.ReactNode;
  /** The ids accept will send. Surfaced as data so a gate can assert the set is exactly one. */
  acceptGroupIds?: string[];
  accepting?: boolean;
  onAccept?: () => void;
  onEdit?: () => void;
  onIgnore?: () => void;
  className?: string;
}

export function CarveProposal({
  state,
  advisory = false,
  subConcepts,
  axis,
  summary,
  readjudicationEnabled,
  notAvailable,
  acceptPrice,
  acceptGroupIds,
  accepting = false,
  onAccept,
  onEdit,
  onIgnore,
  className,
}: CarveProposalProps) {
  /**
   * ONE rationale line out of the judge's two fields, rather than two stacked paragraphs.
   *
   * `axis` is what it reads the group as differing ALONG; `summary` is its theme sentence for the group's
   * core. Both are its own words about why it flagged this, so both belong under "Rationale" — and a run
   * carries either, both, or neither. Joined rather than dropped: `summary` is only shown elsewhere on the
   * row when it has been BORROWED as the group's label (Task 1), so on a group that has a generated name
   * this is the only place it appears at all.
   */
  const style = FINDING_STYLE[state];
  const label = COHERENCE_COPY[state].label;
  return (
    <section
      data-testid="carve-proposal"
      data-coherence={state}
      aria-label={`Coherence finding — ${label}`}
      className={cn(
        // A LEFT RULE + soft tint keyed on the judge's STATE, not one amber for both: split is an
        // over-merge to resolve (amber), qualify an advisory modifier (blue). The row's spine already
        // carries the alarm, so this is a tint, not a full surface.
        "flex flex-col gap-3 rounded-inner border-l-4 px-6 py-4",
        style.border,
        style.surface,
        className,
      )}
    >
      <div className="flex flex-col gap-1.5">
        {/* THE EYEBROW + THE JUDGE'S OWN THEME SENTENCE + THE AXIS — the mockup's clean finding, not the
            old heavy proposal box. The proposer stays "the coherence judge" (via COHERENCE_COPY's label),
            the one name the column, the filter and the borrowed-label pill also use. */}
        <p className={cn("text-xs font-bold uppercase tracking-eyebrow", style.ink)}>Coherence finding — {label}</p>
        {summary && <p className={cn("max-w-[68ch] text-sm font-medium", style.ink)}>{summary}</p>}
        {axis && (
          <p className={cn("text-xs", style.ink)}>
            Axis of difference: <span className="font-semibold">{axis}</span>
          </p>
        )}
      </div>

      {/* THE DISTINCT VALUES AS PILLS (mockup parity) — the KINDS the judge read the group as spanning. A
          count is never invented beside them: core does not attribute members to values (see props). */}
      {subConcepts.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {subConcepts.map((sub) => (
            <span
              key={sub.id}
              className="rounded-pill border border-rule-on-raised bg-surface-raised px-2.5 py-0.5 text-xs font-semibold text-on-raised"
            >
              {sub.label}
            </span>
          ))}
        </div>
      ) : advisory ? null : (
        /* THE JUDGE FLAGGED THE FUSION WITHOUT NAMING THE DIVISION. Said plainly rather than papered over:
           an invented sub-concept list would be the screen fabricating the very finding it is asking the
           reviewer to check. Accepting still works — the division is computed by the re-split itself. */
        <p data-testid="carve-no-division" className={cn("max-w-[68ch] text-xs", style.ink)}>
          It did not name the sub-concepts it would divide this into. Accepting works out the division as
          part of the re-split; editing by hand lets you decide it yourself.
        </p>
      )}

      {/* THE TRUTH CLAIM (split only): the pipeline FLAGS and never re-groups, so the panel says, in its
          own words, that it has not already done what it proposes. A qualify is advisory — nothing is
          proposed, so there is nothing to un-apply. */}
      {!advisory && (
        <p data-testid="carve-unapplied" className={cn("max-w-[68ch] text-xs", style.ink)}>
          Nothing has been changed — this is a proposal.
        </p>
      )}

      {/* PRICED INLINE, BEFORE IT RUNS, NEVER BEHIND A MODAL — the same register as the commit bar's
          irreversible-spend statement. A modal on a paid action trains the reviewer to dismiss it. */}
      {!advisory && readjudicationEnabled && acceptPrice && (
        <p data-testid="carve-price" className={cn("max-w-[68ch] text-xs font-semibold", style.ink)}>
          {acceptPrice}
        </p>
      )}

      {!advisory && (
      <div className="flex flex-wrap items-center gap-2">
        {readjudicationEnabled ? (
          <Button
            type="button"
            onClick={onAccept}
            disabled={accepting}
            // The payload as DATA as well as behaviour. "Exactly one group id, never an empty list" is the
            // prohibition this control exists under, and reading it off the request is a gate that only
            // works where a request can be made — which is not the static build every other gate runs in.
            data-group-ids={acceptGroupIds ? JSON.stringify(acceptGroupIds) : undefined}
          >
            {accepting ? "Re-splitting…" : "Accept this division"}
          </Button>
        ) : (
          notAvailable ?? (
            <NotAvailable thing="Re-adjudication" claim="not-enabled" className="bg-surface-raised">
              Accepting a carve re-splits the group into distinct concepts, which costs money, so it is off
              by default. Turn it on at Setup to enable it. Ignoring or editing the proposal by hand still
              works.
            </NotAvailable>
          )
        )}
        <Button type="button" variant="outline" onClick={onEdit}>
          Edit by moving variables
        </Button>
        <Button type="button" variant="ghost" onClick={onIgnore}>
          Ignore the proposal
        </Button>
      </div>
      )}
    </section>
  );
}
