import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisclosureChevron, DisclosureLabel, disclosureRow } from "@/components/ui/disclosure";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { RunKeyField } from "@/components/gate/RunKeyField";
import { matchDeclaredScore } from "@/lib/api";
import { heldRunKey, keyAskFor, type KeyRefusal } from "@/lib/run-key";
import { estimateScoreMatchUsd, formatUsd } from "@/lib/estimate";
import { gate4MatchRefusal, matchActionLabel, type DeclaredScore } from "@/lib/score-match";
import { GATE4_VERDICT_LABEL, gate4ScoreHeader, gate4ScoreVerdict } from "@/lib/gate4-score";
import {
  MISSING_IS_A_RUN_RESULT,
  PARTIAL_IS_NOT_THE_SCORE,
  PRESENCE_IS_PER_DICTIONARY,
  SCOPE_VERDICT_COPY,
  componentVerdictFor,
  coveredCohorts,
  missingReason,
  type ComponentEvidence,
  type ScopeVerdict,
} from "@/lib/score-scope";
import { cn } from "@/lib/utils";
import { ScoreComponentsCard } from "@/pages/composite";
import type { CompositeSpec, FieldDetail, UIRecord } from "@/types";

/**
 * The declared score on Gate 4 — read-only declaration, one paid Match, then verdict + coverage + recipe.
 *
 * WHY HERE (decision Q5, 08-28 1f). A score is declared on Gate 1, where the reviewer is scoping; it is matched
 * here, where the concepts are FINAL — the reviewer's scope, renames, target picks and edits all applied, the
 * same records every export carries. A staged run parked at Gate 1 has no assigned records at all, which is
 * why the Gate 1 panel's old promise ("the verdict fills in once the run has got that far") could never keep.
 *
 * THE DECLARATION IS A RECORD. Gate 1 has been passed, so nothing here edits it — no text box, no Declare. Being
 * a record freezes EDITING; it never freezes MATCHING, which reads the declaration as it stands.
 *
 * THE PAID BOUNDARY IS PRICED ON THE CONTROL, as everywhere else in the gates: "Match (one model call, about
 * $X)", with the priced sentence immediately above it and never behind a modal. Once it has run, the figure
 * shown is what the call was actually billed.
 *
 * THE FOUR RULES `DeclaredScorePanel` keeps are kept here too: a missing component is a RESULT (and
 * "retrieved and rejected" differs from "nothing retrieved"); an unstated cutoff is never invented (core flags
 * every such step `needs review`); partial coverage is not the published score, in words; presence is per data
 * dictionary. The verdict shown is the server's presentation verdict — never a negative one from no evidence.
 *
 * A DISCLOSURE, FOLDED BY DEFAULT (final review round 2: "score builder section should be collapsible"), the
 * way the how-to strip and Gate 1's score strip are. Folded, its header still carries what the reviewer needs
 * without opening it — the score's name, that it is declared, and its state: not matched yet with the price of
 * matching (never moved behind the fold), or matched with the verdict and its coverage (`gate4ScoreHeader`).
 */

const VERDICT_STYLE: Record<ScopeVerdict, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  full: { label: GATE4_VERDICT_LABEL.full, className: "border-rule-ok bg-surface-ok text-on-ok", Icon: CheckCircle2 },
  partial: {
    label: GATE4_VERDICT_LABEL.partial,
    className: "border-rule-warn bg-surface-warn text-on-warn",
    Icon: AlertTriangle,
  },
  infeasible: {
    label: GATE4_VERDICT_LABEL.infeasible,
    className: "border-rule-danger bg-surface-danger text-on-danger",
    Icon: XCircle,
  },
  // "We could not tell" is rendered by FORM (a dashed ring on the neutral surface), never a status colour.
  indeterminate: {
    label: GATE4_VERDICT_LABEL.indeterminate,
    className: "border-rule-on-raised text-on-raised-muted",
    Icon: CircleDashed,
  },
};

export interface Gate4ScorePanelProps {
  jobId: string;
  score: DeclaredScore;
  /** The newest spec derived under this score's name, when one exists. */
  spec: CompositeSpec | null;
  /** True on the shared demo, which never spends. */
  pinned?: boolean;
  /** A match came back — the page holds it and refreshes the run's stored composites. */
  onMatched: (spec: CompositeSpec) => void;
  /** The run's final records — what the match's concept ids name — for the matched cards' group labels. */
  records?: UIRecord[];
  /** cohort:var → its FieldDetail, so a matched variable reads as its question rather than a raw id. */
  fieldIndex?: Record<string, FieldDetail>;
}

/** The cards resolve through `resolveConcept`; nothing is keyed by a separate concept map here. */
const NO_CONCEPTS: Record<string, UIRecord> = {};

