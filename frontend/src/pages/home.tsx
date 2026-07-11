import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Eye, EyeOff, Info, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IS_STATIC, listModels, startHarmonize } from "@/lib/api";
import { useAuthState } from "@/auth";
import {
  ADVANCED_ROLES,
  SEMANTIC_ROLES,
  VALUE_ROLES,
  ROLE_FORMAT,
  ROLE_HELP,
  ROLE_REQUIREMENT,
  estimateRunCostBreakdown,
  estimateRunTime,
  formatUsd,
  formatDurationRange,
  type CdeSet,
  type ColumnRole,
  type CostBreakdown,
  type RunMode,
  type TimeEstimate,
} from "@/types";

const NONE = "__none__";

// Human-facing provider labels + per-provider key hints for the picker. Providers not listed here
// (e.g. "other") fall back to the raw id and a generic key field.
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  local: "Local / on-prem",
  other: "Other",
};
const PROVIDER_KEY_INFO: Record<string, { placeholder: string; link?: string }> = {
  anthropic: { placeholder: "sk-ant-…", link: "https://console.anthropic.com/settings/keys" },
  openai: { placeholder: "sk-…", link: "https://platform.openai.com/api-keys" },
  gemini: { placeholder: "AIza…", link: "https://aistudio.google.com/apikey" },
};

