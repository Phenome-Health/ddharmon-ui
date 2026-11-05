/**
 * Where the API lives, as a build setting (`VITE_API_ORIGIN`).
 *
 * Every deployed build leaves it EMPTY: the backend serves the SPA, so its API paths are same-origin. The Lavish review
 * surface sets it to a local backend (e.g. `http://localhost:8790`), because Lavish serves the page itself from its
 * own sandboxed origin — that is how the review runs the LIVE app, on the same data path as dev, rather than the
 * backend-less static build. Pure (no `import.meta.env`) so a Playwright spec can import it.
 */
export function withApiOrigin(origin: string | undefined, path: string): string {
  const o = (origin ?? "").trim().replace(/\/+$/, "");
  return o ? `${o}${path}` : path;
}
