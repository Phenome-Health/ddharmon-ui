import { expect, test } from "@playwright/test";
import { loadManifest, measure, requiredPairs, shortfalls } from "./role-probe";
import { routeUrl, TOKEN_LAYER_ROUTES } from "./routes";
import {
  asCss,
  EXPECTED_TIER_1_ONLY_SHORTFALLS,
  PREVIOUS_BRAND_TIER_1,
  PREVIOUS_BRAND_TIER_2_REMAP,
} from "./fixtures/previous-brand";

/**
 * THE REBRAND DRILL.
 *
 * "A rebrand is a one-file edit" is a claim, and a claim about future work is worth nothing
 * unasserted. This file swaps tier 1 to the PREVIOUS Phenome Health brand's real measured values
 * — a brand that differed on every axis: type, dark neutral, light neutral, dominant accent,
 * radii — and then asks the questions that decide whether the insulation is real:
 *
 *   1. Does every role still RESOLVE? A role that falls through to an inherited value has no
 *      insulation at all; it just fails quietly.
 *   1b. Did the swap actually TAKE? Without this the drill could pass vacuously.
 *   2. Does every (surface, foreground) pair still meet its CONTRAST requirement — and is the set
 *      of pairs a rebrand must re-decide in tier 2 exactly the declared one?
 *   3. Does the TYPE stack move too, or is only colour tokenized?
 *   4. Does any component-level colour SURVIVE the swap? A colour that does not move is a colour
 *      the token layer cannot reach, which is a rebrand that silently does not happen.
 *
 * Question 4 is expected to FAIL until Part 2 migrates the 22 page files, so it calls
 * `test.fail()` — Playwright then treats a PASS as the failure, which is what forces the marker
 * off once the leaks are gone. It is not deleted and it is not loosened: it prints the offending
 * elements, and that list is Part 2's work.
 */

const manifest = loadManifest();
const pairs = requiredPairs(manifest);
const TIER_1 = asCss(PREVIOUS_BRAND_TIER_1);
const TIER_1_AND_2 = `${TIER_1}\n${asCss(PREVIOUS_BRAND_TIER_2_REMAP)}`;

test("@drill 1 — with tier 1 swapped to the previous brand, every role still resolves", async ({ page }) => {
  await page.goto("/new");
  const { unresolved } = await measure(page, pairs, TIER_1);
  expect(
    unresolved,
    "a role that stops resolving under a swapped palette was reaching a primitive by a name the " +
      "new palette does not define — the failure a rebrand hits on its FIRST day:\n  " +
      unresolved.join("\n  "),
  ).toEqual([]);
});

test("@drill 1b — the swap actually took: every role's resolved value moved", async ({ page }) => {
  await page.goto("/new");
  const { measured: before } = await measure(page, pairs);
  const { measured: after } = await measure(page, pairs, TIER_1);

  const byLabel = new Map(before.map((b) => [b.label, b]));
  const unmoved = after.filter((a) => {
    const b = byLabel.get(a.label);
    return b && a.fgResolved === b.fgResolved && a.bgResolved === b.bgResolved;
  });
  // The destructive hue is #E21C52 in BOTH brands — the previous brand's dominant accent is the
  // current brand's destructive fill — so its pairs legitimately cannot move. Named, not hidden.
  const unexplained = unmoved.filter((u) => !/destructive/.test(u.label));
  expect(
    unexplained.map((u) => `${u.label} — still ${u.fgResolved} on ${u.bgResolved}`),
    "these pairs did not move when tier 1 was replaced, so either the override did not apply or " +
      "the role is not sourced from a primitive. Either way the rest of this file would be " +
      "measuring the CURRENT brand and passing for the wrong reason:",
  ).toEqual([]);
});

