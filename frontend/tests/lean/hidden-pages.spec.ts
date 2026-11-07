import { test, expect } from "@playwright/test";

/**
 * The LEAN SITE — a build with VITE_HIDDEN_PAGES set the way prod sets it (playwright.lean.config.ts).
 *
 * Prod (ddharmon.io) is a stripped-down copy of dev for outside visitors (AMIA, 2026-11): the same code, minus
 * six content pages. A hidden page must be gone EVERYWHERE a visitor could reach it — the nav, its URL, and any
 * in-page link pointing at it — or prod ships a dead end. Each test below covers one of those three ways in.
 */

const HIDDEN = [
  { label: "Methods", path: "/methods" },
  { label: "Benchmarks", path: "/benchmarks" },
  { label: "Design", path: "/design" },
  { label: "Roadmap", path: "/roadmap" },
  { label: "Architecture", path: "/architecture" },
  { label: "Phenome Health", path: "/phenome" },
];
const KEPT = ["Guide", "Demo", "New run", "Runs", "Related work"];

test("the nav drops the hidden pages and keeps the rest", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByTestId("app-nav");
  for (const { label } of HIDDEN) {
    await expect(nav.getByRole("link", { name: label, exact: true }), `${label} should be hidden`).toHaveCount(0);
  }
  for (const label of KEPT) {
    await expect(nav.getByRole("link", { name: label, exact: true }), `${label} should stay`).toHaveCount(1);
  }
});

test("a hidden page's URL lands on the home page instead of the page", async ({ page }) => {
  // An old link (a slide, a README, a bookmark) must not open a page prod has dropped. The roadmap's design
  // previews go with the roadmap: it is their only way in, and each one's back link points at it.
  for (const path of [...HIDDEN.map((h) => h.path), "/preview/payoff", "/preview/restructure"]) {
    await page.goto(path);
    await expect(page, `${path} should redirect home`).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("One meaning.");
  }
});

test("no page that stays links into a hidden one", async ({ page }) => {
  // The Guide and Setup each carried an in-text link to Methods.
  for (const path of ["/", "/guide", "/related", "/demo", "/run/new/setup"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    for (const { path: hidden } of HIDDEN) {
      await expect(page.locator(`main a[href="${hidden}"]`), `${path} links to ${hidden}`).toHaveCount(0);
    }
  }
});

test("the lean site still carries the ARPA-H funding acknowledgement", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("funding-acknowledgement")).toContainText("Advanced Research Projects Agency for Health (ARPA-H)");
});
