import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileCode,
  Info,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { MatchSankey } from "@/components/match-sankey";
import { Analytics } from "@/components/analytics";
import { EmbeddingAtlas } from "@/components/embedding-atlas";
import { exportUrl, submitVerdict } from "@/lib/api";
import { focusLabel, recordMatchesFocus, sameFocus, type Focus } from "@/lib/chart";
import { VERDICT_STYLES, type UIRecord } from "@/types";

// Known phase ordering for the progress bar. The phase LABEL is shown verbatim from the stream (so a new
// pipeline phase still displays); only the percent uses this ordering, falling back gracefully if unknown.
const PHASE_ORDER = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "specs"];
const VERDICT_BAR: Record<string, string> = {
  adopt: "bg-success",
  refine: "bg-warning",
  novel: "bg-ph-navy",
  unclassified: "bg-neutral-400",
};

/** Click-to-open explainer of what is / isn't reproducible run-to-run. Shown on every run's header. */
function ReproducibilityInfo() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500 transition-colors hover:border-ph-navy/40 hover:text-ph-navy"
        >
          <Info className="h-3 w-3" /> Reproducibility
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-xs font-normal leading-relaxed">
        <p className="mb-2 text-sm font-semibold text-ph-ink">How reproducible is a run?</p>
        <p className="mb-2 text-neutral-600">
          Embeddings are deterministic. Two stages are <span className="font-medium">not</span> bitwise-reproducible:
        </p>
        <ul className="mb-2 list-disc space-y-1 pl-4 text-neutral-600">
          <li>
            <span className="font-medium">Clustering</span> (UMAP/HDBSCAN) — cluster boundaries can shift run to run.
          </li>
          <li>
            <span className="font-medium">LLM assignment</span> — runs at temperature 0, but the model gives no
            bitwise guarantee, so a few borderline verdicts may flip.
          </li>
        </ul>
        <p className="mb-2 text-neutral-600">
          The split-aware assignment re-derives concepts from each cluster, so most of that drift washes out of the
          final grouping.
        </p>
        <p className="mb-2 rounded-md bg-neutral-50 p-2 text-neutral-600">
          <span className="font-medium text-ph-ink">Reference</span> (3×200-field cohorts, two independent fresh
          runs): ~85% of concepts recurred and ~87% of shared concepts kept the same verdict (record count
          350&nbsp;→&nbsp;320).
        </p>
        <p className="text-neutral-500">
          A <span className="font-medium">saved / demo run</span> replays a frozen snapshot + cached responses —
          identical every time.
        </p>
      </PopoverContent>
    </Popover>
  );
}

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

// ── review-queue sorting ──────────────────────────────────────────────────────────────────────
type SortKey = "concept" | "cde" | "verdict" | "cos" | "cohorts" | "specs";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey;
  dir: SortDir;
}
// Verdict sort order mirrors the EITL review priority (adopt → refine → novel → unclassified).
const VERDICT_RANK: Record<string, number> = { adopt: 0, refine: 1, novel: 2, unclassified: 3 };

function sortValue(r: UIRecord, key: SortKey): string | number {
  switch (key) {
    case "concept":
      return (r.concept || r.id).toLowerCase();
    case "cde":
      return (r.cde?.id ?? "").toLowerCase();
    case "verdict":
      return VERDICT_RANK[r.verdict] ?? 9;
    case "cos":
      return r.cosines.chosen ?? r.cosines.top1 ?? -1; // nulls (novels) sort as lowest support
    case "cohorts":
      return r.cohorts.join(",").toLowerCase();
    case "specs":
      return r.transforms.length;
  }
}

