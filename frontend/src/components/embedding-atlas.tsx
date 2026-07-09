// Embedding atlas — a 2D scatter of the field space (PCA projection from the backend). Shows cross-cohort
// mixing and cohort-isolated islands at a glance (Krishnamurthy/cde-atlas idiom; recharts, no WebGL).
//
// Instrument controls: color points by cohort OR by verdict; drag a box to zoom (reset to restore); click
// ANY point to open its full read-in detail (with a link to its concept). Respects the shared focus (dims
// non-matching points).
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
  sameFocus,
  VERDICT_LABEL,
  VERDICTS,
  verdictColor,
  type Focus,
} from "@/lib/chart";
import type { AtlasPoint, FieldDetail, UIRecord } from "@/types";

type ColorBy = "cohort" | "verdict" | "agreement";

// "agreement" coloring: does a point share its concept with its neighbors in the 2-D atlas? A ≤3-color
// palette (NOT a per-concept hue explosion) — the point is to stay legible at hundreds of concepts.
type Agreement = "agree" | "disagree" | "unassigned";
const K_NEIGHBORS = 10; // atlas is capped at 2500 pts server-side, so an O(n²) k-NN pass here is cheap.
const RESPONSE_CAP = 12; // max code=label options shown inline in the detail panel before "+N more".
const AGREEMENT_COLOR: Record<Agreement, string> = {
  agree: "#16A34A", // green — concept-mates cluster nearby (geometry respected)
  disagree: "#F59E0B", // amber — concept-mates are scattered elsewhere (a QA signal)
  unassigned: "#CBD5E1", // = UNASSIGNED_COLOR — no concept
};
const AGREEMENT_LABEL: Record<Agreement, string> = {
  agree: "Agree — concept shared with neighbors",
  disagree: "Disagree — concept-mates scattered",
  unassigned: "Unassigned (no concept)",
};

// A field that isn't a member of any concept record (an outlier the pipeline didn't group). Kept in the
// atlas as the "residual" of the field space, but it is NOT the "unclassified" VERDICT — conflating the two
// made these points show as a verdict the review queue has none of. Its own muted color + non-filterable
// legend entry keeps the distinction honest.
const UNASSIGNED = "unassigned";
const UNASSIGNED_COLOR = "#CBD5E1"; // slate-300 — clearly muted vs the verdict palette
const catLabel = (v: string): string => (v === UNASSIGNED ? "Unassigned (no concept)" : (VERDICT_LABEL[v] ?? v));
const catColor = (v: string): string => (v === UNASSIGNED ? UNASSIGNED_COLOR : verdictColor(v));

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
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: catColor(p.verdict) }} />
        <span>{catLabel(p.verdict)}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-neutral-400">click for details</div>
    </div>
  );
}

// One labeled line in the click-to-inspect panel — renders nothing when the source didn't provide the value.
function DetailRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="mt-0.5">
      <span className="text-neutral-400">{label}: </span>
      <span className="break-words text-neutral-600">{value}</span>
    </div>
  );
}

