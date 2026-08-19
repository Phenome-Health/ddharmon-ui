import { expect, test } from "@playwright/test";
import { loadManifest, measure, requiredPairs, shortfalls } from "./role-probe";

/**
 * The contrast gate, driven by `src/tokens/role-manifest.json`.
 *
 * **Why this was rewritten.** The gate it replaces asserted eleven HARDCODED anchors. It passed
 * all the way through the retheme while the field/copy pairing was broken — bare copy on the
 * content field inherited the CHROME's cream foreground and rendered cream-on-cream — precisely
 * because no anchor covered text-on-field. A gate whose coverage is a hand-written list grows
 * blind spots exactly where new surfaces appear.
 *
 * Iterating the manifest inverts that: a surface cannot ship without a row, and a row cannot
 * exist without a contrast requirement. All eleven original AA/AAA anchors and all three
 * original prohibitions are still enforced — see `role-manifest.json`, where each carries the
 * threshold it was given in UI-SPEC §5.5 — plus the pairs the old list had no row for:
 * text-on-field, text-on-inset, the label inside a filled action, every status wash's own
 * foreground, both focus rings and all nine chart steps.
 *
 * Route: `/new`. It is the only baselined route with native form controls on a raised card,
 * which makes it the right place to also assert the `color-scheme` split.
 */

const manifest = loadManifest();
const pairs = requiredPairs(manifest);

test.beforeEach(async ({ page }) => {
  await page.goto("/new");
});

test("every role in the manifest resolves to a real colour in the shipped stylesheet", async ({ page }) => {
  const { unresolved } = await measure(page, pairs);
  expect(
    unresolved,
    "a role that resolves to nothing does not fail loudly — `var(--gone)` is invalid at " +
      "computed-value time, so the declaration falls back to the INHERITED value and the element " +
      "keeps rendering something plausible. That is how four `--sf-*` reads survived 08-05:\n  " +
      unresolved.join("\n  "),
  ).toEqual([]);
});

test("every (surface, foreground) pair in the manifest meets its required contrast", async ({ page }) => {
  const required = pairs.filter((p) => p.level !== "prohibited");
  const { measured } = await measure(page, required);
  // `DDH_ROLE_TABLE=1` prints every measured ratio. The gate only needs the shortfalls, but the
  // full table is what a reviewer (or a plan summary) needs to see, and recomputing it by hand
  // is how a documented ratio drifts from the shipped one.
  if (process.env.DDH_ROLE_TABLE) {
    for (const p of required) {
      const m = measured.find((x) => x.label === p.label);
      console.log(`${p.label.padEnd(46)} ${String(m?.ratio ?? "unresolved").padStart(6)}:1  ${p.level}`);
    }
  }
  const bad = shortfalls(required, measured);
  expect(
    bad,
    `${bad.length} of ${required.length} manifest pairs miss their requirement. Each row names ` +
      `the pair, the measured ratio and the level it is declared at in role-manifest.json:\n  ` +
      bad.join("\n  "),
  ).toEqual([]);
});

test("the prohibited pairings stay prohibited — and stay prohibited by their numbers", async ({ page }) => {
  // Asserted as measurements rather than as taste: if a token edit ever made one of these legal,
  // this is where it shows up. The `non-text` rows carry the same discipline from the other side —
  // a hairline colour raised to text contrast stops reading as a hairline — so they are folded in
  // here, which is how the third original prohibition (--faint is not a text colour) survives.
  const banned = pairs.filter((p) => p.level === "prohibited" || p.level === "non-text");
  const { measured } = await measure(page, banned);
  const bad = shortfalls(banned, measured);
  expect(
    bad,
    `a prohibited or non-text pairing is out of bounds:\n  ` + bad.join("\n  "),
  ).toEqual([]);
});

