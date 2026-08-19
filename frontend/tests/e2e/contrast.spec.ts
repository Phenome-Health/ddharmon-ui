import { test, expect, type Page } from "@playwright/test";

/**
 * Contrast gate for the 2026 identity token layer (UI-SPEC §5.5).
 *
 * Every anchor in that table is asserted here rather than trusted to a document: the ratios are read
 * out of the SHIPPED stylesheet (`getComputedStyle` on `:root`, in the built app) and recomputed
 * against WCAG 2.x relative luminance in page. A future token edit that quietly drops a pairing below
 * AA fails this file — and the file that fails also explains why the pairing exists.
 *
 * The two PROHIBITIONS are asserted numerically for the same reason. `--b-blue` on the ground and
 * `--b-teal` on paper are both unusable (2.5:1), and the temptation to reach for them there is
 * constant — so the numbers that forbid them live beside the numbers that permit everything else.
 *
 * Route: `/new`. It is the only baselined route with native form controls on a paper card, which makes
 * it the right place to also assert the `color-scheme` split (dark root, light paper surfaces) that
 * keeps a `<select>` from rendering dark-on-cream.
 */

/**
 * Reads every §5.5 pairing out of the live stylesheet and returns the measured ratios.
 *
 * All of the colour maths is declared INSIDE `page.evaluate` on purpose: the callback is serialised
 * into the browser and cannot close over Node-side helpers, so anything it needs has to be in its own
 * body.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];

    /** Resolve a custom property to a concrete colour, following `var()` indirection. */
    const token = (name: string, depth = 0): string => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (!raw) throw new Error(`token ${name} is not defined`);
      const indirect = /^var\(\s*(--[\w-]+)\s*(?:,.*)?\)$/.exec(raw);
      if (indirect && depth < 8) return token(indirect[1], depth + 1);
      return raw;
    };

    /**
     * Parse a colour as the BUILD emits it, not as it was authored. The production stylesheet is
     * minified, which rewrites `rgba(34,37,114,.70)` to the 8-digit hex `#222572b3` — so a parser that
     * only understood the authored form would pass in dev and fail on the shipped bundle.
     */
    const parse = (value: string): Rgba => {
      const v = value.trim();
      const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
      if (hex) {
        const d = hex[1];
        const wide = d.length <= 4 ? d.split("").map((c) => c + c).join("") : d;
        if (wide.length !== 6 && wide.length !== 8) throw new Error(`unparseable colour: ${value}`);
        const n = parseInt(wide.slice(0, 6), 16);
        const alpha = wide.length === 8 ? parseInt(wide.slice(6, 8), 16) / 255 : 1;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
      }
      const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
      if (fn) {
        const p = fn[1]
          .split(/[,\s/]+/)
          .filter(Boolean)
          .map((part) => (part.endsWith("%") ? Number(part.slice(0, -1)) / 100 : Number(part)));
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      }
      throw new Error(`unparseable colour: ${value}`);
    };

    /** Composite a possibly-translucent foreground over an opaque background before measuring it. */
    const over = (fg: Rgba, bg: Rgba): Rgba => [
      Math.round(fg[0] * fg[3] + bg[0] * (1 - fg[3])),
      Math.round(fg[1] * fg[3] + bg[1] * (1 - fg[3])),
      Math.round(fg[2] * fg[3] + bg[2] * (1 - fg[3])),
      1,
    ];

    const luminance = (c: Rgba): number => {
      const channel = (x: number) => {
        const s = x / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    };

    const ratio = (fgToken: string, bgToken: string): number => {
      const bg = parse(token(bgToken));
      const fg = over(parse(token(fgToken)), bg);
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    return {
      inkOnPaper: ratio("--ink", "--b-paper"),
      mutedOnPaper: ratio("--muted", "--b-paper"),
      faintOnPaper: ratio("--faint", "--b-paper"),
      onPageOnGround: ratio("--on-page", "--b-ground"),
      onPageMutedOnGround: ratio("--on-page-muted", "--b-ground"),
      blueOnPaper: ratio("--b-blue", "--b-paper"),
      blueOnGround: ratio("--b-blue", "--b-ground"),
      okOnPaper: ratio("--ok", "--b-paper"),
      warnOnWarnBg: ratio("--warn", "--warn-bg"),
      warnOnPaper: ratio("--warn", "--b-paper"),
      crimsonOnPaper: ratio("--b-crimson", "--b-paper"),
      tealInkOnPaper: ratio("--b-teal-ink", "--b-paper"),
      tealOnGround: ratio("--b-teal", "--b-ground"),
      tealOnPaper: ratio("--b-teal", "--b-paper"),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/new");
});

test("every UI-SPEC §5.5 contrast anchor holds in the shipped stylesheet", async ({ page }) => {
  const m = await measure(page);

  // The two body pairings clear AAA — this is a reading tool, and both surfaces carry running text.
  expect.soft(m.inkOnPaper, "--ink on --b-paper").toBeGreaterThanOrEqual(13);
  expect.soft(m.onPageOnGround, "--on-page on --b-ground").toBeGreaterThanOrEqual(13);

  // Secondary text and every coloured signal clear AA for normal-size text.
  expect.soft(m.mutedOnPaper, "--muted on --b-paper").toBeGreaterThanOrEqual(4.5);
  expect.soft(m.onPageMutedOnGround, "--on-page-muted on --b-ground").toBeGreaterThanOrEqual(4.5);
  expect.soft(m.blueOnPaper, "--b-blue on --b-paper").toBeGreaterThanOrEqual(4.5);
  expect.soft(m.okOnPaper, "--ok on --b-paper").toBeGreaterThanOrEqual(4.5);
  // The coherence flag is the most important signal on Gate 1; it is why --warn was darkened.
  expect.soft(m.warnOnWarnBg, "--warn on --warn-bg").toBeGreaterThanOrEqual(4.5);
  expect.soft(m.warnOnPaper, "--warn on --b-paper").toBeGreaterThanOrEqual(4.5);
  expect.soft(m.crimsonOnPaper, "--b-crimson on --b-paper").toBeGreaterThanOrEqual(4.5);
  expect.soft(m.tealInkOnPaper, "--b-teal-ink on --b-paper").toBeGreaterThanOrEqual(4.5);
  expect.soft(m.tealOnGround, "--b-teal on --b-ground").toBeGreaterThanOrEqual(4.5);
});

test("the two prohibited pairings stay prohibited — and stay prohibited by their numbers", async ({ page }) => {
  const m = await measure(page);

  // §5.2: blue never touches the ground. §5.4: raw teal never touches paper. Asserted as measurements
  // rather than as taste: if a token edit ever made either legal, this test is where that shows up.
  expect(m.blueOnGround, "--b-blue on --b-ground is prohibited (§5.2)").toBeLessThan(3);
  expect(m.tealOnPaper, "--b-teal on --b-paper is prohibited (§5.4) — use --b-teal-ink").toBeLessThan(3);

  // --faint is a hairline colour, not a text colour. Asserting that it is BELOW AA is what documents
  // the distinction: raise it to text contrast and the hairlines it draws stop reading as hairlines.
  expect(m.faintOnPaper, "--faint is for hairlines and dashed marks only").toBeLessThan(4.5);
});

test("the color-scheme split holds: dark root, light paper surfaces", async ({ page }) => {
  const rootScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(rootScheme, ":root carries the dark scheme the removed .dark class used to signal").toContain("dark");

  // A paper surface must re-declare `light`, or the native chrome inside it (select popups, autofill
  // fills, validation bubbles) renders dark-on-cream. `/new` is the route that has such controls.
  const paperScheme = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".bg-card, .bg-neutral-0, .bg-neutral-50");
    return el ? getComputedStyle(el).colorScheme : null;
  });
  expect(paperScheme, "/new should render at least one paper surface").not.toBeNull();
  expect(paperScheme, "a paper surface must re-declare the light scheme").toContain("light");

  const controlScheme = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("input, select, textarea");
    return el ? getComputedStyle(el).colorScheme : null;
  });
  expect(controlScheme, "/new should render at least one native form control").not.toBeNull();
  expect(controlScheme, "a native form control must draw its chrome light-on-cream").toContain("light");
});
