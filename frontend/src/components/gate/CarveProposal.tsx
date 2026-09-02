import { Button } from "@/components/ui/button";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { cn } from "@/lib/utils";

/**
 * The judge's proposed division of an over-merged group — a PROPOSAL, never an action already taken.
 *
 * THE STANDING PROHIBITION: an over-merged group is never auto-split or auto-resolved without human
 * review. The pipeline FLAGS; a human resolves. So this renders the proposed sub-concepts and offers three
 * verbs — accept, edit, ignore — and applies none of them on its own.
 *
 * ACCEPT IS THE HUMAN TRIGGER FOR RE-ADJUDICATION (UI-SPEC §0.3, STGD-16), which re-splits the group and
 * re-assigns its parts, and therefore COSTS MONEY. It is opt-in per run and off by default. When the run
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
  const rationale = [axis, summary].filter(Boolean).join(" — ");
  return (
    <section
      data-testid="carve-proposal"
      aria-label="Proposed division of this group"
      className={cn(
        // An amber LEFT RULE, not an amber fill: the proposal is an unresolved judgment, and the row's
        // spine already says so — a second full amber surface inside it would double the alarm.
        "flex flex-col gap-3 rounded-inner border-l-4 border-l-status-warn bg-surface-warn px-6 py-4",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        {/*
          A CLAIM, A RATIONALE, AND THE STATE — in that order, one line each (08-16c review).

          Bhargav: *"this box is heavy handed. re-write along the lines of 'LLM judgement proposes
          splitting this group' / 'rationale: ____'."* It had spent three sentences saying what the three
          buttons underneath already say: "Accept it, edit it by moving variables yourself, or ignore it"
          is a caption for controls the reviewer can read.

          WHAT DID NOT GO IS "NOTHING HAS BEEN CHANGED". That is not decoration — it is a truth claim
          about the state of the run, and it is the whole reason this box is safe to ignore. The pipeline
          FLAGS and never re-groups, so the amber panel has to say, in its own words, that it has not
          already done the thing it is proposing.

          THE PROPOSER IS STILL "THE COHERENCE JUDGE" rather than the "LLM judgement" of Bhargav's
          sketch, and that is the one place this departs from his wording. It is the name the Coherence
          column, the four filter chips, `COHERENCE_COPY` and the borrowed-label pill all already use for
          this one component; a second name for it here is exactly what 08-14h's "written ONCE" test
          exists to prevent. The shape he asked for — a claim naming the proposer, then a labelled
          rationale — is what is built.
        */}
        <h4 className="text-sm font-semibold text-on-warn">The coherence judge proposes splitting this group</h4>
        {rationale && (
          <p className="max-w-[68ch] text-xs text-on-warn">
            <span className="font-semibold">Rationale:</span> {rationale}
          </p>
        )}
        <p data-testid="carve-unapplied" className="max-w-[68ch] text-xs text-on-warn">
          Nothing has been changed — this is a proposal.
        </p>
      </div>

      {subConcepts.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {subConcepts.map((sub) => (
            <li key={sub.id} className="flex flex-col gap-1 rounded-inner bg-surface-raised px-3 py-2">
              <span className="text-sm font-semibold text-on-raised">{sub.label}</span>
              {sub.memberIds && (
                <span className="font-mono text-xs tabular-nums text-on-raised-muted">
                  {sub.memberIds.length} {sub.memberIds.length === 1 ? "variable" : "variables"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        /* THE JUDGE FLAGGED THE FUSION WITHOUT NAMING THE DIVISION. Said plainly rather than papered over:
           an invented sub-concept list would be the screen fabricating the very finding it is asking the
           reviewer to check. Accepting still works — the division is computed by the re-split itself. */
        <p data-testid="carve-no-division" className="max-w-[68ch] text-xs text-on-warn">
          It did not name the sub-concepts it would divide this into. Accepting works out the division as
          part of the re-split; editing by hand lets you decide it yourself.
        </p>
      )}

      {/* PRICED INLINE, BEFORE IT RUNS, NEVER BEHIND A MODAL — the same register as the commit bar's
          irreversible-spend statement. A modal on a paid action trains the reviewer to dismiss it. */}
      {readjudicationEnabled && acceptPrice && (
        <p data-testid="carve-price" className="max-w-[68ch] text-xs font-semibold text-on-warn">
          {acceptPrice}
        </p>
      )}

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
              Accepting a carve re-splits the group and re-assigns its parts, which costs money, so it is off
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
    </section>
  );
}