export function EmbeddingAtlas({
  points,
  records = [],
  fieldIndex = {},
  focus = null,
  onFocus,
  onOpenConcept,
}: {
  points: AtlasPoint[];
  records?: UIRecord[];
  // Full per-field read-in detail, keyed "cohort:variable" (uncapped). Drives the click-to-inspect panel.
  fieldIndex?: Record<string, FieldDetail>;
  focus?: Focus;
  onFocus?: (f: Focus) => void;
  onOpenConcept?: (recordId: string) => void;
}) {
  const [colorBy, setColorBy] = useState<ColorBy>("cohort");
  const [zoom, setZoom] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // The clicked point, held by its "cohort:variable" key (stable across the `pts` recompute). ANY point —
  // clustered or grey — opens the inline detail panel below the legend (we no longer auto-navigate).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // The concept whose members to emphasize on hover (dim the rest). null = grey point or nothing hovered.
  const [hoveredRecordId, setHoveredRecordId] = useState<string | null>(null);

  // Map each field (cohort:variable) to its record, for verdict color + click-through.
  const byMember = useMemo(() => {
    const m = new Map<string, UIRecord>();
    for (const r of records) for (const mem of r.members) m.set(mem, r);
    return m;
  }, [records]);

  const pts: EnrichedPoint[] = useMemo(() => {
    return points.map((p) => {
      const rec = byMember.get(`${p.cohort}:${p.variable}`);
      // A point with no matching record is an unGROUPED field, not the "unclassified" verdict.
      return { ...p, verdict: rec?.verdict ?? UNASSIGNED, recordId: rec?.id ?? null };
    });
  }, [points, byMember]);

  const cohorts = useMemo(() => [...new Set(points.map((p) => p.cohort))].sort(), [points]);
  const cohortColor = useMemo(
    () => Object.fromEntries(cohorts.map((c, i) => [c, COHORT_PALETTE[i % COHORT_PALETTE.length]])),
    [cohorts],
  );
  const categoriesPresent = useMemo(
    () => [...VERDICTS, UNASSIGNED].filter((v) => pts.some((p) => p.verdict === v)),
    [pts],
  );

  // Per-point agreement, indexed to `pts`. For each ASSIGNED point, look at its K nearest neighbors in the
  // shipped 2-D atlas (x, y) — the only per-point signal available client-side. A point "agrees" when a
  // majority of its reachable concept-mates land among those neighbors (i.e. embedding-near ⇒ same concept).
  // Singletons have no mates to be scattered from, so they agree by construction; unassigned stays grey.
  const agreement = useMemo<Agreement[]>(() => {
    const n = pts.length;
    const conceptSize = new Map<string, number>();
    for (const p of pts) if (p.recordId) conceptSize.set(p.recordId, (conceptSize.get(p.recordId) ?? 0) + 1);
    return pts.map((p, i) => {
      if (!p.recordId) return "unassigned";
      const mates = (conceptSize.get(p.recordId) ?? 1) - 1;
      if (mates === 0) return "agree"; // singleton concept — no mates that could sit far away
      const dists: { d: number; rid: string | null }[] = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = pts[j].x - p.x;
        const dy = pts[j].y - p.y;
        dists.push({ d: dx * dx + dy * dy, rid: pts[j].recordId });
      }
      dists.sort((a, b) => a.d - b.d);
      const kk = Math.min(K_NEIGHBORS, dists.length);
      let found = 0;
      for (let t = 0; t < kk; t++) if (dists[t].rid === p.recordId) found += 1;
      const reachable = Math.min(mates, kk); // how many mates could fit in the neighborhood
      return found * 2 >= reachable ? "agree" : "disagree";
    });
  }, [pts]);
  const agreementPresent = useMemo(() => {
    const s = new Set(agreement);
    return (["agree", "disagree", "unassigned"] as Agreement[]).filter((a) => s.has(a));
  }, [agreement]);

  // Resolve the clicked key back to its index in `pts` (so we can read its agreement + kNN breakdown).
  const keyToIdx = useMemo(() => {
    const m = new Map<string, number>();
    pts.forEach((p, i) => m.set(`${p.cohort}:${p.variable}`, i));
    return m;
  }, [pts]);
  const selectedIdx = selectedKey != null ? (keyToIdx.get(selectedKey) ?? null) : null;
  const selected = selectedIdx != null ? pts[selectedIdx] : null;
  const selectedRec = selectedKey != null ? (byMember.get(selectedKey) ?? null) : null;
  const selectedDetail = selectedKey != null ? (fieldIndex[selectedKey] ?? null) : null;
  // For a clicked ASSIGNED point: of its K nearest 2-D neighbors, how many share its concept vs sit in a
  // different one — the concrete geometry-vs-pipeline evidence surfaced in agreement mode.
  const selectedNeighbors = useMemo(() => {
    if (selectedIdx == null) return null;
    const p = pts[selectedIdx];
    if (!p.recordId) return null;
    const dists: { d: number; rid: string | null }[] = [];
    for (let j = 0; j < pts.length; j++) {
      if (j === selectedIdx) continue;
      const dx = pts[j].x - p.x;
      const dy = pts[j].y - p.y;
      dists.push({ d: dx * dx + dy * dy, rid: pts[j].recordId });
    }
    dists.sort((a, b) => a.d - b.d);
    const k = Math.min(K_NEIGHBORS, dists.length);
    let same = 0;
    for (let t = 0; t < k; t++) if (dists[t].rid === p.recordId) same += 1;
    return { k, same, diff: k - same };
  }, [selectedIdx, pts]);

  if (!points.length) {
    return <p className="py-8 text-center text-sm text-neutral-400">No embedding coordinates.</p>;
  }

  const colorOf = (p: EnrichedPoint, i: number) =>
    colorBy === "cohort"
      ? cohortColor[p.cohort]
      : colorBy === "verdict"
        ? catColor(p.verdict)
        : AGREEMENT_COLOR[agreement[i]];
  // Dim a point if it's outside the sticky focus OR (on hover) not a member of the hovered concept. Composing
  // both lets a viewer hover to make a concept's members pop as a tight blob without losing the focus filter.
  // An "unassigned" focus subsets to the grey (recordId == null) points — the mirror of a verdict focus.
  const dimOf = (p: EnrichedPoint) => {
    const outOfFocus =
      !!focus &&
      (focus.kind === "unassigned"
        ? p.recordId != null
        : focus.kind === "cohort"
          ? p.cohort !== focus.value
          : p.verdict !== focus.value);
    const outOfHover = hoveredRecordId != null && p.recordId !== hoveredRecordId;
    return outOfFocus || outOfHover;
  };

  const legend: { label: string; color: string; focus: Focus }[] =
    colorBy === "cohort"
      ? cohorts.map((c) => ({ label: c, color: cohortColor[c], focus: { kind: "cohort", value: c } }))
      : colorBy === "verdict"
        ? categoriesPresent.map((v) => ({
            label: catLabel(v),
            color: catColor(v),
            // "unassigned" isn't a verdict — it gets its own focus kind, which subsets to the grey no-concept points.
            focus: v === UNASSIGNED ? ({ kind: "unassigned" } as Focus) : { kind: "verdict", value: v },
          }))
        : // agreement mode: a 3-entry legend, not a per-concept palette. Not a Focus axis, so clicking clears focus.
          agreementPresent.map((a) => ({ label: AGREEMENT_LABEL[a], color: AGREEMENT_COLOR[a], focus: null as Focus }));

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
          {(["cohort", "verdict", "agreement"] as ColorBy[]).map((c) => (
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
              const d = e as unknown as EnrichedPoint & { payload?: EnrichedPoint };
              const pt = d?.payload ?? d;
              // Any point (clustered or grey) → open the inline detail panel below the legend. No auto-navigate;
              // the panel carries a "→ open concept" link when the point belongs to a concept.
              if (pt?.cohort != null && pt?.variable != null) setSelectedKey(`${pt.cohort}:${pt.variable}`);
            }}
            onMouseEnter={(e) => {
              const d = e as unknown as EnrichedPoint & { payload?: EnrichedPoint };
              const pt = d?.payload ?? d;
              setHoveredRecordId(pt?.recordId ?? null);
            }}
            onMouseLeave={() => setHoveredRecordId(null)}
            cursor="pointer"
          >
            {pts.map((p, i) => (
              <Cell key={i} fill={colorOf(p, i)} fillOpacity={dimOf(p) ? 0.12 : 0.7} />
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
          const on = !focus || sameFocus(focus, l.focus);
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
        <span className="ml-auto text-right text-neutral-400">
          {colorBy === "agreement" && "agreement = shares its concept with 2-D atlas neighbors · "}
          drag to zoom · click a point for details
        </span>
      </div>

      {colorBy === "agreement" && (
        <p className="mt-1.5 rounded-md border border-warning-border bg-warning-bg px-2.5 py-1.5 text-[11px] leading-relaxed text-neutral-700">
          <b className="text-warning">Reading this view:</b> the agree/disagree color is a{" "}
          <b>2-D geometry check only</b> — it asks whether a field&apos;s concept-mates fall among its {K_NEIGHBORS}{" "}
          nearest neighbors on this PCA plot. Concept assignment itself is <b>not</b> pure atlas proximity: the split
          stage also weighs the variable name, the field&apos;s response values/units, and an LLM concept judgment. So
          two dots that sit close here can still be assigned to different concepts — that&apos;s the pipeline using
          signals this flat 2-D view can&apos;t show. Click a dot for its concept, rationale, and values.
        </p>
      )}

      {selected && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-xs">
          <span
            className="mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: selectedIdx != null ? colorOf(selected, selectedIdx) : UNASSIGNED_COLOR }}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-neutral-700">{selected.variable}</div>
            <div className="text-neutral-500">{selected.cohort}</div>

            {/* Full read-in detail from fieldIndex["cohort:variable"] — missing keys drop out cleanly. */}
            <DetailRow label="Text" value={selectedDetail?.text} />
            <DetailRow label="Description" value={selectedDetail?.description} />
            <DetailRow label="Question" value={selectedDetail?.questionText} />
            <DetailRow label="Encoding" value={selectedDetail?.valueEncoding} />
            <DetailRow label="Units" value={selectedDetail?.units} />
            <DetailRow label="Type" value={selectedDetail?.dataType} />
            {selectedDetail?.responseOptions && selectedDetail.responseOptions.length > 0 && (
              <div className="mt-0.5">
                <span className="text-neutral-400">Responses: </span>
                <span className="text-neutral-600">
                  {selectedDetail.responseOptions.slice(0, RESPONSE_CAP).map((o, i) => (
                    <span key={i}>
                      {i > 0 && <span className="text-neutral-300"> · </span>}
                      <span className="font-mono text-neutral-500">{o.code}</span>
                      {"="}
                      {o.label}
                    </span>
                  ))}
                  {selectedDetail.responseOptions.length > RESPONSE_CAP && (
                    <span className="text-neutral-400">
                      {" · "}+{selectedDetail.responseOptions.length - RESPONSE_CAP} more
                    </span>
                  )}
                </span>
              </div>
            )}

            {/* Concept group + "→ open concept" link when clustered; else the unclustered reason. */}
            {selectedRec ? (
              <div className="mt-1.5 border-t border-neutral-200 pt-1.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: catColor(selectedRec.verdict) }}
                  />
                  <span className="min-w-0 truncate text-neutral-600">{selectedRec.concept}</span>
                  <span className="shrink-0 text-neutral-400">· {catLabel(selectedRec.verdict)}</span>
                </div>
                {onOpenConcept && (
                  <button
                    onClick={() => onOpenConcept(selectedRec.id)}
                    className="mt-1 font-medium text-ph-navy hover:underline"
                  >
                    → open concept
                  </button>
                )}
              </div>
            ) : (
              <div className="mt-1 text-neutral-400">
                {catLabel(UNASSIGNED)} — this field didn&apos;t cluster into any concept.
              </div>
            )}

            {/* Agreement-mode evidence: WHY an atlas-near point can land in a different concept — the pipeline's
                non-geometric signals (concept + rationale + values) plus the point's own kNN neighbor split. */}
            {colorBy === "agreement" && selectedIdx != null && (
              <div className="mt-1.5 border-t border-neutral-200 pt-1.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: AGREEMENT_COLOR[agreement[selectedIdx]] }}
                  />
                  <span className="text-neutral-600">{AGREEMENT_LABEL[agreement[selectedIdx]]}</span>
                </div>
                {selectedRec && agreement[selectedIdx] === "disagree" && selectedNeighbors && (
                  <div className="mt-1 text-neutral-500">
                    {selectedNeighbors.diff} of its {selectedNeighbors.k} nearest atlas neighbors sit in a different
                    concept. Geometry alone would group these, but the pipeline separated them using signals this 2-D
                    view can&apos;t show — the variable name, its response values/units, and an LLM concept judgment.
                  </div>
                )}
                {selectedRec?.rationale && (
                  <div className="mt-1 text-neutral-500">
                    <span className="text-neutral-400">Assign rationale: </span>
                    {selectedRec.rationale}
                  </div>
                )}
                {!selectedRec && (
                  <div className="mt-1 text-neutral-400">The agreement check applies only to assigned fields.</div>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setSelectedKey(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded px-1 leading-none text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
