import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Plus, ListChecks, BookOpen, Workflow, Gauge, Lightbulb, Sparkles, Boxes, Building2, Milestone, Network, Github,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { UserButton } from "@clerk/react";
import { cn } from "@/lib/utils";
import { readNavCollapsed, writeNavCollapsed } from "@/lib/nav-collapse";
import { AUTH_ENABLED, useAuthState } from "@/auth";
import { IS_STATIC } from "@/lib/api";
import { ISSUES_URL, PH, REPO_URL } from "@/lib/links";
import { PhMark } from "@/components/ph-logo";
import { ActiveRunsIndicator } from "@/components/active-runs-indicator";
import { GlobalStatusBanner } from "@/components/global-status-banner";

// Dev channel: a build pinned to an UNRELEASED core (git ref), deployed to dev.ddharmon.io for
// pre-PyPI validation. Baked in at build time (VITE_APP_CHANNEL=dev); defaults to prod so a normal
// build is never mislabeled. Surfaced as a prominent badge so a dev build is never mistaken for prod.
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
  /** Icon-rail form: the label is still the accessible name, it is just not drawn (08-16c Task 5). */
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
        "flex items-center rounded text-sm transition-colors",
        collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2",
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

export function AppShell({ children }: { children: ReactNode }) {
  const { isGuest, exitGuest, email } = useAuthState();
  /**
   * Seeded from storage on FIRST RENDER, not in an effect (08-16c Task 5). An effect would paint the
   * expanded nav and then snap it shut on every navigation for a reviewer who chose collapsed — a flash
   * of the state they explicitly turned off.
   */
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => readNavCollapsed());
  const toggleNav = () => {
    setNavCollapsed((cur) => {
      writeNavCollapsed(!cur);
      return !cur;
    });
  };
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-chrome">
      {/* Site-wide "under active development" notice — every page, both prod + dev channels. */}
      <GlobalStatusBanner />
      {/* Top bar (biomapper-ui chrome): logo + breadcrumb, sticky. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-rule-on-chrome bg-surface-chrome px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <PhMark tone="ground" className="h-6 w-6" />
          <div className="flex items-center gap-2 text-sm">
            <span className="font-display font-semibold text-on-chrome">Phenome Health</span>
            <span className="text-on-chrome-faint">/</span>
            <span className="font-display text-on-chrome-muted">ddharmon</span>
          </div>
        </Link>
        <div className="flex items-center gap-1">
          {IS_DEV_CHANNEL && (
            <span
              title="Development build — pinned to an unreleased core from GitHub, not the PyPI release. For pre-release testing only."
              className="mr-2 rounded border border-danger-border bg-danger-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-eyebrow text-danger"
            >
              Dev · unreleased core
            </span>
          )}
          {IS_STATIC && (
            <span className="mr-2 rounded bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">
              Preview · sample data
            </span>
          )}
          <ActiveRunsIndicator />
          {/* Account area — only when the SSO gate is active. Guests get a "Sign in" affordance; signed-in
              users get Clerk's UserButton (which must live inside the ClerkProvider AuthProvider mounts). */}
          {AUTH_ENABLED && (
            <div className="ml-1 flex items-center gap-2">
              {isGuest ? (
                <>
                  <span
                    title={email ? `Signed in as ${email} — read-only demo (running is limited to Phenome Health accounts)` : undefined}
                    className="max-w-[16rem] truncate rounded bg-surface-inset px-2 py-0.5 text-xs font-semibold text-on-inset-muted"
                  >
                    {email ? `${email} · read-only` : "Guest"}
                  </span>
                  <button
                    type="button"
                    onClick={exitGuest}
                    className="rounded px-2 py-1 text-xs font-semibold text-on-chrome transition-colors hover:bg-on-chrome/10"
                  >
                    {email ? "Sign out" : "Sign in"}
                  </button>
                </>
              ) : (
                <UserButton />
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left sidebar nav. */}
        <aside
          data-testid="app-nav"
          data-collapsed={navCollapsed ? "true" : "false"}
          className={cn(
            "hidden shrink-0 flex-col border-r border-rule-on-chrome bg-surface-chrome py-4 lg:flex",
            // The icon rail keeps every destination reachable and the current one identifiable; only the
            // labels go. Full removal would have made "which page am I on" unanswerable from the chrome.
            navCollapsed ? "w-14 px-2" : "w-60 px-3",
          )}
        >
          {/* Inside the aside, so below the `lg:` breakpoint — where the nav is already hidden — the
              control neither appears nor occupies space. */}
          <button
            type="button"
            data-testid="app-nav-toggle"
            onClick={toggleNav}
            aria-expanded={!navCollapsed}
            aria-controls="app-nav-list"
            // Names the ACTION, not the state: "Collapse navigation" is what pressing it does.
            aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
            title={navCollapsed ? "Expand navigation" : "Collapse navigation"}
            className={cn(
              "mb-2 flex items-center gap-2 rounded px-2 py-1.5 text-xs text-on-chrome-muted transition-colors hover:bg-on-chrome/10 hover:text-on-chrome",
              navCollapsed ? "justify-center" : "justify-start",
            )}
          >
            {navCollapsed ? (
              <PanelLeftOpen aria-hidden="true" className="h-4 w-4 shrink-0" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="h-4 w-4 shrink-0" />
            )}
            {!navCollapsed && <span>Collapse</span>}
          </button>
          <nav id="app-nav-list" className="space-y-1">
            <NavLink href="/guide" icon={<BookOpen className="h-4 w-4" />} label="Guide" collapsed={navCollapsed} />
            <NavLink href="/methods" icon={<Workflow className="h-4 w-4" />} label="Methods" collapsed={navCollapsed} />
            <NavLink href="/benchmarks" icon={<Gauge className="h-4 w-4" />} label="Benchmarks" collapsed={navCollapsed} />
            <NavLink href="/design" icon={<Lightbulb className="h-4 w-4" />} label="Design" collapsed={navCollapsed} />
            <NavLink href="/demo" icon={<Sparkles className="h-4 w-4" />} label="Demo" collapsed={navCollapsed} />
            <NavLink href="/run/new/setup" icon={<Plus className="h-4 w-4" />} label="New run" collapsed={navCollapsed} />
            <NavLink href="/jobs" icon={<ListChecks className="h-4 w-4" />} label="Runs" collapsed={navCollapsed} />
            <NavLink href="/related" icon={<Boxes className="h-4 w-4" />} label="Related work" collapsed={navCollapsed} />
            <NavLink href="/roadmap" icon={<Milestone className="h-4 w-4" />} label="Roadmap" collapsed={navCollapsed} />
            <NavLink href="/architecture" icon={<Network className="h-4 w-4" />} label="Architecture" collapsed={navCollapsed} />
            <NavLink href="/phenome" icon={<Building2 className="h-4 w-4" />} label="Phenome Health" collapsed={navCollapsed} />
          </nav>
          <div
            className={cn(
              "mt-auto space-y-1 border-t border-rule-on-chrome pt-3 text-xs",
              // The footer is prose + a mark. Collapsed there is no room for the words, so it goes rather
              // than wrapping into an unreadable column.
              navCollapsed && "hidden",
            )}
          >
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
              className="flex items-center gap-2 rounded px-3 py-1.5 text-on-chrome-muted transition-colors hover:bg-on-chrome/10 hover:text-on-chrome"
            >
              <Github className="h-3.5 w-3.5" /> Report an issue
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="block px-3 text-xs text-on-chrome-muted transition-colors hover:text-on-chrome"
            >
              View source on GitHub
            </a>
            <a
              href="https://claude.com/claude-code"
              target="_blank"
              rel="noreferrer"
              className="block px-3 text-xs text-on-chrome-muted transition-colors hover:text-on-chrome"
            >
              Built with Claude Code
            </a>
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
