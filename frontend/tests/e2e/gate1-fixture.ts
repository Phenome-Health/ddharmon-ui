import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { ConceptGroup, JobResult } from "@/types";

/**
 * Serving a MUTATED copy of the real Gate 1 fixture to one test, without committing a second fixture.
 *
 * WHY INTERCEPTION RATHER THAN MORE FILES IN `static-data/`. The committed fixture is DERIVED — every
 * group, every coherence verdict and every field row in it came out of a run that actually happened
 * (`scripts/build_gate_fixture.py`). That is what makes it evidence. A hand-written second file called
 * `result-demo-staged-gate1-empty.json` would be neither derived nor a run, and the next person to read
 * `static-data/` would have no way to tell which of the two describes reality.
 *
 * A handful of states cannot be derived at all, because the demo does not contain them: a run with zero
 * groups, a run whose every variable fell out as an outlier, a run that opted IN to re-adjudication. Those
 * are properties of a DIFFERENT run, so they are constructed here, in the test that asserts them, from the
 * real fixture — visibly, in the spec, where the construction is part of the assertion's evidence.
 *
 * The static build fetches `<base>/static-data/result-<jobId>.json` and nothing else, so one route glob
 * covers every screen in the flow.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../../public/static-data/result-demo-staged-gate1.json");

/** The committed fixture's job id. Its result file is `result-<id>.json`, which is all `getResult` needs. */
export const PAUSED_JOB = "demo-staged-gate1";

/** The committed fixture, parsed. Read from disk so a spec asserts against the file that actually ships. */
export function gate1Fixture(): JobResult {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as JobResult;
}

/** Every concept group the committed fixture carries, in file order. */
export function fixtureGroups(): ConceptGroup[] {
  return gate1Fixture().result?.conceptGroups ?? [];
}

/**
 * Serve `mutate(fixture)` for every result fetch on this page.
 *
 * The mutation runs in NODE, not in the browser: the payload is serialized and fulfilled as the response
 * body, so a spec can use the real types and the real fixture without shipping either into the bundle.
 */
export async function serveRun(page: Page, mutate: (run: JobResult) => JobResult | void): Promise<void> {
  await page.route("**/static-data/result-*.json", async (route) => {
    const run = gate1Fixture();
    const served = mutate(run) ?? run;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(served),
    });
  });
}

/**
 * The same run, served as the REVIEWER'S OWN rather than as the shared demo (08-18).
 *
 * Both committed fixtures are derived from the demo, so they carry `config.demo: true` — and since 08-18 the demo
 * is WALKED, not resumed: its Continue steps to the next screen for free and its commit bar quotes no amount,
 * because the pinned demo cannot be resumed and a guest must never be shown a purchase. A test about the PAID
 * path (a price, a quote, a refused resume) is therefore about an owned run, and says so by serving one. The
 * config keeps its other keys, so `resolvePinned` reads a real run (`false`), never "unknown".
 */
export function asOwnedRun(run: JobResult): JobResult {
  const { demo: _demo, ...rest } = (run.config ?? {}) as Record<string, unknown>;
  run.config = rest as JobResult["config"];
  return run;
}
