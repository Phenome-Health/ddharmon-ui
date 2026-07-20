// Shared chrome for the roadmap design previews (/preview/*): a back-link, a title with a "Preview · mockup"
// badge, an intro line, and the honesty banner. Every preview is a local/sample mockup — no run, no backend,
// no LLM — and says so up front. Page-specific content (and any "in the real feature…" footnote) is children.
import type { ReactNode } from "react";
import { Link } from "wouter";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function PreviewShell({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <Link href="/roadmap" className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-ph-navy">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to roadmap
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold text-ph-ink">
          {title}
          <Badge variant="outline" className="gap-1 border-warning/40 text-warning">
            <FlaskConical className="h-3.5 w-3.5" /> Preview · mockup
          </Badge>
        </h1>
        <p className="mt-1 text-sm text-neutral-500">{intro}</p>
      </div>
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-neutral-700">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>
          <span className="font-medium">This is a mockup, not a live tool.</span> Everything here runs in your
          browser on illustrative sample data — no run, no data upload, no LLM call. ddharmon itself is
          metadata-only; the real analysis would run outside it on your own data.
        </span>
      </div>
      {children}
    </div>
  );
}
