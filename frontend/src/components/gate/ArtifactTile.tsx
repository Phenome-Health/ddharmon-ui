import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { ArtifactState } from "@/lib/gate4";

/**
 * One export artifact (UI-SPEC §0.2 Surface 2): a checkbox, a name, a one-sentence description, the
 * filename that will land in Downloads, and a Preview action.
 *
 * THREE STATES, THREE CLAIMS, and the difference is load-bearing (T-08-103/104):
 *  - `ready`      — the artifact exists; it can be selected and previewed.
 *  - `generating` — the pipeline is still producing it; it cannot be selected or counted yet.
 *  - `failed`     — it was attempted and produced nothing. This is a DEFECT, and it is styled and worded
 *                   distinctly from the neutral dashed `NotAvailable` tile, which states a deliberate
 *                   BOUNDARY. A failure that reads as a boundary tells the reviewer the product cannot do
 *                   something it can; a boundary that reads as a failure does the reverse.
 *
 * The name is clamped so a long one cannot reflow the tile, with the full value kept in `title`.
 */
export interface ArtifactTileProps {
  /** Stable slug (the export format id), emitted as `data-thing` so tests address it without its prose. */
  slug: string;
  name: string;
  description: string;
  filename: string;
  state: ArtifactState;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
  /** The notebook tile's language toggle, or the EITL tile's campaign list — rendered when selected. */
  children?: React.ReactNode;
  /** A standing assurance for this artifact (the notebook tile's data-never-enters line, §8.6). */
  assurance?: React.ReactNode;
  className?: string;
}

export function ArtifactTile({
  slug,
  name,
  description,
  filename,
  state,
  selected,
  onToggle,
  onPreview,
  children,
  assurance,
  className,
}: ArtifactTileProps) {
  const ready = state === "ready";
  return (
    <section
      data-testid="artifact-tile"
      data-thing={slug}
      data-state={state}
      data-selected={String(selected && ready)}
      className={cn(
        "flex flex-col gap-2 rounded-card bg-surface-raised px-5 py-4 shadow-card",
        state === "failed" && "border border-rule-danger",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          data-testid="artifact-checkbox"
          aria-label={`Include ${name} in the download`}
          checked={selected && ready}
          disabled={!ready}
          onCheckedChange={() => onToggle()}
          className="mt-1"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 title={name} className="truncate text-sm font-semibold text-on-raised">
              {name}
            </h3>
            {ready && (
              <button
                type="button"
                data-testid="artifact-preview"
                onClick={onPreview}
                className="shrink-0 text-xs font-semibold text-link-on-raised underline underline-offset-2"
              >
                Preview
              </button>
            )}
          </div>
          <p className="max-w-[68ch] text-xs text-on-raised-muted">{description}</p>
          {ready && (
            <p data-testid="artifact-filename" className="font-mono text-xs text-on-raised-faint">
              {filename}
            </p>
          )}
          {state === "generating" && (
            <p data-testid="artifact-generating" className="text-xs text-on-raised-muted">
              Still generating — it will be selectable once the run finishes producing it.
            </p>
          )}
          {state === "failed" && (
            <p data-testid="artifact-failed" className="text-xs font-semibold text-status-danger">
              Couldn't build this artifact on this run. This is a failure, not a format we don't offer — retry the run to produce it.
            </p>
          )}
        </div>
      </div>
      {assurance && (
        <p data-testid="artifact-assurance" className="max-w-[68ch] pl-7 text-xs text-on-raised-muted">
          {assurance}
        </p>
      )}
      {ready && selected && children && <div className="pl-7">{children}</div>}
    </section>
  );
}
