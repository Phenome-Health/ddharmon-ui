"""FastAPI app for the ddharmon harmonization GUI.

Endpoints (all under /api/harmonize):
    POST /detect            columns -> suggested column->role map (SchemaRegistry)
    POST /batch             multipart upload of dict files + config -> {jobId}
    GET  /stream/{job_id}   SSE progress (event: progress)
    GET  /result/{job_id}   full job snapshot (REST fallback)
    GET  /jobs              list jobs (summaries)
    DELETE /jobs/{job_id}   delete a job
    POST /jobs/{job_id}/cancel    request a stop for an in-flight run (-> cancelled)
    POST /jobs/{job_id}/verdict   persist a human approve/refine/reject decision (by recordId)
    POST /jobs/{job_id}/records/{record_id}/regenerate-specs  regenerate member->GenCDE recodes after a refine
    GET  /jobs/{job_id}/export    eitl_tsv | records_json | decisions_csv | notebook_py | notebook_r
    GET  /demos              list precomputed demo datasets + available combos
    POST /demo               hydrate a completed job from a precomputed demo snapshot -> {jobId}

Serves the built frontend (frontend/dist) at / when present.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import shutil
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager, suppress
from copy import deepcopy
from pathlib import Path
from typing import Annotated, Any, cast

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import backend.artifact_kinds  # noqa: F401 — importing registers the artifact kinds
from backend import batch_reconcile
from backend.artifacts import ArtifactError, ReadOnlyRunError, UnknownArtifactKindError, registry
from backend.auth import AuthError, authenticate
from backend.checkpoint import Checkpoint, CheckpointMissingError, load_checkpoint, next_gate
from backend.db import JobDB
from backend.demos import demo_job_id, list_demos, load_snapshot, seed_demos
from backend.engine import CONTRACT_VERSION
from backend.jobs import _PINNED_CONFIG_KEYS, AWAITING_REVIEW, TERMINAL_STATES, Job, _is_pinned, principal_of, store
from backend.notebook import build_notebook
from backend.runner import run_harmonization

logger = logging.getLogger(__name__)

# --- CDE catalog (server-side; not uploaded) -------------------------------------------------
# Repo root is the parent of backend/ (this file is backend/app.py). The CDE catalog is NOT
# shipped in this repo (data/cde/ is gitignored) — supply it on the server and/or point
# DDHARMON_CDE_DIR at it. The pipeline REQUIRES a catalog (cdeSet must be endorsed|full).
_REPO_ROOT = Path(__file__).resolve().parents[1]
_CDE_DIR = Path(os.environ.get("DDHARMON_CDE_DIR", _REPO_ROOT / "data" / "cde"))
CDE_FILES = {"endorsed": _CDE_DIR / "nih_endorsed_flat.tsv", "full": _CDE_DIR / "all_cdes_flat.tsv"}
CDE_COLUMN_ROLES = {
    "variable_name": "designation",
    "field_id": "tinyId",
    "description": "definition",
    "question_text": "question_text",
    "data_type": "datatype",
    "value_encoding": "permissible_values",
    "category": "classification",
    "standard_code": "concept_codes",
}
CDE_COHORT = "NIH_CDE"

_WORK_ROOT = Path(os.environ.get("DDHARMON_UI_WORK", _REPO_ROOT / ".ddharmon_ui"))
# Let the job store tear down a job's on-disk scratch dir (<_WORK_ROOT>/<job_id>: uploads + prompts +
# substrate) on explicit delete. Owned runs now RETAIN their uploads so they can be re-run (see
# PERSIST-RUNS-PLAN.md); the scratch dir is torn down only when the user deletes the run.
store.work_root = _WORK_ROOT
# Durable per-user run history: a SQLite file under the work root (persists across restarts; survives a
# git pull but not a fresh clone — same lifetime as the CDE catalog). Override with DDHARMON_UI_DB.
_DB_PATH = Path(os.environ.get("DDHARMON_UI_DB", _WORK_ROOT / "jobs.db"))

# --- LiteLLM proxy (multi-provider gateway) --------------------------------------------------
# When LITELLM_PROXY_URL is set, the model picker's catalog comes from the proxy's /v1/models and
# non-Anthropic runs route through it. Unset (the default) → the picker shows a built-in fallback
# catalog and only Anthropic executes. LITELLM_MASTER_KEY authorizes the proxy's admin endpoints
# (catalog listing); it is read server-side only and is NEVER sent to the browser.
LITELLM_PROXY_URL = os.environ.get("LITELLM_PROXY_URL", "").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

# Built-in fallback model catalog (used when no proxy is configured) — mirrors the frontend fallback.
_FALLBACK_MODELS: list[dict[str, str]] = [
    {"id": "claude-sonnet-4-6", "provider": "anthropic", "label": "Claude Sonnet 4.6"},
    {"id": "claude-opus-4-8", "provider": "anthropic", "label": "Claude Opus 4.8"},
    {"id": "gpt-4o", "provider": "openai", "label": "GPT-4o"},
    {"id": "gemini/gemini-1.5-pro", "provider": "gemini", "label": "Gemini 1.5 Pro"},
]


def _provider_for_model(model_id: str) -> str:
    """Derive the provider bucket from a model id/prefix (mirrors ddharmon.llm provider prefixes)."""
    m = (model_id or "").lower()
    if m.startswith(("gemini/", "gemini-")):
        return "gemini"
    if m.startswith(("hosted_vllm/", "vllm", "ollama", "local", "local-")):
        return "local"
    if m.startswith(("gpt", "o1", "o3", "openai/")):
        return "openai"
    if m.startswith(("claude", "anthropic/")):
        return "anthropic"
    return "other"


def _reconcile_sweep(trigger: str) -> None:
    """Run the batch-reconciliation sweep once. Logs and swallows — never breaks the caller.

    Both callers are on paths that must not be able to fail: startup (a raise here would stop the server
    booting, over work that is recoverable on the next tick) and a background timer (a raise would kill
    the loop silently and end reconciliation for the process's lifetime).
    """
    try:
        outcomes = batch_reconcile.sweep(store=store)
    except Exception as exc:  # noqa: BLE001 — see docstring
        logger.warning("%s reconcile sweep failed (%s: %s)", trigger, type(exc).__name__, exc)
        return
    attached = [o for o in outcomes if o.changed]
    if attached:
        logger.info("%s reconcile sweep attached late batch results to %d run(s)", trigger, len(attached))


async def _reconcile_loop() -> None:
    """The interval half of D-04: the guarantee for a reviewer who never comes back.

    Sleeps FIRST, because the startup sweep has just run. Off-thread: the sweep is blocking disk plus
    provider I/O and must not stall the event loop that is serving progress streams.
    """
    while True:
        await asyncio.sleep(batch_reconcile.RECONCILE_INTERVAL_SECONDS)
        await asyncio.to_thread(_reconcile_sweep, "interval")


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Attach the durable store, reconcile any run interrupted by a prior restart, then prepopulate the
    Runs page with the precomputed demo(s) so a fresh boot is never empty. Demos are re-seeded every
    startup, ownerless, and exempt from TTL purging (never written to the durable store)."""
    store.db = JobDB(_DB_PATH)
    store.db.recover_stale()  # any non-terminal row = a worker that died on the last restart -> error
    seed_demos(store)
    # D-04 runs BOTH ways. This is the restart half: a batch submitted by the process that just died is
    # paid for and still retrievable, and nothing else in the system would ever go back for it.
    _reconcile_sweep("startup")
    reconciler = asyncio.create_task(_reconcile_loop())
    try:
        yield
    finally:
        reconciler.cancel()
        with suppress(asyncio.CancelledError):
            await reconciler
        store.db.close()


app = FastAPI(title="ddharmon Harmonization API", version="1.1.0", lifespan=_lifespan)

# CORS: the built SPA is served same-origin by this app in prod, so CORS matters only for the Vite dev
# proxy and any deliberate cross-origin caller. Lock the allowed origins via DDHARMON_UI_ALLOWED_ORIGINS
# (comma-separated) in prod, e.g. "https://ddharmon.io"; default to the localhost dev origins.
_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("DDHARMON_UI_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Endpoints reachable WITHOUT signing in (the "try the demo" guest path). The demo is a precomputed,
# no-LLM replay of public example data, so listing/starting it — and streaming/reading a *demo* job — is
# public. Everything else (detect, batch/upload, the runs list, real-run stream/result, verdicts, export)
# stays gated, so a guest physically cannot run their own cohorts. Demo-job scoping is checked via the
# store's ``config.demo`` flag so real runs are never exposed by the shared stream/result routes.
_PUBLIC_EXACT = {"/api/harmonize/demos", "/api/harmonize/demo"}
# READ paths only. `/checkpoint/` joins them because R9 promises a guest can walk every gate on the demo
# without an account, and a gate screen with no gate state is not a walk. `/resume/` deliberately does NOT:
# resume SPENDS MONEY, and an unauthenticated spend path is a different kind of surface (T-08-41). Each
# prefix is scoped by the store's own `config.demo` flag, so a real run is never exposed by a shared route.
_DEMO_SCOPED_PREFIXES = (
    "/api/harmonize/stream/",
    "/api/harmonize/result/",
    "/api/harmonize/checkpoint/",
)


def _is_public_path(path: str) -> bool:
    if path in _PUBLIC_EXACT:
        return True
    for prefix in _DEMO_SCOPED_PREFIXES:
        if path.startswith(prefix):
            job = store.get(path[len(prefix) :])
            return bool(job and job.config.get("demo"))
    return False


def _subject(request: Request) -> str | None:
    """The verified caller's Clerk subject, set on ``request.state`` by the auth gate. None on public/demo
    paths (the gate doesn't authenticate them) and when the gate is disabled (dev / no Clerk env)."""
    principal = getattr(request.state, "principal", None)
    return getattr(principal, "subject", None) if principal else None


def _visible_to(job: Job, subject: str | None) -> bool:
    """A run is visible to a caller if they own it, or it's a public demo/pinned run (visible to everyone).

    Visibility is NOT permission to write: a pinned run is readable by everyone and writable by no one (see
    :func:`_writable_run` and ``JobStore._is_pinned``). When run sharing lands this returns a permission
    rather than a bool — every write path must then check for write access, not mere visibility.
    """
    return _is_pinned(job) or job.owner_subject == subject


@contextmanager
def _writable_run() -> Iterator[None]:
    """Turn an attempted write to the immutable demo into a 403 that names the recovery.

    Every write path goes through this, so a new endpoint gets the guarantee by using the same wrapper
    rather than by remembering a rule.
    """
    try:
        yield
    except ReadOnlyRunError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except UnknownArtifactKindError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ArtifactError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.middleware("http")
async def _auth_gate(request: Request, call_next: Any) -> Any:
    """Gate ``/api/harmonize/*`` behind Clerk SSO when configured (see :mod:`backend.auth`).

    With no Clerk env set (local dev, the static demo) :func:`authenticate` returns an anonymous
    principal and this is a pass-through. OPTIONS (CORS preflight) and the public demo paths
    (:func:`_is_public_path`) are never gated. The SSE endpoint passes its token via ``?token=``
    because ``EventSource`` can't set an Authorization header.
    """
    path = request.url.path
    if request.method != "OPTIONS" and path.startswith("/api/harmonize/") and not _is_public_path(path):
        try:
            request.state.principal = authenticate(
                request.headers.get("authorization"),
                request.query_params.get("token"),
            )
        except AuthError as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


# The Runs page shows only real runs (the demo, via POST /demo, and any user runs). The synthetic
# "Sample —" seed runs were removed from the app — ``backend.seed`` is retained solely for tests that
# need to exercise the results/workbench/export UI without the pipeline. (Was gated on DDHARMON_UI_SEED.)


# --- /detect ---------------------------------------------------------------------------------
class DetectBody(BaseModel):
    columns: list[str]


@app.post("/api/harmonize/detect")
def detect(body: DetectBody) -> dict[str, Any]:
    """Suggest a column->role mapping (load_dictionary kwargs) for the given headers."""
    from ddharmon.ingestion.schema_registry import SchemaRegistry

    mapping = SchemaRegistry().detect_roles(body.columns)
    # Invert role_map (column -> match) into {kwarg: column}, keeping the highest-confidence column per role.
    best: dict[str, tuple[float, str]] = {}
    for column, match in mapping.role_map.items():
        kwarg = match.role.value
        if kwarg not in best or match.confidence > best[kwarg][0]:
            best[kwarg] = (match.confidence, column)
    column_roles = {kwarg: col for kwarg, (_conf, col) in best.items()}
    return {"columnRoles": column_roles, "confidence": mapping.overall_confidence}


# --- /batch ----------------------------------------------------------------------------------
@app.post("/api/harmonize/batch")
async def start_batch(
    request: Request,
    files: Annotated[list[UploadFile], File()],
    config: Annotated[str, Form()],
    x_anthropic_key: Annotated[str | None, Header()] = None,
    x_provider_key: Annotated[str | None, Header()] = None,
    x_provider: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    """Start a harmonization run. ``config`` is a JSON string:

    ``{dictionaries: [{filename, cohortName, columnRoles}], cdeSet: endorsed|full,
       runMode: batch|sync|preview, minClusterSize: int, genTransformSpecs?: bool,
       topK?: int, retrievalFloor?: float, modelTag?: str, displayName?}``

    The pipeline requires a CDE catalog (assignment to the given backbone is the thesis) — ``cdeSet`` must be
    ``endorsed`` or ``full``. ``runMode`` defaults to ``batch`` (the deployed default).

    BYOK: the ``X-Anthropic-Key`` header (frontend ``x-anthropic-key``) carries a per-request Anthropic
    key. It is threaded to the pipeline as an in-memory arg for this job only — deliberately NOT written
    into ``run_config`` (which ``store.create`` persists) or any log, so it never touches disk.
    """
    cfg = json.loads(config)
    job_id = str(uuid.uuid4())
    work_dir = _WORK_ROOT / job_id
    uploads = work_dir / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)

    saved: dict[str, Path] = {}
    for up in files:
        dest = uploads / Path(up.filename or "upload.csv").name
        with open(dest, "wb") as fh:
            shutil.copyfileobj(up.file, fh)
        saved[dest.name] = dest

    dict_specs: list[dict[str, Any]] = []
    for d in cfg.get("dictionaries", []):
        fname = Path(d["filename"]).name
        if fname not in saved:
            raise HTTPException(status_code=400, detail=f"Uploaded file missing for {fname!r}")
        roles = {k: v for k, v in d.get("columnRoles", {}).items() if v}
        if "variable_name" not in roles and "description" not in roles and "question_text" not in roles:
            raise HTTPException(
                status_code=400, detail=f"{fname!r} needs at least variable_name/description/question_text"
            )
        dict_specs.append({"path": str(saved[fname]), "cohort_name": d["cohortName"], "column_roles": roles})

    # The pipeline REQUIRES a CDE backbone (assignment to the given catalog is the thesis) — no cdeSet=none path.
    cde_set = cfg.get("cdeSet", "endorsed")
    if cde_set not in CDE_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"cdeSet must be one of {sorted(CDE_FILES)} — harmonization requires a CDE catalog",
        )
    cde_path = CDE_FILES[cde_set]
    if not cde_path.exists():
        raise HTTPException(
            status_code=400, detail=f"CDE file not found: {cde_path} (set DDHARMON_CDE_DIR to the catalog directory)"
        )
    cde_spec: dict[str, Any] = {
        "path": str(cde_path),
        "cohort_name": CDE_COHORT,
        "column_roles": dict(CDE_COLUMN_ROLES),
    }

    run_mode = cfg.get("runMode", "batch")
    if run_mode not in ("batch", "sync", "preview"):
        raise HTTPException(status_code=400, detail="runMode must be batch|sync|preview")
    run_config: dict[str, Any] = {
        "run_mode": run_mode,
        "gen_transform_specs": bool(cfg.get("genTransformSpecs", True)),
        # "Suggest analysis ideas" toggle — generate them during the run (same model/provider/key) so the
        # results page has them ready. No-op in preview (no LLM). The runner reads this.
        "gen_analysis_ideas": bool(cfg.get("suggestAnalysisIdeas", True)),
        "cde_cohort": CDE_COHORT,
        "work_dir": str(work_dir),
        "cde_set": cde_set,
        # Corpus size the New-Run form estimated (variables / cohorts). Display-only — persisted so the run
        # view's Stop dialog can show a committed-vs-avoided cost estimate (run_config keeps no dictionaries).
        "est_fields": int(cfg["estFields"]) if cfg.get("estFields") is not None else None,
        "est_cohorts": int(cfg["estCohorts"]) if cfg.get("estCohorts") is not None else None,
    }
    # Optional advanced knobs — passed through only when set (else the engine's defaults apply). min_cluster_size
    # is auto-scaled from corpus size by the engine when omitted (no longer a GUI knob); an explicit value from
    # an advanced/API caller still wins. Adding a new knob here needs no frontend change.
    for cfg_key, run_key in (
        ("minClusterSize", "min_cluster_size"),
        ("topK", "top_k"),
        ("retrievalFloor", "retrieval_floor"),
        ("modelTag", "model_tag"),
    ):
        if cfg.get(cfg_key) is not None:
            run_config[run_key] = int(cfg[cfg_key]) if cfg_key in ("minClusterSize", "topK") else cfg[cfg_key]
    # Non-Anthropic providers have no Anthropic-style Batch API, so they run SYNCHRONOUSLY regardless of the
    # requested runMode. Anthropic keeps the (default) cost-bounded batch path. Provider is derived from the
    # selected model tag; the picker also sends x-provider as a hint (used only for logging/telemetry here).
    selected_model = run_config.get("model_tag")
    if run_config["run_mode"] == "batch" and selected_model and _provider_for_model(str(selected_model)) != "anthropic":
        run_config["run_mode"] = "sync"
    # BYOK: prefer the provider-agnostic header; fall back to the legacy Anthropic-specific one. Held in memory
    # for this job only (thread kwarg below) — never written to run_config (persisted) or any log.
    effective_key = x_provider_key or x_anthropic_key
    display = cfg.get("displayName") or f"Run {job_id[:8]}"
    # Own the run (verified Clerk subject) and persist dict_specs so it can be re-run from its retained
    # uploads. dict_specs paths point into this job's work_dir/uploads, which now survives until delete.
    store.create(job_id, display, run_config, owner_subject=_subject(request), dict_specs=dict_specs)
    # api_key rides as a thread kwarg (in-memory, this job only) — never in run_config, which is persisted.
    threading.Thread(
        target=run_harmonization,
        args=(store, job_id, dict_specs, cde_spec, run_config),
        kwargs={"api_key": effective_key},
        daemon=True,
    ).start()
    return {"jobId": job_id}


# --- /models ---------------------------------------------------------------------------------
@app.get("/api/harmonize/models")
def list_models() -> dict[str, Any]:
    """Model catalog for the New Run picker. With a LiteLLM proxy configured (LITELLM_PROXY_URL), proxy its
    OpenAI-compatible /v1/models catalog; otherwise return a built-in fallback list. The master key is used
    server-side only (never returned to the browser). Any proxy error falls back to the built-in catalog so
    the picker always renders."""
    if LITELLM_PROXY_URL:
        try:
            import httpx

            headers = {"Authorization": f"Bearer {LITELLM_MASTER_KEY}"} if LITELLM_MASTER_KEY else {}
            resp = httpx.get(f"{LITELLM_PROXY_URL}/v1/models", headers=headers, timeout=5.0)
            resp.raise_for_status()
            data = resp.json().get("data", [])
            models: list[dict[str, str]] = []
            for m in data:
                mid = m.get("id") if isinstance(m, dict) else None
                if mid:
                    models.append({"id": mid, "provider": _provider_for_model(mid), "label": mid})
            if models:
                return {"models": models, "source": "proxy"}
        except Exception:
            # Proxy unreachable / misconfigured — fall through to the built-in catalog so the picker still works.
            pass
    return {"models": list(_FALLBACK_MODELS), "source": "fallback"}


# --- SSE + result ----------------------------------------------------------------------------
def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _fmt(x: float | None) -> str:
    return "" if x is None else f"{x:.3f}"


def _clean(s: Any) -> str:
    return str(s).replace("\t", " ").replace("\n", " ").replace("\r", " ")


@app.get("/api/harmonize/stream/{job_id}")
async def stream(job_id: str, request: Request) -> StreamingResponse:
    # Resolved ONCE, outside the generator: `request` is still in scope while streaming, but the subject is a
    # property of the connection, not of each tick, and re-deriving it per frame invites a mid-stream change.
    subject = _subject(request)
    job = store.get(job_id)
    # 404 (not 403) on a run the caller doesn't own, so we never reveal that someone else's job exists.
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")

    async def gen() -> Any:
        store.purge_expired()
        while True:
            job = store.get(job_id)
            if job is None:
                yield _sse("error", {"message": "Job not found"})
                return
            # THIN frame (08 D-03): live fields plus a `resultVersion` token, and no payload. The former
            # `to_dict()` here shipped the whole job — `result` included — twice a second. That was free
            # only while `result` stayed None until terminal; a checkpointed run has a multi-megabyte
            # partial from Gate 2 onward, so the same code became a 6.8 MB frame at 2 Hz (T-08-38).
            #
            # It is also why this no longer needs owner-scoping: the frame carries nothing owner-specific
            # (no result, no decisions, no ideas, no composites, not even `config`), so the shared-run leak
            # the artifact scoping existed to close cannot occur here. The payload is fetched from
            # /result/{job_id}, which IS owner- and demo-scoped, when the token moves.
            yield _sse("progress", job.progress_dict())
            if job.status in TERMINAL_STATES:
                return
            # A gate pause is an EXIT (D-01): there is no worker left to report progress, so holding the
            # stream open would poll a dead run forever. Close and let the client refetch the payload.
            if job.status == AWAITING_REVIEW:
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


def _checkpoint_for(job: Job) -> Checkpoint | None:
    """The persisted gate payload for a paused run, or None when it is not paused.

    Raises 409 rather than 200-with-nothing when the pointer is set but the artifact cannot be read: a
    silent empty Gate 1 shows the reviewer fewer concept groups than they scoped with nothing saying so
    (T-08-43). The message names the artifact, because the operator's next step is to look at that file.
    """
    if job.status != AWAITING_REVIEW or not job.checkpoint_ref:
        return None
    root = store.work_root or _WORK_ROOT
    try:
        return load_checkpoint(Path(root) / job.checkpoint_ref)
    except CheckpointMissingError as exc:
        raise HTTPException(status_code=409, detail=f"This run's saved state could not be read: {exc}") from exc


def _reconcile_on_open(job: Job, *, api_key: str | None = None) -> None:
    """The fast half of D-04: reconcile THIS run before its gate state is served.

    Without it a returning reviewer sees a run short of work they were already charged for until the next
    interval tick. Same function as the sweep calls — there is exactly one reconcile implementation.

    Swallows everything. This runs on the reviewer's only route back to their paid work, so a provider
    hiccup or a missing work dir must degrade to "no new results attached", never to a screen they cannot
    open. A pinned demo is skipped inside ``reconcile_run``, which is what keeps the demo-scoped (and
    therefore unauthenticated) read from being able to make this server talk to a provider.
    """
    try:
        batch_reconcile.reconcile_run(job.job_id, store=store, api_key=api_key)
    except Exception as exc:  # noqa: BLE001 — see docstring
        logger.warning("on-open reconcile of %s failed (%s: %s)", job.job_id, type(exc).__name__, exc)


@app.get("/api/harmonize/result/{job_id}")
def result(job_id: str, request: Request) -> dict[str, Any]:
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    body = job.to_dict(store.artifacts_for(job, subject))
    # A paused run's payload lives on the per-run work dir, not in its row (D-02), so it is rehydrated
    # here. This is what makes "close the browser at Gate 1 and come back to the same groups" work across
    # a process restart: nothing is re-run and nothing is re-charged.
    ckpt = _checkpoint_for(job)
    if ckpt is not None:
        body["result"] = ckpt.result
    return body


@app.get("/api/harmonize/checkpoint/{job_id}")
def checkpoint_state(
    job_id: str, request: Request, x_anthropic_key: Annotated[str | None, Header()] = None
) -> dict[str, Any]:
    """Where a run is parked and what it is parked with — the gate screens' entry read.

    Separate from /result because it answers a different question ("which screen, and what did reaching it
    cost?") and a returning reviewer's router needs the answer BEFORE deciding which gate to render. It
    never carries raw stage responses: those are resume fuel, not review data.

    This is also where a reopen reconciles (D-04). The key is optional and never stored: retrieving an
    already-submitted batch is free, but the provider still wants a credential, and on a bring-your-own-key
    deployment the reviewer's own request is the only place one exists.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    # Reconcile BEFORE reading the run back: serving the pre-reconcile payload would hand the reviewer a
    # version token that is already stale, so the screen they are looking at is the one without their work.
    _reconcile_on_open(job, api_key=x_anthropic_key)
    job = store.get(job_id) or job
    ckpt = _checkpoint_for(job)
    return {
        "jobId": job.job_id,
        "status": job.status,
        "gatePosition": job.gate_position,
        "resumeGate": job.resume_gate(),
        "nextGate": next_gate(job.gate_position) if job.gate_position else None,
        "resultVersion": job.result_version,
        "costSoFar": job.cost_so_far,
        "result": ckpt.result if ckpt is not None else None,
    }


@app.post("/api/harmonize/resume/{job_id}")
def resume_run(
    job_id: str, request: Request, x_anthropic_key: Annotated[str | None, Header()] = None
) -> dict[str, Any]:
    """Commit the current gate and continue the run to the next boundary — the Continue action.

    A fresh worker, not a woken one (D-01). It is handed the previous gate's recorded stage answers, so
    every prompt the earlier leg already paid for is replayed at $0 and only genuinely new work reaches a
    provider.

    Authenticated even for the demo: this is the spend path. Pressing Continue at Gate 0 is the run's FIRST
    CHARGE (UI-SPEC §0.1), so it is not a surface a guest reaches by accident.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    with _writable_run():
        if _is_pinned(job):
            raise ReadOnlyRunError(f"{job_id} is the shared demo and cannot be resumed — clone it first")
    if job.status != AWAITING_REVIEW or not job.gate_position:
        raise HTTPException(status_code=409, detail="This run is not paused at a gate")
    target = next_gate(job.gate_position)
    if target is None:
        raise HTTPException(status_code=409, detail="This run is at the final gate; there is nothing to resume")
    # Reconcile before the replay fuel is read, not after: a late batch result that is attached now is a
    # stage this leg replays for $0, and one attached a minute later is a stage it pays for twice.
    _reconcile_on_open(job, api_key=x_anthropic_key)
    job = store.get(job_id) or job
    ckpt = _checkpoint_for(job)
    if ckpt is None:
        raise HTTPException(status_code=409, detail="This run has no saved state to resume from")
    if not job.dict_specs or not job.config.get("work_dir"):
        raise HTTPException(status_code=409, detail="This run predates resumable gates (no retained uploads)")

    cde_set = job.config.get("cde_set", "endorsed")
    cde_path = CDE_FILES.get(cde_set)
    if cde_path is None or not cde_path.exists():
        raise HTTPException(status_code=409, detail=f"CDE catalog {cde_set!r} is unavailable on the server")
    cde_spec = {"path": str(cde_path), "cohort_name": CDE_COHORT, "column_roles": dict(CDE_COLUMN_ROLES)}
    # Only gates with a core boundary are stop targets; past that the pipeline runs to completion and the
    # UI backend holds the run itself (UI-SPEC §0.1).
    run_config = {**job.config, "stop_at_gate": target if target in ("gate1", "gate2") else None}
    store.update(job_id, status="pending", phase="pending")
    threading.Thread(
        target=run_harmonization,
        args=(store, job_id, job.dict_specs, cde_spec, run_config),
        kwargs={"api_key": x_anthropic_key, "replay_responses": ckpt.responses},
        daemon=True,
    ).start()
    return {"jobId": job_id, "resumedFrom": job.gate_position, "target": target}


# --- jobs list / delete ----------------------------------------------------------------------
@app.get("/api/harmonize/jobs")
def list_jobs(request: Request) -> list[dict[str, Any]]:
    """The caller's own runs (durable history + any live) plus the public demo(s), newest first."""
    subject = _subject(request)
    return [j.summary_dict(store.artifacts_for(j, subject)) for j in store.list(subject)]


@app.delete("/api/harmonize/jobs/{job_id}", status_code=204)
def delete_job(job_id: str, request: Request) -> None:
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)):
        raise HTTPException(status_code=404, detail="Job not found")
    store.delete(job_id)


