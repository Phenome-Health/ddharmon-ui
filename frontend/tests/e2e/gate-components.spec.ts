import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * The gate component vocabulary (08-12 Task 3).
 *
 * WHY THESE ARE SOURCE ASSERTIONS. Nothing mounts these components yet — 08-13 through 08-17 each compose
 * one screen from them, and every gate route already carries a committed visual baseline, so rendering one
 * here to assert it would move a screenshot another plan owns. The properties below are all statically
 * decidable, and a static gate that runs today beats a rendered gate that arrives in five plans' time.
 * The rendered half — that each of these controls resolves a non-empty accessible name in a real DOM —
 * lands with the first screen that mounts them.
 *
 *   run: npm run test:e2e -- --grep "@gate-components"
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = resolve(HERE, "../../src/components/gate");

/** Every component the UI-SPEC §6 inventory marks NEW, and which file must hold it. */
const INVENTORY: Record<string, string[]> = {
  "Ledger.tsx": ["Ledger"],
  "LedgerRow.tsx": ["LedgerRow"],
  "CoherenceMark.tsx": ["CoherenceMark"],
  "CohortCoverage.tsx": ["CohortCoverage"],
  "MemberChip.tsx": ["MemberChip", "MemberDropZone"],
  "CarveProposal.tsx": ["CarveProposal"],
  "TermSearch.tsx": ["TermSearch"],
  "CommitBar.tsx": ["CommitBar"],
  "CandidateCard.tsx": ["CandidateCard"],
  "GateTwoLayout.tsx": ["GateTwoLayout"],
  "NotAvailable.tsx": ["NotAvailable"],
  "GateEmptyState.tsx": ["GateEmptyState"],
};

function read(file: string): string {
  return readFileSync(resolve(GATE_DIR, file), "utf8");
}

/**
 * A source with its COMMENTS STRIPPED — block comments first, then line comments.
 *
 * Every assertion about what a component DOES has to read code, not prose. These files deliberately record
 * the rule each construct exists to satisfy in the construct's own docstring, so a naive substring gate
 * convicts the very sentence that documents the rule: `LedgerRow`'s docstring says a ledger row never takes
 * `rounded-card`, and a grep for `rounded-card` found it saying so.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** Every gate component source, by filename. */
function gateSources(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(GATE_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => [f, read(f)]),
  );
}

/**
 * Elements whose entire visible content is icons, with no accessible name.
 *
 * The rule (UI-SPEC §6): an icon-only control carries an `aria-label` / `aria-labelledby` naming the action
 * AND its object, or a visible text label beside the icon. `lucide-react` icons are decorative and
 * `aria-hidden`, so a control whose only child is one has NO accessible name at all — a defect, not a
 * style choice. The detector strips JSX elements and expressions from a control's body; whatever text
 * remains is the visible label.
 */
function unnamedIconControls(src: string): string[] {
  const offenders: string[] = [];
  const openers = /<(button|CollapsibleTrigger|Button)\b/g;
  let m: RegExpExecArray | null;
  while ((m = openers.exec(src))) {
    const tag = m[1];
    const closeIdx = src.indexOf(`</${tag}>`, m.index);
    const block = closeIdx === -1 ? src.slice(m.index, m.index + 600) : src.slice(m.index, closeIdx);
    const hasIcon = /<[A-Z][A-Za-z]*\s+aria-hidden/.test(block);
    if (!hasIcon) continue;
    const named = /aria-label(?:ledby)?=/.test(block);
    // The body after the opening tag, with nested elements and `{…}` expressions removed.
    const bodyStart = block.indexOf(">");
    const body = block
      .slice(bodyStart + 1)
      .replace(/<[^>]*>/g, " ")
      .replace(/\{[^{}]*\}/g, " ")
      .trim();
    if (!named && !body) offenders.push(block.slice(0, 120).replace(/\s+/g, " "));
  }
  return offenders;
}

