import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { IS_STATIC, listJobs } from "@/lib/api";
import type { JobSummary } from "@/types";

// A run is a server-side job, so it keeps executing wherever the user navigates. This component — mounted
// once in the AppShell header — is the app-wide observer of the user's runs: it shows a "N running" badge
// so an in-flight run is always visible, and fires a completion toast (from any page) when one finishes, so
// the user never has to sit on the run page. It shares the ["jobs"] query cache with the Runs page.
const TERMINAL = new Set(["complete", "error", "cancelled"]);

export function ActiveRunsIndicator() {
  const [, navigate] = useLocation();
  // Poll while any run is in flight; stop when everything is terminal (refetchInterval → false). Disabled on
  // the static preview, where jobs.json is a fixed fixture with nothing to observe.
  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: listJobs,
    enabled: !IS_STATIC,
    refetchInterval: (query) => {
      const list = query.state.data as JobSummary[] | undefined;
      return list?.some((j) => !TERMINAL.has(j.status)) ? 4000 : false;
    },
  });

  // Announce a run that flips from in-flight → terminal. Seed the status map on first load so runs that were
  // already finished before this mounted don't trigger a burst of stale toasts.
  const lastStatus = useRef<Map<string, string>>(new Map());
  const seeded = useRef(false);
  useEffect(() => {
    if (!jobs) return;
    if (!seeded.current) {
      for (const j of jobs) lastStatus.current.set(j.jobId, j.status);
      seeded.current = true;
      return;
    }
    for (const j of jobs) {
      const prev = lastStatus.current.get(j.jobId);
      lastStatus.current.set(j.jobId, j.status);
      if (!prev || TERMINAL.has(prev) || !TERMINAL.has(j.status)) continue;
      const goTo = () => navigate(`/job/${j.jobId}`);
      if (j.status === "complete") {
        toast.success("Run finished", {
          description: j.displayName,
          action: { label: "View results", onClick: goTo },
        });
      } else if (j.status === "cancelled") {
        toast("Run stopped", {
          description: j.displayName,
          action: { label: "View", onClick: goTo },
        });
      } else {
        toast.error("Run failed", {
          description: j.displayName,
          action: { label: "Details", onClick: goTo },
        });
      }
    }
  }, [jobs, navigate]);

  const active = jobs?.filter((j) => !TERMINAL.has(j.status)) ?? [];
  if (IS_STATIC || active.length === 0) return null;

  return (
    <Link
      href="/jobs"
      title={`${active.length} run${active.length === 1 ? "" : "s"} in progress — view Runs`}
      className="mr-1 flex items-center gap-1.5 rounded bg-ph-navy/10 px-2 py-0.5 text-[11px] font-medium text-ph-navy transition-colors hover:bg-ph-navy/20"
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      {active.length} running
    </Link>
  );
}
