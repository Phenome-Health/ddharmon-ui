import { expect, test } from "@playwright/test";
import { loadManifest } from "./role-probe";
import { routeUrl, VISUAL_ROUTES } from "./routes";

/**
 * THE PAIRING GATE — every rendered run of text, measured against the surface it is
 * ACTUALLY drawn on.
 *
 * Why this exists, and why the manifest gate is not enough. `contrast.spec.ts` proves that
 * every (surface, foreground) pair the manifest DECLARES holds. It cannot prove that a
 * component picked the right pair. Those are different claims, and the gap between them is
 * where the defect this whole plan was written for lived: `<main>` inherited `--on-chrome`
 * from `<body>`, bare copy rendered cream-on-cream, every declared pair measured fine, and
 * the gate was green the entire time. A gate can be blind rather than passing.
 *
 * So this one asks the only question that survives a surface change: walk up from each text
 * node to the first opaque background, and does the text clear its threshold against THAT?
 * It is what makes flipping the content field to the navy ground a checkable act rather than
 * a 22-page eyeball — an element left on `text-on-raised` over the navy field measures
 * 1.04:1 here and names itself, with its route, its classes and its words.
 *
 * THE DECORATION EXEMPTION, taken from the manifest rather than from a list of excuses.
 * Some marks are deliberately sub-AA: the `--on-*-faint` roles are declared `non-text` in
 * `role-manifest.json` precisely because "raise a hairline to text contrast and it stops
 * reading as a hairline". An element whose resolved colour IS one of those roles is held to
 * VISIBILITY (2.5:1) instead of legibility. That is not a loosening — a faint role has an
 * upper bound asserted in the contrast gate, so it cannot be used to smuggle body copy
 * through: to claim the exemption an element must be painting a colour the manifest itself
 * says is decoration.
 *
 * WHAT IS SKIPPED, and why each is a WCAG exemption rather than a convenience:
 *  - Disabled controls (1.4.3 explicitly exempts them) and anything under a partial opacity,
 *    whose composited value is a transient of the animation/disabled state, not a design pair.
 *  - `aria-hidden` subtrees: not presented to the user as text.
 *  - Zero-area and clipped-away nodes.
 */

const manifest = loadManifest();

/** Roles the manifest itself declares as decoration (`non-text`), by name. */
const FAINT_ROLES = manifest.surfaces
  .flatMap((s) => s.foregrounds)
  .filter((f) => f.level === "non-text")
  .map((f) => f.role);

