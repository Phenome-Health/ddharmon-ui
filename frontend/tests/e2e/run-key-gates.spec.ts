import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Request, type Route } from "@playwright/test";
import { KEY_REJECTED, KEY_REQUIRED } from "@/lib/run-key";
import type { JobResult } from "@/types";
import { PAUSED_JOB, asOwnedRun, gate1Fixture } from "./gate1-fixture";
import { FINISHED_JOB, finishedFixture } from "./gate23-fixture";

/**
 * The BYOK key on the staged screens (08-28, the pre-ship blocker).
 *
 * THE BUG. Only Setup took the key, and only in component state, so it was gone the moment the reviewer reached
 * Gate 1. Every later paid call — Continue, Accept the division, extracting a score's components, the Gate 4 match
 * — sent none, the backend fell back to the server's own key, and on a bring-your-own-key server (dev.ddharmon.io
 * has none) every Continue was refused at the door with nowhere on the screen to enter one.
 *
 * THE FIX, asserted here:
 *  1. a TAB-LIFETIME holder, in memory only (`lib/run-key.ts`): it survives in-app navigation and is gone on a
 *     reload, and nothing puts it in Web Storage, a URL or a cookie;
 *  2. Setup puts the key it started the run with into it, and every paid call on the staged screens sends it;
 *  3. when the SERVER says a key is needed (a machine-readable `code`, never the English sentence) the field
 *     appears where the reviewer pressed — the Continue bar beside its price, the division, the score panels —
 *     and the same press, retried, carries the key;
 *  4. no field where nothing is paid (a preview's Continue, the pinned demo), and a server with its own key is
 *     never blocked client-side.
 *
 * STATIC BUILD — backend-less. The paid routes are fulfilled with `page.route` in the exact shapes the backend
 * returns (`tests/test_key_refusal.py` pins the refusal: `{detail, code: "key_required"}`). Fake keys only.
 *
 *   run: E2E_PORT=4213 npx playwright test run-key-gates
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk-ant-test-0000";
const NEW_KEY = "sk-ant-test-1111";
const REFUSED = {
  status: 400,
  body: {
    detail:
      "Enter your Anthropic API key to continue — a paid step needs it and the key clears on reload. Your gate " +
      "state is preserved; re-enter the key and press Continue again.",
    code: KEY_REQUIRED,
  },
};

type Answer = { status: number; body: unknown };
const json = (route: Route, a: Answer) =>
  route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });

/** The key a request carried, or null. */
const keyOf = (r: Request): string | null => r.headers()["x-anthropic-key"] ?? null;

/** Every place a key could leak to in the browser, as one string to search. */
async function everythingStored(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const dump = (s: Storage) => JSON.stringify(Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)])));
    const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    return [dump(localStorage), dump(sessionStorage), document.cookie, location.href, JSON.stringify(dbs)].join("\n");
  });
}

/** An owned run parked at `gate`, from the real fixtures (Gate 1's for Gate 1, the finished demo's after it). */
function parkedAt(gate: "gate1" | "gate2" | "gate3", jobId: string, mutate?: (run: JobResult) => void): JobResult {
  const run = gate === "gate1" ? gate1Fixture() : finishedFixture();
  if (gate !== "gate1" && run.result?.records) run.result.records = run.result.records.slice(0, 12);
  run.jobId = jobId;
  run.status = "awaiting_review";
  run.gatePosition = gate;
  if (run.result) run.result.gatePosition = gate;
  asOwnedRun(run);
  mutate?.(run);
  return run;
}

/** Serve the run at whatever gate `where()` names, so a resume can move it the way the server would. */
async function serveMoving(page: Page, jobId: string, where: () => JobResult): Promise<void> {
  await page.route(`**/static-data/result-${jobId}.json`, (route) => json(route, { status: 200, body: where() }));
}

/** Capture every Continue, answering each with `answer(n)` (1-based) and running `after(n)` before replying. */
async function routeResume(page: Page, answer: (n: number) => Answer, after?: (n: number) => void): Promise<Request[]> {
  const sent: Request[] = [];
  await page.route("**/api/harmonize/resume/*", async (route) => {
    sent.push(route.request());
    after?.(sent.length);
    await json(route, answer(sent.length));
  });
  return sent;
}

const commitBar = (page: Page) => page.getByTestId("commit-bar");
const barField = (page: Page) => commitBar(page).getByTestId("run-key-field");
const gate1Continue = (page: Page) => commitBar(page).getByRole("button", { name: /Continue to Gate 2/ });

/**
 * Press a control the way a keyboard user does. A toast from the previous press ("Continuing to …", or the
 * server's refusal) sits over the sticky bar's corner for a few seconds, and a pointer click would wait on it.
 */
async function press(control: Locator): Promise<void> {
  await expect(control).toBeEnabled();
  await control.focus();
  await control.press("Enter");
}

