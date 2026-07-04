import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { listDemos, startDemo } from "@/lib/api";

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export default function DemoPage() {
  const [, navigate] = useLocation();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["demos"], queryFn: listDemos });

  const datasets = data?.datasets ?? [];
  const combos = useMemo(() => data?.combos ?? [], [data]);

  // Default-select the largest available combo once demos load.
  const defaulted = useMemo(() => {
    const avail = combos.filter((c) => c.available).sort((a, b) => b.datasets.length - a.datasets.length);
    return avail[0]?.datasets ?? [];
  }, [combos]);
  const effective = selected.length || !defaulted.length ? selected : defaulted;

  const match = combos.find((c) => sameSet(c.datasets, effective));
  const canLoad = !!match?.available && !loading;
  const anyAvailable = combos.some((c) => c.available);

  function toggle(id: string) {
    setSelected((prev) => {
      const base = prev.length ? prev : defaulted;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  }

  async function load() {
    setLoading(true);
    try {
      const { jobId } = await startDemo(effective);
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
          Load a ready-made cross-cohort harmonization over curated public cohorts — explore verdicts,
          transform specs, and the visualizations without uploading anything or spending API credits.
        </p>
      </div>

      <Card className="border-ph-navy/20 bg-ph-navy/[0.03]">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">Choose cohorts</CardTitle>
          <Badge variant="secondary" className="font-normal">no API credits</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading demos…
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                {datasets.map((d) => {
                  const on = effective.includes(d.id);
                  return (
                    <label
                      key={d.id}
                      className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition-colors ${
                        on ? "border-ph-navy/40 bg-neutral-0" : "border-neutral-200 bg-neutral-0/60 hover:border-neutral-300"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Checkbox checked={on} onCheckedChange={() => toggle(d.id)} />
                        <span className="font-medium text-neutral-700">{d.label}</span>
                      </span>
                      <span className="pl-6 text-xs text-neutral-400">{d.nFields} fields</span>
                      {d.description && <span className="pl-6 text-xs text-neutral-400">{d.description}</span>}
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-neutral-400">
                  {!anyAvailable
                    ? "Demo snapshot is being prepared — check back soon."
                    : match?.available
                      ? `Ready: ${match.label}`
                      : "This combination isn't precomputed yet — pick a highlighted set."}
                </p>
                <Button onClick={load} disabled={!canLoad} size="sm">
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
