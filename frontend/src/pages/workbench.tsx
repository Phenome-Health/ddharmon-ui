// Candidate-review workbench — CDEMapper (JAMIA 2025 Fig 4) idiom adapted to the split-aware model.
// Two panes: (left) concept-group list; (right) ranked CDE candidates + value/transform mapping + the
// approve/refine/reject decision for the selected group. Renders the ranked candidates the pipeline saw
// (contract `candidates`) — read-only alternatives with the chosen one flagged — since our backend records
// one decision per group rather than a free re-pick. Deferred (future): ⌘K palette, batch mode, resizable.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { toast } from "sonner";
import { ArrowLeft, Ban, Check, ExternalLink, Loader2, Pencil, Sparkles, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlotInfo } from "@/components/plot-info";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { MemberVariables } from "@/components/member-variables";
import { submitVerdict } from "@/lib/api";
import { VERDICT_STYLES, type UIRecord, type UITransform } from "@/types";

const NIH_CDE_URL = "https://cde.nlm.nih.gov/deView?tinyId=";
const VERDICT_BAR: Record<string, string> = {
  adopt: "bg-success",
  refine: "bg-warning",
  novel: "bg-ph-navy",
  unclassified: "bg-neutral-400",
};

function cos(x: number | null | undefined): string {
  return x == null ? "—" : x.toFixed(3);
}

