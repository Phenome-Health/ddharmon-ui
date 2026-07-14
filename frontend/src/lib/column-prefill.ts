// Column-assignment prefill for the New Run flow. When a user drops a CSV, we recognize it by its
// header signature and prefill the column->role mapping from one of two sources:
//   1. the shipped DEMO manifest (canonical assignments that reproduce the showcased run), or
//   2. the user's OWN last-used mapping for a file with the same columns (localStorage; per-browser).
// Unrecognized files prefill nothing (manual assignment, as before). Prefilled values stay editable.
//
// The demo manifest is emitted by scripts/build_demo_bundle.py from build_demos.COHORT_ROLES, so it
// can't drift from the mapping the demo run used. `headerSignature` MUST stay identical to that
// script's _header_signature (trim + lowercase each column, drop empties, sort, join with '|').
import demoManifest from "@/data/demo-column-assignments.json";

interface DemoEntry {
  cohort: string;
  filename: string;
  signature: string;
  roles: Record<string, string>;
}
const DEMO_BY_SIG = new Map<string, DemoEntry>(
  (demoManifest as { entries: DemoEntry[] }).entries.map((e) => [e.signature, e]),
);

const HISTORY_KEY = "ddharmon:column-assignments:v1";
const NONE = "__none__";

export type PrefillSource = "demo" | "history";
export interface Prefill {
  roles: Record<string, string>;
  source: PrefillSource;
}

/** Order-independent key from a CSV's column names. MUST match build_demo_bundle.py::_header_signature. */
export function headerSignature(headers: string[]): string {
  return headers
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
}

function readHistory(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

/**
 * Prefill the role assignments for an uploaded file, recognized by its header signature.
 * Demo-zip files (shipped canonical manifest) win; otherwise the user's own last-used mapping for a file
 * with this exact column set. Returns null for an unrecognized file (→ manual assignment).
 */
export function lookupPrefill(headers: string[]): Prefill | null {
  const sig = headerSignature(headers);
  const demo = DEMO_BY_SIG.get(sig);
  if (demo) return { roles: { ...demo.roles }, source: "demo" };
  const hist = readHistory()[sig];
  if (hist && Object.keys(hist).length) return { roles: { ...hist }, source: "history" };
  return null;
}

/**
 * Remember the assignments a user chose for a file's column set, so a later upload of a same-shaped file
 * prefills them. Per-browser (localStorage) — a future enhancement can sync per-user via the backend DB.
 * Demo-recognized files are NOT stored (they use the shipped canonical manifest). No-op if nothing mapped.
 */
export function rememberAssignment(headers: string[], roles: Record<string, string>): void {
  const cleaned = Object.fromEntries(Object.entries(roles).filter(([, col]) => col && col !== NONE));
  if (!Object.keys(cleaned).length) return;
  const sig = headerSignature(headers);
  if (DEMO_BY_SIG.has(sig)) return; // demo files use the shipped manifest; don't shadow it with history
  try {
    const hist = readHistory();
    hist[sig] = cleaned;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  } catch {
    /* localStorage unavailable/full — silent no-op */
  }
}
