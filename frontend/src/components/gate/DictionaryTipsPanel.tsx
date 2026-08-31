import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Before you upload — a CHECKLIST, one imperative line per thing to fix.
 *
 * REWRITTEN IN 08-14f, hours after 08-14d shipped it. That is not waste: 08-14d wrote it for a world in
 * which the product still preprocessed uploaded dictionaries, so its register was "here is a pitfall, here
 * is why it costs you, here is what to do" — three sentences a bullet. 08-14e makes preparation opt-in and
 * OFF, which moves the work to the reviewer, and Bhargav read the result live on 2026-08-31 and said the
 * panel was too verbose to act on. Advice a reviewer has to READ is advice they skip; advice they can SCAN
 * is advice they follow. So: directives, one line each, one concrete example each, seven at most.
 *
 * WHERE THE CONTENT COMES FROM. Not from imagination — each bullet is one rule `preprocess_dictionary`
 * implements in core, in core's own order, carrying core's own example. Those rules exist because real
 * dictionaries do the thing they fix, which makes this list empirical rather than invented. With
 * preparation off, the list is now the reviewer's job description.
 *
 * IT LEADS WITH THE ONE NOTHING CAN FIX FOR THEM. `load_dictionary` keys fields on the variable name and
 * the last row bearing a repeat wins, so the earlier rows are gone before any rule runs — 658 of them
 * across two public catalogues in the D-1 measurement. It CROSS-REFERENCES the live check rather than
 * restating it: this list names the class, and the mapping table on this same screen reports the
 * reviewer's actual file as the mapping changes. Two surfaces stating one finding differently is how both
 * become untrustworthy (08-DECISION-GATE0 D-4).
 *
 * NO COHORT IS NAMED, and the examples are de-branded rather than quoted verbatim where core's docstring
 * happens to carry a cohort name. 08-14f asked for "that rule's own example"; CLAUDE.md's cohort-agnostic
 * rule is the stronger constraint and wins, so the example keeps the real SHAPE (a stock sentence pointing
 * at an external website) and drops the brand. The shape is what teaches — and naming a partner cohort as
 * an example of doing it wrong publishes an internal judgement about their data on a screen a guest can
 * reach. A shipped gate asserts this, on purpose.
 *
 * RENDERED IN THE COMPOSE STATE ONLY, and CLOSED by default, so it costs one row until it is asked for.
 */

interface Check {
  /** The directive. Imperative, one line. */
  do: string;
  /** Exactly one concrete specimen, rendered as a visibly separate thing from the directive. */
  example: string;
}

const CHECKS: Check[] = [
  {
    do: "Give every row a variable name that appears only once.",
    example: "two rows named bmi — only the last survives loading, and the first is gone silently",
  },
  {
    do: "Strip the instrument wrapper and leave the question the participant was asked.",
    example: 'ACE touchscreen question "Do you smoke?"  →  Do you smoke?',
  },
  {
    do: "Clear a description that only repeats one of that variable's own answer labels.",
    example: 'a description that is literally "Do not know"',
  },
  {
    do: "Replace a boilerplate description shared by many variables, or leave it empty.",
    example: "Field description available on the study website, repeated on hundreds of rows",
  },
  {
    do: "Drop a prefix that every variable name shares.",
    example: "SURVEY_A_bmi, SURVEY_A_age  →  bmi, age",
  },
  {
    do: "Do not repeat the variable name inside its own description.",
    example: "bmi  →  bmi: body mass index, which embeds the code twice and the meaning once",
  },
  {
    do: "Export as UTF-8 and strip markup, entities and stray whitespace.",
    // The tag is written literally: this is a JS string in a JSX text position, so React escapes it for
    // display — writing the ENTITY here would show the reviewer `&lt;br&gt;` rather than the `<br>` their
    // file actually contains, which is the wrong specimen.
    example: "Weight (kgâ€​), <br> and curly quotes all survive a bad export",
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
            ? "Hide the checklist of what to fix in your dictionary before uploading it"
            : "Show the checklist of what to fix in your dictionary before uploading it"
        }
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">
          Before you upload — check your dictionary
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-on-field-muted transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-3 flex flex-col gap-2">
          {CHECKS.map((check) => (
            <li key={check.do} data-testid="dictionary-tip" className="flex flex-col">
              <span data-testid="dictionary-tip-do" className="max-w-[78ch] text-sm text-on-field">
                {check.do}
              </span>
              {/* THE EXAMPLE IS ITS OWN ELEMENT, monospaced and muted, so it reads AS a specimen rather
                  than as a second half of the instruction. */}
              <span
                data-testid="dictionary-tip-example"
                className="max-w-[78ch] font-mono text-xs text-on-field-muted"
              >
                e.g. {check.example}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 max-w-[78ch] text-xs text-on-field-muted">
          The first one is the only one nothing downstream can undo — the mapping table below reports it
          for your actual file the moment you map a variable-name column. Automated preparation is
          forthcoming; until it ships, this list is the cheapest fix available.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