@app.post("/api/harmonize/jobs/{job_id}/cancel")
def cancel_job(job_id: str, request: Request, mode: str = "discard") -> dict[str, bool]:
    """Request a stop for an in-flight run the caller owns. ``mode`` is ``keep`` (finish the current stage,
    keep its partial result, skip the rest — no further LLM cost) or ``discard`` (abort ASAP, no result).
    Cooperative: flags the job; the worker acts at its next checkpoint (-> ``cancelled``). Idempotent —
    ``cancelled`` is False when the run is unknown to the caller (404) or already terminal (nothing to stop)."""
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"cancelled": store.request_cancel(job_id, mode)}


@app.post("/api/harmonize/jobs/{job_id}/rerun")
def rerun_job(job_id: str, request: Request, x_anthropic_key: Annotated[str | None, Header()] = None) -> dict[str, str]:
    """Re-execute a past run from its retained uploads as a NEW owned run (the original is preserved).

    Copies the source job's uploaded dictionaries into a fresh work dir and restarts the pipeline with the
    same config. BYOK: batch/sync modes need the ``X-Anthropic-Key`` header re-supplied (never persisted);
    preview mode needs none.
    """
    subject = _subject(request)
    src = store.get(job_id)
    if src is None or not _visible_to(src, subject) or _is_pinned(src):
        raise HTTPException(status_code=404, detail="Job not found")
    if not src.dict_specs or not src.config.get("work_dir"):
        raise HTTPException(status_code=409, detail="This run predates re-run support (no retained uploads)")

    old_uploads = Path(src.config["work_dir"]) / "uploads"
    if not old_uploads.is_dir():
        raise HTTPException(status_code=409, detail="Uploaded files for this run are no longer available")

    # Rebuild the CDE backbone from the stored cdeSet (catalog files live server-side, not in the job dir).
    cde_set = src.config.get("cde_set", "endorsed")
    cde_path = CDE_FILES.get(cde_set)
    if cde_path is None or not cde_path.exists():
        raise HTTPException(status_code=409, detail=f"CDE catalog {cde_set!r} is unavailable on the server")

    new_id = str(uuid.uuid4())
    new_work = _WORK_ROOT / new_id
    new_uploads = new_work / "uploads"
    shutil.copytree(old_uploads, new_uploads)
    # Remap each dict_spec path (same filenames) into the new uploads dir.
    new_specs = [{**s, "path": str(new_uploads / Path(s["path"]).name)} for s in src.dict_specs]
    cde_spec = {"path": str(cde_path), "cohort_name": CDE_COHORT, "column_roles": dict(CDE_COLUMN_ROLES)}
    run_config = {**src.config, "work_dir": str(new_work)}

    display = f"{src.display_name} (re-run)"
    store.create(new_id, display, run_config, owner_subject=subject, dict_specs=new_specs)
    threading.Thread(
        target=run_harmonization,
        args=(store, new_id, new_specs, cde_spec, run_config),
        kwargs={"api_key": x_anthropic_key},
        daemon=True,
    ).start()
    return {"jobId": new_id}


