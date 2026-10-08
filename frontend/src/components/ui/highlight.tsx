import { createContext, useContext } from "react";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type HighlightMode = "substring" | "word-prefix";

/**
 * The gate's live search, for every `Highlight` under it that is not given a query of its own — the queue rows AND
 * the open concept's detail (review round 4: "search highlighting should extend to any field thats being used for
 * retrieval"), the way Gmail marks the terms in the open message as well as in the list. `ConceptWorkbench` provides it.
 */
const SearchHighlight = createContext<{ query?: string; mode: HighlightMode }>({ mode: "substring" });

export function SearchHighlightProvider({
  query,
  mode,
  children,
}: {
  query?: string;
  mode: HighlightMode;
  children: React.ReactNode;
}) {
  return <SearchHighlight.Provider value={{ query, mode }}>{children}</SearchHighlight.Provider>;
}

/**
 * The queue's search hits (review round 3, Bhargav: "when i search something here, i want the matched text to be
 * highlighted like gmail does"). With no query the text renders as it is.
 *
 * THE HIGHLIGHT FOLLOWS THE GATE'S OWN MATCH RULE, so what is marked is what made the row match:
 *  - `substring` (Gates 2-3): the whole query, wherever it occurs.
 *  - `word-prefix` (Gate 1, `matchTerms`): each word of the query, where it BEGINS a word — "smok" marks the start of
 *    "smoking", never the middle of a word, because Gate 1's search does not match there.
 */
export function Highlight({
  text,
  query,
  mode,
}: {
  text: string;
  /** Omit both to follow the surrounding `SearchHighlightProvider`. */
  query?: string;
  mode?: HighlightMode;
}) {
  const ctx = useContext(SearchHighlight);
  const q = (query ?? ctx.query)?.trim();
  mode = mode ?? ctx.mode;
  if (!q) return <>{text}</>;
  let pattern: RegExp;
  if (mode === "word-prefix") {
    const words = (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).sort((a, b) => b.length - a.length);
    if (words.length === 0) return <>{text}</>;
    pattern = new RegExp(`(?<![a-z0-9])(${words.map(escape).join("|")})`, "gi");
  } else {
    pattern = new RegExp(`(${escape(q)})`, "gi");
  }
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        // `split` with one capturing group puts every match at an odd index.
        i % 2 === 1 ? (
          <mark key={i} data-search-hit className="rounded-[2px] bg-surface-highlight px-px text-current">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
