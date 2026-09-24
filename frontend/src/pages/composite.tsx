// Composite / derived-variable builder — point at a paper (or repo, PDF, or Word supplement) that defines a score and ask
// whether THIS run's harmonized concepts can support it, and out of which concepts.
//
// Three things this surface must never soften, because they are the whole point of the feature:
//   1. A MISSING component is a result, not a failure to hide — and "we retrieved 8 candidates and the judge
//      rejected them all" is different information from "nothing was retrieved".
//   2. A cutoff the source didn't state is flagged for a human, never invented.
//   3. Partial coverage is NOT the published score. The verdict and the caveats say so in those words.
//
// Metadata-only: the output is a recipe the analyst runs on their own rows. ddharmon never computes it.
import { Fragment, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  Calculator,
  CheckCircle2,
  ChevronDown,
  FileText,
  Link2,
  Loader2,
  CircleDashed,
  Upload,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { deriveComposite, extractCompositeDocument } from "@/lib/api";
import { coveredCohorts } from "@/lib/score-scope";
import { cn } from "@/lib/utils";
import type { ComponentMatch, CompositeSpec, ScoreComponent, UIRecord } from "@/types";

type Mode = "paste" | "ref" | "pdf";

const VERDICT_STYLE: Record<string, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  full: { label: "Computable", className: "text-on-ok border-rule-ok bg-surface-ok", Icon: CheckCircle2 },
  partial: { label: "Partially computable", className: "text-on-warn border-rule-warn bg-surface-warn", Icon: AlertTriangle },
  infeasible: { label: "Not computable", className: "text-on-danger border-rule-danger bg-surface-danger", Icon: XCircle },
  // The fourth value: "we could not tell", which is NOT "no". Rendered by FORM — a dashed ring on the
  // neutral surface — for the same reason the coherence cell renders `not judged` that way: a status
  // colour would file it as an outcome, and it is the absence of one. No destructive colour, because
  // "undeterminable" and "cannot be built" are different claims and must not look alike.
  indeterminate: {
    label: "Cannot be determined",
    className: "text-on-raised-muted border-rule-on-raised",
    Icon: CircleDashed,
  },
};

