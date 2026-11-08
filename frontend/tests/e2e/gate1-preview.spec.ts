import { expect, test, type Page } from "@playwright/test";
import { decisionItemKey, optionSetKey, type GateDecision } from "@/lib/gate-decisions";
import { gate1ExportPath } from "@/lib/gate1-export";
import { SANDBOX_PREFIX } from "@/lib/sandbox";
import type { ConceptGroup, ScoreSuggestions } from "@/types";
import { PAUSED_JOB, asOwnedRun, gate1Fixture, previewRun, serveRun } from "./gate1-fixture";

/**
 * GATE 1 FOR A PREVIEW RUN (08-31) — a $0 redundancy checker.
 *
 * Bhargav: "use gate 1 as a single cohort redundancy checker/similar var consolidater … achievable without LLM —
 * clustering pass + concept spotlight hybrid retrieval + some manual user sidebar searching." A Preview calls no model,
 * so its rows are the clustering's groups labelled by keywords, and the screen must say what the run did and nothing it
 * did not: no generated name, no split, no coherence reading, no charge, no Continue to a paid gate.
 */

async function openPreview(page: Page): Promise<void> {
  await serveRun(page, previewRun);
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-testid='ledger']")).toBeVisible();
}

const rowOf = (page: Page, gid: string) => page.locator(`[data-testid='ledger-row'][data-row-id='${gid}']`);

