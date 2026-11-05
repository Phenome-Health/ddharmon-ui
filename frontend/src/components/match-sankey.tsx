// Match-journey Sankey: Cohort -> Verdict -> Destination, link width = variable (member) count.
// Borrows the ItemComplex "Cohort -> Cluster -> CDE-anchor" Sankey vocabulary (todos 2026-04-30 /
// 2026-05-10) but is built entirely from the stable UIRecord contract -- no backend dependency. It's the
// single chart that makes the assign-to-backbone story legible: what adopts/refines onto an existing CDE,
// what routes novel to GenCDE, and where things stay unresolved.
//
// Interactivity: hovering a node or a flow emphasizes the connected paths and dims the rest, and a branded
// tooltip reads out the exact counts (share of total). All hover state is local; colors come from lib/chart.
import { useMemo, useState } from "react";
import { ResponsiveContainer, Sankey, Tooltip } from "recharts";
import { CHART_LABEL_SIZE, CHART_TOOLTIP_CLASS, VERDICT_COLOR, type Focus } from "@/lib/chart";
import {
  DEST_NAMES,
  NOT_MAPPED,
  UNCLUSTERED,
  VERDICT_NAMES,
  VERDICT_NODE,
  buildSankeyData,
  type SankeyLinkDatum,
  type SankeyNodeDatum,
} from "@/lib/sankey";
import type { UIRecord } from "@/types";

// The data half moved to `lib/sankey.ts` (final review round 2) so Gate 4 shares it and a spec can assert it.
export { buildSankeyData } from "@/lib/sankey";

// -- hover model --
type Hover = { kind: "node"; index: number } | { kind: "link"; li: number } | null;
type Tip = { title: string; sub: string; x: number; y: number; anchor: "right" | "left" | "above" } | null;

function computeActive(hover: Hover, links: SankeyLinkDatum[]) {
  if (!hover) return null;
  const activeLinks = new Set<number>();
  const activeNodes = new Set<number>();
  if (hover.kind === "node") {
    activeNodes.add(hover.index);
    links.forEach((l, li) => {
      if (l.source === hover.index || l.target === hover.index) {
        activeLinks.add(li);
        activeNodes.add(l.source);
        activeNodes.add(l.target);
      }
    });
  } else {
    activeLinks.add(hover.li);
    const l = links[hover.li];
    if (l) {
      activeNodes.add(l.source);
      activeNodes.add(l.target);
    }
  }
  return { activeLinks, activeNodes };
}

type ShapeState = "base" | "on" | "off";

interface NodeShapeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: SankeyNodeDatum & { depth: number };
  state: ShapeState;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}

function NodeShape({ x, y, width, height, payload, state, onEnter, onLeave, onClick }: NodeShapeProps) {
  const depth = payload.depth ?? 0;
  const cy = y + height / 2;
  let tx = x + width + 6;
  let anchor: "start" | "middle" | "end" = "start";
  let ty = cy;
  if (depth === 0) {
    tx = x - 6;
    anchor = "end";
  } else if (depth === 1) {
    tx = x + width / 2;
    anchor = "middle";
    ty = y - 5;
  }
  const dim = state === "off";
  return (
    <g style={{ cursor: "pointer" }} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={onClick}>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={2}
        fill={payload.color}
        fillOpacity={dim ? 0.25 : state === "on" ? 1 : 0.9}
      />
      <text
        x={tx}
        y={ty}
        textAnchor={anchor}
        dominantBaseline="middle"
        fontSize={CHART_LABEL_SIZE}
        fill="var(--on-raised)"
        fillOpacity={dim ? 0.35 : 1}
        style={{ fontWeight: state === "on" ? 600 : 400 }}
      >
        {payload.name}
      </text>
    </g>
  );
}

interface LinkShapeProps {
  sourceX: number;
  sourceY: number;
  sourceControlX: number;
  targetX: number;
  targetY: number;
  targetControlX: number;
  linkWidth: number;
  payload: SankeyLinkDatum;
  state: ShapeState;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}

