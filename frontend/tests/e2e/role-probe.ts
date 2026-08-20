import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";

/**
 * Shared measurement machinery for the two role gates — `contrast.spec.ts` (the shipped
 * stylesheet) and `rebrand-drill.spec.ts` (the stylesheet with tier 1 swapped).
 *
 * Two deliberate choices, both of which the previous gate got wrong:
 *
 * 1. **Colours are resolved BY THE BROWSER, never parsed.** The old gate read
 *    `getPropertyValue('--muted')` and parsed the string itself, which only worked because
 *    every value happened to be a hex or an `rgba()`. The role layer derives every wash and
 *    every alpha step with `color-mix()`, whose computed custom-property value is still
 *    `color-mix(...)` — a hand-written parser would have to reimplement sRGB interpolation to
 *    read it. Setting `color: var(--role)` on a probe and reading back `getComputedStyle`
 *    delegates that to the engine, so the number measured is the number that ships.
 *
 * 2. **An unresolved role is detected by SENTINEL INHERITANCE, not by an empty string.**
 *    `var(--nope)` is invalid at computed-value time, so the declaration falls back to the
 *    inherited value rather than to nothing — which is exactly how a deleted token keeps
 *    rendering something plausible and fails silently. Two probes with two different
 *    inherited sentinels disambiguate: if each returns its OWN sentinel, the token is unset.
 */

export interface ManifestForeground {
  role: string;
  utility: string;
  level: string;
  what: string;
}
export interface ManifestSurface {
  role: string;
  utility: string;
  what: string;
  foregrounds: ManifestForeground[];
  rules: { role: string; utility: string }[];
}
export interface RoleManifest {
  version: number;
  levels: Record<string, { min?: number; max?: number; why: string }>;
  surfaces: ManifestSurface[];
  graphicalMarks: { surface: string; note: string; roles: string[] };
  focus: { ring: string; surface: string; level: string }[];
  prohibited: { fg: string; bg: string; max: number; why: string }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = resolve(HERE, "../../src/tokens/role-manifest.json");

export function loadManifest(): RoleManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as RoleManifest;
}

/** Every (foreground, surface) pair the manifest requires, flattened with its threshold. */
export interface RequiredPair {
  fg: string;
  bg: string;
  level: string;
  min?: number;
  max?: number;
  label: string;
  why: string;
}

export function requiredPairs(m: RoleManifest): RequiredPair[] {
  const out: RequiredPair[] = [];
  for (const s of m.surfaces) {
    for (const f of s.foregrounds) {
      const level = m.levels[f.level];
      if (!level) throw new Error(`manifest: ${f.role} declares unknown level "${f.level}"`);
      out.push({
        fg: f.role,
        bg: s.role,
        level: f.level,
        min: level.min,
        max: level.max,
        label: `${f.role} on ${s.role}`,
        why: `${f.what} (${s.what})`,
      });
    }
  }
  for (const g of m.graphicalMarks.roles) {
    out.push({
      fg: g,
      bg: m.graphicalMarks.surface,
      level: "graphical",
      min: m.levels.graphical.min,
      label: `${g} on ${m.graphicalMarks.surface}`,
      why: m.graphicalMarks.note,
    });
  }
  for (const f of m.focus) {
    out.push({
      fg: f.ring,
      bg: f.surface,
      level: f.level,
      min: m.levels[f.level].min,
      label: `${f.ring} on ${f.surface}`,
      why: "the focus outline must be visible against the surface it outlines on",
    });
  }
  for (const p of m.prohibited) {
    out.push({ fg: p.fg, bg: p.bg, level: "prohibited", max: p.max, label: `${p.fg} on ${p.bg}`, why: p.why });
  }
  return out;
}

export interface Measured {
  label: string;
  ratio: number | null;
  fgResolved: string | null;
  bgResolved: string | null;
}

/**
 * Resolve and measure every pair inside the page. `overrideCss`, when given, is injected as a
 * stylesheet FIRST — that is the rebrand swap.
 */
