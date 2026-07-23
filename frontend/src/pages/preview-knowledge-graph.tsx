// PREVIEW / MOCKUP — "Bridge into a biomedical knowledge graph" (roadmap: Interoperability, Exploring).
// A design sketch of resolving each harmonized concept to a node in a biomedical knowledge graph that
// already carries Common Data Elements and their cross-vocabulary equivalents. Everything here is sample
// data and runs in the browser — no run, no backend, no graph call. Only the thin concept↔node mapping
// layer is shown; value domains and transform specs deliberately stay out of the graph.
import { useState } from "react";
import { AlertTriangle, ArrowRight, Check, Link2, Network, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PreviewShell } from "@/components/preview-shell";

type Verdict = "adopt" | "refine" | "novel";
type Relation = "exact_match" | "close_match" | "related_to" | "new";

interface Equivalent {
  vocab: string;
  id: string;
}
interface KgLink {
  id: string;
  concept: string; // harmonized concept label
  verdict: Verdict;
  cohorts: string[]; // contributing cohorts
  node: string | null; // existing graph node (a CDE node) — null → would propose a new node
  nodeId: string | null; // the graph identifier the concept resolves to
  relation: Relation;
  equivalents: Equivalent[]; // cross-vocabulary identifiers carried on the node
  confidence: number; // 0..1 link confidence
}

// Sample cross-cohort run. Assumes the graph already has NIH Common Data Elements ingested as nodes; each
// harmonized concept either resolves to one (adopt/refine) or would seed a new node (novel). Illustrative.
const LINKS: KgLink[] = [
  {
    id: "dbp",
    concept: "Diastolic blood pressure",
    verdict: "adopt",
    cohorts: ["UK Biobank", "MESA", "CLSA", "AI-READI"],
    node: "Diastolic Blood Pressure Measurement",
    nodeId: "CDE:2179000",
    relation: "exact_match",
    equivalents: [
      { vocab: "LOINC", id: "8462-4" },
      { vocab: "SNOMED", id: "271650006" },
      { vocab: "NCIT", id: "C25299" },
    ],
    confidence: 0.96,
  },
  {
    id: "bmi",
    concept: "Body mass index",
    verdict: "adopt",
    cohorts: ["All of Us", "CLSA", "UK Biobank", "MESA", "AI-READI"],
    node: "Body Mass Index",
    nodeId: "CDE:2006809",
    relation: "exact_match",
    equivalents: [
      { vocab: "LOINC", id: "39156-5" },
      { vocab: "SNOMED", id: "60621009" },
    ],
    confidence: 0.98,
  },
  {
    id: "phq",
    concept: "Depression severity (PHQ-9 total)",
    verdict: "refine",
    cohorts: ["All of Us", "UK Biobank", "MESA"],
    node: "Patient Health Questionnaire 9 Total Score",
    nodeId: "CDE:6142509",
    relation: "close_match",
    equivalents: [
      { vocab: "LOINC", id: "44261-6" },
      { vocab: "NCIT", id: "C122060" },
    ],
    confidence: 0.88,
  },
  {
    id: "smk",
    concept: "Current smoking status",
    verdict: "refine",
    cohorts: ["All of Us", "CLSA", "UK Biobank", "MESA", "AI-READI"],
    node: "Tobacco Smoking Status",
    nodeId: "CDE:2181650",
    relation: "related_to",
    equivalents: [
      { vocab: "LOINC", id: "72166-2" },
      { vocab: "SNOMED", id: "77176002" },
    ],
    confidence: 0.74,
  },
  {
    id: "gait",
    concept: "Usual gait speed",
    verdict: "refine",
    cohorts: ["CLSA", "MESA", "AI-READI"],
    node: "Gait Speed Measurement",
    nodeId: "CDE:3540220",
    relation: "related_to",
    equivalents: [{ vocab: "LOINC", id: "41950-7" }],
    confidence: 0.44,
  },
  {
    id: "lonely",
    concept: "Loneliness (UCLA 3-item) score",
    verdict: "novel",
    cohorts: ["All of Us", "CLSA"],
    node: null,
    nodeId: null,
    relation: "new",
    equivalents: [],
    confidence: 0.63,
  },
];

