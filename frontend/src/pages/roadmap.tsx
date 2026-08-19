import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Circle, CircleDot, Eye, FlaskConical, Milestone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROADMAP, type RoadmapStatus } from "@/data/roadmap";

// Per-status presentation. Shipped = crossed off (a filled check); planned = an empty circle; in-progress
// sits between, with a badge so it isn't mistaken for either. Exploring = an open research direction (a
// flask), badged like in-progress so it reads as a live bet, not a committed plan.
const STATUS: Record<RoadmapStatus, { Icon: typeof Circle; cls: string; label: string }> = {
  shipped: { Icon: CheckCircle2, cls: "text-success", label: "Shipped" },
  "in-progress": { Icon: CircleDot, cls: "text-accent-on-raised", label: "In progress" },
  planned: { Icon: Circle, cls: "text-on-raised-muted", label: "Planned" },
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
        <h1 className="flex items-center gap-2 font-display text-xl font-semibold text-on-raised">
          <Milestone className="h-6 w-6 text-accent-on-raised" /> Roadmap
        </h1>
        <p className="mt-1 text-sm text-on-raised-muted">
          Where ddharmon is going — shipped features and what&apos;s next, crossed off as they land. An
          indicative direction, not dated commitments.
        </p>
      </div>

      {/* Legend + at-a-glance counts. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
          <span className="inline-flex items-center gap-1.5 text-on-raised">
            <CheckCircle2 className="h-4 w-4 text-success" /> Shipped
            <span className="tabular-nums text-on-raised-muted">· {shipped}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-on-raised">
            <CircleDot className="h-4 w-4 text-accent-on-raised" /> In progress
            <span className="tabular-nums text-on-raised-muted">· {inProgress}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-on-raised">
            <Circle className="h-4 w-4 text-on-raised-muted" /> Planned
            <span className="tabular-nums text-on-raised-muted">· {planned}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-on-raised">
            <FlaskConical className="h-4 w-4 text-warning" /> Exploring
            <span className="tabular-nums text-on-raised-muted">· {exploring}</span>
          </span>
        </CardContent>
      </Card>

      {ROADMAP.map((group) => (
        <Card key={group.theme}>
          <CardHeader>
            <CardTitle className="text-sm">{group.theme}</CardTitle>
            <p className="text-xs text-on-raised-muted">{group.blurb}</p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {group.items.map((item) => {
                const s = STATUS[item.status];
                return (
                  <li key={item.label} className="flex items-start gap-2.5 text-sm">
                    <s.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.cls}`} />
                    <span className="min-w-0">
                      <span className={item.status === "shipped" ? "text-on-raised-muted" : "text-on-raised"}>
                        {item.label}
                      </span>
                      {item.status === "in-progress" && (
                        <Badge variant="secondary" className="ml-2 align-middle text-xs">
                          In progress
                        </Badge>
                      )}
                      {item.status === "exploring" && (
                        <Badge variant="outline" className="ml-2 align-middle border-warning/40 text-xs text-warning">
                          Exploring
                        </Badge>
                      )}
                      {item.preview && (
                        <Link
                          href={item.preview}
                          className="ml-2 inline-flex items-center gap-1 rounded border border-rule-info px-1.5 py-0.5 align-middle text-xs font-semibold text-accent-on-raised hover:bg-surface-info"
                        >
                          <Eye className="h-3 w-3" /> Preview
                        </Link>
                      )}
                      {item.note && <span className="mt-0.5 block text-xs text-on-raised-muted">{item.note}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center justify-between rounded-lg border border-rule-on-raised bg-surface-inset px-4 py-3">
        <p className="text-sm text-on-raised">Want something on here? Open an issue or try a run.</p>
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
