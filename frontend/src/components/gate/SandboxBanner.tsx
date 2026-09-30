import { useEffect, useState } from "react";
import { Copy, FlaskConical, LogIn } from "lucide-react";
import { AUTH_ENABLED, useAuthState } from "@/auth";
import { Button } from "@/components/ui/button";
import { CloneDialog } from "@/components/gate/CloneDialog";
import { SANDBOX_BANNER_COPY, onSandboxChange, sandboxVerdictCount } from "@/lib/sandbox";

/**
 * The shared-demo banner every gate screen wears (08-18, UI-SPEC §8.5 "Leaving the demo sandbox").
 *
 * PERSISTENT, NOT A MODAL. It is in the flow of the page, above the masthead, on every screen of the walk — a
 * modal would be dismissed once and the promise it makes forgotten. The sentence is the contract's, verbatim
 * (`SANDBOX_BANNER_COPY`): this is the shared demo, the changes are the visitor's alone, they are not saved, they
 * disappear with the tab, and cloning is how to keep them. Every one of those clauses is literally true because
 * the edits are in sessionStorage and nowhere else (`lib/sandbox.ts`).
 *
 * THE COUNT IS LIVE. It is read from the sandbox on every write the tab makes (`onSandboxChange`), not from
 * storage at render time — the shipped workbench banner read storage on render and was one click behind forever.
 *
 * WHAT IT OFFERS depends on who is looking, because keeping a copy needs an account that can own one:
 *  - an anonymous guest is offered sign-in, and signing in offers the clone (`SignInClonePrompt`);
 *  - a signed-in, read-only account is told plainly that keeping a copy needs full access;
 *  - anyone who can own a run opens the clone dialog, which offers both flavours explicitly.
 */
export function SandboxBanner({ jobId, sourceName }: { jobId: string; sourceName?: string }) {
  const { isGuest, exitGuest, email } = useAuthState();
  const [count, setCount] = useState(() => sandboxVerdictCount(jobId));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setCount(sandboxVerdictCount(jobId));
    return onSandboxChange(jobId, () => setCount(sandboxVerdictCount(jobId)));
  }, [jobId]);

  const guest = AUTH_ENABLED && isGuest;
  return (
    <section
      aria-label="Shared demo"
      data-testid="sandbox-banner"
      data-unsaved={count}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-inner border border-rule-on-field bg-on-field/5 px-4 py-3"
    >
      <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-on-field">
        <FlaskConical aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-on-field-muted" />
        <span>
          <span data-testid="sandbox-banner-copy">{SANDBOX_BANNER_COPY}</span>{" "}
          <span data-testid="sandbox-unsaved" className="font-semibold">
            {count > 0 ? `${count} unsaved change${count === 1 ? "" : "s"} in this tab.` : "No changes yet."}
          </span>
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {guest && !email && (
          <Button size="sm" data-testid="sandbox-sign-in" onClick={exitGuest} className="gap-1.5">
            <LogIn aria-hidden="true" className="h-3.5 w-3.5" />
            Sign in to keep them
          </Button>
        )}
        {guest && email && (
          <span data-testid="sandbox-read-only" className="text-xs text-on-field-muted">
            Keeping a copy needs a full-access account.
          </span>
        )}
        {!guest && (
          <Button size="sm" data-testid="sandbox-keep" onClick={() => setOpen(true)} className="gap-1.5">
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            {count > 0 ? "Keep a copy…" : "Make my own copy…"}
          </Button>
        )}
      </div>
      {!guest && (
        <CloneDialog open={open} onOpenChange={setOpen} jobId={jobId} sourceName={sourceName ?? "Demo"} />
      )}
    </section>
  );
}
