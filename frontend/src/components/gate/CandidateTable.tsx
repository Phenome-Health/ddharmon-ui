import { useState } from "react";
import { Star, ExternalLink, Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UICandidate } from "@/types";

/**
 * The ranked CDE-candidate list (08-16g) — the workbench's cosine-bar ranking, made INSPECTABLE and
 * RE-PICKABLE in place.
 *
 * Bhargav: *"A user selects the best CDE based on (1) overall richness of the CDE metadata and (2)
 * harmonizability of the group vars to the CDE's permissible values. This info needs to be available at a
 * glance and not require clicking the hyperlink to the CDE repo. Clicking a candidate should expand to show
 * these core metadata fields; others can be viewed on the repo."*
 *
 * So each row carries a RICHNESS meter and a permissible-value count at a glance; clicking a row EXPANDS it
 * to show the permissible values (the harmonizability signal) plus question text, data type, units and
 * steward inline; and the repo link is kept only for the long tail. Selection is an explicit button in the
 * expanded panel — clicking a row inspects, it does not silently re-pick.
 *
 * Catalog metadata is optional on the wire (older runs / the current core contract omit it). Absent → the
 * row shows what it can and points at the repo; the candidate-enrichment join fills it for real runs.
 */

const NIH_CDE_URL = "https://cde.nlm.nih.gov/deView?tinyId=";

/** The richness fields a reviewer weighs — how many are actually populated for this candidate. */
const RICHNESS_FIELDS = ["questionText", "dataType", "units", "permissibleValues", "stewardOrg"] as const;

function richnessOf(c: UICandidate): number {
  let n = 0;
  if (c.questionText) n++;
  if (c.dataType) n++;
  if (c.units) n++;
  if (c.permissibleValues && c.permissibleValues.length > 0) n++;
  if (c.stewardOrg) n++;
  return n;
}

function cos(x: number | null | undefined): string {
  return x == null ? "—" : x.toFixed(3);
}

function MiniBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-surface-track">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** A compact "how many of the richness fields are present" meter — dots, so it scans without reading. */
function RichnessMeter({ score }: { score: number }) {
  const total = RICHNESS_FIELDS.length;
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`${score} of ${total} metadata fields present`}
      aria-label={`richness ${score} of ${total}`}
    >
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn("h-1.5 w-1.5 rounded-full", i < score ? "bg-accent" : "bg-surface-track")}
        />
      ))}
    </span>
  );
}

