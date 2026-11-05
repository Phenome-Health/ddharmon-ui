// The verdict-stacked bar chart and its tooltip, shared by every surface that stacks counts by verdict.
//
// EXTRACTED FROM `analytics.tsx` BY 08-16, unchanged, because Gate 2 takes ONE of that file's four views —
// the retrieval-score histogram — and importing `Analytics` to get it would drag the coverage table, the
// size-tier chart and the overlap heatmap onto a screen whose decision none of them serve. The alternative,
// re-implementing the bars beside it, is the duplication the inherited-UI audit exists to catch: the same
// rule that sent `source-rows.tsx` to Gate 1 as ONE grid rather than two.
//
// A PURE MOVE. Nothing here was rewritten while it was carried across — the axis `stroke`, the absolute
// tooltip contract and the recharts defaults are all as `analytics.tsx` had them, so the dashboard renders
// the same pixels it did before the extraction.
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_LABEL_SIZE,
  CHART_TOOLTIP_CLASS,
  VERDICT_COLOR,
  VERDICT_LABEL,
  VERDICTS,
  type Focus,
  type Verdict,
} from "@/lib/chart";

interface BarTipItem {
  dataKey?: string | number;
  value?: number;
  color?: string;
}

export function makeBarTooltip(formatLabel: (name: string) => string) {
  return function BarTooltip({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: BarTipItem[];
    label?: string | number;
  }) {
    if (!active || !payload?.length) return null;
    const rows = payload.filter((p) => (p.value ?? 0) > 0);
    if (!rows.length) return null;
    const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
    return (
      <div className={CHART_TOOLTIP_CLASS}>
        <div className="mb-1 font-semibold text-on-raised">{formatLabel(String(label))}</div>
        {rows.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-on-raised">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: p.color }} />
              {VERDICT_LABEL[String(p.dataKey)] ?? String(p.dataKey)}
            </span>
            <span className="tabular-nums text-on-raised">{p.value}</span>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-rule-quiet-on-raised pt-1 text-on-raised-muted">
          <span>Total</span>
          <span className="tabular-nums">{total}</span>
        </div>
      </div>
    );
  };
}

export function StackedVerdictBars({
  data,
  formatLabel,
  focus,
  onFocus,
  height = 224,
}: {
  data: Record<string, string | number>[];
  formatLabel: (name: string) => string;
  focus?: Focus;
  onFocus?: (f: Focus) => void;
  height?: number;
}) {
  const BarTooltip = useMemo(() => makeBarTooltip(formatLabel), [formatLabel]);
  const dimmed = (v: Verdict) => focus?.kind === "verdict" && focus.value !== v;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        {/* `stroke` as well as `tick.fill`: recharts defaults the axis LINE to a mid-grey of its
            own, which the token layer cannot reach — the rebrand drill found it as the one painted
            colour in the whole app that did not move when the brand was replaced. */}
        <XAxis dataKey="name" stroke={CHART_AXIS} tick={{ fontSize: CHART_LABEL_SIZE, fill: CHART_AXIS }} />
        <YAxis
          allowDecimals={false}
          stroke={CHART_AXIS}
          tick={{ fontSize: CHART_LABEL_SIZE, fill: CHART_AXIS }}
          width={28}
        />
        <RTooltip content={<BarTooltip />} cursor={{ fill: "var(--surface-inset)" }} />
        <Legend
          iconType="square"
          iconSize={9}
          onClick={onFocus ? (e: { value?: string }) => e.value && onFocus({ kind: "verdict", value: e.value }) : undefined}
          formatter={(v: string) => (
            <span className="cursor-pointer text-on-raised-muted" style={{ opacity: dimmed(v as Verdict) ? 0.4 : 1 }}>
              {VERDICT_LABEL[v] ?? v}
            </span>
          )}
          wrapperStyle={{ fontSize: CHART_LABEL_SIZE, cursor: onFocus ? "pointer" : "default" }}
        />
        {VERDICTS.map((v) => (
          <Bar
            key={v}
            dataKey={v}
            stackId="s"
            fill={VERDICT_COLOR[v]}
            fillOpacity={dimmed(v) ? 0.28 : 1}
            radius={v === "unclassified" ? [3, 3, 0, 0] : undefined}
            cursor={onFocus ? "pointer" : undefined}
            onClick={onFocus ? () => onFocus({ kind: "verdict", value: v }) : undefined}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
