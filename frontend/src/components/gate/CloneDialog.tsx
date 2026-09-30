import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AUTH_ENABLED, useAuthState } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cloneJob, listJobs } from "@/lib/api";
import {
  clearGuestSession,
  clearSandbox,
  cloneNameTaken,
  cloneRequestFor,
  clonedPathFor,
  readSandbox,
  sandboxJobsWithWork,
  sandboxWorkCount,
  signInCloneOffer,
  uniqueCloneName,
  wasGuestSession,
  type CloneFlavour,
} from "@/lib/sandbox";

/**
 * Keeping the shared demo: BOTH clone flavours, offered explicitly (08-18, UI-SPEC §8.5 / D3–D4).
 *
 * The demo is one shared row, so a visitor's edits live in their tab and the ONLY way to keep them is to ask. That
 * is why there is no fork-on-write anywhere and why this dialog never picks a flavour for the reviewer: someone
 * who has been evaluating wants their decisions carried; someone who was poking at buttons wants a clean copy.
 * Neither is right for everyone, and "Not now" keeps the edits in the tab exactly as they were.
 *
 * THE SANDBOX IS CLEARED ONLY AFTER A CLONE SUCCEEDS. With changes, they live on the copy now and leaving them
 * would double-count; fresh, the reviewer chose to leave them behind, and a stale set resurfacing on the next
 * visit would contradict that. A failed clone clears nothing — the tab is the only place that work exists.
 *
 * THE NAME is proposed, not imposed: a default that collides with one of the reviewer's runs is replaced by the
 * next free name AND the dialog says which name was taken, and a typed name that collides is refused in place.
 * Run ids are unique server-side, so nothing is ever overwritten — the rule exists so two identical names on the
 * Runs page are never created silently.
 */
