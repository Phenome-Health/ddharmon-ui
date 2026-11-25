import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { JobResult } from "@/types";

/**
 * Select-all on Gate 1 is ONE request (user test 2026-11-25: "the select/deselect all in the sidebar is very slow").
 *
 * It used to write each group with its own PUT and re-read every artifact the run holds after each one: a few hundred
 * groups were a few hundred round trips and a quadratic amount of reading. The press now goes to the batch route once,
 * and the decisions are read back once. Only a live-shaped build can see this — the static build keeps decisions in the
 * tab and never makes a request.
 *
 *   run: npx playwright test --project stream bulk-scope
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = resolve(HERE, "../../public/static-data");
const JOB = "demo-staged-gate1";

function parkedAtGate1(): JobResult {
  const run = JSON.parse(readFileSync(resolve(STATIC, `result-${JOB}.json`), "utf8")) as JobResult;
  const { demo: _demo, gate1_scope: _sent, ...config } = (run.config ?? {}) as Record<string, unknown>;
  run.config = config as JobResult["config"]; // an OWNED run, so decisions go to the server, not the tab
  Object.assign(run, { status: "awaiting_review", phase: "awaiting_review", gatePosition: "gate1" });
  if (run.result) (run.result as unknown as Record<string, unknown>).gatePosition = "gate1";
  return run;
}

async function serve(page: Page) {
  const run = parkedAtGate1();
  const calls: { method: string; path: string }[] = [];
  const frame = { ...run, resultVersion: run.resultVersion || 1 } as Record<string, unknown>;
  for (const key of ["result", "decisions", "analysisIdeas", "composites", "config", "dictionaries", "demoScore"])
    delete frame[key];

  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"not routed in this spec"}' }),
  );
  await page.route("**/api/harmonize/jobs", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/harmonize/models", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: readFileSync(resolve(STATIC, "models.json"), "utf8") }),
  );
  await page.route(`**/api/harmonize/stream/${JOB}*`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: `event: progress\ndata: ${JSON.stringify(frame)}\n\n`,
    }),
  );
  await page.route(`**/api/harmonize/result/${JOB}*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) }),
  );
  await page.route(`**/api/harmonize/jobs/${JOB}/artifacts**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    calls.push({ method: req.method(), path });
    if (req.method() === "GET")
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"kinds":[],"artifacts":{},"stale":[]}' });
    if (req.method() === "POST" && path.endsWith("/batch")) {
      const body = req.postDataJSON() as { put: { payload: { groupId: string } }[]; delete: string[] };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          written: body.put.map((p, i) => ({ kind: "gate1_group_scope", itemKey: p.payload.groupId, updatedAt: 1000 + i, conflict: null })),
          deleted: body.delete,
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"kind":"gate1_group_scope","itemKey":"x","updatedAt":1,"conflict":null}' });
  });
  return { calls, nGroups: run.result?.conceptGroups?.length ?? 0 };
}

test("@bulk-scope select-all on a real run is one batch request and one read-back, however many groups", async ({ page }) => {
  const { calls, nGroups } = await serve(page);
  expect(nGroups).toBeGreaterThan(20);
  await page.goto(`/run/${JOB}/gate1`);
  const bulk = page.locator("[data-testid='bulk-scope']");
  await expect(bulk).toHaveAttribute("data-state", "none");
  const reads = () => calls.filter((c) => c.method === "GET").length;
  const readsBefore = reads();

  await bulk.locator("[data-testid='bulk-scope-toggle']").click();
  await expect(bulk).toHaveAttribute("data-state", "all");
  await expect(page.getByTestId("bulk-scope-busy")).toHaveCount(0);

  const writes = calls.filter((c) => c.method !== "GET");
  expect(writes.map((c) => c.method)).toEqual(["POST"]);
  expect(writes[0]!.path).toMatch(/\/artifacts\/gate1_group_scope\/batch$/);
  expect(reads() - readsBefore).toBeLessThanOrEqual(1);
});
