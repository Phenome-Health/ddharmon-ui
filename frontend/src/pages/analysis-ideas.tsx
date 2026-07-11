// Dedicated "analysis ideas" page — the ideas live here (not inline on the run view) so the dashboard stays
// uncluttered. Reached from the AnalysisIdeasPanel CTA: a demo run pre-loads pre-generated ideas; a real run
// generates them first (LLM pass) and then lands here. Each idea's concept chips deep-link into the review
// workbench, preselected to that concept.
import { useMemo } from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, Lightbulb, Loader2 } from "lucide-react";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { IdeaCard } from "@/components/analysis-ideas";

export default function AnalysisIdeasPage() {
  const { jobId = "" } = useParams();
  // Load the finished run immediately (no replay animation) — same as the workbench.
  const { jobState } = useHarmonizeStream(jobId, true, true);

  // Concept LABEL → record id, so an idea's concept chip can deep-link into the workbench (which preselects
  // a concept by ?c=<recordId>). First match wins. Computed before the early return to keep hook order stable.
  const records = jobState?.result?.records ?? [];
  const idByConcept = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of records) if (r.concept && !(r.concept in m)) m[r.concept] = r.id;
    return m;
  }, [records]);

  if (!jobState) {
    return (
      <div className="flex items-center gap-2 p-8 text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
      </div>
    );
  }

  const ideas = jobState.analysisIdeas ?? [];
  const isDemo = !!(jobState.config as { demo?: boolean }).demo;
  const linkForConcept = (concept: string) => {
    const id = idByConcept[concept];
    return id ? `/job/${jobId}/workbench?c=${encodeURIComponent(id)}` : undefined;
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/job/${jobId}`}
          className="mb-1 flex items-center gap-1 text-xs text-neutral-500 hover:text-ph-navy"
        >
          <ArrowLeft className="h-3 w-3" /> Back to run
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ph-ink">
          <Lightbulb className="h-5 w-5 text-ph-navy" /> Analysis ideas
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm text-neutral-500">
          What this cross-cohort harmonization unlocks — analyses grounded in this run's own concepts.
          Hypotheses to explore, not validated findings; ddharmon reads only metadata and never runs them.
          Click any concept to open it in the review workbench.
        </p>
        {isDemo && (
          <p className="mt-2 inline-block rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-500">
            Pre-generated for this demo. Run your own cohorts to get ideas grounded in your data.
          </p>
        )}
      </div>

      {ideas.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ideas.map((idea, i) => (
            <IdeaCard key={`${idea.title}-${i}`} idea={idea} linkForConcept={linkForConcept} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          No analysis ideas for this run.{" "}
          <Link href={`/job/${jobId}`} className="text-ph-navy underline hover:text-ph-ink">
            Back to the run
          </Link>
          .
        </p>
      )}
    </div>
  );
}
