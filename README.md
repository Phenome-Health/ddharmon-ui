# ddharmon-ui

Web GUI for the [**ddharmon**](https://github.com/Phenome-Health/ddharmon) harmonization
pipeline. A React + Vite + Tailwind + shadcn/ui frontend talking to a FastAPI backend that
wraps `ddharmon.harmonization`.

This repo sits **on top of** the core `ddharmon` library — modeled on the way
biomapper-ui sits on top of biomapper, but
deliberately simpler: a **single** FastAPI process serves both the built SPA and the `/api`
routes and runs `ddharmon` in-process (no Express / Clerk / Postgres).

> **Two ways to use ddharmon.** This repo is the point-and-click GUI (no code). To drive the
> same pipeline programmatically — Jupyter notebook, Python API, or CLI — use the core library
> directly: **[Phenome-Health/ddharmon](https://github.com/Phenome-Health/ddharmon)**. The
> harmonization logic lives there; this repo only adds the web layer.

```
React + Vite (frontend, :5173)  →  /api proxy  →  FastAPI (backend, :8000)  →  ddharmon
                                                   (one process; serves the built SPA in prod)
```

**Workflow:** upload cohort data dictionaries → map columns → run the pipeline (cluster →
value sub-cluster → CDE anchor → adopt/refine/novel) with live progress → review the
recommendations (approve / refine / reject) → export the EITL queue.

## Layout

```
backend/     FastAPI app (app.py) + in-memory job store (jobs.py) + pipeline runner (runner.py)
frontend/    React/Vite/shadcn SPA (build output -> frontend/dist, served by the backend in prod)
tests/       backend tests (monkeypatch BERTopic — no model download / API key needed)
dev.sh       dev: backend :8000 (--reload) + Vite :5173 (proxies /api)
serve.sh     prod-ish: build the SPA once, then serve SPA + API from one uvicorn process
```

## Prerequisites

- **Python 3.12+** with the **full ddharmon stack** — installed transitively via the
  `ddharmon[all]` dependency (sentence-transformers + BERTopic/UMAP/HDBSCAN + anthropic).
  Because `ddharmon` is a **private** repo, `pip install` needs git auth (SSH deploy key or a
  token) on whatever machine installs it.
- **Node 20+** and npm.
- **CDE catalog** flat TSVs — every run needs one, and they are not shipped in this repo; put them under
  `data/cde/` (or point `DDHARMON_CDE_DIR` at them). New runs default to `cdeSet` = `full`
  (`all_cdes_flat.tsv`); `endorsed` (`nih_endorsed_flat.tsv`) is the opt-in alternative. A server
  missing the requested file refuses the run by name — it never falls back to the other catalog.

  **Warm the catalog's embeddings after every deploy or catalog update.** Every run embeds the catalog
  through the shared embedding cache, and on a cold cache the first full-catalog run embeds all 22,743 rows
  on the CPU while a user waits. Run `.venv/bin/python scripts/warm_cde_cache.py` (both catalogs; add
  `--cde-set full` or `--cde-set endorsed` to warm just one) as the service's user with the service's
  `DDHARMON_CACHE` and `DDHARMON_CDE_DIR` (unset means `~/.ddharmon` and `data/cde/`), or it warms a cache the
  service never reads. It loads and embeds the catalog through the same code a run uses. On a warm cache it
  embeds nothing and finishes in about two seconds. Verify with `scripts/warm_cde_cache.py --check`
  (it never embeds, and exits 1 unless every row is cached) or with `/api/health`, where
  `cdeCache.catalogs.<name>` shows `{rows, cached, warm}` as the service sees it. That check runs in the
  background, so the value is `null` on the first poll after a start, and the first poll after the cache
  changes starts a re-check (at most one per 15 s). Poll again a few seconds later to read it.
- **`ANTHROPIC_API_KEY`** only for `classifyMode` = `sync`/`batch` (the default `none` runs the full
  clustering + anchoring with no LLM and no key).

## Install

```bash
uv venv && uv pip install -e ".[dev]"     # resolves ddharmon[all] from the private git repo
# or:  python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

### Develop against a local core checkout

If you have the `ddharmon` source checked out locally and want to iterate on both, install the
core editable first, then this repo's web deps without re-resolving the git pin:

```bash
uv pip install -e "../ddharmon[all]"   # path to your local ddharmon checkout
uv pip install -e . --no-deps
uv pip install "fastapi>=0.115" "uvicorn[standard]>=0.32" "python-multipart>=0.0.9"
```

## Run

**Dev** (hot reload; two processes):

```bash
./dev.sh        # backend :8000 + Vite :5173 → open http://localhost:5173
```

**Serve** (build once; single FastAPI process serves the SPA + API):

```bash
./serve.sh      # → open http://localhost:8000
```

Health check: `curl -s localhost:8000/api/health` → `{"status":"ok","frontendBuilt":true,...}`.

## Notes

- Jobs are kept **in-memory** — they're lost when the backend restarts (fine for a single-user GUI).
  Run exactly **one** uvicorn worker (in-memory job state + SSE need a single process).
- `classifyMode=none` shows CDE-anchored sub-clusters as `pending` (un-classified); choose
  `sync` (inline, needs API key) or `batch` (Anthropic Batch API, async) to get adopt/refine/novel.
- Uploaded files + batch artifacts land in `.ddharmon_ui/<jobId>/` (gitignored; override with
  `DDHARMON_UI_WORK`).
