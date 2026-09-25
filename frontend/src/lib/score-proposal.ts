/**
 * The component PROPOSAL — a model reads the score paper, the reviewer confirms the list (08-16e).
 *
 * EXTRACTION PROPOSES; THE REVIEWER DISPOSES. Rule 2 of the declared-score panel — a cutoff the source did not
 * state is flagged, never invented — covers an extracted component list too: a model that returns eight
 * components when the paper names six has invented two, and the reviewer who uploaded the paper *to avoid
 * reading 41,000 characters* is the least likely person to notice. So nothing here writes a declaration.
 * `acceptedDraft` only fills the same components box a reviewer types into; the declaration is still written
 * by the panel's own "Declare these components", which is why an accepted list is indistinguishable from a
 * typed one.
 *
 * PURE AND ROUTE-FREE on purpose: no `import.meta.env`, no fetch, no job id. That is what lets the algebra be
 * asserted in node, and what lets the propose/confirm step be lifted onto Setup later (todo 2026-09-25)
 * without a rewrite — the caller injects the extraction call and receives the accepted names.
 */

import { declaredComponents } from "@/lib/score-scope";

/**
 * The most extracted text one extraction reads. Mirrors `backend/composite.py::MAX_COMPONENT_EXTRACT_CHARS`
 * (a backend test pins the two to one number). Above it the panel refuses BEFORE the press, and the server
 * refuses again — the text is never cut short, because half a paper gives a plausible, incomplete list.
 */
export const MAX_COMPONENT_EXTRACT_CHARS = 200_000;

/** A coding the SOURCE states. Absent (`null`) whenever core did not mark it source-stated. */
export interface StatedCoding {
  kind: string;
  cutoff: string;
  referenceRange: string;
  codeMap: Record<string, string>;
  formula: string;
  units: string;
}

export interface ProposedComponent {
  /** The document's own wording. */
  name: string;
  /** Whether that wording occurs in the text that was read (case/whitespace-insensitive). */
  verbatim: boolean;
  coding: StatedCoding | null;
}

/** What `POST /jobs/{id}/score/components` returns. */
export interface ComponentProposal {
  found: boolean;
  scoreName: string;
  statedNItems: number | null;
  components: ProposedComponent[];
  /** Why nothing was found, when nothing was. */
  reason: string;
  sha256: string;
  nChars: number;
  provenance: string;
  model: string;
  /** True when this exact text was already extracted on this run — no charge this time. */
  cached: boolean;
}

/** The free read's output — what the proposal is checked against, and what is sent to be extracted. */
export interface ReadDocument {
  text: string;
  sha256: string;
  nChars: number;
  provenance: string;
}

// --- the three cost states, stated where the reviewer meets them -----------------------------------------

/** Step 1 — reading. $0: no model is called. */
export const READ_IS_FREE =
  "Reading the document costs nothing — no model is called. It pulls the text out so you can see whether " +
  "the component table survived extraction before anything is spent on it.";

/** Step 2 — extracting. Paid, priced inline before it runs. */
export function extractPrice(nChars: number): string {
  return (
    `Extracting the components costs money: it is one model call that reads the ${nChars.toLocaleString()} ` +
    "characters above and proposes the component names it finds. Nothing is charged until you press it, and " +
    "the same text is never charged twice on this run. Nothing it proposes is declared until you accept it."
  );
}

/** The closed strip's one-line summary — all three states, visible without opening anything. */
export const STRIP_SUMMARY =
  "Reading a paper is free; extracting its components and matching them against this run each cost one model call.";

// --- refusals BEFORE the press ---------------------------------------------------------------------------

export interface ExtractionRefusal {
  claim: "deferred" | "failed" | "not-enabled";
  reason: string;
}

/**
 * Why extraction cannot be pressed HERE, or `null` when it can. Checked in the order the server checks, so the
 * screen and the route never disagree about which reason applies.
 */
