import { useCallback, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Info, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IS_STATIC, startHarmonize } from "@/lib/api";
import {
  ADVANCED_ROLES,
  PRIMARY_ROLES,
  ROLE_FORMAT,
  ROLE_HELP,
  estimateRunCostBreakdown,
  formatUsd,
  type CdeSet,
  type ColumnRole,
  type CostBreakdown,
  type RunMode,
} from "@/types";

const NONE = "__none__";

interface DictFile {
  file: File;
  cohortName: string;
  headers: string[];
  nFields: number;
  roles: Record<string, string>; // role -> column (or unset)
  showAdvanced: boolean;
}

function parseFile(file: File): Promise<{ headers: string[]; nFields: number }> {
  return new Promise((resolve) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => resolve({ headers: (res.meta.fields ?? []).filter(Boolean), nFields: res.data.length }),
      error: () => resolve({ headers: [], nFields: 0 }),
    });
  });
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const [dicts, setDicts] = useState<DictFile[]>([]);
  const [cdeSet, setCdeSet] = useState<CdeSet>("endorsed");
  const [runMode, setRunMode] = useState<RunMode>("batch");
  const [minClusterSize, setMinClusterSize] = useState(15);
  const [genTransformSpecs, setGenTransformSpecs] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onDrop = useCallback(async (accepted: File[]) => {
    const added: DictFile[] = [];
    for (const file of accepted) {
      const { headers, nFields } = await parseFile(file);
      const cohortName = file.name.replace(/\.(csv|tsv|txt)$/i, "");
      // Columns start UNMAPPED — the user decides every role explicitly (no auto-detect prefill).
      added.push({ file, cohortName, headers, nFields, roles: {}, showAdvanced: false });
    }
    setDicts((prev) => [...prev, ...added]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "text/csv": [".csv"], "text/tab-separated-values": [".tsv"], "text/plain": [".txt"] },
  });

  function setRole(idx: number, role: ColumnRole, column: string) {
    setDicts((prev) => prev.map((d, i) => (i === idx ? { ...d, roles: { ...d.roles, [role]: column } } : d)));
  }
  function setCohort(idx: number, name: string) {
    setDicts((prev) => prev.map((d, i) => (i === idx ? { ...d, cohortName: name } : d)));
  }
  function toggleAdvanced(idx: number) {
    setDicts((prev) => prev.map((d, i) => (i === idx ? { ...d, showAdvanced: !d.showAdvanced } : d)));
  }
  function removeDict(idx: number) {
    setDicts((prev) => prev.filter((_, i) => i !== idx));
  }

  const totalFields = useMemo(() => dicts.reduce((s, d) => s + d.nFields, 0), [dicts]);
  const cost = useMemo(
    () => estimateRunCostBreakdown(totalFields, dicts.length, runMode, genTransformSpecs),
    [totalFields, dicts.length, runMode, genTransformSpecs],
  );
  const costMeta = dicts.length
    ? `${totalFields.toLocaleString()} fields · ${dicts.length} cohort${dicts.length > 1 ? "s" : ""} · ${runMode}`
    : "";

  async function run() {
    if (!dicts.length) {
      toast.error("Add at least one data-dictionary file.");
      return;
    }
    for (const d of dicts) {
      const hasKey = ["variable_name", "description", "question_text"].some((r) => d.roles[r] && d.roles[r] !== NONE);
      if (!hasKey) {
        toast.error(`${d.file.name}: map at least variable_name, description, or question_text.`);
        return;
      }
    }
    setSubmitting(true);
    try {
      const config = {
        dictionaries: dicts.map((d) => ({
          filename: d.file.name,
          cohortName: d.cohortName,
          columnRoles: Object.fromEntries(Object.entries(d.roles).filter(([, col]) => col && col !== NONE)),
        })),
        cdeSet,
        runMode,
        minClusterSize,
        genTransformSpecs,
        displayName: displayName || undefined,
      };
      const { jobId } = await startHarmonize(
        dicts.map((d) => d.file),
        config,
      );
      navigate(`/job/${jobId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start run");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ph-ink">New harmonization run</h1>
        <p className="text-sm text-neutral-500">
          Upload cohort data dictionaries, map their columns, and assign each concept to the CDE backbone
          (adopt / refine / novel) with transform specs. New here? See the{" "}
          <Link href="/guide" className="text-ph-navy underline hover:text-ph-ink">
            Guide
          </Link>
          , or try the{" "}
          <Link href="/demo" className="text-ph-navy underline hover:text-ph-ink">
            Demo
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        {/* Left — upload + dictionaries */}
        <div className="space-y-6 lg:col-span-2">
      <div
        {...getRootProps()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed py-12 transition-colors ${
          isDragActive ? "border-ph-navy bg-ph-navy/5" : "border-neutral-300 hover:border-neutral-400"
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="mb-2 h-7 w-7 text-neutral-400" />
        <p className="text-sm font-medium text-neutral-700">Drop CSV/TSV data dictionaries here, or click to browse</p>
        <p className="text-xs text-neutral-400">One file per cohort. The CDE catalog is added automatically server-side.</p>
      </div>

      {dicts.map((d, idx) => (
        <Card key={`${d.file.name}-${idx}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              {d.file.name}
              <Badge variant="secondary">{d.headers.length} cols</Badge>
              <Badge variant="secondary">{d.nFields.toLocaleString()} fields</Badge>
            </CardTitle>
            <Button variant="ghost" size="icon" onClick={() => removeDict(idx)} aria-label="Remove">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid max-w-xs gap-1.5">
              <Label>Cohort name</Label>
              <Input value={d.cohortName} onChange={(e) => setCohort(idx, e.target.value)} />
            </div>

            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">Columns</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {PRIMARY_ROLES.map((role) => (
                  <RoleField key={role} role={role} value={d.roles[role]} headers={d.headers} onChange={(v) => setRole(idx, role, v)} />
                ))}
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => toggleAdvanced(idx)}
                className="flex items-center gap-1 text-xs font-medium text-neutral-500 hover:text-ph-navy"
              >
                {d.showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {d.showAdvanced ? "Hide" : "Show"} advanced columns ({ADVANCED_ROLES.length})
              </button>
              {d.showAdvanced && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {ADVANCED_ROLES.map((role) => (
                    <RoleField key={role} role={role} value={d.roles[role]} headers={d.headers} onChange={(v) => setRole(idx, role, v)} />
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
        </div>

        {/* Right — run options + cost + run (sticky) */}
        <div className="space-y-4 lg:sticky lg:top-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1 text-xs">
                CDE catalog <InfoTip text={OPTION_HELP.cdeSet} label="About the CDE catalog options" />
              </Label>
              <Select value={cdeSet} onValueChange={(v) => setCdeSet(v as CdeSet)}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="endorsed">NIH-endorsed (~174)</SelectItem>
                  <SelectItem value="full">Full repo (~22.7k)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1 text-xs">
                Run mode <InfoTip text={OPTION_HELP.runMode} label="About the run mode options" />
              </Label>
              <Select value={runMode} onValueChange={(v) => setRunMode(v as RunMode)}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="batch">Batch (async, default)</SelectItem>
                  <SelectItem value="sync">Sync (inline, needs API key)</SelectItem>
                  <SelectItem value="preview">Preview (no LLM — clusters only)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1 text-xs">
                Min cluster size <InfoTip text={OPTION_HELP.minClusterSize} label="About minimum cluster size" />
              </Label>
              <Input
                type="number"
                min={2}
                value={minClusterSize}
                onChange={(e) => setMinClusterSize(Number(e.target.value) || 15)}
                className="h-8"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1 text-xs">
                Run name (optional) <InfoTip text={OPTION_HELP.displayName} label="About the run name" />
              </Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="h-8" />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2">
            <div>
              <Label className="flex items-center gap-1 text-sm">
                Generate transform specs{" "}
                <InfoTip text={OPTION_HELP.genTransformSpecs} label="About transform-spec generation" />
              </Label>
              <p className="text-xs text-neutral-400">
                Value recodes + unit/arithmetic conversions for adopt/refine assignments.
              </p>
            </div>
            <Switch checked={genTransformSpecs} onCheckedChange={setGenTransformSpecs} disabled={runMode === "preview"} />
          </div>

        </CardContent>
      </Card>

      <CostCard breakdown={cost} meta={costMeta} />

      <Button onClick={run} disabled={submitting || !dicts.length || IS_STATIC} size="lg" className="w-full">
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Run harmonization
      </Button>
      {IS_STATIC && (
        <p className="text-center text-xs text-neutral-400">
          New runs are disabled in this preview — explore the sample runs under{" "}
          <Link href="/jobs" className="text-ph-navy underline hover:text-ph-ink">
            Runs
          </Link>
          .
        </p>
      )}
        </div>
      </div>
    </div>
  );
}

function CostCard({ breakdown, meta }: { breakdown: CostBreakdown; meta: string }) {
  return (
    <Card className="border-ph-navy/20 bg-ph-navy/[0.03]">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">Estimated cost</CardTitle>
        {breakdown.free ? (
          <span className="text-lg font-semibold text-success">{meta ? "Free" : "—"}</span>
        ) : (
          <span className="text-lg font-semibold tabular-nums text-ph-ink">
            {formatUsd(breakdown.total.low)}–{formatUsd(breakdown.total.high)}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-neutral-400">{meta || "Add files to estimate"}</p>
        {breakdown.lines.length > 0 && (
          <div className="space-y-1 border-t border-neutral-200 pt-2 text-xs">
            {breakdown.lines.map((l) => (
              <div key={l.label} className="flex items-center justify-between">
                <span className="text-neutral-600">
                  {l.label}
                  {l.note && <span className="ml-1 text-neutral-400">· {l.note}</span>}
                </span>
                <span className="tabular-nums text-neutral-700">{l.cost === 0 ? "$0" : `~${formatUsd(l.cost)}`}</span>
              </div>
            ))}
            {breakdown.batchSavings > 0 && (
              <div className="flex items-center justify-between border-t border-neutral-200 pt-1 text-success">
                <span>Batch discount</span>
                <span className="tabular-nums">−{formatUsd(breakdown.batchSavings)} vs sync</span>
              </div>
            )}
          </div>
        )}
        {breakdown.free && meta && <p className="text-xs text-success">Preview runs no LLM — free.</p>}
        <p className="text-[10px] uppercase tracking-wide text-neutral-400">rough estimate · from observed runs</p>
      </CardContent>
    </Card>
  );
}

function RoleField({
  role,
  value,
  headers,
  onChange,
}: {
  role: ColumnRole;
  value?: string;
  headers: string[];
  onChange: (v: string) => void;
}) {
  const format = ROLE_FORMAT[role];
  return (
    <div className="grid gap-1.5">
      <Label className="flex items-center gap-1 text-xs">
        {role}
        {role === "variable_name" && <span className="text-ph-crimson">*</span>}
        <RoleInfo role={role} />
      </Label>
      <Select value={value || NONE} onValueChange={onChange}>
        <SelectTrigger className="h-8">
          <SelectValue placeholder="— choose column —" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— none —</SelectItem>
          {headers.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {format && <p className="text-[11px] leading-tight text-neutral-400">{format}</p>}
    </div>
  );
}

/** Small ⓘ button with a hover/focus tooltip. Reused for column roles and run options. */
function InfoTip({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-neutral-400 transition-colors hover:text-ph-navy" aria-label={label}>
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal text-left font-normal normal-case leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function RoleInfo({ role }: { role: ColumnRole }) {
  return <InfoTip text={ROLE_HELP[role]} label={`What is ${role}?`} />;
}

// Help text for the run-option controls (mirrors the Guide's "Choosing run options" section).
const OPTION_HELP: Record<string, string> = {
  cdeSet:
    "Which Common Data Element catalog your fields are matched against. NIH-endorsed is a small, curated, high-signal set (~174); Full repo is the complete catalog (~22.7k) — broader coverage, but more candidates to weigh per concept.",
  runMode:
    "How the LLM assignment step runs. Batch: asynchronous and cost-bounded via the Anthropic Batch API (default, cheapest per field). Sync: inline results — needs an API key; best for small runs. Preview: no LLM at all — clustering + candidate retrieval only, so you can inspect the groupings before spending credits.",
  minClusterSize:
    "The fewest fields that can form a concept cluster. Smaller values surface more, finer-grained concepts (and more singletons/novels); larger values pool more aggressively into fewer, broader concepts.",
  displayName: "An optional label to recognize this run in the Runs list. Doesn't affect results.",
  genTransformSpecs:
    "For each adopt/refine assignment, draft the recipe to convert your raw values into the CDE's expected form — categorical value recodes, unit conversions, and arithmetic formulas. Turned off automatically in Preview mode.",
};