@app.post("/api/harmonize/jobs/{job_id}/analysis-ideas")
def analysis_ideas(
    job_id: str,
    request: Request,
    x_anthropic_key: Annotated[str | None, Header()] = None,
    regenerate: bool = False,
) -> dict[str, Any]:
    """Suggest (never run) downstream cross-cohort analyses this run's harmonization unlocks — one opt-in,
    BYOK LLM pass over the run's own concepts (metadata only). Cached on the job after the first call so it
    isn't re-billed on every view; ``?regenerate=true`` forces a fresh pass.
    """
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)):
        raise HTTPException(status_code=404, detail="Job not found")
    if job.analysis_ideas is not None and not regenerate:
        return {"ideas": job.analysis_ideas, "cached": True}
    records = (job.result or {}).get("records") if job.result else None
    if not records:
        raise HTTPException(status_code=409, detail="This run has no harmonized concepts to analyze yet.")

    from backend.analysis_ideas import generate_analysis_ideas
    from backend.engine.llm import build_llm_client
    from backend.llm_errors import llm_call

    # Use the SAME model/provider the run was configured with (its persisted model_tag), not the SDK's stale
    # default. BYOK: the key is in-memory for this request only — never persisted or logged.
    model_tag = job.config.get("model_tag")
    client = build_llm_client(model_tag, x_anthropic_key)
    # A rejected key or an overloaded provider is an expected condition, not a crash — surface it as such.
    with llm_call(model=model_tag):
        out = generate_analysis_ideas(records, client.complete)
    store.set_analysis_ideas(job_id, out["ideas"], subject=_subject(request))
    return {"ideas": out["ideas"], "nConcepts": out["nConcepts"], "cached": False}


