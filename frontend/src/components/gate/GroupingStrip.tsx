import { cn } from "@/lib/utils";

/**
 * Gate 1's grouping strip: four read-only figures and one provenance line. NO CONTROL OF ANY KIND.
 *
 * THE PROHIBITION IS THE COMPONENT'S REASON TO EXIST (D-17). There is no `min_cluster_size` slider here
 * and there must never be one, for three independent reasons any one of which would be sufficient:
 *
 *   1. Re-clustering INVALIDATES THE FROZEN SUBSTRATE. UMAP + HDBSCAN is not bit-reproducible, so a
 *      partition cannot be recovered by re-running with the same parameters — the run would be a
 *      different run.
 *   2. It RE-PAYS the clustering step and strands every decision already made: a scope or a regroup is
 *      keyed to a group that no longer exists under the new partition.
 *   3. The public design page already publishes a hand-tuned cluster size as the REJECTED alternative. A
 *      slider here would contradict a live public claim about how the tool works.
 *
 * WHAT CHANGED, AND WHAT DID NOT (D-17's 2026-08-17 resolution). The prohibition stands unaltered. Its
 * original rationale — that the line was an honesty device, disclosing that the row was a scaffold
 * standing in for a concept — does not, because since UI-SPEC §0.1's reversal the row IS a real
 * post-split concept group. So the line is now PROVENANCE: it says where these groups came from, and
 * that the way to reshape one is to move variables into it.
 *
 * ALWAYS VISIBLE, NEVER A TOOLTIP. It explains what a row is; a reviewer who never hovers would never
 * learn it, and the one who most needs it is the one who does not know there is something to hover.
 */

export interface GroupingStripProps {
  /** Post-split concept groups — the ledger's row count. */
  nGroups: number;
  /** Parent clusters those groups were divided out of. */
  nClusters: number;
  /** Variables pooled across every group. */
  nVariables: number;
  /** Groups drawing on two or more cohorts — the harmonization subset, and the ledger's default view. */
  nCrossCohort: number;
  className?: string;
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div data-testid="strip-figure" className="flex flex-col gap-0.5">
      <span className="font-mono text-lg font-semibold tabular-nums text-on-field">{value}</span>
      <span className="text-xs text-on-field-muted">{label}</span>
    </div>
  );
}

export function GroupingStrip({
  nGroups,
  nClusters,
  nVariables,
  nCrossCohort,
  className,
}: GroupingStripProps) {
  return (
    <section
      data-testid="grouping-strip"
      aria-label="Where these groups came from"
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="flex flex-wrap gap-x-10 gap-y-3">
        <Figure value={nGroups} label={nGroups === 1 ? "concept group" : "concept groups"} />
        <Figure value={nClusters} label={nClusters === 1 ? "parent cluster" : "parent clusters"} />
        <Figure value={nVariables} label={nVariables === 1 ? "variable" : "variables"} />
        {/* Named as what it IS — groups drawing on more than one cohort — rather than as a quality score.
            The complement is not a failure; it is a different job, scored separately. */}
        <Figure value={nCrossCohort} label="span two or more cohorts" />
      </div>
      <p data-testid="strip-provenance" className="max-w-[80ch] text-sm text-on-field-muted">
        Clusters were sized automatically from how many variables your dictionaries carry, then each
        cluster was divided into the distinct concepts inside it. Reshape a group by moving variables into
        or out of it — not by re-clustering, which would discard the grouping these decisions are recorded
        against.
      </p>
    </section>
  );
}