function MiniBar({ value, verdict }: { value: number; verdict: string }) {
  return (
    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200">
      <div
        className={`h-full rounded-full ${VERDICT_BAR[verdict] ?? "bg-neutral-400"}`}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  );
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

const CODE_MAP_CAP = 10;

// The actual recode content for one transform, rendered inline under its summary row so a reviewer can see
// EXACTLY what the spec does without exporting: categorical code→code pairs (capped), the unit factor/offset
// + units, the arithmetic formula + inputs, or the data-dependent method. Returns null for identity/none.
function TransformDetail({ t }: { t: UITransform }) {
  if (t.kind === "categorical") {
    const entries = Object.entries(t.codeMap ?? {});
    if (!entries.length && !t.unmappedSourceCodes?.length) return null;
    const shown = entries.slice(0, CODE_MAP_CAP);
    const moreCodes = entries.length - shown.length;
    const unmapped = t.unmappedSourceCodes ?? [];
    return (
      <div className="mt-2 space-y-1 border-t border-neutral-100 pt-2 pl-1">
        {shown.length > 0 && (
          <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {shown.map(([src, tgt]) => (
              <div key={src} className="flex items-center gap-1.5 font-mono text-[11px]">
                <span className="truncate text-neutral-500">{src}</span>
                <span className="text-neutral-300">→</span>
                <span className="truncate text-neutral-700">{tgt}</span>
              </div>
            ))}
          </div>
        )}
        {moreCodes > 0 && <div className="text-[11px] text-neutral-400">+{moreCodes} more mapped</div>}
        {unmapped.length > 0 && (
          <div className="text-[11px] text-warning">
            unmapped: <span className="font-mono">{unmapped.slice(0, CODE_MAP_CAP).join(", ")}</span>
            {unmapped.length > CODE_MAP_CAP ? ` +${unmapped.length - CODE_MAP_CAP} more` : ""}
          </div>
        )}
      </div>
    );
  }
  if (t.kind === "unit") {
    return (
      <div className="mt-2 border-t border-neutral-100 pt-2 pl-1 font-mono text-[11px] text-neutral-600">
        target = source × {t.factor ?? "?"}
        {t.offset ? ` + ${t.offset}` : ""}
        <span className="ml-2 font-sans text-neutral-400">
          ({t.sourceUnit ?? "?"} → {t.targetUnit ?? "?"})
        </span>
      </div>
    );
  }
  if (t.kind === "arithmetic") {
    return (
      <div className="mt-2 border-t border-neutral-100 pt-2 pl-1 font-mono text-[11px] text-neutral-600">
        {t.formula ?? "—"}
        {t.inputs?.length ? <span className="ml-2 font-sans text-neutral-400">inputs: {t.inputs.join(", ")}</span> : null}
      </div>
    );
  }
  if (t.kind === "data_dependent") {
    return (
      <div className="mt-2 border-t border-neutral-100 pt-2 pl-1 text-[11px] text-neutral-500">
        method <span className="font-mono text-neutral-600">{t.method ?? "data-dependent"}</span> — needs row-level
        data at apply-time
      </div>
    );
  }
  return null;
}

export default function WorkbenchPage() {
  const { jobId = "" } = useParams();
  // The workbench is a deep review surface — always load the finished result immediately.
  // instant=true skips the demo replay animation (the landing dashboard is where that flourish
  // belongs; here a mid-replay stream would populate the queue in real time, which reads as a bug).
  const { jobState } = useHarmonizeStream(jobId, true, true);
  if (!jobState) {
    return (
      <div className="flex items-center gap-2 p-8 text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
      </div>
    );
  }
  return <WorkbenchBody jobId={jobId} records={jobState.result?.records ?? []} />;
}

export function WorkbenchBody({ jobId, records }: { jobId: string; records: UIRecord[] }) {
  // Deep link from the embedding atlas: /job/:id/workbench?c=<recordId> preselects that concept.
  const queryString = useSearch();
  const linkedId = new URLSearchParams(queryString).get("c");
  const [selectedId, setSelectedId] = useState<string | null>(linkedId);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  // Second, independent verdict axis: approve/refine/reject each var→CDE transform spec, PER source variable
  // (keyed `${recordId}:${sourceVariable}`) — distinct from the concept→CDE match verdict above.
  const [transformDecisions, setTransformDecisions] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter(
      (r) => (filter === "all" || r.verdict === filter) && (!q || r.concept.toLowerCase().includes(q)),
    );
  }, [records, filter, search]);

  // Default-select the first group once records load / filter changes.
  useEffect(() => {
    if (!groups.length) {
      setSelectedId(null);
    } else if (!selectedId || !groups.some((g) => g.id === selectedId)) {
      setSelectedId(groups[0].id);
    }
  }, [groups, selectedId]);

  const selected = useMemo(() => records.find((r) => r.id === selectedId) ?? null, [records, selectedId]);

  // The assign LLM returns a RANKING (best-first) + a chosen candidate + a one-sentence rationale — so the
  // pick can differ from the highest-cosine candidate (it ranks concept fit over embedding similarity).
  // Surface that: find the chosen vs the highest-cosine candidate and whether the model overrode cosine.
  const candInfo = useMemo(() => {
    const cands = selected?.candidates ?? [];
    const chosen = cands.find((c) => c.isChosen) ?? null;
    const best = cands.length ? cands.reduce((a, b) => (b.cosine > a.cosine ? b : a)) : null;
    return {
      chosen,
      bestRank: best?.rank ?? null,
      bestCos: best?.cosine ?? null,
      reranked: !!(chosen && best && chosen.cosine < best.cosine - 1e-6),
    };
  }, [selected]);

  // The LLM's `ranking` array and its chosen `cde_id` are separate outputs that can disagree, so the chosen
  // candidate isn't always ranking[0]. Present the chosen first (it IS the decision), then the rest in the
  // model's ranking order, and renumber the shown # to display order — so the ★ always reads as #1.
  const orderedCandidates = useMemo(
    () => [...(selected?.candidates ?? [])].sort((a, b) => (b.isChosen ? 1 : 0) - (a.isChosen ? 1 : 0) || a.rank - b.rank),
    [selected],
  );

  async function decide(r: UIRecord, decision: "approve" | "refine" | "reject") {
    setDecisions((p) => ({ ...p, [r.id]: decision }));
    try {
      await submitVerdict(jobId, r.id, decision, notes[r.id] ?? "");
      toast.success(`Marked "${r.concept || r.id}" ${decision}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save decision");
    }
  }

  // Transform-axis verdict — approve/refine/reject ONE source variable's recode spec, keyed by
  // `${recordId}:${sourceVariable}`, distinct from the concept→CDE match verdict.
  async function decideTransform(r: UIRecord, t: UITransform, decision: "approve" | "refine" | "reject") {
    const key = `${r.id}:${t.sourceVariable}`;
    setTransformDecisions((p) => ({ ...p, [key]: decision }));
    try {
      await submitVerdict(jobId, r.id, decision, notes[r.id] ?? "", "transform", t.sourceVariable);
      toast.success(`Transform for "${t.sourceVariable}" ${decision}d`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save transform decision");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/job/${jobId}`} className="mb-1 flex items-center gap-1 text-xs text-neutral-500 hover:text-ph-navy">
            <ArrowLeft className="h-3 w-3" /> Back to run
          </Link>
          <h1 className="text-2xl font-semibold text-ph-ink">Review workbench</h1>
        </div>
        <div className="text-sm text-neutral-500">{records.length} concepts</div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        {/* ── group list ── */}
        <Card className="flex flex-col overflow-hidden lg:sticky lg:top-4 lg:h-[calc(100vh-9rem)]">
          <CardHeader className="shrink-0 space-y-2">
            <CardTitle className="text-base">Concepts ({groups.length})</CardTitle>
            <Input placeholder="Search concepts…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8" />
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="h-8">
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
          <CardContent className="max-h-[calc(100vh-20rem)] space-y-1 overflow-y-auto p-2 lg:max-h-none lg:flex-1">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => setSelectedId(g.id)}
                className={`w-full rounded px-3 py-2 text-left transition-colors ${
                  g.id === selectedId ? "bg-ph-navy/5 ring-1 ring-ph-navy/25" : "hover:bg-neutral-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-neutral-700">{g.concept || g.id}</span>
                  {decisions[g.id] && <Check className="h-3.5 w-3.5 shrink-0 text-success" />}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <Badge variant="outline" className={`${VERDICT_STYLES[g.verdict] ?? ""} px-1.5 py-0`}>
                    {g.verdict}
                  </Badge>
                  <span className="text-xs text-neutral-400">
                    {g.nMembers} · {g.cohorts.join(", ")}
                  </span>
                </div>
              </button>
            ))}
            {!groups.length && <p className="py-8 text-center text-sm text-neutral-400">No concepts match.</p>}
          </CardContent>
        </Card>

        {/* ── detail: decision + candidates + transforms ── */}
        {selected ? (
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {selected.concept || selected.id}
                    <Badge variant="outline" className={VERDICT_STYLES[selected.verdict] ?? ""}>
                      {selected.verdict}
                    </Badge>
                  </CardTitle>
                  <p className="mt-1 text-xs text-neutral-500">
                    {selected.nMembers} variables · {selected.cohorts.join(", ")} · route {selected.route}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <DecisionBtn active={decisions[selected.id] === "approve"} onClick={() => decide(selected, "approve")} title="Approve" color="text-success">
                    <Check className="h-4 w-4" />
                  </DecisionBtn>
                  <DecisionBtn active={decisions[selected.id] === "refine"} onClick={() => decide(selected, "refine")} title="Refine" color="text-warning">
                    <Pencil className="h-4 w-4" />
                  </DecisionBtn>
                  <DecisionBtn active={decisions[selected.id] === "reject"} onClick={() => decide(selected, "reject")} title="Reject" color="text-danger">
                    <Ban className="h-4 w-4" />
                  </DecisionBtn>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="Reviewer note…"
                  value={notes[selected.id] ?? ""}
                  onChange={(e) => setNotes((p) => ({ ...p, [selected.id]: e.target.value }))}
                  className="h-8 max-w-md"
                />
                <div className="grid gap-1 text-sm">
                  <Field label="Concept summary">{selected.idealCde || "—"}</Field>
                  {selected.rationale && (
                    <div className="mt-1 space-y-1">
                      <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                        Why this CDE — model rationale
                      </div>
                      <blockquote className="border-l-2 border-neutral-300 pl-3 italic text-neutral-600">
                        {selected.rationale}
                      </blockquote>
                    </div>
                  )}
                  {candInfo.reranked && candInfo.chosen && candInfo.bestCos != null && (
                    <div className="flex items-start gap-2 rounded-md border border-ph-navy/20 bg-ph-navy/5 px-3 py-2 text-xs text-neutral-600">
                      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ph-navy" />
                      <span>
                        The model chose a candidate at cos{" "}
                        <span className="font-medium tabular-nums">{cos(candInfo.chosen.cosine)}</span> over a
                        higher-cosine one at <span className="font-medium tabular-nums">{cos(candInfo.bestCos)}</span> —
                        it ranks concept fit above raw embedding similarity (see the rationale above).
                      </span>
                    </div>
                  )}
                </div>
                <MemberVariables record={selected} />
              </CardContent>
            </Card>

            {/* ranked candidates */}
            <Card>
              <CardHeader className="space-y-1">
                <CardTitle className="text-base">CDE candidates ({selected.candidates.length})</CardTitle>
                <p className="text-xs text-neutral-400">
                  Ordered by the model&apos;s concept-fit ranking. ★ = the model&apos;s pick · cos = embedding
                  similarity (retrieval signal, which can differ from the pick).
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {selected.candidates.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8">#</TableHead>
                        <TableHead>CDE</TableHead>
                        <TableHead>Definition</TableHead>
                        <TableHead className="text-right">cos</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orderedCandidates.map((c, i) => (
                        <TableRow key={c.rank} className={c.isChosen ? "bg-success-bg/40" : undefined}>
                          <TableCell className="tabular-nums text-neutral-500">{i + 1}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-neutral-700">{c.cdeId}</span>
                              {c.isChosen && <Star className="h-3.5 w-3.5 fill-success text-success" />}
                              {c.llmSuggested && <Sparkles className="h-3.5 w-3.5 text-ph-navy" />}
                              {c.rank === candInfo.bestRank && !c.isChosen && (
                                <span className="rounded bg-neutral-100 px-1 py-0.5 text-[10px] font-medium text-neutral-500">
                                  highest cos
                                </span>
                              )}
                            </div>
                            {c.cdeExternalId && <div className="font-mono text-xs text-neutral-400">{c.cdeExternalId}</div>}
                          </TableCell>
                          <TableCell className="max-w-md">
                            <span className="line-clamp-2 text-xs text-neutral-500">{c.definition || "—"}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <MiniBar value={c.cosine} verdict={selected.verdict} />
                              <span className="tabular-nums text-xs text-neutral-600">{cos(c.cosine)}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {c.cdeExternalId && (
                              <a
                                href={`${NIH_CDE_URL}${encodeURIComponent(c.cdeExternalId)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-neutral-400 hover:text-ph-navy"
                                title="Open in NIH CDE Repository"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-400">
                    No candidates retained (novel / GenCDE route).
                  </p>
                )}
              </CardContent>
            </Card>

            {/* value / transform mapping */}
            <Card>
              <CardHeader className="flex flex-row items-center gap-2 space-y-0">
                <CardTitle className="text-base">Value mapping ({selected.transforms.length})</CardTitle>
                <PlotInfo>
                  One row per source variable → CDE transform recipe, showing the actual recode inline: the
                  categorical <b>code map</b> (source code → CDE code), the <b>unit</b> conversion (factor/offset +
                  units), the <b>arithmetic</b> formula, or the data-dependent <b>method</b>. The mono badge is the
                  transform <b>kind</b>; <b>coverage</b> is the share of the source&apos;s values the recipe maps.
                  Each row carries its OWN <b>approve / refine / reject</b> verdict — a per-variable second axis,
                  separate from the concept→CDE match verdict at the top of the page. The <b>review</b> /{" "}
                  <b>units</b> / <b>data</b> chips are diagnostic flags, not buttons — respectively: flagged for a
                  human check, source/target units couldn&apos;t be reconciled, and needs row-level data to apply.
                  Specs are exported from the run&apos;s <b>Export</b> menu (EITL TSV, records JSON, or a runnable
                  notebook).
                </PlotInfo>
              </CardHeader>
              <CardContent>
                {selected.transforms.length ? (
                  <div className="space-y-2">
                    {selected.transforms.map((t, i) => {
                      const tKey = `${selected.id}:${t.sourceVariable}`;
                      const td = transformDecisions[tKey];
                      return (
                        <div key={i} className="rounded border border-neutral-100 px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary" className="font-mono">
                              {t.kind}
                            </Badge>
                            <span className="font-mono text-neutral-600">{t.sourceVariable}</span>
                            <span className="text-neutral-300">→</span>
                            <span className="text-neutral-600">{transformSummary(t)}</span>
                            <span className="text-neutral-400">coverage {(t.coverage * 100).toFixed(0)}%</span>
                            {t.needsReview && <Badge variant="outline" className="border-warning/40 text-warning">review</Badge>}
                            {t.needsUnits && <Badge variant="outline" className="border-warning/40 text-warning">units</Badge>}
                            {t.needsData && <Badge variant="outline" className="border-warning/40 text-warning">data</Badge>}
                            <div className="ml-auto flex items-center gap-0.5">
                              <DecisionBtn active={td === "approve"} onClick={() => decideTransform(selected, t, "approve")} title="Approve transform" color="text-success">
                                <Check className="h-4 w-4" />
                              </DecisionBtn>
                              <DecisionBtn active={td === "refine"} onClick={() => decideTransform(selected, t, "refine")} title="Refine transform" color="text-warning">
                                <Pencil className="h-4 w-4" />
                              </DecisionBtn>
                              <DecisionBtn active={td === "reject"} onClick={() => decideTransform(selected, t, "reject")} title="Reject transform" color="text-danger">
                                <Ban className="h-4 w-4" />
                              </DecisionBtn>
                            </div>
                          </div>
                          <TransformDetail t={t} />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-neutral-400">No transform specs for this concept.</p>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardContent className="py-16 text-center text-sm text-neutral-400">
              {records.length ? "Select a concept to review." : "No records in this run yet."}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</span>
      <span className="text-neutral-700">{children}</span>
    </div>
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
      className={`h-8 w-8 ${active ? color : "text-neutral-400"}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  );
}
