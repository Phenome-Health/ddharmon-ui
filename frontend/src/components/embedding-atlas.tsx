// Embedding atlas — a 2D scatter of the field space (PCA projection from the backend). Shows cross-cohort
// mixing and cohort-isolated islands at a glance (Krishnamurthy/cde-atlas idiom; recharts, no WebGL).
//
// Instrument controls: color points by cohort OR by verdict; drag a box to zoom (reset to restore); click a
// point to open its concept in the review workbench. Respects the shared focus (dims non-matching points).
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Cell,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_TOOLTIP_CLASS,
  COHORT_PALETTE,
  VERDICT_COLOR,
  VERDICT_LABEL,
  VERDICTS,
  verdictColor,
  type Focus,
} from "@/lib/chart";
import type { AtlasPoint, UIRecord } from "@/types";

type ColorBy = "cohort" | "verdict";

interface EnrichedPoint extends AtlasPoint {
  verdict: string;
  recordId: string | null;
}

interface TooltipPayload {
  payload?: EnrichedPoint;
}
function AtlasTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  if (!p) return null;
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      <div className="font-mono text-neutral-700">{p.variable}</div>
      <div className="flex items-center gap-1.5 text-neutral-500">
        <span>{p.cohort}</span>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: verdictColor(p.verdict) }} />
        <span>{VERDICT_LABEL[p.verdict] ?? p.verdict}</span>
      </div>
      {p.recordId && <div className="mt-0.5 text-[10px] text-neutral-400">click to open concept</div>}
    </div>
  );
}

