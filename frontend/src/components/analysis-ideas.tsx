import { useState } from "react";
import { Lightbulb, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { generateAnalysisIdeas } from "@/lib/api";
import type { AnalysisIdea } from "@/types";

function IdeaCard({ idea }: { idea: AnalysisIdea }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start gap-2">
          <CardTitle className="text-sm">{idea.title}</CardTitle>
          {idea.category && (
            <Badge variant="neutral" className="ml-auto shrink-0 text-[10px]">
              {idea.category}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm">
        <p className="leading-relaxed text-neutral-600">{idea.hypothesis}</p>
        {idea.concepts.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {idea.concepts.map((c) => (
              <span key={c} className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-neutral-600">
                {c}
              </span>
            ))}
          </div>
        )}
        <dl className="space-y-1 text-xs text-neutral-500">
          {idea.cohorts.length > 0 && (
            <div className="flex gap-1.5">
              <dt className="font-medium text-neutral-500">Cohorts</dt>
              <dd className="text-neutral-600">{idea.cohorts.join(", ")}</dd>
            </div>
          )}
          {idea.method && (
            <div className="flex gap-1.5">
              <dt className="font-medium text-neutral-500">Method</dt>
              <dd className="text-neutral-600">{idea.method}</dd>
            </div>
          )}
        </dl>
        {idea.whyNewlyPossible && (
          <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs text-neutral-600">
            <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-ph-navy" />
            <span>
              <span className="font-medium text-neutral-700">Newly possible: </span>
              {idea.whyNewlyPossible}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Post-run "analysis ideas" — an opt-in LLM pass that suggests downstream cross-cohort analyses this run's
 * harmonization unlocks. Metadata-only (suggests, never runs). BYOK: needs the Anthropic key re-entered (a
 * transport-only header, never stored), so the button opens a small key dialog. Ideas are cached server-side
 * after the first pass, so a revisit shows them without re-billing.
 */
export function AnalysisIdeasPanel({ jobId, initial }: { jobId: string; initial: AnalysisIdea[] | null }) {
  const [ideas, setIdeas] = useState<AnalysisIdea[] | null>(initial ?? null);
  const [open, setOpen] = useState(false);
  const [regen, setRegen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(key: string, regenerate: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const { ideas: got } = await generateAnalysisIdeas(jobId, key, regenerate);
      setIdeas(got);
      setOpen(false);
      setApiKey("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not generate analysis ideas");
    } finally {
      setBusy(false);
    }
  }

  const openDialog = (regenerate: boolean) => {
    setRegen(regenerate);
    setErr(null);
    setOpen(true);
  };

  const hasIdeas = ideas !== null && ideas.length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4 text-ph-navy" /> Analysis ideas
          </CardTitle>
          {hasIdeas && (
            <Button variant="ghost" size="sm" className="ml-auto text-xs" disabled={busy} onClick={() => openDialog(true)}>
              Regenerate
            </Button>
          )}
        </div>
        <p className="text-sm text-neutral-500">
          What this cross-cohort harmonization unlocks — LLM-suggested analyses grounded in this run's own
          concepts. Hypotheses to explore, not validated findings; ddharmon reads only metadata and never
          runs them.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasIdeas ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {ideas!.map((idea, i) => (
              <IdeaCard key={`${idea.title}-${i}`} idea={idea} />
            ))}
          </div>
        ) : ideas !== null ? (
          <p className="text-sm text-neutral-500">
            No cross-cohort concepts in this run yet — analysis ideas need a concept shared by ≥2 cohorts.
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
            <p className="text-sm text-neutral-600">
              See concrete cross-cohort analyses this run makes possible.
            </p>
            <Button size="sm" disabled={busy} onClick={() => openDialog(false)}>
              <Sparkles className="mr-1.5 h-4 w-4" /> Generate analysis ideas
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate analysis ideas</DialogTitle>
            <DialogDescription>
              This runs one LLM pass over the run's harmonized concepts, so it needs your Anthropic API key.
              The key is sent for this request only — never written to disk, logs, or the saved run.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            placeholder="sk-ant-…"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim()) run(apiKey.trim(), regen);
            }}
          />
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => run(apiKey.trim(), regen)} disabled={busy || !apiKey.trim()}>
              {busy ? "Generating…" : "Generate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
