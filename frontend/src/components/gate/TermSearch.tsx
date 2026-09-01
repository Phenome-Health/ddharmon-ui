import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Concept search that takes a LIST of terms — one per line, or pasted.
 *
 * A LIST, NOT A BOX. A reviewer scoping a run has a list: the components of a score, the variables a
 * paper used, the twelve things this analysis needs. A one-term box makes them run twelve searches and
 * remember twelve answers.
 *
 * A TERM THAT MATCHES NOTHING IS A COVERAGE FINDING, NOT AN EMPTY STATE (UI-SPEC §7.3.2, §8.2). "No
 * results" tells the reviewer their search failed; "nothing in this run measures smoking" tells them
 * something true about their corpus, which is the thing they actually came to find out. It renders as an
 * amber left-ruled band naming the term and what its absence means, and it says so HERE rather than
 * deferring it: it will not resurface at a later gate.
 *
 * IT IS A TEXT MATCH, AND THE COPY SAYS SO (corrected 08-15). This component originally told the reviewer
 * that "matching is semantic", which was written against a plan to match each term against the group's
 * embedding centroid. **No centroid and no embedding reach the browser** — `UIConceptGroup` carries
 * neither, and `UIResult.atlas` is a 2-D PCA of individual variables that is empty on a run paused at
 * Gate 1 — so the match is over each group's own text (see `lib/ledger.ts::matchTerms`). The claim was
 * corrected rather than the feature dropped, because the coverage finding is the load-bearing part and it
 * is still true; what would not have been true is telling a reviewer the tool understood their term.
 *
 * TERMS ARE RENDERED AS ESCAPED TEXT CHILDREN. A coverage finding echoes user input back, and the one way
 * that becomes a vulnerability is raw-HTML injection — so no `dangerouslySetInnerHTML` on this surface,
 * ever. JSX children are escaped by construction, which is why this is a rule about what NOT to reach for.
 */

export interface TermSearchProps {
  /** Run the search. The component owns the textarea; the caller owns the matching. */
  onSearch: (terms: string[]) => void;
  /** Terms the caller found no group for, echoed back as coverage findings. */
  noMatches?: string[];
  /**
   * For each unmatched term, the words of it that appear NOWHERE in the run (`matchTerms`).
   *
   * WHAT IT BUYS: the difference between "this run does not measure that" and "you mistyped it". A term
   * whose every word is missing is a genuine coverage finding; a term where one word landed and another
   * did not is a wording problem, and the reviewer's next move is different in each case. The match is
   * lexical, so the tool cannot read intent — but it can say which words it could not find, which is a
   * REPORT rather than a correction. No did-you-mean, ever: that would be the semantic claim again.
   */
  missingTokens?: Record<string, string[]>;
  /** Fill the list from a declared score's components ("Use as scope"). Omitted when no score was declared. */
  onUseScore?: () => void;
  /** Prefilled terms, e.g. from a score. */
  value?: string;
  className?: string;
}

export function TermSearch({
  onSearch,
  noMatches = [],
  missingTokens = {},
  onUseScore,
  value = "",
  className,
}: TermSearchProps) {
  const [text, setText] = useState(value);
  const terms = text
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <section
      data-testid="term-search"
      className={cn("flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="term-search-input" className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
          Search concepts — one term per line
        </label>
        {text && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // Icon-only: the name states the action AND its object.
            aria-label="Clear the search terms"
            onClick={() => {
              setText("");
              onSearch([]);
            }}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Textarea
        id="term-search-input"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"body mass index\nsmoking status\ngrip strength"}
        className="rounded-inner"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => onSearch(terms)} disabled={terms.length === 0}>
          Search {terms.length > 0 ? `${terms.length} ${terms.length === 1 ? "term" : "terms"}` : ""}
        </Button>
        {onUseScore && (
          <Button type="button" variant="outline" onClick={onUseScore}>
            Use my declared score as the scope
          </Button>
        )}
        <span className="text-xs text-on-raised-muted">
          Each term is matched against the text of each group — its generated name, the description behind
          it, and its variable names. It runs on this machine, so searching costs nothing.
        </span>
      </div>

      {noMatches.length > 0 && (
        <ul data-testid="coverage-findings" className="flex flex-col gap-2">
          {noMatches.map((term) => {
            const missing = missingTokens[term] ?? [];
            // A term where SOME words landed and others did not is a wording problem, not a coverage
            // finding — the run does contain the vocabulary, just not the way this term spells it.
            const partial = missing.length > 0 && missing.length < term.trim().split(/\s+/).length;
            return (
              <li
                key={term}
                className="flex flex-col gap-1 rounded-inner border-l-4 border-l-status-warn bg-surface-warn px-3 py-2"
              >
                {/* Escaped text children — never raw HTML. See the docstring. */}
                <span className="text-sm font-semibold text-on-warn">&ldquo;{term}&rdquo; matched no group</span>
                <span className="text-xs text-on-warn">
                  {partial ? (
                    <>
                      No group has a word beginning{" "}
                      {missing.map((w, i) => (
                        <span key={w}>
                          {i > 0 && ", "}
                          <span className="font-semibold">&ldquo;{w}&rdquo;</span>
                        </span>
                      ))}
                      , though the rest of the term does appear here — so this is more likely a spelling or
                      wording difference than a gap in the run. Try the word as this run spells it.
                    </>
                  ) : (
                    <>
                      No part of this term appears anywhere in the run, so either the clustering never
                      formed such a group or no cohort here measures it. Settle it now; it will not
                      resurface at a later gate.
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
