import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listDemos, startDemo } from "@/lib/api";
import { PH } from "@/lib/links";

// Public source dictionary + reproducing build script for each demo cohort. Kept in sync with the
// provenance table at data/examples/README.md (the source of truth). URLs are the public, no-login catalogs.
const DEMO_SOURCES: { name: string; href: string; src: string; script: string }[] = [
  {
    name: "All of Us",
    href: "https://docs.google.com/spreadsheets/d/1pODkE2bFN-kmVtYp89rtrJg7oXck4Fsex58237x47mA/edit",
    src: "Survey Data Codebooks",
    script: "build_all_of_us_csv.py",
  },
  {
    name: "CLSA",
    href: "https://www.clsa-elcv.ca/resource-types/data-dictionaries/",
    src: "CLSA Data Dictionaries",
    script: "build_clsa_csv.py",
  },
  {
    name: "UK Biobank",
    href: "https://biobank.ndph.ox.ac.uk/showcase/schema.cgi",
    src: "UKB Showcase Schema",
    script: "build_ukbb_csv.py",
  },
  {
    name: "MESA",
    href: "https://www.ncbi.nlm.nih.gov/projects/gap/cgi-bin/study.cgi?study_id=phs000209",
    src: "dbGaP phs000209 (public variable summaries)",
    script: "build_dbgap_csv.py",
  },
  {
    name: "AI-READI",
    href: "https://github.com/AI-READI/DataElementMaps",
    src: "AI-READI / DataElementMaps",
    script: "build_aireadi_csv.py",
  },
  {
    name: "NIH CDEs",
    href: "https://cde.nlm.nih.gov/",
    src: "NIH CDE Repository (assignment backbone)",
    script: "flatten_cde_repo.py",
  },
];

