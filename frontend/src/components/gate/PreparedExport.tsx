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

/**
 * PER-DICTIONARY, PRE-START: mark this dictionary's mapping complete, then take its embedding-text CSV.
 *
 * WHY IT IS SEPARATE FROM `PreparedExport` ABOVE. That one is job-scoped — it re-reads a STARTED run's
 * retained upload, so it cannot exist before Start. This one is the answer to the question a reviewer
 * actually has while they are still mapping: *what text will this file give the model?* The file is still
 * in the browser at that point, so the export is a POST of the file itself against a job-less endpoint,
 * and it costs nothing.
 *
 * CONFIRMATION IS A REAL STATE, NOT A STYLING OF "HAS A MAPPING". The caller holds the mapping that was
 * confirmed, not a boolean, so editing a column drops the confirmation structurally rather than through an
 * effect someone has to remember to fire. A reviewer downloading a CSV that describes a mapping they have
 * since edited — and believing it — is the failure this shape rules out.
 */
export function DictionaryEmbeddingExport({
  cohortName,
  confirmed,
  canConfirm,
  blockedReason,
  onConfirm,
  onDownload,
  downloading = false,
  note,
  error,
  available,
}: {
  cohortName: string;
  confirmed: boolean;
  canConfirm: boolean;
  blockedReason?: string;
  onConfirm: () => void;
  onDownload: () => void;
  downloading?: boolean;
  note?: string;
  error?: string;
  available: boolean;
}) {
  return (
    <div
      data-testid="dict-embedding-export"
      data-cohort={cohortName}
      data-confirmed={String(confirmed)}
      className="flex flex-col gap-2 border-t border-rule-on-raised pt-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        {confirmed ? (
          <>
            <span data-testid="dict-mapping-confirmed" className="text-sm font-semibold text-on-raised">
              Mapping complete
            </span>
            <button
              type="button"
              data-testid="dict-embedding-download"
              onClick={onDownload}
              disabled={downloading || !available}
              className="text-sm font-semibold text-link-on-raised underline underline-offset-2 disabled:no-underline disabled:text-on-raised-muted"
            >
              {downloading ? "Preparing…" : `Download ${cohortName} with the embedding text (CSV)`}
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="dict-mapping-confirm"
            onClick={onConfirm}
            disabled={!canConfirm}
            className="rounded-inner border border-rule-on-raised px-3 py-1.5 text-sm font-semibold text-on-raised disabled:text-on-raised-muted"
          >
            Mapping complete
          </button>
        )}
      </div>
      {!confirmed && blockedReason && (
        // A DISABLED CONTROL WITH NO REASON IS A DEAD END. It states what is missing rather than leaving
        // the reviewer to guess which of a dozen columns the mapping still needs.
        <p data-testid="dict-mapping-blocked" className="max-w-[68ch] text-xs text-on-raised-muted">
          {blockedReason}
        </p>
      )}
      {confirmed && (
        // NOT GATED ON `available`. What the export contains, and that reaching it is free, are claims
        // about the FLOW — they are just as true in a preview with no server as on the deployed app, and
        // hiding them there would make the absence notice read as "this feature costs something we
        // cannot charge here". The absence is stated separately, after the description of what is absent.
        <p className="max-w-[68ch] text-xs text-on-raised-muted">
          Your own rows, unchanged and in their own column order, with one column appended:{" "}
          <span className="font-mono">ddharmon_embedding_text</span> — the exact text that will be fed to
          clustering for that variable. It costs nothing and starts no run.
        </p>
      )}
      {confirmed && !available && (
        <p data-testid="dict-embedding-unavailable" className="max-w-[68ch] text-xs text-on-raised-muted">
          This preview has no server to compose the embedding text, so the download is unavailable here.
        </p>
      )}
      {note && (
        <p data-testid="dict-embedding-note" role="status" className="max-w-[68ch] text-xs text-on-raised">
          {note}
        </p>
      )}
      {error && (
        <p data-testid="dict-embedding-error" role="alert" className="max-w-[68ch] text-xs text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * RUN-LEVEL, PRE-START: every dictionary mapped, then all of them as ONE workbook, a sheet each.
 *
 * The per-dictionary CSV answers *"what will this file give the model?"* while a reviewer is mapping one
 * file. This answers the question they have once they have finished: *what does the whole run look like?*
 * That is a comparison across dictionaries, and a comparison across five files in a Downloads folder is
 * not one.
 *
 * IT NAMES WHAT IS OUTSTANDING RATHER THAN SITTING INERT. A control that is disabled with no explanation
 * on a screen with five mapping tables above it is a control the reviewer will read as broken.
 */
export function WorkbookExport({
  total,
  remaining,
  confirmed,
  onConfirm,
  onDownload,
  downloading = false,
  error,
  available,
}: {
  total: number;
  remaining: number;
  confirmed: boolean;
  onConfirm: () => void;
  onDownload: () => void;
  downloading?: boolean;
  error?: string;
  available: boolean;
}) {
  const ready = remaining === 0 && total > 0;
  return (
    <section
      data-testid="workbook-export"
      data-remaining={String(remaining)}
      data-confirmed={String(confirmed && ready)}
      className="flex flex-col gap-2 rounded-card bg-surface-raised px-6 py-4 shadow-card"
    >
      <h2 className="text-sm font-semibold text-on-raised">All your dictionaries, in one workbook</h2>
      {confirmed && ready ? (
        <button
          type="button"
          data-testid="workbook-download"
          onClick={onDownload}
          disabled={downloading || !available}
          className="self-start text-sm font-semibold text-link-on-raised underline underline-offset-2 disabled:no-underline disabled:text-on-raised-muted"
        >
          {downloading ? "Building the workbook…" : "Download all dictionaries as one workbook (.xlsx)"}
        </button>
      ) : (
        <button
          type="button"
          data-testid="workbook-confirm"
          onClick={onConfirm}
          disabled={!ready}
          className="self-start rounded-inner border border-rule-on-raised px-3 py-1.5 text-sm font-semibold text-on-raised disabled:text-on-raised-muted"
        >
          Every dictionary is mapped
        </button>
      )}
      {!ready && (
        <p data-testid="workbook-remaining" className="max-w-[68ch] text-xs text-on-raised-muted">
          {total === 0
            ? "Add a dictionary first — the workbook holds one sheet per dictionary."
            : `${remaining} of ${total} ${total === 1 ? "dictionary is" : "dictionaries are"} still to be marked complete.`}
        </p>
      )}
      {ready && (
        <p className="max-w-[68ch] text-xs text-on-raised-muted">
          One sheet per dictionary, each holding that dictionary's own rows plus the{" "}
          <span className="font-mono">ddharmon_embedding_text</span> column. Free, and it starts no run.
        </p>
      )}
      {confirmed && ready && !available && (
        <p data-testid="workbook-unavailable" className="max-w-[68ch] text-xs text-on-raised-muted">
          This preview has no server to build the workbook, so the download is unavailable here.
        </p>
      )}
      {error && (
        <p data-testid="workbook-error" role="alert" className="max-w-[68ch] text-xs text-status-danger">
          {error}
        </p>
      )}
    </section>
  );
}