# --- clone ------------------------------------------------------------------------------------
class CloneBody(BaseModel):
    """Take a copy of a run — how work done in the canonical demo is kept.

    ``artifacts`` carries the browser's sandbox edits (verdicts, composite specs), so "clone with my changes"
    needs no server-side guest session and no identity merge: the client already holds them. Omit it for a
    clean copy. ``recordPatches`` carries edits that changed the run's own records (a corrected GenCDE),
    which are applied to the copy's result blob.
    """

    displayName: str | None = None
    artifacts: list[dict[str, Any]] | None = None  # [{kind, payload}, …]
    recordPatches: list[dict[str, Any]] | None = None  # whole records, matched by id


@app.post("/api/harmonize/jobs/{job_id}/clone")
def clone_job(job_id: str, body: CloneBody, request: Request) -> dict[str, str]:
    """Copy a run into one the caller owns, optionally carrying their sandbox edits.

    Requires an account (this route is gated): the copy is owned, and without a subject there is no one to
    own it. The demo/pinned flags are STRIPPED — inheriting them would make the copy immutable and
    TTL-exempt, i.e. another shared demo, which is the precise opposite of the point.
    """
    subject = _subject(request)
    source = store.get(job_id)
    if source is None or not _visible_to(source, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    if source.result is None:
        raise HTTPException(status_code=409, detail="This run has no result to copy yet.")

    new_id = uuid.uuid4().hex[:12]
    # Deep copy: a shallow one leaves the copy sharing the demo's record list, so editing the copy would
    # mutate the canonical demo for everyone — the very thing this design exists to prevent.
    result = deepcopy(source.result)
    records = result.get("records") or []
    by_id = {r.get("id"): i for i, r in enumerate(records)}
    for patch in body.recordPatches or []:
        i = by_id.get(patch.get("id"))
        if i is not None:
            records[i] = patch

    config = {k: v for k, v in source.config.items() if k not in _PINNED_CONFIG_KEYS}
    config["clonedFrom"] = job_id
    display = (body.displayName or "").strip() or f"{source.display_name} (my copy)"
    # dict_specs are deliberately NOT copied: the uploads live under the SOURCE run's work dir, so the copy
    # cannot be re-run from them. It is a review artifact, not a re-runnable run.
    store.create(new_id, display, config, owner_subject=subject)
    store.update(new_id, status="complete", phase="complete", result=result)

    artifacts = store.artifacts
    if artifacts is not None and body.artifacts:
        owner = principal_of(subject, store.get(new_id))
        with _writable_run():
            for entry in body.artifacts:
                kind, payload = entry.get("kind"), entry.get("payload")
                if not kind or not isinstance(payload, dict):
                    raise HTTPException(status_code=400, detail="each artifact needs a kind and a payload object")
                artifacts.put(owner=owner, job_id=new_id, kind=str(kind), payload=payload)
    return {"jobId": new_id}


# --- user artifacts (generic) ----------------------------------------------------------------
# One surface for every kind of user-generated work attached to a run. A new persisted feature registers
# its kind in backend/artifact_kinds.py and is reachable here immediately — no new route, no new column,
# no new setter. Feature endpoints that DO more than store (an LLM derivation, a result-blob merge) keep
# their own route and persist through the same store.


def _artifact_target(job_id: str, request: Request) -> tuple[Job, str]:
    """The run and the caller's owner key, or 404/403. Rejects the immutable demo for writes."""
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    return job, principal_of(subject, job)


@app.get("/api/harmonize/jobs/{job_id}/artifacts")
def list_artifacts(job_id: str, request: Request) -> dict[str, Any]:
    """Everything the CALLER has stored against this run, grouped by kind."""
    job, owner = _artifact_target(job_id, request)
    return {"kinds": registry.names(), "artifacts": store.artifacts_for(job, owner)}


@app.put("/api/harmonize/jobs/{job_id}/artifacts/{kind}")
def put_artifact(job_id: str, kind: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Upsert one artifact. Its identity (and so what it replaces) is derived by its kind."""
    job, owner = _artifact_target(job_id, request)
    artifacts = store.artifacts
    if artifacts is None:
        raise HTTPException(status_code=503, detail="Persistence is not configured on this server")
    with _writable_run():
        stored = artifacts.put(owner=owner, job_id=job_id, kind=kind, payload=payload, pinned=_is_pinned(job))
    return {"kind": stored.kind, "itemKey": stored.item_key, "updatedAt": stored.updated_at}


@app.delete("/api/harmonize/jobs/{job_id}/artifacts/{kind}/{item_key:path}", status_code=204)
def delete_artifact(job_id: str, kind: str, item_key: str, request: Request) -> None:
    job, owner = _artifact_target(job_id, request)
    artifacts = store.artifacts
    if artifacts is None:
        raise HTTPException(status_code=503, detail="Persistence is not configured on this server")
    with _writable_run():
        if _is_pinned(job):
            raise ReadOnlyRunError(f"{job_id} is the shared demo and cannot be modified")
        artifacts.delete(owner=owner, job_id=job_id, kind=kind, item_key=item_key)


# --- composite / derived variables -----------------------------------------------------------
class CompositeBody(BaseModel):
    """Derive one composite score against this run's concepts.

    Supply the score's definition as ONE of `sourceText` (pasted methods/component table) or `sourceRef`
    (URL, bare DOI, or GitHub repo). For a PDF, call `/composite/extract` first and pass back the text it
    returns — that way the extracted text is reviewable BEFORE any tokens are spent on it.

    `definition` re-derives from an ALREADY-transcribed definition (the `definition` object of a previous
    response), skipping the extraction call. `overrides` maps a component name to a concept id to pin it, or
    to null to drop it; with every component pinned the re-derive costs no LLM call at all.
    """

    sourceText: str | None = None
    sourceRef: str | None = None
    definition: dict[str, Any] | None = None
    overrides: dict[str, str | None] | None = None
    hybrid: bool = False


@app.post("/api/harmonize/jobs/{job_id}/composite/extract")
async def composite_extract(job_id: str, request: Request, file: Annotated[UploadFile, File()]) -> dict[str, Any]:
    """Extract text from an uploaded PDF or Word (.docx) document so the client can review it before
    deriving ($0, no LLM call).

    Separated from the derive route on purpose: a publisher PDF may be an access-check interstitial, or its
    component table may not survive extraction at all (PMC does exactly this), and finding that out should
    not cost a derivation. Word matters because a score's item table is usually in the SUPPLEMENT, and
    supplements are routinely .docx.
    """
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)):
        raise HTTPException(status_code=404, detail="Job not found")

    from backend.composite import resolve_source

    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Document too large (20 MB cap)")
    try:
        source = resolve_source(upload=data, filename=file.filename or "uploaded document")
    except (ValueError, ImportError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"text": source.text, "provenance": source.provenance, "sha256": source.sha256, "nChars": len(source.text)}


@app.post("/api/harmonize/jobs/{job_id}/composite")
def composite(
    job_id: str,
    body: CompositeBody,
    request: Request,
    x_anthropic_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Derive a composite/derived-variable spec for this run — can a published score be computed, and how?

    One opt-in BYOK pass over the run's OWN concepts (metadata only, like analysis-ideas): it transcribes the
    score from the supplied document, matches each component to a concept actually present, and returns the
    feasibility verdict + per-cohort coverage + the derivation recipe. Cached on the job (replacing any
    previous spec for the same score) so a re-view isn't re-billed.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    records = (job.result or {}).get("records") if job.result else None
    if not records:
        raise HTTPException(status_code=409, detail="This run has no harmonized concepts to build a score from.")

    from backend.artifact_kinds import COMPOSITE
    from backend.composite import derive, resolve_source
    from backend.engine.llm import build_llm_client
    from backend.llm_errors import llm_call

    # A re-derive from an existing definition needs no document; a first derivation does.
    source = None
    if body.definition is None:
        try:
            source = resolve_source(text=body.sourceText, ref=body.sourceRef)
        except (ValueError, ImportError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Same model/provider the run was configured with. BYOK: in-memory for this request only.
    model_tag = job.config.get("model_tag")
    client = build_llm_client(model_tag, x_anthropic_key)
    try:
        # llm_call: a rejected key / rate limit / overload is the provider's condition, not our crash.
        with llm_call(model=model_tag):
            spec = derive(
                records,
                source or _definition_from_payload(body.definition or {}),
                client.complete,
                overrides=body.overrides,
                hybrid=body.hybrid,
            )
    except ValueError as exc:
        # e.g. the document defines no score, or its text extraction came back empty — a 400, not a 500.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Durable home is the per-user artifact store, keyed by the score's name — so a re-derive REPLACES that
    # score for THIS user (what `composite.upsert` used to do by hand) and one user's derivation is never
    # visible to another on a shared run. A pinned run raises here rather than silently discarding the spec,
    # which is the bug this whole layer exists to fix.
    artifacts = store.artifacts
    if artifacts is not None:
        with _writable_run():
            artifacts.put(
                owner=principal_of(subject, job),
                job_id=job_id,
                kind=COMPOSITE,
                payload=spec,
                pinned=_is_pinned(job),
            )
    return spec


def _definition_from_payload(payload: dict[str, Any]) -> Any:
    """Rebuild a core ``ScoreDefinition`` from a previous response's `definition` object (the re-derive path).

    Kept minimal and delegating: the field mapping belongs to core's contract, so this only inverts what
    ``spec_to_dict`` emitted.
    """
    from ddharmon.harmonization.composite import (
        CodingKind,
        ComponentCoding,
        CompositeKind,
        ScoreComponent,
        ScoreDefinition,
    )

    def _enum(cls: Any, value: Any, fallback: Any) -> Any:
        """A client-supplied enum value, falling back rather than 500-ing on an unknown one."""
        try:
            return cls(str(value or "").strip().lower())
        except ValueError:
            return fallback

    components = []
    for c in payload.get("components") or []:
        coding = c.get("coding") or {}
        components.append(
            ScoreComponent(
                name=str(c.get("name", "")),
                definition=str(c.get("definition", "") or ""),
                required=bool(c.get("required", True)),
                weight=c.get("weight"),
                coding=ComponentCoding(
                    kind=_enum(CodingKind, coding.get("kind"), CodingKind.UNSTATED),
                    cutoff=str(coding.get("cutoff", "") or ""),
                    reference_range=str(coding.get("referenceRange", "") or ""),
                    code_map={str(k): str(v) for k, v in (coding.get("codeMap") or {}).items()},
                    formula=str(coding.get("formula", "") or ""),
                    units=str(coding.get("units", "") or ""),
                    stated_in_source=bool(coding.get("statedInSource", False)),
                ),
            )
        )
    if not components:
        raise HTTPException(status_code=400, detail="a re-derive needs the previous response's `definition`")
    return ScoreDefinition(
        name=str(payload.get("name", "") or "(unnamed composite)"),
        kind=_enum(CompositeKind, payload.get("kind"), CompositeKind.CUSTOM),
        components=components,
        citation=str(payload.get("citation", "") or ""),
        combination_rule=str(payload.get("combinationRule", "") or ""),
        threshold=str(payload.get("threshold", "") or ""),
        notes=str(payload.get("notes", "") or ""),
        stated_n_items=(int(n) if isinstance(n := payload.get("statedNItems"), (int, float)) and n > 0 else None),
    )


# --- human decisions -------------------------------------------------------------------------
class VerdictBody(BaseModel):
    recordId: str
    decision: str  # all axes: approve | refine | reject | clear (clear = un-set a prior verdict, toggle-off undo)
    note: str = ""
    axis: str = "match"  # match (concept→CDE) | transform (per source-variable recode) | gencde (proposed GenCDE)
    sourceVariable: str | None = None  # REQUIRED for axis="transform" — the "cohort:var" edge the verdict is on
    # axis="gencde" refine only: the reviewer's corrected GenCDE fields (camelCase UIGenCDE subset). Stored on
    # the decision and merged into the result blob's GenCDE, so edits flow to the workbench/export/regen.
    edited: dict[str, Any] | None = None


@app.post("/api/harmonize/jobs/{job_id}/verdict")
def submit_verdict(job_id: str, body: VerdictBody, request: Request) -> dict[str, bool]:
    if body.axis not in ("match", "transform", "gencde"):
        raise HTTPException(status_code=400, detail="axis must be match|transform|gencde")
    # All axes accept the full triad plus "clear" (un-set a prior verdict — the reviewer toggled it off).
    allowed = ("approve", "refine", "reject", "clear")
    if body.decision not in allowed:
        raise HTTPException(status_code=400, detail=f"decision must be {'|'.join(allowed)}")
    if body.axis == "transform" and not body.sourceVariable:
        raise HTTPException(status_code=400, detail="sourceVariable is required for the transform axis")
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)):
        raise HTTPException(status_code=404, detail="Job not found")
    with _writable_run():
        saved = store.set_decision(
            job_id,
            body.recordId,
            body.decision,
            body.note,
            axis=body.axis,
            source_variable=body.sourceVariable,
            edited=body.edited,
            subject=_subject(request),
        )
    if not saved:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


@app.post("/api/harmonize/jobs/{job_id}/records/{record_id}/regenerate-specs")
def regenerate_specs(
    job_id: str,
    record_id: str,
    request: Request,
    x_anthropic_key: Annotated[str | None, Header()] = None,
    x_provider_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Regenerate the member->GenCDE recodes for one record whose GenCDE was refined (its value domain changed).

    Reads the (already reviewer-corrected) GenCDE from the run's result blob, reloads the run's retained source
    dictionaries to recover each member's source value set, and re-runs the SAME core recode seams a full run
    uses — via a targeted one-off BYOK LLM pass — then writes the fresh transforms back onto the record.

    BYOK: the key rides the ``X-Provider-Key`` (or legacy ``X-Anthropic-Key``) header, is used to build the
    LLM client for THIS request only, and is NEVER written to ``run_config``, the job, the DB, os.environ, or
    any log — exactly like the analysis-ideas + batch paths.
    """
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)):
        raise HTTPException(status_code=404, detail="Job not found")
    records = (job.result or {}).get("records") if job.result else None
    rec_ui = next((r for r in (records or []) if r.get("id") == record_id), None)
    if rec_ui is None:
        raise HTTPException(status_code=404, detail="Record not found in this run")
    if not rec_ui.get("gencde"):
        raise HTTPException(status_code=409, detail="This record has no proposed GenCDE to regenerate recodes for")
    if not job.dict_specs:
        raise HTTPException(
            status_code=409, detail="This run predates recode regeneration (no retained source dictionaries)"
        )

    from backend.engine.adapter import regenerate_gencde_specs, specgen_stage_fn
    from backend.engine.llm import build_llm_client

    # Use the SAME model the run was configured with; the BYOK key is in-memory for this request only.
    effective_key = x_provider_key or x_anthropic_key
    client = build_llm_client(job.config.get("model_tag"), effective_key)
    stage_fn = specgen_stage_fn(client)
    try:
        updated = regenerate_gencde_specs(
            rec_ui, job.dict_specs, model_tag=job.config.get("model_tag"), stage_fn=stage_fn
        )
    except RuntimeError as exc:  # e.g. a core build lacking the GenCDE spec-gen seams
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    store.replace_result_record(job_id, record_id, cast("dict[str, Any]", updated))
    return {"record": updated}