test("@pairing every rendered run of text clears its threshold against the surface it is drawn on", async ({
  page,
  baseURL,
}) => {
  const failures: string[] = [];
  const counts: { route: string; measured: number; bad: number }[] = [];

  for (const route of VISUAL_ROUTES) {
    const url = await routeUrl(route, baseURL);
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    // The `/job/:jobId/*` family streams its result in. An unsettled scan measures a loading
    // shell and pronounces the route clean — the same blind spot the leak scan had to fix.
    await page.waitForLoadState("networkidle");

    const found = await page.evaluate((faintRoles: string[]) => {
      type Rgba = [number, number, number, number];

      // Transitions and animations must die FIRST: `getComputedStyle` hands back the
      // ANIMATING value, so a colour read while a `transition-colors` element is still
      // moving is last frame's paint. That mistake reported 31 false leaks in the drill.
      const freeze = document.createElement("style");
      freeze.textContent =
        "*, *::before, *::after { transition: none !important; animation: none !important; }";
      document.head.appendChild(freeze);
      void document.body.offsetHeight;

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
        return [0, 0, 0, 0];
      };
      const over = (fg: Rgba, bg: Rgba): Rgba => [
        fg[0] * fg[3] + bg[0] * (1 - fg[3]),
        fg[1] * fg[3] + bg[1] * (1 - fg[3]),
        fg[2] * fg[3] + bg[2] * (1 - fg[3]),
        1,
      ];
      const lum = (c: Rgba): number => {
        const ch = (x: number) => {
          const s = x / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
      };
      const contrast = (f: Rgba, b: Rgba) => {
        const a = lum(f);
        const c = lum(b);
        return Math.round(((Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05)) * 100) / 100;
      };

      /** Resolve a role to the paint the engine gives it — never a hand parser. */
      const roleColour = (token: string): string => {
        const probe = document.createElement("div");
        probe.style.color = `var(${token})`;
        document.documentElement.appendChild(probe);
        const v = getComputedStyle(probe).color;
        probe.remove();
        return v;
      };
      const faint = new Set(faintRoles.map(roleColour));

      /**
       * Every colour stop of a `background-image`, as the engine resolved them. A GRADIENT is
       * an opaque surface that `backgroundColor` reports as transparent, so a walk that reads
       * only `backgroundColor` climbs straight past the landing hero's navy gradient and
       * measures its cream text against the cream FIELD — 23 false failures on one route, all
       * of them text that is perfectly legible on the navy it actually sits on. The stops are
       * already resolved to `rgb()`/`color(srgb …)` in the computed value, so no gradient
       * maths is needed: a run of text over a gradient must clear its threshold at EVERY
       * stop, so each stop becomes a candidate surface and the WORST one decides.
       */
      const imageStops = (value: string): Rgba[] => {
        if (!value || value === "none") return [];
        const found = value.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/gi) ?? [];
        return found.map(parse).filter((c) => c[3] > 0);
      };

      /**
       * The surface a run of text is actually drawn on: climb until the composited stack is
       * opaque. Translucent layers are composited in order, which matters — a cream wash at
       * 60% over the navy field is neither cream nor navy, and rounding it to either would
       * make this gate lie in whichever direction was convenient.
       *
       * Returns CANDIDATES, not one colour, because a gradient is legitimately several
       * surfaces at once.
       */
      const effectiveBg = (el: Element): Rgba[] => {
        const stack: Rgba[] = [];
        let bases: Rgba[] | null = null;
        let node: Element | null = el;
        while (node) {
          const cs = getComputedStyle(node);
          const stops = imageStops(cs.backgroundImage);
          const c = parse(cs.backgroundColor);
          if (c[3] > 0) {
            if (c[3] >= 1 && !stops.length) {
              bases = [c];
              break;
            }
            stack.push(c);
          }
          if (stops.length) {
            // A gradient paints over this element's own background-color, so the colour layer
            // pushed just above it is not part of the ground beneath the stops.
            if (c[3] > 0 && c[3] < 1) stack.pop();
            bases = stops;
            break;
          }
          node = node.parentElement;
        }
        if (!bases) bases = [[255, 255, 255, 1]]; // no opaque ancestor: the canvas
        return bases.map((base) => {
          let acc = base;
          for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
          return acc;
        });
      };

      const hidden = (el: Element): boolean => {
        let node: Element | null = el;
        while (node) {
          const cs = getComputedStyle(node);
          if (cs.display === "none" || cs.visibility === "hidden") return true;
          if (Number(cs.opacity) < 1) return true; // disabled / mid-fade: not a design pair
          if (node.getAttribute("aria-hidden") === "true") return true;
          if (node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true") return true;
          node = node.parentElement;
        }
        return false;
      };

      const out: { desc: string; ratio: number; need: number; text: string }[] = [];
      let measured = 0;
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
        // Only elements with their OWN text, so a wrapper is not blamed for its child's paint.
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        if (!own) continue;
        if (hidden(el)) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;

        const cs = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        // SVG text paints with `fill`, not `color`.
        const raw = tag === "text" || tag === "tspan" ? cs.fill : cs.color;
        const fgRaw = parse(raw);
        if (fgRaw[3] === 0) continue; // fully transparent text is not text

        // The worst candidate decides: text over a gradient has to be legible along all of it.
        const candidates = effectiveBg(el);
        let ratio = Infinity;
        let bg = candidates[0];
        for (const cand of candidates) {
          const r = contrast(over(fgRaw, cand), cand);
          if (r < ratio) {
            ratio = r;
            bg = cand;
          }
        }
        void bg;
        measured++;

        const px = parseFloat(cs.fontSize);
        const weight = Number(cs.fontWeight) || 400;
        const large = px >= 24 || (px >= 18.66 && weight >= 600);
        // The decoration exemption, claimed only by painting a colour the manifest declares
        // `non-text`. Such a mark still has to be VISIBLE.
        const need = faint.has(raw) ? 2.5 : large ? 3 : 4.5;
        if (ratio < need) {
          const cls = (el.getAttribute("class") ?? "").slice(0, 110);
          out.push({
            desc: `<${tag}${cls ? ` class="${cls}"` : ""}>`,
            ratio,
            need,
            text: own.replace(/\s+/g, " ").slice(0, 52),
          });
        }
      }
      freeze.remove();
      return { out, measured };
    }, FAINT_ROLES);

    counts.push({ route: route.path, measured: found.measured, bad: found.out.length });
    for (const f of found.out) {
      failures.push(
        `${route.path.padEnd(26)} ${f.ratio.toFixed(2)}:1 (need ${f.need})  "${f.text}"  ${f.desc}`,
      );
    }
  }

  const total = counts.reduce((n, c) => n + c.measured, 0);
  console.log(`\n=== PAIRING GATE: ${total} text runs measured across ${counts.length} routes ===`);
  for (const c of counts) {
    console.log(`  ${c.route.padEnd(28)} ${String(c.measured).padStart(5)} runs, ${c.bad} short`);
  }

  expect(
    failures,
    `${failures.length} rendered run(s) of text do not clear contrast against the surface they are ` +
      `actually drawn on. This is the assertion the manifest gate cannot make: every DECLARED pair ` +
      `can hold while a component picks the WRONG pair — which is precisely how bare copy rendered ` +
      `cream-on-cream through a whole retheme. Fix the element's surface role, not this threshold:\n  ` +
      failures.join("\n  "),
  ).toEqual([]);
});
