import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useRunKey } from "@/hooks/use-run-key";
import { PROVIDER_KEY_INFO } from "@/lib/provider-keys";
import { keyAskCopy, type KeyRefusal } from "@/lib/run-key";
import { cn } from "@/lib/utils";

/**
 * The inline key field a gate shows when the SERVER said a paid press needs a key (08-28, BYOK on Continue).
 *
 * WHERE IT APPEARS is where the reviewer pressed: the Continue bar beside its price, the division's proposal, the
 * score panels. Never up front — a server with its own key needs none, and the demo and a preview's Continue buy
 * nothing — so a host renders this only on a key refusal (`keyAskFor` in `lib/run-key.ts` decides). The retry is
 * the host's OWN button, pressed again: this field adds no second control that could spend.
 *
 * ONE KEY PER TAB. The value is the tab's held key (`useRunKey`), written as it is typed, so a key entered here is
 * the key every later paid call on every gate sends — and, like Setup's, it lives in memory only and clears on
 * reload. Setup's look and hints: the same password box, reveal toggle, `PROVIDER_KEY_INFO` placeholder and "Get a
 * key" link (Anthropic: the one provider the gates' routes read a key for).
 */
export function RunKeyField({
  reason,
  action,
  className,
}: {
  /** Why the server refused: no key, or a key the provider rejected. */
  reason: KeyRefusal;
  /** The words on the button to press again — the sentence names it. */
  action: string;
  className?: string;
}) {
  const id = useId();
  const [key, setKey] = useRunKey();
  const [show, setShow] = useState(false);
  const info = PROVIDER_KEY_INFO.anthropic;
  return (
    <div data-testid="run-key-field" data-reason={reason} className={cn("flex max-w-[68ch] flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-semibold text-on-raised">
        Anthropic API key
      </label>
      {/* The reveal is a RENDERING toggle and nothing else — the same pattern as Setup's key field. */}
      <div className="relative max-w-[40ch]">
        <input
          id={id}
          data-testid="run-key-input"
          type={show ? "text" : "password"}
          value={key}
          placeholder={info?.placeholder ?? "your API key"}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-label="Anthropic API key"
          onChange={(e) => setKey(e.target.value)}
          className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 pr-8 font-mono text-xs text-on-raised placeholder:text-on-raised-muted"
        />
        <button
          type="button"
          data-testid="run-key-reveal"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide API key" : "Show API key"}
          aria-pressed={show}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-on-raised-muted transition-colors hover:text-accent-on-raised"
        >
          {show ? <EyeOff aria-hidden="true" className="h-3.5 w-3.5" /> : <Eye aria-hidden="true" className="h-3.5 w-3.5" />}
        </button>
      </div>
      <p data-testid="run-key-copy" role="status" className="text-xs text-on-raised-muted">
        {keyAskCopy(reason, action)} Sent over HTTPS for this tab only — never written to disk, to logs, or into the
        saved run configuration.{" "}
        {info?.link && (
          <a
            data-testid="run-key-help-link"
            href={info.link}
            target="_blank"
            rel="noreferrer"
            className="text-link-on-raised underline hover:text-on-raised"
          >
            Get a key
          </a>
        )}
      </p>
    </div>
  );
}
