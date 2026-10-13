import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Plus, ListChecks, BookOpen, Workflow, Gauge, Lightbulb, Sparkles, Boxes, Building2, Milestone, Network, Github,
  UserRound,
} from "lucide-react";
import { UserButton } from "@clerk/react";
import { cn } from "@/lib/utils";
import { AUTH_ENABLED, useAuthState } from "@/auth";
import { IS_STATIC } from "@/lib/api";
import { ISSUES_URL, PH, REPO_URL } from "@/lib/links";
import { PhMark } from "@/components/ph-logo";
import { ActiveRunsIndicator } from "@/components/active-runs-indicator";
import { GlobalStatusBanner } from "@/components/global-status-banner";
import { BuildStamp } from "@/components/build-stamp";

// Dev channel: a build pinned to an UNRELEASED core (git ref), deployed to dev.ddharmon.io for
// pre-PyPI validation. Baked in at build time (VITE_APP_CHANNEL=dev); defaults to prod. Its prominent badge went
// with the top bar (review round 7, Bhargav: "remove the dev tag"); what remains is the build stamp in the rail's
// footer, which names the code — the Lavish≡dev parity check reads it.
const IS_DEV_CHANNEL = (import.meta.env.VITE_APP_CHANNEL as string | undefined) === "dev";

function NavLink({
  href,
  icon,
  label,
  collapsed = false,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  /** Icon-rail form: the label is still the accessible name, it is just not drawn (08-16c Task 5; the rail rests
   *  this way since review round 7 and opens on hover). */
  collapsed?: boolean;
}) {
  const [loc] = useLocation();
  const active = loc === href || (href !== "/" && loc.startsWith(href));
  return (
    <Link
      href={href}
      // The label survives collapsing as the accessible name and as the hover tooltip, so collapsing
      // hides text — it does not remove a destination or its identification.
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      data-nav-active={active ? "true" : "false"}
      className={cn(
        // One geometry in both forms, so the icon does not jump when the rail opens: it sits where the rail centres it.
        "flex items-center gap-3 whitespace-nowrap rounded px-3 py-2 text-sm transition-colors",
        active
          ? "bg-on-chrome/12 font-semibold text-on-chrome"
          : "text-on-chrome-muted hover:bg-on-chrome/8 hover:text-on-chrome",
      )}
    >
      {icon}
      {!collapsed && label}
    </Link>
  );
}

/** How long the pointer must rest on the rail before it opens — long enough that crossing it does not flash it open. */
const NAV_HOVER_DELAY_MS = 120;