# --- export ----------------------------------------------------------------------------------
# Export is built from the stable UIRecord contract (not from ddharmon) — one more place insulated from
# pipeline churn. eitl_tsv mirrors export_leanb_eitl_queue's intent (refine→novel→adopt first).
# The per-variable transform verdicts are serialized into a SINGLE trailing ``transformDecisions`` JSON
# column (a map keyed by sourceVariable -> {decision, note}); appending it LAST keeps the match columns and
# positions stable for index-based test assertions (e.g. eitl[4] == verdict, decisions[0] == recordId).
_EITL_COLS = [
    "recordId", "clusterId", "groupId", "concept", "verdict", "route", "cdeId", "cdeExternalId",
    "top1Cos", "chosenCos", "coverageGap", "floored", "crossCohort", "nMembers", "cohorts", "members",
    "nTransforms", "idealCde", "rationale", "humanDecision", "humanNote", "transformDecisions", "gencdeDecision",
]  # fmt: skip
_DECISIONS_COLS = [
    "recordId", "concept", "verdict", "cdeId", "chosenCos", "humanDecision", "humanNote", "transformDecisions",
    "gencdeDecision",
]  # fmt: skip
_EITL_RANK = {"refine": 0, "novel": 1, "adopt": 2}


def _transform_decisions_json(dec: dict[str, Any]) -> str:
    """Serialize a record's per-source-variable transform verdicts to a compact JSON map for export.

    Empty string when the record has no transform verdicts. ``_clean`` strips any tab/newline so the value
    stays on one TSV/CSV row (the JSON's own commas/quotes are handled by ``csv.writer`` quoting)."""
    transforms = dec.get("transforms")
    return _clean(json.dumps(transforms, sort_keys=True)) if transforms else ""


