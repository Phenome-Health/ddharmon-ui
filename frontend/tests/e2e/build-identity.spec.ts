import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { withApiOrigin } from "@/lib/api-origin";
import { buildStampText, uiTreeStamp } from "@/lib/build-stamp";

/**
 * What Bhargav approves in the Lavish review surface must be what lands on dev.ddharmon.io (2026-10-09: "I need
 * assurance that what I approve in lavish will be what I see on dev").
 *
 * Two app-side pieces make that checkable:
 *  1. THE SERVER ADDRESS IS A BUILD SETTING (`VITE_API_ORIGIN`). The review surface runs the LIVE app against a local
 *     backend — the same data path dev uses — instead of the backend-less static build, whose screens read a whole
 *     fixture and so can show what the live app drops (and vice versa: the demo's shipped score never reached any
 *     static build). Empty means same-origin, which is every deployed build.
 *  2. EVERY BUILD NAMES ITSELF by its git tree (`data-ui-tree` on <html>; the dev badge shows it with the live page
 *     width). The tree, not the commit: `integration/dev` adds merge commits whose content is the reviewed branch.
 *
 *   run: E2E_PORT=4199 npx playwright test build-identity
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

test.describe("the server address — as a function", () => {
  test("@build no origin keeps the path same-origin, exactly as every deployed build calls it", () => {
    expect(withApiOrigin(undefined, "/api/harmonize")).toBe("/api/harmonize");
    expect(withApiOrigin("", "/api/harmonize/stream/j1")).toBe("/api/harmonize/stream/j1");
    expect(withApiOrigin("   ", "/api/harmonize")).toBe("/api/harmonize");
  });

  test("@build an origin makes the path absolute, whatever trailing slashes it was given", () => {
    expect(withApiOrigin("http://localhost:8790", "/api/harmonize")).toBe("http://localhost:8790/api/harmonize");
    expect(withApiOrigin("http://localhost:8790/", "/api/harmonize")).toBe("http://localhost:8790/api/harmonize");
    expect(withApiOrigin("http://localhost:8790//", "/api/x")).toBe("http://localhost:8790/api/x");
  });

  test("@build no screen addresses the server except through lib/api.ts", () => {
    // A second '/api' literal would ignore VITE_API_ORIGIN and call the review surface's own (static) host.
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(path.join("lib", "api.ts")))
      .filter((f) => /["'`]\/api[/"'`]/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
    const api = readFileSync(path.join(SRC, "lib", "api.ts"), "utf8");
    expect(api).toMatch(/withApiOrigin\(/);
  });
});

test.describe("the build stamp — as a function", () => {
  test("@build the stamp names the tree and the page width", () => {
    expect(buildStampText("3f2c1a9", 1440)).toBe("build 3f2c1a9 · 1440px");
    expect(buildStampText("3f2c1a9+dirty", 1280)).toBe("build 3f2c1a9+dirty · 1280px");
    expect(buildStampText(null, 1024)).toBe("build unknown · 1024px");
  });

  test("@build a tree is stamped dirty when tracked files differ from it", () => {
    expect(uiTreeStamp("3f2c1a9d00", false)).toBe("3f2c1a9");
    expect(uiTreeStamp("3f2c1a9d00", true)).toBe("3f2c1a9+dirty");
    expect(uiTreeStamp(null, false)).toBeNull();
  });
});

test("@build the running page names the git tree it was built from", async ({ page }) => {
  const repo = path.resolve(SRC, "..", "..");
  const tree = execSync("git rev-parse HEAD^{tree}", { cwd: repo }).toString().trim();
  const dirty = execSync("git status --porcelain --untracked-files=no", { cwd: repo }).toString().trim() !== "";
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-tree", uiTreeStamp(tree, dirty)!);
});
