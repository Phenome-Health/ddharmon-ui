import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  FileText,
  Loader2,
  XCircle,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { useGateDecisions } from "@/hooks/use-gate-decisions";
import { deriveComposite, extractScoreDocument, IS_STATIC } from "@/lib/api";
import { SpecView } from "@/pages/composite";
import { cn } from "@/lib/utils";
import { groupLabel } from "@/lib/ledger";
import {
  CUTOFF_UNSTATED,
  PARTIAL_IS_NOT_THE_SCORE,
  PRESENCE_IS_PER_DICTIONARY,
  SCOPE_VERDICT_COPY,
  componentVerdictFor,
  declaredComponents,
  missingReason,
  scopeVerdictFor,
  type ComponentEvidence,
  type ScopeVerdict,
} from "@/lib/score-scope";
import type {
  CompositeSpec,
  UIRecord,
  ComponentCoding,
  ComponentMatch,
  ConceptGroup,
  FieldDetail,
} from "@/types";

/**
 * The declared-score panel — a COLLAPSED STRIP NEAR THE TOP OF THE GATE 1 BODY.
 *
 * NOT ITS OWN SCREEN, not a step between Setup and Gate 1, and not a modal. A pre-gate screen would
 * interrupt a purchase decision to pitch an add-on, which is the pattern this whole review has been
 * removing; the reviewer reaches this without leaving the ledger.
 *
 * MOVED UP AND CLOSED BY DEFAULT (08-16c review, item E). Bhargav: *"the placement is weird — it's below
 * everything"*, settled as *"move score panel near top as a dropdown for now."* It used to render between
 * the ledger and the commit bar, 3035px down the page, expanded — a 651px panel nobody scrolled to.
 * PLACEMENT ONLY: "for now" is his word, and nothing inside the disclosure is redesigned here.
 *
 * IT STAYS ON GATE 1, and the two alternatives were closed rather than left open. SETUP was ruled out by
 * the 08-25 amendment — with no run there are no concepts, so the verdict was hard-coded `indeterminate`.
 * GATE 2 would add nothing: this panel matches components onto the run's own CONCEPTS, not onto common
 * data elements ("Matched to a concept in this run"), so Gate 2's new information is information it never
 * reads.
 *
 * THE CHARGE RIDES ON THE TRIGGER, and that is the constraint the collapse had to satisfy rather than a
 * flourish. The free/paid split below is the SHAPE of this panel; on a screen whose whole job is deciding
 * what to spend, hiding the paid half behind a disclosure would mean the reviewer meets the charge LATER
 * than they did before. Naming it on the always-visible trigger — at the top of the screen, without
 * opening anything — means they meet it EARLIER instead. The priced copy itself has not moved: it is
 * still inline, immediately above the button it prices, and never behind a modal.
 *
 * ONE STRIP, IN THE HOW-TO'S REGISTER. It sits directly under `HowToPanel` and borrows its geometry
 * exactly — ground surface, inner radius, the same eyebrow and chevron — because a fourth CARD at the top
 * of Gate 1 would be competing with the ledger for the screen, which is a worse placement than the one
 * being fixed.
 *
 * IT ADAPTS `pages/composite.tsx`, which already implemented this feature and which no plan in the phase
 * had ever named until the 2026-08-25 inherited-UI audit found it. Four rules are written into that file's
 * own header and only the first had a counterpart in the amendment — the other three were about to be
 * lost, so they are restored here and in `lib/score-scope.ts`:
 *
 *  1. A MISSING component is a RESULT, not a failure to hide — and "8 candidates were retrieved and all
 *     rejected" is different information from "nothing was retrieved". MISSING means *not retrieved in
 *     this run*, never *the cohort lacks it*.
 *  2. A cutoff the source did not state is FLAGGED FOR A HUMAN, never invented. A score's threshold is a
 *     clinical claim, and synthesising one is the most consequential fabrication this surface could make.
 *  3. PARTIAL COVERAGE IS NOT THE PUBLISHED SCORE, and the verdict says so in those words rather than
 *     leaving it to be inferred from a colour.
 *  4. PRESENCE IS PER DATA DICTIONARY. Participant-level missingness — and therefore an effective N —
 *     cannot be derived from metadata. The output is a recipe the analyst runs; ddharmon never computes
 *     the score.
 *
 * THE FREE/PAID SPLIT IS THE SHAPE OF THE PANEL. Reading the document is $0 and job-independent (08-11's
 * extract route) and stays that way. Matching components onto this run's concepts is one model call, so it
 * is priced inline BEFORE it runs — never behind a modal, in the same register as the commit bar — and
 * where the run cannot run it, it renders as an honest not-available naming the reason rather than as a
 * dead control.
 *
 * THE DECLARATION PERSISTS THROUGH THE SHARED GATE-DECISION LAYER, on the `composite_swap` kind that
 * already keys on `(scoreName, componentName)` — one row per declared component, its `chosen` being the
 * concept a match picked, or `""` for "none of these yet". So a declared score survives a reload like
 * every other gate decision, and no artifact kind had to be added to carry it.
 */