function LinkShape({
  sourceX,
  sourceY,
  sourceControlX,
  targetX,
  targetY,
  targetControlX,
  linkWidth,
  payload,
  state,
  onEnter,
  onLeave,
  onClick,
}: LinkShapeProps) {
  const opacity = state === "off" ? 0.06 : state === "on" ? 0.62 : 0.38;
  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={payload.color ?? "var(--on-raised-muted)"}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={opacity}
      style={{ cursor: "pointer", transition: "stroke-opacity 120ms" }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
    />
  );
}

const LEGEND = [
  { label: "Adopt", color: VERDICT_COLOR.adopt },
  { label: "Refine", color: VERDICT_COLOR.refine },
  { label: "Novel", color: VERDICT_COLOR.novel },
  { label: "Unclassified", color: VERDICT_COLOR.unclassified },
];

export function MatchSankey({
  records,
  cohortTotals,
  focus = null,
  onFocus,
}: {
  records: UIRecord[];
  cohortTotals?: Record<string, number>;
  focus?: Focus;
  onFocus?: (f: Focus) => void;
}) {
  const data = useMemo(() => buildSankeyData(records, cohortTotals), [records, cohortTotals]);
  const [hover, setHover] = useState<Hover>(null);
  const [tip, setTip] = useState<Tip>(null);

  const { nodeTotals, total, nodeNames } = useMemo(() => {
    const names = data.nodes.map((n) => n.name);
    const inSum = new Array(data.nodes.length).fill(0);
    const outSum = new Array(data.nodes.length).fill(0);
    for (const l of data.links) {
      outSum[l.source] += l.value;
      inSum[l.target] += l.value;
    }
    const totals = data.nodes.map((_, i) => Math.max(inSum[i], outSum[i]));
    const t = data.links.filter((l) => l.source < data.nCohorts).reduce((s, l) => s + l.value, 0) || 1;
    return { nodeTotals: totals, total: t, nodeNames: names };
  }, [data]);

  // Sticky emphasis from the shared focus, expressed as a node highlight; a live hover overrides it.
  const focusHover: Hover = useMemo(() => {
    if (!focus) return null;
    // "unassigned" focus emphasizes the Unclustered node (and its connected flows).
    const name =
      focus.kind === "unassigned" ? UNCLUSTERED : focus.kind === "verdict" ? VERDICT_NODE[focus.value] : focus.value;
    const i = data.nodes.findIndex((n) => n.name === name);
    return i >= 0 ? { kind: "node", index: i } : null;
  }, [focus, data.nodes]);
  const active = useMemo(() => computeActive(hover ?? focusHover, data.links), [hover, focusHover, data.links]);

  const clear = () => {
    setHover(null);
    setTip(null);
  };
  const nodeState = (i: number): ShapeState => (!active ? "base" : active.activeNodes.has(i) ? "on" : "off");
  const linkState = (li: number): ShapeState => (!active ? "base" : active.activeLinks.has(li) ? "on" : "off");

  // Map a node / flow to the focus it represents. The Unclustered / Not-mapped reconciliation bucket ->
  // "unassigned" focus (so the review queue browses result.unassignedFields); cohort nodes -> cohort focus;
  // verdict nodes (and any flow, via its verdict endpoint) -> verdict focus. Checked FIRST because
  // VERDICT_NAMES also contains "Unclustered".
  const focusForNode = (name: string): Focus => {
    if (name === UNCLUSTERED || name === NOT_MAPPED) return { kind: "unassigned" };
    if (VERDICT_NAMES.has(name)) return { kind: "verdict", value: name.toLowerCase() };
    if (DEST_NAMES.has(name)) return null;
    return { kind: "cohort", value: name };
  };
  const focusForLink = (l: SankeyLinkDatum): Focus => {
    const s = nodeNames[l.source];
    const t = nodeNames[l.target];
    if (s === UNCLUSTERED || t === UNCLUSTERED || t === NOT_MAPPED) return { kind: "unassigned" };
    const vName = VERDICT_NAMES.has(s) ? s : VERDICT_NAMES.has(t) ? t : null;
    return vName ? { kind: "verdict", value: vName.toLowerCase() } : null;
  };
  const emitFocus = (f: Focus) => {
    if (f && onFocus) onFocus(f);
  };

  if (!data.links.length) {
    return <p className="py-8 text-center text-sm text-on-raised-muted">No flows to display.</p>;
  }
  const height = Math.max(280, data.nodes.length * 30);
  // recharts mutates the data it receives (resolves link source/target indices into node objects and writes
  // x/y/depth onto nodes). Hand it a throwaway clone each render so our canonical `data` -- which the hover
  // math reads by index -- stays pristine.
  const chartData = {
    nodes: data.nodes.map((n) => ({ ...n })),
    links: data.links.map((l) => ({ ...l })),
  };

  return (
    <div>
      <div className="relative" onMouseLeave={clear}>
        <ResponsiveContainer width="100%" height={height}>
          <Sankey
            data={chartData}
            nodePadding={26}
            nodeWidth={14}
            linkCurvature={0.5}
            iterations={64}
            margin={{ left: 90, right: 110, top: 12, bottom: 12 }}
            node={(props: unknown) => {
              const p = props as NodeShapeProps;
              const i = nodeNames.indexOf(p.payload.name);
              const depth = p.payload.depth ?? 0;
              const anchor = depth === 0 ? "right" : depth === 2 ? "left" : "above";
              const x = depth === 0 ? p.x + p.width + 8 : depth === 2 ? p.x - 8 : p.x + p.width / 2;
              const y = depth === 1 ? p.y - 8 : p.y + p.height / 2;
              return (
                <NodeShape
                  {...p}
                  state={nodeState(i)}
                  onEnter={() => {
                    setHover({ kind: "node", index: i });
                    setTip({ title: p.payload.name, sub: `${nodeTotals[i]} variables`, x, y, anchor });
                  }}
                  onLeave={clear}
                  onClick={() => emitFocus(focusForNode(p.payload.name))}
                />
              );
            }}
            link={(props: unknown) => {
              const p = props as LinkShapeProps;
              const li = p.payload.li;
              const mx = (p.sourceX + p.targetX) / 2;
              const my = (p.sourceY + p.targetY) / 2;
              const pct = Math.round((p.payload.value / total) * 100);
              return (
                <LinkShape
                  {...p}
                  state={linkState(li)}
                  onEnter={() => {
                    setHover({ kind: "link", li });
                    setTip({
                      title: `${nodeNames[p.payload.source]} → ${nodeNames[p.payload.target]}`,
                      sub: `${p.payload.value} variables · ${pct}%`,
                      x: mx,
                      y: my,
                      anchor: "above",
                    });
                  }}
                  onLeave={clear}
                  onClick={() => emitFocus(focusForLink(p.payload))}
                />
              );
            }}
          >
            {/* Our tooltip is the absolutely-positioned div below; suppress recharts' own rendered content. */}
            <Tooltip content={() => null} />
          </Sankey>
        </ResponsiveContainer>
        {tip && (
          <div
            className={CHART_TOOLTIP_CLASS + " absolute z-10 whitespace-nowrap"}
            style={{
              left: tip.x,
              top: tip.y,
              transform:
                tip.anchor === "right"
                  ? "translate(0, -50%)"
                  : tip.anchor === "left"
                    ? "translate(-100%, -50%)"
                    : "translate(-50%, -100%)",
            }}
          >
            <div className="font-semibold text-on-raised">{tip.title}</div>
            <div className="tabular-nums text-on-raised-muted">{tip.sub}</div>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-raised-muted">
        <span className="text-on-raised-muted">Cohort &rarr; verdict &rarr; destination &middot; width = variable count</span>
        {LEGEND.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
