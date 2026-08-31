import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ROLE_FORMAT } from "@/types";

/**
 * Which column is which — the mapping-role reference, and the bare minimum stated plainly.
 *
 * WHY IT IS SEPARATE FROM THE CHECKLIST. They answer different questions at different moments: *"is my
 * file clean enough to upload?"* before the reviewer picks a file, and *"which column is which?"* while
 * they are staring at the mapping table. Merging them makes one long panel that answers neither quickly,
 * which is exactly the verbosity that got the previous version rewritten.
 *
 * THE BARE MINIMUM IS THE HEADLINE, and that is a product decision rather than a layout one: a reviewer
 * who believes they must map twelve columns will not start. It is small, and saying so is the point.
 *
 * REQUIRED VS OPTIONAL IS MARKED AGAINST `to_embedding_text`'s ACTUAL BEHAVIOUR, read from core rather
 * than from intuition, because intuition gets two of them backwards:
 *
 *   * `question_text` OUTRANKS `description` — core composes `question_text or description`, so mapping
 *     a definition into `question_text` silently replaces the wording the model reads. The UI's own
 *     display derivation reads them the other way round, which is how easy this is to get wrong.
 *   * `category` IS APPENDED to the embedded string (`… | Category: Diet`), so it is optional but it
 *     genuinely changes clustering. Filing it beside units — the obvious grouping, since both are
 *     "extra" — would be wrong.
 *   * `value_encoding`, `data_type` and `units` are deliberately EXCLUDED from the semantic vector and
 *     routed to prompts instead. Value metadata is symbolic; putting it in the geometry is noise.
 *
 * The groupings are core's own (`FieldRole`'s docstring), so the panel reads in the order the model
 * thinks in. Only the roles this screen can actually MAP are listed — documenting a role with no control
 * behind it is worse than omitting it.
 *
 * THE `variable_name` ESCAPE HATCH (08-14g) IS MEASURED, and the measurement corrected the plan that
 * asked for it. Fixtures of six rows all named "Q1", loaded against core on 2026-08-31:
 *
 *   variable_name mapped to the repeating column       field_count 1 of 6   the silent collapse
 *   variable_name + field_id unmapped, description      field_count 6 of 6   the hatch works
 *   variable_name + field_id unmapped, question_text    field_count 0 of 6   the file VANISHES
 *   ditto, description blank on two rows                field_count 4 of 6   those two rows dropped
 *
 * The third row is the whole reason this copy names DESCRIPTION rather than "question text or a
 * description". `csv_parser` derives the description as description → short_label → variable_name and
 * REFUSES the synthetic `_ROW_` name, so a row with none of those is `continue`d away (`csv_parser.py:132`)
 * before embedding is reached. `question_text` is not in that chain. `short_label` is, but this screen
 * cannot map it, so on this screen the precondition is exactly "a description on every row".
 *
 * That also means `to_embedding_text`'s variable_name fallback — the mechanism the plan cited — is NOT
 * what a reviewer hits: the row is gone before it could embed its own identifier. "Dropped" is the honest
 * word and it is the stronger warning, so the copy uses it.
 *
 * `_ROW_00042` is shown as a SPECIMEN, never promised: it is an implementation detail of core's fallback
 * and may change. What is promised is that the identifier is generated and unique per row.
 */

interface RoleDoc {
  role: string;
  /** One line on what belongs in the column. */
  gloss: string;
  /** Whether the value reaches the string that gets clustered. */
  clustered: boolean;
  /**
   * Where it goes when it is not clustered — stated, so "not clustered" does not read as "ignored".
   *
   * A VERB PHRASE completing "It …": the renderer wraps it as `It {instead}.`, so "kept for provenance"
   * produces "It kept for provenance." Caught by reading the rendered screen, not the source.
   */
  instead?: string;
  example?: string;
  /**
   * An ESCAPE HATCH for one named situation — rendered apart from the gloss, because it is advice for the
   * reviewer who already knows their file is the odd case, not a recommendation for everyone.
   */
  escapeHatch?: string;
}

interface RoleGroup {
  heading: string;
  roles: RoleDoc[];
}

