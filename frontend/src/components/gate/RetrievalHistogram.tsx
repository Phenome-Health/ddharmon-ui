import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlotInfo } from "@/components/plot-info";
import { StackedVerdictBars } from "@/components/stacked-verdict-bars";
import { isVerdict, type Focus, type Verdict } from "@/lib/chart";
import type { UIRecord } from "@/types";

/**
 * Where the retrieval floor is cutting, as a distribution.
 *
 * THE ONE ANALYTICS VIEW GATE 2 TAKES, and the reason is the decision this screen makes. The inherited-UI
 * audit's verdict on `analytics.tsx` was SPLIT: the coverage table, the size-tier chart and the cross-cohort
 * overlap heatmap all describe the run as a whole and belong on the results screen, but this one answers the
 * question a reviewer is actually holding at Gate 2 — *is the boundary between "a catalogue element fits"
 * and "generate one" falling in a sensible place, or is the floor eating matches?* A reviewer who can see
 * adopts clustering high and novels clustering low can tell whether a particular concept's low score is
 * unusual or typical, which is the context that makes one re-pick decision better than a guess.
 *
 * IT IS CONTEXT, NOT A CONTROL. Nothing here is clickable-to-decide; the histogram informs the pick made in
 * the cards above it and never substitutes for one.
 */

function vkey(r: UIRecord): Verdict {
  return isVerdict(r.verdict) ? r.verdict : "unclassified";
}

/** Ten bins over the top-1 cosine, stacked by verdict. Empty when no record carries a score at all. */
export function scoreHistogram(records: UIRecord[]): Record<string, string | number>[] {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    name: `${(i / 10).toFixed(1)}`,
    adopt: 0,
    refine: 0,
    novel: 0,
    unclassified: 0,
  }));
  let any = false;
  for (const r of records) {
    const c = r.cosines?.top1;
    if (c == null) continue;
    any = true;
    const b = Math.min(9, Math.max(0, Math.floor(c * 10)));
    bins[b][vkey(r)] += 1;
  }
  return any ? bins : [];
}

export const binLabel = (b: string): string => {
  const lo = Number(b);
  return `cosine ${lo.toFixed(1)}–${(lo + 0.1).toFixed(1)}`;
};

export function RetrievalHistogram({
  records,
  focus,
  onFocus,
}: {
  records: UIRecord[];
  focus?: Focus;
  onFocus?: (f: Focus) => void;
}) {
  const hist = useMemo(() => scoreHistogram(records), [records]);
  return (
    <Card data-testid="retrieval-histogram">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <CardTitle className="text-sm">Retrieval score distribution</CardTitle>
        <PlotInfo>
          Distribution of each concept&apos;s cosine similarity to its nearest CDE (binned), stacked by verdict.
          Adopts cluster at high similarity, novels at low — a quick read on match quality and where the
          adopt/novel boundary falls. Click a bar to focus that verdict.
        </PlotInfo>
      </CardHeader>
      <CardContent>
        {hist.length ? (
          <StackedVerdictBars data={hist} formatLabel={binLabel} focus={focus} onFocus={onFocus} />
        ) : (
          // Not an empty chart: a run whose records carry no score is a different thing from a run whose
          // scores all landed in one bin, and an axis with nothing on it reads as the second.
          <p className="py-8 text-center text-sm text-on-raised-muted">No retrieval scores.</p>
        )}
        <p className="mt-1 text-xs text-on-raised-muted">
          nearest-CDE cosine (binned) · adopts cluster high, novels low
        </p>
      </CardContent>
    </Card>
  );
}
