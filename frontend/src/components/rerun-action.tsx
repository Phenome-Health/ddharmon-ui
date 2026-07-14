import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { rerunJob } from "@/lib/api";
import type { JobSummary } from "@/types";

// Re-run a past run from its server-retained uploads. Preview runs (no LLM) go in one click; batch/sync runs
// need the Anthropic key re-entered (it's never persisted, so the client can't have it) via a small dialog.
// Shared between the Runs list (icon-only) and a run's error state (labeled) — pass `labeled` for the latter.
// Accepts anything carrying the run's id, name, and config (a JobSummary row or a live JobResult).
export function RerunAction({
  job,
  labeled = false,
}: {
  job: Pick<JobSummary, "jobId" | "displayName" | "config">;
  labeled?: boolean;
}) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const mode = (job.config as { run_mode?: string })?.run_mode ?? "batch";
  const needsKey = mode !== "preview";
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go(apiKey?: string) {
    setBusy(true);
    setErr(null);
    try {
      const { jobId } = await rerunJob(job.jobId, apiKey);
      setOpen(false);
      setKey("");
      qc.invalidateQueries({ queryKey: ["jobs"] });
      navigate(`/job/${jobId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Re-run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {labeled ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => (needsKey ? setOpen(true) : go())}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {busy ? "Starting…" : "Re-run with same inputs"}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Re-run"
          title="Re-run this run"
          disabled={busy}
          onClick={() => (needsKey ? setOpen(true) : go())}
        >
          <RotateCcw className="h-4 w-4 text-neutral-400" />
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-run “{job.displayName}”</DialogTitle>
            <DialogDescription>
              This {mode} run calls the LLM, so it needs your Anthropic API key again. The key is sent for this
              run only — never written to disk, logs, or the saved run.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            placeholder="sk-ant-…"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && key.trim()) go(key.trim());
            }}
          />
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => go(key.trim() || undefined)} disabled={busy || !key.trim()}>
              {busy ? "Starting…" : "Re-run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