function sortRecords(records: UIRecord[], sort: SortState | null): UIRecord[] {
  if (!sort) return records;
  const arr = [...records];
  arr.sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sort.dir === "asc" ? c : -c;
  });
  return arr;
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
  const [sort, setSort] = useState<SortState | null>(null);
  const onSort = (key: SortKey) =>
    setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  // Cross-cohort = the actual harmonization (a concept pooled from ≥2 cohorts). Single-cohort concepts are
  // CDE-mappings (the CDEMapper/DIVER lane). This toggle narrows the queue to the harmonization subset.
  const [xcOnly, setXcOnly] = useState(false);

  const result = jobState?.result ?? null;
  const records = useMemo<UIRecord[]>(() => result?.records ?? [], [result]);
  const filtered = useMemo(
    () => records.filter((r) => recordMatchesFocus(r, focus) && (!xcOnly || r.crossCohort)),
    [records, focus, xcOnly],
  );
  const sorted = useMemo(() => sortRecords(filtered, sort), [filtered, sort]);
  const headerCohorts = useMemo(() => [...new Set(records.flatMap((r) => r.cohorts))].sort(), [records]);
  // Stats derived from the records revealed so far, so the cards grow live during the demo replay; at
  // completion they equal result.summary (route/crossCohort/transforms mirror the backend _summarize).
  const stats = useMemo(() => {
    let nAssigned = 0;
    let nCrossCohort = 0;
    let nCrossAssigned = 0;
    let nSingleAssigned = 0;
    let nSingleNovel = 0;
    let nWithTransforms = 0;
    for (const r of records) {
      const assigned = r.route === "assigned";
      if (assigned) nAssigned += 1;
      if (r.transforms.length) nWithTransforms += 1;
      if (r.crossCohort) {
        nCrossCohort += 1;
        if (assigned) nCrossAssigned += 1;
      } else if (assigned) {
        nSingleAssigned += 1;
      } else {
        nSingleNovel += 1;
      }
    }
    return {
      nRecords: records.length,
      nAssigned,
      nCrossCohort,
      nCrossAssigned,
      nSingle: records.length - nCrossCohort,
      nSingleAssigned,
      nSingleNovel,
      nWithTransforms,
    };
  }, [records]);

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
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <nav className="mb-1 text-xs text-neutral-500">
              <Link href="/jobs" className="hover:text-ph-navy hover:underline">
                Runs
              </Link>
              <span className="mx-1 text-neutral-300">/</span>
              <span className="font-mono">{jobId.slice(0, 8)}</span>
            </nav>
            <h1 className="text-2xl font-semibold text-ph-ink">{jobState.displayName}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-500">
              {result && (
                <Badge variant="neutral" className="font-normal">
                  {result.mode}
                </Badge>
              )}
              <span>Split-aware CDE harmonization run</span>
              {headerCohorts.length > 0 && (
                <>
                  <span className="text-neutral-300">·</span>
                  <span className="font-mono text-xs text-neutral-400">{headerCohorts.join(" · ")}</span>
                </>
              )}
              <span className="text-neutral-300">·</span>
              <ReproducibilityInfo />
            </div>
          </div>
          {result && !isPreview && !running && records.length > 0 && (
            <Button size="sm" asChild className="shrink-0">
              <Link href={`/job/${jobId}/workbench`}>Review workbench</Link>
            </Button>
          )}
        </div>

        {result && !isPreview && !running && records.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
            <span className="mr-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Export</span>
            <ExportButton
              href={exportUrl(jobId, "eitl_tsv")}
              icon={Download}
              label="EITL TSV"
              tip="Tab-separated review queue for expert-in-the-loop sign-off — one row per concept with its verdict, confidence, ranked CDE candidates, and transform. Opens in Excel; import into an EITL campaign."
            />
            <ExportButton
              href={exportUrl(jobId, "decisions_csv")}
              icon={Download}
              label="Decisions"
              tip="CSV log of your approve / refine / reject decisions for this run — concept, verdict, chosen CDE, and reviewer note. Your audit trail."
            />
            <ExportButton
              href={exportUrl(jobId, "records_json")}
              icon={Download}
              label="Records JSON"
              tip="The full machine-readable result — every concept with its members, verdict, ranked CDE candidates, cosine scores, and transform specs. The source of truth for programmatic use."
            />
            <ExportButton
              href={exportUrl(jobId, "notebook_py")}
              icon={FileCode}
              label="Notebook · Python"
              tip="A ready-to-run Python notebook that applies the harmonization transforms (value recodes, unit and arithmetic conversions) to your data in your own environment."
            />
            <ExportButton
              href={exportUrl(jobId, "notebook_r")}
              icon={FileCode}
              label="Notebook · R"
              tip="A ready-to-run R notebook that applies the harmonization transforms to your data in your own environment."
            />
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

      {result && !isPreview && records.length > 0 && (
        <>
          {/* Segment harmonization (cross-cohort pooling — the cross-dataset payoff) from single-cohort
              CDE-mapping (the CDEMapper/DIVER lane), rather than one blended "assigned" count. */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Concepts" value={stats.nRecords} sub={`${stats.nWithTransforms} with transform specs`} />
            <StatCard
              label="Harmonized · cross-cohort"
              value={stats.nCrossCohort}
              sub={`${stats.nCrossAssigned} mapped to a CDE`}
              accent
            />
            <StatCard
              label="Single-cohort · CDE-mapping"
              value={stats.nSingle}
              sub={`${stats.nSingleAssigned} mapped · ${stats.nSingleNovel} novel`}
            />
            <StatCard
              label="Assigned to CDE"
              value={stats.nAssigned}
              sub={`${stats.nCrossAssigned} cross · ${stats.nSingleAssigned} single`}
            />
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

          {!running && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Review queue ({filtered.length})</CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={xcOnly ? "secondary" : "outline"}
                  size="sm"
                  className={`h-8 ${xcOnly ? "text-ph-navy" : "text-neutral-500"}`}
                  onClick={() => setXcOnly((v) => !v)}
                  title="Show only concepts pooled from 2+ cohorts (the harmonization subset)"
                >
                  Cross-cohort only
                </Button>
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
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-6" />
                    <SortableHead label="Concept" sortKey="concept" sort={sort} onSort={onSort} />
                    <SortableHead label="CDE" sortKey="cde" sort={sort} onSort={onSort} />
                    <SortableHead label="Verdict" sortKey="verdict" sort={sort} onSort={onSort} />
                    <SortableHead
                      label="cos"
                      sortKey="cos"
                      sort={sort}
                      onSort={onSort}
                      align="right"
                      tip="Cosine similarity (0–1) between the concept and the chosen CDE embedding — a retrieval signal, not a calibrated model confidence. The LLM's decision is the verdict. Sort ascending to review the weakest matches first."
                    />
                    <SortableHead label="Cohorts" sortKey="cohorts" sort={sort} onSort={onSort} />
                    <SortableHead label="Specs" sortKey="specs" sort={sort} onSort={onSort} align="right" />
                    <TableHead>Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((r) => (
                    <RecordRows
                      key={r.id}
                      r={r}
                      jobId={jobId}
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
          )}
        </>
      )}
    </div>
  );
}

function RecordRows({
  r,
  jobId,
  open,
  toggle,
  decision,
  note,
  onNote,
  onDecide,
}: {
  r: UIRecord;
  jobId: string;
  open: boolean;
  toggle: () => void;
  decision?: string;
  note: string;
  onNote: (v: string) => void;
  onDecide: (d: "approve" | "refine" | "reject") => void;
}) {
  // The chosen candidate can have a lower cosine than a nearer one — the assign LLM ranks concept fit over
  // embedding similarity. Flag that so the reviewer knows to read the rationale (why the model overrode cos).
  const reranked =
    r.cosines.chosen != null && r.cosines.top1 != null && r.cosines.chosen < r.cosines.top1 - 1e-6;
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
                <span className="flex w-24 shrink-0 items-center gap-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Cosine
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 cursor-help text-neutral-300" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs whitespace-normal text-left font-normal normal-case leading-relaxed">
                      Cosine similarity to the chosen CDE embedding (0–1) — the retrieval signal behind this match.
                      It is not a calibrated model confidence; the LLM&apos;s decision is the verdict (adopt / refine
                      / novel). The pipeline does not emit a separate confidence score.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <ConfidenceBar value={r.cosines.chosen ?? r.cosines.top1 ?? 0} verdict={r.verdict} />
                <span className="text-xs tabular-nums text-neutral-600">{cos(r.cosines.chosen ?? r.cosines.top1)}</span>
              </div>
            )}

            {reranked && (
              <p className="text-xs text-neutral-500">
                The model ranked concept fit over similarity — it chose a candidate at cos{" "}
                <span className="tabular-nums">{cos(r.cosines.chosen)}</span> over a nearer one at cos{" "}
                <span className="tabular-nums">{cos(r.cosines.top1)}</span>. See the rationale.
              </p>
            )}

            {r.rationale && (
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">Model rationale</div>
                <blockquote className="border-l-2 border-neutral-300 pl-3 italic text-neutral-600">
                  {r.rationale}
                </blockquote>
              </div>
            )}

            {/* Summary only — the full detail (source variables, ranked CDE candidates, value mapping) lives
                in the workbench, one click away. Keeps the queue a scannable triage surface. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
              <span>
                {r.nMembers} {r.nMembers === 1 ? "field" : "fields"} · {r.cohorts.join(", ") || "—"}
                {r.crossCohort ? " · cross-cohort" : ""}
              </span>
              {r.transforms.length > 0 && (
                <span>
                  · {r.transforms.length} transform spec{r.transforms.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            <div className="pt-1">
              <Link
                href={`/job/${jobId}/workbench?c=${encodeURIComponent(r.id)}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-ph-navy hover:underline"
              >
                Open in review workbench — source variables, all CDE candidates &amp; value mapping
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
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

function SortableHead({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  tip,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState | null;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  tip?: string;
}) {
  const active = sort?.key === sortKey;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className="inline-flex items-center gap-1 font-medium hover:text-ph-navy"
        >
          {label}
          <Icon className={`h-3 w-3 ${active ? "text-ph-navy" : "text-neutral-300"}`} />
        </button>
        {tip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3 w-3 cursor-help text-neutral-300" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal text-left font-normal leading-relaxed">
              {tip}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
    </TableHead>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card className={accent ? "border-ph-navy/30 bg-ph-navy/[0.03]" : undefined}>
      <CardContent>
        <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-ph-ink">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-neutral-400">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function ExportButton({
  href,
  icon: Icon,
  label,
  tip,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" asChild>
          <a href={href}>
            <Icon className="mr-1.5 h-4 w-4" /> {label}
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal text-left font-normal leading-relaxed">{tip}</TooltipContent>
    </Tooltip>
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
