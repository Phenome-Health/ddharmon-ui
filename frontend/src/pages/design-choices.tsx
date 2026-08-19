import { Link } from "wouter";
import { ArrowRight, ExternalLink, Lightbulb, ScaleIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PH } from "@/lib/links";
import { DESIGN_CHOICES, type DesignChoice } from "@/data/design-choices";
import { UnderReviewBanner } from "@/components/under-review-banner";

/** Inline external link, styled + with an icon (matches the Methods/Benchmarks/Guide `A`). */
function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-link-on-raised underline decoration-rule-info underline-offset-2 hover:decoration-link-on-raised"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function DecisionCard({ d }: { d: DesignChoice }) {
  const Icon = d.icon;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-start gap-2 text-sm">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent-on-raised" />
          <span>{d.title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* The rejected alternative — the "why not just…" the page exists to answer. */}
        <p className="text-on-raised">
          <span className="font-semibold text-on-raised-muted">Instead of</span> {d.rejected}.
        </p>
        <p className="leading-relaxed text-on-raised">{d.rationale}</p>

        {/* Evidence chip — only when a PUBLIC benchmark delta backs the decision. */}
        {d.evidence && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-muted px-3 py-2">
            <span className="text-xs text-on-raised">
              {d.evidence.metric}
              <Badge variant="neutral" className="ml-2 align-middle text-xs">
                {d.evidence.source}
              </Badge>
            </span>
            <span className="font-mono text-sm font-semibold text-on-raised">{d.evidence.value}</span>
          </div>
        )}

        <div className="flex items-start gap-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-on-raised-faint" />
          <span className="font-semibold text-on-raised">{d.takeaway}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DesignChoicesPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 font-display text-xl font-semibold text-on-raised">
          <Lightbulb className="h-6 w-6 text-accent-on-raised" /> Design choices
        </h1>
        <p className="mt-1 text-sm text-on-raised-muted">
          Why the pipeline is built the way it is. Each card states a non-obvious choice, the obvious
          alternative it rejected, and what the data said — the mirror image of the{" "}
          <Link href="/methods" className="text-link-on-raised underline hover:text-on-raised">
            Methods
          </Link>{" "}
          page (what the stages are) and the{" "}
          <Link href="/benchmarks" className="text-link-on-raised underline hover:text-on-raised">
            Benchmarks
          </Link>{" "}
          page (the scores).
        </p>
      </div>

      <UnderReviewBanner />

      {/* Reading frame — how to interpret the cards, before any of them. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScaleIcon className="h-4 w-4 text-accent-on-raised" /> Choices made because the data said so
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-relaxed text-on-raised">
          <p>
            None of these are default settings left unexamined. Each was settled by an A/B against{" "}
            <span className="font-semibold text-on-raised">external ground truth</span>, or is a
            structural choice with a stated rationale. Where a decision has a published delta, the card
            shows it and names the benchmark it was measured on.
          </p>
          <p className="text-xs text-on-raised-muted">
            Only <span className="font-semibold text-on-raised">mechanistically-justified</span> changes
            are adopted — never benchmark-chasing. Numbers are development-set figures where the benchmark
            is CDEMapper (read as optimistic); see the{" "}
            <Link href="/benchmarks" className="text-link-on-raised underline hover:text-on-raised">
              Benchmarks
            </Link>{" "}
            page for the dev/held-out framing.
          </p>
        </CardContent>
      </Card>

      {/* One card per decision — rendered from the manifest. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {DESIGN_CHOICES.map((d) => (
          <DecisionCard key={d.title} d={d} />
        ))}
      </div>

      {/* Grounding footnote — the numbers trace to the canonical, public methods doc. */}
      <p className="text-xs text-on-raised-muted">
        Every choice and number here is grounded in the canonical{" "}
        <A href={`${PH.ddharmon}/blob/main/docs/methods.md`}>ddharmon methods documentation</A> (the
        "Why assignment-first", "The pipeline", and "Evaluation" sections). Deltas are published results on
        named external benchmarks, not internal runs.
      </p>

      <div className="flex items-center justify-between rounded-lg border border-rule-on-raised bg-surface-inset px-4 py-3">
        <p className="text-sm text-on-raised">See these choices in action, or read the full method.</p>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/methods">Methods</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/demo">
              Open demo <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