export function CloneDialog({
  open,
  onOpenChange,
  jobId,
  sourceName,
  reason = "keep",
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The demo run being copied. */
  jobId: string;
  /** Its display name — the default copy name is built from it. */
  sourceName: string;
  /** `sign-in`: opened by the sign-in prompt, so the copy says why it appeared unasked. */
  reason?: "keep" | "sign-in";
  /** Called after a clone succeeded (before navigating to it). */
  onDone?: () => void;
}) {
  const [location, navigate] = useLocation();
  const { data: jobs } = useQuery({ queryKey: ["jobs"], queryFn: listJobs, enabled: open, staleTime: 30_000 });
  const existing = useMemo(() => (jobs ?? []).map((j) => j.displayName ?? "").filter(Boolean), [jobs]);
  const proposal = useMemo(() => uniqueCloneName(sourceName, existing), [sourceName, existing]);

  // Read when the dialog OPENS, not on every render: the count on the button is the count that will be posted.
  const [count, setCount] = useState(0);
  const [name, setName] = useState(proposal.name);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState<CloneFlavour | "">("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setCount(sandboxWorkCount(readSandbox(jobId)));
    setError("");
    setEdited(false);
  }, [open, jobId]);
  // The reviewer's runs arrive after the dialog opens; re-propose until they have typed a name of their own.
  useEffect(() => {
    if (open && !edited) setName(proposal.name);
  }, [open, edited, proposal.name]);

  const taken = name.trim() !== "" && cloneNameTaken(name, existing);
  const blocked = !!busy || name.trim() === "" || taken;

  async function clone(flavour: CloneFlavour) {
    setBusy(flavour);
    setError("");
    try {
      const { jobId: newId } = await cloneJob(jobId, cloneRequestFor(flavour, readSandbox(jobId), name));
      clearSandbox(jobId);
      onDone?.();
      onOpenChange(false);
      toast.success(
        flavour === "changes"
          ? `Copied with your ${count} change${count === 1 ? "" : "s"} — this copy is yours and is saved`
          : "Copy created — it is yours, and everything you do in it is saved",
      );
      navigate(clonedPathFor(location, jobId, newId));
    } catch (e) {
      // Nothing was cleared: the tab is still the only place these edits exist.
      setError(e instanceof Error ? e.message : "Could not copy this run");
    } finally {
      setBusy("");
    }
  }

  const plural = `${count} change${count === 1 ? "" : "s"}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="clone-dialog" data-reason={reason} data-unsaved={count}>
        <DialogHeader>
          <DialogTitle>{reason === "sign-in" ? "You're signed in — keep your demo work?" : "Keep a copy of the demo"}</DialogTitle>
          <DialogDescription>
            {count > 0
              ? `You made ${plural} on the shared demo. They are still only in this tab — nothing has been copied. Choose how to keep a copy of your own.`
              : "A copy of the demo that is yours: everything you do in it is saved."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <label htmlFor="clone-name" className="text-xs font-semibold uppercase tracking-eyebrow text-on-raised-muted">
            Name of your copy
          </label>
          <input
            id="clone-name"
            data-testid="clone-name"
            value={name}
            onChange={(e) => {
              setEdited(true);
              setName(e.target.value);
            }}
            className="min-h-8 rounded-inner border border-rule-control-on-raised bg-surface-raised px-2 py-1 text-sm text-on-raised"
          />
          {proposal.collided && !edited && (
            <p data-testid="clone-name-collision" role="status" className="text-xs text-on-raised-muted">
              You already have a run called “{proposal.taken}”, so this copy is named “{proposal.name}”. Change it if
              you like.
            </p>
          )}
          {taken && (
            <p data-testid="clone-name-taken" role="alert" className="text-xs font-semibold text-danger">
              You already have a run called “{name.trim()}”. Choose a different name.
            </p>
          )}
        </div>

        {error && (
          <p data-testid="clone-error" role="alert" className="text-sm text-danger">
            {error} Your changes are still here, in this tab.
          </p>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" data-testid="clone-not-now" disabled={!!busy} onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            variant="outline"
            data-testid="clone-fresh"
            disabled={blocked}
            onClick={() => void clone("fresh")}
            title={count > 0 ? `A clean copy — the ${plural} you made here are discarded.` : undefined}
          >
            {busy === "fresh" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
            Clone fresh
          </Button>
          {count > 0 && (
            <Button data-testid="clone-with-changes" disabled={blocked} onClick={() => void clone("changes")}>
              {busy === "changes" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Copy className="mr-1.5 h-3.5 w-3.5" />
              )}
              Clone with my changes ({count})
            </Button>
          )}
        </DialogFooter>
        {count > 0 && (
          <p className="text-xs text-on-raised-muted">
            Clone fresh leaves your {plural} behind. Not now keeps them in this tab until you close it.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The prompt a guest meets on SIGNING IN while holding demo work — mounted once, app-wide.
 *
 * App-wide because a sign-in does not return the reviewer to the gate they were on (the wall replaces the whole
 * app, and an OAuth round trip reloads it), so a prompt that lived on the gate screen would never be seen. The
 * decision itself is `signInCloneOffer` (pure, asserted in `sandbox.spec.ts`): only a full-access sign-in by a tab
 * that was a guest, only with work, only on a run that is a demo. With no work there is NO prompt — the marker is
 * simply consumed. Either way it appears at most once per sign-in, and nothing is copied until a flavour is chosen.
 */
export function SignInClonePrompt() {
  const { isAuthed, isGuest } = useAuthState();
  const wasGuest = wasGuestSession();
  const eligible = AUTH_ENABLED && isAuthed && !isGuest && wasGuest;
  const { data: jobs } = useQuery({ queryKey: ["jobs"], queryFn: listJobs, enabled: eligible });
  const [closed, setClosed] = useState(false);

  const offer = useMemo(() => {
    if (!eligible || !jobs) return null;
    const demoJobIds = new Set(jobs.filter((j) => (j.config as { demo?: boolean } | undefined)?.demo).map((j) => j.jobId));
    return signInCloneOffer({
      authEnabled: AUTH_ENABLED,
      isAuthed,
      isGuest,
      wasGuest,
      withWork: sandboxJobsWithWork(),
      demoJobIds,
    });
  }, [eligible, jobs, isAuthed, isGuest, wasGuest]);

  // Signed in with nothing to carry: consume the marker so the NEXT sign-in in this tab is judged afresh.
  useEffect(() => {
    if (eligible && jobs && !offer) clearGuestSession();
  }, [eligible, jobs, offer]);

  if (!offer || closed) return null;
  const source = jobs?.find((j) => j.jobId === offer.jobId);
  return (
    <CloneDialog
      open
      reason="sign-in"
      jobId={offer.jobId}
      sourceName={source?.displayName ?? "Demo"}
      onOpenChange={(o) => {
        if (o) return;
        clearGuestSession();
        setClosed(true);
      }}
    />
  );
}
