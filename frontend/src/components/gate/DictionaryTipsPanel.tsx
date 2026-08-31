import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Dictionary-hygiene tips — what replaces the deleted preprocessing report (08-14d).
 *
 * WHY IT IS SMALL, and the smallness is the requirement. 08-14b moved the demoted Gate 0 onto Setup as a
 * pre-flight report. Bhargav read it live on 2026-08-31 and retired it: the verbosity buried the screen
 * and a reviewer would get lost in the text. A long list of tips would be that same failure in a
 * friendlier voice, so this is SIX pitfalls, closed by default, one line of what-to-do each. The spec
 * bounds the count on both sides.
 *
 * WHERE THE CONTENT COMES FROM. Not from imagination. Each pitfall corresponds to a rule
 * `preprocess_dictionary` already implements in core — unicode repair, administrative-text stripping,
 * option-echo clearing, placeholder-description replacement, common-prefix stripping, whitespace
 * normalisation — which is the empirical record of what real dictionaries actually get wrong, plus the
 * repo's recorded loader gotchas. Cohort-agnostic by construction: no cohort is named as an example of
 * doing it wrong, because the rules are generic and discovered, and because a guest can reach this screen.
 *
 * IT LEADS WITH THE ONE THE PRODUCT CANNOT FIX. `load_dictionary` keys on the variable name and the last
 * row with a repeated one wins, so the earlier rows are gone before any rule runs. It CROSS-REFERENCES
 * `nameCheck` rather than restating it: this list explains the class, and the mapping table on this same
 * screen reports the reviewer's actual file, live, as the mapping changes. Two surfaces stating one
 * finding differently is how both become untrustworthy (`08-DECISION-GATE0.md` D-4).
 *
 * THE FORTHCOMING SENTENCE CLAIMS NOTHING ABOUT TODAY. Its companion plan 08-14e turns the preparation
 * stage off in core, and this plan must not depend on having landed after it — so the copy states only
 * that automated preparation is coming, which is true either way.
 *
 * RENDERED IN THE COMPOSE STATE ONLY. A run's column mapping is fixed at `startHarmonize`, so from the
 * boundary onwards none of this is actionable without starting again. Advice you cannot take is noise on
 * a screen that was just cleared of noise.
 */

interface Tip {
  /** The problem, named. */
  what: string;
  /** Why it costs the reviewer something — one sentence. */
  why: string;
  /** What to do about it — one line. */
  fix: string;
}

const TIPS: Tip[] = [
  {
    what: "The same variable name on more than one row",
    why:
      "Rows are keyed on the variable name, so when two share one only the last survives and the earlier " +
      "variables are gone before any other step runs.",
    fix: "Map a column whose value is unique to each row — the mapping table on this screen checks your file and reports the count.",
  },
  {
    what: "The wording you want the model to read is in a column you did not map",
    why:
      "Dictionaries often keep the participant-facing question in a notes or comment column and leave a " +
      "short internal code in the description, so the model reads the code.",
    fix: "Map whichever column holds the actual question wording as the question text.",
  },
  {
    what: "One boilerplate sentence repeated as the description of many variables",
    why:
      "A sentence shared by hundreds of variables cannot tell them apart, so they group on the boilerplate " +
      "rather than on what they measure.",
    fix: "Give each variable its own description, or leave the field empty rather than filling it with a stock line.",
  },
  {
    what: "A description that just repeats one of the variable's own answer labels",
    why: "An answer option is not a description of the question, and it pulls the variable towards other variables that happen to share that answer.",
    fix: "Describe what the variable measures; leave the answer labels in the response-options column.",
  },
  {
    what: "Administration and validation prose mixed in with the question",
    why:
      "Interviewer instructions, range checks and help text are usually longer than the question itself, " +
      "so they dominate the text the model sees.",
    fix: "Keep the question the participant was asked; move the administration notes to a column you do not map.",
  },
  {
    what: "Encoding damage and stray markup",
    why:
      "A file exported through the wrong encoding carries mojibake and curly-quote artifacts, and HTML " +
      "tags, invisible characters and runs of whitespace travel with copied-in text.",
    fix: "Export as UTF-8 and strip markup before uploading.",
  },
];

export function DictionaryTipsPanel({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="dictionary-tips"
      className={cn("rounded-inner bg-on-field/5 px-4 py-3", className)}
    >
      <CollapsibleTrigger
        // States the ACTION and its OBJECT in both directions — an icon-only control whose name does not
        // say what it operates on is a defect, not a style choice (UI-SPEC §6).
        aria-label={
          open
            ? "Hide how to prepare your data dictionary before uploading"
            : "Show how to prepare your data dictionary before uploading"
        }
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">
          Before you upload — what to check in your dictionary
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-on-field-muted transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-3 flex flex-col gap-3">
          {TIPS.map((tip) => (
            <li key={tip.what} data-testid="dictionary-tip" className="flex flex-col gap-0.5">
              <span data-testid="dictionary-tip-what" className="text-sm font-semibold text-on-field">
                {tip.what}
              </span>
              <span className="max-w-[68ch] text-sm text-on-field-muted">{tip.why}</span>
              <span data-testid="dictionary-tip-fix" className="max-w-[68ch] text-sm text-on-field">
                {tip.fix}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 max-w-[68ch] text-sm text-on-field-muted">
          Automated preparation of uploaded dictionaries is forthcoming. Until it ships, reading through
          your file against this list before you upload it is the cheapest fix available — and the only
          one you can be sure of.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