/** Used when the reviewer declares components without naming the score. A key needs a non-empty value. */
const UNNAMED_SCORE = "Declared score";

const VERDICT_STYLE: Record<
  ScopeVerdict,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  full: {
    label: "Every component is present",
    className: "border-rule-ok bg-surface-ok text-on-ok",
    Icon: CheckCircle2,
  },
  partial: {
    label: "Some components are present",
    className: "border-rule-warn bg-surface-warn text-on-warn",
    Icon: AlertTriangle,
  },
  infeasible: {
    label: "None of the components was found",
    className: "border-rule-danger bg-surface-danger text-on-danger",
    Icon: XCircle,
  },
  // THE FOURTH VALUE, and it is "we could not tell" rather than "no". Rendered BY FORM — a dashed ring on
  // the neutral surface — for the same reason the coherence cell renders `not judged` that way: a status
  // colour would file it as an outcome, and it is the absence of one. Carried over from `composite.tsx`.
  indeterminate: {
    label: "Cannot be determined yet",
    className: "border-rule-on-raised text-on-raised-muted",
    Icon: CircleDashed,
  },
};

export interface DeclaredScorePanelProps {
  jobId: string;
  /** True on the shared demo, which writes to the browser rather than the store. */
  pinned?: boolean;
  /**
   * A composite spec already derived for this run, when one exists. This is the ONLY source of match
   * evidence — the panel never infers a match, because inferring one is what `match_components` is paid
   * to do properly.
   */
  spec?: CompositeSpec | null;
  /** Why matching cannot run on this run, or `null` when it can. */
  matchRefusal: {
    claim: "deferred" | "failed" | "not-enabled";
    reason: React.ReactNode;
  } | null;
  onMatch?: () => void;
  matching?: boolean;
  /**
   * groupId → its Gate 1 group, so a match (or a retrieved-but-rejected candidate) can name its concept
   * group and link into the detail pane. Absent where the run has no groups (the demo's empty Gate 1).
   */
  groupsById?: Map<string, ConceptGroup>;
  /** cohort:var → its FieldDetail, so a variable-level match/candidate resolves to its name (not a raw id)
   *  in the Swap dropdown. From the run's `fieldIndex`. */
  fieldIndex?: Record<string, FieldDetail>;
  /** Select a group in Gate 1's detail pane (the drag-drop screen) and scroll it into view. */
  onOpenGroup?: (groupId: string) => void;
  className?: string;
}

