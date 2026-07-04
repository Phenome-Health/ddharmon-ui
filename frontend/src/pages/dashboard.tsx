import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Ban, Check, ChevronDown, ChevronRight, Download, FileCode, Loader2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { MatchSankey } from "@/components/match-sankey";
import { Analytics } from "@/components/analytics";
import { EmbeddingAtlas } from "@/components/embedding-atlas";
import { exportUrl, submitVerdict } from "@/lib/api";
import { focusLabel, recordMatchesFocus, sameFocus, type Focus } from "@/lib/chart";
import { VERDICT_STYLES, type UIRecord, type UITransform } from "@/types";

// Known phase ordering for the progress bar. The phase LABEL is shown verbatim from the stream (so a new
// pipeline phase still displays); only the percent uses this ordering, falling back gracefully if unknown.
const PHASE_ORDER = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "specs"];
const VERDICT_BAR: Record<string, string> = {
  adopt: "bg-success",
  refine: "bg-warning",
  novel: "bg-ph-navy",
  unclassified: "bg-neutral-400",
};

function phasePercent(phase: string, completed: number, total: number): number {
  if (phase === "complete" || phase === "prepared") return 100;
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < 0) return 5;
  const span = 100 / PHASE_ORDER.length;
  const sub = total > 0 ? (completed / total) * span : 0;
  return Math.min(99, Math.round(idx * span + sub));
}

function cos(x: number | null): string {
  return x == null ? "—" : x.toFixed(3);
}

function transformSummary(t: UITransform): string {
  switch (t.kind) {
    case "identity":
      return "identity (already aligned)";
    case "categorical":
      return `${Object.keys(t.codeMap ?? {}).length} codes mapped${t.unmappedSourceCodes?.length ? `, ${t.unmappedSourceCodes.length} unmapped` : ""}`;
    case "unit":
      return `× ${t.factor ?? "?"}${t.offset ? ` + ${t.offset}` : ""} (${t.sourceUnit ?? "?"} → ${t.targetUnit ?? "?"})`;
    case "arithmetic":
      return t.formula ?? "formula";
    case "data_dependent":
      return `${t.method ?? "data-dependent"} (needs data at apply-time)`;
    default:
      return "no spec";
  }
}

