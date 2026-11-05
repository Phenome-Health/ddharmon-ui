/**
 * Shared plumbing for the LIVE project (see `playwright.live.config.ts`): which run, which stage, what the
 * driver decided, and the run's own data read straight from the rig's API — so a display assertion compares
 * the SCREEN against the server rather than against a value the test invented.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, type APIRequestContext, type Page } from "@playwright/test";

export const JOB = process.env.LIVE_JOB ?? "";
export const STAGE = process.env.LIVE_STAGE ?? "";
export const OUT = process.env.LIVE_OUT ?? "";

/** Skip unless the run is at one of `stages`. Every live spec opens with this. */
export function onlyAt(...stages: string[]): void {
  test.skip(!JOB, "LIVE_JOB is not set");
  test.skip(!stages.includes(STAGE), `applies at ${stages.join("/")}, the run is at ${STAGE || "?"}`);
}

/** The decisions the driver made this iteration (`<out>/state.json`), or `{}` when run by hand. */
export function driverState(): Record<string, any> {
  const p = OUT ? join(OUT, "state.json") : "";
  return p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

export async function api(request: APIRequestContext, path: string): Promise<any> {
  const r = await request.get(`/api/harmonize${path}`);
  if (!r.ok()) throw new Error(`${r.status()} GET ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export async function checkpoint(request: APIRequestContext): Promise<any> {
  return api(request, `/checkpoint/${JOB}`);
}

export async function artifacts(request: APIRequestContext): Promise<Record<string, any[]>> {
  return (await api(request, `/jobs/${JOB}/artifacts`)).artifacts ?? {};
}

export async function job(request: APIRequestContext): Promise<any> {
  const all = await api(request, "/jobs");
  return all.find((j: any) => j.jobId === JOB);
}

/** "$1.23" / "$0.0495" / "spent $0.70" → 0.70. NaN when there is no amount. */
export function usd(text: string | null | undefined): number {
  const m = (text ?? "").replace(/,/g, "").match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : Number.NaN;
}

export async function gotoGate(page: Page, gate: string): Promise<void> {
  await page.goto(`/run/${JOB}/${gate}`);
  await page.waitForLoadState("networkidle");
}

/** Balanced parentheses — a cheap, exact test for a label that was cut mid-parenthesis (F15). */
export function balanced(label: string): boolean {
  let depth = 0;
  for (const ch of label) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