// Apply a swap/drop to a spec CLIENT-SIDE — the optimistic preview shown immediately, and the only
// result on an immutable demo or the static build (both refuse the backend write). On an owned run the
// backend's authoritative re-derive replaces this (it fills confidence + rationale the client cannot).
// The backend (backend/composite.py::assess_feasibility) remains the authority; this mirrors its verdict
// rule closely enough to keep the readout honest between the click and the server's answer.
function applyEditLocally(
  spec: CompositeSpec,
  component: string,
  conceptId: string | null,
  groupsById?: Map<string, ConceptGroup>,
): CompositeSpec {
  const matches = spec.matches.map((m) => {
    if (m.component !== component) return m;
    if (conceptId == null) {
      return { ...m, conceptId: null, concept: "", cohorts: [], sourceVariables: [], confidence: 0, column: "", rationale: "", pinned: false };
    }
    const g = groupsById?.get(conceptId);
    return {
      ...m,
      conceptId,
      concept: g ? groupLabel(g).text : conceptId,
      cohorts: g?.cohorts ?? [],
      sourceVariables: g?.memberVariableNames ?? [],
      column: "",
      rationale: "Manually re-pointed to this concept (pending the run's own re-derive).",
      pinned: true,
    };
  });
  const requiredNames = new Set(spec.definition.components.filter((c) => c.required).map((c) => c.name));
  const anyRequired = requiredNames.size > 0;
  const required = matches.filter((m) => !anyRequired || requiredNames.has(m.component));
  const matchedRequired = required.filter((m) => m.conceptId != null);
  const verdict =
    required.length > 0 && matchedRequired.length === required.length
      ? "full"
      : matchedRequired.length > 0
        ? "partial"
        : "infeasible";
  const perCohort = spec.feasibility.perCohort.map((c) => {
    const present = matches.filter((m) => m.conceptId != null && m.cohorts.includes(c.cohort)).map((m) => m.component);
    const missing = required.filter((m) => !(m.conceptId != null && m.cohorts.includes(c.cohort))).map((m) => m.component);
    return { ...c, present, missing, computable: missing.length === 0 && required.length > 0 };
  });
  return {
    ...spec,
    matches,
    feasibility: {
      ...spec.feasibility,
      verdict,
      nRequired: required.length,
      nRequiredMatched: matchedRequired.length,
      matched: matches.filter((m) => m.conceptId != null).map((m) => m.component),
      missing: matches.filter((m) => m.conceptId == null).map((m) => m.component),
      perCohort,
    },
  };
}