export default function DashboardPage() {
  const { jobId = "" } = useParams();
  const [, navigate] = useLocation();
  const { jobState, error } = useHarmonizeStream(jobId);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Shared brushing-and-linking selection: clicking any chart element sets it; it filters the review queue
  // and emphasizes the matching slice across every chart. Clicking the same element again clears it.
  const [focus, setFocus] = useState<Focus>(null);
  const toggleFocus = (f: Focus) => setFocus((cur) => (sameFocus(cur, f) ? null : f));

  const result = jobState?.result ?? null;
  const records = useMemo<UIRecord[]>(() => result?.records ?? [], [result]);
  const filtered = useMemo(() => records.filter((r) => recordMatchesFocus(r, focus)), [records, focus]);

  async function decide(r: UIRecord, decision: "approve" | "refine" | "reject") {
    setDecisions((p) => ({ ...p, [r.id]: decision }));
    try {
      await submitVerdict(jobId, r.id, decision, notes[r.id] ?? "");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save decision");
    }
  }

  if (!jobState) {
    return (
      <div className="flex items-center gap-2 p-8 text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Connecting to run…
      </div>
    );
  }

  const running = jobState.status !== "complete" && jobState.status !== "error";
  const isPreview = result?.mode === "preview";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <nav className="mb-1 text-xs text-neutral-500">
            <Link href="/jobs" className="hover:text-ph-navy hover:underline">
              Runs
            </Link>
            <span className="mx-1 text-neutral-300">/</span>
            <span className="font-mono">{jobId.slice(0, 8)}</span>
          </nav>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-ph-ink">
            {jobState.displayName}
            {result && (
              <Badge variant="neutral" className="font-normal">
                {result.mode}
              </Badge>
            )}
          </h1>
          <p className="text-sm text-neutral-500">Split-aware CDE harmonization run</p>
        </div>
        {result && !isPreview && (
          <div className="flex gap-2">
            <Button size="sm" asChild>
              <Link href={`/job/${jobId}/workbench`}>Review workbench</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={exportUrl(jobId, "eitl_tsv")}>
                <Download className="mr-1.5 h-4 w-4" /> EITL TSV
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={exportUrl(jobId, "decisions_csv")}>
                <Download className="mr-1.5 h-4 w-4" /> Decisions
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={exportUrl(jobId, "records_json")}>
                <Download className="mr-1.5 h-4 w-4" /> Records JSON
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={exportUrl(jobId, "notebook_py")}>
                <FileCode className="mr-1.5 h-4 w-4" /> Notebook · Python
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={exportUrl(jobId, "notebook_r")}>
                <FileCode className="mr-1.5 h-4 w-4" /> Notebook · R
              </a>
            </Button>
          </div>
        )}
      </div>

      {(running || error) && (
        <Card>
          <CardContent className="space-y-2 py-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium capitalize text-neutral-700">
                {error ? "Error" : `Phase: ${jobState.phase}`}
              </span>
              <span className="text-neutral-500">{jobState.total > 0 ? `${jobState.completed}/${jobState.total}` : ""}</span>
            </div>
            <Progress value={error ? 100 : phasePercent(jobState.phase, jobState.completed, jobState.total)} />
            {error && <p className="text-sm text-danger">{error.message}</p>}
          </CardContent>
        </Card>
      )}

      {result && isPreview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview prepared (no LLM)</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-neutral-600">
            Clustering + retrieval ran and{" "}
            <span className="font-semibold text-ph-ink">{result.prompts.ideal}</span> concept prompts were built. Re-run
            in <span className="font-medium">batch</span> or <span className="font-medium">sync</span> mode to produce
            adopt / refine / novel decisions.
          </CardContent>
        </Card>
      )}

      {result && !isPreview && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Records" value={result.summary.nRecords} />
            <StatCard label="Assigned to CDE" value={result.summary.nAssigned} />
            <StatCard label="Cross-cohort" value={result.summary.nCrossCohort} />
            <StatCard label="With transform specs" value={result.summary.nWithTransforms} />
          </div>

          {focus && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-ph-navy/20 bg-ph-navy/5 px-3 py-2 text-sm">
              <span className="text-neutral-500">Focused on</span>
              <Badge
                variant="outline"
                className={focus.kind === "verdict" ? (VERDICT_STYLES[focus.value] ?? "") : "border-ph-teal/50 text-ph-navy"}
              >
                {focus.kind === "cohort" ? "cohort · " : ""}
                {focusLabel(focus)}
              </Badge>
              <span className="text-neutral-500">
                {filtered.length} of {records.length} concepts · click any chart to change
              </span>
              <button
                onClick={() => setFocus(null)}
                className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-ph-navy"
              >
                Clear <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Match journey</CardTitle>
            </CardHeader>
            <CardContent>
              <MatchSankey records={records} focus={focus} onFocus={toggleFocus} />
            </CardContent>
          </Card>

          <Analytics records={records} focus={focus} onFocus={toggleFocus} />

          {result.atlas.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Embedding atlas</CardTitle>
              </CardHeader>
              <CardContent>
                <EmbeddingAtlas
                  points={result.atlas}
                  records={records}
                  focus={focus}
                  onFocus={toggleFocus}
                  onOpenConcept={(id) => navigate(`/job/${jobId}/workbench?c=${encodeURIComponent(id)}`)}
                />
                <p className="mt-1 text-xs text-neutral-400">PCA of field embeddings · colored by cohort or verdict</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Review queue ({filtered.length})</CardTitle>
              <Select
                value={focus?.kind === "verdict" ? focus.value : "all"}
                onValueChange={(v) => setFocus(v === "all" ? null : { kind: "verdict", value: v })}
              >
                <SelectTrigger className="h-8 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All verdicts</SelectItem>
                  <SelectItem value="adopt">Adopt</SelectItem>
                  <SelectItem value="refine">Refine</SelectItem>
                  <SelectItem value="novel">Novel</SelectItem>
                  <SelectItem value="unclassified">Unclassified</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-6" />
                    <TableHead>Concept</TableHead>
                    <TableHead>CDE</TableHead>
                    <TableHead>Verdict</TableHead>
                    <TableHead className="text-right">cos</TableHead>
                    <TableHead>Cohorts</TableHead>
                    <TableHead className="text-right">Specs</TableHead>
                    <TableHead>Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <RecordRows
                      key={r.id}
                      r={r}
                      open={!!expanded[r.id]}
                      toggle={() => setExpanded((p) => ({ ...p, [r.id]: !p[r.id] }))}
                      decision={decisions[r.id]}
                      note={notes[r.id] ?? ""}
                      onNote={(v) => setNotes((p) => ({ ...p, [r.id]: v }))}
                      onDecide={(d) => decide(r, d)}
                    />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function RecordRows({
  r,
  open,
  toggle,
  decision,
  note,
  onNote,
  onDecide,
}: {
  r: UIRecord;
  open: boolean;
  toggle: () => void;
  decision?: string;
  note: string;
  onNote: (v: string) => void;
  onDecide: (d: "approve" | "refine" | "reject") => void;
}) {
  return (
    <>
      <TableRow className="cursor-pointer" onClick={toggle}>
        <TableCell className="align-top text-neutral-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </TableCell>
        <TableCell className="max-w-xs align-top">
          <div className="font-medium text-neutral-700">{r.concept || r.id}</div>
          <div className="truncate text-xs text-neutral-400">
            {r.nMembers} {r.nMembers === 1 ? "field" : "fields"}
            {r.crossCohort && " · cross-cohort"}
            {r.coverageGap && " · coverage gap"}
            {r.floored && " · floored"}
          </div>
        </TableCell>
        <TableCell className="align-top text-sm text-neutral-600">
          {r.cde ? (
            <div>
              <div>{r.cde.id}</div>
              {r.cde.externalId && <div className="text-xs text-neutral-400">{r.cde.externalId}</div>}
            </div>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="align-top">
          <Badge variant="outline" className={VERDICT_STYLES[r.verdict] ?? ""}>
            {r.verdict}
          </Badge>
        </TableCell>
        <TableCell className="align-top text-right text-sm tabular-nums">{cos(r.cosines.chosen ?? r.cosines.top1)}</TableCell>
        <TableCell className="align-top text-xs text-neutral-500">{r.cohorts.join(", ")}</TableCell>
        <TableCell className="align-top text-right text-sm tabular-nums">{r.transforms.length || "—"}</TableCell>
        <TableCell className="align-top" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <DecisionBtn active={decision === "approve"} onClick={() => onDecide("approve")} title="Approve" color="text-success">
              <Check className="h-4 w-4" />
            </DecisionBtn>
            <DecisionBtn active={decision === "refine"} onClick={() => onDecide("refine")} title="Refine" color="text-warning">
              <Pencil className="h-4 w-4" />
            </DecisionBtn>
            <DecisionBtn active={decision === "reject"} onClick={() => onDecide("reject")} title="Reject" color="text-danger">
              <Ban className="h-4 w-4" />
            </DecisionBtn>
            <Input
              placeholder="note"
              value={note}
              onChange={(e) => onNote(e.target.value)}
              className="h-7 w-28 text-xs"
            />
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-neutral-50/60 hover:bg-neutral-50/60">
          <TableCell />
          <TableCell colSpan={7} className="space-y-3 py-4 text-sm">
            {/* provenance triple: source → verdict → CDE (Monarch association-detail idiom) */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-neutral-200 bg-neutral-0 px-2 py-0.5 text-xs text-neutral-600">
                {r.nMembers} {r.nMembers === 1 ? "field" : "fields"} · {r.cohorts.join(", ") || "—"}
              </span>
              <span className="text-neutral-300">→</span>
              <Badge variant="outline" className={VERDICT_STYLES[r.verdict] ?? ""}>
                {r.verdict}
              </Badge>
              <span className="text-neutral-300">→</span>
              {r.cde ? (
                <span className="rounded border border-neutral-200 bg-neutral-0 px-2 py-0.5 text-xs">
                  <span className="font-medium text-neutral-700">{r.cde.id}</span>
                  {r.cde.externalId && <span className="ml-1 font-mono text-neutral-400">{r.cde.externalId}</span>}
                </span>
              ) : (
                <span className="text-xs text-neutral-500">GenCDE (novel)</span>
              )}
              <Badge variant="neutral" className="ml-auto font-normal">
                {r.decidedBy === "deterministic" ? "rule" : "AI"}
              </Badge>
            </div>

            {(r.cosines.chosen ?? r.cosines.top1) != null && (
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Confidence
                </span>
                <ConfidenceBar value={r.cosines.chosen ?? r.cosines.top1 ?? 0} verdict={r.verdict} />
                <span className="text-xs tabular-nums text-neutral-600">{cos(r.cosines.chosen ?? r.cosines.top1)}</span>
              </div>
            )}

            {r.rationale && (
              <blockquote className="border-l-2 border-neutral-300 pl-3 italic text-neutral-600">{r.rationale}</blockquote>
            )}

            <DetailLine label="Ideal CDE" value={r.idealCde || "—"} />
            <DetailLine label="Members" value={r.members.join(", ") || "—"} />
            {r.transforms.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Transform specs</div>
                <div className="space-y-1">
                  {r.transforms.map((t, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="secondary" className="font-mono">
                        {t.kind}
                      </Badge>
                      <span className="font-mono text-neutral-600">{t.sourceVariable}</span>
                      <span className="text-neutral-400">→</span>
                      <span className="text-neutral-600">{transformSummary(t)}</span>
                      {t.needsReview && <Badge variant="outline" className="border-warning/40 text-warning">needs review</Badge>}
                      {t.needsUnits && <Badge variant="outline" className="border-warning/40 text-warning">needs units</Badge>}
                      {t.needsData && <Badge variant="outline" className="border-warning/40 text-warning">needs data</Badge>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ConfidenceBar({ value, verdict }: { value: number; verdict: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-neutral-200">
      <div className={`h-full rounded-full ${VERDICT_BAR[verdict] ?? "bg-neutral-400"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</span>
      <span className="text-neutral-700">{value}</span>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent>
        <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-ph-ink">{value}</div>
      </CardContent>
    </Card>
  );
}

function DecisionBtn({
  active,
  onClick,
  title,
  color,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon"
      className={`h-7 w-7 ${active ? color : "text-neutral-400"}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  );
}
