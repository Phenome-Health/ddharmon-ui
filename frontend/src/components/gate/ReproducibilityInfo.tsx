import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The reproducibility disclosure — what is deterministic about a run and what is not.
 *
 * LIFTED from `pages/dashboard.tsx` (08-17 audit: "LIFT"). Gate 4 is the "defend the mappings I export"
 * screen (STGD-15), and the run's reproducibility facts are exactly what make an export defensible; the
 * legacy results page had this and the staged flow did not. Extracted to a shared component so the two
 * screens render one source of truth rather than drifting copies.
 *
 * The educational body is unchanged from the dashboard. The one addition is the run-specific fact the
 * dashboard popover never carried: the `coreVersion` this run was produced by — the single stamp that ties
 * a re-run's drift to a pipeline release rather than leaving it unattributed.
 */
export function ReproducibilityInfo({ coreVersion }: { coreVersion?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="reproducibility-trigger"
          className="inline-flex items-center gap-1 rounded-full border border-rule-on-field px-2 py-0.5 text-xs text-on-field-muted transition-colors hover:border-on-field-faint hover:text-on-field"
        >
          <Info className="h-3 w-3" /> Reproducibility
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-xs font-normal leading-relaxed">
        <p className="mb-2 text-sm font-semibold text-on-raised">How reproducible is a run?</p>
        <p className="mb-2 text-on-raised">
          Embeddings are deterministic. Two stages are <span className="font-semibold">not</span> bitwise-reproducible:
        </p>
        <ul className="mb-2 list-disc space-y-1 pl-4 text-on-raised">
          <li>
            <span className="font-semibold">Clustering</span> (UMAP/HDBSCAN) — cluster boundaries can shift run to run.
          </li>
          <li>
            <span className="font-semibold">LLM assignment</span> — runs at temperature 0, but the model gives no
            bitwise guarantee, so a few borderline verdicts may flip.
          </li>
        </ul>
        <p className="mb-2 text-on-raised">
          The split-aware assignment re-derives concepts from each cluster, so most of that drift washes out of the
          final grouping.
        </p>
        <p className="mb-2 rounded-md bg-surface-inset p-2 text-on-raised">
          <span className="font-semibold text-on-raised">Reference</span> (5×200-variable cohorts): across independent fresh
          runs most concepts recur and keep the same verdict — the split-aware assignment washes most UMAP/LLM
          drift out of the final grouping.
        </p>
        <p className="mb-2 text-on-raised-muted">
          A <span className="font-semibold">saved / demo run</span> replays a frozen snapshot + cached responses —
          identical every time.
        </p>
        {coreVersion && (
          <p data-testid="reproducibility-core-version" className="text-on-raised-muted">
            This run was produced by pipeline release{" "}
            <span className="font-mono text-on-raised">{coreVersion}</span>.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
