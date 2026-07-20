// An Excel/sheets-style grid of the RAW data-dictionary rows behind a concept group — one row per pooled
// variable, columns = the fields as they were ingested. This is the evidence layer under every derived claim
// in the workbench (summary, GenCDE, value mapping): a reviewer can verify those against the ground-truth
// metadata without leaving the app, and an over-merge (is this really 25 BP vars, or BP+pulse mislumped?)
// becomes obvious at a glance.
//
// Reads the already-persisted contract only — `record.members` ("cohort:var" keys) into `fieldIndex` — so it
// slots into EXISTING runs with no re-run or migration. For a run that predates `fieldIndex` it degrades to
// `memberDetails` (name + embedded text), then to the raw id: fewer columns, never a crash.
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FieldDetail, UIRecord } from "@/types";

// Bound a pathological over-merge so the grid stays a bounded widget, never a page-blowing dump. The
// scroll region already caps height; this caps the DOM row count. Overflow is surfaced with a footer note.
const ROW_CAP = 100;

// A variable name the loader synthesized (no usable id column in the source) — not worth showing raw.
const isSyntheticName = (n: string): boolean => /^_ROW_\d+$/.test(n);

interface SourceRow {
  id: string; // "cohort:var"
  cohort: string;
  name: string;
  synthetic: boolean;
  text: string; // the cleaned signal actually embedded (may differ from the raw description/question)
  description?: string;
  questionText?: string;
  valueEncoding?: string;
  units?: string;
  dataType?: string;
}

// The coded response options, as a compact "code=label | code=label" string. Prefers the parsed
// responseOptions; falls back to the inline valueEncoding string the source carried.
function encodingText(fd: FieldDetail | undefined): string | undefined {
  if (!fd) return undefined;
  if (fd.responseOptions?.length) {
    return fd.responseOptions.map((o) => (o.label ? `${o.code}=${o.label}` : o.code)).join(" | ");
  }
  return fd.valueEncoding || undefined;
}

function buildRows(record: UIRecord, fieldIndex: Record<string, FieldDetail>): SourceRow[] {
  // `members` is the canonical, ordered member list; fall back to memberDetails ids for older shapes.
  const ids = record.members?.length ? record.members : (record.memberDetails ?? []).map((m) => m.id);
  const byId = new Map((record.memberDetails ?? []).map((m) => [m.id, m]));
  return ids.map((id) => {
    const fd = fieldIndex[id];
    const md = byId.get(id);
    const i = id.indexOf(":");
    const cohort = md?.cohort ?? (i > 0 ? id.slice(0, i) : "");
    const name = fd?.name ?? md?.name ?? (i > 0 ? id.slice(i + 1) : id);
    const text = fd?.text ?? md?.text ?? name;
    return {
      id,
      cohort,
      name,
      synthetic: isSyntheticName(name),
      text,
      description: fd?.description,
      questionText: fd?.questionText,
      valueEncoding: encodingText(fd),
      units: fd?.units,
      dataType: fd?.dataType,
    };
  });
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-neutral-200 px-2.5 py-1.5 text-left align-bottom font-medium uppercase tracking-wide text-neutral-500",
        className,
      )}
    >
      {children}
    </th>
  );
}

// A wrapping text cell with a bounded width and a native tooltip for the full value. Empty → muted dash.
function TextCell({ value, className }: { value?: string; className?: string }) {
  if (!value) return <td className="px-2.5 py-1.5 align-top text-neutral-300">—</td>;
  return (
    <td className={cn("px-2.5 py-1.5 align-top text-neutral-700", className)} title={value}>
      <span className="block min-w-[12rem] max-w-[24rem] whitespace-pre-wrap break-words">{value}</span>
    </td>
  );
}

/** The raw source-dictionary rows behind a concept group, as a bounded, horizontally-scrollable grid.
 *  Optional columns render only when at least one member carries that field, so older/sparse runs stay clean. */
export function SourceRows({
  record,
  fieldIndex,
}: {
  record: UIRecord;
  fieldIndex: Record<string, FieldDetail>;
}) {
  const rows = buildRows(record, fieldIndex);
  if (!rows.length) return null;

  const shown = rows.slice(0, ROW_CAP);
  const extra = rows.length - shown.length;
  const has = (pred: (r: SourceRow) => boolean) => rows.some(pred);

  // Optional columns: show a column only when some member actually carries it (keeps pre-fieldIndex and
  // sparse-dictionary runs from rendering a wall of empty cells).
  const showDesc = has((r) => !!r.description);
  const showQ = has((r) => !!r.questionText);
  const showEnc = has((r) => !!r.valueEncoding);
  const showUnits = has((r) => !!r.units);
  const showType = has((r) => !!r.dataType);
  // The embedded signal is worth its own column only where it DIFFERS from the raw description/question —
  // i.e. the pipeline cleaned it or fell back to another field. That difference is the debugging signal.
  const showEmbedded = has((r) => !!r.text && r.text !== r.description && r.text !== r.questionText);

  return (
    <div className="space-y-1.5">
      <div className="max-h-[28rem] overflow-auto rounded-md border border-neutral-200">
        <table className="w-full border-collapse text-xs">
          {/* sticky on the <thead> section (with border-collapse) is the combination that actually pins in
              Chromium/Firefox/Safari 16+; sticky on <th> cells silently fails under border-collapse. */}
          <thead className="sticky top-0 z-10 bg-neutral-50">
            <tr>
              <Th className="whitespace-nowrap">Cohort</Th>
              <Th className="whitespace-nowrap">Variable</Th>
              {showDesc && <Th>Description</Th>}
              {showQ && <Th>Question</Th>}
              {showEnc && <Th>Value encoding</Th>}
              {showUnits && <Th className="whitespace-nowrap">Units</Th>}
              {showType && <Th className="whitespace-nowrap">Type</Th>}
              {showEmbedded && <Th>Embedded text</Th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
                <td className="px-2.5 py-1.5 align-top">
                  <Badge variant="neutral" className="font-normal">
                    {r.cohort || "—"}
                  </Badge>
                </td>
                <td className="px-2.5 py-1.5 align-top">
                  {r.synthetic ? (
                    <span className="text-neutral-300" title={r.name}>
                      —
                    </span>
                  ) : (
                    <span className="whitespace-nowrap font-mono text-neutral-700">{r.name}</span>
                  )}
                </td>
                {showDesc && <TextCell value={r.description} />}
                {showQ && <TextCell value={r.questionText} />}
                {showEnc && <TextCell value={r.valueEncoding} className="font-mono text-neutral-600" />}
                {showUnits && (
                  <td className="whitespace-nowrap px-2.5 py-1.5 align-top text-neutral-600">{r.units || "—"}</td>
                )}
                {showType && (
                  <td className="whitespace-nowrap px-2.5 py-1.5 align-top text-neutral-600">{r.dataType || "—"}</td>
                )}
                {showEmbedded && <TextCell value={r.text} className="italic text-neutral-500" />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {extra > 0 && (
        <div className="text-xs text-neutral-400">
          Showing the first {ROW_CAP} of {rows.length} variables — use Export for the full set.
        </div>
      )}
      {showEmbedded && (
        <div className="text-xs text-neutral-400">
          <span className="italic">Embedded text</span> is the cleaned signal the pipeline actually embedded, shown
          where it differs from the raw description or question.
        </div>
      )}
    </div>
  );
}
