import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deleteJob, listJobs, rerunJob } from "@/lib/api";
import { useAuthState } from "@/auth";
import type { JobSummary } from "@/types";

// Terminal statuses; anything else is an in-flight phase (data-driven — we don't enumerate phases).
const TERMINAL = new Set(["complete", "error"]);

// Re-run a past run from its server-retained uploads. Preview runs (no LLM) go in one click; batch/sync runs
// need the Anthropic key re-entered (it's never persisted, so the Runs page can't have it) via a small dialog.
function RerunAction({ job }: { job: JobSummary }) {
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

export default function JobsPage() {
  const qc = useQueryClient();
  const { isGuest } = useAuthState();
  // Real runs are per-account and behind the SSO gate, so guests don't fetch the list (it would 401) —
  // they get a sign-in CTA instead. The demo lives on its own page.
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: listJobs,
    refetchInterval: 3000,
    enabled: !isGuest,
  });

  async function remove(jobId: string) {
    await deleteJob(jobId);
    qc.invalidateQueries({ queryKey: ["jobs"] });
  }

  if (isGuest) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <h1 className="text-2xl font-semibold text-ph-ink">Runs</h1>
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <p className="text-sm text-neutral-600">Your runs live in your account.</p>
            <p className="text-xs text-neutral-500">
              Sign in to upload cohorts and see your harmonization runs here — or try the{" "}
              <Link href="/demo" className="text-ph-navy underline hover:text-ph-ink">
                demo
              </Link>{" "}
              without an account.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold text-ph-ink">Runs</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Records</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.jobId}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Link
                        href={
                          j.status === "complete" || (j.config as { demo?: boolean })?.demo
                            ? `/job/${j.jobId}?results=1`
                            : `/job/${j.jobId}`
                        }
                        className="font-medium text-ph-navy hover:underline"
                      >
                        {j.displayName}
                      </Link>
                      {(j.config as { demo?: boolean })?.demo && (
                        <Badge variant="outline" className="border-ph-navy/30 text-ph-navy">
                          Demo
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={j.status === "complete" ? "secondary" : j.status === "error" ? "destructive" : "outline"}>
                      {TERMINAL.has(j.status) ? j.status : j.phase}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{j.nRecords || "—"}</TableCell>
                  <TableCell className="text-sm text-neutral-500">
                    {new Date(j.createdAt * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="flex items-center justify-end gap-1">
                      {TERMINAL.has(j.status) && !(j.config as { demo?: boolean })?.demo && <RerunAction job={j} />}
                      <Button variant="ghost" size="icon" onClick={() => remove(j.jobId)} aria-label="Delete">
                        <Trash2 className="h-4 w-4 text-neutral-400" />
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {!jobs.length && !isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-neutral-400">
                    No runs yet. <Link href="/new" className="text-ph-navy hover:underline">Start one →</Link>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