// Models validated end-to-end with ddharmon are selectable; the rest render greyed-out/disabled until we
// finish testing them. So far only Anthropic's Claude Sonnet 4.6 has been validated. Matched tolerantly so a
// proxy-returned id like "anthropic/claude-sonnet-4-6" also counts.
const isModelTested = (id: string): boolean => /sonnet.*4[.-]6/i.test(id);

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
  const { isGuest } = useAuthState();
  const [dicts, setDicts] = useState<DictFile[]>([]);
  const [cdeSet, setCdeSet] = useState<CdeSet>("endorsed");
  const [runMode, setRunMode] = useState<RunMode>("batch");
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("");
  const [genTransformSpecs, setGenTransformSpecs] = useState(true);
  const [displayName, setDisplayName] = useState("");
  // BYOK: kept in component memory only — never persisted (no localStorage/sessionStorage), cleared on reload.
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const needsKey = runMode !== "preview"; // batch + sync call the LLM; preview runs none
  const needsProviderKey = needsKey && provider !== "local"; // local/on-prem models need no provider key

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
  const time = useMemo(
    () => estimateRunTime(totalFields, dicts.length, runMode),
    [totalFields, dicts.length, runMode],
  );
  const costMeta = dicts.length
    ? `${totalFields.toLocaleString()} fields · ${dicts.length} cohort${dicts.length > 1 ? "s" : ""} · ${runMode}`
    : "";

  // Model catalog for the picker — from the proxy (via the backend) or a built-in fallback.
  const { data: catalog } = useQuery({ queryKey: ["models"], queryFn: listModels });
  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const providers = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of models) if (!seen.has(m.provider)) (seen.add(m.provider), out.push(m.provider));
    return out;
  }, [models]);
  const modelsForProvider = useMemo(() => models.filter((m) => m.provider === provider), [models, provider]);
  // Keep `model` valid for the chosen provider: default to the first available whenever the current pick is
  // empty or not in the provider's list (after the catalog loads, or when the provider changes).
  useEffect(() => {
    if (!modelsForProvider.length) return;
    // Default to the first TESTED model for the provider (so Anthropic lands on Sonnet 4.6); fall back to the
    // first listed only if the provider has no tested model yet. Also re-default if the current pick is a
    // now-disabled (untested) model.
    const valid = model && modelsForProvider.some((m) => m.id === model && isModelTested(m.id));
    if (!valid) setModel((modelsForProvider.find((m) => isModelTested(m.id)) ?? modelsForProvider[0]).id);
  }, [modelsForProvider, model]);
  const providerLabel = PROVIDER_LABELS[provider] ?? provider;
  const isProviderTested = (p: string): boolean => models.some((m) => m.provider === p && isModelTested(m.id));
  const keyInfo = PROVIDER_KEY_INFO[provider];

  async function run() {
    if (isGuest) {
      toast.error("Sign in to run your own cohorts. The demo is available without an account.");
      return;
    }
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
    const key = apiKey.trim();
    if (needsProviderKey) {
      if (!key) {
        toast.error(`Enter your ${providerLabel} API key for batch/sync runs, or switch to Preview (no LLM).`);
        return;
      }
      if (provider === "anthropic" && !key.startsWith("sk-ant-")) {
        toast.error("That doesn't look like an Anthropic API key — it should start with “sk-ant-”.");
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
        genTransformSpecs,
        displayName: displayName || undefined,
        modelTag: model || undefined,
        provider,
      };
      const { jobId } = await startHarmonize(
        dicts.map((d) => d.file),
        config,
        provider,
        needsProviderKey ? key : undefined,
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

            <div className="space-y-4">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Question columns
                  <span className="font-normal normal-case text-neutral-300">what the field asks (semantic)</span>
                  <span className="inline-flex items-center gap-1 font-normal normal-case text-ph-crimson">
                    <span aria-hidden>★</span> at least one required
                    <InfoTip
                      text="Map at least one meaning-bearing field so the pipeline can match your fields to CDEs. description and question_text are the primary semantic signals; variable_name alone works but carries the least meaning (and is auto-generated if you skip it)."
                      label="About the required fields"
                    />
                  </span>
                </div>
                <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
                  {SEMANTIC_ROLES.map((role) => (
                    <RoleField key={role} role={role} value={d.roles[role]} headers={d.headers} onChange={(v) => setRole(idx, role, v)} />
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Response columns{" "}
                  <span className="ml-1 font-normal normal-case text-neutral-300">the values &amp; how they're coded</span>
                </div>
                <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
                  {VALUE_ROLES.map((role) => (
                    <RoleField key={role} role={role} value={d.roles[role]} headers={d.headers} onChange={(v) => setRole(idx, role, v)} />
                  ))}
                </div>
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
                  <SelectItem value="preview">Preview (no LLM — clusters only)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {needsKey && (
              <div className="grid gap-1.5">
                <Label className="flex items-center gap-1 text-xs">
                  Provider <InfoTip text={OPTION_HELP.provider} label="About the provider options" />
                </Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => {
                      const tested = isProviderTested(p);
                      return (
                        <SelectItem key={p} value={p} disabled={!tested}>
                          {(PROVIDER_LABELS[p] ?? p) + (tested ? "" : " · not yet tested")}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
            {needsKey && (
              <div className="grid gap-1.5">
                <Label className="flex items-center gap-1 text-xs">
                  Model <InfoTip text={OPTION_HELP.model} label="About the model options" />
                </Label>
                <Select value={model} onValueChange={setModel} disabled={!modelsForProvider.length}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder={modelsForProvider.length ? undefined : "No models available"} />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsForProvider.map((m) => {
                      const tested = isModelTested(m.id);
                      return (
                        <SelectItem key={m.id} value={m.id} disabled={!tested}>
                          {m.label + (tested ? "" : " · not yet tested")}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
            {needsProviderKey && (
              <div className="grid gap-1.5">
                <Label className="flex items-center gap-1 text-xs">
                  {providerLabel} API key <span className="text-ph-crimson">*</span>
                  <InfoTip text={OPTION_HELP.apiKey} label="About the API key" />
                </Label>
                <div className="relative">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={keyInfo?.placeholder ?? "your API key"}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`${providerLabel} API key`}
                    className="h-8 pr-8 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 transition-colors hover:text-ph-navy"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <p className="text-[11px] leading-tight text-neutral-400">
                  Used only for this run, sent over HTTPS — never stored, logged, or saved with the run.{" "}
                  {keyInfo?.link && (
                    <a
                      href={keyInfo.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ph-navy underline hover:text-ph-ink"
                    >
                      Get a key
                    </a>
                  )}
                </p>
              </div>
            )}
            {needsKey && provider === "local" && (
              <p className="text-[11px] leading-tight text-neutral-400">
                Local / on-prem models run through the self-hosted proxy — no provider API key needed.
              </p>
            )}
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

      <CostCard breakdown={cost} time={time} meta={costMeta} />

      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] leading-snug text-neutral-500">
        {runMode === "preview" ? (
          <>
            <span className="font-medium text-neutral-700">Nothing leaves this server.</span> Preview runs
            clustering and candidate retrieval on-box — no third-party LLM call, and none of your data is sent
            anywhere.
          </>
        ) : provider === "local" ? (
          <>
            <span className="font-medium text-neutral-700">Stays on-prem.</span> Field names, descriptions, and
            value labels are sent to your local / on-prem model via the self-hosted proxy — inside your compliance
            boundary, not to any third-party cloud.
          </>
        ) : (
          <>
            <span className="font-medium text-neutral-700">Before you run:</span> the field names, descriptions,
            and value labels from your dictionaries are sent to{" "}
            <span className="font-medium text-neutral-700">{providerLabel}'s API</span> — a third party we don't
            control — to run concept assignment. The calls use your own key; your data is processed in memory for
            this run only and nothing is retained after it completes. Switch to Preview to run with no LLM at all.
          </>
        )}
      </div>

      <Button
        onClick={run}
        disabled={submitting || !dicts.length || IS_STATIC || isGuest}
        size="lg"
        className="w-full"
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Run harmonization
      </Button>
      {isGuest && (
        <p className="text-center text-xs text-neutral-400">
          You're exploring as a guest. <span className="text-neutral-500">Sign in</span> to upload and run your
          own cohorts — the <Link href="/demo" className="text-ph-navy underline hover:text-ph-ink">demo</Link> runs
          without an account.
        </p>
      )}
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

function CostCard({ breakdown, time, meta }: { breakdown: CostBreakdown; time: TimeEstimate; meta: string }) {
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
        {time.mid > 0 && (
          <div className="flex items-center justify-between border-t border-neutral-200 pt-2 text-xs">
            <span className="text-neutral-600">
              Estimated time
              {time.note && <span className="ml-1 text-neutral-400">· {time.note}</span>}
            </span>
            <span className="tabular-nums text-neutral-700">~{formatDurationRange(time)}</span>
          </div>
        )}
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
  const requirement = ROLE_REQUIREMENT[role];
  return (
    <div className="grid gap-1.5">
      <Label className="flex items-center gap-1 text-xs">
        {role}
        {/* Soft, non-crimson tier hints; the hard "required" marker lives on the semantic group header. */}
        {requirement === "conditional" && (
          <span className="font-normal normal-case text-neutral-400">· for transform specs</span>
        )}
        {requirement === "recommended" && (
          <span className="font-normal normal-case text-neutral-400">· recommended</span>
        )}
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
    "How the run executes. Batch: the LLM assignment runs asynchronously via the Anthropic Batch API (cost-bounded; needs your API key below). Preview: no LLM at all — clustering + candidate retrieval only, so you can inspect the groupings for free before spending credits.",
  provider:
    "Which LLM provider runs concept assignment. Only providers we've validated end-to-end with ddharmon are selectable; the others are shown greyed-out and will unlock as we finish testing them. So far ddharmon has been tested only with Anthropic (Claude Sonnet 4.6). Anthropic uses the cost-bounded Batch API; other providers will run synchronously via the self-hosted proxy.",
  model:
    "The specific model the pipeline calls for concept assignment and transform specs. Only models we've validated with ddharmon are selectable — so far that's Anthropic's Claude Sonnet 4.6. Greyed-out models are shown for visibility and become available once we've completed testing on them.",
  apiKey:
    "Your provider API key authorizes this run's LLM calls (concept assignment + transform specs). It's sent over HTTPS for this run only — never written to disk, logs, or the saved run config, and it's cleared when you reload the page. Not needed for Preview mode or local/on-prem models, which need no provider key.",
  displayName: "An optional label to recognize this run in the Runs list. Doesn't affect results.",
  genTransformSpecs:
    "For each adopt/refine assignment, draft the recipe to convert your raw values into the CDE's expected form — categorical value recodes, unit conversions, and arithmetic formulas. Turned off automatically in Preview mode.",
};
