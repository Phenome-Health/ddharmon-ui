import { Link } from "wouter";
import { RotateCcw } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { rerunSetupPathFor } from "@/lib/gate-routes";
import type { JobSummary } from "@/types";

// Re-run a past run: open Setup for a NEW run, prefilled with this one's dictionaries, column roles and
// options, for the reviewer to check and start (08-28). A LINK, not an action — it buys nothing by itself.
//
// It used to POST the re-run at once, in the old run's mode (asking for the key in a dialog first), and then
// land on the legacy run page, which has no way into the gates. That assumed the run type the reviewer
// wanted and started a paid run they never got to look at. The run type is a conscious choice made on
// Setup, beside the price it changes, so every re-run entry point now lands there.
//
// Shared between the Runs list (icon-only) and a run's error / stopped / preview states (labeled).
export function RerunAction({
  job,
  labeled = false,
}: {
  job: Pick<JobSummary, "jobId" | "displayName">;
  labeled?: boolean;
}) {
  const href = rerunSetupPathFor(job.jobId);
  const title = `Set up a new run with the same inputs as “${job.displayName}” — nothing starts until you press Start`;
  return labeled ? (
    <Link href={href} title={title} className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
      <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Re-run with same inputs
    </Link>
  ) : (
    <Link
      href={href}
      aria-label="Re-run"
      title={title}
      className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
    >
      <RotateCcw className="h-4 w-4 text-on-raised-muted" />
    </Link>
  );
}
