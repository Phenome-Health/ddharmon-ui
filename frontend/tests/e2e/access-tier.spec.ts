import { expect, test } from "@playwright/test";
import { accessTier } from "@/lib/access-tier";

/**
 * Who gets in, keyed on the signed-in email's domain. Prod lists no full-access domains (everyone signed in is full).
 * Dev lists phenomehealth.org; until 2026-11-05 every other signed-in user landed on a read-only demo, and from then
 * dev turns that tier OFF (VITE_READ_ONLY_TIER=false) so any other account is refused outright — dev is PH-only.
 */
const PH = ["phenomehealth.org"];

test("@access no full-access list means everyone signed in is full (prod)", () => {
  expect(accessTier("someone@gmail.com", [], true)).toBe("full");
  expect(accessTier("someone@gmail.com", [], false)).toBe("full");
});

test("@access a listed domain is full, whatever the read-only setting", () => {
  expect(accessTier("alice@phenomehealth.org", PH, true)).toBe("full");
  expect(accessTier("alice@phenomehealth.org", PH, false)).toBe("full");
  expect(accessTier("Alice@PhenomeHealth.ORG", PH, false)).toBe("full");
});

test("@access any other account is read-only when the tier is on, refused when it is off (dev)", () => {
  expect(accessTier("collab@uni.edu", PH, true)).toBe("read-only");
  expect(accessTier("collab@uni.edu", PH, false)).toBe("refused");
  // A look-alike domain is not the domain.
  expect(accessTier("x@phenomehealth.org.evil.test", PH, false)).toBe("refused");
  expect(accessTier("x@notphenomehealth.org", PH, false)).toBe("refused");
});

test("@access a session with no email is never full on a locked deployment", () => {
  expect(accessTier(undefined, PH, false)).toBe("refused");
  expect(accessTier(undefined, PH, true)).toBe("read-only");
});