test("every manifest role generates a real Tailwind utility, verified on the rendered element", async ({
  page,
}) => {
  // THE NAMESPACE TRAP, asserted. Six `--font-size-*` keys in this file generated NOTHING for
  // months because Tailwind v4's font-size namespace is `--text-*`, and a grep gate reported
  // success the whole time. A role whose utility does not exist is worse than no role: the class
  // silently does not apply. So each utility is applied to a probe element and the computed
  // paint is compared against the token it is supposed to carry.
  const spec = manifest.surfaces.flatMap((s) => [
    { utility: s.utility, token: s.role, property: "backgroundColor" as const },
    ...s.foregrounds.map((f) => ({ utility: f.utility, token: f.role, property: "color" as const })),
    ...s.rules.map((r) => ({ utility: r.utility, token: r.role, property: "borderTopColor" as const })),
  ]);

  const bad = await page.evaluate((spec) => {
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-9999px";
    document.documentElement.appendChild(host);
    const failures: string[] = [];
    for (const s of spec) {
      const viaUtility = document.createElement("div");
      viaUtility.className = s.utility;
      viaUtility.style.borderStyle = "solid";
      viaUtility.style.borderWidth = "1px";
      const viaToken = document.createElement("div");
      viaToken.style.setProperty(
        s.property === "backgroundColor" ? "background-color" : s.property === "color" ? "color" : "border-top-color",
        `var(${s.token})`,
      );
      viaToken.style.borderStyle = "solid";
      viaToken.style.borderWidth = "1px";
      host.append(viaUtility, viaToken);
      const got = getComputedStyle(viaUtility)[s.property];
      const want = getComputedStyle(viaToken)[s.property];
      if (got !== want) failures.push(`.${s.utility} paints ${got} but var(${s.token}) is ${want}`);
      viaUtility.remove();
      viaToken.remove();
    }
    host.remove();
    return failures;
  }, spec);

  expect(
    bad,
    `${bad.length} of ${spec.length} role utilities do not paint their own token. An empty or ` +
      `transparent paint means the utility DOES NOT EXIST — check the Tailwind v4 namespace ` +
      `(--color-* for paint, --text-* for size, --font-weight-* for weight):\n  ` +
      bad.join("\n  "),
  ).toEqual([]);
});

test("the color-scheme split holds: dark root, light raised surfaces", async ({ page }) => {
  const rootScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(rootScheme, ":root carries the dark scheme the removed .dark class used to signal").toContain("dark");

  // A raised surface must re-declare `light`, or the native chrome inside it (select popups,
  // autofill fills, validation bubbles) renders dark-on-cream. `/new` is the route with controls.
  const paperScheme = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      ".bg-surface-raised, .bg-surface-inset, .bg-surface-inset-strong, .bg-card",
    );
    return el ? getComputedStyle(el).colorScheme : null;
  });
  expect(paperScheme, "/new should render at least one raised surface").not.toBeNull();
  expect(paperScheme, "a raised surface must re-declare the light scheme").toContain("light");

  const controlScheme = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("input, select, textarea");
    return el ? getComputedStyle(el).colorScheme : null;
  });
  expect(controlScheme, "/new should render at least one native form control").not.toBeNull();
  expect(controlScheme, "a native form control must draw its chrome light-on-cream").toContain("light");
});

test("the focus outline colour flips with the surface, not with a marker class", async ({ page }) => {
  // The focus treatment resolves through `light-dark()` against the same `color-scheme` split —
  // the accent on a raised surface, the chrome's foreground on the chrome, because the accent on
  // the chrome is 2.47:1 and prohibited. That mechanism degrades SILENTLY on an engine without
  // `light-dark()` (the declaration is dropped and the fallback is used everywhere), so it is
  // probed directly rather than through `:focus-visible`, whose matching depends on interaction.
  const resolved = await page.evaluate(() => {
    const probe = (scheme: string) => {
      const el = document.createElement("div");
      el.style.colorScheme = scheme;
      el.style.outlineColor = "light-dark(var(--focus-ring-on-raised), var(--focus-ring-on-chrome))";
      document.body.appendChild(el);
      const value = getComputedStyle(el).outlineColor;
      el.remove();
      return value;
    };
    const token = (name: string) => {
      const el = document.createElement("div");
      el.style.outlineColor = `var(${name})`;
      document.body.appendChild(el);
      const value = getComputedStyle(el).outlineColor;
      el.remove();
      return value;
    };
    return {
      paper: probe("light"),
      ground: probe("dark"),
      onRaised: token("--focus-ring-on-raised"),
      onChrome: token("--focus-ring-on-chrome"),
    };
  });

  expect(resolved.paper, "focus on a raised surface is the action accent").toBe(resolved.onRaised);
  expect(resolved.ground, "focus on the chrome is the chrome's own foreground, never the accent").toBe(
    resolved.onChrome,
  );
  expect(resolved.onRaised, "the two focus rings must differ, or the flip is decorative").not.toBe(
    resolved.onChrome,
  );
});