test.describe("gate component vocabulary", () => {
  test("@gate-components every component the inventory marks new exists and is exported", () => {
    for (const [file, exports] of Object.entries(INVENTORY)) {
      const src = read(file);
      for (const name of exports) {
        expect(src, `${file} must export ${name}`).toContain(`export function ${name}`);
      }
    }
  });

  test("@gate-components no colour literal and no default-palette utility", () => {
    // The token layer is the only place a colour is named. A literal survives a rebrand untouched, and a
    // Tailwind default-palette utility is wired to no brand primitive at all.
    for (const file of Object.keys(gateSources())) {
      const src = code(file);
      expect(src, `${file} carries a hex literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, `${file} carries an rgb()/hsl() literal`).not.toMatch(/\b(?:rgba?|hsla?)\(/);
      expect(src, `${file} reaches for Tailwind's own palette`).not.toMatch(
        /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
      );
      // A component reads a token by NAME only for a value JS consumes; none of these do.
      expect(src, `${file} reads a raw token`).not.toMatch(/var\(--/);
    }
  });

  test("@gate-components every icon-only control names its action and its object", () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(gateSources())) {
      for (const control of unnamedIconControls(src)) offenders.push(`${file}: ${control}`);
    }
    expect(offenders, "an icon-only control with no accessible name is a defect").toEqual([]);
    // And the names say WHICH thing, not just what: "Expand" alone is useless on a four-hundred-row list.
    expect(read("LedgerRow.tsx")).toMatch(/aria-label=\{`\$\{open \? "Collapse" : "Expand"\} \$\{/);
    expect(read("MemberChip.tsx")).toContain("aria-label={`Drag ${variable} from ${cohort}");
  });

  test("@gate-components the unjudged coherence state differs by FORM, not by dimness", () => {
    const src = read("CoherenceMark.tsx");
    // A hollow DASHED marker…
    expect(src).toMatch(/not_judged:\s*"border border-dashed/);
    // …at the same muted colour as a judged label, and never the faint role or an opacity step. Rendering
    // it dimmer reads as "less important, therefore fine", which is the prohibited misread.
    expect(src).toMatch(/not_judged:\s*"text-on-raised-muted"/);
    expect(src).not.toMatch(/not_judged[^\n]*(?:faint|opacity-)/);
    // The copy that makes the state unmistakable must travel with it.
    expect(src).toContain("Silence from a judge that was never asked is not a pass.");
  });

  test("@gate-components the two-pane detail track cannot widen the page", () => {
    // A plain `1fr` keeps `min-width:auto`, so a wide value matrix widens the TRACK and the page scrolls
    // sideways. `minmax(0,…)` is the fix, and it is asserted rather than commented.
    const src = read("GateTwoLayout.tsx");
    expect(src).toContain("minmax(0,1fr)");
    expect(src).not.toMatch(/grid-cols-\[320px_1fr\]/);
  });

  test("@gate-components the draggable chip is declared at module scope", () => {
    // A component defined inside the page that renders it is a new type on every render, so React remounts
    // every chip and cancels any drag in flight. Module scope means column zero.
    const lines = read("MemberChip.tsx").split("\n");
    const decl = lines.find((l) => l.includes("function MemberChip"));
    expect(decl).toBe("export function MemberChip({");
  });

  test("@gate-components no package was added, and none is reached for", () => {
    const manifest = readFileSync(resolve(HERE, "../../package.json"), "utf8");
    for (const forbidden of ["react-window", "react-virtual", "@tanstack/react-virtual", "react-dnd", "dnd-kit"]) {
      expect(manifest, `${forbidden} must not be a dependency`).not.toContain(forbidden);
    }
    for (const [file, src] of Object.entries(gateSources())) {
      expect(src, `${file} imports a virtualization or drag-and-drop package`).not.toMatch(
        /from "(?:react-window|react-virtual|@tanstack\/react-virtual|react-dnd|@dnd-kit)/,
      );
    }
    // Large row counts are handled with CSS instead.
    expect(read("LedgerRow.tsx")).toContain("content-visibility");
  });

  test("@gate-components container geometry stays off instrument-level surfaces", () => {
    // Cards, panes, the ledger container, the commit bar and the drawer always take the container radius;
    // a ledger row, a table cell, a badge, a checkbox and an input never do (UI-SPEC §4).
    for (const file of ["Ledger.tsx", "CommitBar.tsx", "CandidateCard.tsx", "TermSearch.tsx"]) {
      expect(code(file), `${file} is a paper surface and takes the container radius`).toContain("rounded-card");
    }
    expect(code("LedgerRow.tsx"), "a ledger row must not take the container radius").not.toContain("rounded-card");
    expect(code("CohortCoverage.tsx"), "a coverage segment must not take the container radius").not.toContain(
      "rounded-card",
    );
    expect(code("MemberChip.tsx"), "a chip must not take the container radius").not.toContain("rounded-card");
    expect(code("NotAvailable.tsx"), "the tile sits at the inner radius").toContain("rounded-inner");
  });

  test("@gate-components the carve proposal is a proposal, and its paid path is honest when off", () => {
    const src = read("CarveProposal.tsx");
    // Accepting is the human trigger for re-adjudication, which is paid and opt-in. When the run did not
    // opt in it renders an honest tile naming the option — never hidden, never a bare disabled control.
    expect(src).toContain("readjudicationEnabled");
    expect(src).toContain('claim="not-enabled"');
    expect(src).toContain("Turn it on at Setup to enable it.");
    // Edit and ignore stay live either way: both are free, and both are how the flag gets resolved by hand.
    expect(src).toContain("Edit by moving variables");
    expect(src).toContain("Ignore the proposal");
  });

  test("@gate-components the not-available tile distinguishes three claims and is not an error", () => {
    const src = read("NotAvailable.tsx");
    for (const claim of ["deferred", "failed", "not-enabled"]) expect(src).toContain(claim);
    // Not styled as an error: no destructive/danger ROLE and no warning icon. Asserted over the code, not
    // the prose — the docstring's own sentence about carrying no destructive colour convicted it.
    expect(code("NotAvailable.tsx")).not.toMatch(
      /(?:bg|text|border)-(?:status-destructive|status-danger|surface-danger|on-danger|rule-danger)|AlertTriangle|CircleAlert|TriangleAlert/,
    );
    expect(src).toContain("border-dashed");
  });
});