async function scopeFirstGroupIn(page: Page): Promise<void> {
  await page.locator("[data-testid='ledger-row']").first().locator("[data-testid='queue-scope']").click();
  await expect(gate1Continue(page)).toBeEnabled();
}

// --- the walk: Setup -> Gate 1 -> Gate 2, then a reload -------------------------------------------------------

test.describe("run key on the staged screens", () => {
  test("@runkey the key Setup started the run with rides every later Continue, and never lands in storage", async ({
    page,
  }) => {
    let at: "gate1" | "gate2" | "gate3" = "gate1";
    await serveMoving(page, PAUSED_JOB, () => parkedAt(at, PAUSED_JOB));
    const starts: Request[] = [];
    await page.route("**/api/harmonize/batch", async (route) => {
      starts.push(route.request());
      await json(route, { status: 200, body: { jobId: PAUSED_JOB } });
    });
    const resumes = await routeResume(
      page,
      (n) => (n === 1 ? { status: 200, body: { jobId: PAUSED_JOB, target: "gate2" } } : { status: 409, body: { detail: "stopped by the e2e gate" } }),
      (n) => {
        if (n === 1) at = "gate2";
      },
    );

    // SETUP: one dictionary, a paid mode, the key typed once.
    await page.goto("/run/new/setup");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => localStorage.clear());
    const fixture = path.resolve(HERE, "..", "..", "..", "tests", "live", "fixture", "aou.csv");
    await page.getByTestId("dict-upload").setInputFiles([fixture]);
    await expect(page.getByTestId("dict-parse-state").filter({ hasText: "read" })).toHaveCount(1);
    await page.getByTestId("api-key").fill(KEY);
    await press(page.getByTestId("start-run"));
    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0].headers()["x-provider-key"]).toBe(KEY);

    // GATE 1: reached in-app. Continue carries the held key and asks for nothing.
    await expect(page).toHaveURL(new RegExp(`/run/${PAUSED_JOB}/gate1$`));
    await expect(page.locator("[data-testid='ledger']")).toBeVisible();
    await scopeFirstGroupIn(page);
    await press(gate1Continue(page));
    await expect.poll(() => resumes.length).toBe(1);
    expect(keyOf(resumes[0])).toBe(KEY);

    // GATE 2: still the same tab, still the same key — and a refusal that is not about the key shows no field.
    await expect(page).toHaveURL(new RegExp(`/run/${PAUSED_JOB}/gate2$`));
    await press(page.getByTestId("gate2-continue"));
    await expect.poll(() => resumes.length).toBe(2);
    expect(keyOf(resumes[1])).toBe(KEY);
    await expect(page.getByText("stopped by the e2e gate").first()).toBeVisible();
    await expect(page.getByTestId("run-key-field")).toHaveCount(0);

    // NOWHERE ELSE: not in Web Storage, not in IndexedDB, not in a cookie or the URL.
    expect(await everythingStored(page)).not.toContain(KEY);
  });

  test("@runkey after a reload the tab holds no key: Continue asks inline, beside its price, and the retry carries it", async ({
    page,
  }) => {
    let at: "gate2" | "gate3" = "gate2";
    await serveMoving(page, FINISHED_JOB, () => parkedAt(at, FINISHED_JOB));
    const resumes = await routeResume(
      page,
      (n) => (n === 1 ? REFUSED : { status: 200, body: { jobId: FINISHED_JOB, target: "gate3" } }),
      (n) => {
        if (n === 2) at = "gate3";
      },
    );
    await page.goto(`/run/${FINISHED_JOB}/gate2`);
    await page.waitForLoadState("networkidle");
    await expect(barField(page)).toHaveCount(0); // nothing asked before the server asks

    await press(page.getByTestId("gate2-continue"));
    await expect.poll(() => resumes.length).toBe(1);
    expect(keyOf(resumes[0])).toBeNull(); // the tab holds none — so none was sent, and the server decided

    // The field, in the Continue bar, in Setup's register: a password box with the Anthropic hint and a link.
    const field = barField(page);
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("data-reason", KEY_REQUIRED);
    const input = field.getByTestId("run-key-input");
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("placeholder", "sk-ant-…");
    await expect(field.getByTestId("run-key-help-link")).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
    await expect(field.getByTestId("run-key-copy")).toContainText("Continue to Gate 3");
    // The gate is untouched: still Gate 2, and Continue is still there to retry.
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate2$`));
    await expect(page.getByTestId("gate2-continue")).toBeEnabled();

    await input.fill(NEW_KEY);
    await press(page.getByTestId("gate2-continue"));
    await expect.poll(() => resumes.length).toBe(2);
    expect(keyOf(resumes[1])).toBe(NEW_KEY);
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate3$`));
    expect(await everythingStored(page)).not.toContain(NEW_KEY);

    // A reload forgets it, exactly as Setup promises.
    await page.reload();
    await page.waitForLoadState("networkidle");
    expect(await everythingStored(page)).not.toContain(NEW_KEY);
  });

  test("@runkey on a server with its own key, a keyless Continue is sent and goes through", async ({ page }) => {
    let at: "gate2" | "gate3" = "gate2";
    await serveMoving(page, FINISHED_JOB, () => parkedAt(at, FINISHED_JOB));
    const resumes = await routeResume(
      page,
      () => ({ status: 200, body: { jobId: FINISHED_JOB, target: "gate3" } }),
      () => {
        at = "gate3";
      },
    );
    await page.goto(`/run/${FINISHED_JOB}/gate2`);
    await page.waitForLoadState("networkidle");
    await press(page.getByTestId("gate2-continue"));
    await expect.poll(() => resumes.length).toBe(1);
    expect(keyOf(resumes[0])).toBeNull();
    await expect(page).toHaveURL(new RegExp(`/run/${FINISHED_JOB}/gate3$`));
    await expect(page.getByTestId("run-key-field")).toHaveCount(0);
  });

  test("@runkey a preview run's Continue buys nothing, so it never shows the key field", async ({ page }) => {
    await serveMoving(page, FINISHED_JOB, () =>
      parkedAt("gate2", FINISHED_JOB, (run) => {
        (run.config as Record<string, unknown>).runMode = "preview";
      }),
    );
    const resumes = await routeResume(page, () => REFUSED);
    await page.goto(`/run/${FINISHED_JOB}/gate2`);
    await page.waitForLoadState("networkidle");
    await press(page.getByTestId("gate2-continue"));
    await expect.poll(() => resumes.length).toBe(1);
    await expect(page.getByText(/Enter your Anthropic API key/).first()).toBeVisible();
    await expect(page.getByTestId("run-key-field")).toHaveCount(0);
  });

  test("@runkey the shared demo walks Continue with no request and no key field", async ({ page }) => {
    await serveMoving(page, PAUSED_JOB, () => gate1Fixture()); // the committed fixture IS the pinned demo
    const resumes = await routeResume(page, () => REFUSED);
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await scopeFirstGroupIn(page);
    await press(gate1Continue(page));
    await expect(page).toHaveURL(new RegExp(`/run/${PAUSED_JOB}/gate2$`));
    expect(resumes).toHaveLength(0);
    await expect(page.getByTestId("run-key-field")).toHaveCount(0);
  });
});

