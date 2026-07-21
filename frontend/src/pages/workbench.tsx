// Candidate-review workbench — CDEMapper (JAMIA 2025 Fig 4) idiom adapted to the split-aware model.
// Two panes: (left) concept-group list; (right) ranked CDE candidates + value/transform mapping + the
// approve/refine/reject decision for the selected group. Renders the ranked candidates the pipeline saw
// (contract `candidates`) — read-only alternatives with the chosen one flagged — since our backend records
// one decision per group rather than a free re-pick. Deferred (future): ⌘K palette, batch mode, resizable.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Ban, Check, ExternalLink, Loader2, Pencil, Plus, RefreshCw, Save, Sparkles, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlotInfo } from "@/components/plot-info";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { SourceRows } from "@/components/source-rows";
import { regenerateSpecs, submitVerdict } from "@/lib/api";
import {
  VERDICT_STYLES,
  conceptLabel,
  permissibleValueLabels,
  sourceValueLabels,
  type FieldDetail,
  type GenCDE,
  type ResponseOption,
  type UIRecord,
  type UITransform,
} from "@/types";

const NIH_CDE_URL = "https://cde.nlm.nih.gov/deView?tinyId=";
const VERDICT_BAR: Record<string, string> = {
  adopt: "bg-success",
  refine: "bg-warning",
  novel: "bg-ph-navy",
  unclassified: "bg-neutral-400",
};

// User-verdict → {icon, color}. Single source of truth for the concept-list sidebar badge AND the
// approve/refine/reject decision buttons (same icons/colors) so they can't drift. Keyed by the values
// decide() stores in `decisions`: approve | refine | reject.
const VERDICT_ICON: Record<string, { Icon: typeof Check; color: string }> = {
  approve: { Icon: Check, color: "text-success" },
  refine: { Icon: Pencil, color: "text-warning" },
  reject: { Icon: Ban, color: "text-danger" },
};

/** The sidebar "reviewed" badge: shows the reviewer's ACTUAL verdict icon (approve=✓/refine=✎/reject=⦸),
 *  not a blanket green check. Renders nothing when undecided (TBD). */
function VerdictBadge({ verdict }: { verdict?: string }) {
  const v = verdict ? VERDICT_ICON[verdict] : undefined;
  if (!v) return null;
  const { Icon, color } = v;
  return <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} />;
}

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

// A GenCDE's value domain as a stable string — the categorical permissible values plus the numeric units /
// bounds. Used to tell whether a refine touched the part of the proposal that the member→GenCDE recodes
// depend on (text-only edits to definition/title/question don't make recodes stale).
function valueDomainKey(g: Pick<GenCDE, "permissibleValues" | "units" | "minimum" | "maximum">): string {
  const pv = g.permissibleValues.map((o) => `${o.code}=${o.label}`).join("|");
  return `${pv}§${g.units ?? ""}§${g.minimum ?? ""}§${g.maximum ?? ""}`;
}

const CODE_MAP_CAP = 10;

// One `code (label)` cell: the code reads primary (mono), the label secondary (muted sans). Label omitted
// when the source/target carries no coded meaning for that code (numeric/open field, or an assigned CDE
// whose permissible values aren't in the payload) — the bare code shows, per graceful-degradation.
function CodeLabel({ code, label, codeClass }: { code: string; label?: string; codeClass: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <span className={`font-mono ${codeClass}`}>{code}</span>
      {label ? <span className="truncate text-neutral-400">({label})</span> : null}
    </span>
  );
}

