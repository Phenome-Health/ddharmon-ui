import { useEffect, useState } from "react";
import { onSandboxChange, sandboxVerdictCount } from "@/lib/sandbox";

/**
 * How many edits this tab holds for a run — LIVE (08-18).
 *
 * Subscribed to the sandbox's own change event rather than read from storage at render: every decision hook on a
 * screen writes after the render its click caused, so a render-time read is the shipped workbench banner's
 * "one click behind, forever" bug. Best-effort like the store itself: storage that throws reads as zero.
 */
export function useSandboxCount(jobId: string): number {
  const [count, setCount] = useState(() => sandboxVerdictCount(jobId));
  useEffect(() => {
    setCount(sandboxVerdictCount(jobId));
    return onSandboxChange(jobId, () => setCount(sandboxVerdictCount(jobId)));
  }, [jobId]);
  return count;
}
