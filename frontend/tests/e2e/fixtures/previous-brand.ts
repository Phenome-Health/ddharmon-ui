/**
 * The PREVIOUS Phenome Health brand, as the rebrand drill's fixture.
 *
 * ROLLED FORWARD 2026-08-20. This file used to hold the S3 brand guide (Roboto / proxima-nova,
 * #0B152D navy, #EDEDED grey, #E21C52 magenta). That palette is now TWO generations behind, and a
 * drill run against a two-generations-stale brand proves the layer against a straw man: the
 * further apart the two palettes are, the easier it is for every role to move. The fixture must
 * hold the generation IMMEDIATELY behind the shipped one, so the drill measures the insulation
 * against the hardest realistic case — the one where some axes did not move at all.
 *
 * So the values below are the JULY 2026 identity: the brand `08-05` sampled and `08-07` built the
 * three-tier layer on, and the one this app shipped until plan `08-12b` re-pointed tier 1 at the
 * identity `phenomehealth.org` republished on 2026-08-20.
 *
 *   axis            previous (July 2026)           current (2026-08-20)
 *   page ground     #1E2A52 navy                   #D5E0F6 pale blue  (INVERTED)
 *   paper           #FFFFF8 warm cream             #FFFFFF pure white
 *   second light    #F7F6EC cream-dim              #EBEFFF palest blue (warm -> cool)
 *   dark surface    #1E2A52 (#00063D was a tint)   #00063D             (PROMOTED to a surface)
 *   ink             #222572 indigo                 #000000
 *   dominant accent #0D59F2                        #0D59F2             (UNCHANGED — see below)
 *   second accent   #3AB3BB teal / #1B7F86 ink     absent (logo-scoped only)
 *   display face    Byrl -> Space Grotesk          Inter (one typeface)
 *   container radii 30px / 14px                    16px / 10px
 *
 * THE HARD CASE THIS FIXTURE BUYS, and the reason rolling it forward matters. The accent
 * (#0D59F2), the status registers and the categorical make-up did NOT move between these two
 * generations. Against the S3 guide every single value moved, so "did every role move?" was a
 * question the fixture could not fail to answer yes to. Here it can, and one pair legitimately
 * cannot move at all (`--on-warn on --surface-warn`, painted end to end from product-owned status
 * primitives). That pair is exempted BY NAME in the drill rather than by a regex, so the exemption
 * cannot quietly widen.
 *
 * MEASURED vs DERIVED. Every value below is labelled. A brand does not publish a token layer, so
 * some roles have no source in the generation being replayed — the July identity had no light
 * field, because 08-07 put the page on navy, and it had no mark palette, because the mark was
 * painted from UI roles (which is the defect 08-12b fixed). Those are DERIVED here by the same
 * rule the current identity follows, and the fact that a rebrand has to derive them is itself a
 * finding: it is the work a rebrand actually costs, and it is bounded to tier 1.
 */

