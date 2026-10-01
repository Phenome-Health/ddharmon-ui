import { expect, test, type Page } from "@playwright/test";
import { catalogPageFor, cdeDetailUrl } from "@/lib/links";
import { FINISHED_JOB, serveFinished } from "./gate23-fixture";

/**
 * Review round 2 (Gate 3 note 1): "adopt CDEs should have hyperlink to repo".
 *
 * Wherever Gates 2 and 3 NAME a catalog element as a concept's target — an adopt's CDE, and a refine's parent
 * (the catalog element it refines, which is what Gate 3 shows as its selected CDE) — the name links to that
 * element's NIH CDE Repository page, in a new tab. ONE helper decides it (`catalogPageFor`, over `cdeDetailUrl`),
 * and it NEVER links a generated element: a GenCDE has no catalog page, so a link would point at nothing — or at
 * an unrelated element that happens to share an id shape.
 *
 *   run: E2E_PORT=4213 npx playwright test catalog-links
 */

const ADOPT = "c46be33d9a542#g5"; // adopt -> "Age when stopped smoking cigarettes completely" (UHbvUDjaf)
const REFINE = "c0a367d9fb0eb#g0"; // refine of a catalog element (m1Nzc9j2jl), with a derived element
const NOVEL = "c46be33d9a542#g6"; // novel -> a generated element, no catalog target

test.describe("the catalog link rule", () => {
  test("@gate3 a catalog element links to its repository page by tinyId", () => {
    expect(catalogPageFor({ externalId: "UHbvUDjaf" })).toBe("https://cde.nlm.nih.gov/deView?tinyId=UHbvUDjaf");
    expect(catalogPageFor({ externalId: "UHbvUDjaf" })).toBe(cdeDetailUrl("UHbvUDjaf"));
    // the tinyId is a path-unsafe string from the wire: it is encoded, never spliced raw
    expect(catalogPageFor({ externalId: "a b&c" })).toBe("https://cde.nlm.nih.gov/deView?tinyId=a%20b%26c");
  });

  test("@gate3 a generated element, or one with no tinyId, gets no link", () => {
    expect(catalogPageFor({ externalId: "UHbvUDjaf", generated: true })).toBeNull();
    expect(catalogPageFor({ externalId: "" })).toBeNull();
    expect(catalogPageFor({ externalId: "   " })).toBeNull();
    expect(catalogPageFor({})).toBeNull();
    expect(catalogPageFor(null)).toBeNull();
  });
});

async function open(page: Page, gate: "gate2" | "gate3", groupId: string): Promise<void> {
  await serveFinished(
    page,
    (run) => {
      run.result!.records = [run.result!.records!.find((x) => x.groupId === groupId)!];
    },
    { keep: 0 },
  );
  await page.goto(`/run/${FINISHED_JOB}/${gate}`);
  await page.waitForLoadState("networkidle");
}

async function expectRepoLink(page: Page, scope: string, tinyId: string, name: string): Promise<void> {
  const link = page.locator(`${scope} [data-testid='catalog-link']`);
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", `https://cde.nlm.nih.gov/deView?tinyId=${tinyId}`);
  await expect(link).toHaveAttribute("target", "_blank");
  expect(await link.getAttribute("rel")).toMatch(/\bnoopener\b/);
  await expect(link).toContainText(name);
}

test.describe("Gate 3 names its catalog target as a link", () => {
  test("@gate3 an adopt's selected CDE links to the repository", async ({ page }) => {
    await open(page, "gate3", ADOPT);
    await expectRepoLink(
      page,
      "[data-testid='chosen-target']",
      "UHbvUDjaf",
      "Age when stopped smoking cigarettes completely",
    );
  });

  test("@gate3 a refine's parent CDE links to the repository", async ({ page }) => {
    await open(page, "gate3", REFINE);
    await expectRepoLink(page, "[data-testid='chosen-target']", "m1Nzc9j2jl", "Have you ever used any of these drugs");
  });

  test("@gate3 a generated target is never linked", async ({ page }) => {
    await open(page, "gate3", NOVEL);
    await expect(page.getByTestId("chosen-target")).toContainText("Synthesized CDE");
    await expect(page.locator("[data-testid='chosen-target'] [data-testid='catalog-link']")).toHaveCount(0);
    await expect(page.locator("[data-testid='chosen-target'] a")).toHaveCount(0);
  });
});

test.describe("Gate 2 names the same target with the same link", () => {
  test("@gate2 the current target on an adopt links to the repository", async ({ page }) => {
    await open(page, "gate2", ADOPT);
    await expectRepoLink(
      page,
      "[data-testid='current-target']",
      "UHbvUDjaf",
      "Age when stopped smoking cigarettes completely",
    );
    // the candidate row's own repo link is built by the same helper, and opens the same way
    const rowLink = page.locator("[data-testid='candidate-detail'] a", { hasText: "Full record on the repo" });
    await expect(rowLink).toHaveAttribute("href", "https://cde.nlm.nih.gov/deView?tinyId=UHbvUDjaf");
    await expect(rowLink).toHaveAttribute("target", "_blank");
    expect(await rowLink.getAttribute("rel")).toMatch(/\bnoopener\b/);
  });

  test("@gate2 a novel concept's target (its own generated element) is not linked", async ({ page }) => {
    await open(page, "gate2", NOVEL);
    await expect(page.getByTestId("current-target")).toBeVisible();
    await expect(page.locator("[data-testid='current-target'] a")).toHaveCount(0);
  });
});
