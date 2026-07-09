// Central place for external URLs — the GitHub repo (issues), reference standards, and related work.
// Keep public-facing only (no internal tools/strategy).

export const REPO_URL = "https://github.com/Phenome-Health/ddharmon-ui";
export const ISSUES_URL = `${REPO_URL}/issues`;

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
