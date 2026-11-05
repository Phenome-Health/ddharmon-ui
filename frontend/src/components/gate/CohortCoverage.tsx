import { cn } from "@/lib/utils";

/**
 * Cohort coverage as segments — one per cohort in the run, filled where this group has a member.
 *
 * ACHROMATIC ON PURPOSE. Not teal, not the accent: "a full column of it out-shouted the two things this
 * screen is actually for, the coherence verdict and the price" (UI-SPEC §5.4). A ledger's job is to let a
 * reviewer scan two columns; a third competing for attention costs more than it adds.
 *
 * GEOMETRY. 8 × 16px segments with a 2px gap and the 2px hairline radius (`rounded-sm`) — three of the enumerated exceptions
 * to the round-to-4 spacing rule (§2). Segments are instrument-level surfaces, so they never take the
 * container radius.
 *
 * ONE accessible name for the whole strip, not one per segment: eleven "present"/"absent" announcements is
 * not a reading of coverage, it is an obstacle to one.
 */

export function CohortCoverage({
  cohorts,
  allCohorts,
  className,
}: {
  /** The cohorts this group actually has members from. */
  cohorts: string[];
  /** Every cohort in the run, in a stable order — the denominator. */
  allCohorts: string[];
  className?: string;
}) {
  const present = new Set(cohorts);
  const covered = allCohorts.filter((c) => present.has(c));
  return (
    <span
      data-testid="cohort-coverage"
      role="img"
      aria-label={
        covered.length === 0
          ? `No cohort coverage recorded for this group`
          : `${covered.length} of ${allCohorts.length} cohorts: ${covered.join(", ")}`
      }
      className={cn("flex items-center gap-[2px]", className)}
    >
      {allCohorts.map((cohort) => (
        <span
          key={cohort}
          data-covered={present.has(cohort)}
          className={cn(
            "h-4 w-2 rounded-sm",
            present.has(cohort) ? "bg-on-raised-muted" : "bg-surface-track",
          )}
        />
      ))}
    </span>
  );
}
