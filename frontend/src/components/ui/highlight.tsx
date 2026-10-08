const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  mode = "substring",
}: {
  text: string;
  query?: string;
  mode?: "substring" | "word-prefix";
}) {
  const q = query?.trim();
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