def _gencde_decision_json(dec: dict[str, Any]) -> str:
    """Serialize a record's GenCDE-axis verdict ({decision, note}) to a compact JSON object for export.

    Empty string when the record has no GenCDE verdict. Appended LAST (like ``transformDecisions``) so the
    match/transform column positions stay stable for index-based test assertions."""
    gencde = dec.get("gencde")
    return _clean(json.dumps(gencde, sort_keys=True)) if gencde else ""


@app.get("/api/harmonize/jobs/{job_id}/export")
def export(job_id: str, format: str = "eitl_tsv") -> Any:
    job = store.get(job_id)
    if job is None or job.result is None:
        raise HTTPException(status_code=404, detail="Job not found or not complete")
    records: list[dict[str, Any]] = job.result["records"]
    decisions = job.decisions

    if format in ("notebook_py", "notebook_r"):
        lang = "r" if format == "notebook_r" else "py"
        nb = build_notebook(job.result, lang, job.display_name)
        return JSONResponse(
            nb,
            media_type="application/x-ipynb+json",
            headers={"Content-Disposition": f'attachment; filename="harmonization_{job_id[:8]}.{lang}.ipynb"'},
        )

    if format == "records_json":
        return JSONResponse(
            records, headers={"Content-Disposition": f'attachment; filename="records_{job_id[:8]}.json"'}
        )

    if format == "decisions_csv":
        cols, rows, sep, ext = _DECISIONS_COLS, records, ",", "csv"
    else:
        format = "eitl_tsv"
        cols, sep, ext = _EITL_COLS, "\t", "tsv"
        rows = sorted(
            records,
            key=lambda r: (
                _EITL_RANK.get(r["verdict"], 3),
                r["cosines"]["top1"] if r["cosines"]["top1"] is not None else 0.0,
            ),
        )

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=sep)
    w.writerow(cols)
    for r in rows:
        dec = decisions.get(r["id"], {})
        cde = r["cde"] or {}
        if format == "decisions_csv":
            w.writerow(
                [
                    r["id"],
                    _clean(r["concept"]),
                    r["verdict"],
                    cde.get("id", ""),
                    _fmt(r["cosines"]["chosen"]),
                    dec.get("decision", ""),
                    _clean(dec.get("note", "")),
                    _transform_decisions_json(dec),
                    _gencde_decision_json(dec),
                ]
            )
        else:
            w.writerow(
                [
                    r["id"],
                    r["clusterId"],
                    r["groupId"],
                    _clean(r["concept"]),
                    r["verdict"],
                    r["route"],
                    cde.get("id", ""),
                    cde.get("externalId", ""),
                    _fmt(r["cosines"]["top1"]),
                    _fmt(r["cosines"]["chosen"]),
                    r["coverageGap"],
                    r["floored"],
                    r["crossCohort"],
                    r["nMembers"],
                    ";".join(r["cohorts"]),
                    _clean(";".join(r["members"])),
                    len(r["transforms"]),
                    _clean(r["idealCde"]),
                    _clean(r["rationale"]),
                    dec.get("decision", ""),
                    _clean(dec.get("note", "")),
                    _transform_decisions_json(dec),
                    _gencde_decision_json(dec),
                ]
            )
    media = "text/csv" if ext == "csv" else "text/tab-separated-values"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{format}_{job_id[:8]}.{ext}"'},
    )