export function extractionRefusalFor(opts: {
  nChars: number;
  pinned?: boolean;
  frozen?: boolean;
}): ExtractionRefusal | null {
  if (opts.pinned) {
    return {
      claim: "not-enabled",
      reason:
        "This is the shared demo, which never spends money. Clone it into a run of your own to have a model " +
        "extract the components — or type them yourself below.",
    };
  }
  if (opts.frozen) {
    return {
      claim: "not-enabled",
      reason: "This run has passed Gate 1, so its score declaration is a record and cannot be changed.",
    };
  }
  if (opts.nChars > MAX_COMPONENT_EXTRACT_CHARS) {
    return {
      claim: "not-enabled",
      reason:
        `This document is ${opts.nChars.toLocaleString()} characters; extraction reads at most ` +
        `${MAX_COMPONENT_EXTRACT_CHARS.toLocaleString()}, and a longer one is refused rather than cut short — ` +
        "half a paper gives a plausible but incomplete list. Read the section or supplement that holds the " +
        "component table instead, or type the components below.",
    };
  }
  return null;
}

// --- the outcome of a press ------------------------------------------------------------------------------

/**
 * Four outcomes, kept apart because the reviewer does something different after each:
 *  - `found`    — a list to check;
 *  - `nothing`  — the model read it and found none: an ANSWER, and typing still works;
 *  - `refused`  — the request was declined before anything was spent (no key, a passed gate, over the cap);
 *  - `failed`   — it was attempted and did not produce an answer (an unreadable reply, the provider down).
 */
export type ProposalOutcome = "found" | "nothing" | "refused" | "failed";

/** An HTTP status → refused (declined, nothing spent) or failed (attempted, no answer). */
export function errorOutcome(status: number | undefined): "refused" | "failed" {
  if (status === undefined) return "failed";
  return [400, 401, 403, 404, 409, 413].includes(status) ? "refused" : "failed";
}

export function proposalOutcome(p: ComponentProposal): "found" | "nothing" {
  return p.found && p.components.length > 0 ? "found" : "nothing";
}

// --- accepting -------------------------------------------------------------------------------------------

/**
 * Which proposed names start TICKED: the ones found word-for-word in the text. A name the text does not contain
 * starts unticked and flagged — kept, because the reviewer disposes, but never accepted by default.
 */
export function initialSelection(p: ComponentProposal): Set<string> {
  return new Set(p.components.filter((c) => c.verbatim).map((c) => c.name));
}

/**
 * The components box after accepting `names`: what was already typed, then each accepted name not already
 * there. Accepting never deletes the reviewer's own typing — it adds to it — and the box stays editable.
 */
export function acceptedDraft(existing: string, names: string[]): string {
  const kept = declaredComponents(existing);
  const seen = new Set(kept.map((n) => n.toLowerCase()));
  for (const n of names) {
    const name = n.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      kept.push(name);
    }
  }
  return kept.join("\n");
}

/** A stated coding, as the one line the proposal shows — the source's own values, never a paraphrase. */
export function statedCodingText(c: StatedCoding): string {
  if (c.cutoff) return c.cutoff + (c.units ? ` ${c.units}` : "");
  if (c.referenceRange) return c.referenceRange;
  const pairs = Object.entries(c.codeMap ?? {});
  if (pairs.length) return pairs.map(([k, v]) => `${k} = ${v}`).join(", ");
  return c.formula;
}

/**
 * The gap between what the document CLAIMS and what was read, in words — or `""` when there is none.
 * "The paper says 40 items; 38 were read" tells the reviewer to look for two, which is information they need.
 */
export function underEnumeratedNote(p: ComponentProposal): string {
  const n = p.statedNItems;
  if (!n || n <= p.components.length) return "";
  return (
    `The document says the score has ${n} items; ${p.components.length} could be read out of the text. ` +
    "The rest may be in a table that did not survive extraction, or in a supplement — nothing has been filled in."
  );
}
