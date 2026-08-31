import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, FileText, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { useGateDecisions } from "@/hooks/use-gate-decisions";
import { extractScoreDocument } from "@/lib/api";
import { cn } from "@/lib/utils";
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
import type { CompositeSpec } from "@/types";

/**
 * The declared-score panel — a SECTION OF THE GATE 1 BODY.
 *
 * NOT ITS OWN SCREEN, not a step between Setup and Gate 1, and not a modal. A pre-gate screen would
 * interrupt a purchase decision to pitch an add-on, which is the pattern this whole review has been
 * removing; the reviewer reaches this without leaving the ledger.
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

const VERDICT_STYLE: Record<ScopeVerdict, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  full: { label: "Every component is present", className: "border-rule-ok bg-surface-ok text-on-ok", Icon: CheckCircle2 },
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
  matchRefusal: { claim: "deferred" | "failed" | "not-enabled"; reason: React.ReactNode } | null;
  onMatch?: () => void;
  matching?: boolean;
  className?: string;
}

export function DeclaredScorePanel({
  jobId,
  pinned,
  spec,
  matchRefusal,
  onMatch,
  matching = false,
  className,
}: DeclaredScorePanelProps) {
  const swaps = useGateDecisions(jobId, "composite_swap", { pinned });
  const [draft, setDraft] = useState("");
  const [scoreName, setScoreName] = useState("");
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [document, setDocument] = useState<{ provenance: string; nChars: number } | null>(null);

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
        out.push({ scoreName: spec?.definition.name || UNNAMED_SCORE, name: c.name });
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
    const byComponent = new Map((spec?.matches ?? []).map((m) => [m.component, m]));
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
  const codingFor = (name: string) => spec?.definition.components.find((c) => c.name === name)?.coding;

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
    <section
      data-testid="score-panel"
      aria-label="A published score you want this run to support"
      className={cn("flex flex-col gap-4 rounded-card bg-surface-raised px-6 py-4 shadow-card", className)}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-on-raised">A score you want to build from this run</h2>
        <p className="max-w-[80ch] text-sm text-on-raised-muted">
          Name the components of a published score — a frailty index, an intrinsic-capacity score, an SES
          index — and this run will say which of them its concepts can supply, and out of which.{" "}
          {PRESENCE_IS_PER_DICTIONARY}
        </p>
      </div>

      {/* THE FREE HALF. Reading a document costs nothing and the copy says so. */}
      <div data-testid="score-upload" className="flex flex-col gap-2">
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
        <p className="max-w-[80ch] text-xs text-on-raised-muted">
          Reading the document costs nothing — no model is called. It pulls the text out so you can see
          whether the component table survived extraction before anything is spent on it.
        </p>
        {document && (
          <p data-testid="score-doc-read" className="text-xs text-on-raised">
            Read {document.nChars.toLocaleString()} characters from {document.provenance}. Copy the
            component names out of it below.
          </p>
        )}
        {readError && (
          <p data-testid="score-doc-error" role="alert" className="text-xs font-semibold text-status-danger">
            {readError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="score-name" className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
          Score name
        </label>
        <input
          id="score-name"
          value={scoreName}
          onChange={(e) => setScoreName(e.target.value)}
          placeholder={UNNAMED_SCORE}
          className="min-h-8 rounded-inner border border-rule-control-on-raised bg-surface-raised px-2 py-1 text-sm text-on-raised"
        />
        <label htmlFor="score-components" className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
          Its components, one per line
        </label>
        <Textarea
          id="score-components"
          data-testid="score-components"
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={"Weak grip strength\nSlow walking speed\nUnintentional weight loss"}
          className="rounded-inner"
        />
        <div>
          <Button type="button" onClick={() => void onDeclare()} disabled={draft.trim().length === 0}>
            Declare these components
          </Button>
        </div>
      </div>

      {declared.length > 0 && (
        <>
          <div
            data-testid="score-verdict"
            data-verdict={verdict}
            className={cn("flex flex-col gap-1 rounded-inner border px-4 py-3", style.className)}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <style.Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              {style.label}
              <span className="font-mono text-xs tabular-nums">
                {evidence.filter((e) => e.matched).length}/{evidence.length}
              </span>
            </span>
            <span className="max-w-[80ch] text-xs">{SCOPE_VERDICT_COPY[verdict]}</span>
            {/* Rule 3: this is what stops `partial` reading as a qualified yes. */}
            {verdict === "partial" && <span className="max-w-[80ch] text-xs">{PARTIAL_IS_NOT_THE_SCORE}</span>}
          </div>

          <ul className="flex flex-col gap-2">
            {evidence.map((e) => {
              const componentVerdict = componentVerdictFor(e);
              const coding = codingFor(e.name);
              return (
                <li
                  key={e.name}
                  data-testid="score-component"
                  data-verdict={componentVerdict}
                  className="flex flex-col gap-1 rounded-inner border border-rule-on-raised px-3 py-2"
                >
                  <span className="text-sm font-semibold text-on-raised">{e.name}</span>
                  <span className="max-w-[80ch] text-xs text-on-raised-muted">
                    {e.matched
                      ? `Matched to a concept in this run: ${
                          spec?.matches.find((m) => m.component === e.name)?.concept ?? "—"
                        }`
                      : missingReason(e)}
                  </span>
                  {/* Rule 2: a cutoff the source did not state is flagged, never derived. */}
                  {coding && !coding.cutoff && !coding.referenceRange && (
                    <span data-testid="score-cutoff-unstated" className="max-w-[80ch] text-xs text-on-warn">
                      {CUTOFF_UNSTATED}
                    </span>
                  )}
                  {coding && (coding.cutoff || coding.referenceRange) && (
                    <span className="text-xs text-on-raised-muted">
                      As stated in the source:{" "}
                      <span className="font-mono">{coding.cutoff || coding.referenceRange}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* THE PAID BOUNDARY, priced inline and never behind a modal. */}
      <div className="flex flex-col gap-2 border-t border-rule-quiet-on-raised pt-3">
        <p data-testid="score-match-price" className="max-w-[80ch] text-xs font-semibold text-on-raised">
          Matching these components onto this run&rsquo;s concepts costs money: it is one model call over
          the concepts, and it is what turns a declaration into a verdict. Nothing is charged until you
          press it.
        </p>
        {matchRefusal ? (
          <NotAvailable thing="Matching the components" claim={matchRefusal.claim}>
            {matchRefusal.reason}
          </NotAvailable>
        ) : (
          <div>
            <Button type="button" onClick={onMatch} disabled={matching || declared.length === 0}>
              {matching && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}
              Match them against this run
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