test.describe("Gate 1 on a Preview run", () => {
  test("@gate1 @preview its rows are the clustering's groups, labelled by keywords", async ({ page }) => {
    await openPreview(page);
    const rows = page.locator("[data-testid='ledger-row']");
    expect(await rows.count()).toBeGreaterThan(1);
    // Every row's label says where it came from in the DOM — and no row carries a per-row pill for it: the screen's
    // lead says it once, because a mark on every row says nothing (08-16c review).
    await expect(rows.first().locator("[data-label-source='keywords']")).toBeVisible();
    await expect(page.locator("[data-label-source='generated']")).toHaveCount(0);
    await expect(page.locator("[data-testid='how-to-lead']")).toContainText(/labelled by the words that set it apart/i);
    await expect(page.locator("[data-testid='how-to-lead']")).toContainText(/no model/i);
  });

  test("@gate1 @preview nothing claims a judgement, a split or a charge that never happened", async ({ page }) => {
    await openPreview(page);
    // No coherence state on a row, and no State filter to narrow by one.
    await expect(page.locator("[data-testid='ledger-row'] [data-testid='coherence-mark']")).toHaveCount(0);
    await page.locator("[data-testid='filter-open']").click();
    await expect(page.locator("[data-testid^='filter-state-']")).toHaveCount(0);
    await page.keyboard.press("Escape");
    // No scope to buy: nothing is sent to Gate 2 from a Preview — no per-row box, no select-all, no sort by a state.
    await expect(page.locator("[data-testid='queue-scope']")).toHaveCount(0);
    await expect(page.locator("[data-testid='bulk-scope']")).toHaveCount(0);
    await expect(page.locator("[data-testid='sort-verdict']")).toHaveCount(0);

    await page.locator("[data-testid='ledger-row']").first().click();
    const detail = page.locator("[data-testid='gate1-detail']");
    await expect(detail).toBeVisible();
    await expect(detail.locator("[data-testid='coherence-mark']")).toHaveCount(0);
    await expect(detail.locator("[data-testid='coherence-finding']")).toHaveCount(0); // not "Too small to judge"
    await expect(detail.getByText("Send to Gate 2")).toHaveCount(0);
    await expect(detail.getByText(/Generated ideal CDE/)).toHaveCount(0);

    // The how-to has no charge step and no Continue; the bar is the Preview's own, not a purchase.
    await expect(page.locator("[data-testid='how-to']")).not.toContainText(/Continue to Gate 2|charged/);
    await expect(page.locator("[data-testid='commit-bar']")).toHaveCount(0);
    const end = page.locator("[data-testid='preview-end']");
    await expect(end).toBeVisible();
    await expect(end).toContainText(/paid run/i);
    // No amount anywhere on the screen but the rail's realized $0: a Preview buys nothing, so nothing quotes a price.
    await expect(page.locator("body")).not.toContainText(/\$\s?(?:[1-9]|0\.\d*[1-9])/);
  });

  test("@gate1 @preview In no group holds only what the clustering left out", async ({ page }) => {
    let grouped = 0;
    let fields = 0;
    await serveRun(page, (run) => {
      previewRun(run);
      // The committed run grouped every variable, so one group is taken away to stand for the clustering's TRUE
      // outliers — a real Preview leaves some over (run 7fafc83f: 8 of 409).
      const result = run.result!;
      const dropped = result.conceptGroups!.pop()!;
      delete result.conceptGroupMembers![dropped.groupId];
      grouped = new Set(Object.values(result.conceptGroupMembers ?? {}).flat()).size;
      fields = Object.keys(result.fieldIndex ?? {}).length;
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    expect(fields - grouped).toBeGreaterThan(0);
    await page.locator("[data-testid='gate1-pool-entry']").click();
    // The run's own unassigned list names every variable (a Preview has no records); the pool must not.
    await expect(page.locator("[data-testid='pool-count']")).toHaveText(String(fields - grouped));
    await expect(page.locator("[data-testid='unassigned-pool']")).not.toContainText(/Gate 2/);
  });

  test("@gate1 @preview a variable can be moved out of a group, and the count follows", async ({ page }) => {
    await openPreview(page);
    const row = page.locator("[data-testid='ledger-row']").first();
    const id = await row.getAttribute("data-row-id");
    await row.click();
    const detail = page.locator("[data-testid='gate1-detail']");
    const member = detail.locator("[data-testid='member-row']").first();
    await member.dragTo(detail.locator("[data-testid='member-drop-zone'][data-group-id='__unassigned__']"));
    await expect(page.locator(`[data-testid='ledger-row'][data-row-id='${id}']`)).toHaveAttribute(
      "data-spine",
      "changed",
    );
  });

  test("@gate1 @preview a Preview still running says what it is waiting for — the clustering, not three paid stages", async ({
    page,
  }) => {
    await serveRun(page, (run) => {
      previewRun(run);
      run.status = "running";
      run.phase = "clustering";
      run.result = null;
    });
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    const waiting = page.locator("[data-testid='gate1-waiting']");
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText(/clustering/i);
    await expect(waiting).not.toContainText(/coherence judge|splits/i);
    // Nothing to download yet: there are no groups, and the route would answer that with an error, not a file.
    await expect(page.locator("[data-testid='preview-end']")).toBeVisible();
    await expect(page.locator("[data-testid='gate1-export']")).toHaveCount(0);
  });

  test("@gate1 @preview the how-to is the Preview's own — no charge, no Continue, still orientation", async ({ page }) => {
    await openPreview(page);
    const panel = page.getByTestId("how-to");
    await expect(panel.getByRole("button", { name: "Hide how to use this screen" })).toBeVisible();
    const text = await panel.innerText();
    // The same guards gate1.spec holds the paid list to.
    expect(await panel.locator("li").count()).toBeLessThanOrEqual(6);
    expect(text.length, "the orientation panel is too long to read in one pass").toBeLessThan(700);
    expect(text.toLowerCase()).toContain("drag");
    expect(text.toLowerCase()).toContain("in no group");
    expect(text).toMatch(/CSV/);
    expect(text).not.toMatch(/Gate 2|Continue|charge|tick/i);
  });

  test("@gate1 @preview a New group and a rename work as on a paid run, and neither speaks of Gate 2", async ({
    page,
  }) => {
    await openPreview(page);
    await page.locator("[data-testid='new-group']").click();
    const input = page.locator("[data-testid='new-group-name']");
    await input.fill("Eye conditions");
    await input.press("Enter");
    const newRow = page.locator("[data-testid='ledger-row'][data-reviewer='true']", { hasText: "Eye conditions" });
    await expect(newRow).toBeVisible();
    await expect(newRow.locator("[data-testid='queue-scope']")).toHaveCount(0);
    await expect(newRow.locator("[data-testid='new-group-mark']")).not.toHaveAttribute("title", /Gate 2/);
    const newDetail = page.locator("[data-testid='new-group-detail']");
    await expect(newDetail).toContainText(/drag/i);
    await expect(newDetail).not.toContainText(/Gate 2|model call|price/i);

    // A cluster's keyword label is renamed like any name, and the reviewer's name is what the row shows.
    const first = page.locator("[data-testid='ledger-row']:not([data-reviewer])").first();
    const id = (await first.getAttribute("data-row-id"))!;
    await first.click();
    const detail = page.locator("[data-testid='gate1-detail']");
    await detail.locator("[data-testid='rename-group']").click();
    const box = detail.getByRole("textbox", { name: "Rename group" });
    await box.fill("Race and ethnicity");
    await box.press("Enter");
    await expect(rowOf(page, id).locator("[data-label-source='reviewer']")).toHaveText("Race and ethnicity");
    // The keywords were never a name ddharmon gave it, so nothing says it "called it" anything or "generated" it.
    await expect(rowOf(page, id).locator("[data-testid='renamed-mark']")).not.toHaveAttribute("title", /generated/);
    await expect(page.getByText(/ddharmon called it/)).toHaveCount(0);
  });

  test("@gate1 @preview emptying a group says what happened — and promises nothing at Gate 2", async ({ page }) => {
    await openPreview(page);
    // A one-variable group: one press of its row's × empties it.
    const result = previewRun(gate1Fixture()).result!;
    const single = result.conceptGroups!.find((g) => (result.conceptGroupMembers![g.groupId] ?? []).length === 1)!;
    await rowOf(page, single.groupId).click();
    const detail = page.locator("[data-testid='gate1-detail']");
    await detail.locator("[data-testid='member-remove']").first().click();
    const emptied = detail.locator("[data-testid='group-emptied']");
    await expect(emptied).toBeVisible();
    await expect(emptied).not.toContainText(/Gate 2|matched/);
  });

  test("@gate1 @preview Concept Spotlight's free search tags the Preview's rows", async ({ page }) => {
    const { target } = await openSpotlightPreview(page);
    await expect(rowOf(page, target.groupId).locator("[data-testid='queue-score-tag']")).toHaveCount(1);
    await expect(page.locator("[data-testid='queue-scope']")).toHaveCount(0);
  });

  test("@gate1 @preview Concept Spotlight on a Preview is the free search alone — no scope, no later gate, one refusal", async ({
    page,
  }) => {
    const { target } = await openSpotlightPreview(page);
    // The row keeps its tag with the box above it gone, and the tag keeps a column of its own: the name starts after it.
    const row = rowOf(page, target.groupId);
    const tag = row.locator("[data-testid='queue-score-tag']");
    await expect(tag).toBeVisible();
    const tagBox = (await tag.boundingBox())!;
    const controlBox = (await row.locator("[data-testid='queue-row-control']").boundingBox())!;
    const nameBox = (await row.locator("[data-label-source]").boundingBox())!;
    expect(tagBox.width).toBeGreaterThan(0);
    expect(tagBox.x).toBeGreaterThanOrEqual(controlBox.x);
    expect(tagBox.x + tagBox.width).toBeLessThanOrEqual(controlBox.x + controlBox.width);
    expect(tagBox.x + tagBox.width).toBeLessThan(nameBox.x);
    // Its tooltip names the free search — not a verdict at a gate a Preview never reaches.
    await tag.focus();
    const tip = page.locator("[data-testid='queue-score-tip']");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/free search/i);
    await expect(tip).not.toContainText(/Gate \d/);
    await page.keyboard.press("Escape");

    // Closed, the strip names what is declared — and no match still to come.
    const status = page.locator("[data-testid='score-strip-status']");
    await expect(status).toHaveText("My items · 1 item declared");
    await page.locator("[data-testid='score-panel-toggle']").click();
    const panel = page.locator("[data-testid='score-panel']");
    await expect(panel.locator("[data-testid='score-suggestions']")).toBeVisible();
    await panel.locator("[data-testid='score-suggestion-expand']").first().click();
    const group = panel.locator("[data-testid='score-suggestion-group']").first();
    await expect(group).toBeVisible();
    // A Preview has no scope: nothing in the panel can be ticked, and nothing in it is counted as "in scope".
    await expect(panel.locator("input[type='checkbox'], [role='checkbox']")).toHaveCount(0);
    await expect(panel.locator("[data-testid='score-suggestion-scope-why']")).toHaveCount(0);
    // The search's own figures stay: what it suggested, and what those groups hold.
    await expect(panel.locator("[data-testid='score-suggestion-spread']").first()).toContainText(/1 group suggested/);
    // No verdict waiting on a match, and no price for one: a Preview cannot match. The ONE refusal says so, and it is
    // the only place in the panel a later gate is named.
    await expect(panel.locator("[data-testid='score-verdict']")).toHaveCount(0);
    await expect(panel.locator("[data-testid='score-match-price']")).toHaveCount(0);
    const refusal = panel.locator("[data-testid='not-available']").filter({ hasText: /A Preview calls no model/ });
    await expect(refusal).toHaveCount(1);
    const rest = (await panel.innerText()).replace(await refusal.innerText(), "");
    expect(rest).not.toMatch(/Gate 2|Gate 4|in scope|Gate 1.s scope/i);
  });

  test("@gate1 @preview Concept Spotlight's closed strip does not price a match a Preview cannot make", async ({ page }) => {
    await openPreview(page);
    const strip = page.locator("[data-testid='score-panel-toggle']");
    await expect(strip).toContainText(/searching this run.s groups for its items (are|is) free/i);
    await expect(strip).not.toContainText(/match/i);
  });

  test("@gate1 @preview the gate strip ends at Gate 1 — no later gate, and a total of nothing", async ({ page }) => {
    await openPreview(page);
    const rail = page.locator("[data-testid='gate-rail'] > li");
    await expect(rail).toHaveCount(2);
    await expect(rail.nth(0)).toHaveAttribute("data-gate", "setup");
    await expect(rail.nth(1)).toHaveAttribute("data-gate", "gate1");
    await expect(page.locator("[data-testid='gate-rail']")).not.toContainText(/Gate [234]|est\./);
    // Gate 1 spends nothing on a Preview, so it says so as a state — not a $0.00 figure dressed as spend.
    await expect(rail.nth(1).locator("[data-cost]")).toHaveAttribute("data-cost", "state");
    await expect(rail.nth(1).locator("[data-cost]")).toHaveText("no charge");
    const total = page.locator("[data-testid='rail-total']");
    await expect(total).toContainText("$0");
    await expect(total).toContainText("nothing charged");
  });

  test("@gate1 @preview a Preview's Setup — composed or finished — draws the same short strip", async ({ page }) => {
    // The finished Preview's own Setup, read back.
    await serveRun(page, previewRun);
    await page.goto(`/run/${PAUSED_JOB}/setup`);
    await page.waitForLoadState("networkidle");
    const rail = page.locator("[data-testid='gate-rail'] > li");
    await expect(rail).toHaveCount(2);
    await expect(page.locator("[data-testid='gate-rail']")).not.toContainText(/Gate [234]/);

    // A new run: the strip follows the mode chosen, because a Preview will stop at Gate 1 — and back again.
    await page.goto("/run/new/setup");
    await page.waitForLoadState("networkidle");
    await expect(rail).toHaveCount(5);
    await page.getByTestId("run-mode").selectOption("preview");
    await expect(rail).toHaveCount(2);
    await expect(page.locator("[data-testid='gate-rail']")).not.toContainText(/est\./);
    await page.getByTestId("run-mode").selectOption("batch");
    await expect(rail).toHaveCount(5);
  });
});

/**
 * Gate 1 on the reviewer's OWN Preview, with one item declared in Concept Spotlight and the free search's answer
 * served: one group reached, above the cut-off. Suggestions are asked for only on an owned run.
 */
async function openSpotlightPreview(page: Page): Promise<{ target: ConceptGroup }> {
  const groups = previewRun(gate1Fixture()).result!.conceptGroups!;
  const target = groups[0]!;
  const component = "Race";
  // The declaration, as the reviewer left it in the tab.
  const declared: GateDecision = {
    scoreName: "My items",
    componentName: component,
    chosen: "",
    alternatives: [component],
    optionSetKey: optionSetKey([component]),
  };
  await page.addInitScript(
    ([key, state]) => sessionStorage.setItem(key, state),
    [
      `${SANDBOX_PREFIX}${PAUSED_JOB}`,
      JSON.stringify({
        gateDecisions: { composite_swap: { [decisionItemKey("composite_swap", declared)]: declared } },
      }),
    ] as const,
  );
  const answer: ScoreSuggestions = {
    scored: true,
    scoreKind: "dense_cosine",
    threshold: 0.62,
    reason: "",
    billedUsd: 0,
    scores: [
      {
        scoreName: "My items",
        nVariablesIndexed: 328,
        components: [
          {
            component,
            groups: [{ groupId: target.groupId, score: 0.9, bestMember: target.memberVariableNames[0] ?? "" }],
          },
        ],
      },
    ],
  };
  await page.route("**/api/harmonize/jobs/*/score/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) }),
  );
  await serveRun(page, (run) => previewRun(asOwnedRun(run)));
  await page.goto(`/run/${PAUSED_JOB}/gate1`);
  await page.waitForLoadState("networkidle");
  return { target };
}

/**
 * GATE 1'S FREE EXPORT (08-31 task 4): the groups as the reviewer left them, as a CSV, from `GET /jobs/{id}/gate1.csv`.
 * It is where a Preview ENDS, so its bar carries it; a paid Gate 1 carries it beside Continue. Building the file needs
 * the server, which this static build does not have — so here the Preview's control says why it is unavailable, the
 * paid bar (where it is an extra) shows nothing, and the link's shape is proved in node.
 */
test.describe("Gate 1 export", () => {
  test("@gate1 @preview the link is the run's own gate1.csv, carrying the token a download cannot send as a header", () => {
    expect(gate1ExportPath("/api/harmonize", "7fafc83f")).toBe("/api/harmonize/jobs/7fafc83f/gate1.csv");
    expect(gate1ExportPath("/api/harmonize", "a b", "t+k")).toBe("/api/harmonize/jobs/a%20b/gate1.csv?token=t%2Bk");
  });

  test("@gate1 @preview a Preview ends in the download — unavailable here, and saying why", async ({ page }) => {
    await openPreview(page);
    const end = page.locator("[data-testid='preview-end']");
    const download = end.locator("[data-testid='gate1-export']");
    await expect(download).toHaveText("Download groups (CSV)");
    await expect(download).toBeDisabled();
    await expect(end.locator("[data-testid='gate1-export-unavailable']")).toContainText(/server/i);
  });

  test("@gate1 a paid Gate 1's bar offers no dead download where there is no server to build it", async ({ page }) => {
    await page.goto(`/run/${PAUSED_JOB}/gate1`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-testid='commit-bar']")).toBeVisible();
    await expect(page.locator("[data-testid='gate1-export']")).toHaveCount(0);
  });
});
