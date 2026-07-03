import { cn } from "@/lib/utils";
import lockupLight from "@/assets/ph/ph-lockup-light.png";
import lockupDark from "@/assets/ph/ph-lockup-dark.png";

// Official Phenome Health horizontal lockup (three-blade icon + wordmark).
// tone="auto" swaps by theme for contrast; "dark" forces the white-text version
// (for permanently-dark surfaces like the landing hero).
export function PhLogo({ className, tone = "auto" }: { className?: string; tone?: "auto" | "dark" | "light" }) {
  if (tone === "dark") return <img src={lockupDark} alt="Phenome Health" className={className} />;
  if (tone === "light") return <img src={lockupLight} alt="Phenome Health" className={className} />;
  return (
    <>
      <img src={lockupLight} alt="Phenome Health" className={cn("dark:hidden", className)} />
      <img src={lockupDark} alt="Phenome Health" className={cn("hidden dark:block", className)} />
    </>
  );
}
