import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Plus, ListChecks, BookOpen, Sparkles, Boxes, Building2, Github, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { IS_STATIC } from "@/lib/api";
import { ISSUES_URL, PH, REPO_URL } from "@/lib/links";
import { PhenomeChip } from "@/components/phenome-mark";
import { PhLogo } from "@/components/ph-logo";

function NavLink({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  const [loc] = useLocation();
  const active = loc === href || (href !== "/" && loc.startsWith(href));
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded px-3 py-2 text-sm transition-colors",
        active
          ? "bg-neutral-200 font-medium text-neutral-900"
          : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, toggle } = useTheme();
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-neutral-0">
      {/* Top bar (biomapper-ui chrome): logo + breadcrumb, sticky. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-neutral-0 px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <PhenomeChip />
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-ph-ink">ddharmon</span>
            <span className="text-neutral-300">/</span>
            <span className="text-neutral-500">Harmonization</span>
          </div>
        </Link>
        <div className="flex items-center gap-1">
          {IS_STATIC && (
            <span className="mr-2 rounded bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning">
              Preview · sample data
            </span>
          )}
          <span className="mr-2 hidden text-xs text-neutral-500 sm:block">Split-aware CDE harmonization</span>
          <button
            type="button"
            onClick={toggle}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
            className="flex h-8 w-8 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-ph-navy"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left sidebar nav. */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 px-3 py-4 lg:flex">
          <nav className="space-y-1">
            <NavLink href="/guide" icon={<BookOpen className="h-4 w-4" />} label="Guide" />
            <NavLink href="/demo" icon={<Sparkles className="h-4 w-4" />} label="Demo" />
            <NavLink href="/new" icon={<Plus className="h-4 w-4" />} label="New run" />
            <NavLink href="/jobs" icon={<ListChecks className="h-4 w-4" />} label="Runs" />
            <NavLink href="/related" icon={<Boxes className="h-4 w-4" />} label="Related work" />
            <NavLink href="/phenome" icon={<Building2 className="h-4 w-4" />} label="Phenome Health" />
          </nav>
          <div className="mt-auto space-y-1 border-t border-neutral-200 pt-3 text-xs">
            <a
              href={PH.org}
              target="_blank"
              rel="noreferrer"
              title="Phenome Health"
              className="mb-1.5 block rounded px-3 py-1.5 opacity-90 transition-opacity hover:opacity-100"
            >
              <div className="text-[9px] uppercase tracking-wide text-neutral-400">A project of</div>
              <PhLogo className="mt-1 h-4 w-auto" />
            </a>
            <a
              href={ISSUES_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded px-3 py-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-ph-navy"
            >
              <Github className="h-3.5 w-3.5" /> Report an issue
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="block px-3 text-[11px] text-neutral-400 transition-colors hover:text-ph-navy"
            >
              View source on GitHub
            </a>
            <a
              href="https://claude.com/claude-code"
              target="_blank"
              rel="noreferrer"
              className="block px-3 text-[11px] text-neutral-400 transition-colors hover:text-ph-navy"
            >
              Built with Claude Code
            </a>
          </div>
        </aside>

        {/* Scrolling content region. */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-screen-2xl px-6 py-8 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
