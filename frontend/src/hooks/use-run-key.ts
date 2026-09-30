import { useSyncExternalStore } from "react";
import { heldRunKey, holdRunKey, subscribeRunKey } from "@/lib/run-key";

/**
 * The tab's held BYOK key, as React state — re-rendering whoever reads it when any screen changes it.
 *
 * A thin view over `lib/run-key.ts`, which owns the promise (memory only, tab lifetime). Every key field on the
 * staged screens reads and writes through this, so a key typed into the division's field is the key the Continue
 * bar and the score panels send next: one key per tab, not one per control.
 */
export function useRunKey(): [string, (key: string) => void] {
  const key = useSyncExternalStore(subscribeRunKey, heldRunKey, heldRunKey);
  return [key ?? "", holdRunKey];
}