// The actual recode content for one transform, rendered inline under its summary row so a reviewer can see
// EXACTLY what the spec does without exporting: categorical code→code pairs (capped) WITH their value
// labels, the unit factor/offset + units, the arithmetic formula + inputs, or the data-dependent method.
// `srcLabels`/`tgtLabels` are code→label maps for the source field and target CDE; empty maps degrade to
// bare codes. Returns null for identity/none.
function TransformDetail({
  t,
  srcLabels,
  tgtLabels,
}: {
  t: UITransform;
  srcLabels: Record<string, string>;
  tgtLabels: Record<string, string>;
}) {
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
              <div
                key={src}
                className="flex items-center gap-1.5 text-[11px]"
                title={`${src}${srcLabels[src] ? ` = ${srcLabels[src]}` : ""}  →  ${tgt}${tgtLabels[tgt] ? ` = ${tgtLabels[tgt]}` : ""}`}
              >
                <CodeLabel code={src} label={srcLabels[src]} codeClass="text-neutral-500" />
                <span className="shrink-0 text-neutral-300">→</span>
                <CodeLabel code={tgt} label={tgtLabels[tgt]} codeClass="text-neutral-700" />
              </div>
            ))}
          </div>
        )}
        {moreCodes > 0 && <div className="text-[11px] text-neutral-400">+{moreCodes} more mapped</div>}
        {unmapped.length > 0 && (
          <div className="text-[11px] text-warning">
            <span className="font-medium">unmapped:</span>{" "}
            {unmapped.slice(0, CODE_MAP_CAP).map((code, i) => (
              <span key={code}>
                {i > 0 ? ", " : ""}
                <span className="font-mono">{code}</span>
                {srcLabels[code] ? <span className="text-warning/80"> ({srcLabels[code]})</span> : null}
              </span>
            ))}
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
  return (
    <WorkbenchBody
      jobId={jobId}
      records={jobState.result?.records ?? []}
      fieldIndex={jobState.result?.fieldIndex ?? {}}
    />
  );
}

export function WorkbenchBody({
  jobId,
  records,
  fieldIndex = {},
}: {
  jobId: string;
  records: UIRecord[];
  fieldIndex?: Record<string, FieldDetail>;
}) {
  // Deep link from the embedding atlas: /job/:id/workbench?c=<recordId> preselects that concept.
  const queryString = useSearch();
  const linkedId = new URLSearchParams(queryString).get("c");
  const [selectedId, setSelectedId] = useState<string | null>(linkedId);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  // Second, independent verdict axis: approve/refine/reject each var→CDE transform spec, PER source variable
  // (keyed `${recordId}:${sourceVariable}`) — distinct from the concept→CDE match verdict above.
  const [transformDecisions, setTransformDecisions] = useState<Record<string, string>>({});
  // Third axis: approve/refine/reject the synthesized GenCDE itself (novel route), keyed by recordId.
  const [gencdeDecisions, setGencdeDecisions] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("all");
  // Second, independent filter: the reviewer's OWN decision (the `decisions` map) — distinct from the pipeline
  // verdict above. "tbd" = no entry in `decisions` (undecided). Values mirror decide(): approve|refine|reject.
  const [userFilter, setUserFilter] = useState("all");
  const [search, setSearch] = useState("");
  // Refine → regen (Part 3): recordIds whose GenCDE-target recodes went stale because a refine changed the
  // GenCDE's value domain, and the freshly regenerated transforms once "Regenerate recodes" completes (an
  // override layered over the record's `transforms`, since records arrive as a prop from the stream hook).
  const [staleRecords, setStaleRecords] = useState<Record<string, boolean>>({});
  const [regenTransforms, setRegenTransforms] = useState<Record<string, UITransform[]>>({});
  // BYOK dialog for the regen LLM pass — the key is held in component memory only, never persisted.
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenKey, setRegenKey] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenErr, setRegenErr] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter(
      (r) =>
        (filter === "all" || r.verdict === filter) &&
        // "all" = any; "reviewed" = has ANY decision (approve/refine/reject); else = that exact verdict;
        // "tbd" = undecided (no entry in `decisions`).
        (userFilter === "all" ||
          (userFilter === "reviewed"
            ? (decisions[r.id] ?? "tbd") !== "tbd"
            : (decisions[r.id] ?? "tbd") === userFilter)) &&
        (!q || conceptLabel(r).toLowerCase().includes(q)),
    );
  }, [records, filter, userFilter, decisions, search]);

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

  // Transforms to render for the selected record: the freshly regenerated set once a regen has run, else the
  // record's own. `gencdeId` flags which recodes target the proposed GenCDE; `gencdeStale` = a value-domain
  // refine left those recodes stale (awaiting regeneration).
  const gencdeId = selected?.gencde?.gencdeId ?? null;
  const shownTransforms = selected ? (regenTransforms[selected.id] ?? selected.transforms) : [];
  const gencdeStale = selected ? !!staleRecords[selected.id] : false;

  async function decide(r: UIRecord, decision: "approve" | "refine" | "reject") {
    const cleared = decisions[r.id] === decision; // re-clicking the active verdict toggles it off
    setDecisions((p) => {
      if (!cleared) return { ...p, [r.id]: decision };
      const rest = { ...p };
      delete rest[r.id];
      return rest;
    });
    try {
      await submitVerdict(jobId, r.id, cleared ? "clear" : decision, notes[r.id] ?? "");
      toast.success(cleared ? `Cleared verdict for "${conceptLabel(r)}"` : `Marked "${conceptLabel(r)}" ${decision}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save decision");
    }
  }

  // Transform-axis verdict — approve/refine/reject ONE source variable's recode spec, keyed by
  // `${recordId}:${sourceVariable}`, distinct from the concept→CDE match verdict.
  async function decideTransform(r: UIRecord, t: UITransform, decision: "approve" | "refine" | "reject") {
    const key = `${r.id}:${t.sourceVariable}`;
    const cleared = transformDecisions[key] === decision; // re-clicking the active verdict toggles it off
    setTransformDecisions((p) => {
      if (!cleared) return { ...p, [key]: decision };
      const rest = { ...p };
      delete rest[key];
      return rest;
    });
    try {
      await submitVerdict(jobId, r.id, cleared ? "clear" : decision, notes[r.id] ?? "", "transform", t.sourceVariable);
      toast.success(cleared ? `Cleared transform verdict for "${t.sourceVariable}"` : `Transform for "${t.sourceVariable}" ${decision}d`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save transform decision");
    }
  }

  // GenCDE-axis verdict — approve/refine/reject the synthesized GenCDE (the novel route's proposed target),
  // keyed by recordId, distinct from the concept→CDE match verdict and the per-variable transform verdicts.
  // A refine can carry the reviewer's corrected GenCDE (`edited`); when that correction changes the value
  // domain, the record's member→GenCDE recodes go stale (Part 3). Re-clicking the active verdict (with no
  // edit) toggles it off — persisted as a "clear".
  async function decideGencde(r: UIRecord, decision: "approve" | "refine" | "reject", edited?: GenCDE) {
    const cleared = !edited && gencdeDecisions[r.id] === decision; // re-clicking the active verdict toggles it off (never on an edit)
    setGencdeDecisions((p) => {
      if (!cleared) return { ...p, [r.id]: decision };
      const rest = { ...p };
      delete rest[r.id];
      return rest;
    });
    if (decision === "refine" && edited && r.gencde && valueDomainKey(r.gencde) !== valueDomainKey(edited)) {
      // The value domain moved — the previously generated member→GenCDE recodes no longer target it.
      setStaleRecords((p) => ({ ...p, [r.id]: true }));
    }
    try {
      await submitVerdict(jobId, r.id, cleared ? "clear" : decision, notes[r.id] ?? "", "gencde", undefined, edited);
      toast.success(
        cleared
          ? `Cleared GenCDE verdict for "${conceptLabel(r)}"`
          : edited
            ? `Saved GenCDE edits for "${conceptLabel(r)}"`
            : `Proposed GenCDE for "${conceptLabel(r)}" ${decision}d`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save GenCDE decision");
    }
  }

  // Refine → regen (Part 3): re-run the member→GenCDE recodes for the selected record against its corrected
  // value domain. One targeted, BYOK LLM pass; the fresh transforms overlay the record and the stale flag clears.
  async function regenerate(r: UIRecord, key: string) {
    setRegenBusy(true);
    setRegenErr(null);
    try {
      const { record } = await regenerateSpecs(jobId, r.id, key || undefined);
      setRegenTransforms((p) => ({ ...p, [r.id]: record.transforms }));
      setStaleRecords((p) => ({ ...p, [r.id]: false }));
      setRegenOpen(false);
      setRegenKey("");
      toast.success(`Regenerated ${record.transforms.length} recode(s) for "${conceptLabel(r)}"`);
    } catch (e) {
      setRegenErr(e instanceof Error ? e.message : "Failed to regenerate recodes");
    } finally {
      setRegenBusy(false);
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
            {/* Two independent filters. Verdict = the PIPELINE's call (adopt/refine/novel). Review status =
                the REVIEWER's own decision (the `decisions` map). Both have a "refine" — labels disambiguate. */}
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-neutral-400">Verdict · pipeline</span>
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
            </div>
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-neutral-400">Review status · yours</span>
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All review statuses</SelectItem>
                  {/* "All reviewed" = anything I've decided; Approved/Refine/Rejected are its sub-options
                      (indented — the check indicator sits on the right, so left-pad is free). */}
                  <SelectItem value="reviewed">All reviewed</SelectItem>
                  <SelectItem value="approve" className="pl-6">Approved</SelectItem>
                  <SelectItem value="refine" className="pl-6">Refine</SelectItem>
                  <SelectItem value="reject" className="pl-6">Rejected</SelectItem>
                  <SelectItem value="tbd">TBD · undecided</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
                  <span className="truncate text-sm font-medium text-neutral-700">{conceptLabel(g)}</span>
                  <VerdictBadge verdict={decisions[g.id]} />
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
                    {conceptLabel(selected)}
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
                  {selected.gencde && (
                    <GenCDECard
                      g={selected.gencde}
                      decision={gencdeDecisions[selected.id]}
                      onDecide={(d, edited) => decideGencde(selected, d, edited)}
                    />
                  )}
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
              </CardContent>
            </Card>

            {/* raw source-dictionary rows — the ground-truth metadata behind every derived claim above */}
            <Card>
              <CardHeader className="space-y-1">
                <div className="flex flex-row items-center gap-2">
                  <CardTitle className="text-base">Source dictionary rows ({selected.nMembers})</CardTitle>
                  <PlotInfo>
                    The raw metadata rows you uploaded for each variable this concept pooled — one row per
                    variable, columns are the fields as ingested (description, question, value encoding, units,
                    type). This is the ground truth behind the summary, CDE match, and value mapping on this page:
                    use it to confirm the derived claims, or to spot a bad group (e.g. distinct measurements
                    mistakenly merged). Empty columns are hidden.
                  </PlotInfo>
                </div>
              </CardHeader>
              <CardContent>
                <SourceRows record={selected} fieldIndex={fieldIndex} />
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
                  <div className="max-h-[24rem] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-neutral-0">
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
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-400">
                    No candidates retained (novel / GenCDE route).
                  </p>
                )}
              </CardContent>
            </Card>

            {/* value / transform mapping */}
            <Card>
              <CardHeader className="space-y-2">
                <div className="flex flex-row items-center gap-2">
                  <CardTitle className="text-base">Value mapping ({shownTransforms.length})</CardTitle>
                  <PlotInfo>
                    One row per source variable → target recode recipe, showing the actual recode inline: the
                    categorical <b>code map</b> (source code → target code), the <b>unit</b> conversion (factor/offset
                    + units), the <b>arithmetic</b> formula, or the data-dependent <b>method</b>. The mono badge is the
                    transform <b>kind</b>; <b>coverage</b> is the share of the source&apos;s values the recipe maps.
                    A <b>→ Proposed GenCDE</b> pill marks a recode whose target is this concept&apos;s synthesized
                    GenCDE (novel route) rather than an existing CDE. Each row carries its OWN{" "}
                    <b>approve / refine / reject</b> verdict — a per-variable second axis, separate from the
                    concept→CDE match verdict at the top of the page. The <b>review</b> / <b>units</b> / <b>data</b>{" "}
                    chips are diagnostic flags, not buttons — respectively: flagged for a human check, source/target
                    units couldn&apos;t be reconciled, and needs row-level data to apply. Specs are exported from the
                    run&apos;s <b>Export</b> menu (EITL TSV, records JSON, or a runnable notebook).
                  </PlotInfo>
                  {gencdeStale && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7 gap-1.5 border-warning/40 text-xs text-warning hover:bg-warning-bg"
                      onClick={() => {
                        setRegenErr(null);
                        setRegenOpen(true);
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Regenerate recodes
                    </Button>
                  )}
                </div>
                {gencdeId && (
                  <p className="text-xs text-neutral-500">
                    These recodes map each source variable&apos;s values <b>into the proposed GenCDE&apos;s domain</b>{" "}
                    (this concept is novel — the target is the synthesized GenCDE above, not an existing CDE).
                  </p>
                )}
                {gencdeStale && (
                  <p className="flex items-center gap-1.5 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> The GenCDE&apos;s value domain was refined —
                    the recodes below are stale. Regenerate them to remap against the corrected domain.
                  </p>
                )}
              </CardHeader>
              <CardContent>
                {shownTransforms.length ? (
                  <div className="space-y-2">
                    {shownTransforms.map((t, i) => {
                      const tKey = `${selected.id}:${t.sourceVariable}`;
                      const td = transformDecisions[tKey];
                      const toGenCDE = !!gencdeId && t.targetCdeId === gencdeId;
                      // Source labels from the loaded dictionary's value encoding (keyed "cohort:var" in the
                      // field index); target labels from the novel concept's GenCDE permissible values (an
                      // assigned real CDE doesn't carry them → bare target code shows).
                      const srcLabels = sourceValueLabels(fieldIndex[t.sourceVariable]);
                      const tgtLabels = permissibleValueLabels(selected.gencde?.permissibleValues);
                      return (
                        <div key={i} className="rounded border border-neutral-100 px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary" className="font-mono">
                              {t.kind}
                            </Badge>
                            <span className="font-mono text-neutral-600">{t.sourceVariable}</span>
                            <span className="text-neutral-300">→</span>
                            <span className="text-neutral-600">{transformSummary(t)}</span>
                            {toGenCDE && (
                              <Badge variant="outline" className="gap-1 border-ph-navy/30 text-ph-navy">
                                <Sparkles className="h-3 w-3" /> → Proposed GenCDE
                              </Badge>
                            )}
                            {toGenCDE && gencdeStale && (
                              <Badge variant="outline" className="gap-1 border-warning/40 text-warning">
                                <AlertTriangle className="h-3 w-3" /> stale — regenerate
                              </Badge>
                            )}
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
                          <TransformDetail t={t} srcLabels={srcLabels} tgtLabels={tgtLabels} />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-neutral-400">No transform specs for this concept.</p>
                )}
              </CardContent>
            </Card>

            {/* Regenerate-recodes BYOK dialog (Part 3): one targeted LLM pass re-maps the member→GenCDE recodes
                against the corrected value domain. Key is transport-only, never persisted. */}
            <Dialog open={regenOpen} onOpenChange={setRegenOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Regenerate recodes</DialogTitle>
                  <DialogDescription>
                    The proposed GenCDE&apos;s value domain changed, so this re-maps each source variable&apos;s values
                    into the corrected domain — one LLM pass, so it needs your Anthropic API key. The key is sent for
                    this request only — never written to disk, logs, or the saved run.
                  </DialogDescription>
                </DialogHeader>
                <Input
                  type="password"
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  value={regenKey}
                  onChange={(e) => setRegenKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && regenKey.trim() && selected) regenerate(selected, regenKey.trim());
                  }}
                />
                {regenErr && <p className="text-sm text-destructive">{regenErr}</p>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setRegenOpen(false)} disabled={regenBusy}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => selected && regenerate(selected, regenKey.trim())}
                    disabled={regenBusy || !regenKey.trim()}
                  >
                    {regenBusy ? "Regenerating…" : "Regenerate"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
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

// The synthesized GenCDE proposed for a novel concept (contract `UIRecord.gencde`) — the spec-conformant
// harmonization target, distinct from the free-text "Concept summary" (idealCde). Shown only on novels.
// Clicking "refine" opens an editable draft over the synthesized fields so the reviewer can CORRECT the
// proposal (name/definition/question, permissible values, units/bounds); "Save changes" persists the edited
// GenCDE alongside the verdict. A save that moves the value domain marks the recodes stale (see the parent).
function GenCDECard({
  g,
  decision,
  onDecide,
}: {
  g: GenCDE;
  decision?: string;
  onDecide: (d: "approve" | "refine" | "reject", edited?: GenCDE) => void;
}) {
  // Editable draft, seeded from the synthesized proposal and reset when a different GenCDE is selected.
  const [draft, setDraft] = useState<GenCDE>(g);
  useEffect(() => {
    setDraft(g);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on concept switch, not on every g ref
  }, [g.gencdeId]);
  const editing = decision === "refine";
  const hasRange = g.minimum != null || g.maximum != null;

  const setPV = (i: number, patch: Partial<ResponseOption>) =>
    setDraft((d) => ({ ...d, permissibleValues: d.permissibleValues.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const addPV = () => setDraft((d) => ({ ...d, permissibleValues: [...d.permissibleValues, { code: "", label: "" }] }));
  const removePV = (i: number) =>
    setDraft((d) => ({ ...d, permissibleValues: d.permissibleValues.filter((_, j) => j !== i) }));
  const numOrUndef = (s: string) => (s.trim() === "" ? undefined : Number(s));

  function save() {
    // Drop blank permissible-value rows before persisting so an empty editor row isn't stored as a code.
    const cleaned: GenCDE = {
      ...draft,
      permissibleValues: draft.permissibleValues.filter((o) => o.code.trim() !== "" || o.label.trim() !== ""),
    };
    onDecide("refine", cleaned);
  }

  return (
    <div className="mt-1 space-y-2 rounded-md border border-ph-navy/20 bg-ph-navy/5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ph-navy">
          <Sparkles className="h-3.5 w-3.5" /> Proposed GenCDE
        </span>
        <span className="flex items-center gap-1">
          {g.dataType && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {g.dataType}
            </Badge>
          )}
          {g.needsReview && (
            <Badge variant="outline" className="border-warning/40 text-warning">
              needs review
            </Badge>
          )}
        </span>
      </div>
      {/* GenCDE-axis verdict: approve/refine/reject the proposed target itself (distinct from the concept→CDE
          match verdict and the per-variable transform verdicts). "refine" opens the edit form below. */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-neutral-500">Review proposal:</span>
        <DecisionBtn active={decision === "approve"} onClick={() => onDecide("approve")} title="Approve GenCDE" color="text-success">
          <Check className="h-4 w-4" />
        </DecisionBtn>
        <DecisionBtn active={decision === "refine"} onClick={() => onDecide("refine")} title="Refine GenCDE" color="text-warning">
          <Pencil className="h-4 w-4" />
        </DecisionBtn>
        <DecisionBtn active={decision === "reject"} onClick={() => onDecide("reject")} title="Reject GenCDE" color="text-danger">
          <Ban className="h-4 w-4" />
        </DecisionBtn>
      </div>

      {editing ? (
        // ── editable refine form ─────────────────────────────────────────────────────────────
        <div className="space-y-2.5 rounded border border-warning/30 bg-warning-bg/30 p-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <EditField label="Preferred name">
              <Input
                className="h-8"
                value={draft.preferredName}
                onChange={(e) => setDraft((d) => ({ ...d, preferredName: e.target.value }))}
              />
            </EditField>
            <EditField label="Title">
              <Input className="h-8" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
            </EditField>
          </div>
          <EditField label="Definition">
            <Textarea
              className="min-h-[60px]"
              value={draft.definition}
              onChange={(e) => setDraft((d) => ({ ...d, definition: e.target.value }))}
            />
          </EditField>
          <EditField label="Question text">
            <Input
              className="h-8"
              value={draft.questionText}
              onChange={(e) => setDraft((d) => ({ ...d, questionText: e.target.value }))}
            />
          </EditField>
          <div className="grid gap-2 sm:grid-cols-3">
            <EditField label="Units">
              <Input
                className="h-8"
                value={draft.units ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, units: e.target.value || undefined }))}
              />
            </EditField>
            <EditField label="Minimum">
              <Input
                className="h-8"
                type="number"
                value={draft.minimum ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, minimum: numOrUndef(e.target.value) }))}
              />
            </EditField>
            <EditField label="Maximum">
              <Input
                className="h-8"
                type="number"
                value={draft.maximum ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, maximum: numOrUndef(e.target.value) }))}
              />
            </EditField>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] uppercase tracking-wide text-neutral-500">Permissible values (code = label)</Label>
              <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 text-xs" onClick={addPV}>
                <Plus className="h-3 w-3" /> Add value
              </Button>
            </div>
            {draft.permissibleValues.length === 0 && (
              <p className="text-[11px] text-neutral-400">No permissible values (numeric / open-text GenCDE).</p>
            )}
            {draft.permissibleValues.map((o, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="h-7 w-24 font-mono text-[11px]"
                  placeholder="code"
                  value={o.code}
                  onChange={(e) => setPV(i, { code: e.target.value })}
                />
                <span className="text-neutral-300">=</span>
                <Input
                  className="h-7 flex-1 text-[11px]"
                  placeholder="label"
                  value={o.label}
                  onChange={(e) => setPV(i, { label: e.target.value })}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-neutral-400 hover:text-danger"
                  title="Remove value"
                  onClick={() => removePV(i)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDraft(g)}>
              Reset
            </Button>
            <Button type="button" size="sm" className="h-7 gap-1.5 text-xs" onClick={save}>
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      ) : (
        // ── read-only display ────────────────────────────────────────────────────────────────
        <>
          <div className="text-sm">
            <span className="font-mono font-medium text-ph-ink">{g.preferredName || "—"}</span>
            {g.title && <span className="text-neutral-500"> · {g.title}</span>}
          </div>
          {g.definition && <p className="text-sm text-neutral-600">{g.definition}</p>}
          {g.permissibleValues.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {g.permissibleValues.map((o) => (
                <span
                  key={`${o.code}=${o.label}`}
                  className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
                >
                  {o.code}={o.label}
                </span>
              ))}
            </div>
          )}
          {(g.units || hasRange) && (
            <div className="text-xs text-neutral-500">
              {g.units && (
                <>
                  units <span className="font-mono">{g.units}</span>
                </>
              )}
              {g.units && hasRange && " · "}
              {hasRange && (
                <>
                  range{" "}
                  <span className="font-mono">
                    {g.minimum ?? "−∞"}…{g.maximum ?? "∞"}
                  </span>
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
            <span>
              coverage{" "}
              <span className="font-medium tabular-nums">
                {g.valueCoverage == null ? "n/a" : `${Math.round(g.valueCoverage * 100)}%`}
              </span>
            </span>
            {g.confidence > 0 && (
              <span>
                confidence <span className="font-medium tabular-nums">{g.confidence.toFixed(2)}</span>
              </span>
            )}
            {g.sourceCohorts.length > 0 && <span>from {g.sourceCohorts.join(", ")}</span>}
          </div>
          {g.uncoveredLabels.length > 0 && (
            <div className="text-[11px] text-warning">missing answer concepts: {g.uncoveredLabels.join(", ")}</div>
          )}
        </>
      )}
    </div>
  );
}

// Small labeled wrapper for one edit field in the GenCDE refine form.
function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</Label>
      {children}
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