export default function DemoPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["demos"], queryFn: listDemos });

  const datasets = data?.datasets ?? [];
  const combos = useMemo(() => data?.combos ?? [], [data]);
  // A single canonical demo — the largest available combo (the cross-cohort run). No cohort picker.
  const combo = useMemo(
    () => combos.filter((c) => c.available).sort((a, b) => b.datasets.length - a.datasets.length)[0],
    [combos],
  );
  const cohorts = useMemo(
    () => (combo ? datasets.filter((d) => combo.datasets.includes(d.id)) : []),
    [combo, datasets],
  );
  const totalFields = cohorts.reduce((s, d) => s + (d.nFields ?? 0), 0);
  // Stable id of the prepopulated run (matches the backend + static-client scheme) — deep-link target for
  // "skip to results", so impatient users jump straight to the finished run without watching it build.
  const demoJobId = useMemo(
    () => (combo ? "demo-" + [...combo.datasets].map((d) => d.toLowerCase()).sort().join("_") : null),
    [combo],
  );

  async function load() {
    if (!combo) return;
    setLoading(true);
    try {
      const { jobId } = await startDemo(combo.datasets);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      navigate(`/job/${jobId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load demo");
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ph-ink">
          <Sparkles className="h-5 w-5 text-ph-navy" /> Demo
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Watch a real cross-cohort harmonization run — mapping verdicts, transform specs, and the
          visualizations — over curated public cohorts. No uploads, no API credits.
        </p>
      </div>

      <Card className="border-ph-navy/20 bg-ph-navy/[0.03]">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">{combo?.label ?? "Cross-cohort demo"}</CardTitle>
          <Badge variant="secondary" className="font-normal">
            no API credits
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading demo…
            </div>
          ) : !combo ? (
            <p className="py-6 text-sm text-neutral-500">Demo snapshot is being prepared — check back soon.</p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                {cohorts.map((d) => (
                  <div
                    key={d.id}
                    className="flex flex-col gap-1 rounded-md border border-neutral-200 bg-neutral-0 p-3 text-sm"
                  >
                    <span className="font-medium text-neutral-700">{d.label}</span>
                    <span className="text-xs text-neutral-400">{d.nFields} variables</span>
                    {d.description && <span className="text-xs text-neutral-400">{d.description}</span>}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-neutral-400">
                  {cohorts.length} cohorts · {totalFields} variables · live mapping to NIH CDEs
                  {data?.coreVersion && (
                    <>
                      {" · "}
                      <span
                        title="The ddharmon version this frozen demo was generated with. The live app on dev.ddharmon.io may run a newer version — prod lags dev, so a feature you see on dev may not appear in this demo (or on prod) yet."
                        className="cursor-help underline decoration-dotted underline-offset-2"
                      >
                        reflects ddharmon v{data.coreVersion}
                      </span>
                    </>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  {demoJobId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-ph-navy hover:text-ph-navy"
                      onClick={() => navigate(`/job/${demoJobId}?results=1`)}
                    >
                      Skip to results →
                    </Button>
                  )}
                  <Button onClick={load} disabled={loading} size="sm">
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Load demo
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Reproduce-it-yourself: download the curated inputs + scripts, and point at the source repos. */}
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-neutral-700">Run it yourself</div>
            <p className="mt-0.5 text-xs text-neutral-500">
              Download the curated cohort CSVs and the build scripts, then reproduce this run locally.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild className="shrink-0">
            <a href={`${import.meta.env.BASE_URL}demo-cohorts.zip`} download>
              <Download className="mr-1.5 h-4 w-4" /> Curated cohorts + scripts (.zip)
            </a>
          </Button>
        </div>
        <p className="mt-2 text-xs text-neutral-400">
          Curated 200-variable subsets of public All of Us / CLSA / UK Biobank / MESA / AI-READI data. Each cohort's
          public source dictionary and the exact script that builds it are documented in the zip's README and in the{" "}
          <a href={PH.ddharmonProvenance} target="_blank" rel="noreferrer" className="text-ph-navy hover:underline">
            provenance table
          </a>
          {" · "}this app:{" "}
          <a href={PH.ddharmonUi} target="_blank" rel="noreferrer" className="text-ph-navy hover:underline">
            ddharmon-ui
          </a>
        </p>
      </div>

      {/* Data provenance — public source dictionaries + how the ~200-variable subset was curated. */}
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <div className="text-sm font-medium text-neutral-700">Where the demo data comes from</div>
        <p className="mt-0.5 text-xs text-neutral-500">
          Every demo cohort is built from a <span className="font-medium">public data dictionary</span> —
          metadata only (variable names, descriptions, value codings), never participant-level data. Each links
          to its public source and the script that reproduces our copy.
        </p>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {DEMO_SOURCES.map((s) => (
            <li key={s.name} className="text-xs text-neutral-500">
              <a
                href={s.href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-ph-navy hover:underline"
              >
                {s.name}
              </a>{" "}
              — {s.src} <span className="text-neutral-400">({s.script})</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-neutral-500">
          <span className="font-medium text-neutral-600">How the ~200 variables per cohort were chosen:</span>{" "}
          each cohort&apos;s full public dictionary is filtered to variables touching a shared set of common
          health &amp; demographic domains (sex, age, race, education, smoking, blood pressure, diabetes, …),
          grouped by domain and taken round-robin so the subset spans domains rather than piling into one
          section. If a cohort has fewer domain-matched variables than the ~200 cap, the rest is filled from its
          remaining variables so every cohort contributes the same count. It&apos;s a domain-stratified
          curation — deliberately not random, and not cherry-picked — so the cohorts genuinely overlap and the
          demo has real cross-cohort matches to find (see{" "}
          <a
            href={`${PH.ddharmonUi}/blob/main/scripts/build_demo_data.py`}
            target="_blank"
            rel="noreferrer"
            className="text-ph-navy hover:underline"
          >
            build_demo_data.py
          </a>
          ).
        </p>
      </div>
    </div>
  );
}
