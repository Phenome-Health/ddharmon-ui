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
  Pin,
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
}: {
  spec: CompositeSpec;
  conceptById: Record<string, UIRecord>;
  records: UIRecord[];
  onEdit: (component: string, conceptId: string | null) => void;
  busy: boolean;
  jobId: string;
  hideDerivation?: boolean;
  onOpenGroup?: (conceptId: string) => void;
  resolveConcept?: (id: string) => { concept: string; cohorts: string[] } | undefined;
}) {
  const { definition, feasibility, derivation } = spec;
  // An unrecognized verdict falls back to INDETERMINATE, never to the negative one. The previous
  // `?? VERDICT_STYLE.infeasible` turned any verdict this build did not know about — a newer core's
  // vocabulary, a truncated field on an old run — into an on-screen claim that the score cannot be
  // built. That is the prohibited emission, arrived at by a default rather than by a judgement.
  const style = VERDICT_STYLE[feasibility.verdict] ?? VERDICT_STYLE.indeterminate;
  const codingFor = (name: string): ScoreComponent | undefined =>
    definition.components.find((c) => c.name === name);
  // Two buckets, per the reviewer ask: concepts this run FOUND for a component (sorted most-confident
  // first, since that is the order a reviewer audits) and the ones it did NOT.
  const foundMatches = spec.matches
    .filter((m) => m.conceptId != null)
    .sort((a, b) => b.confidence - a.confidence);
  const notFoundMatches = spec.matches.filter((m) => m.conceptId == null);
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
  // A cohort "covers" a domain when at least one of its components is present in that cohort.
  const cohortCoversDomain = (matches: ComponentMatch[], cohort: string) =>
    matches.some((m) => m.conceptId != null && m.cohorts.includes(cohort));
  // One component's per-cohort presence row — shared by the flat and domain-grouped coverage tables.
  const coverageComponentRow = (m: ComponentMatch) => (
    <tr key={m.component} className="border-b border-border/60 last:border-0">
      <td className="py-1.5 pr-3 text-on-raised">{m.component}</td>
      {feasibility.perCohort.map((c) => {
        const present = m.conceptId != null && m.cohorts.includes(c.cohort);
        return (
          <td key={c.cohort} className="px-2 py-1.5 text-center">
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
          <Collapsible defaultOpen>
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-status-ok" /> Found · {foundMatches.length}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-2">
              {foundMatches.map(renderRow)}
            </CollapsibleContent>
          </Collapsible>
          {notFoundMatches.length > 0 && (
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                <span className="flex items-center gap-1.5">
                  <XCircle className="h-3.5 w-3.5 text-on-raised-muted" /> Not found · {notFoundMatches.length}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {notFoundMatches.map(renderRow)}
              </CollapsibleContent>
            </Collapsible>
          )}
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
                            spec.matches.filter(
                              (m) => m.conceptId != null && m.cohorts.includes(c.cohort),
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
 * One component row: its match (or its honest gap), the coding rule, and the accept/swap/drop controls.
 *
 * The gap wording distinguishes "the judge saw N candidates and rejected them all" from "retrieval found
 * nothing" — a rejected shortlist means the concepts exist but don't measure the component, which is a
 * different problem from the run simply not covering it.
 */
function MatchRow({
  match,
  component,
  concept,
  onEdit,
  busy,
  jobId,
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
  resolveConcept?: (id: string) => { concept: string; cohorts: string[] } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const coding = component?.coding;
  const lowConfidence =
    match.conceptId != null && match.confidence > 0 && match.confidence < 0.6;
  // The swap targets are the concepts retrieval SHORTLISTED for THIS component (the top-k the judge saw),
  // not the whole run — that is what a reviewer wants to choose among, and it is the same set whether the
  // component matched or not. The current pick is folded in and de-duplicated.
  const candidateIds = Array.from(
    new Set([
      ...(match.shortlist ?? []),
      ...(match.conceptId ? [match.conceptId] : []),
    ]),
  );

  return (
    <div className="rounded-md border border-border">
      {/* Collapsed by default so a reviewer can scan the list and open ONE component at a time. */}
      <button
        type="button"
        data-testid="score-component-expand"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {match.conceptId ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-status-ok" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-on-raised-muted" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-on-raised">
              {match.component}
            </span>
            {!match.required && (
              <Badge variant="neutral" className="text-xs">optional</Badge>
            )}
            {match.pinned && (
              <Badge variant="neutral" className="gap-1 text-xs">
                <Pin className="h-2.5 w-2.5" /> pinned
              </Badge>
            )}
            {match.isVariable && (
              <Badge variant="neutral" className="text-xs" title="Matched to a single source variable, not a concept group">
                variable
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-on-raised-muted">
            {match.conceptId
              ? `${match.concept || match.conceptId} · confidence ${match.confidence.toFixed(2)}`
              : match.shortlist.length > 0
                ? `Missing · ${match.shortlist.length} retrieved, none fit`
                : "Missing · nothing retrieved"}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-on-raised-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border/60 px-3 py-2.5 pl-9 text-xs">
          {coding?.needsReview && (
            <Badge className="mb-1.5 border-rule-warn bg-surface-warn text-xs text-on-warn">
              {coding.kind === "unstated"
                ? "no coding rule in source"
                : `${coding.kind.replace(/_/g, " ")} — review`}
            </Badge>
          )}
          {component?.definition && (
            <p className="text-on-raised-muted">{component.definition}</p>
          )}

          {match.conceptId ? (
            <div className="mt-1.5">
              {onOpenGroup ? (
                <button
                  type="button"
                  onClick={() => onOpenGroup(match.conceptId!)}
                  className="text-left text-on-raised underline decoration-rule-control-on-raised hover:text-link-on-raised"
                  title="Show this concept group on Gate 1"
                >
                  {match.concept || concept?.concept || match.conceptId}
                </button>
              ) : (
                <Link
                  href={`/job/${jobId}/workbench?c=${encodeURIComponent(match.conceptId)}`}
                  className="text-on-raised underline decoration-rule-control-on-raised hover:text-link-on-raised"
                  title="Open this concept in the review workbench"
                >
                  {match.concept || concept?.concept || match.conceptId}
                </Link>
              )}
              <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-on-raised-muted">
                <span>{match.cohorts.join(", ") || "—"}</span>
                <span className={lowConfidence ? "text-status-warn" : ""}>
                  confidence {match.confidence.toFixed(2)}
                  {lowConfidence && " — review"}
                </span>
                {match.column && (
                  <span className="font-mono text-xs">{match.column}</span>
                )}
              </div>
              {match.rationale && (
                <p className="mt-1 text-on-raised-muted">{match.rationale}</p>
              )}
            </div>
          ) : (
            <p className="mt-1.5 text-on-raised-muted">
              <span className="font-semibold text-on-raised">Missing.</span>{" "}
              {match.shortlist.length > 0
                ? `${match.shortlist.length} candidate concept${match.shortlist.length === 1 ? "" : "s"} were retrieved and none measures this component — pick one below if it fits.`
                : "Nothing in this run retrieved for it."}
            </p>
          )}

          {coding && (coding.cutoff || coding.referenceRange) && (
            <p className="mt-1 text-on-raised-muted">
              <span className="font-semibold">As stated: </span>
              <span className="font-mono text-xs">
                {coding.cutoff || coding.referenceRange}
              </span>
            </p>
          )}

          {/* accept / swap / drop — every re-derive is free (all other matches are pinned) */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || candidateIds.length === 0}
              onClick={() => setSwapping((sw) => !sw)}
              className="h-6 px-2 text-xs"
            >
              {match.conceptId ? "Swap" : "Choose concept"}
            </Button>
            {match.conceptId && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onEdit(match.component, null)}
                className="h-6 px-2 text-xs"
              >
                Drop
              </Button>
            )}
          </div>

          {swapping && (
            <div
              data-testid="swap-candidates"
              className="mt-1.5 flex flex-col gap-1 rounded-md border border-border bg-surface-raised p-1.5"
            >
              {/* Each retrieved candidate is a link into its Gate 1 group — inspect the members BEFORE
                  selecting — with an explicit Select so opening a group is not the same act as choosing it. */}
              <p className="px-1 pb-0.5 text-[11px] text-on-raised-muted">
                Open a candidate to inspect its group on Gate 1, then select the one that fits.
              </p>
              {candidateIds.map((id) => {
                const c = resolveConcept?.(id);
                const label = c?.concept || id;
                const co = c?.cohorts?.length ? c.cohorts.join(", ") : "";
                const isCurrent = id === match.conceptId;
                return (
                  <div
                    key={id}
                    data-testid="swap-candidate"
                    data-group={id}
                    className="flex items-center gap-2 rounded px-1 py-0.5"
                  >
                    {onOpenGroup ? (
                      <button
                        type="button"
                        data-testid="swap-candidate-open"
                        onClick={() => onOpenGroup(id)}
                        className="min-w-0 flex-1 text-left text-xs text-link-on-raised underline decoration-rule-control-on-raised underline-offset-2"
                        title="Open this concept group on Gate 1"
                      >
                        <span className="line-clamp-1">{label}</span>
                        {co && <span className="text-on-raised-muted"> · {co}</span>}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 text-xs text-on-raised">
                        <span className="line-clamp-1">{label}</span>
                        {co && <span className="text-on-raised-muted"> · {co}</span>}
                      </span>
                    )}
                    {isCurrent ? (
                      <Badge variant="neutral" className="shrink-0 gap-1 text-[11px]">
                        <Pin className="h-2.5 w-2.5" /> current
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="swap-candidate-select"
                        disabled={busy}
                        onClick={() => {
                          setSwapping(false);
                          onEdit(match.component, id);
                        }}
                        className="h-5 shrink-0 px-2 text-[11px]"
                      >
                        Select
                      </Button>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                data-testid="swap-candidate-none"
                disabled={busy}
                onClick={() => {
                  setSwapping(false);
                  onEdit(match.component, null);
                }}
                className="mt-0.5 border-t border-border/60 px-1 pt-1 text-left text-[11px] text-on-raised-muted hover:text-on-raised"
              >
                — none (report as missing) —
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