/** Tier 1 only. A drill that also rewrote tier 2 would be proving nothing. */
export const PREVIOUS_BRAND_TIER_1: Record<string, string> = {
  // ── Colour ──────────────────────────────────────────────────────────────────
  "--brand-white": "#FFFFF8", // MEASURED — the July identity's paper. A warm off-white, never pure.
  "--brand-pale": "#F7F6EC", // MEASURED — its second light step (`--brand-cream-dim`).
  "--brand-mist": "#F2F1E4", // DERIVED — the July identity published no THIRD light step, because
  //                             08-07 put the page on navy and the light field role did not exist.
  //                             Continues the cream -> cream-dim interval by one more step.
  "--brand-navy-deep": "#1E2A52", // MEASURED — its dominant dark neutral. Note the swap: the July
  //                             identity ALSO had #00063D, but only as a shadow/scrim tint, never
  //                             as a surface. This role is now a real surface, so the counterpart
  //                             is the navy that actually painted one.
  "--brand-blue": "#0D59F2", // MEASURED — IDENTICAL in both generations. The one axis that did not
  //                             move, and the reason this fixture is a harder test than the S3 one.
  "--brand-slate": "#5B667A", // MEASURED — the July categorical slate.
  "--brand-black": "#222572", // MEASURED — the July ink (`--brand-indigo`). That identity had no
  //                             pure black; its darkest text colour was a chromatic indigo.

  // The mark's palette. DERIVED, and the derivation IS the defect 08-12b fixed: the July
  // generation had no mark palette at all, because `phenome-mark.tsx` painted the logo from
  // `--status-destructive`, `--on-chrome` and `--accent-2-on-chrome`. These are the values those
  // three UI roles happened to resolve to, which is exactly why a brand asset must not be painted
  // from semantic UI roles (T-08-65).
  "--brand-mark-crimson": "#E21C52", // DERIVED — via `--status-destructive`
  "--brand-mark-paper": "#FFFFF8", // DERIVED — via `--on-chrome`
  "--brand-mark-teal": "#3AB3BB", // DERIVED — via `--accent-2-on-chrome`

  // Status is PRODUCT-owned: no Phenome Health generation has published a status palette, so these
  // did not move. MEASURED against the July token layer, which is where they were decided.
  "--brand-green": "#0E7C63",
  "--brand-amber": "#8F4E00",
  "--brand-amber-pale": "#FCEFD6",
  "--brand-amber-mid": "#E8C48A",
  "--brand-crimson": "#E21C52",
  "--brand-crimson-ink": "color-mix(in srgb, var(--brand-crimson) 88%, var(--brand-navy-deep))",

  // Categorical make-up. Also product-owned and also unmoved; the teal step keeps the July
  // `--brand-teal-ink` value, which is what it was carrying then.
  "--brand-teal-deep": "#1B7F86",
  "--brand-violet": "#7C3AED",
  "--brand-sky-deep": "#0369A1",
  "--brand-series-1": "#2a78d6",
  "--brand-series-2": "#008300",
  "--brand-series-3": "#e87ba4",
  "--brand-series-4": "#eda100",
  "--brand-series-5": "#1baf7a",

  // ── Type ────────────────────────────────────────────────────────────────────
  // The BODY face is Inter in both generations — another axis that did not move, and the drill
  // says so out loud rather than asserting a change that did not happen. The DISPLAY stack is
  // where type moved: the July identity ran a licensed display face (Byrl) with Space Grotesk as
  // its standing fallback; the current brand has exactly one typeface and builds hierarchy from
  // weight and tracking instead.
  "--brand-font-body": "'Inter', -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  "--brand-font-mono": "'JetBrains Mono', ui-monospace, \"SF Mono\", Consolas, monospace",
  "--brand-font-display": "'Byrl', 'Space Grotesk', 'Inter', sans-serif",
  "--brand-weight-regular": "400",
  "--brand-weight-strong": "600",
  "--brand-tracking-display": "0em", // DERIVED — the July identity carried no display tracking; the
  //                             token did not exist, because a separate display FACE was doing the
  //                             work the current brand does with negative tracking.

  // ── Geometry ────────────────────────────────────────────────────────────────
  "--brand-radius-container": "30px", // MEASURED — the July site was 30px-dominant
  "--brand-radius-inner": "14px", // MEASURED
  "--brand-radius-pill": "999px", // unchanged
  "--brand-radius-hairline": "2px", // unchanged
  "--brand-radius-control": "4px", // unchanged — control radii are instrument discipline, not brand
  "--brand-radius-control-md": "6px",
  "--brand-radius-control-lg": "8px",
};

/**
 * The ONE tier-2 remap this fixture needs, and the whole point of declaring it explicitly.
 *
 * `--surface-field` is the page field, and it is the role the July identity genuinely could not
 * fill. Its light neutrals top out at #FFFFF8 / #F7F6EC, and its dark neutral is #1E2A52 rather
 * than #00063D — so the deepest ink that palette can put on a light field measures 12.25:1, just
 * under the 13:1 AAA-body floor the two body surfaces are held to. Both field body pairings
 * (`--on-field` and `--link-on-field`, which is the same decision re-made) land there together,
 * because they are the same value.
 *
 * So a rebrand back to that palette has to make ONE decision: the field takes the BRIGHTEST light
 * neutral rather than a third derived step, and the field and the paper become the same colour.
 * That is one line in tier 2, and it fixes both pairs at once.
 *
 * It is also the most interesting thing this fixture says. Collapsing the field onto the paper
 * destroys the "paper on a field" separation the Gate 1 ledger rests on — which is precisely why
 * 08-07 put that generation's page on NAVY rather than on a light ground. The drill re-derives,
 * from contrast numbers alone, the design decision that was actually taken at the time.
 */
export const PREVIOUS_BRAND_TIER_2_REMAP: Record<string, string> = {
  "--surface-field": "var(--brand-white)",
};

