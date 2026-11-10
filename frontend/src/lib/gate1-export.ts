/**
 * The Gate 1 export's link (08-31): `GET <base>/jobs/{id}/gate1.csv` — every group's variables as the reviewer left
 * them, plus the variables in no group. Free, owner-scoped, and served for Preview runs and paid runs at Gate 1.
 *
 * A PURE FUNCTION OF ITS INPUTS, in its own module, because `lib/api.ts` reads `import.meta.env` and so cannot be
 * imported by a Playwright spec — and the link's shape is the one thing about the download a backend-less e2e can
 * prove. `gate1ExportUrl` in `lib/api.ts` supplies the base and the token, and returns null on the static build.
 *
 * The TOKEN rides the query because a download link cannot carry an Authorization header — the same reason as
 * `exportUrl` and the SSE stream; the backend's auth gate reads `?token=` on every harmonize API route.
 */
export function gate1ExportPath(base: string, jobId: string, token?: string | null): string {
  const url = `${base}/jobs/${encodeURIComponent(jobId)}/gate1.csv`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}
