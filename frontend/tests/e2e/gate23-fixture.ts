import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { JobResult, UIRecord } from "@/types";

/**
 * The run Gate 2 and Gate 3 render against, and why it is the FINISHED demo rather than the paused one.
 *
 * `result-demo-staged-gate1.json` is parked at Gate 1 and carries ZERO records — correctly, because the
 * assign stage that produces them is Gate 2's own spend and has not run. So it is the right fixture for
 * Gate 2's empty state and it is the wrong one for everything else: there are no candidates in it to rank,
 * no generated elements to mark and no transform specs to edit.
 *
 * The shipped demo (`result-demo-aireadi_aou_clsa_mesa_ukbb.json`, 535 records) is a real completed run and
 * carries all of it — 20 candidates on every record, 425 generated elements, and categorical / unit /
 * arithmetic specs including 12 arithmetic ones. It is also, by construction, the R13 subject: a FINISHED
 * run is exactly what Task 3 re-decides on.
 *
 * MUTATIONS ARE CONSTRUCTED IN THE SPEC, NOT COMMITTED AS FILES — the same rule `gate1-fixture.ts` sets and
 * for the same reason. Both fixtures are DERIVED from runs that happened, which is what makes them
 * evidence; a hand-written third file would sit beside them looking equally authoritative while describing
 * nothing. States the demo does not contain (a retrieval failure, an opted-in concept gate) are built here
 * from the real record, visibly, where the construction is part of the assertion.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FINISHED = resolve(HERE, "../../public/static-data/result-demo-aireadi_aou_clsa_mesa_ukbb.json");
const PAUSED = resolve(HERE, "../../public/static-data/result-demo-staged-gate1.json");

/** The finished demo's job id — `result-<id>.json` is all the static client fetches. */
export const FINISHED_JOB = "demo-aireadi_aou_clsa_mesa_ukbb";
/** The paused fixture's job id, for the "nothing reached this gate" states. */
export const PAUSED_JOB = "demo-staged-gate1";

export function finishedFixture(): JobResult {
  return JSON.parse(readFileSync(FINISHED, "utf8")) as JobResult;
}

export function pausedFixture(): JobResult {
  return JSON.parse(readFileSync(PAUSED, "utf8")) as JobResult;
}

export function finishedRecords(): UIRecord[] {
  return finishedFixture().result?.records ?? [];
}

/**
 * Serve `mutate(finished demo)` for every result fetch on this page.
 *
 * TRIMMED TO `keep` RECORDS BY DEFAULT. The real demo has 535 records, each with 20 candidates; rendering
 * all of them makes every assertion wait on a list nobody is asserting about. The trim is a test-speed
 * measure only — it never changes a record's SHAPE, so nothing asserted here is true only of a subset.
 */
export async function serveFinished(
  page: Page,
  mutate?: (run: JobResult) => JobResult | void,
  { keep = 12 }: { keep?: number } = {},
): Promise<void> {
  await page.route("**/static-data/result-*.json", async (route) => {
    const run = finishedFixture();
    if (run.result?.records && keep > 0) run.result.records = run.result.records.slice(0, keep);
    const served = mutate?.(run) ?? run;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(served),
    });
  });
}

/** Serve the PAUSED (zero-record) run, for the "nothing was sent to this gate" states. */
export async function servePaused(page: Page, mutate?: (run: JobResult) => JobResult | void): Promise<void> {
  await page.route("**/static-data/result-*.json", async (route) => {
    const run = pausedFixture();
    const served = mutate?.(run) ?? run;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(served) });
  });
}

/** The first record carrying a generated element — the GenCDE-marking assertions' subject. */
export function firstGenerated(run: JobResult): UIRecord {
  const rec = (run.result?.records ?? []).find((r) => r.gencde);
  if (!rec) throw new Error("fixture carries no generated element");
  return rec;
}
