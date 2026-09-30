import { useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { RunKeyField } from "@/components/gate/RunKeyField";
import { keyAskFor, type KeyRefusal } from "@/lib/run-key";
import { cn } from "@/lib/utils";
import {
  errorOutcome,
  extractPrice,
  extractionRefusalFor,
  initialSelection,
  proposalOutcome,
  statedCodingText,
  underEnumeratedNote,
  type ComponentProposal,
  type ReadDocument,
} from "@/lib/score-proposal";

/**
 * A model reads the score paper and PROPOSES its components; the reviewer confirms the list (08-16e).
 *
 * EXTRACTION PROPOSES, THE REVIEWER DISPOSES. Nothing this component does writes a declaration. Accepting hands
 * the ticked names to `onAccept`, and the host puts them in the SAME components box a reviewer types into — so
 * the declaration is still written by the host's own "Declare these components", and an accepted list is
 * indistinguishable from a typed one (same `composite_swap` rows, same reload, same matching).
 *
 * WHY ACCEPTANCE IS DELIBERATE. Rule 2 — never invent what the source did not state — governs a component list
 * as much as a cutoff, and the reviewer who uploaded a paper to avoid reading 41,000 characters is the least
 * likely to catch an invented item. So the list is labelled as a model's proposal, a name the text does not
 * contain word-for-word is flagged and starts UNTICKED, a coding is shown only where the source stated one,
 * and a document that claims more items than were read says so instead of the gap being filled.
 *
 * FOUR OUTCOMES, never collapsed: a list; "found nothing" (an answer — typing still works); REFUSED (declined
 * before anything was spent); FAILED (attempted, no answer). The host keeps the free text on screen beside
 * this in every one of them: it is the evidence the proposal is checked against.
 *
 * SELF-CONTAINED SO IT CAN MOVE. The declaration is due to move to Setup (todo 2026-09-25). Nothing here knows
 * about a job, a gate or a route: the host injects `extract` and receives the accepted names, and passes the
 * two host facts (`pinned`, `frozen`) that decide whether the paid press is offered at all.
 */
export interface ScoreComponentProposalProps {
  /** The free read's output — the text that will be sent, and what the proposal is checked against. */
  document: ReadDocument;
  /** The paid call. Rejects with an error carrying `status` so REFUSED can be told from FAILED. */
  extract: (doc: ReadDocument) => Promise<ComponentProposal>;
  /** The ticked names, and the score name the document gave (or `""`). Never called without a press. */
  onAccept: (names: string[], scoreName: string) => void;
  /** The shared demo: it never spends, so the press is an honest not-available. */
  pinned?: boolean;
  /** The host screen is a record (a passed gate): the press is refused like every other write. */
  frozen?: boolean;
  className?: string;
}

type Phase = "idle" | "busy" | "found" | "nothing" | "refused" | "failed" | "accepted";

export function ScoreComponentProposal({
  document,
  extract,
  onAccept,
  pinned,
  frozen,
  className,
}: ScoreComponentProposalProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [proposal, setProposal] = useState<ComponentProposal | null>(null);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acceptedCount, setAcceptedCount] = useState(0);
  /** The server refused the extraction for want of a BYOK key (08-28): the field shows here, where it was pressed. */
  const [keyAsk, setKeyAsk] = useState<KeyRefusal | null>(null);

  const refusal = extractionRefusalFor({ nChars: document.nChars, pinned, frozen });

  async function run() {
    if (refusal) return; // the control is not rendered; this is the second layer
    setPhase("busy");
    setMessage("");
    try {
      const p = await extract(document);
      setKeyAsk(null);
      setProposal(p);
      setSelected(initialSelection(p));
      setPhase(proposalOutcome(p));
      setMessage(p.reason);
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      setKeyAsk(keyAskFor(e, { pinned }));
      setProposal(null);
      setPhase(errorOutcome(status));
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  function accept() {
    if (!proposal) return;
    // In the DOCUMENT's order, not the order they were ticked in.
    const names = proposal.components.map((c) => c.name).filter((n) => selected.has(n));
    onAccept(names, proposal.scoreName);
    setAcceptedCount(names.length);
    setProposal(null);
    setPhase("accepted");
  }

  function discard() {
    setProposal(null);
    setPhase("idle");
  }

  const toggle = (name: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const nTicked = selected.size;
  const gap = proposal ? underEnumeratedNote(proposal) : "";

  return (
    <div data-testid="score-extract" data-state={phase} className={cn("flex flex-col gap-2", className)}>
      {/* STEP 2 OF 3, PRICED INLINE BEFORE IT RUNS — the same register as the match price below it. */}
      <p data-testid="score-extract-price" className="max-w-[80ch] text-xs font-semibold text-on-raised">
        {extractPrice(document.nChars)}
      </p>

      {refusal ? (
        <NotAvailable thing="Extracting the components" claim={refusal.claim} slug="score-extract">
          {refusal.reason}
        </NotAvailable>
      ) : (
        <div>
          <Button type="button" variant="outline" onClick={() => void run()} disabled={phase === "busy"}>
            {phase === "busy" ? (
              <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
            )}
            Extract the components (one model call)
          </Button>
        </div>
      )}

      {phase === "nothing" && (
        <p role="status" className="max-w-[80ch] text-xs text-on-raised">
          The model read the document and found no components in it, and nothing was invented to fill the
          gap. If the paper has them in a table that did not survive extraction, read the supplement instead,
          or type them below.
          {message && <span className="block text-on-raised-muted">{message}</span>}
        </p>
      )}
      {phase === "refused" && (
        <p role="alert" className="max-w-[80ch] text-xs font-semibold text-status-danger">
          Extraction was refused, so nothing was charged: {message}
        </p>
      )}
      {phase === "failed" && (
        <p role="alert" className="max-w-[80ch] text-xs font-semibold text-status-danger">
          Extraction did not produce an answer — that is a failure, not a finding that the document has no
          components. {message} The text you read is still here; retry, or type the components yourself.
        </p>
      )}
      {/* A key refusal (08-28): the field sits under the message it answers; the retry is the Extract button. */}
      {keyAsk && (phase === "refused" || phase === "failed") && (
        <RunKeyField reason={keyAsk} action="Extract the components" />
      )}
      {phase === "accepted" && (
        <p role="status" className="max-w-[80ch] text-xs text-on-raised">
          Added {acceptedCount} {acceptedCount === 1 ? "component" : "components"} to the box below. They are
          not declared yet — edit them if you need to, then declare.
        </p>
      )}

      {phase === "found" && proposal && (
        <section
          data-testid="score-proposal"
          aria-label="Components proposed by a model"
          className="flex flex-col gap-2 rounded-inner border border-dashed border-rule-control-on-raised px-4 py-3"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
              Proposed by a model — nothing is declared until you accept it
            </span>
            <span className="max-w-[80ch] text-xs text-on-raised-muted">
              Check each name against the text it came from. A name the text does not contain word-for-word is
              flagged and starts unticked.
            </span>
            {proposal.cached && (
              <span data-testid="score-proposal-cached" className="text-xs text-on-raised-muted">
                Already extracted from this exact text on this run — not charged again.
              </span>
            )}
            {gap && (
              <span data-testid="score-proposal-gap" className="max-w-[80ch] text-xs text-on-warn">
                {gap}
              </span>
            )}
          </div>

          <ul className="flex max-h-80 flex-col gap-1 overflow-auto">
            {proposal.components.map((c) => (
              <li
                key={c.name}
                data-testid="score-proposal-item"
                data-name={c.name}
                data-verbatim={String(c.verbatim)}
                className="flex flex-col gap-0.5 rounded-inner px-2 py-1"
              >
                <label className="flex items-center gap-2 text-sm text-on-raised">
                  <input
                    type="checkbox"
                    checked={selected.has(c.name)}
                    onChange={(e) => toggle(c.name, e.target.checked)}
                    className="h-4 w-4 shrink-0"
                  />
                  {c.name}
                </label>
                {!c.verbatim && (
                  <span
                    data-testid="score-proposal-unverified"
                    className="flex items-center gap-1 pl-6 text-xs text-on-warn"
                  >
                    <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    Not found word-for-word in the text — check it against the paper before keeping it.
                  </span>
                )}
                {c.coding && statedCodingText(c.coding) && (
                  <span data-testid="score-proposal-coding" className="pl-6 text-xs text-on-raised-muted">
                    As stated in the source: <span className="font-mono">{statedCodingText(c.coding)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={accept} disabled={nTicked === 0}>
              Use the {nTicked} ticked {nTicked === 1 ? "component" : "components"}
            </Button>
            <Button type="button" variant="outline" onClick={discard}>
              Discard the proposal
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
