/**
 * The Gate 4 notebook preview's reading of a real `.ipynb` (review round 8, Bhargav: "this preview doesnt reflect what
 * I actually see when I open the ipynb file. I want user to see an exact preview").
 *
 * The preview used to be a summary assembled HERE, in comments, which no notebook contains. It now reads the file the
 * download carries and draws its cells, so it cannot say something the file does not — the same rule the table
 * previews keep by parsing their files.
 *
 * MARKDOWN: the subset ddharmon's notebooks are written in (`backend/notebook.py`) — ATX headings, paragraphs, `-`/`*`
 * and numbered lists, **bold**, _italic_ / *italic*, and `code`. Anything else stays visible as its literal text rather
 * than being guessed at. Parsed into tokens and drawn as React elements, never as HTML, so a cell cannot inject markup.
 */

export interface NotebookCell {
  kind: "markdown" | "code" | "raw";
  source: string;
}

export interface ParsedNotebook {
  /** The kernel's language ("python", "R"), for the code cells' label. */
  language: string;
  cells: NotebookCell[];
}

const joinSource = (s: unknown): string => (Array.isArray(s) ? s.join("") : typeof s === "string" ? s : "");

/** The notebook's cells in order, or null when the text is not a notebook. */
export function parseNotebook(text: string): ParsedNotebook | null {
  let nb: unknown;
  try {
    nb = JSON.parse(text);
  } catch {
    return null;
  }
  if (!nb || typeof nb !== "object" || !Array.isArray((nb as { cells?: unknown }).cells)) return null;
  const meta = (nb as { metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } } }).metadata;
  const language = meta?.kernelspec?.language || meta?.language_info?.name || "";
  const cells = ((nb as { cells: { cell_type?: string; source?: unknown }[] }).cells ?? []).map((c) => ({
    kind: c.cell_type === "markdown" ? ("markdown" as const) : c.cell_type === "code" ? ("code" as const) : ("raw" as const),
    source: joinSource(c.source),
  }));
  return { language, cells };
}

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

/** A markdown cell's blocks: headings, paragraphs and lists, in order. */
export function markdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };
  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
    } else if (bullet || numbered) {
      const ordered = !bullet;
      if (para.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // A continuation line of the last list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

/** Inline emphasis and code within one block's text. Unmatched markers stay as literal text. */
export function inlineTokens(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_]*?)_(?![A-Za-z0-9])/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) {
      // Bold may wrap italics (`**_x_**`) or the reverse; one level of nesting is flattened to bold.
      out.push({ kind: "strong", text: (m[2] ?? m[3])!.replace(/^[_*]|[_*]$/g, "") });
    } else out.push({ kind: "em", text: (m[4] ?? m[5])! });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
