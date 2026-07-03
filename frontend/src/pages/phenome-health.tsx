import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PhenomeChip } from "@/components/phenome-mark";
import { PH } from "@/lib/links";

interface Tool {
  name: string;
  desc: string;
  href?: string;
  tag?: string;
}

const TOOLS: Tool[] = [
  {
    name: "ddharmon",
    desc: "This tool — cross-cohort data-dictionary harmonization to a Common Data Element backbone (adopt / refine / novel + transform specs).",
    href: PH.ddharmon,
    tag: "you are here",
  },
  {
    name: "ddharmon-ui",
    desc: "The web GUI for ddharmon (this app) — configure runs, review verdicts, and export the results.",
    href: PH.ddharmonUi,
  },
  {
    name: "biomapper",
    desc: "The identifier-layer toolkit — maps entities (proteins, metabolites, genes) to standard IDs. The substrate ddharmon's outputs link into.",
    href: PH.biomapper,
  },
  {
    name: "biomapper-ui",
    desc: "The web GUI for biomapper; the shared Phenome Health design system this app mirrors.",
    href: PH.biomapperUi,
  },
  {
    name: "KRAKEN",
    desc: "The knowledge-graph / linkage layer — where harmonized elements connect to the broader vocabulary and ontology graph.",
    href: PH.kraken,
  },
  {
    name: "EITL (expert-in-the-loop)",
    desc: "The campaign-based human-review web app. ddharmon exports its review queue into EITL campaigns for expert sign-off.",
    href: PH.eitl,
  },
];

export default function PhenomeHealthPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold text-ph-ink">
          <PhenomeChip className="h-8 w-8" />
          Phenome Health
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          The internal Phenome Health ecosystem ddharmon plugs into — mapping, knowledge-graph, and review tooling
          built alongside this app.{" "}
          <a href={PH.org} target="_blank" rel="noreferrer" className="text-ph-navy underline hover:text-ph-ink">
            phenomehealth.org
          </a>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tools &amp; platforms</CardTitle>
          <p className="text-xs text-neutral-400">How ddharmon fits with the rest of the Phenome Health stack</p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {TOOLS.map((t) => (
            <ToolCard key={t.name} tool={t} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ToolCard({ tool }: { tool: Tool }) {
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-neutral-700 group-hover:text-ph-navy">{tool.name}</span>
        {tool.href && <ExternalLink className="h-3 w-3 text-neutral-400 group-hover:text-ph-navy" />}
        {tool.tag && (
          <Badge variant="secondary" className="ml-auto font-normal">
            {tool.tag}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-neutral-600">{tool.desc}</p>
    </>
  );
  const cls = "group block rounded-md border border-neutral-200 p-3 transition-colors";
  return tool.href ? (
    <a href={tool.href} target="_blank" rel="noreferrer" className={`${cls} hover:border-ph-navy/40`}>
      {inner}
    </a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