export function EmbeddingAtlas({
  points,
  records = [],
  focus = null,
  onFocus,
  onOpenConcept,
}: {
  points: AtlasPoint[];
  records?: UIRecord[];
  focus?: Focus;
  onFocus?: (f: Focus) => void;
  onOpenConcept?: (recordId: string) => void;
}) {
  const [colorBy, setColorBy] = useState<ColorBy>("cohort");
  const [zoom, setZoom] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Map each field (cohort:variable) to its record, for verdict color + click-through.
  const byMember = useMemo(() => {
    const m = new Map<string, UIRecord>();
    for (const r of records) for (const mem of r.members) m.set(mem, r);
    return m;
  }, [records]);

  const pts: EnrichedPoint[] = useMemo(() => {
    return points.map((p) => {
      const rec = byMember.get(`${p.cohort}:${p.variable}`);
      return { ...p, verdict: rec?.verdict ?? "unclassified", recordId: rec?.id ?? null };
    });
  }, [points, byMember]);

  const cohorts = useMemo(() => [...new Set(points.map((p) => p.cohort))].sort(), [points]);
  const cohortColor = useMemo(
    () => Object.fromEntries(cohorts.map((c, i) => [c, COHORT_PALETTE[i % COHORT_PALETTE.length]])),
    [cohorts],
  );
  const verdictsPresent = useMemo(() => VERDICTS.filter((v) => pts.some((p) => p.verdict === v)), [pts]);

  if (!points.length) {
    return <p className="py-8 text-center text-sm text-neutral-400">No embedding coordinates.</p>;
  }

  const colorOf = (p: EnrichedPoint) => (colorBy === "cohort" ? cohortColor[p.cohort] : verdictColor(p.verdict));
  const dimOf = (p: EnrichedPoint) =>
    !!focus && (focus.kind === "cohort" ? p.cohort !== focus.value : p.verdict !== focus.value);

  const legend: { label: string; color: string; focus: Focus }[] =
    colorBy === "cohort"
      ? cohorts.map((c) => ({ label: c, color: cohortColor[c], focus: { kind: "cohort", value: c } }))
      : verdictsPresent.map((v) => ({ label: VERDICT_LABEL[v], color: VERDICT_COLOR[v], focus: { kind: "verdict", value: v } }));

  // drag-to-zoom on the plot: mousedown starts a box, mouseup commits it as the axis domain.
  const endDrag = () => {
    if (drag && drag.x1 !== drag.x2 && drag.y1 !== drag.y2) {
      setZoom({
        x: [Math.min(drag.x1, drag.x2), Math.max(drag.x1, drag.x2)],
        y: [Math.min(drag.y1, drag.y2), Math.max(drag.y1, drag.y2)],
      });
    }
    setDrag(null);
  };

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between">
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-200 text-xs">
          {(["cohort", "verdict"] as ColorBy[]).map((c) => (
            <button
              key={c}
              onClick={() => setColorBy(c)}
              className={`px-2.5 py-1 capitalize ${colorBy === c ? "bg-ph-navy text-white" : "text-neutral-500 hover:bg-neutral-50"}`}
            >
              {c}
            </button>
          ))}
        </div>
        {zoom && (
          <button
            onClick={() => setZoom(null)}
            className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-ph-navy"
          >
            Reset zoom
          </button>
        )}
      </div>

      <ResponsiveContainer width="100%" height={360}>
        <ScatterChart
          margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          onMouseDown={(e) => {
            const s = e as unknown as { xValue?: number; yValue?: number };
            if (s?.xValue != null && s.yValue != null) setDrag({ x1: s.xValue, y1: s.yValue, x2: s.xValue, y2: s.yValue });
          }}
          onMouseMove={(e) => {
            const s = e as unknown as { xValue?: number; yValue?: number };
            if (drag && s?.xValue != null && s.yValue != null) setDrag({ ...drag, x2: s.xValue, y2: s.yValue });
          }}
          onMouseUp={endDrag}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
          <XAxis
            type="number"
            dataKey="x"
            name="PC1"
            tick={false}
            axisLine={false}
            allowDataOverflow
            domain={zoom ? zoom.x : ["auto", "auto"]}
            label={{ value: "PC1", position: "insideBottom", fontSize: 11, fill: CHART_AXIS }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="PC2"
            tick={false}
            axisLine={false}
            width={20}
            allowDataOverflow
            domain={zoom ? zoom.y : ["auto", "auto"]}
            label={{ value: "PC2", angle: -90, position: "insideLeft", fontSize: 11, fill: CHART_AXIS }}
          />
          <ZAxis range={[18, 18]} />
          <RTooltip content={<AtlasTooltip />} cursor={{ strokeDasharray: "3 3" }} />
          <Scatter
            data={pts}
            isAnimationActive={false}
            onClick={(e) => {
              const d = e as unknown as { recordId?: string; payload?: { recordId?: string } };
              const id = d?.recordId ?? d?.payload?.recordId;
              if (id && onOpenConcept) onOpenConcept(id);
            }}
            cursor={onOpenConcept ? "pointer" : undefined}
          >
            {pts.map((p, i) => (
              <Cell key={i} fill={colorOf(p)} fillOpacity={dimOf(p) ? 0.12 : 0.7} />
            ))}
          </Scatter>
          {drag && (
            <ReferenceArea
              x1={drag.x1}
              x2={drag.x2}
              y1={drag.y1}
              y2={drag.y2}
              strokeOpacity={0.3}
              stroke="var(--navy)"
              fill="var(--navy)"
              fillOpacity={0.08}
            />
          )}
        </ScatterChart>
      </ResponsiveContainer>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        {legend.map((l) => {
          const on = !focus || (l.focus && focus.kind === l.focus.kind && focus.value === l.focus.value);
          return (
            <button
              key={l.label}
              onClick={() => onFocus?.(l.focus)}
              className="flex items-center gap-1.5"
              style={{ opacity: on ? 1 : 0.4, cursor: onFocus ? "pointer" : "default" }}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} />
              {l.label}
            </button>
          );
        })}
        <span className="ml-auto text-neutral-400">drag to zoom · click a point to open its concept</span>
      </div>
    </div>
  );
}
