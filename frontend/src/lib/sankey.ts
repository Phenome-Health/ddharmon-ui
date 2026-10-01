// The Sankey's DATA: Cohort -> Verdict -> Destination, link width = variable (member) count. Pure, so it is
// asserted node-side (`frontend/` has no component test runner) and shared by every surface that draws the chart —
// the legacy run view's "Match journey" and Gate 4's export flows (final review round 2). The drawing (hover,
// tooltip, recharts) stays in `components/match-sankey.tsx`.
import { COHORT_PALETTE, VERDICT_COLOR } from "@/lib/chart";
import type { UIRecord } from "@/types";

export const VERDICT_NODE: Record<string, string> = {
  adopt: "Adopt",
  refine: "Refine",
  novel: "Novel",
  unclassified: "Unclassified",
};
const VERDICT_ORDER = ["adopt", "refine", "novel", "unclassified"];
const DEST_ORDER = ["Existing CDE", "GenCDE / new", "Needs review"];
// Reconciliation bucket: fields that never clustered into a concept (HDBSCAN outliers) — so the Sankey's
// cohort widths equal the true per-cohort field count, not just the fields that reached a concept group.
export const UNCLUSTERED = "Unclustered";
export const NOT_MAPPED = "Not mapped";
export const VERDICT_NAMES = new Set([...Object.values(VERDICT_NODE), UNCLUSTERED]); // "Adopt", "Refine", ...
export const DEST_NAMES = new Set([...DEST_ORDER, NOT_MAPPED]);

// Node fill by name -- verdict + destination reuse the verdict palette; cohorts use ph-teal.
const COLORS: Record<string, string> = {
  Adopt: VERDICT_COLOR.adopt,
  Refine: VERDICT_COLOR.refine,
  Novel: VERDICT_COLOR.novel,
  Unclassified: VERDICT_COLOR.unclassified,
  "Existing CDE": VERDICT_COLOR.adopt,
  "GenCDE / new": VERDICT_COLOR.novel,
  "Needs review": VERDICT_COLOR.unclassified,
  [UNCLUSTERED]: VERDICT_COLOR.unclassified,
  [NOT_MAPPED]: VERDICT_COLOR.unclassified,
};
const COHORT_COLOR = COHORT_PALETTE[0];

function colorFor(name: string): string {
  return COLORS[name] ?? COHORT_COLOR;
}

function destOf(verdict: string): string {
  if (verdict === "adopt" || verdict === "refine") return "Existing CDE";
  if (verdict === "novel") return "GenCDE / new";
  return "Needs review";
}

function cohortOf(member: string, fallback: string): string {
  const i = member.indexOf(":");
  return i > 0 ? member.slice(0, i) : fallback;
}

export interface SankeyNodeDatum {
  name: string;
  color: string;
}
export interface SankeyLinkDatum {
  source: number;
  target: number;
  value: number;
  color: string;
  li: number; // index into links[], for hover identity
}
export interface SankeyData {
  nodes: SankeyNodeDatum[];
  links: SankeyLinkDatum[];
  nCohorts: number;
}

export function buildSankeyData(records: UIRecord[], cohortTotals?: Record<string, number>): SankeyData {
  // Keys are JSON tuples, not space-joined strings: destination names contain spaces ("Existing CDE"),
  // so a naive split would mis-parse the node name and produce an undefined link target.
  const cohortVerdict = new Map<string, number>();
  const verdictDest = new Map<string, number>();
  const cohortsSet = new Set<string>();
  const verdictsSet = new Set<string>();
  const destsSet = new Set<string>();

  for (const r of records) {
    const v = r.verdict in VERDICT_NODE ? r.verdict : "unclassified";
    const dest = destOf(v);
    // weight by member (variable) count; fall back to one unit per cohort if members are absent.
    const members = r.members.length ? r.members : r.cohorts.map((c) => `${c}:`);
    for (const m of members) {
      const c = cohortOf(m, r.cohorts[0] ?? "unknown");
      cohortsSet.add(c);
      verdictsSet.add(v);
      destsSet.add(dest);
      const cvKey = JSON.stringify([c, v]);
      const vdKey = JSON.stringify([v, dest]);
      cohortVerdict.set(cvKey, (cohortVerdict.get(cvKey) ?? 0) + 1);
      verdictDest.set(vdKey, (verdictDest.get(vdKey) ?? 0) + 1);
    }
  }

  // Reconcile to the true field count: fields that never clustered into a concept (HDBSCAN outliers) are
  // absent from `records`, so a cohort's mapped members can be < its total fields — which would contradict
  // the "200 fields / cohort" headline. When `cohortTotals` is supplied (per-cohort field count from the
  // embedding atlas), route each cohort's shortfall to an "Unclustered" -> "Not mapped" bucket so its source
  // width equals the true total. Omitted (e.g. mid-replay, atlas withheld) -> the chart just shows mapped flows.
  const cohortMapped = new Map<string, number>();
  for (const [key, value] of cohortVerdict) {
    const [c] = JSON.parse(key) as [string, string];
    cohortMapped.set(c, (cohortMapped.get(c) ?? 0) + value);
  }
  const cohortUnclustered = new Map<string, number>();
  let unclusteredTotal = 0;
  if (cohortTotals) {
    for (const c of new Set([...cohortsSet, ...Object.keys(cohortTotals)])) {
      const gap = (cohortTotals[c] ?? 0) - (cohortMapped.get(c) ?? 0);
      if (gap > 0) {
        cohortsSet.add(c);
        cohortUnclustered.set(c, gap);
        unclusteredTotal += gap;
      }
    }
  }
  const hasUnclustered = unclusteredTotal > 0;

  const cohorts = [...cohortsSet].sort();
  const verdicts = VERDICT_ORDER.filter((v) => verdictsSet.has(v));
  const dests = DEST_ORDER.filter((d) => destsSet.has(d));
  const middleNames = [...verdicts.map((v) => VERDICT_NODE[v]), ...(hasUnclustered ? [UNCLUSTERED] : [])];
  const rightNames = [...dests, ...(hasUnclustered ? [NOT_MAPPED] : [])];
  const nodeNames = [...cohorts, ...middleNames, ...rightNames];
  const idx = new Map(nodeNames.map((n, i) => [n, i]));
  const nodes: SankeyNodeDatum[] = nodeNames.map((name) => ({ name, color: colorFor(name) }));

  const links: SankeyLinkDatum[] = [];
  for (const [key, value] of cohortVerdict) {
    const [c, v] = JSON.parse(key) as [string, string];
    links.push({ source: idx.get(c)!, target: idx.get(VERDICT_NODE[v])!, value, color: colorFor(VERDICT_NODE[v]), li: 0 });
  }
  for (const [key, value] of verdictDest) {
    const [v, d] = JSON.parse(key) as [string, string];
    links.push({ source: idx.get(VERDICT_NODE[v])!, target: idx.get(d)!, value, color: colorFor(VERDICT_NODE[v]), li: 0 });
  }
  for (const [c, gap] of cohortUnclustered) {
    links.push({ source: idx.get(c)!, target: idx.get(UNCLUSTERED)!, value: gap, color: colorFor(UNCLUSTERED), li: 0 });
  }
  if (hasUnclustered) {
    links.push({ source: idx.get(UNCLUSTERED)!, target: idx.get(NOT_MAPPED)!, value: unclusteredTotal, color: colorFor(UNCLUSTERED), li: 0 });
  }
  links.forEach((l, i) => (l.li = i));
  return { nodes, links, nCohorts: cohorts.length };
}
