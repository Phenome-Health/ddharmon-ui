import lockupLight from "@/assets/ph/ph-lockup-light.png";
import lockupDark from "@/assets/ph/ph-lockup-dark.png";
import iconColor from "@/assets/ph/ph-icon-color.png";
import iconWhite from "@/assets/ph/ph-icon-white.png";

/**
 * Official Phenome Health icon (three-blade mark) only. Colour on paper, white on the ground.
 *
 * Single theme (D-05): there is no longer a theme to swap on, so the choice is made by SURFACE and the
 * call site declares it. That is the honest replacement for the pair of theme-variant hide/show
 * utilities this used to render — which shipped BOTH images on every page and let CSS hide one.
 */
export function PhMark({ className, tone = "paper" }: { className?: string; tone?: "paper" | "ground" }) {
  return <img src={tone === "ground" ? iconWhite : iconColor} alt="" aria-hidden className={className} />;
}

/**
 * Official Phenome Health horizontal lockup (three-blade icon + wordmark).
 *
 * `tone="dark"` forces the white-text version for a surface that is permanently dark (the landing
 * hero, the navy ground). `tone="auto"` is retained as the default for its existing call sites and now
 * resolves to the paper form — with one theme, "auto" can only mean "the surface this app's content
 * lives on", which is paper. Prefer stating the surface explicitly at new call sites.
 */
export function PhLogo({ className, tone = "auto" }: { className?: string; tone?: "auto" | "dark" | "light" }) {
  return <img src={tone === "dark" ? lockupDark : lockupLight} alt="Phenome Health" className={className} />;
}
