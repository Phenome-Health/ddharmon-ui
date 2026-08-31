import { preparedExportUrl } from "@/lib/api";

/**
 * The prepared-dictionary export — the one part of the retired preprocessing report that survives on its
 * own merits.
 *
 * WHY IT OUTLIVED THE REPORT. `08-DECISION-GATE0.md` D-5 already called this the one part of that surface
 * a reviewer could actually use, and 08-14d — which deleted the report after Bhargav read it live on
 * 2026-08-31 and judged it not worth the reader's attention — kept it deliberately. It is not a summary of
 * what preparation did; it is the reviewer's OWN file handed back, so it survives the deletion of every
 * screen that summarised anything. With the report gone it is now the only way to see what preparation did
 * at all.
 *
 * STRUCTURALLY MORE RELIABLE THAN THE SCREEN EVER WAS. The endpoint re-reads and re-prepares the upload on
 * request rather than reading the run's capped diff, so it covers EVERY variable rather than the ~50 the
 * run carried per-variable detail for — which is also why it was immune to the `[:80]` truncation that
 * made the retired screen unreviewable for two days.
 *
 * NOT BEHIND A DISCLOSURE. It is the answer, so it is reachable without expanding anything.
 */
export function PreparedExport({ jobId, cohorts }: { jobId: string; cohorts: readonly string[] }) {
  // ONE probe, not one per cohort: `preparedExportUrl` returns null for the whole static preview rather
  // than per-file, so a per-cohort check would render the same absence notice N times.
  const available = cohorts.length > 0 && preparedExportUrl(jobId, cohorts[0]) !== null;
  return (
    <section
      data-testid="prepared-export"
      className="flex flex-col gap-2 rounded-card bg-surface-raised px-6 py-4 shadow-card"
    >
      <h2 className="text-sm font-semibold text-on-raised">Check your dictionaries yourself</h2>
      {available ? (
        <ul className="flex flex-col gap-1">
          {cohorts.map((cohort) => (
            <li key={cohort}>
              <a
                data-testid="prepared-export-link"
                data-cohort={cohort}
                href={preparedExportUrl(jobId, cohort)!}
                download
                className="text-sm font-semibold text-link-on-raised underline underline-offset-2"
              >
                Download {cohort} with the prepared columns (CSV)
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="prepared-export-unavailable" className="text-sm font-semibold text-on-raised-muted">
          Download of the prepared dictionary is unavailable in this preview
        </p>
      )}
      <p className="max-w-[68ch] text-xs text-on-raised-muted">
        {available
          ? "Your original file, unchanged and in its own column order, with ddharmon_variable_name, ddharmon_description and ddharmon_embedding_text appended for EVERY variable — not only the ones that changed. It is re-read and re-prepared on request, so it costs nothing."
          : "This preview has no server to re-read your upload from. Start a run to export the prepared dictionary."}
      </p>
    </section>
  );
}
