import { useMemo } from "react";
import { previewTable, type ArtifactPreview } from "@/lib/gate4";
import { cn } from "@/lib/utils";

/**
 * The body of Gate 4's preview drawer — the artifact's own content, shown the way its format reads best
 * (final review round 2: "previews should be prettier, rather than raw CSV/TSV show in spreadsheet layout").
 *
 * A DELIMITED FILE IS A TABLE. The decision log and the review queue are spreadsheets, so they are drawn as
 * one: the file's own header row (in mono, exactly as its column names are spelled — these are the names a
 * reviewer will see in their spreadsheet tool, so they are not re-cased into the eyebrow register), aligned
 * columns, a header that stays put while the rows scroll, and a sideways scroll INSIDE this box for a wide
 * file so the drawer itself never scrolls horizontally. The cells are PARSED from the file's text by a real
 * CSV parser (`previewTable`), never re-derived, so the table cannot say something the file does not.
 *
 * JSON AND THE NOTEBOOK STAY CODE, unwrapped, so nested keys keep the indentation the file has.
 *
 * The row cap is unchanged; the drawer states it under the excerpt (`note`), outside the scrolling box.
 */
export function ArtifactPreviewBody({ preview, className }: { preview: ArtifactPreview; className?: string }) {
  // Keyed on the TEXT, not the object: the page builds a fresh preview object on every render.
  const delimiter = preview.kind === "table" ? preview.delimiter : null;
  const table = useMemo(
    () => (delimiter ? previewTable(preview.text, delimiter) : null),
    [delimiter, preview.text],
  );

  if (preview.kind === "empty") {
    return (
      <p data-testid="artifact-preview-content" data-kind="empty" className={cn("text-sm text-on-raised-muted", className)}>
        {preview.text}
      </p>
    );
  }

  if (preview.kind === "code" || !table) {
    return (
      <pre
        data-testid="artifact-preview-content"
        data-kind="code"
        className={cn(
          "min-h-0 overflow-auto whitespace-pre rounded-inner bg-surface-inset p-4 font-mono text-xs leading-relaxed text-on-inset",
          className,
        )}
      >
        {preview.text}
      </pre>
    );
  }

  const { columns, rows } = table;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
      <div
        data-testid="artifact-preview-content"
        data-kind="table"
        className="min-h-0 overflow-auto rounded-inner border border-rule-on-raised"
      >
        {/* `border-separate` + zero spacing, not `border-collapse`: a collapsed border does not travel with a
            sticky header cell, so the rule under the header would scroll away with the first row. */}
        <table data-testid="artifact-preview-table" className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={`${i}-${c}`}
                  scope="col"
                  className="sticky top-0 z-10 whitespace-nowrap border-b border-rule-on-raised bg-surface-inset px-3 py-2 align-bottom font-mono font-semibold text-on-inset"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="align-top hover:bg-surface-inset">
                {columns.map((_, i) => (
                  <td key={i} className="border-b border-rule-quiet-on-raised px-3 py-2 text-on-raised">
                    {/* A long cell wraps inside a readable measure instead of stretching its column off-screen;
                        the table as a whole still scrolls sideways when the columns add up past the drawer. */}
                    <div className="min-w-[5rem] max-w-[22rem] whitespace-pre-wrap break-words">{row[i] ?? ""}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.note && (
        <p data-testid="artifact-preview-note" className="text-xs text-on-raised-muted">
          {preview.note}
        </p>
      )}
    </div>
  );
}
