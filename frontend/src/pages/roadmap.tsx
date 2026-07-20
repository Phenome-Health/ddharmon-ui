import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Circle, CircleDot, FlaskConical, Milestone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROADMAP, type RoadmapStatus } from "@/data/roadmap";

// Per-status presentation. Shipped = crossed off (a filled check); planned = an empty circle; in-progress
// sits between, with a badge so it isn't mistaken for either. Exploring = an open research direction (a
// flask), badged like in-progress so it reads as a live bet, not a committed plan.
const STATUS: Record<RoadmapStatus, { Icon: typeof Circle; cls: string; label: string }> = {
  shipped: { Icon: CheckCircle2, cls: "text-success", label: "Shipped" },
  "in-progress": { Icon: CircleDot, cls: "text-ph-navy", label: "In progress" },
  planned: { Icon: Circle, cls: "text-neutral-300", label: "Planned" },
  exploring: { Icon: FlaskConical, cls: "text-warning", label: "Exploring" },
};

export default function RoadmapPage() {
  const all = ROADMAP.flatMap((g) => g.items);
  const shipped = all.filter((i) => i.status === "shipped").length;
  const inProgress = all.filter((i) => i.status === "in-progress").length;
  const planned = all.filter((i) => i.status === "planned").length;
  const exploring = all.filter((i) => i.status === "exploring").length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ph-ink">
          <Milestone className="h-6 w-6 text-ph-navy" /> Roadmap
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Where ddharmon is going — shipped features and what&apos;s next, crossed off as they land. An
          indicative direction, not dated commitments.
        </p>
      </div>

      {/* Legend + at-a-glance counts. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
          <span className="inline-flex items-center gap-1.5 text-neutral-600">
            <CheckCircle2 className="h-4 w-4 text-success" /> Shipped
            <span className="tabular-nums text-neutral-400">· {shipped}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-neutral-600">
            <CircleDot className="h-4 w-4 text-ph-navy" /> In progress
            <span className="tabular-nums text-neutral-400">· {inProgress}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-neutral-600">
            <Circle className="h-4 w-4 text-neutral-300" /> Planned
            <span className="tabular-nums text-neutral-400">· {planned}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-neutral-600">
            <FlaskConical className="h-4 w-4 text-warning" /> Exploring
            <span className="tabular-nums text-neutral-400">· {exploring}</span>
          </span>
        </CardContent>
      </Card>

      {ROADMAP.map((group) => (
        <Card key={group.theme}>
          <CardHeader>
            <CardTitle className="text-base">{group.theme}</CardTitle>
            <p className="text-xs text-neutral-400">{group.blurb}</p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {group.items.map((item) => {
                const s = STATUS[item.status];
                return (
                  <li key={item.label} className="flex items-start gap-2.5 text-sm">
                    <s.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.cls}`} />
                    <span className="min-w-0">
                      <span className={item.status === "shipped" ? "text-neutral-500" : "text-neutral-700"}>
                        {item.label}
                      </span>
                      {item.status === "in-progress" && (
                        <Badge variant="secondary" className="ml-2 align-middle text-[10px]">
                          In progress
                        </Badge>
                      )}
                      {item.status === "exploring" && (
                        <Badge variant="outline" className="ml-2 align-middle border-warning/40 text-[10px] text-warning">
                          Exploring
                        </Badge>
                      )}
                      {item.note && <span className="mt-0.5 block text-xs text-neutral-400">{item.note}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <p className="text-sm text-neutral-600">Want something on here? Open an issue or try a run.</p>
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