export default function CompositePage() {
  const { jobId = "" } = useParams();
  const { jobState } = useHarmonizeStream(jobId, true, true);

  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [ref, setRef] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hybrid, setHybrid] = useState(false);
  const [busy, setBusy] = useState<"" | "extract" | "derive">("");
  const [error, setError] = useState("");
  const [spec, setSpec] = useState<CompositeSpec | null>(null);
  const [extracted, setExtracted] = useState<{ provenance: string; nChars: number } | null>(null);

  const records: UIRecord[] = jobState?.result?.records ?? [];
  // Show a previously derived spec for this run until a new derivation replaces it.
  const stored = jobState?.composites ?? null;
  const shown = spec ?? (stored && stored.length > 0 ? stored[stored.length - 1] : null);

  const conceptById = useMemo(() => {
    const m: Record<string, UIRecord> = {};
    for (const r of records) m[r.id] = r;
    return m;
  }, [records]);

  async function onDocument(file: File) {
    setBusy("extract");
    setError("");
    try {
      const out = await extractCompositeDocument(jobId, file);
      setText(out.text);
      setExtracted({ provenance: out.provenance, nChars: out.nChars });
      setMode("paste"); // the extracted text is now the source — reviewable before anything is spent
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function derive(overrides?: Record<string, string | null>) {
    setBusy("derive");
    setError("");
    try {
      const body = overrides
        ? { definition: shown!.definition, overrides }
        : mode === "ref"
          ? { sourceRef: ref, hybrid }
          : { sourceText: text, hybrid };
      setSpec(await deriveComposite(jobId, body, apiKey || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  /** Re-derive with one component's match changed — pin every other match so the pass stays free. */
  function editMatch(component: string, conceptId: string | null) {
    if (!shown) return;
    const overrides: Record<string, string | null> = {};
    for (const m of shown.matches) overrides[m.component] = m.conceptId;
    overrides[component] = conceptId;
    void derive(overrides);
  }

  if (!jobState) {
    return (
      <div className="flex items-center gap-2 p-8 text-on-raised-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
      </div>
    );
  }

  const canDerive = (mode === "ref" ? ref.trim() : text.trim()).length > 0 && busy === "";

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/job/${jobId}`} className="mb-1 flex items-center gap-1 text-xs text-on-field-muted hover:text-on-field">
          <ArrowLeft className="h-3 w-3" /> Back to run
        </Link>
        <h1 className="flex items-center gap-2 font-display text-xl font-semibold text-on-field">
          <Calculator className="h-5 w-5 text-on-field" /> Composite variable
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm text-on-field-muted">
          Point at a paper, repo, PDF, or Word supplement that defines a score — a frailty index, an intrinsic-capacity score,
          an SES index — and see whether this run's {records.length} harmonized concepts can support it, which
          concepts compose it, and how. ddharmon reads only metadata: it produces the derivation recipe and
          never computes the score.
        </p>
      </div>

      {/* --- source --- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">The score's definition</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["paste", "Paste text", FileText],
                ["ref", "URL / DOI / repo", Link2],
                ["pdf", "Upload PDF / Word", Upload],
              ] as const
            ).map(([m, label, Icon]) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "default" : "outline"}
                onClick={() => setMode(m)}
                className="gap-1.5"
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </Button>
            ))}
          </div>

          {mode === "paste" && (
            <>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={7}
                placeholder="Paste the methods section or the component table that defines the score…"
                className="font-mono text-xs"
              />
              {extracted && (
                <p className="text-xs text-on-raised-muted">
                  Extracted {extracted.nChars.toLocaleString()} chars from{" "}
                  <span className="font-semibold text-on-raised">{extracted.provenance}</span> — review it above
                  before deriving. If the score's item table isn't here, the document didn't carry it.
                </p>
              )}
            </>
          )}
          {mode === "ref" && (
            <>
              <Input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="https://… , 10.1007/s11357-017-9993-7, or https://github.com/owner/repo"
              />
              <p className="text-xs text-on-raised-muted">
                Fetched server-side and bounded (http(s) only, size-capped). A publisher page may omit the
                score's item table — if the result looks under-enumerated, upload the PDF or supplement instead.
              </p>
            </>
          )}
          {mode === "pdf" && (
            <div>
              <Input
                type="file"
                accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onDocument(f);
                }}
              />
              <p className="mt-1.5 text-xs text-on-raised-muted">
                PDF or Word (.docx) — a score's item table is often in the supplement, and tables are read too.
                Free — the extracted text lands in the paste box for review before anything is spent.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Anthropic API key (this call only)"
              className="max-w-xs"
            />
            <label className="flex items-center gap-1.5 text-xs text-on-raised-muted">
              <input type="checkbox" checked={hybrid} onChange={(e) => setHybrid(e.target.checked)} />
              Hybrid retrieval (slower first call, better matching on large runs)
            </label>
            <Button onClick={() => void derive()} disabled={!canDerive} className="ml-auto gap-1.5">
              {busy === "derive" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
              Derive
            </Button>
          </div>
          <p className="text-xs text-on-raised-muted">
            Two LLM calls: transcribe the score, then match its components to this run's concepts. Editing a
            match afterwards re-derives for free.
          </p>
          {busy === "extract" && (
            <p className="flex items-center gap-1.5 text-xs text-on-raised-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> Reading the document…
            </p>
          )}
          {error && (
            <p className="rounded-md border border-rule-danger bg-surface-danger px-3 py-2 text-xs text-on-danger">{error}</p>
          )}
        </CardContent>
      </Card>

      {shown && <SpecView spec={shown} conceptById={conceptById} records={records} onEdit={editMatch} busy={busy === "derive"} jobId={jobId} />}
    </div>
  );
}

// Builder-level: a concept group is auto-selected (and auto-tagged for Gate 2) when its aggregate
// confidence is at/above this threshold. Provisional 0.80 — to be tuned against the 49×UKBB FI benchmark;
// set once for the whole builder, never per component.
const GROUP_SELECT_THRESHOLD = 0.8;

export function SpecView({
  spec,
  conceptById,
  records,
  onEdit,
  busy,
  jobId,
  hideDerivation = false,
  onOpenGroup,
  resolveConcept,
  resolveGroupId,
}: {
  spec: CompositeSpec;
  conceptById: Record<string, UIRecord>;
  records: UIRecord[];
  onEdit: (component: string, conceptId: string | null) => void;
  busy: boolean;
  jobId: string;
  hideDerivation?: boolean;
  onOpenGroup?: (conceptId: string) => void;
  resolveConcept?: (
    id: string,
  ) => { concept: string; cohorts: string[]; nMembers?: number } | undefined;
  resolveGroupId?: (id: string) => string | undefined;
}) {
  const { definition, feasibility, derivation } = spec;
  // An unrecognized verdict falls back to INDETERMINATE, never to the negative one. The previous
  // `?? VERDICT_STYLE.infeasible` turned any verdict this build did not know about — a newer core's
  // vocabulary, a truncated field on an old run — into an on-screen claim that the score cannot be
  // built. That is the prohibited emission, arrived at by a default rather than by a judgement.
  const style = VERDICT_STYLE[feasibility.verdict] ?? VERDICT_STYLE.indeterminate;
  const codingFor = (name: string): ScoreComponent | undefined =>
    definition.components.find((c) => c.name === name);
  // The component list renders in SOURCE-DOCUMENT order — `spec.matches` preserves the definition's order,
  // which the builder keeps from the source doc — never reordered by match state or confidence, so the
  // reviewer reads the score exactly as the paper presents it. Found vs missing is shown per row (the icon)
  // and summarised in the header count, not by regrouping the list.
  const nFound = spec.matches.filter((m) => m.conceptId != null).length;
  // Resolve a concept id to a name + cohorts for the swap dropdown. Callers may pass a resolver (the gate
  // strip resolves against the run's concept groups); otherwise fall back to this run's records.
  const recordById = useMemo(
    () => Object.fromEntries(records.map((r) => [r.id, r])),
    [records],
  );
  const resolve =
    resolveConcept ??
    ((id: string) => {
      const r = conceptById[id] ?? recordById[id];
      return r ? { concept: r.concept ?? "", cohorts: r.cohorts ?? [] } : undefined;
    });
  const renderRow = (m: typeof spec.matches[number]) => (
    <MatchRow
      key={m.component}
      match={m}
      component={codingFor(m.component)}
      concept={m.conceptId ? conceptById[m.conceptId] : undefined}
      onEdit={onEdit}
      busy={busy}
      jobId={jobId}
      onOpenGroup={onOpenGroup}
      resolveConcept={resolve}
      resolveGroupId={resolveGroupId}
    />
  );

  // Domain grouping for the coverage view (a score's "type of deficit" sub-scales). GENERIC: the table
  // groups only when components actually carry a `domain`; with none, the flat table below renders
  // unchanged — never a code-side, score-specific grouping. Domains appear in the order their first
  // component appears in the definition.
  const hasDomains = definition.components.some((c) => c.domain);
  const coverageDomains = useMemo(() => {
    if (!hasDomains) return [] as { domain: string; matches: ComponentMatch[] }[];
    const domainByComponent = new Map(
      definition.components.map((c) => [c.name, c.domain || "Other"] as const),
    );
    const order: string[] = [];
    const byDomain = new Map<string, ComponentMatch[]>();
    for (const m of spec.matches) {
      const d = domainByComponent.get(m.component) ?? "Other";
      if (!byDomain.has(d)) {
        byDomain.set(d, []);
        order.push(d);
      }
      byDomain.get(d)!.push(m);
    }
    return order.map((d) => ({ domain: d, matches: byDomain.get(d)! }));
  }, [spec.matches, definition.components, hasDomains]);
  // A cohort "covers" a domain when at least one of its components is COVERED in that cohort — union
  // coverage (`coveredCohorts`), not raw group membership.
  const cohortCoversDomain = (matches: ComponentMatch[], cohort: string) =>
    matches.some((m) => coveredCohorts(m).includes(cohort));
  // One component's per-cohort presence row — shared by the flat and domain-grouped coverage tables. Reads
  // the SAME union coverage as the found-component detail and the Swap list, so the table cannot disagree.
  const coverageComponentRow = (m: ComponentMatch) => (
    <tr
      key={m.component}
      data-testid="coverage-row"
      data-component={m.component}
      className="border-b border-border/60 last:border-0"
    >
      <td className="py-1.5 pr-3 text-on-raised">{m.component}</td>
      {feasibility.perCohort.map((c) => {
        const present = coveredCohorts(m).includes(c.cohort);
        return (
          <td
            key={c.cohort}
            data-testid="coverage-cell"
            data-cohort={c.cohort}
            data-present={present ? "true" : "false"}
            className="px-2 py-1.5 text-center"
          >
            {present ? (
              <CheckCircle2 className="mx-auto h-3.5 w-3.5 text-status-ok" />
            ) : (
              <XCircle className="mx-auto h-3.5 w-3.5 text-on-raised-muted/40" />
            )}
          </td>
        );
      })}
    </tr>
  );

  return (
    <div className="space-y-4">
      {/* --- verdict --- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start gap-2">
            <CardTitle className="text-sm">{definition.name}</CardTitle>
            <Badge variant="neutral" className="text-xs">{definition.kind.replace(/_/g, " ")}</Badge>
            <span className={`ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold ${style.className}`}>
              <style.Icon className="h-3.5 w-3.5" />
              {style.label} · {feasibility.nRequiredMatched}/{feasibility.nRequired} required components
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {definition.citation && <p className="text-xs text-on-raised-muted">{definition.citation}</p>}
          {definition.combinationRule && (
            <p className="text-on-raised">
              <span className="font-semibold text-on-raised">Rule: </span>
              {definition.combinationRule}
            </p>
          )}
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-on-raised-muted">
            <div>
              <dt className="inline font-semibold">Source: </dt>
              <dd className="inline text-on-raised">{definition.provenance || "pasted text"}</dd>
            </div>
            {definition.threshold && (
              <div>
                <dt className="inline font-semibold">Threshold: </dt>
                <dd className="inline text-on-raised">{definition.threshold}</dd>
              </div>
            )}
            {spec.units && (
              <div>
                <dt className="inline font-semibold">Units: </dt>
                <dd className="inline text-on-raised">{spec.units}</dd>
              </div>
            )}
            <div>
              <dt className="inline font-semibold">Cost: </dt>
              <dd className="inline text-on-raised">
                {spec.callsMade ?? 0} LLM call{(spec.callsMade ?? 0) === 1 ? "" : "s"}
                {spec.nConceptsIndexed != null && ` over ${spec.nConceptsIndexed} concepts`}
              </dd>
            </div>
          </dl>

          {definition.underEnumerated > 0 && (
            <p className="flex items-start gap-1.5 rounded-md border border-rule-warn bg-surface-warn px-3 py-2 text-xs text-on-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                The source describes a {definition.statedNItems}-item score but only{" "}
                {definition.components.length} item{definition.components.length === 1 ? "" : "s"} could be read
                out of it. The document is incomplete — supply the publisher PDF or supplement. The missing
                items were <span className="font-semibold">not</span> filled in from prior knowledge.
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      {/* --- components --- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Components → this run's concepts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Builder-level: how matching works + the auto-select threshold, shown ONCE above all components. */}
          <div
            data-testid="score-builder-info"
            className="rounded-md border border-border bg-surface-raised px-3 py-2.5 text-xs"
          >
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted">
              Score builder · how matching works
            </p>
            <ul className="flex flex-col gap-1 text-on-raised-muted">
              <li>
                <span className="font-semibold text-on-raised">Source-only.</span> Each component shows the
                paper&rsquo;s own fields (name · categories · coding); generated prose is dropped unless it is
                verbatim in the document.
              </li>
              <li>
                <span className="font-semibold text-on-raised">Scoring.</span> The judge rates each variable /
                answer-option individually (0–1); a group&rsquo;s score is the mean of its rated members.
              </li>
              <li>
                <span className="font-semibold text-on-raised">Component number.</span> The figure on each
                component is the mean of the best match per cohort, over the cohorts found.
              </li>
            </ul>
            <p className="mt-2 border-t border-rule-quiet-on-raised pt-2 text-on-raised-muted">
              Auto-select &amp; tag every group scoring{" "}
              <span className="font-mono text-on-raised">{GROUP_SELECT_THRESHOLD.toFixed(2)}</span> or higher —
              set once here, applies to all components.
              <span className="mt-0.5 block text-on-raised-muted/80">
                Provisional — to be tuned against the 49×UKBB FI benchmark.
              </span>
            </p>
          </div>
          {/* ONE list, in source-document order (never regrouped found-vs-missing or sorted by confidence).
              The header carries the found/total tally; each row shows its own found/missing icon. */}
          <Collapsible defaultOpen>
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
              <span className="flex items-center gap-1.5">
                Components · {nFound}/{spec.matches.length} found
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-2">
              {spec.matches.map(renderRow)}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {/* --- per-cohort coverage --- */}
      <Card>
        <Collapsible defaultOpen>
          <CardHeader className="pb-2">
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left">
              <CardTitle className="text-sm">
                Per-cohort coverage
                {hasDomains && (
                  <span className="ml-2 font-normal text-xs text-on-raised-muted">
                    by {coverageDomains.length} domains
                  </span>
                )}
              </CardTitle>
              <ChevronDown className="h-4 w-4 shrink-0 text-on-raised-muted transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-on-raised-muted">
                      <th className="py-1.5 pr-3 font-semibold">Component</th>
                      {feasibility.perCohort.map((c) => (
                        <th key={c.cohort} className="px-2 py-1.5 text-center font-semibold">
                          {c.cohort}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {hasDomains
                      ? coverageDomains.map(({ domain, matches }) => (
                          <Fragment key={domain}>
                            <tr className="border-b border-border bg-muted/40">
                              <td
                                colSpan={feasibility.perCohort.length + 1}
                                className="px-1 py-1 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted"
                              >
                                {domain}
                              </td>
                            </tr>
                            {matches.map(coverageComponentRow)}
                            {/* The domain-level readout the reviewer asked for: a cohort need only supply
                                ONE item in a sub-scale for that domain to be represented in it. */}
                            <tr
                              data-testid="coverage-domain-covers"
                              data-domain={domain}
                              className="border-b border-border/60 text-on-raised-muted"
                            >
                              <td className="py-1 pl-3 pr-3 italic">covers ≥1</td>
                              {feasibility.perCohort.map((c) => (
                                <td key={c.cohort} className="px-2 py-1 text-center">
                                  {cohortCoversDomain(matches, c.cohort) ? (
                                    <CheckCircle2 className="mx-auto h-3 w-3 text-status-ok" />
                                  ) : (
                                    <XCircle className="mx-auto h-3 w-3 text-on-raised-muted/40" />
                                  )}
                                </td>
                              ))}
                            </tr>
                          </Fragment>
                        ))
                      : spec.matches.map(coverageComponentRow)}
                    <tr className="border-t border-border font-semibold">
                      <td className="py-1.5 pr-3 text-on-raised">Present</td>
                      {feasibility.perCohort.map((c) => (
                        <td key={c.cohort} className="px-2 py-1.5 text-center text-on-raised">
                          {
                            spec.matches.filter((m) =>
                              coveredCohorts(m).includes(c.cohort),
                            ).length
                          }
                        </td>
                      ))}
                    </tr>
                    <tr className="font-semibold">
                      <td className="py-1.5 pr-3 text-on-raised">Computable</td>
                      {feasibility.perCohort.map((c) => (
                        <td key={c.cohort} className="px-2 py-1.5 text-center">
                          {c.computable ? (
                            <span className="text-status-ok">yes</span>
                          ) : (
                            <span className="text-on-raised-muted">no</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-on-raised-muted">
                A cohort is computable only when every required component is present in it.
                {hasDomains &&
                  " “covers ≥1” is looser — it asks only whether a cohort supplies any item in a domain."}{" "}
                Presence is per data dictionary — participant-level missingness, and therefore effective N,
                cannot be derived from metadata.
              </p>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* --- derivation --- */}
      {!hideDerivation && (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Derivation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {derivation.map((s) => (
            <div key={s.order} className="rounded-md border border-border bg-muted/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-on-raised-muted">{s.order}.</span>
                <Badge variant="neutral" className="text-xs">{s.kind.replace(/_/g, " ")}</Badge>
                {s.needsReview && (
                  <Badge className="border-rule-warn bg-surface-warn text-xs text-on-warn">needs review</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-on-raised">{s.description}</p>
              {s.expression && (
                <pre className="mt-1.5 overflow-x-auto rounded bg-surface-raised px-2 py-1.5 font-mono text-xs text-on-raised">
                  {s.expression}
                </pre>
              )}
            </div>
          ))}
          {spec.validationRules.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-on-raised-muted">
              {spec.validationRules.map((r) => (
                <li key={r} className="flex gap-1.5">
                  <span className="text-on-raised-muted">•</span>
                  {r}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}

      {feasibility.caveats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Caveats</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-xs text-on-raised">
              {feasibility.caveats.map((c) => (
                <li key={c} className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-on-raised-muted" />
                  {c}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * One component row: the concept GROUPS its rated variables reached. Every group at/above the builder's
 * auto-select threshold renders as selected (and auto-tagged for Gate 2), with its covered members + cohorts;
 * the header figure is the mean best match per cohort. Source coding is shown structurally, never as
 * synthesised prose. A missing component lists the retrieved-but-below-threshold candidates instead.
 */
function MatchRow({
  match,
  component,
  onEdit,
  busy,
  onOpenGroup,
  resolveConcept,
}: {
  match: ComponentMatch;
  component?: ScoreComponent;
  concept?: UIRecord;
  onEdit: (component: string, conceptId: string | null) => void;
  busy: boolean;
  jobId: string;
  onOpenGroup?: (conceptId: string) => void;
  resolveConcept?: (
    id: string,
  ) => { concept: string; cohorts: string[]; nMembers?: number } | undefined;
  resolveGroupId?: (id: string) => string | undefined;
}) {
  void onEdit;
  void busy;
  const [open, setOpen] = useState(false);
  const coding = component?.coding;

  // Build the reached concept GROUPS from `groupCandidates`, each carrying its covered members (from
  // `coverageMembers`, grouped by the member's source groupId). Union coverage already spans groups, so this
  // shows WHICH group each cohort's support came from — no single "winner" group (the cataracts/glaucoma
  // case where AoU's match lived in a different group than the surfaced one).
  const membersByGroup = new Map<
    string,
    { cohort: string; variableId: string; confidence: number; optionLabel?: string }[]
  >();
  for (const [cohort, mems] of Object.entries(match.coverageMembers ?? {})) {
    for (const mm of mems) {
      const gid = mm.groupId ?? match.conceptId ?? "";
      const list = membersByGroup.get(gid) ?? [];
      list.push({ cohort, variableId: mm.variableId, confidence: mm.confidence, optionLabel: mm.optionLabel });
      membersByGroup.set(gid, list);
    }
  }
  // Back-compat: a spec from before variable-only matching carries only `conceptId` (no `groupCandidates`).
  // Treat that concept as its one group so a matched component never expands to "Missing".
  const candidates: NonNullable<ComponentMatch["groupCandidates"]> = match.groupCandidates?.length
    ? match.groupCandidates
    : match.conceptId
      ? [{ groupId: match.conceptId, confidence: match.confidence }]
      : [];
  const groups = candidates.map((g) => ({
    groupId: g.groupId,
    label: resolveConcept?.(g.groupId)?.concept?.trim() || "Unnamed group",
    confidence: g.confidence,
    nMatched: g.nMatched,
    nTotal: g.nTotal,
    members: (membersByGroup.get(g.groupId) ?? []).slice().sort((a, b) => b.confidence - a.confidence),
    selected: g.confidence >= GROUP_SELECT_THRESHOLD,
  }));
  type GroupRow = (typeof groups)[number];
  const orderedGroups = [...groups].sort((a, b) => b.confidence - a.confidence);

  // Selection is interactive: SEEDED from the auto-select threshold, then the reviewer checks/unchecks any
  // group. The spread, the header figure and the Gate-2 tags all derive from the CHECKED set. This slice
  // keeps the set in component state — clickable on the static demo; persisting it across a reload and wiring
  // it into the Gate-2 queue is the next slice.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(groups.filter((g) => g.selected).map((g) => g.groupId)),
  );
  const isSel = (gid: string) => selectedIds.has(gid);
  const toggleGroup = (gid: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  const selected = orderedGroups.filter((g) => isSel(g.groupId));

  // Header figure = mean of the best match per cohort, averaged over the cohorts FOUND across the SELECTED
  // groups (not one group's aggregate). Breadth is the spread line's job, so this number means "how good are
  // the matches we found", not a coverage count.
  const bestByCohort = new Map<string, number>();
  for (const g of selected)
    for (const m of g.members) {
      const cur = bestByCohort.get(m.cohort);
      if (cur == null || m.confidence > cur) bestByCohort.set(m.cohort, m.confidence);
    }
  const meanBest = bestByCohort.size
    ? [...bestByCohort.values()].reduce((s, v) => s + v, 0) / bestByCohort.size
    : null;

  const spreadVars = selected.reduce((s, g) => s + g.members.length, 0);
  const spreadCohorts = [...new Set(selected.flatMap((g) => g.members.map((m) => m.cohort)))];
  const isFound = selected.length > 0 || match.conceptId != null;

  const renderGroup = (g: GroupRow) => {
    const sel = isSel(g.groupId);
    return (
      <div
        data-testid="score-group"
        data-group={g.groupId}
        data-selected={sel ? "true" : "false"}
        className={cn(
          "rounded-md border",
          sel ? "border-rule-ok bg-surface-ok" : "border-border bg-surface-raised opacity-80",
        )}
      >
        <div className="flex items-start gap-2 px-2.5 py-2">
          <input
            type="checkbox"
            data-testid="score-group-toggle"
            checked={sel}
            onChange={() => toggleGroup(g.groupId)}
            aria-label={`Include the group ${g.label} for this component`}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer text-status-ok accent-current"
          />
          <div className="min-w-0 flex-1">
            {onOpenGroup ? (
              <button
                type="button"
                data-testid="score-open-group"
                data-group={g.groupId}
                onClick={() => onOpenGroup(g.groupId)}
                className="text-left text-xs font-semibold text-link-on-raised underline decoration-rule-control-on-raised underline-offset-2"
                title="Open this concept group on Gate 1"
              >
                {g.label} ↗
              </button>
            ) : (
              <span className="text-xs font-semibold text-on-raised">{g.label}</span>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-on-raised-muted">
              <span className="font-mono tabular-nums text-on-raised">{g.confidence.toFixed(2)}</span>
              {g.nMatched != null && g.nTotal != null && (
                <span className="text-status-warn">
                  {g.nMatched} of {g.nTotal} matched
                </span>
              )}
            </div>
            {g.members.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-0.5 border-l border-border/60 pl-2.5">
                {g.members.map((m) => {
                  // The raw variable id (e.g. "CLSA:GEN_HLTH_TRM") is not informative — surface the field's
                  // question text (or its description, then its name) via the run's field index. Drop the
                  // "cohort:" prefix on any fallback: the cohort chip beside it already carries the cohort.
                  // Field text can carry raw HTML + help blocks (some cohorts bury the question in notes), so
                  // strip tags and collapse whitespace; the span line-clamps so a messy field stays one row.
                  const raw = resolveConcept?.(m.variableId)?.concept?.trim();
                  const q = raw ? raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
                  const ci = m.variableId.indexOf(":");
                  const label = q || (ci >= 0 ? m.variableId.slice(ci + 1) : m.variableId);
                  return (
                    <li
                      key={`${m.cohort}:${m.variableId}`}
                      data-testid="score-group-member"
                      data-cohort={m.cohort}
                      className="flex items-baseline gap-2 text-[11px]"
                    >
                      <span className="mt-px shrink-0 rounded border border-rule-on-raised px-1 py-0.5 font-mono text-[10px] font-semibold text-on-raised-muted">
                        {m.cohort}
                      </span>
                      <span className="line-clamp-2 min-w-0 flex-1 text-on-raised-muted" title={label}>
                        {label}
                        {m.optionLabel && <span className="italic"> · “{m.optionLabel}”</span>}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-on-raised-muted">
                        {m.confidence.toFixed(2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Keep-all transparency: a group can be judge-affirmed yet have no member at/above the 0.50
                coverage floor — show WHY it has a count but no evidence row, rather than an empty group. */}
            {g.members.length === 0 && g.nMatched != null && g.nMatched > 0 && (
              <p className="mt-1 pl-2.5 text-[11px] italic text-on-raised-muted">
                {g.nMatched} affirmed {g.nMatched === 1 ? "member" : "members"} below the 0.50 coverage floor —
                open on Gate 1 to inspect.
              </p>
            )}
          </div>
          {sel && (
            <span
              data-testid="score-group-gate2"
              className="shrink-0 rounded-full border border-rule-info bg-surface-info px-1.5 py-0.5 text-[10px] font-semibold text-link-on-raised"
            >
              Gate 2 ✓
            </span>
          )}
        </div>
      </div>
    );
  };

  // Source coding shown STRUCTURALLY (categories / coding map or the stated cutoff) — never the freeform
  // `component.definition` prose, which the extract step can synthesise past the "from doc" guardrail.
  const codeEntries = coding?.codeMap ? Object.entries(coding.codeMap) : [];

  return (
    <div
      className="rounded-md border border-border"
      data-testid="score-match"
      data-component={match.component}
      data-matched={isFound ? "true" : "false"}
    >
      <button
        type="button"
        data-testid="score-component-expand"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {isFound ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-status-ok" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-on-raised-muted" />
        )}
        <span className="min-w-0 flex-1 text-sm font-semibold text-on-raised">{match.component}</span>
        {meanBest != null && (
          <span className="flex shrink-0 items-baseline gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted/70">
              mean best / cohort
            </span>
            <span data-testid="score-confidence" className="font-mono text-xs tabular-nums text-on-raised">
              {meanBest.toFixed(2)}
            </span>
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-on-raised-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {/* ALWAYS-VISIBLE summary (moved out of the dropdown per review): review flag, source coding, spread. */}
      <div className="flex flex-col gap-1.5 px-3 pb-2.5 pl-9 text-xs">
        {coding?.needsReview && (
          <Badge className="w-fit border-rule-warn bg-surface-warn text-xs text-on-warn">
            {coding.kind === "unstated" ? "no coding rule in source" : `${coding.kind.replace(/_/g, " ")} — review`}
          </Badge>
        )}
        <div
          data-testid="score-source-coding"
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-on-raised-muted"
        >
          {coding?.kind && coding.kind !== "unstated" && <span>{coding.kind.replace(/_/g, " ")}</span>}
          {codeEntries.map(([k, v]) => (
            <span key={k} className="font-mono">
              · {k} → {v}
            </span>
          ))}
          {(coding?.cutoff || coding?.referenceRange) && (
            <span className="font-mono">· {coding.cutoff || coding.referenceRange}</span>
          )}
        </div>
        {orderedGroups.length > 0 && (
          <div
            data-testid="score-spread"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-rule-info bg-surface-info px-3 py-2 text-on-raised"
          >
            <span>
              <span className="font-semibold">{spreadVars}</span> variable{spreadVars === 1 ? "" : "s"}
            </span>
            <span className="text-on-raised-muted">·</span>
            <span>
              <span className="font-semibold">{spreadCohorts.length}</span> cohort
              {spreadCohorts.length === 1 ? "" : "s"}
              {spreadCohorts.length > 0 && (
                <span className="text-on-raised-muted"> ({spreadCohorts.join(", ")})</span>
              )}
            </span>
            <span className="text-on-raised-muted">·</span>
            <span>
              <span className="font-semibold">{selected.length}</span> group{selected.length === 1 ? "" : "s"}{" "}
              selected
            </span>
            {selected.length > 0 && (
              <span className="ml-auto text-[11px] font-semibold text-link-on-raised">
                → auto-queued for Gate 2
              </span>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="border-t border-border/60 px-3 py-2.5 pl-9 text-xs">
          {orderedGroups.length > 0 ? (
            <>
              <div className="flex flex-col gap-1.5">
                {orderedGroups.map((g, i) => {
                  const showDivider =
                    i > 0 &&
                    orderedGroups[i - 1].confidence >= GROUP_SELECT_THRESHOLD &&
                    g.confidence < GROUP_SELECT_THRESHOLD;
                  return (
                    <Fragment key={g.groupId}>
                      {showDivider && (
                        <div className="flex items-center gap-2 py-0.5 text-[10px] font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                          <span className="h-px flex-1 bg-border" />
                          below auto-select threshold {GROUP_SELECT_THRESHOLD.toFixed(2)}
                          <span className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      {renderGroup(g)}
                    </Fragment>
                  );
                })}
              </div>
              <p className="mt-2 border-t border-rule-quiet-on-raised pt-2 text-[11px] text-on-raised-muted">
                Checked groups auto-tag and continue to Gate 2. Refine any group&rsquo;s membership on Gate 1
                via its <span className="font-semibold">↗</span> link (normal drag/drop); the panel re-reads it.
              </p>
            </>
          ) : (
            <p className="text-on-raised-muted">
              <span className="font-semibold text-on-raised">Missing.</span>{" "}
              {match.shortlist.length > 0
                ? `${match.shortlist.length} ${match.shortlist.length === 1 ? "candidate was" : "candidates were"} retrieved and none measures this component.`
                : "Nothing in this run retrieved for it."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
