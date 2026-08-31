import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { IS_STATIC, listJobs } from "@/lib/api";
import { countInFlight, isInFlight, justEnded } from "@/lib/run-state";
import type { JobSummary } from "@/types";

// A run is a server-side job, so it keeps executing wherever the user navigates. This component — mounted
// once in the AppShell header — is the app-wide observer of the user's runs: it shows a "N running" badge
// so an in-flight run is always visible, and fires a completion toast (from any page) when one finishes, so
// the user never has to sit on the run page. It shares the ["jobs"] query cache with the Runs page.
//
// IT USED TO COUNT PARKED RUNS AS RUNNING. Its own `TERMINAL = new Set(["complete", "error",
// "cancelled"])` made `awaiting_review` look non-terminal, so the badge read "5 running" with a spinning
// loader over five runs that had exited at a gate and were spending nothing — a spinner being a claim
// that something is happening. The predicates now come from `@/lib/run-state` and are shared with the
// Runs page, so the two surfaces cannot drift apart again.
//
// THE BADGE SIMPLY DOES NOT RENDER when nothing is in flight, and no paused variant replaces it. Zero
// running is an honest zero, and hiding it strands nobody: the sidebar carries a permanent Runs link
// (`AppShell.tsx:106`), which is the reviewer's route back to a parked run.

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
      // Poll only while something can change on its own. A parked run changes when a HUMAN acts, and
      // polling for that costs a request every four seconds to observe a run that is standing still.
      return countInFlight(list) > 0 ? 4000 : false;
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
      if (!justEnded(prev, j.status)) continue;
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

  const active = jobs?.filter((j) => isInFlight(j.status)) ?? [];
  if (IS_STATIC || active.length === 0) return null;

  return (
    <Link
      href="/jobs"
      title={`${active.length} run${active.length === 1 ? "" : "s"} in progress — view Runs`}
      data-testid="active-runs"
      className="mr-1 flex items-center gap-1.5 rounded bg-surface-info px-2 py-0.5 text-xs font-semibold text-accent-on-raised transition-colors hover:bg-rule-info"
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      {active.length} running
    </Link>
  );
}
