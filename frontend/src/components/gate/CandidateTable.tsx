import { useState } from "react";
import { ExternalLink, Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { candidateLabel, definitionWithoutName } from "@/lib/cde-identity";
import { cdeDetailUrl } from "@/lib/links";
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

// THE `accent` UTILITY IS NOT THE ACCENT (08-26, live-test-2 #2). `bg-accent` / `fill-accent` / `text-accent`
// are shadcn's HOVER-wash slot (`--color-accent: var(--surface-inset)`, the pale inset), so the model's-pick
// star, the filled richness dots and the cos bar all rendered pale-on-white at ~1.15:1. The accent as a MARK
// on the card is the `accent-on-raised` role.

/** The richness fields a reviewer weighs, in the order the meter's tooltip names them. */
const RICHNESS_FIELDS: { label: string; has: (c: UICandidate) => boolean }[] = [
  { label: "question text", has: (c) => !!c.questionText },
  { label: "data type", has: (c) => !!c.dataType },
  { label: "units", has: (c) => !!c.units },
  { label: "permissible values", has: (c) => !!c.permissibleValues && c.permissibleValues.length > 0 },
  { label: "steward", has: (c) => !!c.stewardOrg },
];

function cos(x: number | null | undefined): string {
  return x == null ? "—" : x.toFixed(3);
}

/**
 * ONE SET OF FIXED COLUMNS for the header and every row (review round 3). The header strip and the rows used to be
 * two grids whose last two columns were `auto`, so each sized them to its own content and FIELDS / COS sat over the
 * wrong cells. The header now also lives INSIDE the scroll box (sticky), so a scrollbar narrows both alike.
 */
const COLUMNS = "grid-cols-[1.75rem_minmax(0,1fr)_4.5rem_5.5rem_6rem]";

/**
 * A column header that explains itself on hover (Bhargav: "add hover tooltips for values, metadata similarity") —
 * the dotted underline says there is more to read, and it takes focus so a keyboard reaches the same words.
 */
function HeadTip({ label, tip }: { label: string; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-help justify-self-end underline decoration-dotted decoration-1 underline-offset-[3px]">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal text-left font-normal normal-case leading-relaxed tracking-normal">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The metadata meter — five dots, no count beside them (review round 3: "remove X/Y metadata, just dots"). Which
 * fields are present is on hover, so the number the words used to carry is not lost, only folded.
 */
function RichnessMeter({ c }: { c: UICandidate }) {
  const has = RICHNESS_FIELDS.filter((f) => f.has(c)).map((f) => f.label);
  const missing = RICHNESS_FIELDS.filter((f) => !f.has(c)).map((f) => f.label);
  const score = has.length;
  const total = RICHNESS_FIELDS.length;
  const said = `${score} of ${total} metadata fields.${has.length ? ` Has: ${has.join(", ")}.` : ""}${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`;
  return (
    <span className="inline-flex items-center gap-0.5" title={said} aria-label={said}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          data-testid="richness-dot"
          data-filled={i < score ? "true" : "false"}
          className={cn(
            "h-2 w-2 rounded-full",
            // Filled = present, a HOLLOW RING = absent. The absent mark used to be `--surface-track`
            // (~1.2:1 on white), so "3 of 5" read as three dots of nothing (#2). The ring is the track's
            // own graphical foreground, which clears 3:1 on the card.
            i < score ? "bg-accent-on-raised" : "border border-on-track",
          )}
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

  return (
    <div className="flex flex-col gap-1.5">
      {/* NO KEY STRIP (review round 3, legend option A). The columns are named for what they hold, the three that
          need it explain themselves on hover, and the row marks are words — so there is nothing to look up. */}
      <div className="max-h-[30rem] overflow-y-auto rounded-inner border border-rule-quiet-on-raised divide-y divide-rule-quiet-on-raised">
        <div
          data-testid="candidate-columns"
          className={cn(
            "sticky top-0 z-10 grid items-center gap-3 bg-surface-raised px-3 py-1.5 text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted",
            COLUMNS,
          )}
        >
          <span>#</span>
          <span>CDE</span>
          <HeadTip
            label="Values"
            tip="How many permissible values the CDE lists. Weigh them against this group's source values — open a row to see them."
          />
          <HeadTip
            label="Metadata"
            tip="How many of the 5 catalog metadata fields the CDE fills: question text, data type, units, permissible values, steward. Hover a row's dots for which."
          />
          <HeadTip
            label="Similarity"
            tip="Embedding similarity between the group and the CDE — the retrieval signal. It can disagree with the model's pick, which ranks on concept fit (the # column)."
          />
        </div>
        {ordered.map((c) => {
          const chosen = c.cdeId === chosenId;
          const open = c.cdeId === effectiveExpanded;
          const pvCount = c.permissibleValues?.length ?? 0;
          return (
            <div
              key={c.cdeId || c.rank}
              data-testid="candidate-row"
              data-cde-id={c.cdeId}
              data-rank={c.rank}
              data-chosen={chosen ? "true" : undefined}
              data-model-pick={c.isChosen ? "true" : undefined}
            >
              {/* The scannable row — clicking it INSPECTS (expands), never silently re-picks. */}
              <button
                type="button"
                data-testid="candidate-expand"
                aria-expanded={open}
                title={open ? "Hide this CDE's metadata" : "Show this CDE's metadata (permissible values, data type, steward…)"}
                onClick={() => setExpandedId(open ? "" : c.cdeId)}
                className={cn(
                  "grid w-full items-center gap-3 px-3 py-2 text-left",
                  COLUMNS,
                  chosen ? "bg-surface-ok/40" : "hover:bg-surface-inset",
                )}
              >
                {/* The RANK, not the row position (#3): the chosen candidate floats to the top, and the model's
                    rationale numbers candidates in the order it saw them — so the row number must be that. */}
                <span data-testid="candidate-ordinal" className="tabular-nums text-xs text-on-raised-muted">
                  {c.rank}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <ChevronRight
                      aria-hidden="true"
                      className={cn("h-3.5 w-3.5 shrink-0 text-on-raised-muted transition-transform", open && "rotate-90")}
                    />
                    {/* The catalog NAME, with its tinyId beside it when the name repeats (08-28 F13) — never core's minted
                        `Age__2` key, which is unique but says nothing about which element the row is. */}
                    <span data-testid="candidate-name" className="truncate text-sm font-semibold text-on-raised">
                      {candidateLabel(c, candidates)}
                    </span>
                    {/* The marks are WORDS, so no key is needed: your target, and the model's pick only when it is
                        not your target (as delivered they are the same row, and saying both would say nothing). */}
                    {chosen && (
                      <span
                        data-testid="candidate-tag"
                        data-tag="target"
                        className="shrink-0 rounded-pill bg-surface-ok px-2 py-0.5 text-xs font-semibold text-on-ok"
                      >
                        your target
                      </span>
                    )}
                    {c.isChosen && !chosen && (
                      <span
                        data-testid="candidate-tag"
                        data-tag="model-pick"
                        title="The model's pick — ranked best on concept fit"
                        className="shrink-0 rounded-pill border border-rule-on-raised px-2 py-0.5 text-xs font-semibold text-on-raised-muted"
                      >
                        model&apos;s pick
                      </span>
                    )}
                  </span>
                  {/* No line at all when the definition was only the name: a "—" under every such row is noise. */}
                  {(c.endorsed || definitionWithoutName(c.definition, c.cdeId)) && (
                    <span className="mt-0.5 flex items-center gap-2 pl-5">
                      {c.endorsed && (
                        <span className="rounded-pill border border-status-ok px-1.5 py-0 text-xs text-on-ok">NIH-endorsed</span>
                      )}
                      <span data-testid="candidate-definition" className="line-clamp-1 text-xs text-on-raised-muted">
                        {definitionWithoutName(c.definition, c.cdeId)}
                      </span>
                    </span>
                  )}
                </span>
                <span
                  data-testid="candidate-pv"
                  title={pvCount > 0 ? `${pvCount} permissible values — open the row to see them` : "No permissible values listed"}
                  className={cn("text-right text-xs tabular-nums", pvCount > 0 ? "text-on-raised" : "text-on-raised-muted")}
                >
                  {pvCount > 0 ? `${pvCount} ${pvCount === 1 ? "value" : "values"}` : "—"}
                </span>
                <span data-testid="candidate-metadata" className="flex justify-end">
                  <RichnessMeter c={c} />
                </span>
                {/* The number alone (review round 3: "for similarity just number, no bar"). */}
                <span
                  data-testid="candidate-similarity"
                  title="Embedding similarity to the group"
                  className="text-right text-xs tabular-nums text-on-raised"
                >
                  {cos(c.cosine)}
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
                    <p className="text-sm text-on-raised-muted">{definitionWithoutName(c.definition, c.cdeId) || "—"}</p>
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
                        href={cdeDetailUrl(c.cdeExternalId)}
                        target="_blank"
                        rel="noopener noreferrer"
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
