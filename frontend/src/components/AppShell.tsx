import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Network, Plus, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

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
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white">
      {/* Top bar (biomapper-ui chrome): logo + breadcrumb, sticky. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-ph-navy text-white">
            <Network className="h-3.5 w-3.5" />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-ph-ink">ddharmon</span>
            <span className="text-neutral-300">/</span>
            <span className="text-neutral-500">Harmonization</span>
          </div>
        </Link>
        <div className="hidden text-xs text-neutral-500 sm:block">Split-aware CDE harmonization</div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left sidebar nav. */}
        <aside className="hidden w-60 shrink-0 border-r border-neutral-200 bg-neutral-50 px-3 py-4 lg:block">
          <nav className="space-y-1">
            <NavLink href="/" icon={<Plus className="h-4 w-4" />} label="New run" />
            <NavLink href="/jobs" icon={<ListChecks className="h-4 w-4" />} label="Runs" />
          </nav>
        </aside>

        {/* Scrolling content region. */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-screen-2xl px-6 py-8 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