test("@drill 2 — tier 1 alone leaves exactly the declared set of pairs short", async ({ page }) => {
  await page.goto("/new");
  const required = pairs.filter((p) => p.level !== "prohibited");
  const { measured } = await measure(page, required, TIER_1);
  const short = shortfalls(required, measured).map((line) => line.split(":")[0]);
  expect(
    short.slice().sort(),
    "the number of roles a rebrand must re-decide in tier 2 is a budget, and this assertion is " +
      "what stops it growing silently. The declared set lives in fixtures/previous-brand.ts with " +
      `its reasoning.\n  measured: ${short.join(", ") || "none"}`,
  ).toEqual([...EXPECTED_TIER_1_ONLY_SHORTFALLS].sort());
});

test("@drill 2b — with its one declared tier-2 remap, every pair meets its requirement", async ({ page }) => {
  await page.goto("/new");
  const required = pairs.filter((p) => p.level !== "prohibited");
  const { measured } = await measure(page, required, TIER_1_AND_2);
  const bad = shortfalls(required, measured);
  expect(
    bad,
    "a whole-brand replacement, absorbed by one primitive block plus a single role remap. If " +
      "this list is non-empty the insulation is not real:\n  " + bad.join("\n  "),
  ).toEqual([]);
});

test("@drill 2c — the prohibitions survive a brand replacement", async ({ page }) => {
  await page.goto("/new");
  const banned = pairs.filter((p) => p.level === "prohibited" || p.level === "non-text");
  const { measured } = await measure(page, banned, TIER_1_AND_2);
  const bad = shortfalls(banned, measured);
  expect(
    bad,
    "a prohibited pairing that becomes legal under a new palette is not a win — the prohibition " +
      "encodes a RELATIONSHIP (the accent on the dark ground, the raw secondary accent on a light " +
      "surface), and the relationship is what has to hold:\n  " + bad.join("\n  "),
  ).toEqual([]);
});

test("@drill 3 — the type stack moves with the brand, not just the colour", async ({ page }) => {
  await page.goto("/new");
  const before = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  await page.addStyleTag({ content: TIER_1 });
  const after = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "font-display";
    document.body.appendChild(probe);
    const display = getComputedStyle(probe).fontFamily;
    probe.remove();
    const strong = document.createElement("strong");
    strong.textContent = "x";
    document.body.appendChild(strong);
    const weight = getComputedStyle(strong).fontWeight;
    strong.remove();
    return { body: getComputedStyle(document.body).fontFamily, display, weight };
  });
  expect(after.body, "the body face must follow the brand").not.toBe(before);
  expect(after.body).toContain("Roboto");
  expect(after.display, "the display face must follow the brand").toContain("proxima-nova");
  // The previous brand's emphasis weight was 700. `<strong>` is pinned to the strong-weight
  // PRIMITIVE rather than to a literal 600, so it follows the brand too.
  expect(after.weight, "the strong weight is a primitive, not a literal").toBe("700");
});

/**
 * The leak scan walks ALL 23 baselined routes, not a sample: a four-route sample reported "no
 * leaks" from four pages that happen to be clean, while the one real leak in the app was on
 * `/job/:jobId`. It also settles each route — the `/job/:jobId/*` family streams its result in,
 * and an unsettled scan walks a 107-element loading shell and pronounces the whole family clean.
 *
 * WHAT THIS SCAN CANNOT SEE, stated because a green result is only worth what its coverage is:
 *
 *  - **Unrendered states.** It sees what the static demo actually paints. `pages/composite.tsx`
 *    carries 24 Tailwind DEFAULT-palette utilities (`bg-amber-50`, `text-red-700`,
 *    `text-emerald-700`) on feasibility badges and an error banner that the demo fixture never
 *    reaches. Those bypass the token layer completely and WOULD survive a rebrand. They are
 *    caught statically instead, by
 *    `tests/test_content_drift.py::test_no_default_palette_utilities`.
 *  - **A colour that moves WRONGLY.** "It moved" is not "it moved to the right thing"; that is
 *    what @drill 2/2b measure.
 *  - **Colours identical in both brands.** #E21C52 is the previous brand's dominant accent and
 *    the current brand's destructive fill, so its pairs cannot move and are exempted by name.
 */
