import { expect, test } from "@playwright/test";
import { routeUrl, TOKEN_LAYER_ROUTES } from "./routes";

/**
 * The four-size scale, asserted on the RENDERED page — the automated half of the R10 type
 * fold (08 T-08-33).
 *
 * In Tailwind v4 CSS-first, deleting a `@theme` key deletes its utility SILENTLY: a stale
 * class simply stops applying and the element renders at a browser default with no error
 * anywhere. A grep gate proves no stale CLASS survives in the source; it cannot prove no
 * ELEMENT renders off-scale, which is the failure a reader actually sees. This walks every
 * baselined route and reads the computed `font-size` of every visible text node's owner.
 *
 * `--text-*: initial` in index.css means Tailwind's whole inherited size namespace is gone,
 * so a mistyped or resurrected `text-lg` produces no declaration at all and the element
 * inherits — which this catches only if the inherited value is itself off-scale. The real
 * catch here is the OTHER direction: an element still sized by a UA default (an unstyled
 * <h1> at 32px, an <input> at 13.33px) or by an off-scale arbitrary value.
 */

/** UI-SPEC §3.1: 12 meta · 14 body · 20 heading · 30 display. Nothing else ships. */
const SCALE = [12, 14, 20, 30];

/** UI-SPEC §3.2: exactly two weights. 500 and 700 are banned, including on the display face. */
const WEIGHTS = [400, 600];

/**
 * Sizes that are legitimately off the text scale because they are not TEXT:
 *  - 0 — an element with no rendered text box.
 *  - 16 — the UA's `font-size: medium` on elements that render no text of their own but are
 *    ancestors we cannot exclude cheaply (they inherit nothing because `body` sets 14px, so
 *    a 16px box means the element sits OUTSIDE body's cascade: `<html>` itself).
 */
const NON_TEXT = new Set([0]);

for (const route of TOKEN_LAYER_ROUTES) {
  test(`@type ${route.name} (${route.path}) renders only the four sizes and two weights`, async ({
    page,
    baseURL,
  }) => {
    await page.goto(await routeUrl(route, baseURL));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");

    const offenders = await page.evaluate(
      ({ scale, weights, nonText }) => {
        const allowed = new Set(scale);
        const bad = new Map<
          string,
          { size: number; weight: number; sample: string; classes: string }
        >();
        for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
          // Only elements that render text of their OWN (a direct, non-empty text child).
          const own = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => (n.textContent ?? "").trim())
            .join(" ")
            .trim();
          if (!own) continue;
          if (!el.offsetParent && el.tagName !== "BODY") continue; // not laid out
          const cs = getComputedStyle(el);
          const size = Math.round(parseFloat(cs.fontSize) * 100) / 100;
          const weight = parseInt(cs.fontWeight, 10);
          const badSize = !allowed.has(size) && !nonText.includes(size);
          const badWeight = !weights.includes(weight);
          if (!badSize && !badWeight) continue;
          const key = `${el.tagName.toLowerCase()}@${size}px/${weight}|${el.className}`;
          if (!bad.has(key)) {
            bad.set(key, {
              size,
              weight,
              sample: own.slice(0, 60),
              classes: String(el.className).slice(0, 90),
            });
          }
        }
        return Array.from(bad.entries()).map(([key, v]) => ({ key, ...v }));
      },
      { scale: SCALE, weights: WEIGHTS, nonText: Array.from(NON_TEXT) },
    );

    expect(
      offenders,
      `${route.path} renders text off the scale — sizes must be one of ${SCALE.join("/")}px and ` +
        `weights one of ${WEIGHTS.join("/")}. An off-scale size is usually a browser default showing ` +
        `through where a deleted type utility used to apply, which is the silent failure mode of a ` +
        `Tailwind v4 \`@theme\` key removal:\n` +
        offenders.map((o) => `  ${o.size}px/${o.weight}  "${o.sample}"  [${o.classes}]`).join("\n"),
    ).toEqual([]);
  });
}
