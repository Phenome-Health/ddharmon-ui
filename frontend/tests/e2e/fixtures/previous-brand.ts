/**
 * The PREVIOUS Phenome Health brand, as the rebrand drill's fixture.
 *
 * Not invented values. Measured from the brand guide at
 * `phenome-health-brand-guide.s3.amazonaws.com/public/index.html` with a computed-style walk —
 * the same method used on the live site for the current identity. The two brands moved on EVERY
 * axis, which is the empirical reason the three-tier layer exists:
 *
 *   axis            previous                       current
 *   type            Roboto + proxima-nova          Byrl + Space Grotesk (100% replaced)
 *   dark neutral    #0B152D                        #1E2A52
 *   light neutral   #EDEDED (cool grey)            #FFFFF8 (warm cream)
 *   dominant accent #E21C52 magenta                #0D59F2 bright blue
 *   other accents   #005B33 green, #3AC2CB cyan,   #222572 indigo
 *                   #113682 blue
 *   radii           20px / 40px / 5px              30px / 100px / 200px / 999px
 *
 * MEASURED vs DERIVED. Every value below is labelled. A brand guide does not publish a token
 * layer, so some roles have no published source — the previous guide has no second light step,
 * no warning register and no contrast-corrected form of its cyan. Those are DERIVED here by the
 * same rule the current identity follows, and the fact that a rebrand has to derive them is
 * itself a finding: it is the work a rebrand actually costs, and it is bounded to tier 1.
 */

/** Tier 1 only. A drill that also rewrote tier 2 would be proving nothing. */
export const PREVIOUS_BRAND_TIER_1: Record<string, string> = {
  // ── Colour ──────────────────────────────────────────────────────────────────
  "--brand-navy": "#0B152D", // MEASURED — the guide's dark neutral, 7 occurrences
  "--brand-navy-deep": "#05091A", // DERIVED — the guide publishes no second navy; shadow tint only
  "--brand-cream": "#EDEDED", // MEASURED — the guide's light neutral, 5 occurrences
  "--brand-cream-dim": "#DCDCDC", // DERIVED — no published second light step
  "--brand-indigo": "#0B152D", // MEASURED — the guide's non-black text colour
  "--brand-blue": "#113682", // MEASURED — the guide's blue, 1 occurrence
  "--brand-teal": "#3AC2CB", // MEASURED — the guide's cyan
  "--brand-teal-ink": "#125358", // DERIVED — #3AC2CB is 1.84:1 on #EDEDED; the light-surface form
  //                                 is brand data the guide never supplied. 7.46:1.
  "--brand-crimson": "#E21C52", // MEASURED — the guide's dominant accent. IDENTICAL in both brands,
  //                                 which is why the leak scan cannot discriminate on it.
  "--brand-crimson-ink": "color-mix(in srgb, var(--brand-crimson) 80%, var(--brand-indigo))",
  // DERIVED — same formula as the current identity at a different ratio. At the current 88% the
  // text form measures 4.39:1 on its own wash under this palette, below AA; 80% (#B71B4B) gives
  // 5.48:1 on the light neutral and 5.00:1 on the wash.
  "--brand-green": "#005B33", // MEASURED — the guide's green
  "--brand-amber": "#6E4304", // DERIVED — the previous brand published NO warning register at all
  "--brand-amber-pale": "#DED9D1", // DERIVED — the amber at 12% over the light neutral
  "--brand-amber-mid": "#B9AA93", // DERIVED — the amber at 35% over the light neutral
  "--brand-violet": "#5B2FB5", // DERIVED — categorical make-up, re-darkened for the grey ground
  "--brand-sky-deep": "#0B4E8A", // DERIVED — ditto
  "--brand-slate": "#4A5568", // DERIVED — ditto
  "--brand-series-1": "#1F5FA8",
  "--brand-series-2": "#0A6B33",
  "--brand-series-3": "#B4507A",
  "--brand-series-4": "#A87400",
  "--brand-series-5": "#127C58",

  // ── Type ────────────────────────────────────────────────────────────────────
  // MEASURED — the guide runs Roboto for UI and proxima-nova for display. Both are 100%
  // replaced in the current identity; type is a rebrand axis, so it is tokenized like colour.
  "--brand-font-body": "'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  "--brand-font-mono": "'Roboto Mono', ui-monospace, 'SF Mono', Consolas, monospace",
  "--brand-font-display": "'proxima-nova', 'Roboto', sans-serif",
  "--brand-weight-regular": "400",
  "--brand-weight-strong": "700", // MEASURED — the previous brand's emphasis weight was 700, not 600

  // ── Geometry ────────────────────────────────────────────────────────────────
  "--brand-radius-container": "40px", // MEASURED — the guide's largest radius
  "--brand-radius-inner": "20px", // MEASURED — the guide's mid radius
  "--brand-radius-pill": "999px", // DERIVED — the guide uses 50% for circles
  "--brand-radius-hairline": "1px", // DERIVED
  "--brand-radius-control": "5px", // MEASURED — the guide's small radius
  "--brand-radius-control-md": "5px", // MEASURED
  "--brand-radius-control-lg": "5px", // MEASURED
};

/**
 * The ONE tier-2 remap this fixture needs, and the whole point of declaring it explicitly.
 *
 * `--status-destructive` is used both as a FILL and as a text colour, and the previous brand's
 * magenta cannot carry AA against its own light neutral in EITHER direction: #E21C52 on #EDEDED
 * measures 3.97:1, and so does #EDEDED on #E21C52. (The current brand scrapes 4.62:1 both ways
 * because its light neutral is a warm cream rather than a cool grey — a two-point-of-lightness
 * difference that decides an accessibility outcome, which is the sharpest argument in this whole
 * plan for measuring instead of eyeballing.)
 *
 * So a rebrand has to make ONE decision: use the ink form for the destructive register and give
 * up the pure magenta as a fill. That is one line in tier 2, and it fixes both directions at once.
 *
 * The drill asserts the tier-1 swap ALONE leaves exactly these two pairs short, so the number of
 * roles a rebrand must reason about cannot silently grow.
 */
export const PREVIOUS_BRAND_TIER_2_REMAP: Record<string, string> = {
  "--status-destructive": "var(--brand-crimson-ink)",
};

/** The pairs the tier-1 swap alone leaves short — the declared, bounded cost of this rebrand. */
export const EXPECTED_TIER_1_ONLY_SHORTFALLS = [
  "--status-destructive on --surface-raised",
  "--on-destructive on --status-destructive",
];

/** Colours unique to the CURRENT brand. Anything still painting one after the swap is a leak. */
export const CURRENT_BRAND_ONLY = [
  "#1E2A52", // navy
  "#00063D", // deepest navy
  "#FFFFF8", // cream
  "#F7F6EC", // cream-dim
  "#222572", // indigo
  "#0D59F2", // blue
  "#3AB3BB", // teal
  "#1B7F86", // teal-ink
  "#0E7C63", // green
  "#8F4E00", // amber
  "#FCEFD6", // amber-pale
];

export function asCss(vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  // `:root` at the same specificity as the token layer wins on source order, because the
  // injected <style> is appended last. No `!important` — a rebrand does not need one, and if it
  // did, that would itself be a finding.
  return `:root {\n${body}\n}`;
}
