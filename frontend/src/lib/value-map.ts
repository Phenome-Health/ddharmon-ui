// The Gate 3 value-map algebra (08-28 item 1c): how a source variable's codes are placed onto a target's
// permissible values, and what is saved when a reviewer moves one.
//
// THE RULE THIS FILE EXISTS FOR: one code space per harmonized column. A transform's `codeMap` maps source
// codes onto the target's CODES (core's spec-gen prompt asks for codes and drops any value that is not one),
// so the editor places the model's recode BY CODE and saves the reviewer's in CODES. Two live bugs came from
// mixing the spaces (08-LIVE-VERIFY-3):
//
//   F19  `codeMapToBuckets` matched the model's target codes ("9") against bucket LABELS ("Don't know"). On a
//        generated target whose codes differ from its labels it never hit, and the editor showed a $0 label
//        heuristic as "ddharmon's recommended mapping" — the model's -121 → 9 displayed as UNMAPPED.
//   F18  the editor saved LABELS, so one column mixed "1"/"0" (the model's recodes) with "Yes"/"No" (the
//        reviewer's).
//
// A catalog CDE's value IS its label — the catalog lists values, not code/label pairs, and core's spec-gen for
// a catalog target returns those values — so its table is label = code. A generated element (GenCDE / refined
// CDE) carries real code/label pairs.
//
// Pure and DOM-free, so it is asserted in node from `tests/e2e/value-map.spec.ts`.

/** The editor's standing buckets — conventions, not target values. Mirrored in `backend/notebook.py`. */
export const MISSING_BUCKET = "__missing__";
export const DROP_BUCKET = "__drop__";

/** One source response option — a chip to place. */
export interface SourceOption {
  code: string;
  label: string;
}

/** One target value a chip can land on. `listed: false` = a code the model's recode uses that the target's
 *  value list, as this run carried it, does not show (the catalog list is capped on the wire). */
export interface TargetValue {
  code: string;
  label: string;
  listed: boolean;
}

/** A generated element's permissible values → the table (label falls back to the code; first code wins). */
export function generatedTargetValues(pvs: { code: string; label?: string }[] | undefined): TargetValue[] {
  const out: TargetValue[] = [];
  const seen = new Set<string>();
  for (const pv of pvs ?? []) {
    const code = String(pv.code ?? "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, label: String(pv.label ?? "").trim() || code, listed: true });
  }
  return out;
}

/** A catalog CDE's value list → the table. The value IS the code. */
export function catalogTargetValues(labels: string[] | undefined): TargetValue[] {
  return generatedTargetValues((labels ?? []).map((l) => ({ code: l, label: l })));
}

/** The code a value names in `values`: the code itself, else a label (case-folded), else a code case-folded. */
export function resolveTargetCode(value: string, values: TargetValue[]): string | undefined {
  const v = String(value ?? "");
  if (!v) return undefined;
  const exact = values.find((t) => t.code === v);
  if (exact) return exact.code;
  const folded = v.trim().toLowerCase();
  return (
    values.find((t) => t.label.toLowerCase() === folded)?.code ??
    values.find((t) => t.code.toLowerCase() === folded)?.code
  );
}

/** One mapping value in codes: the conventions and unknown values pass through untouched (never dropped). */
function inCodes(value: string, values: TargetValue[]): string {
  if (!value || value === MISSING_BUCKET || value === DROP_BUCKET) return value;
  return resolveTargetCode(value, values) ?? value;
}

/**
 * The model's `codeMap` (source code → target CODE) as editor placements, keyed by target code.
 *
 * EVERY entry is kept. One the table does not know stays on its own value (and gets its own bucket via
 * `withModelTargets`), because dropping it would show the model's placement as unmapped — and the reviewer's
 * next save would then turn it into "missing" without anyone having decided that.
 */
export function codeMapToBuckets(
  codeMap: Record<string, string> | undefined,
  values: TargetValue[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(codeMap ?? {})) {
    const code = inCodes(String(tgt ?? ""), values);
    if (code) out[src] = code;
  }
  return out;
}

/** A persisted mapping in codes — an edit saved in LABELS before the fix is shown (and applied) in codes. */
export function mappingInCodes(mapping: Record<string, string>, values: TargetValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(mapping)) out[src] = inCodes(String(tgt ?? ""), values);
  return out;
}

/** The buckets to render: the target's table, plus any value a mapping uses that the table does not list. */
export function withModelTargets(
  values: TargetValue[],
  ...mappings: (Record<string, string> | undefined)[]
): TargetValue[] {
  const out = [...values];
  const known = new Set(values.map((v) => v.code));
  for (const m of mappings) {
    for (const tgt of Object.values(m ?? {})) {
      const code = inCodes(String(tgt ?? ""), values);
      if (!code || code === MISSING_BUCKET || code === DROP_BUCKET || known.has(code)) continue;
      known.add(code);
      out.push({ code, label: code, listed: false });
    }
  }
  return out;
}