export async function measure(
  page: Page,
  pairs: RequiredPair[],
  overrideCss?: string,
): Promise<{ measured: Measured[]; unresolved: string[] }> {
  if (overrideCss) await page.addStyleTag({ content: overrideCss });
  return page.evaluate(
    ({ pairs }) => {
      type Rgba = [number, number, number, number];

      // Two sentinels; a token is unresolved only if BOTH probes hand back their own.
      const SENTINELS = ["rgb(1, 2, 3)", "rgb(4, 5, 6)"];
      const host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "-9999px";
      document.documentElement.appendChild(host);

      const resolve = (token: string): string | null => {
        const seen: string[] = [];
        for (const sentinel of SENTINELS) {
          const parent = document.createElement("div");
          parent.style.color = sentinel;
          const probe = document.createElement("div");
          probe.style.color = `var(${token})`;
          parent.appendChild(probe);
          host.appendChild(parent);
          seen.push(getComputedStyle(probe).color);
          parent.remove();
        }
        if (seen[0] === SENTINELS[0] && seen[1] === SENTINELS[1]) return null; // unset
        return seen[0];
      };

      /**
       * Parse a colour as the ENGINE hands it back, which is not always `rgb()`. Chrome
       * serialises the result of `color-mix(in srgb, ... , transparent)` as
       * `color(srgb 1 1 0.972549 / 0.45)` — 0–1 components in a colour function — and the role
       * layer derives every alpha step that way. A parser that only knew `rgb()` would throw on
       * exactly the tokens this gate exists to measure.
       */
      const parse = (value: string): Rgba => {
        const v = value.trim();
        const legacy = /^rgba?\(([^)]+)\)$/i.exec(v);
        if (legacy) {
          const parts = legacy[1]
            .split(/[,\s/]+/)
            .filter(Boolean)
            .map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)));
          return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
        }
        const modern = /^color\(srgb\s+([^)]+)\)$/i.exec(v);
        if (modern) {
          const parts = modern[1]
            .split(/[\s/]+/)
            .filter(Boolean)
            .map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)));
          return [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts.length > 3 ? parts[3] : 1];
        }
        throw new Error(`unexpected computed colour: ${value}`);
      };

      const over = (fg: Rgba, bg: Rgba): Rgba => [
        fg[0] * fg[3] + bg[0] * (1 - fg[3]),
        fg[1] * fg[3] + bg[1] * (1 - fg[3]),
        fg[2] * fg[3] + bg[2] * (1 - fg[3]),
        1,
      ];

      const luminance = (c: Rgba): number => {
        const ch = (x: number) => {
          const s = x / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
      };

      const cache = new Map<string, string | null>();
      const cached = (t: string) => {
        if (!cache.has(t)) cache.set(t, resolve(t));
        return cache.get(t)!;
      };

      const unresolved = new Set<string>();
      const measured = pairs.map((p) => {
        const fgResolved = cached(p.fg);
        const bgResolved = cached(p.bg);
        if (!fgResolved) unresolved.add(p.fg);
        if (!bgResolved) unresolved.add(p.bg);
        if (!fgResolved || !bgResolved) {
          return { label: p.label, ratio: null, fgResolved, bgResolved };
        }
        // A surface must be opaque: a translucent surface has no defined contrast, and every
        // surface role in the manifest is a real ground.
        const bg = parse(bgResolved);
        const fg = over(parse(fgResolved), bg);
        const a = luminance(fg);
        const b = luminance(bg);
        const ratio = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
        return { label: p.label, ratio, fgResolved, bgResolved };
      });

      host.remove();
      return { measured, unresolved: Array.from(unresolved).sort() };
    },
    { pairs: pairs.map((p) => ({ fg: p.fg, bg: p.bg, label: p.label })) },
  );
}

/** Pairs that miss their requirement, as readable lines. */
export function shortfalls(pairs: RequiredPair[], measured: Measured[]): string[] {
  const byLabel = new Map(measured.map((m) => [m.label, m]));
  const bad: string[] = [];
  for (const p of pairs) {
    const m = byLabel.get(p.label);
    if (!m || m.ratio === null) {
      bad.push(`${p.label}: UNRESOLVED (a role that falls back to an inherited value)`);
      continue;
    }
    if (p.min !== undefined && m.ratio < p.min) {
      bad.push(`${p.label}: ${m.ratio.toFixed(2)}:1 < ${p.min} required (${p.level}) — ${p.why}`);
    }
    if (p.max !== undefined && m.ratio > p.max) {
      bad.push(`${p.label}: ${m.ratio.toFixed(2)}:1 > ${p.max} allowed (${p.level}) — ${p.why}`);
    }
  }
  return bad;
}
