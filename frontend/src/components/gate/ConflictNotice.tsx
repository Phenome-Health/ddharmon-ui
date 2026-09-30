import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { GATE_CONFLICT_EVENT, conflictForJob, type GateConflictDetail } from "@/lib/gate-conflicts";

/**
 * The two-tab notice (UI-SPEC §8.4): a save on this screen replaced a decision this tab had not seen.
 *
 * Last write wins — the reviewer's save IS stored — so the notice is not an error to recover from; it is the one
 * thing a silent overwrite of another session's decision would have hidden. It offers the two resolutions that
 * exist: KEEP MINE (the save stands; dismiss) and RELOAD (see the run as it is now, the other tab's decisions
 * included). The sentence is the server's, rendered verbatim, so every screen says the same thing.
 *
 * PLACED ONCE, IN `GateShell`, so every gate screen shows it; fed by every decision hook on the screen through
 * `GATE_CONFLICT_EVENT`. FIXED to the viewport rather than in the page flow: Gate 1's ledger scrolls far past its
 * masthead, and a notice at the top of a page the reviewer has scrolled away from is a notice nobody sees.
 */
export function ConflictNotice({ jobId }: { jobId: string }) {
  const [state, setState] = useState<{ conflict: GateConflictDetail; count: number } | null>(null);

  useEffect(() => {
    setState(null);
    const onConflict = (event: Event) => {
      const conflict = conflictForJob(event as CustomEvent<unknown>, jobId);
      if (conflict) setState((prev) => ({ conflict, count: (prev?.count ?? 0) + 1 }));
    };
    window.addEventListener(GATE_CONFLICT_EVENT, onConflict);
    return () => window.removeEventListener(GATE_CONFLICT_EVENT, onConflict);
  }, [jobId]);

  if (!state) return null;
  const { conflict, count } = state;
  return (
    <div
      role="alert"
      data-testid="gate-conflict"
      data-kind={conflict.kind ?? ""}
      data-blind={conflict.sentBase ? "false" : "true"}
      className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(40rem,calc(100vw-2rem))] flex-col gap-3 rounded-card border border-l-4 border-rule-on-raised border-l-status-warn bg-surface-raised px-5 py-4 text-sm text-on-raised shadow-card"
    >
      <p className="max-w-[68ch]">
        {conflict.message}
        {count > 1 && (
          <span className="text-on-raised-muted">
            {" "}
            This happened on <span className="font-semibold tabular-nums text-on-raised">{count}</span> of your saves.
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-testid="gate-conflict-reload" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button size="sm" variant="outline" data-testid="gate-conflict-keep" onClick={() => setState(null)}>
          Keep mine
        </Button>
        <span className="text-xs text-on-raised-muted">
          Keep mine leaves your save as it is; Reload shows everything the other tab changed.
        </span>
      </div>
    </div>
  );
}
