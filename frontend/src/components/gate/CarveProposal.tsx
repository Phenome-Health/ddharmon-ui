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
  /** The judge's proposed sub-concepts, in the order it proposed them. */
  subConcepts: { id: string; label: string; memberIds: string[] }[];
  /** One sentence: what axis the judge thinks the group is fused along. */
  axis?: string;
  /** Whether THIS RUN opted in to re-adjudication. False (the default) is not an error state. */
  readjudicationEnabled: boolean;
  onAccept?: () => void;
  onEdit?: () => void;
  onIgnore?: () => void;
  className?: string;
}

export function CarveProposal({
  subConcepts,
  axis,
  readjudicationEnabled,
  onAccept,
  onEdit,
  onIgnore,
  className,
}: CarveProposalProps) {
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
        <h4 className="text-sm font-semibold text-on-warn">The judge proposes dividing this group</h4>
        <p className="max-w-[68ch] text-xs text-on-warn">
          {axis
            ? `It reads the members as differing along: ${axis}. Nothing has been changed — this is a proposal.`
            : "Nothing has been changed — this is a proposal. Accept it, edit it by moving variables yourself, or ignore it."}
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {subConcepts.map((sub) => (
          <li key={sub.id} className="flex flex-col gap-1 rounded-inner bg-surface-raised px-3 py-2">
            <span className="text-sm font-semibold text-on-raised">{sub.label}</span>
            <span className="font-mono text-xs tabular-nums text-on-raised-muted">
              {sub.memberIds.length} {sub.memberIds.length === 1 ? "variable" : "variables"}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {readjudicationEnabled ? (
          <Button type="button" onClick={onAccept}>
            Accept this division
          </Button>
        ) : (
          <NotAvailable thing="Re-adjudication" claim="not-enabled" className="bg-surface-raised">
            Accepting a carve re-splits the group and re-assigns its parts, which costs money, so it is off
            by default. Turn it on at Setup to enable it. Ignoring or editing the proposal by hand still
            works.
          </NotAvailable>
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