const VERDICT: Record<Verdict, { label: string; variant: "success" | "warning" | "brand" }> = {
  adopt: { label: "adopt", variant: "success" },
  refine: { label: "refine", variant: "warning" },
  novel: { label: "novel", variant: "brand" },
};

// SKOS-style mapping relation between the concept and its graph node.
const REL: Record<Relation, { label: string; className: string }> = {
  exact_match: { label: "skos:exactMatch", className: "border-success-border bg-success-bg text-success" },
  close_match: { label: "skos:closeMatch", className: "border-success-border bg-success-bg text-success" },
  related_to: { label: "skos:relatedMatch", className: "border-info-border bg-info-bg text-info" },
  new: { label: "would create node", className: "border-ph-navy/30 bg-ph-navy/5 text-ph-navy" },
};

const REVIEW_THRESHOLD = 0.6;

export default function PreviewKnowledgeGraphPage() {
  const [activeId, setActiveId] = useState(LINKS[0].id);
  const active = LINKS.find((l) => l.id === activeId)!;

  const resolved = LINKS.filter((l) => l.node !== null).length;
  const proposed = LINKS.filter((l) => l.node === null).length;
  const review = LINKS.filter((l) => l.confidence < REVIEW_THRESHOLD).length;

  const needsReview = active.confidence < REVIEW_THRESHOLD;
  const confTone =
    active.confidence >= 0.8 ? "text-success" : active.confidence >= REVIEW_THRESHOLD ? "text-warning" : "text-danger";

  return (
    <PreviewShell
      title="Bridge into a biomedical knowledge graph"
      intro="Resolve each harmonized concept to a node in a biomedical knowledge graph that already carries Common Data Elements and their cross-vocabulary equivalents — turning a run's crosswalk into linked graph identifiers. Select a concept to see how it lands in the graph."
    >
      {/* Summary strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-neutral-600">
          <span className="font-semibold text-ph-ink">{LINKS.length}</span> concepts
        </span>
        <span className="rounded-md border border-success-border bg-success-bg px-2.5 py-1 text-success">
          <span className="font-semibold">{resolved}</span> resolved to existing nodes
        </span>
        <span className="rounded-md border border-ph-navy/30 bg-ph-navy/5 px-2.5 py-1 text-ph-navy">
          <span className="font-semibold">{proposed}</span> would create a new node
        </span>
        <span className="rounded-md border border-warning-border bg-warning-bg px-2.5 py-1 text-warning">
          <span className="font-semibold">{review}</span> flagged for review
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        {/* Left — harmonized concepts from the run */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Harmonized concepts</CardTitle>
            <p className="text-xs text-neutral-400">This run&apos;s crosswalk. Select one to see its graph linkage.</p>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {LINKS.map((l) => {
              const on = l.id === activeId;
              const flag = l.confidence < REVIEW_THRESHOLD;
              return (
                <button
                  key={l.id}
                  onClick={() => setActiveId(l.id)}
                  className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm ${
                    on ? "border-ph-navy/30 bg-ph-navy/5" : "border-neutral-200 hover:border-neutral-300"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-neutral-700">{l.concept}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-neutral-400">
                      {l.node ? l.nodeId : "no existing node — propose new"}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant={VERDICT[l.verdict].variant} className="text-[10px]">
                      {VERDICT[l.verdict].label}
                    </Badge>
                    {flag && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-warning">
                        <AlertTriangle className="h-3 w-3" /> review
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </CardContent>
        </Card>

        {/* Right — the graph linkage for the active concept */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Network className="h-4 w-4 text-ph-navy" /> Graph linkage
            </CardTitle>
            <p className="text-xs text-neutral-400">
              How <span className="text-neutral-600">{active.concept}</span> resolves into the knowledge graph.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Concept → relation → node flow */}
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              {/* Concept node */}
              <div className="flex-1 rounded-lg border border-ph-navy/30 bg-ph-navy/5 p-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-ph-navy">Harmonized concept</div>
                <div className="mt-0.5 text-sm font-semibold text-ph-ink">{active.concept}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <Badge variant={VERDICT[active.verdict].variant} className="text-[10px]">
                    {VERDICT[active.verdict].label}
                  </Badge>
                  <span className="text-[11px] text-neutral-500">{active.cohorts.length} cohorts</span>
                </div>
              </div>

              {/* Relation edge */}
              <div className="flex shrink-0 flex-col items-center gap-1">
                <Badge variant="neutral" className={`font-mono text-[10px] ${REL[active.relation].className}`}>
                  {REL[active.relation].label}
                </Badge>
                <ArrowRight className="h-4 w-4 rotate-90 text-neutral-300 sm:rotate-0" />
                <span className="text-[10px] text-neutral-400">provided by ddharmon</span>
              </div>

              {/* Graph node */}
              {active.node ? (
                <div className="flex-1 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">Graph node (CDE)</div>
                  <div className="mt-0.5 text-sm font-semibold text-neutral-700">{active.node}</div>
                  <div className="mt-1 font-mono text-[11px] text-neutral-500">{active.nodeId}</div>
                </div>
              ) : (
                <div className="flex-1 rounded-lg border border-dashed border-ph-navy/40 bg-ph-navy/5 p-3">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-ph-navy">New graph node</div>
                  <div className="mt-0.5 flex items-center gap-1 text-sm font-semibold text-ph-navy">
                    <Sparkles className="h-3.5 w-3.5" /> Proposed (GenCDE)
                  </div>
                  <div className="mt-1 text-[11px] text-neutral-500">No existing element matched — a new node would be created.</div>
                </div>
              )}
            </div>

            {/* Cross-vocabulary equivalents */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                <Link2 className="h-3.5 w-3.5" /> Equivalent identifiers
              </div>
              {active.equivalents.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {active.equivalents.map((e) => (
                    <span
                      key={`${e.vocab}:${e.id}`}
                      className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-mono text-[11px] text-neutral-600"
                    >
                      <span className="text-neutral-400">{e.vocab}:</span>
                      {e.id}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-neutral-400">
                  None yet — cross-vocabulary links would be attached when the new node is created.
                </p>
              )}
            </div>

            {/* Link confidence + review routing */}
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium uppercase tracking-wide text-neutral-400">Link confidence</span>
                <span className={`font-mono font-semibold ${confTone}`}>{active.confidence.toFixed(2)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                <div className="h-full rounded-full bg-ph-navy/70" style={{ width: `${Math.round(active.confidence * 100)}%` }} />
              </div>
              {needsReview ? (
                <div className="mt-2 flex items-start gap-1.5 rounded-md bg-warning-bg px-2 py-1.5 text-xs text-neutral-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <span>Low link confidence — routed to expert review before it&apos;s written to the graph.</span>
                </div>
              ) : (
                <div className="mt-2 flex items-start gap-1.5 rounded-md bg-success-bg px-2 py-1.5 text-xs text-neutral-700">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  <span>High-confidence link — ready to write as a mapping edge.</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-neutral-400">
        In the real feature, each anchored concept is resolved to a graph node through an
        annotate → normalize → link → resolve pipeline, writing a thin concept layer: harmonized-concept, CDE
        and GenCDE nodes joined by mapping edges (exact/close match for adopt, related for refine), each tagged
        with its provenance. Value domains, transform specs and review state stay out of the graph. Low-confidence
        resolutions go to the expert-review queue before anything is committed.
      </p>
    </PreviewShell>
  );
}