# --- demos (precomputed) ---------------------------------------------------------------------
@app.get("/api/harmonize/demos")
def demos() -> dict[str, Any]:
    """List the curated demo datasets and which combinations have a precomputed snapshot."""
    return list_demos()


class DemoBody(BaseModel):
    datasets: list[str]


# Phases a real run streams, in order — the demo replay paces through these so it looks like a live run.
_DEMO_PHASES = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "gencde", "specs"]


def _replay_demo(job_id: str, snapshot: dict[str, Any]) -> None:
    """Pace a precomputed demo through the pipeline phases so 'Load demo' feels like a live run.

    Reuses the ordinary JobStore + SSE path: we only advance status/phase/completed over a short window
    (weighted by the REAL per-phase wall-clock captured at build time), then deliver the finished result.
    No pipeline, no LLM, no key. ``DDHARMON_DEMO_REPLAY_SECS`` controls total duration (0 → instant, for tests).
    """
    import time

    result = snapshot.get("result", snapshot)
    timings = snapshot.get("phaseTimings", {}) or {}
    total_target = float(os.environ.get("DDHARMON_DEMO_REPLAY_SECS", "16"))
    weights = [max(0.05, float(timings.get(p, 1.0))) for p in _DEMO_PHASES]
    scale = (total_target / sum(weights)) if sum(weights) else 0.0
    prompts = result.get("prompts", {}) or {}
    counts = {
        "generating": prompts.get("ideal", 0),
        "splitting": prompts.get("split", 0),
        "assigning": prompts.get("groupAssign", 0),
        "gencde": prompts.get("gencde", 0),
        "specs": prompts.get("specgen", 0),
    }
    records = result.get("records", []) or []
    n_records = len(records)
    total_w = sum(weights) or 1.0
    # records ramp in only once the record-producing phases begin (after loading+embedding+clustering).
    gen_start_frac = (sum(weights[:3]) / total_w) if len(weights) >= 3 else 0.0
    try:
        elapsed_w = 0.0
        for phase, weight in zip(_DEMO_PHASES, weights, strict=True):
            total = int(counts.get(phase, 0) or 0)
            ticks = 5 if total else 2
            for k in range(1, ticks + 1):
                if store.is_cancel_requested(job_id):  # Stop pressed mid-replay -> end it as cancelled
                    store.update(job_id, status="cancelled", phase="cancelled")
                    return
                done = int(total * k / ticks) if total else 0
                frac = (elapsed_w + weight * k / ticks) / total_w
                reveal = 0.0 if frac <= gen_start_frac else (frac - gen_start_frac) / (1 - gen_start_frac)
                nk = min(n_records, round(n_records * reveal))
                fields: dict[str, Any] = {"status": phase, "phase": phase, "completed": done, "total": total}
                # progressively reveal records so the metric cards + charts build up live during the replay
                # (atlas withheld until completion — it's static field space and keeps each tick light).
                if nk > 0:
                    fields["result"] = {**result, "records": records[:nk], "atlas": []}
                store.update(job_id, **fields)
                if scale:
                    time.sleep(weight * scale / ticks)
            elapsed_w += weight
        store.update(job_id, status="complete", phase="complete", result=result)
    except Exception as exc:  # noqa: BLE001 — a replay glitch must not kill the worker thread silently
        store.update(job_id, status="error", phase="error", error_message=str(exc))


