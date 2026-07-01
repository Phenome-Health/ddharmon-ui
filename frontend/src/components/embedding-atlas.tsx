// Embedding atlas — a cohort-colored 2D scatter of the field space (PCA projection from the backend).
// Shows cross-cohort mixing and cohort-isolated islands at a glance. Krishnamurthy/cde-atlas idiom, built
// from the UIResult `atlas` points (recharts ScatterChart; no new dependency, no WebGL).
import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { AtlasPoint } from "@/types";

const PALETTE = ["#113682", "#3AC2CB", "#E21C52", "#005B33", "#B45309", "#7C3AED", "#0EA5E9", "#8892A3"];

interface TooltipPayload {
  payload?: AtlasPoint;
}
function AtlasTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  if (!p) return null;
  return (
    <div className="rounded border border-neutral-200 bg-white px-2 py-1 text-xs shadow-sm">
      <div className="font-mono text-neutral-700">{p.variable}</div>
      <div className="text-neutral-500">{p.cohort}</div>
    </div>
  );
}

export function EmbeddingAtlas({ points }: { points: AtlasPoint[] }) {
  const byCohort = useMemo(() => {
    const m = new Map<string, AtlasPoint[]>();
    for (const p of points) {
      const arr = m.get(p.cohort) ?? [];
      arr.push(p);
      m.set(p.cohort, arr);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [points]);

  if (!points.length) {
    return <p className="py-8 text-center text-sm text-neutral-400">No embedding coordinates.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={380}>
      <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E3E7EE" />
        <XAxis type="number" dataKey="x" name="PC1" tick={false} axisLine={false} label={{ value: "PC1", position: "insideBottom", fontSize: 11, fill: "#8892A3" }} />
        <YAxis type="number" dataKey="y" name="PC2" tick={false} axisLine={false} width={20} label={{ value: "PC2", angle: -90, position: "insideLeft", fontSize: 11, fill: "#8892A3" }} />
        <ZAxis range={[16, 16]} />
        <RTooltip content={<AtlasTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {byCohort.map(([cohort, data], i) => (
          <Scatter key={cohort} name={cohort} data={data} fill={PALETTE[i % PALETTE.length]} fillOpacity={0.65} />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}