export function Gate4ScorePanel({
  jobId,
  score,
  spec,
  pinned,
  onMatched,
  records = [],
  fieldIndex,
}: Gate4ScorePanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** The server refused the match for want of a BYOK key (08-28): the field shows here, where it was pressed. */
  const [keyAsk, setKeyAsk] = useState<KeyRefusal | null>(null);
  const [open, setOpen] = useState(false);
  const refusal = gate4MatchRefusal({ pinned });
  const n = score.components.length;

  // An unrecognized verdict resolves to INDETERMINATE, never to the negative claim.
  const verdict: ScopeVerdict = gate4ScoreVerdict(spec);
  const style = VERDICT_STYLE[verdict];
  const header = gate4ScoreHeader(n, spec, { refused: refusal !== null });
  const matchOf = new Map((spec?.matches ?? []).map((m) => [m.component, m]));
  /**
   * A matched card's ids → a readable name: a concept id is one of the final RECORDS (the concepts being exported,
   * under the reviewer's names); a variable id ("cohort:var") resolves through the field index to its question.
   */
  const resolveConcept = useMemo(() => {
    const byId = new Map(records.map((r) => [r.id, r]));
    return (id: string) => {
      const r = byId.get(id);
      if (r) return { concept: r.concept ?? "", cohorts: r.cohorts ?? [], nMembers: r.nMembers };
      const fd = fieldIndex?.[id];
      if (fd) {
        const ci = id.indexOf(":");
        return { concept: fd.questionText || fd.text || fd.name || id, cohorts: ci >= 0 ? [id.slice(0, ci)] : [] };
      }
      return undefined;
    };
  }, [records, fieldIndex]);

  async function onMatch() {
    setBusy(true);
    setError("");
    try {
      // The tab's held key rides the match (08-28); with none, the server decides.
      const matched = await matchDeclaredScore(jobId, score.scoreName, heldRunKey());
      setKeyAsk(null);
      onMatched(matched);
    } catch (e) {
      setKeyAsk(keyAskFor(e, { pinned }));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section
        data-testid="gate4-score"
        data-score={score.scoreName}
        data-open={String(open)}
        aria-label={`The score declared at Gate 1: ${score.scoreName}`}
        className="flex flex-col rounded-card bg-surface-raised px-6 py-4 shadow-card"
      >
        <CollapsibleTrigger
          data-testid="gate4-score-toggle"
          // The accessible name states the ACTION and its OBJECT (UI-SPEC §6), as the how-to toggle's does.
          aria-label={`${open ? "Hide" : "Show"} the declared score ${score.scoreName}`}
          className={disclosureRow("raised", "gap-3")}
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <DisclosureLabel ground="raised">The score you declared at Gate 1</DisclosureLabel>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h2 className="text-sm font-semibold text-on-raised">{score.scoreName}</h2>
              {/* THE STATE, ON THE FOLDED HEADER: matched or not, and — unmatched — the price of matching. */}
              <span
                data-testid="gate4-score-state"
                data-state={header.state}
                className="min-w-0 text-xs text-on-raised-muted"
              >
                {header.text}
              </span>
            </span>
          </span>
          <DisclosureChevron ground="raised" open={open} />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 pt-4">
          <p className="max-w-[80ch] text-xs text-on-raised-muted">
            {n} {n === 1 ? "component" : "components"}, as declared. The declaration is a record now and is not
            edited here; matching reads it as it stands, against the concepts you are exporting.{" "}
            {PRESENCE_IS_PER_DICTIONARY}
          </p>

          <div
            data-testid="gate4-score-verdict"
            data-verdict={verdict}
            className={cn("flex flex-col gap-1 rounded-inner border px-4 py-3", style.className)}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <style.Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              {style.label}
              {spec && (
                <span className="font-mono text-xs tabular-nums">
                  {spec.feasibility.nRequiredMatched}/{spec.feasibility.nRequired}
                </span>
              )}
            </span>
            <span className="max-w-[80ch] text-xs">{SCOPE_VERDICT_COPY[verdict]}</span>
            {verdict === "partial" && <span className="max-w-[80ch] text-xs">{PARTIAL_IS_NOT_THE_SCORE}</span>}
          </div>

          {/*
            MATCHED: THE BUILDER'S OWN CARDS (08-28, option A — "what happened to the old score builder look?"). They drew
            only from a match, and Q5 moved the match here, so here is where they come back — as a RECORD: scope was
            settled on Gate 1, so nothing selects and every group the match reached counts. Before a match the
            declaration stands as the plain list it is.
          */}
          {spec ? (
            <ScoreComponentsCard
              spec={spec}
              variant="record"
              conceptById={NO_CONCEPTS}
              records={records}
              jobId={jobId}
              resolveConcept={resolveConcept}
            />
          ) : (
            <ol className="flex flex-col gap-2">
              {score.components.map((name) => {
                const m = matchOf.get(name);
                const evidence: ComponentEvidence = {
                  name,
                  searched: m !== undefined,
                  matched: !!m?.conceptId,
                  shortlistSize: m?.shortlist?.length ?? 0,
                };
                const cohorts = m?.conceptId ? coveredCohorts(m) : [];
                return (
                  <li
                    key={name}
                    data-testid="gate4-score-component"
                    data-component={name}
                    data-verdict={componentVerdictFor(evidence)}
                    className="flex flex-col gap-0.5 rounded-inner border border-rule-on-raised px-3 py-2"
                  >
                    <span className="text-sm font-semibold text-on-raised">{name}</span>
                    <span className="line-clamp-2 max-w-[80ch] text-xs text-on-raised-muted">
                      {evidence.matched ? `Matched: ${m?.concept?.trim() || m?.conceptId}` : missingReason(evidence)}
                    </span>
                    {cohorts.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {cohorts.map((c) => (
                          <span
                            key={c}
                            className="rounded border border-rule-on-raised px-1.5 py-0.5 font-mono text-[11px] text-on-raised-muted"
                          >
                            {c}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {/* Said once for the list (round 5 sweep), when a looked-for component has no match. */}
          {!spec && score.components.some((name) => matchOf.get(name) !== undefined && !matchOf.get(name)?.conceptId) && (
            <p data-testid="missing-is-a-run-result" className="text-xs text-on-raised-muted">
                  {MISSING_IS_A_RUN_RESULT}
                </p>
          )}

          {spec && (
            <>
              {spec.feasibility.perCohort.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-on-raised">
                    Per cohort
                  </span>
                  <ul className="flex flex-col gap-0.5 text-xs text-on-raised">
                    {spec.feasibility.perCohort.map((c) => (
                      <li key={c.cohort} data-testid="gate4-score-cohort" data-computable={String(c.computable)}>
                        <span className="font-mono font-semibold">{c.cohort}</span> —{" "}
                        {c.computable
                          ? "every required component is present"
                          : `${c.present.length} of ${c.present.length + c.missing.length} components present`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold text-on-raised">
                  The recipe — you run it; ddharmon never computes the score
                </span>
                <ol className="flex flex-col gap-2">
                  {spec.derivation.map((s) => (
                    <li
                      key={s.order}
                      data-testid="gate4-score-step"
                      className="flex flex-col gap-1 rounded-inner border border-rule-on-raised px-3 py-2"
                    >
                      <span className="flex flex-wrap items-center gap-2 text-xs text-on-raised">
                        <span className="text-on-raised-muted">{s.order}.</span>
                        {s.description}
                        {s.needsReview && (
                          <span className="rounded border border-rule-warn bg-surface-warn px-1.5 py-0.5 text-[11px] text-on-warn">
                            needs review
                          </span>
                        )}
                      </span>
                      {s.expression && (
                        <pre className="overflow-x-auto rounded-inner bg-surface-inset px-2 py-1.5 font-mono text-xs text-on-inset">
                          {s.expression}
                        </pre>
                      )}
                    </li>
                  ))}
                </ol>
              </div>

              {spec.feasibility.caveats.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs text-on-raised-muted">
                  {spec.feasibility.caveats.map((c) => (
                    <li key={c} className="flex gap-1.5">
                      <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                      {c}
                    </li>
                  ))}
                </ul>
              )}

              {spec.sourceKind && spec.sourceKind !== "declaration" && (
                <p className="text-xs text-on-raised-muted">
                  This verdict came from a score read out of a document, not from the declaration above.
                </p>
              )}
              {typeof spec.billedUsd === "number" && (
                <p data-testid="gate4-score-billed" className="text-xs text-on-raised-muted">
                  This match was billed {formatUsd(spec.billedUsd)} to the run.
                </p>
              )}
            </>
          )}

          {/* THE PAID BOUNDARY, priced inline and on the control, never behind a modal. */}
          <div className="flex flex-col gap-2 border-t border-rule-quiet-on-raised pt-3">
            <p data-testid="gate4-score-price" className="max-w-[80ch] text-xs font-semibold text-on-raised">
              Matching costs money: it is one model call over the concepts you are exporting — about{" "}
              {formatUsd(estimateScoreMatchUsd(n))} for {n} {n === 1 ? "component" : "components"}. It is what turns
              the declaration into a verdict and a recipe. Nothing is charged until you press it.
            </p>
            {refusal ? (
              <NotAvailable thing="Matching the declared score" claim={refusal.claim}>
                {refusal.reason}
              </NotAvailable>
            ) : (
              <div>
                <Button
                  type="button"
                  data-testid="gate4-score-match"
                  onClick={() => void onMatch()}
                  disabled={busy || n === 0}
                  variant={spec ? "outline" : "default"}
                >
                  {busy && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}
                  {matchActionLabel(n, spec !== null)}
                </Button>
              </div>
            )}
            {error && (
              <p data-testid="gate4-score-error" role="alert" className="text-xs font-semibold text-status-danger">
                {error}
              </p>
            )}
            {keyAsk && !refusal && <RunKeyField reason={keyAsk} action={spec ? "Match again" : "Match"} />}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