const GROUPS: RoleGroup[] = [
  {
    heading: "Core",
    roles: [
      {
        role: "variable_name",
        gloss: "The field's own name. Clustered ONLY when there is no question text and no description.",
        clustered: true,
        example: "bmi, age_at_enrollment",
        escapeHatch:
          "Names repeat but each row's text is its own? Leave this and field_id unmapped — every row " +
          "gets its own generated identifier (today _ROW_00042) and nothing collapses. Two conditions: " +
          "a description on every row, since question_text does not stand in here and a row without one " +
          "is dropped rather than left unnamed; and that identifier is what you see wherever the " +
          "variable is named, exports included.",
      },
      {
        role: "description",
        gloss: "What the variable means — the definition. Clustered when no question text is mapped.",
        clustered: true,
        example: "Body mass index derived from height and weight",
      },
      {
        role: "field_id",
        gloss: "A numeric or catalogue id, when it is distinct from the name. Not clustered.",
        clustered: false,
        instead: "is kept for provenance",
        example: "21001",
      },
    ],
  },
  {
    heading: "Context",
    roles: [
      {
        role: "question_text",
        gloss: "The wording actually asked of the participant. This WINS over description when both exist.",
        clustered: true,
        example: "What is your standing height?",
      },
    ],
  },
  {
    heading: "Organization",
    roles: [
      {
        role: "category",
        gloss: "The domain, section or form. Optional — but it IS appended to the clustered string.",
        clustered: true,
        example: "Demographics, Diet",
      },
    ],
  },
  {
    heading: "Values and coding",
    roles: [
      {
        role: "value_encoding",
        gloss: "The permissible values, inline. Does NOT affect clustering.",
        clustered: false,
        instead: "feeds transform-spec generation, which is how two cohorts' codes get reconciled",
        example: ROLE_FORMAT.value_encoding?.split("e.g.")[1]?.trim() ?? "1=Male|2=Female|3=Other",
      },
      {
        role: "standard_code",
        gloss: "An ontology code for the concept. Not clustered.",
        clustered: false,
        instead: "is carried through as provenance",
        example: "LOINC:12345-6",
      },
    ],
  },
  {
    heading: "Typing and measurement",
    roles: [
      {
        role: "data_type",
        gloss: "What kind of value it is. Deliberately excluded from the semantic vector.",
        clustered: false,
        instead: "is used in the harmonization prompts",
        example: "categorical, continuous, date",
      },
      {
        role: "units",
        gloss: "The unit of measure. Deliberately excluded from the semantic vector.",
        clustered: false,
        instead: "is used in the prompts, and in unit-conversion specs",
        example: "kg, mmHg, years",
      },
    ],
  },
];

export function ColumnRolesPanel({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="column-roles"
      className={cn("rounded-inner bg-on-field/5 px-4 py-3", className)}
    >
      <CollapsibleTrigger
        aria-label={
          open
            ? "Hide the reference explaining what each column-mapping role means"
            : "Show the reference explaining what each column-mapping role means"
        }
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">
          What each column role means, and the bare minimum
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 text-on-field-muted transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p data-testid="roles-bare-minimum" className="mt-3 max-w-[78ch] text-sm text-on-field">
          <span className="font-semibold">The bare minimum is two things:</span> a variable identifier, and{" "}
          <span className="font-semibold">at least one of</span> <span className="font-mono">question_text</span>{" "}
          or <span className="font-mono">description</span>. A variable with neither embeds only its name —
          or nothing at all, if that name is an opaque code. Everything else is enrichment.
        </p>
        <p data-testid="roles-precedence" className="mt-2 max-w-[78ch] text-sm text-on-field-muted">
          <span className="font-semibold text-on-field">
            <span className="font-mono">question_text</span> wins when both are present.
          </span>{" "}
          So put the verbatim wording asked of the participant in{" "}
          <span className="font-mono">question_text</span> and the definition in{" "}
          <span className="font-mono">description</span>. Mapping them the wrong way round silently changes
          what gets clustered — nothing fails, the answers are just about a different text.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {GROUPS.map((group) => (
            <div key={group.heading} className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">
                {group.heading}
              </span>
              <ul className="flex flex-col gap-1.5">
                {group.roles.map((r) => (
                  <li
                    key={r.role}
                    data-testid="column-role"
                    // The clustered/not-clustered fact as DATA as well as words: it is the one property a
                    // gate has to read, and parsing it back out of a sentence breaks on a copy edit
                    // rather than on a wrong answer.
                    data-clustered={String(r.clustered)}
                    className="flex flex-col"
                  >
                    <span className="max-w-[78ch] text-sm text-on-field">
                      <span data-role={r.role} className="font-mono font-semibold">
                        {r.role}
                      </span>{" "}
                      — {r.gloss}
                      {r.instead ? ` It ${r.instead}.` : ""}
                    </span>
                    {r.example && (
                      <span className="max-w-[78ch] font-mono text-xs text-on-field-muted">e.g. {r.example}</span>
                    )}
                    {/* SET APART from the gloss and the example both. It is neither — it is a way out of
                        one specific bind, and a reviewer whose file is not in that bind should be able to
                        skip it on sight. */}
                    {r.escapeHatch && (
                      <span
                        data-testid="role-escape-hatch"
                        className="mt-1 max-w-[78ch] border-l-2 border-on-field/20 pl-2 text-xs text-on-field-muted"
                      >
                        {r.escapeHatch}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