/** The pairs the tier-1 swap alone leaves short — the declared, bounded cost of this rebrand. */
export const EXPECTED_TIER_1_ONLY_SHORTFALLS = [
  "--on-field on --surface-field",
  "--link-on-field on --surface-field",
];

/**
 * Pairs that legitimately CANNOT move when tier 1 is swapped, because both their surface and
 * their foreground are painted from primitives that are identical in the two generations.
 *
 * Named individually rather than matched by a regex. The predecessor of this list was
 * `!/destructive/.test(label)`, which exempted five pairs to cover one, and a pattern that
 * exempts more than it needs to is how a real leak hides inside a legitimate exemption.
 */
export const PAIRS_THAT_CANNOT_MOVE = [
  // `--surface-warn` is `--brand-amber-pale` and `--on-warn` is `--brand-amber`, both product-owned
  // status primitives that no Phenome Health generation has ever published. Every OTHER status pair
  // moves, because its wash is derived over `--surface-raised`, which does move.
  "--on-warn on --surface-warn",
];

/** Colours unique to the CURRENT brand. Anything still painting one after the swap is a leak. */
export const CURRENT_BRAND_ONLY = [
  "#FFFFFF", // paper — pure white
  "#EBEFFF", // palest blue
  "#D5E0F6", // pale blue — the field
  "#00063D", // deep navy — the chrome
  "#4B4F6B", // slate
  "#000000", // ink
  "#3AC2CB", // the mark's teal
  "#E11E53", // the mark's crimson
  // NOT #0D59F2: the accent is identical in both generations, so the leak scan cannot
  // discriminate on it. Same reason #E21C52 was exempt under the S3 fixture.
];

/**
 * THE LEAK SCAN NEEDS A DIFFERENT INSTRUMENT, and this is it.
 *
 * `@drill 4` asks "is this painted colour reachable from the token layer?", and it answers by
 * swapping tier 1 and looking for values that did not move. That question does not care what the
 * previous brand WAS — it only needs every primitive to move. Using a real previous brand for it
 * is actively wrong, because two consecutive generations of one identity share values: the accent
 * (#0D59F2), all five status hues and the whole categorical make-up are byte-identical across
 * these two. Every element painting one of them looks exactly like a leak, and the scan reported
 * 215 of them the first time it ran against the rolled-forward fixture — not one a real defect.
 *
 * The predecessor's answer was an exemption (`if (/226, 28, 82/.test(was)) continue;` — the one
 * hue the S3 guide shared with the current brand). Scaling that up means exempting fourteen
 * primitives, and an exemption list that long stops being a list of known-unmeasurable values and
 * starts being cover for real leaks. It also cannot be written correctly: a colour reached through
 * an opacity modifier serialises as `oklab(… / 0.3)`, not as an rgb triple, so a value-matching
 * exemption misses it.
 *
 * So the leak scan gets a PERTURBATION instead of a brand: every colour primitive is replaced by
 * a distinct, evenly-spaced hue. Nothing can then coincide with its own current value, no
 * exemption is needed, and the scan becomes strictly stronger than it was — it now interrogates
 * the fourteen primitives the old exemption was blind to. Non-colour primitives (families,
 * weights, radii) pass through unchanged: this swap answers one question and should not perturb
 * anything that question does not concern.
 */
const COLOUR_PRIMITIVES = Object.keys(PREVIOUS_BRAND_TIER_1).filter((k) =>
  PREVIOUS_BRAND_TIER_1[k].startsWith("#"),
);

export const LEAK_SCAN_TIER_1: Record<string, string> = Object.fromEntries(
  Object.entries(PREVIOUS_BRAND_TIER_1).map(([key, value]) => {
    if (!value.startsWith("#")) return [key, value];
    const hue = Math.round((COLOUR_PRIMITIVES.indexOf(key) * 360) / COLOUR_PRIMITIVES.length);
    // Mid lightness and high saturation on purpose: nothing lands on black, on white, or close
    // enough to a neighbour that a derived wash of one could serialise as a wash of another.
    return [key, `hsl(${hue} 72% 46%)`];
  }),
);

export function asCss(vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  // `:root` at the same specificity as the token layer wins on source order, because the
  // injected <style> is appended last. No `!important` — a rebrand does not need one, and if it
  // did, that would itself be a finding.
  return `:root {\n${body}\n}`;
}