export function DeclaredScorePanel({
  jobId,
  pinned,
  spec,
  matchRefusal,
  onMatch,
  matching = false,
  groupsById,
  fieldIndex,
  onOpenGroup,
  className,
}: DeclaredScorePanelProps) {
  const swaps = useGateDecisions(jobId, "composite_swap", { pinned });
  /** Closed by default (08-16c item E) — the charge it carries is stated on the trigger, not behind it. */
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [scoreName, setScoreName] = useState("");
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [document, setDocument] = useState<{
    provenance: string;
    nChars: number;
  } | null>(null);
  const [showDeclareForm, setShowDeclareForm] = useState(false);
  const [localSpec, setLocalSpec] = useState<CompositeSpec | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  // A swap/drop re-derives with every OTHER match pinned, so the recompute costs no model call; the
  // result is held locally so the panel updates without a round-trip to the run's stored spec.
  const shownSpec = localSpec ?? spec;
  // The Swap dropdown's targets: this run's concept groups, shaped as the minimal record the row reads
  // (id + concept + cohorts). Without these, Swap can only drop a match; with them it can re-point it.
  const swapRecords = useMemo(
    () =>
      [...(groupsById?.values() ?? [])].map((g) => ({
        id: g.groupId,
        concept: g.concept,
        cohorts: g.cohorts,
      })) as unknown as UIRecord[],
    [groupsById],
  );
  // Resolve a candidate id to a name + cohorts (+ the group's TRUE size, for the coverage line) for the
  // Swap dropdown and the matched-group render — a GROUP id via `groupsById`, OR a variable-level candidate
  // id ("cohort:var") via the run's `fieldIndex`. Without the fieldIndex branch a variable candidate would
  // render as a raw "Cohort:var" id. `nMembers` is the denominator of "N of M members matched"; a variable
  // candidate has no group so it stays undefined and the coverage line degrades to "N members matched".
  const resolveConcept = useMemo(
    () => (id: string) => {
      const g = groupsById?.get(id);
      if (g) return { concept: groupLabel(g).text, cohorts: g.cohorts, nMembers: g.nMembers };
      const fd = fieldIndex?.[id];
      if (fd)
        return {
          concept: fd.questionText || fd.text || fd.name || id,
          cohorts: id.includes(":") ? [id.slice(0, id.indexOf(":"))] : [],
        };
      return undefined;
    },
    [groupsById, fieldIndex],
  );
  async function handleEdit(component: string, conceptId: string | null) {
    if (!shownSpec) return;
    // Optimistic: show the edit immediately. On an immutable demo or the static build this is the result.
    const optimistic = applyEditLocally(shownSpec, component, conceptId, groupsById);
    setLocalSpec(optimistic);
    if (IS_STATIC) return;
    // Reconcile with the run's own re-derive (owned run: fills confidence + rationale; every other match
    // is pinned so it costs no model call). A 403 means this is a read-only demo — keep the optimistic view.
    const overrides: Record<string, string | null> = {};
    for (const m of optimistic.matches) overrides[m.component] = m.conceptId;
    setEditBusy(true);
    try {
      setLocalSpec(
        await deriveComposite(jobId, {
          definition: shownSpec.definition,
          overrides,
        }),
      );
    } catch {
      // Read-only demo (403) or a transient failure — the optimistic edit stands.
    } finally {
      setEditBusy(false);
    }
  }

  /**
   * The declared components — from the persisted rows, and from any spec this run has already derived.
   *
   * BOTH SOURCES, because a DERIVED score is a declared one that has been matched. A run that already
   * carries a spec would otherwise show nothing until the reviewer re-typed the component list it was
   * built from, which is the transcription burden that got this panel moved off Setup in the first place.
   * Persisted rows win on collision: they are the reviewer's own statement of what they are scoping to.
   */
  const declared = useMemo(() => {
    const seen = new Set<string>();
    const out: { scoreName: string; name: string }[] = [];
    for (const d of Object.values(swaps.decisions)) {
      const name = typeof d.componentName === "string" ? d.componentName : "";
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        out.push({ scoreName: String(d.scoreName ?? UNNAMED_SCORE), name });
      }
    }
    for (const c of spec?.definition.components ?? []) {
      if (c.name && !seen.has(c.name.toLowerCase())) {
        seen.add(c.name.toLowerCase());
        out.push({
          scoreName: spec?.definition.name || UNNAMED_SCORE,
          name: c.name,
        });
      }
    }
    return out;
  }, [swaps.decisions, spec]);

  /**
   * What this run knows about each declared component.
   *
   * `searched` comes ONLY from a real match having run — the presence of this component in a derived
   * spec's `matches`. Nothing else sets it, which is what keeps `infeasible` unreachable by default.
   */
  const evidence: ComponentEvidence[] = useMemo(() => {
    const byComponent = new Map(
      (spec?.matches ?? []).map((m) => [m.component, m]),
    );
    return declared.map(({ name }) => {
      const match = byComponent.get(name);
      return {
        name,
        searched: match !== undefined,
        matched: !!match?.conceptId,
        shortlistSize: match?.shortlist.length ?? 0,
      };
    });
  }, [declared, spec]);

  const verdict = scopeVerdictFor(evidence);
  const style = VERDICT_STYLE[verdict];
  const codingFor = (name: string) =>
    spec?.definition.components.find((c) => c.name === name)?.coding;
  const matchByComponent = useMemo(
    () => new Map((spec?.matches ?? []).map((m) => [m.component, m])),
    [spec],
  );

  async function onDocument(file: File) {
    setReading(true);
    setReadError("");
    try {
      // $0 AND JOB-INDEPENDENT (08-11). Reading a document is free and nothing here makes it cost money:
      // finding out that a publisher PDF is an access-check interstitial, or that its component table did
      // not survive extraction, should not cost a derivation.
      const out = await extractScoreDocument(file);
      setDocument({ provenance: out.provenance, nChars: out.nChars });
      setDraft(out.text.slice(0, 4000));
    } catch (e) {
      setReadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }

  async function onDeclare() {
    const name = scoreName.trim() || UNNAMED_SCORE;
    const components = declaredComponents(draft);
    await Promise.all(
      components.map((componentName) =>
        swaps.write(
          { scoreName: name, componentName },
          {
            // "None of these" — a declaration is not a match, and writing a concept id here without one
            // having been made would be the panel asserting the very thing it is asking to be paid for.
            chosen: "",
            alternatives: components,
          },
        ),
      ),
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      // Addressable on the ROOT, exactly as `HowToPanel` is, so a spec can measure the strip rather than
      // reaching for it through the collapsible's markup — and so "is it the same height as the other
      // strip?" compares a container with a container.
      data-testid="score-strip"
      // The how-to strip's geometry, verbatim: ground surface, inner radius, same padding. This is the
      // difference between a second orientation strip and a fourth panel competing for the top of Gate 1.
      className={cn("rounded-inner bg-on-field/5 px-4 py-3", className)}
    >
      <CollapsibleTrigger
        data-testid="score-panel-toggle"
        // An icon-only control names the ACTION and its OBJECT; this one is not icon-only, but the same
        // rule governs what the name has to say.
        aria-label={
          open
            ? "Hide the declared-score panel"
            : "Show the declared-score panel"
        }
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        {/*
          ONE LINE, AT THE HOW-TO STRIP'S EXACT HEIGHT. Stacking the title over the summary made this
          strip 58px against the how-to's 40px, and every pixel here is spent from the ledger's own
          budget: Gate 1's first row already begins 1155px down a 900px viewport before this panel
          exists. A two-line header would be this change starting to compete with the data it sits above,
          which is a worse placement than the one it is fixing.
        */}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">
            A score you want to build from this run
          </span>
          {/*
            THE FREE/PAID SPLIT, ON THE CLOSED STRIP. Collapsing this panel must not make the reviewer
            meet the charge later than they did when it was expanded at the foot of the page — so the
            summary states both halves here, where it is visible without opening anything. The priced
            copy inside is unchanged and still sits immediately above the control it prices.
          */}
          <span className="min-w-0 text-xs text-on-field-muted">
            Reading a paper is free; matching its components against this run
            costs one model call.
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-on-field-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <section
          data-testid="score-panel"
          aria-label="A published score you want this run to support"
          className="mt-3 flex flex-col gap-4 rounded-card bg-surface-raised px-6 py-4 shadow-card"
        >
          {(!shownSpec || showDeclareForm) && (
            <>
          <div className="flex flex-col gap-1">
            {/* The TITLE now leads the trigger above, so it is not repeated here; what stays is the sentence
            the title never carried — including `PRESENCE_IS_PER_DICTIONARY`, which is one of the four
            rules this panel exists to keep saying. */}
            <p className="max-w-[80ch] text-sm text-on-raised-muted">
              Name the components of a published score — a frailty index, an
              intrinsic-capacity score, an SES index — and this run will say
              which of them its concepts can supply, and out of which.{" "}
              {PRESENCE_IS_PER_DICTIONARY}
            </p>
          </div>

          {/* THE FREE HALF. Reading a document costs nothing and the copy says so. */}
          <div data-testid="score-upload" className="flex flex-col gap-2">
            <label className="flex w-fit cursor-pointer items-center gap-2 rounded-inner border border-rule-control-on-raised px-3 py-2 text-xs font-semibold text-on-raised">
              {reading ? (
                <Loader2
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <FileText aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              Read a paper or supplement (PDF or Word)
              <input
                type="file"
                accept=".pdf,.docx"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onDocument(file);
                }}
              />
            </label>
            <p className="max-w-[80ch] text-xs text-on-raised-muted">
              Reading the document costs nothing — no model is called. It pulls
              the text out so you can see whether the component table survived
              extraction before anything is spent on it.
            </p>
            {document && (
              <p
                data-testid="score-doc-read"
                className="text-xs text-on-raised"
              >
                Read {document.nChars.toLocaleString()} characters from{" "}
                {document.provenance}. Copy the component names out of it below.
              </p>
            )}
            {readError && (
              <p
                data-testid="score-doc-error"
                role="alert"
                className="text-xs font-semibold text-status-danger"
              >
                {readError}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="score-name"
              className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted"
            >
              Score name
            </label>
            <input
              id="score-name"
              value={scoreName}
              onChange={(e) => setScoreName(e.target.value)}
              placeholder={UNNAMED_SCORE}
              className="min-h-8 rounded-inner border border-rule-control-on-raised bg-surface-raised px-2 py-1 text-sm text-on-raised"
            />
            <label
              htmlFor="score-components"
              className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted"
            >
              Its components, one per line
            </label>
            <Textarea
              id="score-components"
              data-testid="score-components"
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                "Weak grip strength\nSlow walking speed\nUnintentional weight loss"
              }
              className="rounded-inner"
            />
            <div>
              <Button
                type="button"
                onClick={() => void onDeclare()}
                disabled={draft.trim().length === 0}
              >
                Declare these components
              </Button>
            </div>
          </div>
            </>
          )}
          {shownSpec && (
            <button
              type="button"
              onClick={() => setShowDeclareForm((v) => !v)}
              className="w-fit text-xs font-semibold text-on-raised underline decoration-rule-control-on-raised"
            >
              {showDeclareForm ? "Hide" : "Declare a different score"}
            </button>
          )}

          {shownSpec ? (
            <SpecView
              spec={shownSpec}
              conceptById={{}}
              records={swapRecords}
              onEdit={handleEdit}
              busy={editBusy}
              jobId={jobId}
              onOpenGroup={onOpenGroup}
              resolveConcept={resolveConcept}
              hideDerivation
            />
          ) : declared.length > 0 ? (
            <>
              <div
                data-testid="score-verdict"
                data-verdict={verdict}
                className={cn(
                  "flex flex-col gap-1 rounded-inner border px-4 py-3",
                  style.className,
                )}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <style.Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                  {style.label}
                  <span className="font-mono text-xs tabular-nums">
                    {evidence.filter((e) => e.matched).length}/{evidence.length}
                  </span>
                </span>
                <span className="max-w-[80ch] text-xs">
                  {SCOPE_VERDICT_COPY[verdict]}
                </span>
                {/* Rule 3: this is what stops `partial` reading as a qualified yes. */}
                {verdict === "partial" && (
                  <span className="max-w-[80ch] text-xs">
                    {PARTIAL_IS_NOT_THE_SCORE}
                  </span>
                )}
              </div>

              <ul className="flex flex-col gap-2">
                {evidence.map((e) => (
                  <ScoreComponentRow
                    key={e.name}
                    evidence={e}
                    match={matchByComponent.get(e.name)}
                    coding={codingFor(e.name)}
                    groupsById={groupsById}
                    onOpenGroup={onOpenGroup}
                  />
                ))}
              </ul>
            </>
          ) : null}

          {/* THE PAID BOUNDARY, priced inline and never behind a modal. */}
          {!shownSpec && (
          <div className="flex flex-col gap-2 border-t border-rule-quiet-on-raised pt-3">
            <p
              data-testid="score-match-price"
              className="max-w-[80ch] text-xs font-semibold text-on-raised"
            >
              Matching these components onto this run&rsquo;s concepts costs
              money: it is one model call over the concepts, and it is what
              turns a declaration into a verdict. Nothing is charged until you
              press it.
            </p>
            {matchRefusal ? (
              <NotAvailable
                thing="Matching the components"
                claim={matchRefusal.claim}
              >
                {matchRefusal.reason}
              </NotAvailable>
            ) : (
              <div>
                <Button
                  type="button"
                  onClick={onMatch}
                  disabled={matching || declared.length === 0}
                >
                  {matching && (
                    <Loader2
                      aria-hidden="true"
                      className="mr-2 h-4 w-4 animate-spin"
                    />
                  )}
                  Match them against this run
                </Button>
              </div>
            )}
          </div>
          )}
        </section>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One declared component, expandable to the evidence behind its verdict (08-16g follow-on): the concept
 * GROUP ddharmon matched it to, that group's cohorts and the source variables under it, and the candidate
 * groups retrieval offered — each a click-through into that group's drag-drop detail on Gate 1.
 *
 * IT SHOWS ONLY WHAT A MATCH RECORDED. The vars and cohorts come off `ComponentMatch`; the group names come
 * off the run's own groups (`groupsById`). A component with no match and no shortlist has nothing to reveal,
 * so it does not expand — the summary line already says why. This never infers a match the spec did not make.
 */
function ScoreComponentRow({
  evidence,
  match,
  coding,
  groupsById,
  onOpenGroup,
}: {
  evidence: ComponentEvidence;
  match: ComponentMatch | undefined;
  coding: ComponentCoding | undefined;
  groupsById?: Map<string, ConceptGroup>;
  onOpenGroup?: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const componentVerdict = componentVerdictFor(evidence);
  const matchedGroup = match?.conceptId
    ? groupsById?.get(match.conceptId)
    : undefined;
  // The candidates retrieval offered, minus the one that was chosen — the "also considered" for a match,
  // the "retrieved and rejected" for a miss. Only those we can name (present in `groupsById`) are shown.
  const otherCandidates = (match?.shortlist ?? [])
    .filter((id) => id !== match?.conceptId)
    .map((id) => ({ id, group: groupsById?.get(id) }))
    .filter((c): c is { id: string; group: ConceptGroup } => !!c.group);
  const hasDetail = !!matchedGroup || otherCandidates.length > 0;

  return (
    <li
      data-testid="score-component"
      data-component={evidence.name}
      data-verdict={componentVerdict}
      className="flex flex-col gap-1 rounded-inner border border-rule-on-raised px-3 py-2"
    >
      {hasDetail ? (
        <button
          type="button"
          data-testid="score-component-expand"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="text-sm font-semibold text-on-raised">
            {evidence.name}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-4 w-4 shrink-0 text-on-raised-muted transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      ) : (
        <span className="text-sm font-semibold text-on-raised">
          {evidence.name}
        </span>
      )}

      {(() => {
        // Simplified row copy (08-16g review #3): the wordy "Matched to a concept in this run:" prefix is
        // trimmed to "Matched:", and the full sentence — the matched concept's name, or the long "why not"
        // reason — is relegated to a tooltip and clamped to two lines, so a long name/reason never bloats
        // the row. The name resolves through groupLabel (#1) so an unnamed residual reads "Unnamed group",
        // never a raw group id.
        const summary = evidence.matched
          ? `Matched: ${matchedGroup ? groupLabel(matchedGroup).text : match?.concept?.trim() || "—"}`
          : missingReason(evidence);
        return (
          <span
            className="line-clamp-2 max-w-[80ch] text-xs text-on-raised-muted"
            title={summary}
          >
            {summary}
          </span>
        );
      })()}

      {/* Rule 2: a cutoff the source did not state is flagged, never derived. */}
      {coding && !coding.cutoff && !coding.referenceRange && (
        <span
          data-testid="score-cutoff-unstated"
          className="max-w-[80ch] text-xs text-on-warn"
        >
          {CUTOFF_UNSTATED}
        </span>
      )}
      {coding && (coding.cutoff || coding.referenceRange) && (
        <span className="text-xs text-on-raised-muted">
          As stated in the source:{" "}
          <span className="font-mono">
            {coding.cutoff || coding.referenceRange}
          </span>
        </span>
      )}

      {open && hasDetail && (
        <div
          data-testid="score-component-detail"
          data-component={evidence.name}
          className="mt-1 flex flex-col gap-2 border-t border-rule-quiet-on-raised pt-2"
        >
          {matchedGroup && match && (
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                  Matched group
                </span>
                <span className="font-mono text-xs tabular-nums text-on-raised-muted">
                  confidence {match.confidence.toFixed(2)}
                </span>
              </div>
              <button
                type="button"
                data-testid="score-open-group"
                data-group={match.conceptId ?? undefined}
                onClick={() =>
                  match.conceptId && onOpenGroup?.(match.conceptId)
                }
                className="w-fit text-left text-sm font-semibold text-link-on-raised underline underline-offset-2"
                title="Open this group's members on Gate 1"
              >
                {groupLabel(matchedGroup).text}
              </button>
              <div className="flex flex-wrap items-center gap-1">
                {matchedGroup.cohorts.map((c) => (
                  <span
                    key={c}
                    data-testid="score-detail-cohort"
                    className="rounded border border-rule-on-raised px-1.5 py-0.5 font-mono text-[11px] text-on-raised-muted"
                  >
                    {c}
                  </span>
                ))}
              </div>
              {match.sourceVariables.length > 0 && (
                <ul className="flex flex-col gap-0.5 pl-1">
                  {match.sourceVariables.map((v) => (
                    <li
                      key={v}
                      data-testid="score-detail-var"
                      className="break-all font-mono text-xs text-on-raised-muted"
                    >
                      {v}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {otherCandidates.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
                {matchedGroup
                  ? "Other concepts retrieved"
                  : "Concepts retrieved — none measured this"}
              </span>
              {otherCandidates.map(({ id, group }) => (
                <button
                  key={id}
                  type="button"
                  data-testid="score-candidate-group"
                  data-group={id}
                  onClick={() => onOpenGroup?.(id)}
                  className="flex w-full items-baseline justify-between gap-2 text-left"
                  title="Open this group's members on Gate 1"
                >
                  <span className="line-clamp-1 text-xs text-link-on-raised underline underline-offset-2">
                    {groupLabel(group).text}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-on-raised-muted">
                    {group.cohorts.join(" · ")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