@app.post("/api/harmonize/demo")
def start_demo(body: DemoBody) -> dict[str, str]:
    """Replay a precomputed demo as a live-paced job — no pipeline run, no API credits.

    The snapshot was produced offline by the SAME production pipeline (``scripts/build_demos.py``); here we
    stream it back through the phases so the job view shows a live-feeling run. A stable per-combo job id keeps
    the Runs page to a single demo entry (re-loading replays it in place). The job is tagged ``demo: true``.
    """
    snap = load_snapshot(body.datasets)
    if snap is None:
        raise HTTPException(
            status_code=404,
            detail=f"No precomputed demo for {sorted(body.datasets)}. See GET /api/harmonize/demos.",
        )
    result = snap.get("result", snap)
    job_id = demo_job_id(body.datasets)
    display = snap.get("displayName") or "Demo run"
    store.delete(job_id)  # reset any prior replay of this same demo (idempotent → one Runs entry)
    store.create(job_id, display, {"demo": True, "datasets": sorted(body.datasets), "mode": result.get("mode")})
    threading.Thread(target=_replay_demo, args=(job_id, snap), daemon=True).start()
    return {"jobId": job_id}


# --- health ----------------------------------------------------------------------------------
def _core_version() -> str:
    """Installed ``ddharmon`` core version. On the dev channel this pins to a git ref, so surfacing it
    (with ``channel``) makes it observable which core the running server is actually on."""
    try:
        from importlib.metadata import version

        return version("ddharmon")
    except Exception:
        return "unknown"


@app.get("/api/health")
def health() -> dict[str, Any]:
    """Liveness/readiness probe: process is up, plus which optional server-side assets are present.

    Used by the deploy runbook (systemd/nginx verification) and any future uptime check. Returns
    200 as soon as the app imports; ``cde``/``frontendBuilt`` flag whether the catalog TSVs and the
    built SPA are in place (a run with ``cdeSet != none`` needs the matching CDE file). ``channel``
    (``prod`` default / ``dev``) and ``coreVersion`` distinguish the dev deployment — which pins the
    core to an unreleased GitHub ref — from prod, which tracks the PyPI release.
    """
    return {
        "status": "ok",
        "version": app.version,
        "contractVersion": CONTRACT_VERSION,
        "channel": os.environ.get("DDHARMON_CHANNEL", "prod"),
        "coreVersion": _core_version(),
        "cde": {name: path.exists() for name, path in CDE_FILES.items()},
        "frontendBuilt": _DIST.exists(),
    }


# --- static frontend (prod) ------------------------------------------------------------------
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.exists():
    from starlette.exceptions import HTTPException as StarletteHTTPException
    from starlette.responses import FileResponse
    from starlette.staticfiles import StaticFiles

    class _SPAStaticFiles(StaticFiles):
        """Serve the built SPA with an HTML5-history fallback: an unknown, extension-less path (a
        client-side route like ``/methods`` or ``/job/<id>``) falls back to ``index.html`` so a hard
        refresh / bookmark / shared deep link loads the app instead of 404ing. Real missing assets (a path
        whose last segment has an extension, e.g. ``/x.js``) still 404. ``/api/*`` never reaches here — those
        routes are registered before this mount, so they take precedence."""

        async def get_response(self, path: str, scope: Any) -> Any:
            try:
                return await super().get_response(path, scope)
            except StarletteHTTPException as exc:
                if exc.status_code == 404 and "." not in path.rsplit("/", 1)[-1]:
                    return FileResponse(_DIST / "index.html")
                raise

    app.mount("/", _SPAStaticFiles(directory=str(_DIST), html=True), name="frontend")
