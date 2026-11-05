import { useEffect, useState } from "react";
import { buildStampText } from "@/lib/build-stamp";
import { cn } from "@/lib/utils";

/**
 * "build 3f2c1a9 · 1440px" beside the dev badge: the git tree this bundle was built from and the page's live width.
 *
 * The Lavish review surface is built as the dev channel too, so it shows the same stamp. Matching stamps mean the same
 * code at the same width — the two things that decide what a screen looks like, apart from its data. The width is
 * the viewport's (`innerWidth`), which is what the layout's breakpoints read.
 */
export function BuildStamp({ className }: { className?: string }) {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return (
    <span
      data-testid="build-stamp"
      title="The code this page was built from (its git tree) and the page's current width. A review build and a deploy that show the same stamp are the same code at the same width."
      className={cn("font-mono text-xs text-on-chrome-muted", className)}
    >
      {buildStampText(__UI_TREE__, width)}
    </span>
  );
}
