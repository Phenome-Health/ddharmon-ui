// Central place for external URLs — the GitHub repo (issues), reference standards, and related work.
// Keep public-facing only (no internal tools/strategy).

export const REPO_URL = "https://github.com/Phenome-Health/ddharmon-ui";
export const ISSUES_URL = `${REPO_URL}/issues`;

// Absolute filesystem paths that might appear in a raw exception string — scrubbed before a run's error
// text goes into a public GitHub issue so a server path never leaks. Matches a leading path segment.
const _FS_PATH = /(?:\/(?:Users|home|tmp|var|private|opt|mnt|srv)\/[^\s'"]*)/g;

/**
 * Build a prefilled GitHub "new issue" URL for a failed harmonization run.
 *
 * METADATA ONLY: the failing stage, run mode, CDE set, short run id, and the (path-scrubbed) error text.
 * No uploaded data, field names, or field contents are included. The user still reviews and submits the
 * issue themselves on GitHub — nothing is filed automatically.
 */
export function buildRunIssueUrl(opts: {
  jobId: string;
  errorMessage?: string | null;
  failedPhase?: string | null;
  runMode?: string;
  cdeSet?: string;
}): string {
  const err = (opts.errorMessage || "(no error message was captured)").replace(_FS_PATH, "<path>").trim();
  const stage = opts.failedPhase || "unknown";
  const title = `[run error] harmonization failed${opts.failedPhase ? ` in the ${stage} stage` : ""}`;
  const body = [
    "A harmonization run failed. The details below are auto-filled from the run (metadata only — no uploaded",
    "data or field contents are included).",
    "",
    "**Run details**",
    `- Failing stage: \`${stage}\``,
    `- Run mode: \`${opts.runMode || "unknown"}\``,
    `- CDE set: \`${opts.cdeSet || "unknown"}\``,
    `- Run id: \`${opts.jobId.slice(0, 8)}\``,
    "",
    "**Error**",
    "```",
    err,
    "```",
    "",
    "**Anything else** (what you were trying to harmonize, steps to reproduce — please add):",
    "",
  ].join("\n");
  return `${ISSUES_URL}/new?${new URLSearchParams({ title, body }).toString()}`;
}

// Phenome Health org + internal tools (the Phenome Health tab). Empty string → rendered without a link.
export const PH = {
  org: "https://phenomehealth.org",
  ddharmon: "https://github.com/Phenome-Health/ddharmon",
  // Per-cohort provenance: the source-URL → build-script → CSV table for every example cohort.
  ddharmonProvenance: "https://github.com/Phenome-Health/ddharmon/blob/main/data/examples/README.md",
  ddharmonUi: "https://github.com/Phenome-Health/ddharmon-ui",
  biomapper: "https://github.com/Phenome-Health/biomapper2",
  biomapperUi: "https://link.expertintheloop.io/",
  portflow: "https://github.com/Phenome-Health/PortFlow",
  kraken: "https://app.krakenkg.com/",
  eitl: "https://expertintheloop.io/",
} as const;

// Reference standards / concepts linked from the Guide and Related work.
export const REF = {
  cde: "https://cde.nlm.nih.gov/", // NIH CDE Repository
  loinc: "https://loinc.org/",
  snomed: "https://www.snomed.org/",
  omop: "https://www.ohdsi.org/data-standardization/the-common-data-model/",
  sssom: "https://mapping-commons.github.io/sssom/",
  fair: "https://www.go-fair.org/fair-principles/",
  biolink: "https://biolink.github.io/biolink-model/",
  bertopic: "https://maartengr.github.io/BERTopic/",
  hitl: "https://en.wikipedia.org/wiki/Human-in-the-loop",
} as const;
