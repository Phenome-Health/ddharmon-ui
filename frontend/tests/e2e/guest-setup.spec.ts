import { expect, test } from "@playwright/test";
import { GUEST_RUN_ACTION, guestAuthCopy, guestRunBlocker } from "@/lib/sandbox";

/**
 * A guest cannot run their own cohorts (the backend gates `/detect` and `/batch` behind sign-in: "a guest physically
 * cannot run their own cohorts"). Old prod's New run form said so and disabled Run for guests; the staged Setup lost
 * that, so a guest on ddharmon.io (2026-11-05) could fill in a whole run and only hit a 401 at Start. Setup now states
 * it up front, in the same words every other guest-blocked action uses, and makes it the ONLY blocker on Start.
 *
 * Pure checks: the static e2e build has no Clerk, so a browser here is never a guest. The rendered screen is checked
 * against a build with a real Clerk key (see the commit).
 */
test("@guest a guest is told, as Start run's only blocker, to sign in to run their own cohorts", () => {
  const blocker = guestRunBlocker(true);
  expect(blocker).not.toBeNull();
  expect(blocker).toMatch(/sign in/i);
  expect(blocker).toContain(GUEST_RUN_ACTION);
  // It points somewhere useful rather than at a dead end.
  expect(blocker).toMatch(/demo/i);
});

test("@guest anyone who can run sees no guest blocker", () => {
  expect(guestRunBlocker(false)).toBeNull();
});

test("@guest the Setup notice names the action, in the shared guest wording", () => {
  const { title, body } = guestAuthCopy(GUEST_RUN_ACTION);
  expect(title).toBe("Sign in to do this.");
  expect(body).toContain(GUEST_RUN_ACTION);
});