test("@drill 4 — no component-level colour survives the swap", async ({ page, baseURL }) => {
  const leaks: string[] = [];
  for (const route of TOKEN_LAYER_ROUTES) {
    const url = await routeUrl(route, baseURL);
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    // The `/job/:jobId/*` family streams its result in; without settling, the scan walks a
    // 107-element loading shell and reports the whole family clean.
    await page.waitForLoadState("networkidle");
    const found = await page.evaluate((css: string) => {
      const PROPS = ["color", "backgroundColor", "borderTopColor", "fill", "stroke"] as const;
      // `className` on an SVG element is an SVGAnimatedString, which stringifies to
      // "[object SVGAnimatedString]" — use the attribute so an SVG leak is identifiable.
      const describe = (el: Element) => {
        const cls = (el.getAttribute("class") ?? "").slice(0, 64);
        return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ""}>`;
      };
      const snap = () => {
        const rows: { desc: string; vals: string[] }[] = [];
        for (const el of Array.from(document.body.querySelectorAll("*"))) {
          const cs = getComputedStyle(el);
          rows.push({ desc: describe(el), vals: PROPS.map((p) => cs[p] as string) });
        }
        return rows;
      };
      const inert = (v: string) =>
        !v ||
        v === "rgba(0, 0, 0, 0)" ||
        v === "transparent" ||
        v === "none" ||
        v === "currentcolor" ||
        /\/\s*0\)$/.test(v);

      // Transitions must die FIRST. `getComputedStyle` returns the currently ANIMATING value, so
      // on any element carrying `transition-colors` the read taken immediately after the swap is
      // still last frame's colour — which reports the entire app chrome as a leak. This was the
      // drill's own first result: 31 "leaks", nearly all of them elements that do follow the
      // token layer and simply had not finished transitioning.
      const freeze = document.createElement("style");
      freeze.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
      document.head.appendChild(freeze);
      void document.body.offsetHeight;

      const before = snap();
      const style = document.createElement("style");
      style.id = "ddh-rebrand-drill";
      style.textContent = css;
      document.head.appendChild(style);
      void document.body.offsetHeight;
      const after = snap();
      style.remove();
      freeze.remove();

      const seen = new Set<string>();
      const out: string[] = [];
      for (let i = 0; i < before.length && i < after.length; i++) {
        if (before[i].desc !== after[i].desc) continue; // tree moved; not comparable
        for (let j = 0; j < PROPS.length; j++) {
          const was = before[i].vals[j];
          if (inert(was) || was !== after[i].vals[j]) continue;
          // Two documented exemptions, both about colours that CANNOT move rather than colours
          // that failed to: the destructive hue #E21C52 is identical in both brands, and pure
          // black / white are UA defaults on elements that declare no colour of their own.
          if (/226, 28, 82/.test(was)) continue;
          if (was === "rgb(0, 0, 0)" || was === "rgb(255, 255, 255)") continue;
          const line = `${PROPS[j]}=${was}  ${before[i].desc}`;
          const sig = `${PROPS[j]}=${was}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          out.push(line);
        }
      }
      return out;
    }, TIER_1);
    leaks.push(...found.map((l) => `${route.path.padEnd(28)} ${l}`));
    if (process.env.DDH_DRILL_TRACE) {
      const n = await page.evaluate(() => document.body.querySelectorAll("*").length);
      console.log(`  scanned ${url.padEnd(46)} ${String(n).padStart(5)} elements, ${found.length} leak(s)`);
    }
  }

  console.log(`\n=== REBRAND DRILL: ${leaks.length} component-level colours survived the swap ===`);
  for (const l of leaks) console.log(`  ${l}`);

  expect(
    leaks,
    `${leaks.length} painted colour(s) did not move when the brand was replaced. Each is a colour ` +
      `the token layer cannot reach — a hardcoded literal, a Tailwind default-palette utility, or ` +
      `a dead \`var()\`. This list is 08-07 Part 2's migration work:\n  ` + leaks.join("\n  "),
  ).toEqual([]);
});
