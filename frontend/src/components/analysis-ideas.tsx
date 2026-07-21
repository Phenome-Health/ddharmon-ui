import { useState } from "react";
import { Link, useLocation } from "wouter";
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

/**
 * One analysis idea. When ``linkForConcept`` resolves a concept label to a href, that concept's chip
 * becomes a link (into the review workbench, preselected to the concept); otherwise it's a plain chip.
 */
export function IdeaCard({
  idea,
  linkForConcept,
}: {
  idea: AnalysisIdea;
  linkForConcept?: (concept: string) => string | undefined;
}) {
  const chip = "rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-neutral-600";
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
            {idea.concepts.map((c) => {
              const href = linkForConcept?.(c);
              return href ? (
                <Link
                  key={c}
                  href={href}
                  className={`${chip} transition-colors hover:border-ph-navy hover:text-ph-navy`}
                  title="Open this concept in the review workbench"
                >
                  {c}
                </Link>
              ) : (
                <span key={c} className={chip}>
                  {c}
                </span>
              );
            })}
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
 * Post-run "analysis ideas" entry point. The ideas themselves live on a dedicated page (/job/:id/analysis)
 * so they don't clutter the run view — this panel is just the CTA:
 *   - demo run → the page is pre-loaded with pre-generated ideas (no LLM, no key);
 *   - real run, not yet generated → "Generate" opens a key dialog, runs ONE LLM pass, then opens the page;
 *   - real run, already generated → "View" opens the page (ideas are cached server-side).
 * Metadata-only (suggests, never runs). BYOK: the key is a transport-only header, never stored.
 */
export function AnalysisIdeasPanel({
  jobId,
  initial,
  isDemo = false,
}: {
  jobId: string;
  initial: AnalysisIdea[] | null;
  isDemo?: boolean;
}) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [regen, setRegen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const page = `/job/${jobId}/analysis`;
  const alreadyHasIdeas = (initial?.length ?? 0) > 0;
  const noConcepts = initial !== null && initial.length === 0; // generated, but nothing cross-cohort to suggest

  async function run(key: string, regenerate: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const { ideas: got } = await generateAnalysisIdeas(jobId, key, regenerate);
      if (got.length) {
        setOpen(false);
        setApiKey("");
        navigate(page); // ideas are cached server-side — the page loads them
      } else {
        setErr("No cross-cohort concepts in this run — nothing to suggest.");
      }
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

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4 text-ph-navy" /> Analysis ideas
          </CardTitle>
          {alreadyHasIdeas && !isDemo && (
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
      <CardContent>
        {noConcepts ? (
          <p className="text-sm text-neutral-500">
            No cross-cohort concepts in this run — analysis ideas need a concept shared by ≥2 cohorts.
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
            <p className="text-sm text-neutral-600">See concrete cross-cohort analyses this run makes possible.</p>
            {isDemo || alreadyHasIdeas ? (
              <Button size="sm" asChild>
                <Link href={page}>
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  {/* This branch is reached only when ideas exist to VIEW: a preloaded demo carries baked ideas
                      (isDemo), or a real run already generated them (alreadyHasIdeas). The old `&& !isDemo`
                      wrongly showed "Generate" for a demo whose ideas are already present. */}
                  {alreadyHasIdeas ? "View analysis ideas" : "Generate analysis ideas"}
                </Link>
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => openDialog(false)}>
                <Sparkles className="mr-1.5 h-4 w-4" /> Generate analysis ideas
              </Button>
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate analysis ideas</DialogTitle>
            <DialogDescription>
              This runs one LLM pass over the run's harmonized concepts, so it needs your Anthropic API key.
              The key is sent for this request only — never written to disk, logs, or the saved run. Your
              ideas open on their own page when it's done.
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