export function CandidateTable({
  candidates,
  chosenId,
  onPick,
  readOnly,
}: {
  candidates: UICandidate[];
  /** The identifier currently chosen (a candidate's `cdeId`, or "" / a gencde id when none is). */
  chosenId: string;
  onPick: (candidate: UICandidate) => void;
  readOnly?: boolean;
}) {
  // `null` = untouched → the chosen candidate shows expanded (reading the LIVE chosenId, not a stale mount
  // value); once the reviewer clicks a row, their choice governs. "" collapses all.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const effectiveExpanded = expandedId ?? chosenId;

  if (candidates.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-on-raised-muted">
        No candidates retained (novel / GenCDE route).
      </p>
    );
  }
  const ordered = [...candidates].sort(
    (a, b) => (b.isChosen ? 1 : 0) - (a.isChosen ? 1 : 0) || a.rank - b.rank,
  );
  const bestRank = candidates.reduce(
    (best, c) => (c.cosine > (candidates.find((x) => x.rank === best)?.cosine ?? -Infinity) ? c.rank : best),
    candidates[0].rank,
  );

  return (
    <div className="flex flex-col gap-1.5">
      {/* Column key — the ranked table's header, as a light strip above the expandable rows. */}
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-faint">
        <span>#</span>
        <span>CDE</span>
        <span className="text-right" title="How many of the 5 catalog metadata fields this CDE has (question, data type, units, permissible values, steward)">
          Fields
        </span>
        <span className="text-right" title="Embedding cosine similarity — the retrieval signal, which can differ from the model's concept-fit pick">
          cos
        </span>
      </div>
      {/* Icon/column key — so the glyphs are legible without hovering each one. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-xs text-on-raised-faint">
        <span className="inline-flex items-center gap-1">
          <Star className="h-3 w-3 fill-accent text-accent" /> model&apos;s pick
        </span>
        <span className="inline-flex items-center gap-1">
          <RichnessMeter score={3} /> metadata richness
        </span>
        <span>
          <b className="font-semibold text-on-raised-muted">N PV</b> = permissible values
        </span>
        <span>click a row for full metadata</span>
      </div>
      <div className="max-h-[30rem] overflow-y-auto rounded-inner border border-rule-quiet-on-raised divide-y divide-rule-quiet-on-raised">
        {ordered.map((c, i) => {
          const chosen = c.cdeId === chosenId;
          const open = c.cdeId === effectiveExpanded;
          const score = richnessOf(c);
          const pvCount = c.permissibleValues?.length ?? 0;
          return (
            <div key={c.cdeId || c.rank} data-testid="candidate-row" data-cde-id={c.cdeId} data-chosen={chosen ? "true" : undefined}>
              {/* The scannable row — clicking it INSPECTS (expands), never silently re-picks. */}
              <button
                type="button"
                data-testid="candidate-expand"
                aria-expanded={open}
                title={open ? "Hide this CDE's metadata" : "Show this CDE's metadata (permissible values, data type, steward…)"}
                onClick={() => setExpandedId(open ? "" : c.cdeId)}
                className={cn(
                  "grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 text-left",
                  chosen ? "bg-surface-ok/40" : "hover:bg-surface-inset",
                )}
              >
                <span className="tabular-nums text-xs text-on-raised-muted">{i + 1}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <ChevronRight
                      aria-hidden="true"
                      className={cn("h-3.5 w-3.5 shrink-0 text-on-raised-faint transition-transform", open && "rotate-90")}
                    />
                    <span className="truncate text-sm font-semibold text-on-raised">{c.cdeId}</span>
                    {chosen && (
                      <span title="Your selected target">
                        <Check className="h-3.5 w-3.5 shrink-0 text-status-ok" data-testid="candidate-chosen-mark" />
                      </span>
                    )}
                    {c.isChosen && !chosen && (
                      <span title="The model's pick — ranked best on concept fit">
                        <Star className="h-3.5 w-3.5 shrink-0 fill-accent text-accent" />
                      </span>
                    )}
                    {c.rank === bestRank && !c.isChosen && (
                      <span
                        title="Strongest embedding similarity — but not the model's concept-fit pick"
                        className="shrink-0 rounded bg-surface-inset px-1 py-0.5 text-xs font-semibold text-on-inset-muted"
                      >
                        highest cos
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 pl-5">
                    {c.endorsed && (
                      <span className="rounded-pill border border-status-ok px-1.5 py-0 text-xs text-on-ok">NIH-endorsed</span>
                    )}
                    <span className="line-clamp-1 text-xs text-on-raised-muted">{c.definition || "—"}</span>
                  </span>
                </span>
                <span className="flex items-center justify-end gap-2 text-right">
                  {pvCount > 0 && (
                    <span className="rounded bg-surface-inset px-1.5 py-0.5 text-xs font-semibold text-on-inset-muted" title="permissible values">
                      {pvCount} PV
                    </span>
                  )}
                  <RichnessMeter score={score} />
                </span>
                <span className="flex items-center justify-end gap-2">
                  <MiniBar value={c.cosine} />
                  <span className="w-10 text-right tabular-nums text-xs text-on-raised">{cos(c.cosine)}</span>
                </span>
              </button>

              {/* The expanded panel — the core metadata a pick is made on, inline. Long tail is on the repo. */}
              {open && (
                <div data-testid="candidate-detail" className="flex flex-col gap-3 border-t border-rule-quiet-on-raised bg-surface-inset px-4 py-3">
                  {c.questionText && (
                    <div>
                      <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">Question</span>
                      <p className="text-sm text-on-raised">{c.questionText}</p>
                    </div>
                  )}
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">Definition</span>
                    <p className="text-sm text-on-raised-muted">{c.definition || "—"}</p>
                  </div>
                  <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-on-raised-muted">
                    {c.dataType && (
                      <div><dt className="inline font-semibold">Data type: </dt><dd className="inline">{c.dataType}</dd></div>
                    )}
                    {c.units && (
                      <div><dt className="inline font-semibold">Units: </dt><dd className="inline">{c.units}</dd></div>
                    )}
                    {c.stewardOrg && (
                      <div><dt className="inline font-semibold">Steward: </dt><dd className="inline">{c.stewardOrg}</dd></div>
                    )}
                  </dl>
                  {/* THE HARMONIZABILITY SIGNAL — the target's permissible values, to weigh against the group's
                      source values (the Gate 1 panel above). Prominent, not buried behind a link. */}
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-inset-muted">
                      Permissible values{pvCount > 0 ? ` (${pvCount})` : ""}
                    </span>
                    {pvCount > 0 ? (
                      <div data-testid="candidate-permissible-values" className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                        {c.permissibleValues!.map((v, k) => (
                          <span key={k} className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-on-raised">
                            {v}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-on-raised-faint">
                        Not a value-list element, or not on the wire — open the full record on the repo.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!readOnly &&
                      (chosen ? (
                        <span data-testid="candidate-selected" className="inline-flex items-center gap-1.5 text-sm font-semibold text-status-ok">
                          <Check className="h-4 w-4" /> Selected as the target
                        </span>
                      ) : (
                        <Button data-testid="candidate-select" size="sm" onClick={() => onPick(c)}>
                          Select this CDE
                        </Button>
                      ))}
                    {c.cdeExternalId && (
                      <a
                        href={`${NIH_CDE_URL}${encodeURIComponent(c.cdeExternalId)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-link-on-raised hover:underline"
                      >
                        Full record on the repo <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
