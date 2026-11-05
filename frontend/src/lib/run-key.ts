/**
 * The tab's BYOK key — held in MEMORY for the tab's lifetime, and nowhere else (08-28, the pre-ship blocker).
 *
 * WHY IT EXISTS. ddharmon is bring-your-own-key, and only Setup takes the key. It used to keep it in component
 * state, so the key was gone the moment the reviewer reached Gate 1, and every later paid call — Continue, Accept
 * the division, extracting a score's components, the Gate 4 match — went out with none. On a server with its own
 * key that was invisible; on a BYOK-only one (dev.ddharmon.io) every Continue was refused at the door, and no gate
 * screen had anywhere to enter a key.
 *
 * WHAT IT PROMISES — the promise Setup's copy already makes ("cleared when you reload this page"). A module-level
 * variable: it survives in-app navigation (Setup → the gates are client-side routes) and is gone on a reload or
 * when the tab closes. It is NEVER written to localStorage, sessionStorage, IndexedDB, the demo sandbox, a URL, a
 * cookie, a log, the run config or any artifact — `run-key.spec.ts` checks the source and the browser for that.
 * One Anthropic key per tab: 1.0 is Anthropic-only, and the gates' routes read `x-anthropic-key`.
 *
 * PURE: no `import.meta.env`, no fetch, no React — so the holder and the decision below are asserted in node. The
 * hook over it is `hooks/use-run-key.ts`; the field is `components/gate/RunKeyField.tsx`.
 */

// --- the server's machine-readable refusals -------------------------------------------------------------------

/**
 * The code a paid route answers when no key is available (`{detail, code}`, a 400; nothing committed or charged).
 * Mirrors `backend/llm_errors.py::KEY_REQUIRED` — `tests/test_key_refusal.py` pins the two to one spelling.
 */
export const KEY_REQUIRED = "key_required";
/** The code a paid route answers when the provider REJECTED the key it was given (401/403). Same mirror. */
export const KEY_REJECTED = "key_rejected";

export type KeyRefusal = typeof KEY_REQUIRED | typeof KEY_REJECTED;

// --- the holder -------------------------------------------------------------------------------------------------

let held: string | undefined;
const listeners = new Set<() => void>();

/** The key this tab holds, or `undefined`. What every paid call on the staged screens sends. */
export function heldRunKey(): string | undefined {
  return held;
}

/** Hold `key` (trimmed) for the rest of this tab's life. Blank is no key: holding "" forgets it. */
export function holdRunKey(key: string | null | undefined): void {
  const next = (key ?? "").trim() || undefined;
  if (next === held) return;
  held = next;
  for (const fn of [...listeners]) fn();
}

/** Forget the key — sign-out, or a test. A reload does the same for free. */
export function forgetRunKey(): void {
  holdRunKey(undefined);
}

/** Be told when the held key changes (the hook's `useSyncExternalStore` source). Returns the unsubscribe. */
export function subscribeRunKey(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- the decision: when does a screen ask for a key? --------------------------------------------------------------

/**
 * The key refusal an error carries, or `null` — read from its `code`, NEVER from its words.
 *
 * The API client's errors carry the server's `code` beside its message. Deciding on the sentence would let a copy
 * edit silently hide the field, so an error that merely SAYS "Enter your Anthropic API key" is not one.
 */
export function keyRefusalOf(error: unknown): KeyRefusal | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return code === KEY_REQUIRED || code === KEY_REJECTED ? code : null;
}

/**
 * Whether a failed paid call should reveal the key field, and why — or `null` to show the error alone.
 *
 * The trigger is the SERVER's refusal, not a guess made in advance: every call sends the held key when there is
 * one and none when there is not, and a server with its own key lets the keyless call through. Two places never
 * ask even so, because nothing there is paid: the pinned shared demo (it spends nothing and sends nothing), and a
 * preview run's Continue (it calls no model). `preview` is for the CONTINUE only — a preview run's score extraction
 * is still one paid model call, and the server refuses it without a key like any other.
 */
export function keyAskFor(error: unknown, ctx: { pinned?: boolean; preview?: boolean }): KeyRefusal | null {
  if (ctx.pinned || ctx.preview) return null;
  return keyRefusalOf(error);
}

/** Whether a run was started in preview mode, which calls no model — under either spelling of the mode key. */
export function isPreviewRun(config: Record<string, unknown> | null | undefined): boolean {
  const mode = config?.runMode ?? config?.run_mode ?? config?.mode;
  return mode === "preview";
}

/**
 * The field's sentence: what happened, that nothing was lost or charged, and which press to repeat.
 *
 * `action` is the control's own words ("Continue to Gate 3", "Accept this division"), so the sentence names the
 * button the reviewer is looking at rather than a generic "try again".
 */
export function keyAskCopy(reason: KeyRefusal, action: string): string {
  if (reason === KEY_REJECTED) {
    return (
      `The provider rejected the API key this tab sent. Enter a valid Anthropic key and press ${action} again — ` +
      "nothing was charged."
    );
  }
  return (
    "This step is a paid model call, and this tab holds no API key — the key is kept in this tab's memory only " +
    `and clears on reload. Enter it and press ${action} again. Nothing was charged, and nothing on this screen was ` +
    "lost."
  );
}