// --- the other paid calls: the field appears where the reviewer pressed ---------------------------------------

const FLAGGED = "c45aa294f30f6#g1";

test.describe("run key on the gates' paid actions", () => {
  test("@runkey Accept the division asks for the key in the proposal, and Continue then sends the same key", async ({
    page,
  }) => {
    await serveMoving(page, PAUSED_JOB, () =>
      parkedAt("gate1", PAUSED_JOB, (run) => {
        (run.config as Record<string, unknown>).readjudication = true;
      }),
    );
    const divisions: Request[] = [];
    await page.route("**/api/harmonize/jobs/*/readjudicate", async (route) => {
      divisions.push(route.request());
      await json(
        route,
        divisions.length === 1
          ? { status: 400, body: { detail: "Enter your Anthropic API key to re-split this group.", code: KEY_REQUIRED } }
          : {
              status: 200,
              body: { jobId: PAUSED_JOB, groupIds: [FLAGGED], nGroups: 0, parts: [], decisions: {} },
            },
      );
    });
    const resumes = await routeResume(page, () => ({ status: 409, body: { detail: "stopped by the e2e gate" } }));
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await page.locator(`[data-testid='ledger-row'][data-row-id='${FLAGGED}']`).click();
    const carve = page.locator("[data-testid='gate1-detail'] [data-testid='carve-proposal']");
    await press(carve.getByRole("button", { name: /Accept this division/ }));
    await expect.poll(() => divisions.length).toBe(1);
    expect(keyOf(divisions[0])).toBeNull();

    const field = carve.getByTestId("run-key-field");
    await expect(field).toBeVisible();
    await expect(field.getByTestId("run-key-copy")).toContainText("Accept this division");
    await expect(barField(page)).toHaveCount(0); // asked where the reviewer is, not somewhere else
    await field.getByTestId("run-key-input").fill(KEY);
    await press(carve.getByRole("button", { name: /Accept this division/ }));
    await expect.poll(() => divisions.length).toBe(2);
    expect(keyOf(divisions[1])).toBe(KEY);
    await expect(carve.getByTestId("run-key-field")).toHaveCount(0); // answered, so the ask is gone

    // ONE KEY PER TAB: the key entered at the division is the key Continue sends, with no second prompt.
    await scopeFirstGroupIn(page);
    await press(gate1Continue(page));
    await expect.poll(() => resumes.length).toBe(1);
    expect(keyOf(resumes[0])).toBe(KEY);
    expect(await everythingStored(page)).not.toContain(KEY);
  });

  test("@runkey extracting a score's components asks for the key in the panel", async ({ page }) => {
    await serveMoving(page, PAUSED_JOB, () => parkedAt("gate1", PAUSED_JOB));
    const text = "Help Bathing  Yes = 1, No = 0\nHelp Dressing  Yes = 1, No = 0";
    await page.route("**/api/harmonize/score/extract", (route) =>
      json(route, {
        status: 200,
        body: { text, provenance: "paper.pdf", sha256: "a".repeat(64), nChars: text.length },
      }),
    );
    const extracts: Request[] = [];
    await page.route("**/api/harmonize/jobs/*/score/components", async (route) => {
      extracts.push(route.request());
      await json(
        route,
        extracts.length === 1
          ? { status: 400, body: { detail: "Enter your Anthropic API key to extract the components.", code: KEY_REQUIRED } }
          : { status: 409, body: { detail: "stopped by the e2e gate" } },
      );
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("score-panel-toggle").click();
    await page
      .locator("[data-testid='score-upload'] input[type='file']")
      .setInputFiles({ name: "paper.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 stub") });
    const extract = page.getByTestId("score-extract");
    await press(extract.getByRole("button", { name: /Extract the components/ }));
    await expect.poll(() => extracts.length).toBe(1);
    expect(keyOf(extracts[0])).toBeNull();

    const field = extract.getByTestId("run-key-field");
    await expect(field).toBeVisible();
    await field.getByTestId("run-key-input").fill(KEY);
    await press(extract.getByRole("button", { name: /Extract the components/ }));
    await expect.poll(() => extracts.length).toBe(2);
    expect(keyOf(extracts[1])).toBe(KEY);
  });

  test("@runkey the Gate 4 match asks for the key in the panel, and a rejected key says so", async ({ page }) => {
    const score = "Fried frailty phenotype";
    const components = ["Weight loss", "Slow gait"];
    await serveMoving(page, FINISHED_JOB, () => {
      const run = finishedFixture();
      if (run.result?.records) run.result.records = run.result.records.slice(0, 12);
      (run.config as Record<string, unknown>).demo = false;
      return run;
    });
    await page.addInitScript(
      ([jobId, rows]) => {
        sessionStorage.setItem(`ddharmon.sandbox.${jobId}`, JSON.stringify({ gateDecisions: { composite_swap: rows } }));
      },
      [
        FINISHED_JOB,
        Object.fromEntries(
          components.map((c) => [
            `${score}\u001f${c}`,
            { scoreName: score, componentName: c, chosen: "", alternatives: components, optionSetKey: "k" },
          ]),
        ),
      ] as const,
    );
    const matches: Request[] = [];
    await page.route("**/api/harmonize/jobs/*/composite", async (route) => {
      matches.push(route.request());
      const n = matches.length;
      await json(
        route,
        n === 1
          ? { status: 400, body: { detail: "Enter your Anthropic API key to match the declared score.", code: KEY_REQUIRED } }
          : n === 2
            ? {
                status: 401,
                body: { detail: "The model provider rejected the API key (401).", code: KEY_REJECTED },
              }
            : { status: 409, body: { detail: "stopped by the e2e gate" } },
      );
    });
    await page.goto(`/run/${FINISHED_JOB}/gate4`);
    await page.waitForLoadState("networkidle");
    const panel = page.getByTestId("gate4-score");
    // The score panel is a disclosure, folded by default (final review round 2).
    await panel.getByTestId("gate4-score-toggle").click();
    await press(panel.getByTestId("gate4-score-match"));
    await expect.poll(() => matches.length).toBe(1);
    expect(keyOf(matches[0])).toBeNull();

    const field = panel.getByTestId("run-key-field");
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("data-reason", KEY_REQUIRED);
    await field.getByTestId("run-key-input").fill(KEY);
    await press(panel.getByTestId("gate4-score-match"));
    await expect.poll(() => matches.length).toBe(2);
    expect(keyOf(matches[1])).toBe(KEY);

    // The provider rejected THAT key: the field stays, says so, and the next press sends the corrected one.
    await expect(field).toHaveAttribute("data-reason", KEY_REJECTED);
    await expect(field.getByTestId("run-key-copy")).toContainText(/rejected/i);
    await field.getByTestId("run-key-input").fill(NEW_KEY);
    await press(panel.getByTestId("gate4-score-match"));
    await expect.poll(() => matches.length).toBe(3);
    expect(keyOf(matches[2])).toBe(NEW_KEY);
    expect(await everythingStored(page)).not.toContain(NEW_KEY);
  });
});
