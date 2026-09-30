import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  KEY_REJECTED,
  KEY_REQUIRED,
  forgetRunKey,
  heldRunKey,
  holdRunKey,
  isPreviewRun,
  keyAskCopy,
  keyAskFor,
  keyRefusalOf,
  subscribeRunKey,
} from "@/lib/run-key";

/**
 * The tab's BYOK key holder and the one decision made on it (08-28, the pre-ship blocker) — in node.
 *
 * `lib/run-key.ts` is the whole promise: the key lives in memory for the tab's lifetime (in-app navigation keeps
 * it, a reload drops it), nothing writes it anywhere else, and a screen reveals its key field on the SERVER's
 * machine-readable refusal (`code: "key_required"` / `"key_rejected"`, pinned to the backend by
 * `tests/test_key_refusal.py`) — never on the refusal's English sentence, and never where nothing is paid.
 * The screens that use it are walked in `run-key-gates.spec.ts`.
 *
 *   run: E2E_PORT=4213 npx playwright test run-key
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk-ant-test-0000";
const NEW_KEY = "sk-ant-test-1111";
const REFUSED_DETAIL =
  "Enter your Anthropic API key to continue — a paid step needs it and the key clears on reload. Your gate " +
  "state is preserved; re-enter the key and press Continue again.";

// --- the holder and the decision, in node -------------------------------------------------------------------

test.describe("run key holder", () => {
  test.beforeEach(() => forgetRunKey());

  test("@runkey holds one trimmed key, and an empty one is no key", () => {
    expect(heldRunKey()).toBeUndefined();
    holdRunKey(`  ${KEY}  `);
    expect(heldRunKey()).toBe(KEY);
    holdRunKey("   ");
    expect(heldRunKey()).toBeUndefined();
    holdRunKey(KEY);
    forgetRunKey();
    expect(heldRunKey()).toBeUndefined();
  });

  test("@runkey tells its subscribers when the key changes, and only then", () => {
    const seen: (string | undefined)[] = [];
    const stop = subscribeRunKey(() => seen.push(heldRunKey()));
    holdRunKey(KEY);
    holdRunKey(KEY); // no change, no notice
    holdRunKey(NEW_KEY);
    forgetRunKey();
    stop();
    holdRunKey(KEY); // unsubscribed
    expect(seen).toEqual([KEY, NEW_KEY, undefined]);
  });

  test("@runkey the field is revealed on the server's CODE, never on its English sentence", () => {
    const coded = Object.assign(new Error(REFUSED_DETAIL), { status: 400, code: KEY_REQUIRED });
    const rejected = Object.assign(new Error("The model provider rejected the API key (401)."), {
      status: 401,
      code: KEY_REJECTED,
    });
    expect(keyRefusalOf(coded)).toBe(KEY_REQUIRED);
    expect(keyRefusalOf(rejected)).toBe(KEY_REJECTED);
    // The same words WITHOUT the code are not a key refusal: a copy edit must not be what shows the field.
    expect(keyRefusalOf(new Error(REFUSED_DETAIL))).toBeNull();
    expect(keyRefusalOf(Object.assign(new Error("x"), { code: "something_else" }))).toBeNull();
    for (const e of [null, undefined, "key_required", 400, {}]) expect(keyRefusalOf(e)).toBeNull();

    expect(keyAskFor(coded, {})).toBe(KEY_REQUIRED);
    expect(keyAskFor(rejected, {})).toBe(KEY_REJECTED);
    // No prompt where nothing is paid: the pinned demo spends nothing, and a preview's Continue calls no model.
    expect(keyAskFor(coded, { pinned: true })).toBeNull();
    expect(keyAskFor(coded, { preview: true })).toBeNull();
    expect(keyAskFor(new Error("Could not continue"), {})).toBeNull();
  });

  test("@runkey a preview run is recognised under every spelling of its mode", () => {
    expect(isPreviewRun({ runMode: "preview" })).toBe(true);
    expect(isPreviewRun({ run_mode: "preview" })).toBe(true);
    expect(isPreviewRun({ runMode: "batch" })).toBe(false);
    expect(isPreviewRun({ run_mode: "sync" })).toBe(false);
    expect(isPreviewRun(undefined)).toBe(false);
  });

  test("@runkey the copy says what happened, what is kept, and what to press", () => {
    const missing = keyAskCopy(KEY_REQUIRED, "Continue to Gate 2");
    expect(missing).toMatch(/paid/i);
    expect(missing).toMatch(/clears on reload/i);
    expect(missing).toMatch(/Nothing was charged/);
    expect(missing).toContain("Continue to Gate 2");
    const bad = keyAskCopy(KEY_REJECTED, "Match");
    expect(bad).toMatch(/rejected/i);
    expect(bad).toContain("Match");
  });

  test("@runkey the key code touches no storage, no URL and no log", () => {
    const src = (rel: string) => readFileSync(path.resolve(HERE, "../../src", rel), "utf8");
    for (const file of ["lib/run-key.ts", "hooks/use-run-key.ts", "components/gate/RunKeyField.tsx"]) {
      const code = src(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.|location\.|console\./);
    }
  });
});