export function AppShell({ children }: { children: ReactNode }) {
  const { isGuest, exitGuest, email } = useAuthState();
  /**
   * THE RAIL EXPANDS ON HOVER (review round 7, Bhargav 2026-10-13: "a hover to expand mechanic, not a collapse
   * button"). It rests as an icon rail and opens OVER the content — the aside keeps its rail width in the layout and
   * the panel inside it widens — so the page never reflows under the pointer. Keyboard focus opens it too, but only
   * KEYBOARD focus (`:focus-visible`): a clicked link keeps focus, and a rail that stayed open after every click
   * would undo the point of it.
   */
  const [hovered, setHovered] = useState(false);
  const [keyFocus, setKeyFocus] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const expanded = hovered || keyFocus;
  const collapsed = !expanded;
  return (
    <div data-testid="app-shell" className="flex h-screen flex-col overflow-hidden bg-surface-chrome">
      {/* Site-wide "under active development" notice — every page, both prod + dev channels. */}
      <GlobalStatusBanner />
      {/*
        NO TOP BAR (review round 7, Bhargav: "I want the space from this top bar back"). It held the brand (now the
        rail's home link), the dev tag (gone), the build stamp, the running-runs badge and the account (all now in the
        rail). The 56px it took go to every screen.
      */}
      <div className="flex min-h-0 flex-1">
        <aside
          data-testid="app-nav"
          data-expanded={expanded ? "true" : "false"}
          className="relative hidden w-14 shrink-0 lg:block"
          onMouseEnter={() => {
            if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
            hoverTimer.current = window.setTimeout(() => setHovered(true), NAV_HOVER_DELAY_MS);
          }}
          onMouseLeave={() => {
            if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
            setHovered(false);
          }}
          onFocusCapture={(e) => {
            if ((e.target as HTMLElement).matches(":focus-visible")) setKeyFocus(true);
          }}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyFocus(false);
          }}
        >
          <div
            data-testid="app-nav-panel"
            className={cn(
              // z-40: above the page's own pinned bars (the gate rail's pin is z-30), below dialogs and popovers (z-50).
              "absolute inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-r border-rule-on-chrome bg-surface-chrome px-2 py-3 transition-[width] duration-150 ease-out motion-reduce:transition-none",
              expanded ? "w-60" : "w-14",
            )}
          >
            {/* HOME, AND THE PRODUCT'S NAME — what the top bar's brand was for. */}
            <Link
              href="/"
              data-testid="app-home"
              aria-label={collapsed ? "ddharmon — home" : undefined}
              title={collapsed ? "ddharmon — home" : undefined}
              className="mb-2 flex items-center gap-3 rounded px-3 py-2 text-on-chrome transition-colors hover:bg-on-chrome/8"
            >
              <PhMark tone="ground" className="h-4 w-4 shrink-0" />
              {expanded && <span className="whitespace-nowrap font-display text-sm font-semibold">ddharmon</span>}
            </Link>
            {expanded && IS_STATIC && (
              <span className="mx-3 mb-2 w-fit whitespace-nowrap rounded bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">
                Preview · sample data
              </span>
            )}
            <ActiveRunsIndicator compact={collapsed} />
            <nav id="app-nav-list" className="space-y-1">
              <NavLink href="/guide" icon={<BookOpen className="h-4 w-4 shrink-0" />} label="Guide" collapsed={collapsed} />
              <NavLink href="/methods" icon={<Workflow className="h-4 w-4 shrink-0" />} label="Methods" collapsed={collapsed} />
              <NavLink href="/benchmarks" icon={<Gauge className="h-4 w-4 shrink-0" />} label="Benchmarks" collapsed={collapsed} />
              <NavLink href="/design" icon={<Lightbulb className="h-4 w-4 shrink-0" />} label="Design" collapsed={collapsed} />
              <NavLink href="/demo" icon={<Sparkles className="h-4 w-4 shrink-0" />} label="Demo" collapsed={collapsed} />
              <NavLink href="/run/new/setup" icon={<Plus className="h-4 w-4 shrink-0" />} label="New run" collapsed={collapsed} />
              <NavLink href="/jobs" icon={<ListChecks className="h-4 w-4 shrink-0" />} label="Runs" collapsed={collapsed} />
              <NavLink href="/related" icon={<Boxes className="h-4 w-4 shrink-0" />} label="Related work" collapsed={collapsed} />
              <NavLink href="/roadmap" icon={<Milestone className="h-4 w-4 shrink-0" />} label="Roadmap" collapsed={collapsed} />
              <NavLink href="/architecture" icon={<Network className="h-4 w-4 shrink-0" />} label="Architecture" collapsed={collapsed} />
              <NavLink href="/phenome" icon={<Building2 className="h-4 w-4 shrink-0" />} label="Phenome Health" collapsed={collapsed} />
            </nav>
            <div className="mt-auto space-y-1 border-t border-rule-on-chrome pt-3 text-xs">
              {/* THE ACCOUNT, moved from the top bar (round 7). Only when the SSO gate is active. Guests get a sign-in
                  affordance; signed-in users get Clerk's UserButton (inside the ClerkProvider AuthProvider mounts). */}
              {AUTH_ENABLED &&
                (isGuest ? (
                  <button
                    type="button"
                    onClick={exitGuest}
                    aria-label={email ? `Sign out (${email}, read-only)` : "Sign in"}
                    title={
                      email
                        ? `Signed in as ${email} — read-only demo (running is limited to Phenome Health accounts)`
                        : "Guest — sign in"
                    }
                    className="flex w-full items-center gap-3 rounded px-3 py-2 text-left text-on-chrome-muted transition-colors hover:bg-on-chrome/8 hover:text-on-chrome"
                  >
                    <UserRound aria-hidden="true" className="h-4 w-4 shrink-0" />
                    {expanded && (
                      <span className="min-w-0 truncate">
                        {email ? `${email} · read-only · Sign out` : "Guest · Sign in"}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex items-center px-1.5 py-1">
                    <UserButton showName={expanded} />
                  </div>
                ))}
              {expanded && (
                <>
                  <a
                    href={PH.org}
                    target="_blank"
                    rel="noreferrer"
                    className="mb-1 flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 text-on-chrome-muted transition-colors hover:bg-on-chrome/10 hover:text-on-chrome"
                  >
                    <PhMark tone="ground" className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      A project of <span className="font-display font-semibold text-on-chrome">Phenome Health</span>
                    </span>
                  </a>
                  <a
                    href={ISSUES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 whitespace-nowrap rounded px-3 py-1.5 text-on-chrome-muted transition-colors hover:bg-on-chrome/10 hover:text-on-chrome"
                  >
                    <Github className="h-3.5 w-3.5" /> Report an issue
                  </a>
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="block whitespace-nowrap px-3 text-xs text-on-chrome-muted transition-colors hover:text-on-chrome"
                  >
                    View source on GitHub
                  </a>
                  <a
                    href="https://claude.com/claude-code"
                    target="_blank"
                    rel="noreferrer"
                    className="block whitespace-nowrap px-3 text-xs text-on-chrome-muted transition-colors hover:text-on-chrome"
                  >
                    Built with Claude Code
                  </a>
                </>
              )}
              {/* The build stamp stays in the DOM on the rail (screen-reader text) so a parity check can always read
                  it; it is drawn when the rail opens. */}
              {IS_DEV_CHANNEL && <BuildStamp className={expanded ? "block whitespace-nowrap px-3 pt-1" : "sr-only"} />}
            </div>
          </div>
        </aside>
        {/*
          Scrolling content region — and the app's ONLY vertical scroll context.

          `relative` IS LOAD-BEARING, NOT COSMETIC (08-14h Task 4). Without it this element is
          `position: static`, so it is not a containing block, so an absolutely positioned descendant
          with no positioned ancestor of its own is laid out against the INITIAL containing block —
          escaping both this element's `overflow-y: auto` and the shell's `overflow: hidden`, and
          extending the DOCUMENT's scrollable area instead.

          That is not hypothetical. `sr-only` is `position: absolute` by definition, and Gate 1's ledger
          renders one per row (the coherence judge's explanation, the "variables" unit): 58 on the
          shipped fixture, 117 rows' worth on the live run it was found on. The last one landed 3,344px
          down, which gave the page a SECOND vertical scrollbar — one that did not scroll the ledger but
          dragged the whole application, sidebar and header included, up off the top of the window.
          Measured 2026-08-31 at 1440x900 against a real parked run: Gate 1 reported a document scroll
          height of 3,157px where Setup, Gate 2, /jobs and /methods all reported exactly 900.

          So it was never a Gate 1 bug — Gate 1 was only the first screen with enough screen-reader text
          far enough down to make a latent app-wide one visible. Fixing it here means Gate 2's ledger
          growing cannot bring it back. `tests/e2e/gate1.spec.ts` asserts both the document scroll and
          the containing-block property, the second so a future reader cannot "simplify" this word away.
        */}
        <main className="relative min-w-0 flex-1 overflow-y-auto bg-surface-field text-on-field">
          <div className="mx-auto max-w-screen-2xl px-6 py-6 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
