import { useMemo, useState } from "react";
import { ChevronDown, Flashlight, FileText, Loader2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { DisclosureChevron, DisclosureLabel, FOLD_BOX, disclosureRow } from "@/components/ui/disclosure";
import { Textarea } from "@/components/ui/textarea";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { ScoreComponentProposal } from "@/components/gate/ScoreComponentProposal";
import {
  ScoreCutoffLine,
  ScoreSuggestionCards,
  ScoreSuggestionGuide,
  suggestionCounts,
} from "@/components/gate/ScoreSuggestionCards";
import { useGateDecisions, type UseGateDecisions } from "@/hooks/use-gate-decisions";
import { extractScoreComponents, extractScoreDocument } from "@/lib/api";
import { heldRunKey } from "@/lib/run-key";
import { STRIP_SUMMARY, STRIP_SUMMARY_PREVIEW, acceptedDraft, type ReadDocument } from "@/lib/score-proposal";
import { declarationSource, isLongRecord, pastedRecords, recordSize, stripStatus } from "@/lib/score-declaration";
import { SpecView } from "@/pages/composite";
import { cn } from "@/lib/utils";
import type { NamedGroup } from "@/lib/ledger";
import {
  MISSING_IS_A_RUN_RESULT,
  CUTOFF_UNSTATED,
  PRESENCE_IS_PER_DICTIONARY,
  SUGGESTION_TAG_COPY,
  componentVerdictFor,
  declaredComponents,
  missingReason,
  type ComponentEvidence,
} from "@/lib/score-scope";
import { suggestionCards, type GroupScopeWhy, type SuggestionCard } from "@/lib/score-suggestion-cards";
import type { ListCutoff } from "@/lib/score-cutoff";
import type {
  CompositeSpec,
  ComponentCoding,
  ComponentMatch,
  FieldDetail,
  ScoreSuggestions,
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
 * THREE STEPS, THREE COST STATES (08-16e). Between the free read and the paid match sits a second paid step:
 * a model reads the extracted text and PROPOSES the component names (`ScoreComponentProposal`), so the
 * reviewer confirms a list instead of transcribing one out of a 41,000-character dump. It is priced inline
 * like the match, the closed strip names all three states, and the free text stays on screen beside the
 * proposal — it is the evidence the list is checked against. The proposal is never written into the
 * declaration: accepting fills the same box typing does, and "Declare these components" still writes it.
 *
 * THE DECLARATION PERSISTS THROUGH THE SHARED GATE-DECISION LAYER, on the `composite_swap` kind that
 * already keys on `(scoreName, componentName)` — one row per declared component, its `chosen` being the
 * concept a match picked, or `""` for "none of these yet". So a declared score survives a reload like
 * every other gate decision, and no artifact kind had to be added to carry it.
 */

/** Used when the reviewer declares components without naming the score. A key needs a non-empty value. */
const UNNAMED_SCORE = "Declared score";

export interface DeclaredScorePanelProps {
  jobId: string;
  /** True on the shared demo, which writes to the browser rather than the store. */
  pinned?: boolean;
  /**
   * The screen's own `composite_swap` decisions hook, when it reads the declaration too (Gate 1 does, to ask for
   * suggestions). ONE instance, shared: a second would hydrate once and never see this panel's later writes.
   * Absent → the panel keeps its own.
   */
  swaps?: UseGateDecisions;
  /**
   * Gate 1's free score SUGGESTIONS (08-28 Decision 6), when they are what seeds the scope: how many groups they put
   * in scope, for how many components — or, when none could be made, why (`unavailable`). `null` hides the note.
   */
  suggestionNote?: { nGroups: number; nComponents: number; unavailable: string } | null;
  /**
   * The free search's answer itself, when it is Gate 1's score input (no Gate 4 match, gate still open) — what the
   * per-component cards are drawn from. `null` (or no dense score in it) keeps the plain declared list.
   */
  suggestions?: ScoreSuggestions | null;
  /**
   * Where the free search is (user test 2026-11-03): `loading` while it runs — its first call on a run embeds every
   * variable, 93 seconds on dev, and a silent panel read as "nothing happened" — `error` when it failed (a failure used
   * to be dropped silently). Absent/`null` once there is an answer, or when none was asked for.
   */
  suggestionsStatus?: "loading" | "error" | null;
  /** The failed search's message, shown with `suggestionsStatus === "error"`. */
  suggestionsError?: string;
  /** Ask the free search again after a failure. */
  onRetrySuggestions?: () => void;
  /**
   * Each Spotlight LIST's cut-off (2026-11-08, "implement per list cutoff") — its own `gate1_score_cutoff` row, else
   * the run-wide row a run may already hold, else the payload's own. Absent → every list is split at the payload's.
   */
  cutoffOf?: (listName: string) => ListCutoff;
  /** Set (a number) or reset (`null`) ONE list's cut-off. Absent on a frozen gate → each list's is read-only. */
  onCutoffChange?: (listName: string, next: number | null) => void;
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
   * groupId → its Gate 1 group, ALREADY NAMED as Gate 1 names it (`namedGroupsById`: the reviewer's rename, their
   * own New groups and division parts included), so a match (or a retrieved-but-rejected candidate) can name its
   * concept group and link into the detail pane. The panel never re-derives a name — deriving it here, from the
   * pipeline's groups alone, is how a renamed group read under its old name and a New one as "Unnamed group".
   * Absent where the run has no groups (the demo's empty Gate 1).
   */
  groupsById?: Map<string, NamedGroup>;
  /** The run's cohorts (Gate 1's roster) — the columns of the score cards' reached-by-search table. */
  cohorts?: readonly string[];
  /** variableId ("cohort:var") → its concept groupId, so a variable-level retrieval candidate (a missing
   *  component's shortlist is variable-level) can be rolled up to the ONE group it belongs to — deduped and
   *  linkable — instead of listing many look-alike raw variables that cannot open a group. */
  groupByVariable?: Map<string, string>;
  /** cohort:var → its FieldDetail, so a variable-level match/candidate resolves to its name (not a raw id)
   *  in the candidate list. From the run's `fieldIndex`. */
  fieldIndex?: Record<string, FieldDetail>;
  /** Select a group in Gate 1's detail pane (the drag-drop screen) and scroll it into view, highlighting `matchedIds`. */
  onOpenGroup?: (groupId: string, matchedIds?: string[]) => void;
  /**
   * Gate 1 SCOPE for a group — the panel's group checkbox reads this, so "Gate 2 ✓" is literally what Gate 2
   * receives. Absent → the panel falls back to local state seeded from the auto-select threshold.
   */
  isGroupInScope?: (groupId: string) => boolean;
  /** Why a group is in Gate 1's scope — lets a suggestion card count only its own groups. */
  groupScopeWhy?: (groupId: string) => GroupScopeWhy;
  /** Write a group's Gate 1 scope (the ledger checkbox's own path). Absent on a frozen gate → read-only. */
  onGroupScopeChange?: (groupId: string, inScope: boolean) => void;
  /** Gate 1 has been passed: the panel is a record — nothing here may write (08-27 audit B4). */
  frozen?: boolean;
  /**
   * A PREVIEW run (08-31): the panel is the free search over this run's groups and nothing more. A Preview has no
   * scope (nothing goes on to Gate 2) and no match (it stops at Gate 1), so no scope control, no "in scope" count, no
   * verdict waiting on a match and no price for one. That it cannot match is said ONCE, by `matchRefusal` — the
   * Preview's own refusal, which the screen passes in — and nowhere else.
   */
  preview?: boolean;
  className?: string;
}

export function DeclaredScorePanel({
  jobId,
  pinned,
  preview = false,
  swaps: sharedSwaps,
  suggestionNote = null,
  suggestions = null,
  suggestionsStatus = null,
  suggestionsError,
  onRetrySuggestions,
  cutoffOf,
  onCutoffChange,
  spec,
  matchRefusal,
  onMatch,
  matching = false,
  groupsById,
  cohorts,
  groupByVariable,
  fieldIndex,
  onOpenGroup,
  isGroupInScope,
  groupScopeWhy,
  onGroupScopeChange,
  frozen = false,
  className,
}: DeclaredScorePanelProps) {
  const ownSwaps = useGateDecisions(jobId, "composite_swap", { pinned, frozen, enabled: !sharedSwaps });
  const swaps = sharedSwaps ?? ownSwaps;
  /** Closed by default (08-16c item E) — the charge it carries is stated on the trigger, not behind it. */
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [scoreName, setScoreName] = useState("");
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  /** The free read, kept WHOLE: it is sent to be extracted, and shown beside the proposal as its evidence. */
  const [document, setDocument] = useState<ReadDocument | null>(null);
  const [showDeclareForm, setShowDeclareForm] = useState(false);
  // Resolve a candidate id to a name + cohorts (+ the group's TRUE size, for the coverage line) for the
  // matched-group render — a GROUP id via `groupsById`, OR a variable-level candidate
  // id ("cohort:var") via the run's `fieldIndex`. Without the fieldIndex branch a variable candidate would
  // render as a raw "Cohort:var" id. `nMembers` is the denominator of "N of M members matched"; a variable
  // candidate has no group so it stays undefined and the coverage line degrades to "N members matched".
  const resolveConcept = useMemo(
    () => (id: string) => {
      const named = groupsById?.get(id);
      if (named)
        return {
          concept: named.name,
          generatedName: named.generatedName,
          cohorts: named.group.cohorts,
          nMembers: named.group.nMembers,
        };
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
  // Map any candidate id to the GROUP it should open: a group id resolves to itself; a variable id ("cohort:var")
  // rolls up to its concept group. This is what lets the candidate list dedupe by group and link — a missing
  // component's shortlist is variable-level (eight look-alike cancer-type variables all belong to one group),
  // and without the roll-up they render as eight dead, unlinkable rows.
  const resolveGroupId = useMemo(
    () => (id: string) => {
      if (groupsById?.has(id)) return id;
      return groupByVariable?.get(id);
    },
    [groupsById, groupByVariable],
  );

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

  /**
   * The CLOSED strip's status when a score is declared (H4), else `null` and the invitation stands. Read from the
   * persisted rows (`swaps.all`) and the derived spec — never from the draft — so it is what a reload shows too.
   */
  const status = stripStatus(swaps.all, spec, { preview });
  /** What was entered, for each declared score whose newest declaration was PASTED — from the persisted rows. */
  const pasted = useMemo(() => pastedRecords(swaps.all), [swaps.all]);

  const codingFor = (name: string) =>
    spec?.definition.components.find((c) => c.name === name)?.coding;
  const matchByComponent = useMemo(
    () => new Map((spec?.matches ?? []).map((m) => [m.component, m])),
    [spec],
  );

  /**
   * The declared Spotlight LISTS, in declaration order — each with its own concepts, the text that was entered when it
   * was pasted, its own cut-off, the free search's cards for its concepts split at THAT cut-off, and its share of the
   * evidence. A list is the reviewer's unit: with several declared, each one's concepts → groups sits under that list,
   * with its own cut-off (Bhargav, 2026-11-08).
   */
  const lists: SpotlightListData[] = useMemo(() => {
    const pastedBy = new Map(pasted.map((r) => [r.scoreName.trim(), r.text]));
    const byName = new Map<string, { name: string; names: string[]; pastedText?: string }>();
    for (const d of declared) {
      const name = d.scoreName.trim() || UNNAMED_SCORE;
      let list = byName.get(name);
      if (!list) {
        list = { name, names: [], pastedText: pastedBy.get(name) };
        byName.set(name, list);
      }
      list.names.push(d.name);
    }
    return [...byName.values()].map((list) => {
      const own = new Set(list.names.map((n) => n.toLowerCase()));
      // Only with a dense answer to split: a lexical score is never thresholded, so it has no cut-off to show.
      const cutoff = suggestions?.scored
        ? (cutoffOf?.(list.name) ?? { value: suggestions.threshold, own: false, fallback: suggestions.threshold })
        : null;
      return {
        name: list.name,
        nConcepts: list.names.length,
        pastedText: list.pastedText,
        cutoff,
        // The free search's cards, one per concept — `[]` keeps the plain list (no dense score, or none asked).
        cards: spec || !cutoff ? [] : suggestionCards(list.names, suggestions, cutoff.value),
        evidence: evidence.filter((e) => own.has(e.name.toLowerCase())),
      };
    });
  }, [declared, pasted, evidence, spec, suggestions, cutoffOf]);
  const hasCards = lists.some((l) => l.cards.length > 0);

  async function onDocument(file: File) {
    setReading(true);
    setReadError("");
    try {
      // $0 AND JOB-INDEPENDENT (08-11). Reading a document is free and nothing here makes it cost money:
      // finding out that a publisher PDF is an access-check interstitial, or that its component table did
      // not survive extraction, should not cost a derivation.
      const out = await extractScoreDocument(file);
      // The text is EVIDENCE, not a draft: it no longer lands in the components box for the reviewer to
      // prune (todo 2026-09-15). It is shown read-only beside the form, and a model can propose from it.
      setDocument({ text: out.text, sha256: out.sha256, nChars: out.nChars, provenance: out.provenance });
    } catch (e) {
      setReadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }

  async function onDeclare() {
    const name = scoreName.trim() || UNNAMED_SCORE;
    const components = declaredComponents(draft);
    // WHERE THE LIST CAME FROM, on every row (final review round 2): the box exactly as entered when no document
    // was read — the record of a pasted source — or the read document's handle (never its text) when one was.
    const source = declarationSource(draft, document, Date.now());
    await Promise.all(
      components.map((componentName) =>
        swaps.write(
          { scoreName: name, componentName },
          {
            // "None of these" — a declaration is not a match, and writing a concept id here without one
            // having been made would be the panel asserting the very thing it is asking to be paid for.
            chosen: "",
            alternatives: components,
            extra: { source },
          },
        ),
      ),
    );
  }

  /** A score is on the panel — declared here, or matched at Gate 4 — so the form to declare one folds away. */
  const hasScore = !!spec || declared.length > 0;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      // Addressable on the ROOT, exactly as `HowToPanel` is, so a spec can measure the strip rather than
      // reaching for it through the collapsible's markup — and so "is it the same height as the other
      // strip?" compares a container with a container.
      data-testid="score-strip"
      data-declared={status ? "true" : "false"}
      // The how-to strip's geometry, verbatim: ground surface, inner radius, same padding. This is the
      // difference between a second orientation strip and a fourth panel competing for the top of Gate 1.
      className={cn("rounded-inner bg-on-field/5 px-4 py-3", className)}
    >
      <CollapsibleTrigger
        data-testid="score-panel-toggle"
        // An icon-only control names the ACTION and its OBJECT; this one is not icon-only, but the same
        // rule governs what the name has to say.
        // The status rides the accessible name too (H4): an aria-label REPLACES the content, so without it a
        // screen reader would hear "show the panel" while the screen says a score is declared.
        aria-label={`${open ? "Hide" : "Show"} the Concept Spotlight panel${status ? ` — ${status}` : ""}`}
        className={disclosureRow("field", "gap-3")}
      >
        {/*
          ONE LINE, AT THE HOW-TO STRIP'S EXACT HEIGHT. Stacking the title over the summary made this
          strip 58px against the how-to's 40px, and every pixel here is spent from the ledger's own
          budget: Gate 1's first row already begins 1155px down a 900px viewport before this panel
          exists. A two-line header would be this change starting to compete with the data it sits above,
          which is a worse placement than the one it is fixing.
        */}
        {/* Concept Spotlight's one icon, everywhere it appears: the Flashlight (Bhargav's pick, review round 8 note 9 —
            it replaced the clipboard icon once the module was named for a spotlight). */}
        <Flashlight aria-hidden="true" className="h-4 w-4 shrink-0 text-on-field" />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {/* The module's NAME (Bhargav, 2026-10-13): Concept Spotlight — it surfaces the relevant groups from a sea of
              variables, whether the list is a published score or the reviewer's own. */}
          <DisclosureLabel ground="field">Concept Spotlight</DisclosureLabel>
          {status ? (
            /*
              A DECLARED SCORE SAYS SO ON THE CLOSED STRIP (H4, final review round 2 — *"still there — fix
              now"*). It used to read as the same invitation whether 48 components were declared or none, so a
              reviewer coming back to Gate 1 could not see from the top of the screen that their score was there.
              The status REPLACES the invitation rather than joining it: both would wrap the strip onto a second
              line, and this strip is one line at the how-to's height by design. The charge is not lost — every
              paid control inside is still priced inline, above the control — and the reviewer who declared has
              already met it. ONE LINE, truncated: a long score name ellipsizes, and the full line is the title.
            */
            <span
              data-testid="score-strip-status"
              title={status}
              className="min-w-0 flex-1 truncate text-xs font-semibold text-on-field"
            >
              {status}
            </span>
          ) : (
            /*
              THE FREE/PAID SPLIT, ON THE CLOSED STRIP. Collapsing this panel must not make the reviewer
              meet the charge later than they did when it was expanded at the foot of the page — so the
              summary states both halves here, where it is visible without opening anything. The priced
              copy inside is unchanged and still sits immediately above the control it prices.
            */
            <span className="min-w-0 text-xs text-on-field-muted">
              {/* A Preview cannot match, so its strip prices no match: it names the free search instead (08-31). */}
              {preview ? STRIP_SUMMARY_PREVIEW : STRIP_SUMMARY}
            </span>
          )}
        </span>
        <DisclosureChevron ground="field" open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <section
          data-testid="score-panel"
          aria-label="A Spotlight list you want this run to support"
          className="mt-3 flex flex-col gap-4 rounded-card bg-surface-raised px-6 py-4 shadow-card"
        >
          {/* ONCE A SCORE IS DECLARED, THE FORM FOLDS (review round 6, Bhargav: "hidden by default since a score has
              already been entered, collapsed panel should say declare a different score"). Before, only a Gate 4
              match folded it, so Gate 1 — which never has a match — kept the whole empty form open under a declared
              49-item score. */}
          {hasScore && (
            <button
              type="button"
              data-testid="score-declare-toggle"
              aria-expanded={showDeclareForm}
              onClick={() => setShowDeclareForm((v) => !v)}
              className={disclosureRow("raised")}
            >
              <DisclosureLabel ground="raised">Declare a different Spotlight list</DisclosureLabel>
              <DisclosureChevron ground="raised" open={showDeclareForm} />
            </button>
          )}
          {(!hasScore || showDeclareForm) && (
            <>
              {/* The TITLE leads the trigger above, so it is not repeated here; what stays is the sentence the title
                  never carried — including `PRESENCE_IS_PER_DICTIONARY`, one of the four rules this panel keeps saying.
                  ONE NOUN for the list's entries — concepts (Bhargav, 2026-11-08: "items and concepts dual usage is
                  confusing. stick to concepts"); this run's rows are its groups. */}
              <p className="max-w-[80ch] text-sm text-on-raised-muted">
                List the concepts to look for — a published score (a frailty index, an intrinsic-capacity score, an SES
                index) or a list of your own — and{" "}
                {/* A Preview's answer is the free search's, never a match (08-31). */}
                {preview
                  ? "a free search shows which of this run’s groups hold them."
                  : "this run will say which of its groups can supply them, and out of which."}{" "}
                {PRESENCE_IS_PER_DICTIONARY}
              </p>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="score-name"
                  className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted"
                >
                  List name
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
                  Its concepts, one per line
                </label>
                <Textarea
                  id="score-components"
                  data-testid="score-components"
                  rows={4}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={frozen}
                  placeholder={"Weak grip strength\nSlow walking speed\nUnintentional weight loss"}
                  className="rounded-inner"
                />
                {/* THE PAPER IS ANOTHER WAY TO FILL THIS BOX, so it sits under the box beside the declare action
                    (Bhargav, 2026-11-08: "move upload to below list text box"), not above the form. */}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={() => void onDeclare()}
                    disabled={frozen || draft.trim().length === 0}
                  >
                    Declare these concepts
                  </Button>
                  <div data-testid="score-upload">
                    <label className="flex w-fit cursor-pointer items-center gap-2 rounded-inner border border-rule-control-on-raised px-3 py-2 text-xs font-semibold text-on-raised">
                      {reading ? (
                        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
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
                  </div>
                </div>
                {document && (
                  <p data-testid="score-doc-read" className="text-xs text-on-raised">
                    Read {document.nChars.toLocaleString()} characters from {document.provenance}. The text is shown
                    beside the proposal — have a model propose the concepts from it, or type them yourself.
                  </p>
                )}
                {readError && (
                  <p data-testid="score-doc-error" role="alert" className="text-xs font-semibold text-status-danger">
                    {readError}
                  </p>
                )}
              </div>

              {document && (
                /* STEP 2 BESIDE ITS EVIDENCE. The proposal on the left, the free text it came from on the right — and the
                   text stays whatever the proposal's outcome, because it is the only way to notice something the model
                   missed. */
                <div className="grid gap-4 lg:grid-cols-2">
                  <ScoreComponentProposal
                    key={document.sha256}
                    document={document}
                    // The tab's held key, read AT THE PRESS (08-28): a key typed into the field is the next one sent.
                    extract={(doc) => extractScoreComponents(jobId, doc, heldRunKey())}
                    pinned={pinned}
                    frozen={frozen}
                    onAccept={(names, proposedName) => {
                      setDraft((d) => acceptedDraft(d, names));
                      if (!scoreName.trim() && proposedName) setScoreName(proposedName);
                    }}
                  />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-semibold text-on-raised">What was read — free</span>
                    <pre
                      data-testid="score-doc-text"
                      aria-label={`The text read from ${document.provenance}`}
                      className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-inner border border-rule-on-raised px-3 py-2 font-mono text-[11px] leading-5 text-on-raised-muted"
                    >
                      {document.text}
                    </pre>
                  </div>
                </div>
              )}
            </>
          )}

          {spec ? (
            <>
              {/* A matched score: its pasted record(s) above the spec, which carries the per-concept evidence. */}
              {lists
                .filter((list) => list.pastedText)
                .map((list) => (
                  <SpotlightList key={`${list.name}\u001f${list.pastedText}`} list={list} />
                ))}
              <SpecView
                spec={spec}
                conceptById={{}}
                records={[]}
                jobId={jobId}
                onOpenGroup={onOpenGroup}
                isGroupInScope={isGroupInScope}
                onGroupScopeChange={onGroupScopeChange}
                resolveConcept={resolveConcept}
                resolveGroupId={resolveGroupId}
                hideDerivation
              />
            </>
          ) : declared.length > 0 ? (
            <>
              {/* NO VERDICT BOX BEFORE A MATCH (Bhargav, 2026-11-08: "remove"). Without a spec nothing has been matched,
                  so the box could only ever read "Cannot be determined yet 0/N" — a wait, not a finding. The verdict
                  lives with the match (Gate 4's SpecView). */}

              {/* THE SEARCH SAYS WHERE IT IS (user test 2026-11-03). Running: it can take a minute or two on a run's
                  first search, and a panel showing only the Gate 4 note while it ran sent the tester to the demo.
                  Failed: said, with a way to ask again, rather than dropped. */}
              {suggestionsStatus === "loading" && (
                <p
                  data-testid="score-suggestions-loading"
                  role="status"
                  className="flex max-w-[80ch] items-center gap-2 rounded-inner border border-dashed border-rule-on-raised px-4 py-3 text-xs text-on-raised"
                >
                  <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
                  <span>
                    Searching this run&rsquo;s variables for your concepts — free, no model call. The first search on a
                    run can take a minute or two; the rest of this screen stays usable meanwhile.
                  </span>
                </p>
              )}
              {suggestionsStatus === "error" && (
                <div
                  data-testid="score-suggestions-error"
                  role="alert"
                  className="flex max-w-[80ch] flex-wrap items-center gap-3 rounded-inner border border-rule-on-raised px-4 py-3 text-xs text-on-raised"
                >
                  <span>
                    The free search did not come back{suggestionsError ? ` (${suggestionsError})` : ""}. Nothing was
                    charged, and your concepts are saved.
                  </span>
                  {onRetrySuggestions && (
                    <Button type="button" size="sm" variant="outline" data-testid="score-suggestions-retry" onClick={onRetrySuggestions}>
                      Search again
                    </Button>
                  )}
                </div>
              )}

              {/* Only WITHOUT the cards (round 6 repeated-copy): with them, the strip says it is a free search and the
                  verdict is Gate 4's, and each list's fold carries the counts — this note said all three again. */}
              {suggestionNote && !hasCards && (
                <p
                  data-testid="score-suggestions-note"
                  className="max-w-[80ch] rounded-inner border border-dashed border-rule-on-raised px-4 py-3 text-xs text-on-raised"
                >
                  {suggestionNote.unavailable ? (
                    suggestionNote.unavailable
                  ) : preview ? (
                    // A Preview has no scope to start anything in, and no Gate 4 to hand a verdict to (08-31).
                    suggestionNote.nGroups > 0 ? (
                      <>
                        A free search reached {suggestionNote.nGroups} group{suggestionNote.nGroups === 1 ? "" : "s"}{" "}
                        for {suggestionNote.nComponents} of these concepts; they are marked in the list.
                      </>
                    ) : (
                      "A free search reached no group closely enough to suggest one."
                    )
                  ) : suggestionNote.nGroups > 0 ? (
                    <>
                      {SUGGESTION_TAG_COPY}. It reached {suggestionNote.nGroups} group
                      {suggestionNote.nGroups === 1 ? "" : "s"} for {suggestionNote.nComponents} of these concepts;
                      they start in scope and are tagged “Suggested” in the list. Uncheck any you do not want — your
                      choice always wins.
                    </>
                  ) : (
                    <>
                      {SUGGESTION_TAG_COPY}. It reached no group closely enough to suggest one, so nothing was put in
                      scope for you — choose the groups yourself.
                    </>
                  )}
                </p>
              )}

              {/* SAID ONCE FOR EVERY LIST: how a suggestion is made. Each list's CUT-OFF is its own, in its fold. */}
              {hasCards && <ScoreSuggestionGuide preview={preview} />}

              {/*
                EACH LIST CARRIES ITS OWN CONCEPTS → GROUPS (Bhargav, 2026-11-08: "should appear under the relevant
                list if there are multiple, and self contained into a dropdown"). With the free search's answer in hand
                that is the cards (08-28, option A); without one, the plain declared rows stand.
              */}
              {lists.map((list) => (
                <SpotlightList key={`${list.name}\u001f${list.pastedText ?? ""}`} list={list}>
                  {list.cards.length > 0 && list.cutoff ? (
                    <>
                      {/* THE LIST'S OWN CUT-OFF, above the table and the concepts it splits (2026-11-08). */}
                      <ScoreCutoffLine
                        preview={preview}
                        listName={list.name}
                        value={list.cutoff.value}
                        resetTo={list.cutoff.own ? list.cutoff.fallback : null}
                        onChange={frozen || !onCutoffChange ? undefined : (next) => onCutoffChange(list.name, next)}
                      />
                      <ScoreSuggestionCards
                        preview={preview}
                        cards={list.cards}
                        threshold={list.cutoff.value}
                        groupsById={groupsById}
                        cohorts={cohorts}
                        fieldIndex={fieldIndex}
                        isGroupInScope={isGroupInScope}
                        groupScopeWhy={groupScopeWhy}
                        onGroupScopeChange={frozen ? undefined : onGroupScopeChange}
                        onOpenGroup={onOpenGroup}
                      />
                    </>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {list.evidence.map((e) => (
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
                  )}
                </SpotlightList>
              ))}
              {/* Said once for the panel (round 5 sweep), when a looked-for concept has no match. */}
              {evidence.some((e) => e.searched && !e.matched) && (
                <p data-testid="missing-is-a-run-result" className="text-xs text-on-raised-muted">
                  {MISSING_IS_A_RUN_RESULT}
                </p>
              )}
            </>
          ) : null}

          {/* THE PAID BOUNDARY, priced inline and never behind a modal. On a Preview there is nothing to price — it
              cannot match — so only the refusal stands, and it is the one place the panel says so (08-31). */}
          {!spec && (
          <div className="flex flex-col gap-2 border-t border-rule-quiet-on-raised pt-3">
            {!preview && (
            <p
              data-testid="score-match-price"
              className="max-w-[80ch] text-xs font-semibold text-on-raised"
            >
              Matching these concepts onto this run&rsquo;s groups costs
              money: it is one model call over the concepts, and it is what
              turns a declaration into a verdict. Nothing is charged until you
              press it.
            </p>
            )}
            {matchRefusal ? (
              <NotAvailable
                thing="Matching the concepts"
                claim={matchRefusal.claim}
              >
                {matchRefusal.reason}
              </NotAvailable>
            ) : (
              <div>
                <Button
                  type="button"
                  onClick={onMatch}
                  disabled={frozen || matching || declared.length === 0}
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

/** One declared Spotlight list, as the panel renders it. */
interface SpotlightListData {
  name: string;
  nConcepts: number;
  /** The box exactly as entered, when the list was pasted rather than read from a document. */
  pastedText?: string;
  /** This list's cut-off, when there is a dense free-search answer to split at it; `null` otherwise. */
  cutoff: ListCutoff | null;
  cards: SuggestionCard[];
  evidence: ComponentEvidence[];
}

/**
 * One declared Spotlight list, as ONE FOLD (Bhargav, 2026-11-08 round 2: "the block should be collapsible at this
 * level"). The trigger is the list: its NAME (round 1 — not "What was entered — pasted text"; the name field's
 * placeholder when it has none), how many concepts it holds, and — once the free search has answered — how many of them
 * reached a group. Inside: the text that was entered, when the list was pasted, and the list's concepts → groups
 * (`children`). Open until closed. One fold per list, so several declared lists each carry their own.
 *
 * THE ENTERED TEXT FOLDS ONLY WHEN LONG, and then starts CLOSED: a record past what the document box shows unscrolled
 * (`isLongRecord`) would push the list's concepts a screen down. A short one is shown whole, with nothing to open. Both
 * toggles are view controls, so they work on a passed gate too.
 */
function SpotlightList({
  list,
  className,
  children,
}: {
  list: SpotlightListData;
  className?: string;
  children?: React.ReactNode;
}) {
  const [listOpen, setListOpen] = useState(true);
  const text = list.pastedText;
  const long = text ? isLongRecord(text) : false;
  const [textOpen, setTextOpen] = useState(!long);
  const textId = `score-paste-text-${list.name.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
  const counts = list.cards.length > 0 ? suggestionCounts(list.cards) : null;
  return (
    <Collapsible
      open={listOpen}
      onOpenChange={setListOpen}
      data-testid="spotlight-list"
      data-score={list.name}
      className={cn(FOLD_BOX, className)}
    >
      <CollapsibleTrigger data-testid="spotlight-list-toggle" className={disclosureRow("raised", "group")}>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span data-testid="spotlight-list-name" className="text-sm font-semibold text-on-raised">
            {list.name}
          </span>
          <span className="text-xs text-on-raised-muted">
            {list.nConcepts} {list.nConcepts === 1 ? "concept" : "concepts"}
            {counts && (
              <>
                {" "}
                · {counts.nWith}/{list.cards.length} with a suggestion · {counts.nGroups} group
                {counts.nGroups === 1 ? "" : "s"} suggested
              </>
            )}
          </span>
        </span>
        <DisclosureChevron ground="raised" open={listOpen} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2">
        {text && (
          <div
            data-testid="score-paste-record"
            data-score={list.name}
            data-long={String(long)}
            className="flex min-w-0 flex-col gap-1"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              {long ? (
                <button
                  type="button"
                  data-testid="score-paste-toggle"
                  aria-expanded={textOpen}
                  aria-controls={textOpen ? textId : undefined}
                  onClick={() => setTextOpen((o) => !o)}
                  className="flex items-center gap-1 text-xs font-semibold text-on-raised underline decoration-rule-control-on-raised"
                >
                  {textOpen ? "Hide what was entered" : "Show what was entered"}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn("h-3.5 w-3.5 shrink-0 transition-transform", textOpen && "rotate-180")}
                  />
                </button>
              ) : (
                <span className="text-xs font-semibold text-on-raised">What was entered</span>
              )}
              <span className="font-mono text-[11px] tabular-nums text-on-raised-muted">{recordSize(text)}</span>
            </div>
            {textOpen && (
              <pre
                id={textId}
                data-testid="score-paste-text"
                aria-label={`The text entered for ${list.name}`}
                className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-inner border border-rule-on-raised px-3 py-2 font-mono text-[11px] leading-5 text-on-raised-muted"
              >
                {text}
              </pre>
            )}
          </div>
        )}
        {children}
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
  groupsById?: Map<string, NamedGroup>;
  onOpenGroup?: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const componentVerdict = componentVerdictFor(evidence);
  const matchedNamed = match?.conceptId ? groupsById?.get(match.conceptId) : undefined;
  const matchedGroup = matchedNamed?.group;
  // The candidates retrieval offered, minus the one that was chosen — the "also considered" for a match,
  // the "retrieved and rejected" for a miss. Only those we can name (present in `groupsById`) are shown.
  const otherCandidates = (match?.shortlist ?? [])
    .filter((id) => id !== match?.conceptId)
    .map((id) => ({ id, named: groupsById?.get(id) }))
    .filter((c): c is { id: string; named: NamedGroup } => !!c.named);
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
        // the row. The name is the one Gate 1 shows (`namedGroupsById`, #1) so an unnamed residual reads "Unnamed
        // group", never a raw group id, and a renamed group reads under the reviewer's name.
        const summary = evidence.matched
          ? `Matched: ${matchedNamed ? matchedNamed.name : match?.concept?.trim() || "—"}`
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
                <span className="text-sm font-semibold text-on-raised">
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
                {matchedNamed?.name}
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
              <span className="text-sm font-semibold text-on-raised">
                {matchedGroup
                  ? "Other concepts retrieved"
                  : "Concepts retrieved — none measured this"}
              </span>
              {otherCandidates.map(({ id, named: { group, name } }) => (
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
                    {name}
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