const MISSING_HINTS = ["prefer not", "don't know", "dont know", "unknown", "refused", "not answer", "missing", "n/a"];

/** The $0 label heuristic, in CODES: an exact label match → that value's code; a missing-data label → Missing. */
export function heuristicMapping(sourceOptions: SourceOption[], values: TargetValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of sourceOptions) {
    const label = (o.label || o.code).trim().toLowerCase();
    const hit = values.find((t) => t.label.toLowerCase() === label);
    if (hit) out[o.code] = hit.code;
    else if (MISSING_HINTS.some((h) => label.includes(h))) out[o.code] = MISSING_BUCKET;
  }
  return out;
}

/**
 * What the editor opens on, and WHERE it came from.
 *
 * `model` — the model produced a code map, and the recommendation is exactly that map: nothing is added to it.
 * A code the model left unmapped stays unplaced, because a $0 guess shown under "ddharmon's recommended
 * mapping" is the tool vouching for a decision no stage made (F19).
 * `heuristic` — no code map (kind `none`, or no spec at all): the label heuristic seeds a starting point, and
 * the screen says it is one.
 */
export function recommendedMapping(
  sourceOptions: SourceOption[],
  values: TargetValue[],
  codeMap: Record<string, string> | undefined,
): { mapping: Record<string, string>; from: "model" | "heuristic" } {
  const model = codeMapToBuckets(codeMap, values);
  if (Object.keys(model).length > 0) return { mapping: model, from: "model" };
  return { mapping: heuristicMapping(sourceOptions, values), from: "heuristic" };
}

/**
 * The mapping a save STORES (08-28 Q3): the whole mapping, every source code present. A code the reviewer
 * left unplaced is written as an explicit Missing — never an absent key that the notebook's `.map()` turns
 * into a silent NaN nobody chose.
 */
export function mappingForSave(sourceCodes: string[], mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const code of sourceCodes) out[code] = mapping[code] || MISSING_BUCKET;
  for (const [code, tgt] of Object.entries(mapping)) if (!(code in out) && tgt) out[code] = tgt;
  return out;
}

export interface MappingSummary {
  /** Codes placed on a real target value. */
  mapped: number;
  missing: number;
  dropped: number;
  /** Codes with no placement yet — exported as missing. */
  unplaced: number;
  total: number;
  /** mapped / total, the same measure as a spec's own `coverage`. */
  coverage: number;
}

export function mappingSummary(sourceCodes: string[], mapping: Record<string, string>): MappingSummary {
  const codes = [...new Set([...sourceCodes, ...Object.keys(mapping)])];
  let mapped = 0;
  let missing = 0;
  let dropped = 0;
  let unplaced = 0;
  for (const code of codes) {
    const tgt = mapping[code] ?? "";
    if (!tgt) unplaced += 1;
    else if (tgt === MISSING_BUCKET) missing += 1;
    else if (tgt === DROP_BUCKET) dropped += 1;
    else mapped += 1;
  }
  const total = codes.length;
  return { mapped, missing, dropped, unplaced, total, coverage: total ? mapped / total : 0 };
}

/** The spec row's one-line headline for a reviewer's mapping ("2 codes mapped, 1 set missing"). */
export function mappingHeadline(s: MappingSummary): string {
  const parts = [`${s.mapped} ${s.mapped === 1 ? "code" : "codes"} mapped`];
  if (s.missing) parts.push(`${s.missing} set missing`);
  if (s.dropped) parts.push(`${s.dropped} dropped`);
  if (s.unplaced) parts.push(`${s.unplaced} unplaced (exported as missing)`);
  return parts.join(", ");
}

/**
 * The value table ONE spec row maps into: the target ITS spec writes, not necessarily the one the panel shows.
 * A refine record's specs write its derived element (with its own codes) while the panel shows the catalog CDE
 * it refines; a row with no spec (a failed one) maps into the target the reviewer was shown (`fallback`).
 */
export function rowTargetValues({
  transform,
  gencde,
  candidates,
  fallback,
}: {
  transform?: { targetCdeId?: string };
  gencde?: { gencdeId: string; permissibleValues?: { code: string; label?: string }[] } | null;
  candidates: { cdeId: string; permissibleValues?: string[] }[];
  fallback: TargetValue[];
}): TargetValue[] {
  const target = transform?.targetCdeId ?? "";
  if (!target) return fallback;
  // A generated element always carries its own value list on the wire; an empty one is a numeric / free-text
  // element, not a missing list, so it never borrows the catalog CDE's values.
  if (gencde && target === gencde.gencdeId) return generatedTargetValues(gencde.permissibleValues);
  const cand = candidates.find((c) => c.cdeId === target);
  const listed = catalogTargetValues(cand?.permissibleValues);
  return listed.length ? listed : fallback;
}
