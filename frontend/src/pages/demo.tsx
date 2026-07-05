import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listDemos, startDemo } from "@/lib/api";

export default function DemoPage() {
  const [, navigate] = useLocation();
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

  async function load() {
    if (!combo) return;
    setLoading(true);
    try {
      const { jobId } = await startDemo(combo.datasets);
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
                    <span className="text-xs text-neutral-400">{d.nFields} fields</span>
                    {d.description && <span className="text-xs text-neutral-400">{d.description}</span>}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-neutral-400">
                  {cohorts.length} cohorts · {totalFields} fields · live mapping to NIH CDEs
                </p>
                <Button onClick={load} disabled={loading} size="sm">
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Load demo
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
