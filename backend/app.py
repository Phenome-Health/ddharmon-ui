"""FastAPI app for the ddharmon harmonization GUI.

Endpoints (all under /api/harmonize):
    POST /detect            columns -> suggested column->role map (SchemaRegistry)
    POST /batch             multipart upload of dict files + config -> {jobId}
    GET  /stream/{job_id}   SSE progress (event: progress)
    GET  /result/{job_id}   full job snapshot (REST fallback)
    GET  /jobs              list jobs (summaries)
    DELETE /jobs/{job_id}   delete a job
    POST /jobs/{job_id}/cancel    request a stop for an in-flight run (-> cancelled)
    POST /jobs/{job_id}/switch-to-sync  stop waiting on the in-flight batch; finish the stage sync (08-28 0e)
    GET  /jobs/{job_id}/uploads/{filename}  a run's retained upload, for its owner (prefilled re-run)
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
import sys
import threading
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager, suppress
from copy import deepcopy
from pathlib import Path
from typing import Annotated, Any, cast

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

import backend.artifact_kinds  # noqa: F401 — importing registers the artifact kinds
from backend import batch_reconcile, billing, cde_cache, export_decisions
from backend.artifact_kinds import (
    ACCEPTED_GENCDE,
    GATE1_GROUP_SCOPE,
    GATE1_NEW_GROUP,
    GATE1_REGROUP,
    GATE2_CANDIDATE_PICK,
    GATE_DECISION_KINDS,
    REVIEWER_GROUP_PREFIX,
    UNASSIGNED_GROUP_ID,
    VERDICT,
    accept_gencde,
    derive_staleness,
    option_set_key,
    reviewer_group_name,
)
from backend.artifacts import UPDATED_AT, ArtifactError, ReadOnlyRunError, UnknownArtifactKindError, registry
from backend.auth import AuthError, authenticate
from backend.checkpoint import (
    GATE_ORDER,
    Checkpoint,
    CheckpointMissingError,
    checkpoint_lock,
    checkpoint_path,
    load_checkpoint,
    next_gate,
    write_checkpoint,
)
from backend.db import JobDB
from backend.demos import demo_job_id, list_demos, load_snapshot, seed_demos
from backend.engine import CONTRACT_VERSION
from backend.engine.adapter import cost_block, load_spec
from backend.jobs import (
    _PINNED_CONFIG_KEYS,
    AWAITING_REVIEW,
    DECIDED_BY_AUTO,
    GATE_DECIDED_BY_CONFIG_KEY,
    GUIDED_REVIEW,
    REVIEW_MODE_CONFIG_KEY,
    REVIEW_MODES,
    TERMINAL_STATES,
    Job,
    _is_pinned,
    auto_accepted,
    is_auto,
    principal_of,
    store,
)
from backend.llm_errors import CodedHTTPException, coded_http_error, key_required
from backend.notebook import build_notebook
from backend.role_requirement import role_requirement_error, zero_variable_error
from backend.runner import _relative_ref, run_harmonization

logger = logging.getLogger(__name__)

# A single dictionary field can exceed Python's default csv.field_size_limit (128 KB): UKBB carries a long
# notes / value-encoding blob that does, which aborted the stdlib csv read of an upload with "field larger
# than field limit (131072)". Lift the limit process-wide so any csv.reader here or in the loader reads it.
# Portable: sys.maxsize overflows csv's C long on 32-bit builds, so step down until it is accepted.
_csv_limit = sys.maxsize
while True:
    try:
        csv.field_size_limit(_csv_limit)
        break
    except OverflowError:
        _csv_limit //= 10

# --- CDE catalog (server-side; not uploaded) -------------------------------------------------
# Repo root is the parent of backend/ (this file is backend/app.py). The CDE catalog is NOT
# shipped in this repo (data/cde/ is gitignored) — supply it on the server and/or point
# DDHARMON_CDE_DIR at it. The pipeline REQUIRES a catalog (cdeSet must be endorsed|full).
_REPO_ROOT = Path(__file__).resolve().parents[1]
_CDE_DIR = Path(os.environ.get("DDHARMON_CDE_DIR", _REPO_ROOT / "data" / "cde"))
CDE_FILES = {"endorsed": _CDE_DIR / "nih_endorsed_flat.tsv", "full": _CDE_DIR / "all_cdes_flat.tsv"}
CDE_SET_LABELS = {"endorsed": "NIH-endorsed", "full": "full NIH CDE Repository"}
# The catalog a NEW run matches against when its create payload names none (08-28 Decision 7): the full
# catalog. The endorsed one (177 elements) has no body weight, PHQ or PROMIS, so those common measures came out
# "novel" although the full catalog has a good element for each — and every benchmark and the validation run
# used `full`. `endorsed` stays selectable.
DEFAULT_CDE_SET = "full"
# The catalog a STORED run is read back as when its config has no `cde_set` — deliberately NOT the creation
# default above, so moving that default can never switch a run's catalog mid-run. In practice no run reaching a
# read-back lacks the key: every leg that reads it first requires retained `dict_specs` (added 2026-07-10), and
# every run carrying those was created by `start_batch` — which has recorded `cde_set` since 2026-07-01 — or
# copied from one by `/rerun`. If one ever did lack it, it was created while the default was `endorsed`, so that
# is what it ran with.
RECORDED_CDE_SET_FALLBACK = "endorsed"


def _recorded_cde_set(config: dict[str, Any]) -> str:
    """The catalog a stored run recorded at creation — never the current creation default (see above)."""
    return str(config.get("cde_set", RECORDED_CDE_SET_FALLBACK))


def _catalog_path_or_refuse(cde_set: str, *, starting: bool) -> Path:
    """The catalog file for ``cde_set``, or a refusal that names the missing FILE and the setting that fixes it.

    Never a fallback to the other catalog: matching against a different catalog than the one a run asked for
    (or recorded) changes what every variable can map to. A NEW run (``starting``) is refused 400 before
    anything is created, and is told which catalog it could choose instead; a stored run's leg is refused 409
    and stays exactly where it is.
    """
    if cde_set not in CDE_FILES:
        if starting:
            raise HTTPException(
                status_code=400,
                detail=f"cdeSet must be one of {sorted(CDE_FILES)} — harmonization requires a CDE catalog",
            )
        raise HTTPException(status_code=409, detail=f"CDE catalog {cde_set!r} is unavailable on the server")
    path = CDE_FILES[cde_set]
    if path.exists():
        return path
    logger.warning("CDE catalog %r unavailable: %s does not exist", cde_set, path)
    missing = (
        f"CDE catalog {cde_set!r} is unavailable on the server: {path.name} is missing. Set DDHARMON_CDE_DIR to "
        f"the directory that holds {path.name}."
    )
    if not starting:
        raise HTTPException(
            status_code=409,
            detail=f"{missing} This run keeps the catalog it was started with; nothing was changed or charged.",
        )
    others = [CDE_SET_LABELS.get(k, k) for k, p in CDE_FILES.items() if k != cde_set and p.exists()]
    alternative = f" Or choose the {others[0]} catalog for this run instead." if others else ""
    raise HTTPException(status_code=400, detail=f"{missing} Nothing was created or charged.{alternative}")


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


def cde_spec_for(path: Path | str) -> dict[str, Any]:
    """The loader spec a run reads the CDE catalog at ``path`` with — the ONE place it is spelled out.

    Every leg that embeds the catalog builds its spec here, and so does ``scripts/warm_cde_cache.py``: the warm
    fills the embedding cache with the catalog's vectors ahead of the first run, which only helps if it loads the
    catalog with exactly the roles and cohort name a run does (they decide the text that is hashed into the key).
    """
    return {"path": str(path), "cohort_name": CDE_COHORT, "column_roles": dict(CDE_COLUMN_ROLES)}


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
# A missing (or rejected) provider key is refused with a stable `code` beside its human `detail`, so the gate
# screens reveal their key field on the code rather than on the English sentence (08-28, BYOK key on Continue).
app.add_exception_handler(CodedHTTPException, coded_http_error)

# CORS: the built SPA is served same-origin by this app in prod, so CORS matters only for the Vite dev
# proxy and any deliberate cross-origin caller. Lock the allowed origins via DDHARMON_UI_ALLOWED_ORIGINS
# (comma-separated) in prod, e.g. "https://ddharmon.io"; default to the localhost dev origins.
_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("DDHARMON_UI_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]
#: The counts that travel BESIDE the file rather than inside it. A CSV has one appended column by design,
#: so the load-time findings — how many rows the loader collapsed, how many variables embed nothing — ride
#: as response headers, where the screen can read them without the reviewer having to.
_EXPORT_COUNT_HEADERS = (
    "X-Ddharmon-Rows",
    "X-Ddharmon-Variables",
    "X-Ddharmon-Collapsed",
    "X-Ddharmon-Nothing-To-Embed",
    "X-Ddharmon-Repeated-Names",
    "X-Ddharmon-Sheets",
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    # RESPONSE headers are not readable cross-origin unless they are named, and `allow_headers` is
    # about the REQUEST. The embedding export's load-time counts (rows collapsed, variables embedding
    # nothing) ride as response headers, so the screen that reports them needs them exposed.
    expose_headers=list(_EXPORT_COUNT_HEADERS),
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
_JOBS_PREFIX = "/api/harmonize/jobs/"
# Sub-resources under a job that a guest walking the six gates must READ, enumerated rather than opened by
# prefix. The whole set a guest needs is: `/result/` (the records every gate renders), `/checkpoint/` (which
# gate the run is parked at), `/stream/` (a live demo replay) and `artifacts` (the gate decisions plus the
# derived staleness Gate N+1 shows). A path a gate screen needs that is NOT here breaks R9 AT that gate; a
# path added here without cause is a new unauthenticated surface. Nothing else under `/jobs/` is public, and
# only GET is ever considered — the WRITE half of `artifacts` stays gated, and is refused a second time
# behind that by the pinned-run check.
#
# `export` is deliberately NOT here. Gate 4 renders the export SET, which is the records plus the decisions,
# and both already arrive on `/result/` and `artifacts`. The export route now resolves the caller and checks
# visibility like its siblings (08-27: it folds in that caller's gate decisions), but the unauthenticated
# surface stays minimal regardless — downloading the artifact is the single Gate 4 action a guest signs in for.
_DEMO_SCOPED_JOB_READS = ("artifacts",)


def _is_demo_job(job_id: str) -> bool:
    job = store.get(job_id)
    return bool(job and job.config.get("demo"))


def _is_public_path(path: str, method: str = "GET") -> bool:
    if path in _PUBLIC_EXACT:
        return True
    for prefix in _DEMO_SCOPED_PREFIXES:
        if path.startswith(prefix):
            return _is_demo_job(path[len(prefix) :].split("/", 1)[0])
    if method == "GET" and path.startswith(_JOBS_PREFIX):
        rest = path[len(_JOBS_PREFIX) :].split("/")
        if len(rest) == 2 and rest[1] in _DEMO_SCOPED_JOB_READS:
            return _is_demo_job(rest[0])
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
    if request.method != "OPTIONS" and path.startswith("/api/harmonize/") and not _is_public_path(path, request.method):
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


#: Header names that identify a PARTICIPANT rather than a variable. Matched on a normalized header, and
#: only ever consulted alongside per-row uniqueness — the word alone is not evidence, because a data
#: dictionary legitimately DESCRIBES a participant identifier (a row whose variable name is
#: ``participant_id``), and refusing those would reject the very files this product exists to harmonize.
_PARTICIPANT_ID_HEADERS = frozenset(
    {
        "eid",
        "usubjid",
        "subjid",
        "person_id",
        "patient_id",
        "sample_id",
        "subject_id",
        "record_id",
        "participant_id",
        "respondent_id",
    }
)


def _normalized_header(name: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in str(name).strip().lower()).strip("_")


def _participant_level_column(path: Path, sample: int = 40) -> str | None:
    """The column that makes this file look like participant records, or None.

    A data dictionary is one row per VARIABLE; participant-level data is one row per PERSON. Two conditions
    must BOTH hold before a file is refused, because either alone has a real false positive:

    1. a column whose header names a participant identifier, and
    2. that column's values are unique across the sampled rows.

    Condition 1 alone would reject a dictionary that DESCRIBES a participant id - a row whose variable name
    is ``participant_id`` - which is most real dictionaries. Condition 2 alone would reject every dictionary,
    since a variable-name column is unique by construction.

    The uploader's own column mapping is deliberately NOT trusted as an exemption: someone uploading
    participant rows by mistake maps the identifier column as the variable name, because that is what the
    naive mapping does, so exempting declared columns would open the hole exactly where the mistake lives.
    Bare ``id`` is excluded from the header set for the reverse reason - it is the one name a dictionary
    plausibly uses for its own key.

    Only delimited text is inspected. A spreadsheet is not parsed here — stating that limit is better than a
    check that silently covers less than it appears to (the honest gap: an .xlsx of participant rows, and a
    participant-level file carrying no identifier column at all, are not caught by shape alone).
    """
    if path.suffix.lower() not in (".csv", ".tsv", ".txt"):
        return None
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    try:
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as fh:
            reader = csv.reader(fh, delimiter=delimiter)
            header = next(reader, None)
            if not header:
                return None
            suspect = {i: name for i, name in enumerate(header) if _normalized_header(name) in _PARTICIPANT_ID_HEADERS}
            if not suspect:
                return None
            seen: dict[int, list[str]] = {i: [] for i in suspect}
            rows = 0
            for row in reader:
                rows += 1
                for i in suspect:
                    seen[i].append(row[i].strip() if i < len(row) else "")
                if rows >= sample:
                    break
    except OSError:
        return None
    if rows < 2:
        return None
    for i, name in suspect.items():
        values = [v for v in seen[i] if v]
        if len(values) == rows and len(set(values)) == rows:
            return name
    return None


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
       runMode: batch|sync|preview, reviewMode?: guided|auto, minClusterSize: int, genTransformSpecs?: bool,
       topK?: int, retrievalFloor?: float, modelTag?: str, displayName?}``

    ``reviewMode`` (08-30) defaults to ``guided``: every gate waits for the reviewer's Continue. ``auto`` is Full
    auto — each gate is committed with the pipeline's own proposals (Gate 1: every group in scope) and the next leg
    starts by itself, until the run parks at Gate 4. Independent of ``runMode``.

    The pipeline requires a CDE catalog (assignment to the given backbone is the thesis) — ``cdeSet`` must be
    ``endorsed`` or ``full``, and defaults to ``full`` (:data:`DEFAULT_CDE_SET`). ``runMode`` defaults to
    ``batch`` (the deployed default).

    BYOK: the ``X-Anthropic-Key`` header (frontend ``x-anthropic-key``) carries a per-request Anthropic
    key. It is threaded to the pipeline as an in-memory arg for this job only — deliberately NOT written
    into ``run_config`` (which ``store.create`` persists) or any log, so it never touches disk.
    """
    from backend.engine.adapter import PREPARE_BEFORE_EMBED_DEFAULT

    cfg = json.loads(config)
    # BYOK: prefer the provider-agnostic header; fall back to the legacy Anthropic-specific one. Held in memory
    # for this job only (thread kwarg below) — never written to run_config (persisted) or any log.
    effective_key = x_provider_key or x_anthropic_key
    # The review mode is checked at the door with the other refusals that cost nothing: an unknown mode is a
    # caller error, and guessing one would either spend without review or stop where the caller asked not to.
    review_mode = cfg.get("reviewMode", GUIDED_REVIEW)
    if review_mode not in REVIEW_MODES:
        raise HTTPException(status_code=400, detail=f"reviewMode must be one of {'|'.join(REVIEW_MODES)}")
    # Pre-flight the provider key AT THE DOOR, like Continue does (08-28 1a, live verify 3 F8). A run started
    # without one used to be accepted, uploaded and embedded, and then errored in its first paid stage. Refused
    # here, before anything is created: no run row, no work dir, nothing embedded, nothing charged. A preview
    # makes no model call and is exempt; a non-Anthropic model does not use this key.
    if _resume_needs_a_key({"run_mode": cfg.get("runMode", "batch"), "model_tag": cfg.get("modelTag")}, effective_key):
        raise key_required(
            "Enter your Anthropic API key to start this run — its first step is a paid model call and the "
            "key clears on reload. Nothing was created or charged; re-enter the key and press Start again."
        )
    # The pipeline REQUIRES a CDE backbone (assignment to the given catalog is the thesis) — no cdeSet=none path.
    # A run that names none gets the full catalog (DEFAULT_CDE_SET, 08-28 Decision 7). Checked at the door like
    # the key, before anything is created: a server missing the requested file refuses by name, never by quietly
    # matching against the other catalog.
    cde_set = cfg.get("cdeSet", DEFAULT_CDE_SET)
    cde_path = _catalog_path_or_refuse(cde_set, starting=True)
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
        # Core's requirement, from the one place it is written down (`backend/role_requirement.py`, pinned to
        # core's loader and to the frontend's copy). It used to be a hand copy here that took question_text
        # alone, which core loads as ZERO variables — the cohort was then dropped mid-run and the rest billed.
        role_error = role_requirement_error(fname, roles)
        if role_error is not None:
            raise HTTPException(status_code=400, detail=role_error)
        # Refused BEFORE anything is harmonized, embedded or sent anywhere: this is a standing product
        # prohibition (we accept metadata, never participant-level data), so the check belongs at the door.
        offender = _participant_level_column(saved[fname])
        if offender is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{fname!r} looks like participant-level data: the column {offender!r} holds a unique "
                    "value on every row. Upload a data DICTIONARY — one row per variable, describing the "
                    "fields — not the participant records themselves. ddharmon harmonizes metadata and "
                    "never accepts participant data."
                ),
            )
        # The OUTCOME, not just the rule: core's own loader, run on the upload (local, free). A mapping that
        # meets the rule can still load nothing — its text column empty on every row — and a cohort that
        # loads nothing is refused here, by name, rather than silently missing from a run that bills.
        empty_error = zero_variable_error(fname, saved[fname], str(d["cohortName"]), roles)
        if empty_error is not None:
            raise HTTPException(status_code=400, detail=empty_error)
        dict_specs.append({"path": str(saved[fname]), "cohort_name": d["cohortName"], "column_roles": roles})

    cde_spec = cde_spec_for(cde_path)

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
        # STGD-16's two switches, recorded at CREATION and never flipped afterwards: a run resumed with a
        # different answer would stop matching the cost it was quoted (T-08-69). `concept_gate` is the M7
        # advisory stage — opt-in, default off, so a run only pays for a stage it asked for.
        "concept_gate": bool(cfg.get("conceptGate", False)),
        # `readjudication` is permission for the re-adjudication endpoint to spend on a re-split the reviewer
        # names at Gate 1. ALWAYS ON for a new run (final review round 1): no run ever buys a re-split by
        # itself — the reviewer buys one group at a time by pressing a priced "Accept this division", so a
        # blind opt-in at Setup only made that informed decision unreachable. Setup's quote carries it as a
        # per-use line. The create payload's `allowReadjudication` is no longer read. A run created before this
        # recorded its own answer and keeps it (`/readjudicate` still refuses one that recorded off).
        "readjudication": True,
        # 08-14e: whether this run prepares its dictionaries before embedding, recorded so every later leg and a
        # re-run embed the text the first leg embedded even if the product default moves again (`run_prepares`).
        "preprocess": PREPARE_BEFORE_EMBED_DEFAULT,
    }
    # Recorded only when it is not the default, so a guided run's config is byte-for-byte what it always was (an
    # absent key reads as guided — see backend/jobs.py `review_mode_of`).
    if review_mode != GUIDED_REVIEW:
        run_config[REVIEW_MODE_CONFIG_KEY] = review_mode
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
    display = cfg.get("displayName") or f"Run {job_id[:8]}"
    # Own the run (verified Clerk subject) and persist dict_specs so it can be re-run from its retained
    # uploads. dict_specs paths point into this job's work_dir/uploads, which now survives until delete.
    store.create(job_id, display, run_config, owner_subject=_subject(request), dict_specs=dict_specs)
    # api_key rides as a thread kwarg (in-memory, this job only) — never in run_config, which is persisted. A
    # Full-auto leg is also handed the continue function, which carries that same in-memory key to the next leg.
    threading.Thread(
        target=run_harmonization,
        args=(store, job_id, dict_specs, cde_spec, {**run_config, "stop_at_gate": ENTRY_GATE}),
        kwargs={"api_key": effective_key, **_auto_kwargs(run_config)},
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
            # Except a Full-auto park the server is about to continue (08-30): that run is moving, and the
            # next frames are the next leg's.
            if job.status == AWAITING_REVIEW and not job.auto_advance:
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


def _note_reconcile_failures(job_id: str, outcome: Any) -> None:
    """Surface a DECIDING-stage reconcile failure on the run, so a reviewer is told the partition is
    incomplete and can retry — instead of the gate reading as clean and complete (the silent-partial-failure
    half of the identity-drift finding). ADVISORY-stage failures (coherence / distinct_kinds / concept_gate)
    are allowed to fail silently by design and are ignored.

    The advisory/deciding line is READ from the existing maps, never hand-kept: a reconcile ``tag`` is
    advisory iff ``TAG_TO_STAGE[tag]`` names one of the adapter's ``_JUDGE_STAGES``.

    Records the failure via ``error_message`` WITHOUT changing status: the checkpoint-backed result stays
    served and the run stays resumable, so "retry" is the same paid Continue, now informed. (The UI retry
    affordance — and clearing this note on a successful retry — is 08-23b.)
    """
    from backend.batch_reconcile import TAG_TO_STAGE
    from backend.engine.adapter import _JUDGE_STAGES, REQUIRED_STEP_RETRY

    steps: set[str] = set()
    for tag in getattr(outcome, "failed", ()) or ():
        if TAG_TO_STAGE.get(tag) not in _JUDGE_STAGES:  # a deciding stage, or an unknown tag — surface either
            steps.add(str(TAG_TO_STAGE.get(tag, tag)))
    if not steps:
        return
    store.update(
        job_id,
        error_message=f"A required step ({', '.join(sorted(steps))}) failed on the last continue — "
        + REQUIRED_STEP_RETRY,
    )


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
        outcome = batch_reconcile.reconcile_run(job.job_id, store=store, api_key=api_key)
        _note_reconcile_failures(job.job_id, outcome)
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
        # 08-28: how many prompts this gate's state was asked and never heard back on (the result's
        # `unanswered` register, summed) — the one number a reviewer needs before trusting "clean". 0 on a
        # complete gate and on a checkpoint written before the register existed.
        "unansweredPrompts": _unanswered_prompts(ckpt.result if ckpt is not None else None),
        "result": ckpt.result if ckpt is not None else None,
    }


def _unanswered_prompts(result: Any) -> int:
    """The total of a result's ``unanswered`` register; 0 when it has none (or is not a result at all)."""
    gaps = result.get("unanswered") if isinstance(result, dict) else None
    if not isinstance(gaps, list):
        return 0
    return sum(int(g.get("unanswered") or 0) for g in gaps if isinstance(g, dict))


#: The boundary a FRESH run stops at. Gate 1 since 08-14f; ``gate0`` before it.
#:
#: WHY IT MOVED. ``gate0`` existed to give a run a FREE pause after load → preprocess → embed, so a
#: reviewer could inspect their dictionaries before committing money. That pause is now unnecessary and
#: was actively in the way: the inspection it enabled is served better, and EARLIER, by the job-less
#: ``/dictionary/embedding.csv`` — which needs no run at all, so the reviewer sees the exact clustering
#: input while they are still mapping columns rather than after starting something. Keeping the stop as
#: well meant Start bought nothing, parked the run on an intermediate screen, and asked for a SECOND press
#: to actually begin. One press, one charge, straight to Gate 1.
#:
#: THE BOUNDARY ITSELF IS NOT REMOVED, and that is deliberate (08-DECISION-GATE0 D-3).
#: ``_GATE_STOP_MECHANISM["gate0"]`` and ``build_gate0_result()`` stay, the position stays a legal wire
#: value, and its route still redirects to Setup. Six runs are parked at that position right now; ripping
#: the value out would strand them behind a 404. Nothing new enters it — that is the whole change.
#:
#: It is passed to the worker and NOT written into the run's stored config, deliberately. `run_config`
#: records what the user asked for and is replayed verbatim by re-run; the boundary is a property of the
#: LEG, recomputed from the run's gate position every time :func:`resume_run` spawns the next one. Storing
#: it would give the same question two answers, and the stale one would be the sticky one.
ENTRY_GATE = "gate1"


def _no_anthropic_key(config: dict[str, Any], key: str | None) -> bool:
    """No Anthropic key is available for a paid call: the run's model routes to Anthropic and NEITHER the
    request key (BYOK header) NOR the server's ``ANTHROPIC_API_KEY`` env is set (``api_key=None`` falls back
    to the env). A non-Anthropic (proxy) model does not use this key, so it is never blocked here. Callers
    that only spend under certain modes layer that check on top (see :func:`_resume_needs_a_key`)."""
    from backend.engine.llm import is_anthropic_model

    return is_anthropic_model(config.get("model_tag")) and not (key or os.environ.get("ANTHROPIC_API_KEY"))


def _resume_needs_a_key(config: dict[str, Any], header_key: str | None) -> bool:
    """Whether resuming (or starting, or re-running) this run would make a paid Anthropic call with no key.

    A batch/sync resume calls the provider; a preview run makes no LLM call and is exempt. :func:`resume_run`
    refuses BEFORE it commits the gate and spawns the worker, so a missing key is a clear "enter your key" at
    the door rather than an error deep in the paid stage that errors the whole run and wipes the gate state.
    """
    if config.get("run_mode") == "preview":
        return False
    return _no_anthropic_key(config, header_key)


def _gate1_assign_scope(job: Job, subject: str | None, groups: list[dict[str, Any]]) -> list[str] | None:
    """The group ids the reviewer KEPT in scope at Gate 1 — what the paid assign should process — or None.

    Default-in: a group is in scope unless a ``gate1_group_scope`` decision marks it ``out`` (the same rule
    the Gate-2 display filter applies, so the two never disagree). ``None`` means the reviewer scoped nothing
    out, so the assign processes EVERY group exactly as before scope was honoured — an un-scoped run threads
    no filter and keeps the pre-scope cost. Otherwise the kept subset (possibly empty, if everything was
    scoped out): the assign then pays for only those groups, which is what makes the Gate-2 cost match the
    quote Gate 1 showed. ``groups`` is the current gate's ``conceptGroups`` (the frozen partition the resume
    replays), so a scope decision keyed on a group id that this leg no longer has simply matches nothing.
    """
    # 08-27: the scope FROZEN at Gate 1's Continue wins. Gate 1 displays default-OUT (08-23b) while the rule
    # below is default-in, so recomputing from decisions billed groups the reviewer was shown as unchecked.
    # 08-28 Wave 2: the reviewer's New groups are groups too. They are never in a checkpoint's conceptGroups (the
    # split's view — a New group is a RECORD from Gate 2 on), so they come from the frozen regrouping.
    universe = [str(g["groupId"]) for g in groups if g.get("groupId")] + _new_group_ids(job)
    frozen = (getattr(job, "config", None) or {}).get(GATE1_SCOPE_CONFIG_KEY)
    if frozen is not None:
        keep = set(frozen)
        return [gid for gid in universe if gid in keep]
    # Legacy (a run that passed Gate 1 before 08-27): default-in, unchanged.
    scope = (store.artifacts_for(job, subject) or {}).get(GATE1_GROUP_SCOPE) or []
    out_ids = {d.get("groupId") for d in scope if d.get("chosen") == "out"}
    if not out_ids:
        return None
    return [gid for gid in universe if gid not in out_ids]


def _new_group_ids(job: Job) -> list[str]:
    """The New groups Gate 1's Continue froze into this run's regrouping, in frozen order."""
    frozen = (getattr(job, "config", None) or {}).get(GATE1_OVERRIDES_CONFIG_KEY) or {}
    return [str(g.get("groupId")) for g in frozen.get("newGroups") or [] if isinstance(g, dict) and g.get("groupId")]


def _current_group(member: str, origin: dict[str, str], recorded: Any) -> str | None:
    """Where a variable is before a move: the checkpoint's membership when it carries one, else the origin the move
    itself recorded (``None`` = in no group)."""
    if origin:
        return origin.get(member)
    return None if recorded in (None, "", UNASSIGNED_GROUP_ID) else str(recorded)


def _gate1_overrides(job: Job, subject: str | None, result: dict[str, Any]) -> dict[str, Any] | None:
    """The reviewer's Gate-1 regrouping as core will apply it — built from the decisions, sanitised, or None.

    ``{"moves": {memberId: destination | None}, "newGroups": [{"groupId", "name"}]}``, both in a stable order
    (moves by member id, New groups by id) so the frozen value is a pure function of the decisions. A move is
    DROPPED, not frozen, when it would do nothing or name nothing: back to where the variable already is, to a
    group this run does not have (a destination that cannot be honoured must not fail the paid leg), or of a
    variable the run does not have. ``None`` when nothing is left — the leg then runs the split's groups as-is.
    """
    grouped = store.artifacts_for(job, subject) or {}
    existing = {str(g.get("groupId")) for g in result.get("conceptGroups") or [] if g.get("groupId")}
    new_groups: dict[str, dict[str, str]] = {}
    for d in grouped.get(GATE1_NEW_GROUP) or []:
        gid = str(d.get("groupId") or "")
        if gid.startswith(REVIEWER_GROUP_PREFIX) and gid not in existing:
            new_groups[gid] = {"groupId": gid, "name": reviewer_group_name(d)}
            if d.get("splitFrom"):  # a part of an accepted division: the group it was divided from (provenance)
                new_groups[gid]["splitFrom"] = str(d["splitFrom"])
    origin = {str(m): gid for gid, members in (result.get("conceptGroupMembers") or {}).items() for m in members or []}
    fields = set(result.get("fieldIndex") or {})
    moves: dict[str, str | None] = {}
    for d in grouped.get(GATE1_REGROUP) or []:
        member, dest = str(d.get("memberId") or ""), d.get("chosen")
        if not member or not isinstance(dest, str) or not dest or (fields and member not in fields):
            continue
        target = None if dest == UNASSIGNED_GROUP_ID else dest
        if target is not None and target not in existing and target not in new_groups:
            continue
        if _current_group(member, origin, d.get("fromGroupId")) == target:
            continue
        moves[member] = target
    if not moves and not new_groups:
        return None
    return {"moves": dict(sorted(moves.items())), "newGroups": [new_groups[g] for g in sorted(new_groups)]}


def _gate2_picks(job: Job, subject: str | None, in_scope: list[str] | None) -> dict[str, dict[str, Any]]:
    """The reviewer's persisted Gate 2 picks, ``{groupId: {chosen, gencdeEdit, externalId?}}`` — what the Gate 3
    leg honours.

    The adapter decides which of these actually CHANGE a record (a pick naming the model's own CDE is a
    confirmation and costs nothing). A pick on a group Gate 1 scoped out is dropped: that group was never
    assigned, so re-targeting it would pay for specs on work the reviewer declined. ``externalId`` — the picked
    catalog element's tinyId, beside its (not necessarily unique) name — is passed on only when the pick has one
    (08-28 F13).
    """
    keep = set(in_scope) if in_scope is not None else None
    out: dict[str, dict[str, Any]] = {}
    for d in (store.artifacts_for(job, subject) or {}).get(GATE2_CANDIDATE_PICK) or []:
        gid = d.get("groupId")
        if not isinstance(gid, str) or not gid or (keep is not None and gid not in keep):
            continue
        chosen = d.get("chosen")
        edit = d.get("gencdeEdit")
        out[gid] = {
            "chosen": chosen if isinstance(chosen, str) else "",
            "gencdeEdit": edit if isinstance(edit, dict) else None,
        }
        ext = d.get("externalId")
        if isinstance(ext, str) and ext.strip():
            out[gid]["externalId"] = ext.strip()
    return out


# Where the Gate-1 scope is frozen on the run's config — read by every later leg and by the Gate 2/3 display.
GATE1_SCOPE_CONFIG_KEY = "gate1_scope"
# Where Gate 1's Continue freezes the reviewer's regrouping (moves + New groups) — every later leg hands it to
# core (``backend/engine/adapter.py`` reads the same key) and the export says which moves it applied.
GATE1_OVERRIDES_CONFIG_KEY = "gate1_overrides"


class ResumeBody(BaseModel):
    """Optional Continue payload. ``gate1Scope`` = the group ids Gate 1 SHOWED in scope; honoured only at Gate 1."""

    gate1Scope: list[str] | None = None


@app.post("/api/harmonize/resume/{job_id}")
def resume_run(
    job_id: str,
    request: Request,
    x_anthropic_key: Annotated[str | None, Header()] = None,
    body: ResumeBody | None = None,
) -> dict[str, Any]:
    """Commit the current gate and continue the run to the next boundary — the Continue action.

    A fresh worker, not a woken one (D-01). It is handed the previous gate's recorded stage answers, so
    every prompt the earlier leg already paid for is replayed at $0 and only genuinely new work reaches a
    provider.

    Authenticated even for the demo: this is the spend path. Pressing Continue at Gate 0 is the run's FIRST
    CHARGE (UI-SPEC §0.1), so it is not a surface a guest reaches by accident.

    The work itself is :func:`_continue_run` — the ONE function a gate is committed through. Full auto (08-30)
    calls it too, from the runner, so an auto-committed gate is committed exactly as a pressed one is.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    with _writable_run():
        if _is_pinned(job):
            raise ReadOnlyRunError(f"{job_id} is the shared demo and cannot be resumed — clone it first")
    return _continue_run(
        job_id,
        subject=subject,
        api_key=x_anthropic_key,
        gate1_scope=body.gate1Scope if body is not None else None,
    )


class _AutoAdvanceWithdrawnError(Exception):
    """Full auto found nothing to continue: the run was stopped, continued by hand, or moved on meanwhile.

    Not a failure, so it records nothing — whoever withdrew the advance already said why.
    """


def _continue_run(
    job_id: str,
    *,
    subject: str | None,
    api_key: str | None,
    gate1_scope: list[str] | None,
    auto: bool = False,
) -> dict[str, Any]:
    """Commit the gate a run is parked at and start its next leg — what Continue does, callable from the server.

    The HTTP route and Full auto both come through here, and through nothing else: the same reconcile, the same
    checkpoint lock, the same $0 replay seed, the same ledger seed and the same Gate 4 pure read. ``auto`` changes
    only WHAT is committed — the pipeline's own proposals rather than the reviewer's decisions (Gate 1: every
    group in scope, no moves; Gate 2: the model's picks; Gate 3: the specs as drafted) — and records the gate as
    decided by ``auto``. Refusals raise like the route's (409, the key refusal); on the ``auto`` path a run that
    is no longer waiting to be continued raises :class:`_AutoAdvanceWithdrawnError` instead.
    """
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != AWAITING_REVIEW or not job.gate_position:
        if auto:
            raise _AutoAdvanceWithdrawnError
        raise HTTPException(status_code=409, detail="This run is not paused at a gate")
    target = next_gate(job.gate_position)
    if target is None:
        if auto:
            raise _AutoAdvanceWithdrawnError
        raise HTTPException(status_code=409, detail="This run is at the final gate; there is nothing to resume")
    # Reconcile before the replay fuel is read, not after: a late batch result that is attached now is a
    # stage this leg replays for $0, and one attached a minute later is a stage it pays for twice.
    _reconcile_on_open(job, api_key=api_key)
    # Everything from reading the checkpoint to handing it to the next leg happens under the run's
    # checkpoint lock (08-28 1a). A paid action billed onto this checkpoint AFTER it is read as the seed but
    # BEFORE the run leaves `awaiting_review` would land in a file the new leg never reads again, and drop
    # out of every later figure; under the lock it instead waits and is queued for the new leg's checkpoint.
    with checkpoint_lock(job_id):
        return _resume_locked(job_id, target, subject, api_key, gate1_scope, auto=auto)


def _auto_kwargs(config: dict[str, Any]) -> dict[str, Any]:
    """The worker keyword a Full-auto leg carries: the continue function. Nothing at all for a guided leg."""
    return {"auto_advance": _auto_continue} if is_auto(config) else {}


def _gate_label(gate: str | None) -> str:
    return f"Gate {gate[4:]}" if gate and gate.startswith("gate") else "this gate"


def _auto_continue(job_id: str, api_key: str | None) -> None:
    """Full auto's step (08-30): commit the gate the run just parked at with the pipeline's own proposals.

    Called by the runner after a Full-auto leg parks cleanly, with that leg's in-memory key. Never raises: a run
    this cannot continue — no key, no catalog, nothing in scope — stays parked at the gate it reached with the
    reason recorded, which is exactly a guided run waiting for its Continue ("continue it manually").
    """
    job = store.get(job_id)
    gate = job.gate_position if job is not None else None
    try:
        _continue_run(
            job_id,
            subject=job.owner_subject if job is not None else None,
            api_key=api_key,
            gate1_scope=None,
            auto=True,
        )
    except _AutoAdvanceWithdrawnError:
        return
    except Exception as exc:  # noqa: BLE001 — every refusal and failure leaves the run parked, with its reason
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        logger.info("job %s: Full auto stopped at %s (%s)", job_id, gate, type(exc).__name__)
        store.halt_auto_advance(
            job_id,
            reason=f"Full auto stopped at {_gate_label(gate)}: {detail} Review this gate and continue it manually.",
        )


def _resume_locked(
    job_id: str,
    target: str,
    subject: str | None,
    x_anthropic_key: str | None,
    gate1_scope: list[str] | None,
    *,
    auto: bool = False,
) -> dict[str, Any]:
    """The body of :func:`_continue_run`, run under the run's checkpoint lock. Never call this directly."""
    job = store.get(job_id)
    if job is None or job.status != AWAITING_REVIEW or not job.gate_position or next_gate(job.gate_position) != target:
        # Re-checked under the lock: a second Continue that waited on the first must not spawn a second leg.
        if auto:
            raise _AutoAdvanceWithdrawnError
        raise HTTPException(status_code=409, detail="This run is not paused at a gate")
    if auto and not job.auto_advance:
        # A Stop landed between the park and this advance (or the run was continued by hand): it stays parked.
        raise _AutoAdvanceWithdrawnError
    # Who commits this gate (08-30). Written only where it changes something, so a guided run gets no new key.
    decided_by = _decided_by_after(job, auto)
    ckpt = _checkpoint_for(job)
    if ckpt is None:
        raise HTTPException(status_code=409, detail="This run has no saved state to resume from")
    if not job.dict_specs or not job.config.get("work_dir"):
        raise HTTPException(status_code=409, detail="This run predates resumable gates (no retained uploads)")

    # Gate 4 is a PURE READ of the result the run already has (UI-SPEC §0.1, and the comment above
    # `_GATE_STOP_MECHANISM`): there is no stage left to run, so this leg spawns NO worker. It carries the
    # finished payload forward under the new position and returns. Re-running the pipeline to reach a
    # screen that only reads it would pay again for anything the replay could not cover, to arrive at the
    # result already on disk.
    if target == "gate4":
        work_dir = Path(job.config["work_dir"])
        # The CUMULATIVE figure, and one the carried result agrees with: the rail reads `result.cost`, the
        # Gate 4 copy reads the realized cost, and a legacy Gate 3 checkpoint could carry a per-leg realized
        # figure its own cost block contradicts (08-28 1a, F14). The larger is the one money was spent on.
        realized = max(ckpt.realized_cost, cost_block(ckpt.result.get("cost")).get("actualUsd", 0.0))
        if decided_by is not None:
            store.update(job_id, config={**job.config, GATE_DECIDED_BY_CONFIG_KEY: decided_by})
        carried = write_checkpoint(
            work_dir,
            job_id=job_id,
            gate=target,
            result=ckpt.result,
            responses=ckpt.responses,
            realized_cost=realized,
        )
        store.checkpoint(
            job_id,
            gate=target,
            checkpoint_ref=_relative_ref(store, job_id, carried.path or checkpoint_path(work_dir, target)),
            realized_cost=realized,
        )
        return {"jobId": job_id, "resumedFrom": job.gate_position, "target": target}
    # The catalog is needed only by a leg that spawns a worker — checked AFTER the Gate 4 pure-read branch, so a
    # server without a catalog can still carry a finished run to its export screen.
    # The catalog the run RECORDED at creation — never the current creation default (`_recorded_cde_set`).
    cde_path = _catalog_path_or_refuse(_recorded_cde_set(job.config), starting=False)
    cde_spec = cde_spec_for(cde_path)
    # Pre-flight the provider key BEFORE committing the gate and spawning the worker. Past Gate 4 this leg
    # makes a PAID call, and the BYOK key clears on a browser reload — discovering it missing deep in the
    # generating stage errors the whole run and wipes the served gate state (the keyless-wipes-gate-state
    # bug). Refuse at the door instead; the run stays parked and resumable the moment a key is re-supplied.
    if _resume_needs_a_key(job.config, x_anthropic_key):
        raise key_required(
            "Enter your Anthropic API key to continue — a paid step needs it and the key clears on "
            "reload. Your gate state is preserved; re-enter the key and press Continue again."
        )
    # Where the ENGINE stops and where the RUN parks are two different questions. Only gates with a core
    # boundary are stop targets; past that the pipeline runs to completion and the UI backend holds the run
    # itself (UI-SPEC §0.1). Gate 3 is exactly that case — it reviews the FINISHED pipeline, so it takes no
    # engine stop and still parks, which is what `park_at_gate` carries.
    # Gate-1 scope: honour the reviewer's kept groups so the paid per-group assign (77% of the run) processes
    # ONLY them — which is what makes the Gate-2 cost match the quote Gate 1 showed (until now the scope was a
    # display filter only, so the assign paid for every group). Threaded on every worker-spawning leg (gate2
    # and gate3), not just gate1->gate2: the group_assign prompts for out-of-scope groups have no replayed
    # answer, so an unfiltered later leg would re-run them as "new work" and re-charge.
    ckpt_result = getattr(ckpt, "result", None) or {}
    groups = ckpt_result.get("conceptGroups") or []
    config = dict(job.config)
    if job.gate_position == "gate1":
        # 08-28 Wave 2: FREEZE the reviewer's regrouping (moves + New groups) before the first paid leg, exactly as
        # the scope is frozen — every later leg and the $0 replay read this, never the live decisions. Recomputed
        # on EVERY Gate 1 Continue (a leg that failed parks the run back here, and the reviewer may regroup again).
        # Full auto commits the pipeline's own groups, so it freezes no moves at all.
        config = {k: v for k, v in job.config.items() if k != GATE1_OVERRIDES_CONFIG_KEY}
        overrides = None if auto else _gate1_overrides(job, subject, ckpt_result)
        if overrides is not None:
            config[GATE1_OVERRIDES_CONFIG_KEY] = overrides
        # 08-27: Gate 1's Continue sends the scope it DISPLAYED; freeze it (checkpoint order, then the New groups,
        # unknown ids dropped). Only at Gate 1 — past it the scope is a consumed decision, not an input. Full
        # auto's scope is EVERY group (08-30), frozen the same way, so every later leg and export reads it alike.
        known = [g["groupId"] for g in groups if g.get("groupId")]
        if auto:
            gate1_scope = known
        if gate1_scope is not None:
            sent = set(gate1_scope)
            known += [g["groupId"] for g in (overrides or {}).get("newGroups", [])]
            frozen = [gid for gid in known if gid in sent]
            if not frozen:
                raise HTTPException(
                    status_code=409, detail="Nothing is in scope — select at least one group on Gate 1."
                )
            config[GATE1_SCOPE_CONFIG_KEY] = frozen
    if decided_by is not None:
        config[GATE_DECIDED_BY_CONFIG_KEY] = decided_by
    if config != job.config:
        store.update(job_id, config=config)
        job = store.get(job_id) or job
    run_config = {
        **job.config,
        "stop_at_gate": target if target in ("gate1", "gate2") else None,
        "park_at_gate": target,
    }
    in_scope = _gate1_assign_scope(job, subject, groups)
    if in_scope is not None:
        run_config["assign_group_ids"] = in_scope
    # 08-27b: the leg INTO Gate 3 generates the transform specs, so it must build them for the target the
    # reviewer picked at Gate 2, not the model's. Only this leg reads the picks: they are Gate 2's output.
    if target == "gate3" and not auto:  # Full auto builds Gate 3 for the model's own picks
        picks = _gate2_picks(job, subject, in_scope)
        if picks:
            run_config["gate2_picks"] = picks
    # A resume starts a NEW LEG, so its stage timeline starts empty (08-26, live-test-2 #5). Phase starts are
    # stamped with setdefault, so the first leg's loading/embedding/clustering stamps (and the park stamp) would
    # otherwise survive, this leg's own entries into those phases would be dropped, and the progress panel
    # would list the first leg's stages and durations — plus the days the run sat parked — under this leg.
    #
    # `cancel_mode=None` in the SAME locked write as the flip to `pending` (08-28): a stop flag belongs to one
    # worker, and this leg's worker does not exist yet. A flag that survived the park (a Stop pressed on the
    # parked run by an older build, or one that raced the park) was read by this leg's first progress tick and
    # ended the reviewer's paid Continue `cancelled`. Cleared atomically with the flip, so a Stop pressed a
    # moment later sees an in-flight run and is honoured by the new leg, as it should be.
    #
    # A Full-auto run's pending advance ends here too (08-30), however this Continue came: from the server, or
    # from a reviewer who pressed Continue in the moment between the park and the advance.
    flip: dict[str, Any] = {"auto_advance": False} if is_auto(job.config) else {}
    store.update(job_id, status="pending", phase="pending", phase_timings={}, cancel_mode=None, **flip)
    threading.Thread(
        target=run_harmonization,
        args=(store, job_id, job.dict_specs, cde_spec, run_config),
        # `prior_cost` seeds the leg's ledger with everything the run has spent so far, so the checkpoint this
        # leg writes carries the run's cumulative cost rather than the leg's own share (08-28 1a, F14/F10).
        # Only a leg Full auto started is handed the continue function: once a person has continued a run by hand
        # (one that stopped, or that a restart parked) it is guided from there, as the plan promises.
        kwargs={
            "api_key": x_anthropic_key,
            "replay_responses": ckpt.responses,
            "prior_cost": ckpt.result.get("cost"),
            **(_auto_kwargs(job.config) if auto else {}),
        },
        daemon=True,
    ).start()
    return {"jobId": job_id, "resumedFrom": job.gate_position, "target": target}


def _decided_by_after(job: Job, auto: bool) -> dict[str, str] | None:
    """The run's ``gate_decided_by`` once the gate it is parked at is committed — or None when nothing changes.

    Full auto adds the gate as ``auto``. A person continuing a gate takes it OFF the record (a Full-auto run whose
    leg failed parks back at a gate it had auto-committed, and the reviewer then continues it themselves). A run
    with no record and no auto commit — every guided run — returns None, so no config write is made for it.
    """
    gate = job.gate_position or ""
    raw = job.config.get(GATE_DECIDED_BY_CONFIG_KEY)
    current = dict(raw) if isinstance(raw, dict) else None
    if auto:
        updated = {**(current or {}), gate: DECIDED_BY_AUTO}
    elif current is None or gate not in current:
        return None
    else:
        updated = {g: who for g, who in current.items() if g != gate}
    return None if updated == current else updated


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
    ``cancelled`` is False when the run is unknown to the caller (404) or already terminal (nothing to stop).

    A run PARKED at a review gate is refused with a 409 that says why (08-28). A pause is an exit (08 D-01):
    there is no worker to stop and nothing is being spent. Flagging it anyway was not a harmless no-op — the
    flag survived to the next Continue, whose fresh worker raised on it and ended the run ``cancelled``. The
    store refuses the flag too (under its lock), so a Stop that loses a race to the park answers False."""
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)):
        raise HTTPException(status_code=404, detail="Job not found")
    if is_auto(job.config):
        # Full auto (08-30): the run may be parked only for the moment it takes the server to continue it. A Stop
        # landing then stops Full auto THERE — the run stays parked with what it has bought, as a guided run would
        # — and it is decided under the checkpoint lock the advance holds, so the two cannot both go ahead.
        with checkpoint_lock(job_id):
            if store.halt_auto_advance(
                job_id, reason=f"Full auto was stopped at {_gate_label(job.gate_position)}. Continue it manually."
            ):
                return {"cancelled": True}
            return _stop_unlocked(store.get(job_id) or job, mode)
    return _stop_unlocked(job, mode)


def _stop_unlocked(job: Job, mode: str) -> dict[str, bool]:
    """The stop itself — unchanged for every run, guided and auto: a parked run has nothing to stop."""
    if job.status == AWAITING_REVIEW:
        raise HTTPException(
            status_code=409,
            detail="This run is paused at a review gate, so nothing is running and nothing is being spent — "
            "there is nothing to stop. Continue it from its gate, or delete it.",
        )
    return {"cancelled": store.request_cancel(job.job_id, mode)}


@app.post("/api/harmonize/jobs/{job_id}/switch-to-sync")
def switch_to_sync(job_id: str, request: Request) -> dict[str, bool]:
    """Stop waiting on the in-flight batch: cancel it and finish the stage synchronously (08-28 0e, v1).

    What the reviewer is agreeing to: whatever the cancelled batch still hands back is kept at the batch rate,
    and every id it does not is bought again at the full (sync) rate — which is why the offer carries its own
    estimate. The rest of THIS leg then runs sync; the next Continue starts in batch again.

    OWNER-SCOPED, stricter than visibility: it spends the owner's money, so a run the caller does not own —
    the shared demo included — is not found (404, never revealing that someone else's run exists).
    409 unless a batch stage is in flight AND the provider still reports that batch ``in_progress``: only
    that batch can be cancelled, and an ending one hands back everything anyway. IDEMPOTENT: a second press
    in the same leg is a 200 that changes nothing (``alreadyRequested``). The flag is read by the leg's batch
    stage at its next heartbeat; nothing here talks to the provider.
    """
    job = store.get(job_id)
    if job is None or _is_pinned(job) or job.owner_subject != _subject(request):
        raise HTTPException(status_code=404, detail="Job not found")
    outcome = store.request_switch_to_sync(job_id)
    if outcome == "already":
        return {"switched": True, "alreadyRequested": True}
    if outcome == "requested":
        logger.info("job %s: switch to sync requested", job_id)
        return {"switched": True, "alreadyRequested": False}
    raise HTTPException(
        status_code=409,
        detail="There is no batch in the provider's queue to switch: the run is not waiting on one right now.",
    )


@app.get("/api/harmonize/jobs/{job_id}/uploads/{filename}")
def retained_upload(job_id: str, filename: str, request: Request) -> FileResponse:
    """One of a run's retained uploads, handed back to the run's OWNER — what a prefilled re-run reads.

    Re-run in the UI opens Setup prefilled with the earlier run's dictionaries, column roles and options for
    the reviewer to check and start (08-28), rather than firing a paid run in the old mode. Setup posts
    FILES, and a browser does not keep the file a run was started from, so the run's own retained copy is
    read back here and goes through exactly the checks a freshly dropped file does.

    Three refusals, each the difference between this and a file server: only a caller who can see the run
    (404 otherwise, never a 403 that confirms the run exists), only a filename the run itself DECLARED in
    its dict_specs, and only a bare name — a path that walks out of the uploads directory is not a name any
    run declared. The shared demo keeps no uploads and is refused like an unknown run.
    """
    job = store.get(job_id)
    if job is None or not _visible_to(job, _subject(request)) or _is_pinned(job):
        raise HTTPException(status_code=404, detail="Job not found")
    declared = {Path(str(s.get("path", ""))).name for s in (job.dict_specs or [])}
    if Path(filename).name != filename or filename not in declared:
        raise HTTPException(status_code=404, detail="This run has no uploaded dictionary by that name")
    work_dir = job.config.get("work_dir")
    path = Path(work_dir) / "uploads" / filename if work_dir else None
    if path is None or not path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"The uploaded file {filename!r} is no longer available on the server — add it again.",
        )
    return FileResponse(path, filename=filename)


@app.post("/api/harmonize/jobs/{job_id}/rerun")
def rerun_job(job_id: str, request: Request, x_anthropic_key: Annotated[str | None, Header()] = None) -> dict[str, str]:
    """Re-execute a past run from its retained uploads as a NEW owned run (the original is preserved).

    Copies the source job's uploaded dictionaries into a fresh work dir and restarts the pipeline with the
    same config. BYOK: batch/sync modes need the ``X-Anthropic-Key`` header re-supplied (never persisted);
    preview mode needs none.

    KEPT FOR API CALLERS; THE UI NO LONGER CALLS IT (08-28). It starts a paid run immediately in the source
    run's mode, and a re-run in the UI is "start a new run with the last one's inputs filled in" — so the UI
    opens Setup prefilled (reading the uploads back through :func:`retained_upload`) and the reviewer starts
    it there, choosing the mode consciously.
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
    # The same door check as a fresh start (08-28 1a, F8): refuse a keyless paid re-run before its uploads are
    # copied into a new run that could only error in its first paid stage.
    if _resume_needs_a_key(src.config, x_anthropic_key):
        raise key_required(
            "Enter your Anthropic API key to re-run — its first step is a paid model call and the key "
            "clears on reload. Nothing was created or charged; re-enter the key and try again."
        )

    # Rebuild the CDE backbone from the stored cdeSet (catalog files live server-side, not in the job dir).
    # The source run's RECORDED catalog (`_recorded_cde_set`): an API re-run repeats the run it copies.
    cde_path = _catalog_path_or_refuse(_recorded_cde_set(src.config), starting=False)

    new_id = str(uuid.uuid4())
    new_work = _WORK_ROOT / new_id
    new_uploads = new_work / "uploads"
    shutil.copytree(old_uploads, new_uploads)
    # Remap each dict_spec path (same filenames) into the new uploads dir.
    new_specs = [{**s, "path": str(new_uploads / Path(s["path"]).name)} for s in src.dict_specs]
    cde_spec = cde_spec_for(cde_path)
    # A re-run is a NEW run, so it gets what every new run gets: re-splitting on (see `start_batch`), even when the
    # run it copies predates that and recorded it off. The source run is untouched and replays as recorded.
    run_config = {**src.config, "work_dir": str(new_work), "readjudication": True}
    # Which gates Full auto committed is a fact about the SOURCE run's gates, not a setting: the copy has decided
    # nothing yet. (It keeps the review mode, like every other setting it copies.)
    run_config.pop(GATE_DECIDED_BY_CONFIG_KEY, None)

    display = f"{src.display_name} (re-run)"
    store.create(new_id, display, run_config, owner_subject=subject, dict_specs=new_specs)
    threading.Thread(
        target=run_harmonization,
        args=(store, new_id, new_specs, cde_spec, {**run_config, "stop_at_gate": ENTRY_GATE}),
        kwargs={"api_key": x_anthropic_key, **_auto_kwargs(run_config)},
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
    # The reviewer's concepts — a staged run's effective records from its checkpoint (08-28 1f, F20).
    _payload, records, _staged = _harmonized(job, _subject(request))
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
    try:
        with llm_call(model=model_tag):
            out = generate_analysis_ideas(records, client.complete)
    finally:
        # Billed to the run whether or not the reply was usable: the call was charged either way (08-28 1a).
        billing.bill_client(store, job_id, billing.ANALYSIS_IDEAS, client)
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


class ReadjudicateBody(BaseModel):
    """Divide EXACTLY the concept groups a human named (Gate 1's "Accept the division").

    ``groupIds`` is required and must be non-empty. There is deliberately no "all flagged groups" mode: the
    coherence judge FLAGS, and re-splitting every flagged group because it was flagged is an auto-resolution
    of an over-merge with no human decision behind it, which is a standing prohibition and which core's own
    ``readjudicate`` docstring forbids the pipeline from doing.
    """

    groupIds: list[str] = []


def _effective_members(result: dict[str, Any], overrides: dict[str, Any] | None, group_id: str) -> list[str]:
    """A Gate-1 group's members as the reviewer currently sees it: the split's, minus moves out, plus moves in.

    The same rule the Gate 1 screen draws (``effectiveMembers`` in ``frontend/src/lib/ledger.ts``) and core
    applies (``resolve_group_membership``) — used here to refuse, before any spend, a division of a group the
    reviewer has already emptied down to one variable, and (via :func:`_gate1_membership`) as the closed world of
    Gate 1's free score suggestions. Core's own resolution is what the re-split uses.
    """
    uncapped = (result.get("conceptGroupMembers") or {}).get(group_id)
    if uncapped is None:  # a payload with no uncapped list for this group: the recorded sample, as the screen does
        group = next((g for g in result.get("conceptGroups") or [] if g.get("groupId") == group_id), {})
        uncapped = group.get("memberVariableNames") or []
    original = [str(m) for m in uncapped]
    moves = (overrides or {}).get("moves") or {}
    kept = [m for m in original if moves.get(m, group_id) == group_id]
    return kept + sorted(m for m, dest in moves.items() if dest == group_id and m not in original)


def _gate1_membership(result: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, list[str]]:
    """EVERY Gate-1 group's members as the reviewer currently sees them — :func:`_effective_members`, for all.

    The split's groups (``conceptGroups``, then any ``conceptGroupMembers`` key the rows do not list), then the
    reviewer's New groups in ``overrides`` order; ``overrides`` is :func:`_gate1_overrides`' sanitised regrouping,
    so a move to a destination that cannot be honoured never moves anything here either. Every Gate 1 move is
    APPLIED (08-28): a variable dragged into a New group is that group's, and a clustering leftover the reviewer
    placed into a group counts for it.
    """
    ids = [str(g["groupId"]) for g in result.get("conceptGroups") or [] if g.get("groupId")]
    ids += [str(g) for g in (result.get("conceptGroupMembers") or {}) if str(g) not in ids]
    ids += [str(g["groupId"]) for g in (overrides or {}).get("newGroups") or [] if g.get("groupId")]
    return {gid: _effective_members(result, overrides, gid) for gid in dict.fromkeys(ids)}


@app.post("/api/harmonize/jobs/{job_id}/readjudicate")
def readjudicate(
    job_id: str,
    body: ReadjudicateBody,
    request: Request,
    x_anthropic_key: Annotated[str | None, Header()] = None,
    x_provider_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Accept a proposed division at Gate 1 (STGD-16) — the one Gate-1 action that STARTS PAID WORK.

    Every other gate decision rides the generic artifact route, because recording a decision is storage. This
    one buys a re-split from a provider, so it carries its refusals up front, each a prohibition made mechanical
    and each BEFORE anything is bought:

    1. **A pinned demo is rejected outright** — checked first, so a demo that happens to carry the opt-in is
       still refused and a guest walk can never spend money.
    2. **The run must have recorded ``readjudication`` at creation.** Every new run records it ON (final review
       round 1); only a run created before then can carry it off, and the refusal names itself so the UI can
       render the honest "not enabled for this run" state.
    3. **The caller must name explicit group ids.** An empty or absent list is refused, never widened.
    4. **The run must be parked AT Gate 1.** Past it the grouping was committed by Gate 1's Continue, and a
       division now would change nothing any later leg reads.
    5. **Each group must exist on this Gate 1 and still hold two variables** as the reviewer left it.
    6. **A provider key must be available** — a keyless re-split used to answer 200 with nothing done.

    WHAT IT PRODUCES (08-28, the silent no-op fixed). The division is written as the REVIEWER'S OWN Gate 1
    decisions: one ``gate1_new_group`` per part (named for the concept the re-split gave it, ``splitFrom`` =
    the divided group) and a ``gate1_regroup`` moving each of the part's variables into it. The children core
    returns exist on one result only — the Gate 2 leg re-runs the split, which keeps the group whole — so the
    Gate-1 payload is NOT edited: decisions are what Gate 1's Continue freezes and every later leg (and the $0
    replay) applies. So the parts are listed at Gate 1 at once, survive a reload, are priced by Gate 1's quote
    like any New group (a match + one ideal each), and are assigned as themselves at Gate 2. The rows written
    come back, with their versions, so the screen shows them without a reload. A re-split that keeps the group
    whole writes nothing and says so (``nGroups: 0``).

    Rebuilding core's inputs is FREE: ``replay_leanb_result`` replays the deterministic front half against the
    frozen substrate and the checkpoint's recorded stage answers. The only new spend is the re-split, billed to
    Gate 1. BYOK: the key is in-memory for this request only — never written to ``run_config``, the row, or a log.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        # 404, not 403: a 403 would confirm that someone else's run exists.
        raise HTTPException(status_code=404, detail="Job not found")
    with _writable_run():
        if _is_pinned(job):
            raise ReadOnlyRunError(
                f"{job_id} is the shared demo and cannot be re-adjudicated — clone it into a run of your own"
            )
    if not job.config.get("readjudication"):
        # Only a run created before re-splitting became always-on can reach this: it recorded the old opt-in as
        # off, and its quote never included the capability, so it replays as recorded. There is no Setup control
        # to point at any more — every new run has it.
        raise HTTPException(
            status_code=409,
            detail=(
                "Re-splitting is not enabled for this run: it was created before re-splitting became available on "
                "every run, and recorded it as off. Start a new run to re-split a group — every new run can."
            ),
        )
    group_ids = list(dict.fromkeys(g.strip() for g in (body.groupIds or []) if g and g.strip()))
    if not group_ids:
        raise HTTPException(
            status_code=400,
            detail=(
                "Name the concept groups to re-adjudicate. This endpoint never re-splits every flagged "
                "group: the coherence flag is a suggestion, and acting on it without a named human decision "
                "would be an auto-resolution of an over-merge."
            ),
        )
    if job.gate_position != "gate1" or job.status != AWAITING_REVIEW:
        raise HTTPException(
            status_code=409,
            detail=(
                "Accepting a division is a Gate 1 decision, and this run is not parked at Gate 1 — its grouping "
                "was committed when Gate 1 was continued, so a division now would change nothing. Nothing was "
                "charged."
            ),
        )
    if not job.dict_specs or not job.config.get("work_dir"):
        raise HTTPException(
            status_code=409, detail="This run predates re-adjudication (no retained source dictionaries)"
        )
    artifacts = store.artifacts
    if artifacts is None:
        raise HTTPException(status_code=503, detail="Persistence is not configured on this server")
    ckpt = _checkpoint_for(job)
    ckpt_result = ckpt.result if ckpt is not None else {}
    known = {str(g.get("groupId")) for g in ckpt_result.get("conceptGroups") or []}
    unknown = [g for g in group_ids if g not in known]
    if unknown:
        raise HTTPException(status_code=404, detail=f"No concept group {unknown[0]!r} on this run's Gate 1")
    # The reviewer's regrouping SO FAR (live decisions, not yet frozen): the group is divided as they see it now.
    current = _gate1_overrides(job, subject, ckpt_result)
    too_small = [g for g in group_ids if len(_effective_members(ckpt_result, current, g)) < 2]
    if too_small:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{too_small[0]!r} has fewer than two variables left in it, so there is nothing to divide. "
                "Nothing was charged."
            ),
        )
    # The catalog the run RECORDED at creation — never the current creation default (`_recorded_cde_set`).
    cde_path = _catalog_path_or_refuse(_recorded_cde_set(job.config), starting=False)
    cde_spec = cde_spec_for(cde_path)

    # The paid-action guard: the re-split ALWAYS buys a split, so a missing provider key must fail loudly HERE,
    # not deep in the paid stage where it once returned 200 with nothing done. No preview exemption. The key
    # clears on a browser reload, which is exactly how the live test hit it.
    if _no_anthropic_key(job.config, x_provider_key or x_anthropic_key):
        raise key_required(
            "Enter your Anthropic API key to re-split this group — it buys a new split pass and the "
            "key clears on reload. Your run is unchanged; re-enter the key and try again."
        )

    from backend.engine import adapter as engine_adapter
    from backend.engine.llm import build_llm_client

    # A leg that failed parks the run back at Gate 1 with the regrouping it froze still on the config; replaying
    # with it would reshape the groups the reviewer is dividing a SECOND time. Gate 1 is replayed as displayed.
    replay_config = {k: v for k, v in job.config.items() if k != GATE1_OVERRIDES_CONFIG_KEY}
    responses = ckpt.responses if ckpt is not None else {}
    try:
        leanb_result, embedded = engine_adapter.replay_leanb_result(
            job.dict_specs, cde_spec, replay_config, replay_responses=responses
        )
    except engine_adapter.ReplayUnavailableError as exc:
        # 409, and the reason is stated: re-deriving core's objects without the recording would re-buy the
        # whole front half, which is not what a request to re-split two groups agreed to pay for.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    cde_cohort = job.config.get("cde_cohort", CDE_COHORT)
    regrouping = engine_adapter.core_group_overrides(current, engine_adapter.build_field_index(embedded, cde_cohort))

    client = build_llm_client(job.config.get("model_tag"), x_provider_key or x_anthropic_key)
    stage = engine_adapter.specgen_stage_fn(client)
    try:
        parts = engine_adapter.divide_groups(
            leanb_result,
            embedded,
            group_ids=group_ids,
            split=stage,
            group_overrides=regrouping,
            cde_cohort=cde_cohort,
        )
    except engine_adapter.DivisionUnavailableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:  # the seam's own refusal, kept as a 400 rather than a 500
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        billing.bill_client(store, job_id, billing.READJUDICATE, client)

    # Persist the division as the reviewer's decisions (see the docstring). The split is paid for already, so the
    # writes happen after it — and they are the whole of the effect: the checkpoint is not touched.
    owner = principal_of(subject, job)
    origin = {str(m): gid for gid, ms in (ckpt_result.get("conceptGroupMembers") or {}).items() for m in ms or []}
    now = int(time.time() * 1000)
    written: dict[str, list[dict[str, Any]]] = {GATE1_NEW_GROUP: [], GATE1_REGROUP: []}

    def _put(kind: str, payload: dict[str, Any]) -> None:
        stored = artifacts.put(owner=owner, job_id=job_id, kind=kind, payload=payload)
        written[kind].append({**payload, UPDATED_AT: stored.updated_at})

    with _writable_run():
        for i, part in enumerate(parts):
            name, gid = str(part["name"]), str(part["groupId"])
            # Newest first is the queue's order, so the FIRST part is stamped newest and leads the list.
            created = now + (len(parts) - i)
            _put(
                GATE1_NEW_GROUP,
                {
                    "groupId": gid,
                    "chosen": name,
                    "alternatives": [name],
                    "optionSetKey": option_set_key([name]),
                    "name": name,
                    "createdAt": created,
                    "splitFrom": part["parentGroupId"],
                },
            )
            for member in part["members"]:
                source = origin.get(str(member), "")
                alts = list(dict.fromkeys(x for x in (source, UNASSIGNED_GROUP_ID, gid) if x))
                _put(
                    GATE1_REGROUP,
                    {
                        "memberId": str(member),
                        "fromGroupId": source,
                        "chosen": gid,
                        "alternatives": alts,
                        "optionSetKey": option_set_key(alts),
                        "movedAt": now,
                    },
                )
    return {
        "jobId": job_id,
        "groupIds": group_ids,
        "nGroups": len(parts),
        "parts": [
            {
                "groupId": p["groupId"],
                "name": p["name"],
                "splitFrom": p["parentGroupId"],
                "members": list(p["members"]),
            }
            for p in parts
        ],
        "decisions": written,
    }


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
    carried = _checked_clone_artifacts(body.artifacts or [])

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
    if artifacts is not None and carried:
        owner = principal_of(subject, store.get(new_id))
        with _writable_run():
            for kind, payload in carried:
                artifacts.put(owner=owner, job_id=new_id, kind=kind, payload=payload)
    return {"jobId": new_id}


def _checked_clone_artifacts(entries: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    """Every carried artifact, validated by its registered kind BEFORE the copy exists (08-18).

    All or nothing, because the alternative loses work silently: checked one at a time during the copy, a bad
    entry halfway down refused the request AFTER the run and the entries before it were already stored — a
    copy that looks kept on the Runs page and quietly lacks everything after the bad entry. The guest's edits
    are still in their tab when this refuses, so a clean refusal is recoverable and a partial copy is not. The
    same registry the upsert uses does the checking, so no second copy of any rule lives here.
    """
    carried: list[tuple[str, dict[str, Any]]] = []
    for i, entry in enumerate(entries):
        kind, payload = entry.get("kind"), entry.get("payload")
        if not kind or not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="each artifact needs a kind and a payload object")
        try:
            spec = registry.get(str(kind))
            spec.check(payload)
            spec.key_for(payload)
        except (UnknownArtifactKindError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"artifact {i} ({kind}): {exc}") from exc
        carried.append((str(kind), payload))
    return carried


# --- user artifacts (generic) ----------------------------------------------------------------
# One surface for every kind of user-generated work attached to a run. A new persisted feature registers
# its kind in backend/artifact_kinds.py and is reachable here immediately — no new route, no new column,
# no new setter. Feature endpoints that DO more than store (an LLM derivation, a result-blob merge) keep
# their own route and persist through the same store.


def _refuse_past_gate(job: Job, kind: str) -> None:
    """409 when ``kind`` belongs to a gate this staged run has already passed (08-27 audit B4).

    Past gates are records: their decisions were consumed by a paid leg, so changing one afterwards would
    rewrite history (and on a legacy run with no frozen scope, change what a later leg bills). A run with no
    gate position — finished, or never staged — stays re-decidable, as the re-decide-a-finished-run design
    requires.
    """
    from backend.artifact_kinds import AUTO_REVISABLE_KINDS, DECISION_GATE

    gate = DECISION_GATE.get(kind)
    at = job.gate_position
    if gate is None or not at or at not in GATE_ORDER:
        return
    if GATE_ORDER.index(at) > GATE_ORDER.index(gate) and auto_accepted(job.config, gate):
        # Full auto (08-30) committed this gate and NOBODY reviewed it, so it is not a record of a review — it is
        # still open to one. What can change is what the export applies without re-running anything (the set a
        # finished run is re-decided with). Gate 1's grouping and the score declaration would need those groups
        # re-run, which is not available, so they are refused by name rather than accepted and silently ignored.
        if kind in AUTO_REVISABLE_KINDS:
            return
        raise HTTPException(
            status_code=409,
            detail=f"{gate.replace('gate', 'Gate ')} was auto-accepted, and changing its groups would need a re-run "
            "of those groups, which is not available yet. Its names, the Gate 2 targets and the Gate 3 recodes can "
            "still be reviewed.",
        )
    if GATE_ORDER.index(at) > GATE_ORDER.index(gate):
        raise HTTPException(
            status_code=409,
            detail=f"This run has passed {gate.replace('gate', 'Gate ')}; its decisions are a record and cannot be changed.",
        )


def _artifact_target(job_id: str, request: Request) -> tuple[Job, str]:
    """The run and the caller's owner key, or 404/403. Rejects the immutable demo for writes."""
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    return job, principal_of(subject, job)


@app.get("/api/harmonize/jobs/{job_id}/artifacts")
def list_artifacts(job_id: str, request: Request) -> dict[str, Any]:
    """Everything the CALLER has stored against this run, grouped by kind, plus which of it is stale.

    ``stale`` is DERIVED here on every read by comparing each decision's persisted upstream content key
    against that upstream's current one (see ``artifact_kinds.derive_staleness``). It is deliberately not a
    stored field: a flag would have to be written onto a row that may not exist yet, from a write to a
    DIFFERENT row - which is the cross-row read-modify-write this table exists to eliminate.

    Each keyed row carries its stored ``updatedAt`` (08-28 3f): it is what a client sends back as the ``base``
    of its next write, so the first save after a reload names the version it replaces instead of writing blind.
    """
    job, owner = _artifact_target(job_id, request)
    grouped = store.artifacts_for(job, owner, with_updated_at=True)
    return {
        "kinds": registry.names(),
        "artifacts": grouped,
        "stale": derive_staleness(grouped or {}),
    }


#: The two-tab notice (UI-SPEC 8.4), returned so a client can render it verbatim rather than invent one.
_CONFLICT_MESSAGE = (
    "Another tab changed this run. Your last change was kept and theirs was applied on top. "
    "Reload to see the current state."
)


def _conflict_for(
    artifacts: Any, *, owner: str, job_id: str, kind: str, payload: dict[str, Any], base: float | None
) -> dict[str, Any] | None:
    """Whether this write is about to replace a value the caller has not seen. None means it is not.

    Last-write-wins is the resolution; the NOTICE is the requirement, because a silent overwrite of another
    session's decision is prohibited. The store already returns the stored row rather than a boolean —
    deliberately, since the bug it replaced was a setter reporting success for a write it had dropped — and
    this extends that honesty one step, to replacement.

    Three cases stay quiet, or the notice becomes noise a reviewer learns to dismiss:

    - **A first write.** There was nothing to replace.
    - **A re-save the caller itself made**, i.e. it supplied the version currently stored.
    - **A kind that carries no version.** The shipped writers (verdicts, composites) were never asked for
      one, so every re-save of theirs would report a conflict that is really just a second save.

    A gate decision written with NO base over an existing row IS reported: a client that cannot say what it
    replaced has in fact replaced something blind, and reporting it is what makes the client send a version.
    """
    if kind not in GATE_DECISION_KINDS:
        return None
    try:
        item_key = artifacts.item_key_for(kind=kind, payload=payload)
    except ValueError:
        return None  # an invalid payload is about to be rejected by validation anyway
    prior = artifacts.get_one(owner=owner, job_id=job_id, kind=kind, item_key=item_key)
    if prior is None or (base is not None and prior.updated_at == base):
        return None
    return {"replacedUpdatedAt": prior.updated_at, "message": _CONFLICT_MESSAGE}


@app.put("/api/harmonize/jobs/{job_id}/artifacts/{kind}")
def put_artifact(
    job_id: str, kind: str, payload: dict[str, Any], request: Request, base: float | None = None
) -> dict[str, Any]:
    """Upsert one artifact. Its identity (and so what it replaces) is derived by its kind.

    ``base`` is the ``updatedAt`` the caller last saw for this identity. Supplying it is what lets the
    response distinguish "your write created this" from "your write replaced a value written by another
    session" — see :func:`_conflict_for`. Omitting it is legal, and over an existing gate decision it is
    itself reported as a conflict.
    """
    job, owner = _artifact_target(job_id, request)
    _refuse_past_gate(job, kind)
    artifacts = store.artifacts
    if artifacts is None:
        raise HTTPException(status_code=503, detail="Persistence is not configured on this server")
    # The version is the ROW's, served on read (08-28 3f): a client echoing a served row back must not plant a
    # stale copy of it inside the payload.
    payload = {k: v for k, v in payload.items() if k != UPDATED_AT}
    # An accepted generated element's two keys are minted HERE, server-side: a client-supplied digest is not
    # a digest, a client-supplied identifier is not an identity, and `published` must not be settable by
    # including a field on an acceptance (publishing is a separate, explicit, later opt-in).
    if kind == ACCEPTED_GENCDE:
        with _writable_run():
            try:
                payload = accept_gencde(payload, owner_subject=owner)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
    with _writable_run():
        # Read what is there BEFORE replacing it: after the upsert the prior value is gone, and with it any
        # way to tell the reviewer that theirs was not the version they were looking at.
        conflict = _conflict_for(artifacts, owner=owner, job_id=job_id, kind=kind, payload=payload, base=base)
        try:
            stored = artifacts.put(owner=owner, job_id=job_id, kind=kind, payload=payload, pinned=_is_pinned(job))
        except ValueError as exc:  # the kind's own validation: a malformed payload is the caller's error, not a 500
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "kind": stored.kind,
        "itemKey": stored.item_key,
        "updatedAt": stored.updated_at,
        "conflict": conflict,
    }


@app.delete("/api/harmonize/jobs/{job_id}/artifacts/{kind}/{item_key:path}", status_code=204)
def delete_artifact(job_id: str, kind: str, item_key: str, request: Request) -> None:
    job, owner = _artifact_target(job_id, request)
    _refuse_past_gate(job, kind)
    artifacts = store.artifacts
    if artifacts is None:
        raise HTTPException(status_code=503, detail="Persistence is not configured on this server")
    with _writable_run():
        if _is_pinned(job):
            raise ReadOnlyRunError(f"{job_id} is the shared demo and cannot be modified — clone it to keep your work")
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

    `declaredScore` names a score DECLARED on Gate 1 (its ``composite_swap`` rows) and matches exactly those
    components — Gate 4's "Match" (08-28 1f, decision Q5). The declaration is the definition, so nothing is
    transcribed: one model call, the match.
    """

    sourceText: str | None = None
    sourceRef: str | None = None
    definition: dict[str, Any] | None = None
    declaredScore: str | None = None
    overrides: dict[str, str | None] | None = None
    hybrid: bool = False


def _harmonized(job: Job, subject: str | None) -> tuple[dict[str, Any] | None, list[dict[str, Any]], bool]:
    """``(payload, records, staged)`` — the run's concepts as the paid routes over them must read them.

    A STAGED run keeps its payload in the checkpoint its gates share (D-02), so ``job.result`` is empty while it
    is parked — which is why composite / analysis-ideas / regenerate-specs used to 409 on every staged run (live
    verify 3 F20). This reads the same checkpoint-aware payload the exports do and, on a staged run, the same
    EFFECTIVE records (:func:`backend.export_decisions.effective_records`: scope, renames, target picks, recode
    edits), so a paid action is made against the concepts the reviewer left and every export will carry. A
    legacy one-shot run reads its result's records exactly as it always has.
    """
    payload = _export_payload(job)
    if payload is None:
        return None, [], False
    grouped = store.artifacts_for(job, subject) or {}
    if export_decisions.is_staged(job.gate_position, grouped):
        return payload, export_decisions.effective_records(payload, job.config or {}, grouped), True
    return payload, list(payload.get("records") or []), False


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


class ScoreComponentsBody(BaseModel):
    """The text the free read (`/score/extract`) returned, and the handle it came with.

    The TEXT, not the file: the reviewer has already looked at it, and re-uploading would either double the
    parse or let the two steps disagree about what was read. ``sha256`` is that read's own fingerprint — when
    supplied, text that does not hash to it is refused, so the proposal is always of the thing looked at.
    """

    text: str
    sha256: str | None = None
    provenance: str = ""


@app.post("/api/harmonize/jobs/{job_id}/score/components")
def score_components(
    job_id: str,
    body: ScoreComponentsBody,
    request: Request,
    x_anthropic_key: Annotated[str | None, Header()] = None,
    x_provider_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """PROPOSE a score's component names from already-read text — one paid model call (08-16e).

    Extraction PROPOSES, the reviewer disposes: this writes NO declaration and matches nothing. The list comes
    back for the reviewer to accept, edit or discard; accepting writes ordinary ``composite_swap`` rows from
    the panel, indistinguishable from typed ones. It reuses core's ``extract_score_definition`` on its own.

    JOB-SCOPED, unlike ``score_extract``. That route is job-independent so it can run before a run exists and
    stay $0; this one CHARGES, and a charge belongs to a run: it is billed on the run's own configured model
    (``model_tag``), refused on a passed Gate 1 (the panel is a record there) and on the shared demo, and cached
    per user on that run. The panel lives on Gate 1, where a run always exists. When the declaration moves to
    Setup (todo 2026-09-25) the same helper can back a sibling there; this route does not pretend to be one.

    Refusals, all BEFORE anything is spent: unknown run (404), shared demo (403), a passed Gate 1 (409), empty
    text (400), text over :data:`MAX_COMPONENT_EXTRACT_CHARS` (413 — never truncated), a handle that does not
    match the text (400), and no provider key (400, as on the other paid gate action).

    NOT CHARGED TWICE: the answer — including "nothing found", which also cost a call — is cached on the run
    under the text's sha256 + model, and the same text returns it with ``cached: true`` and no provider call.
    A FAILURE (an unreadable reply, a provider error) is not cached, so pressing again genuinely retries.

    BYOK: the key rides ``X-Provider-Key`` / ``X-Anthropic-Key`` for this request only — never persisted.
    """
    import hashlib

    from backend.artifact_kinds import COMPOSITE_SWAP, SCORE_COMPONENT_PROPOSAL
    from backend.composite import MAX_COMPONENT_EXTRACT_CHARS, UnreadableReplyError, propose_components
    from backend.engine.llm import build_llm_client
    from backend.llm_errors import llm_call

    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    with _writable_run():
        if _is_pinned(job):
            raise ReadOnlyRunError(
                f"{job_id} is the shared demo and cannot spend on extracting components — clone it into a run "
                "of your own, or type the components yourself"
            )
    # The proposal exists only to become Gate 1's `composite_swap` declaration, so it freezes with it.
    _refuse_past_gate(job, COMPOSITE_SWAP)

    text = body.text or ""
    if not text.strip():
        raise HTTPException(
            status_code=400, detail="There is no text to extract components from — read a document first."
        )
    if len(text) > MAX_COMPONENT_EXTRACT_CHARS:
        raise HTTPException(
            status_code=413,
            detail=(
                f"This document is {len(text):,} characters; extracting components reads at most "
                f"{MAX_COMPONENT_EXTRACT_CHARS:,}, and a longer one is refused rather than cut short — half a "
                "paper gives a plausible but incomplete list. Read the section or supplement that holds the "
                "component table instead, or type the components below."
            ),
        )
    digest = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
    if body.sha256 and body.sha256.strip().lower() != digest:
        raise HTTPException(
            status_code=400,
            detail="This text is not the text that was read (its fingerprint differs). Read the document again.",
        )

    model_tag = str(job.config.get("model_tag") or "")
    owner = principal_of(subject, job)
    artifacts = store.artifacts
    item_key = f"{digest}|{model_tag}"
    if artifacts is not None:
        prior = artifacts.get_one(owner=owner, job_id=job_id, kind=SCORE_COMPONENT_PROPOSAL, item_key=item_key)
        if prior is not None:
            return {**prior.payload, "cached": True}

    key = x_provider_key or x_anthropic_key
    if _no_anthropic_key(job.config, key):
        raise key_required(
            "Enter your Anthropic API key to extract the components — it is one model call and the key "
            "clears on reload. Nothing was charged; you can still type the components yourself."
        )

    client = build_llm_client(job.config.get("model_tag"), key)
    try:
        with llm_call(model=job.config.get("model_tag")):
            proposal = propose_components(text, client.complete, provenance=body.provenance)
    except UnreadableReplyError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        # The one paid call is billed to the run (Gate 1's line) — also when its reply was unreadable, since
        # it was charged all the same. A cached repeat returned above and never reaches here (08-28 1a, F5).
        billing.bill_client(store, job_id, billing.SCORE_COMPONENTS, client)

    payload = {
        **proposal,
        "sha256": digest,
        "nChars": len(text),
        "provenance": body.provenance,
        "model": model_tag,
    }
    if artifacts is not None:
        with _writable_run():
            artifacts.put(owner=owner, job_id=job_id, kind=SCORE_COMPONENT_PROPOSAL, payload=payload)
    return {**payload, "cached": False}


@app.get("/api/harmonize/jobs/{job_id}/score/suggestions")
def score_suggestions(job_id: str, request: Request) -> dict[str, Any]:
    """Gate 1's SUGGESTIONS for the declared score — the free half of the match: retrieval only, no model, $0.

    08-28 Decision 6 (option A). The paid match is on Gate 4 (decision Q5), after Gate 1 has been continued, so a
    live Gate 1 had no matches to seed its scope from. This runs core's ``suggest_groups`` for every score declared
    on the run (its ``composite_swap`` rows) against Gate 1's EFFECTIVE groups (:func:`_gate1_membership`: the
    split's members with the reviewer's moves applied and their New groups included), and returns each reached
    group with the dense cosine of its best member plus core's calibrated cut-off. The screen seeds and tags the
    groups that clear it AS SUGGESTIONS; the verdict stays on Gate 4.

    $0 by construction: the embedder is the run's cache-backed BioLORD (``backend.composite._embedder``, the same
    ``~/.ddharmon/embeddings.db`` a run and the Gate 4 match use), no LLM client is built and nothing is billed.
    Without the dense encoder the answer is "no suggestions" with core's reason — never a threshold over a lexical
    score, which is not comparable across components. A read: no gate refusal, and a shared demo (whose
    declarations live in the browser, not here) gets an empty list.
    """
    from backend import composite as composite_web
    from backend.declared_score import declared_scores, gate1_suggestions

    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    payload = _export_payload(job) or {}
    declared = declared_scores(store.artifacts_for(job, subject))
    embed = composite_web._embedder() if declared and composite_web.encoder_available() else None
    membership = _gate1_membership(payload, _gate1_overrides(job, subject, payload)) if declared else {}
    return gate1_suggestions(declared, payload.get("fieldIndex"), membership, embed=embed)


@app.post("/api/harmonize/score/extract")
async def score_extract(file: Annotated[UploadFile, File()]) -> dict[str, Any]:
    """Extract a score's definition text from an uploaded PDF or Word document — with NO run required.

    Deliberately job-INDEPENDENT, unlike its sibling above. Setup needs this BEFORE a run exists: the whole
    point of the extraction step is the zero-cost review-before-you-spend path (a publisher PDF may be an
    access-check interstitial, and its component table may not survive extraction at all), and at Setup
    there is no run id to scope it to. Requiring one would force a user to start a run in order to find out
    whether the document they have can define the score they want to scope it by.

    $0: no LLM call, no provider client. Authenticated — it reads a document the caller uploaded, which is
    not a demo surface, so a guest gets the auth-required signal rather than a generic error.
    """
    from backend.composite import resolve_source

    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Document too large (20 MB cap)")
    try:
        source = resolve_source(upload=data, filename=file.filename or "uploaded document")
    except (ValueError, ImportError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"text": source.text, "provenance": source.provenance, "sha256": source.sha256, "nChars": len(source.text)}


# --- the PRE-START embedding export -----------------------------------------------------------
#
# JOB-LESS BY NECESSITY, not by preference. Dictionaries live client-side until Start — the frontend's
# `startHarmonize` builds its multipart body at press time — so before a run exists there is no
# server-side per-dictionary state to hang a download off. `score_extract` above is the precedent: a bare
# upload, no job id, no run created, no provider called, $0. The alternative considered and rejected was
# creating a draft job so the job-scoped `prepared.csv` could be reused; that is run state whose only
# purpose is a download, and the product would then have to reap it.
#
# WHAT IT IS FOR. The reviewer's own rows come back with ONE column appended: the exact string
# `to_embedding_text()` composes, which is what clustering consumes and what is invisible everywhere else
# in the product. It is free, and it is reachable before the first charge — that is the point of it.


def _safe_stem(name: str) -> str:
    """A download filename rebuilt from a safe alphabet rather than escaped.

    The upload name is user-supplied and a response header is the wrong place to trust one — the same
    reasoning (and the same alphabet) as ``prepared_export``.
    """
    return "".join(c if (c.isalnum() or c in "_-.") else "_" for c in Path(name).stem) or "dictionary"


def _mapped_uploads(files: list[UploadFile], config: str, tmp: Path) -> list[dict[str, Any]]:
    """Save the uploads under ``tmp`` and pair each with its declared cohort name and column mapping.

    THE SAME PAYLOAD SHAPE `/batch` TAKES (``{dictionaries: [{filename, cohortName, columnRoles}]}``), and
    the same refusals at the door (role rule, participant-level data, zero variables). Divergence between what the export accepts and what a run accepts
    is how a reviewer gets a clean download for a file the run then rejects.
    """
    try:
        cfg = json.loads(config)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"config is not valid JSON: {exc}") from exc

    saved: dict[str, Path] = {}
    for up in files:
        dest = tmp / Path(up.filename or "upload.csv").name
        with open(dest, "wb") as fh:
            shutil.copyfileobj(up.file, fh)
        saved[dest.name] = dest

    declared = cfg.get("dictionaries") or []
    if not declared:
        raise HTTPException(status_code=400, detail="config.dictionaries is empty — nothing to export")

    specs: list[dict[str, Any]] = []
    for d in declared:
        fname = Path(str(d.get("filename", ""))).name
        if fname not in saved:
            raise HTTPException(status_code=400, detail=f"Uploaded file missing for {fname!r}")
        roles = {k: v for k, v in (d.get("columnRoles") or {}).items() if v}
        # The same rule `/batch` applies, from the same place — an export that took a mapping the run refuses
        # would hand the reviewer a clean-looking file for a dictionary that cannot be run.
        role_error = role_requirement_error(fname, roles)
        if role_error is not None:
            raise HTTPException(status_code=400, detail=role_error)
        # Refused here as well as at `/batch`: a standing product prohibition belongs at every door, and
        # this one accepts an upload without a run in front of it.
        offender = _participant_level_column(saved[fname])
        if offender is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{fname!r} looks like participant-level data: the column {offender!r} holds a unique "
                    "value on every row. Upload a data DICTIONARY — one row per variable, describing the "
                    "fields — not the participant records themselves. ddharmon harmonizes metadata and "
                    "never accepts participant data."
                ),
            )
        cohort_name = str(d.get("cohortName") or Path(fname).stem)
        # And the zero-variable refusal `/batch` makes, for the same reason: a download of a file that loads
        # nothing is a clean-looking answer to a question the run will refuse.
        empty_error = zero_variable_error(fname, saved[fname], cohort_name, roles)
        if empty_error is not None:
            raise HTTPException(status_code=400, detail=empty_error)
        specs.append(
            {
                "path": saved[fname],
                "filename": fname,
                "cohort_name": cohort_name,
                "column_roles": roles,
            }
        )
    return specs


@app.post("/api/harmonize/dictionary/embedding.csv")
async def dictionary_embedding_csv(
    files: Annotated[list[UploadFile], File()],
    config: Annotated[str, Form()],
) -> StreamingResponse:
    """ONE unmapped-yet-uploaded dictionary, returned with the string clustering will consume appended.

    No job id, no run created, no model called, $0 — see the section header. ``config`` is the same shape
    ``/batch`` takes, narrowed to exactly one entry: one download is about one file, and accepting a list
    here would leave the response's ``Content-Disposition`` naming an arbitrary member of it.
    """
    import tempfile

    from backend.engine.adapter import build_embedding_export

    with tempfile.TemporaryDirectory(prefix="ddharmon-embed-") as td:
        specs = _mapped_uploads(files, config, Path(td))
        if len(specs) != 1:
            raise HTTPException(status_code=400, detail="This export is per dictionary — send exactly one file")
        spec = specs[0]
        try:
            export = build_embedding_export(
                spec["path"], cohort_name=spec["cohort_name"], column_roles=spec["column_roles"]
            )
        except ValueError as exc:
            # A STATED ERROR, never a partial file. An empty-looking CSV reads as "my dictionary is empty"
            # rather than as a failure, and the reviewer would act on it.
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - an unreadable upload is the caller's problem, not a 500
            raise HTTPException(status_code=400, detail=f"{spec['filename']!r} could not be read: {exc}") from exc

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(export.header)
        writer.writerows(export.rows)
        body = buf.getvalue()

    return StreamingResponse(
        iter([body]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_stem(spec["filename"])}_embedding.csv"',
            "X-Ddharmon-Rows": str(export.n_rows),
            "X-Ddharmon-Variables": str(export.n_variables),
            # Header name kept for the FE contract; the value is now rows that shared a repeated name and
            # were KEPT AS DISTINCT (disambiguated), not dropped — see EmbeddingExport.n_repeated_kept.
            "X-Ddharmon-Collapsed": str(export.n_repeated_kept),
            "X-Ddharmon-Nothing-To-Embed": str(export.n_nothing_to_embed),
            # Comma-joined and already capped by the builder: "some name repeats" is not actionable, and
            # six thousand of them is not a header.
            "X-Ddharmon-Repeated-Names": ",".join(export.repeated_names),
        },
    )


@app.post("/api/harmonize/dictionary/embedding.xlsx")
async def dictionary_embedding_workbook(
    files: Annotated[list[UploadFile], File()],
    config: Annotated[str, Form()],
) -> StreamingResponse:
    """The WHOLE upload set as one workbook — a sheet per dictionary, each with the embedding column.

    Job-less on the same terms as its CSV sibling above and for the same reason: this is offered once every
    dictionary is mapped and BEFORE the first charge, so there is no run to scope it to. It is the same
    computation over N files rather than a second implementation of it.
    """
    import tempfile

    from backend.export.workbook import build_embedding_workbook

    with tempfile.TemporaryDirectory(prefix="ddharmon-embed-") as td:
        specs = _mapped_uploads(files, config, Path(td))
        try:
            data = build_embedding_workbook(specs)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - an unreadable upload is the caller's problem, not a 500
            raise HTTPException(status_code=400, detail=f"The workbook could not be built: {exc}") from exc

    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="ddharmon_embedding_text.xlsx"',
            "X-Ddharmon-Sheets": str(len(specs)),
        },
    )


@app.post("/api/harmonize/jobs/{job_id}/composite")
def composite(
    job_id: str,
    body: CompositeBody,
    request: Request,
    x_anthropic_key: Annotated[str | None, Header()] = None,
    x_provider_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Derive a composite/derived-variable spec for this run — can a published score be computed, and how?

    One opt-in BYOK pass over the run's OWN concepts (metadata only, like analysis-ideas): it transcribes the
    score from the supplied document, matches each component to a concept actually present, and returns the
    feasibility verdict + per-cohort coverage + the derivation recipe. Cached on the job (replacing any
    previous spec for the same score) so a re-view isn't re-billed.

    The concepts are the reviewer's (:func:`_harmonized`): on a staged run, the checkpoint's effective records,
    so Gate 4 matches against the concepts as they will be exported (08-28 1f, F20). ``declaredScore`` matches
    the score declared on Gate 1 in ONE call; a passed Gate 1 freezes editing that declaration, never matching
    it, so no gate refusal applies here. Its spend is billed under ``composite`` and returned as ``billedUsd``.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    payload, records, staged = _harmonized(job, subject)
    if not records:
        raise HTTPException(status_code=409, detail="This run has no harmonized concepts to build a score from.")

    from backend.artifact_kinds import COMPOSITE
    from backend.composite import derive, resolve_source
    from backend.declared_score import definition_for, find_declared, scoped_field_index
    from backend.engine.llm import build_llm_client
    from backend.llm_errors import llm_call

    key = x_provider_key or x_anthropic_key
    # A re-derive from an existing definition needs no document; a first derivation does; a declared score IS
    # its definition. Every refusal below is made BEFORE anything is spent.
    source = None
    declared = None
    if body.declaredScore is not None:
        declared = find_declared(store.artifacts_for(job, subject), body.declaredScore)
        if declared is None:
            raise HTTPException(
                status_code=409,
                detail=f"No score named {body.declaredScore.strip()!r} was declared on this run's Gate 1.",
            )
        if _no_anthropic_key(job.config, key):
            raise key_required(
                "Enter your Anthropic API key to match the declared score — it is one model call and the "
                "key clears on reload. Nothing was charged."
            )
        source = definition_for(declared)
    elif body.definition is None:
        try:
            source = resolve_source(text=body.sourceText, ref=body.sourceRef)
        except (ValueError, ImportError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Variable-level matching (augment): the run's field index lets a component bind to a single source
    # variable, not only a harmonized concept group. Absent -> group-only. On a staged run it is cut to the
    # final records' members, so a scoped-out variable never takes a shortlist slot.
    field_index = (payload or {}).get("fieldIndex")
    if staged:
        field_index = scoped_field_index(field_index, records)

    # Same model/provider the run was configured with. BYOK: in-memory for this request only.
    model_tag = job.config.get("model_tag")
    client = build_llm_client(model_tag, key)
    billed = 0.0
    try:
        # llm_call: a rejected key / rate limit / overload is the provider's condition, not our crash.
        with llm_call(model=model_tag):
            spec = derive(
                records,
                source or _definition_from_payload(body.definition or {}),
                client.complete,
                overrides=body.overrides,
                hybrid=body.hybrid,
                field_index=field_index,
            )
    except ValueError as exc:
        # e.g. the document defines no score, or its text extraction came back empty — a 400, not a 500.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        # Whatever the derivation's calls cost is billed to the run (a free re-derive drains nothing).
        billed = billing.bill_client(store, job_id, billing.COMPOSITE, client)
    if declared is not None:
        spec["sourceKind"] = "declaration"  # not a transcribed document: the reviewer's own Gate 1 list
    spec["billedUsd"] = billed
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

    ON A PARKED (staged) RUN the record lives in its checkpoint, and is read from and written back to it
    (08-28 1f, F20) — only at Gate 3, whose subject the recodes are. Before Gate 3 the leg into it regenerates
    every spec (a regeneration here would be paid for and then overwritten); after it, Gate 3's recodes are a
    record. The record must be one the reviewer kept (their effective records); the checkpoint's own copy is the
    base, so the reviewer's overlays (renames, edits, rejections) stay decisions and are never baked into it.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    parked = _checkpoint_for(job) is not None
    if parked and job.gate_position != "gate3":
        raise HTTPException(
            status_code=409,
            detail="On a staged run, recodes are regenerated at Gate 3. Nothing was charged.",
        )
    payload, records, _staged = _harmonized(job, subject)
    kept = {r.get("id") for r in records}
    rec_ui = next((r for r in (payload or {}).get("records") or [] if r.get("id") == record_id), None)
    if rec_ui is None or record_id not in kept:
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
    finally:
        billing.bill_client(store, job_id, billing.SPECS_REGEN, client)  # the regeneration's calls (08-28 1a)
    if parked:
        _replace_checkpoint_record(job_id, record_id, cast("dict[str, Any]", updated))
    else:
        store.replace_result_record(job_id, record_id, cast("dict[str, Any]", updated))
    return {"record": updated}


def _replace_checkpoint_record(job_id: str, record_id: str, new_record: dict[str, Any]) -> None:
    """Swap one record of a parked run's checkpoint — the staged sibling of ``store.replace_result_record``.

    Re-read under the run's checkpoint lock: the paid call before this took seconds, and its own bill has just
    rewritten the checkpoint's cost block; writing back the copy read before the call would erase that bill.
    """
    with checkpoint_lock(job_id):
        latest = store.get(job_id)
        fresh = _checkpoint_for(latest) if latest is not None else None
        if latest is None or fresh is None:
            return
        records = [new_record if r.get("id") == record_id else r for r in fresh.result.get("records") or []]
        write_checkpoint(
            fresh.path.parent if fresh.path is not None else Path(latest.config["work_dir"]),
            job_id=fresh.job_id,
            gate=fresh.gate,
            result={**fresh.result, "records": records},
            responses=fresh.responses,
            realized_cost=fresh.realized_cost,
        )
        # The payload changed, so the version token the gate screens refetch on moves once.
        store.update(job_id, result_version=latest.result_version + 1)


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


@app.get("/api/harmonize/jobs/{job_id}/prepared.csv")
def prepared_export(job_id: str, request: Request, cohort: str) -> StreamingResponse:
    """Gate 0's export: ONE uploaded dictionary, returned with the preparation step's output appended.

    The reviewer's own columns come back verbatim and in order, followed by the prepared name, the prepared
    description, and the exact string the next step embeds — so the three things Gate 0 talks about can be
    read on one row instead of inferred from a sampled example.

    A GET, and free. It re-reads the run's retained upload and re-runs the rule-based preparation locally;
    no model is called, nothing is embedded, and no run state is touched — which is what lets Gate 0 offer
    it without qualifying its "nothing has been charged yet" claim.

    Available BEFORE the run has a result, deliberately: Gate 0 is where the question is asked, and the run
    is parked there with no result by construction.
    """
    from backend.engine.adapter import build_prepared_export, run_prepares

    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    spec = next((d for d in (job.dict_specs or []) if str(d.get("cohort_name")) == cohort), None)
    if spec is None:
        # Named rather than defaulted to the first dictionary: silently exporting a different cohort's file
        # is worse than failing, because the file that arrives looks exactly like the one that was asked for.
        raise HTTPException(status_code=404, detail=f"This run has no dictionary named {cohort!r}")
    source = Path(str(spec.get("path", "")))
    if not source.exists():
        raise HTTPException(status_code=409, detail="The uploaded file for this dictionary is no longer available")

    header, rows = build_prepared_export(
        source,
        cohort_name=cohort,
        column_roles=dict(spec.get("column_roles") or {}),
        # The run's OWN recorded choice: since 08-14e a run does not prepare, and its embedding column must be
        # the text it embedded — the same string the run workbook below carries for that variable.
        prepare=run_prepares(job.config),
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    # The filename is echoed back into a response header, so it is rebuilt from a safe alphabet rather
    # than escaped: the upload name is user-supplied and a header is the wrong place to trust one.
    stem = "".join(c if (c.isalnum() or c in "_-.") else "_" for c in source.stem) or "dictionary"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{stem}_prepared.csv"'},
    )


@app.get("/api/harmonize/jobs/{job_id}/embedding.xlsx")
def run_embedding_workbook(job_id: str, request: Request) -> StreamingResponse:
    """A STARTED run's dictionaries as ONE workbook — a sheet each, with the exact text every variable embedded.

    The job-scoped sibling of the pre-Start ``POST /dictionary/embedding.xlsx``. That one exists only while the
    files are still in the browser (Setup's compose stage); once a run exists Setup's export card offered only
    per-dictionary CSVs, so the workbook a reviewer had before Start was gone after it (phase-8 final review,
    round 1). The run retains its uploads, so this re-reads them — the same reasoning as ``prepared.csv``.

    A GET, and free: no model is called, nothing is embedded, no run state is touched. The SAME builder as the
    pre-Start workbook, so the two cannot disagree — except that the text follows the run's own recorded
    ``preprocess`` (``run_prepares``) rather than the product default, because it is a claim about what THIS
    run embedded.

    Refuses rather than dropping a sheet: a workbook whose sheet count silently disagrees with the run's
    dictionaries is the failure a reviewer is least likely to notice.
    """
    from backend.engine.adapter import run_prepares
    from backend.export.workbook import build_embedding_workbook

    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found")
    specs = [
        {
            "path": Path(str(d.get("path", ""))),
            "filename": Path(str(d.get("path", ""))).name,
            "cohort_name": str(d.get("cohort_name") or Path(str(d.get("path", ""))).stem),
            "column_roles": dict(d.get("column_roles") or {}),
        }
        for d in (job.dict_specs or [])
    ]
    if not specs:
        raise HTTPException(status_code=409, detail="This run kept no record of its dictionaries")
    gone = [s["cohort_name"] for s in specs if not s["path"].exists()]
    if gone:
        raise HTTPException(
            status_code=409,
            detail=f"The uploaded file for {gone[0]!r} is no longer available, so the workbook would be missing it",
        )
    try:
        data = build_embedding_workbook(specs, prepare=run_prepares(job.config))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Named for the run rather than the pre-Start file's fixed name, so two runs' workbooks do not overwrite each
    # other in a Downloads folder. The id is rebuilt from the safe alphabet like every other echoed filename.
    stem = "".join(c if (c.isalnum() or c in "_-") else "_" for c in job_id[:8]) or "run"
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="ddharmon_{stem}_embedding_text.xlsx"',
            "X-Ddharmon-Sheets": str(len(specs)),
        },
    )


#: The staged-run additions to the EITL TSV, appended AFTER the legacy columns so every legacy column keeps its
#: index (index-based consumers of the legacy file keep working). Present only on a staged run — a legacy
#: one-shot run exports exactly the legacy header.
_EITL_STAGED_COLS = [
    "generatedConcept", "modelCdeId", "targetPickedBy", "gencdeEdit", "rejectedTransforms", "transformEdits",
    "modelVerdict",
]  # fmt: skip

#: 08-28 1d: how same-cohort variables sharing a target column combine (``backend/combine_rules.py``) — the rule
#: the notebook ran for this record's members, JSON, or "" when none of its members shares a column.
_EITL_COMBINE_COLS = ["combineRules"]

#: 08-28 3f: the SKOS relation on the record's target, who asserted it (reviewer / model / ""), the model's own
#: relation beside it, and the reviewer's note (``backend/export_decisions.py``). Appended last: no index moves.
_EITL_RELATION_COLS = ["relation", "relationBy", "modelRelation", "relationNote"]

#: Review round 2: the variables the reviewer removed from this concept at Gate 3 (``;``-joined, "" for none) —
#: already absent from ``members`` / ``nMembers`` / ``nTransforms``, named here so the absence is not a silent one.
#: Appended last: no index moves.
_EITL_REMOVAL_COLS = ["removedMembers"]

#: 08-30: the gates Full auto committed and nobody reviewed (``gate1;gate2;gate3``). Appended last, and ONLY on such
#: a run: a guided run's queue keeps exactly the columns above.
_EITL_AUTO_COLS = ["gatesAutoAccepted"]


def _export_payload(job: Job) -> dict[str, Any] | None:
    """The result an export serializes: a parked run's checkpoint (D-02), else the finished run's result."""
    ckpt = _checkpoint_for(job)
    if ckpt is not None:
        return ckpt.result
    return job.result


@app.get("/api/harmonize/jobs/{job_id}/export")
def export(job_id: str, request: Request, format: str = "eitl_tsv") -> Any:
    """Serialize one run's export set in one format.

    A STAGED run (parked at a gate, or carrying gate decisions) exports what the REVIEWER left: its payload is
    read from the checkpoint the gates share, and the caller's own gate decisions are folded in by
    :mod:`backend.export_decisions` — the single place they are applied, so every format agrees. A legacy
    one-shot run exports byte-for-byte as it always has.

    Owner-checked like its sibling read routes: gate decisions are per user, so the file is too.
    """
    subject = _subject(request)
    job = store.get(job_id)
    if job is None or not _visible_to(job, subject):
        raise HTTPException(status_code=404, detail="Job not found or not complete")
    payload = _export_payload(job)
    if payload is None:
        raise HTTPException(status_code=404, detail="Job not found or not complete")
    grouped = store.artifacts_for(job, subject)
    if format == "score_json":
        # The declared score's verdict + recipe ride their OWN file (08-28 1f, Q5) — see backend/declared_score.py.
        return _score_download(job, grouped)
    if export_decisions.is_staged(job.gate_position, grouped or {}):
        return _export_staged(job, payload, grouped or {}, format)
    return _export_legacy(job, payload, format)


def _score_download(job: Job, grouped: dict[str, Any] | None) -> JSONResponse:
    """``score_json``: every declared score with its status, verdict and derived spec (recipe included)."""
    from backend.artifact_kinds import COMPOSITE
    from backend.declared_score import score_export

    # No artifact store configured: a finished run's composites are still on its in-memory mirror.
    source = grouped if grouped is not None else {COMPOSITE: job.composites or []}
    return JSONResponse(
        score_export(source),
        headers={"Content-Disposition": f'attachment; filename="score_{job.job_id[:8]}.json"'},
    )


def _download(body: str, fmt: str, ext: str, job_id: str) -> StreamingResponse:
    media = "text/csv" if ext == "csv" else "text/tab-separated-values"
    return StreamingResponse(
        iter([body]),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{fmt}_{job_id[:8]}.{ext}"'},
    )


def _notebook_response(result: dict[str, Any], fmt: str, job: Job) -> JSONResponse:
    lang = "r" if fmt == "notebook_r" else "py"
    nb = build_notebook(result, lang, job.display_name)
    return JSONResponse(
        nb,
        media_type="application/x-ipynb+json",
        headers={"Content-Disposition": f'attachment; filename="harmonization_{job.job_id[:8]}.{lang}.ipynb"'},
    )


def _eitl_order(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        records,
        key=lambda r: (
            _EITL_RANK.get(r["verdict"], 3),
            r["cosines"]["top1"] if r["cosines"]["top1"] is not None else 0.0,
        ),
    )


def _eitl_row(r: dict[str, Any], dec: dict[str, Any], n_transforms: int) -> list[Any]:
    cde = r["cde"] or {}
    return [
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
        n_transforms,
        _clean(r["idealCde"]),
        _clean(r["rationale"]),
        dec.get("decision", ""),
        _clean(dec.get("note", "")),
        _transform_decisions_json(dec),
        _gencde_decision_json(dec),
    ]


def _export_legacy(job: Job, result: dict[str, Any], format: str) -> Any:
    """The pre-08-27 export, unchanged: raw records plus the legacy workbench verdicts."""
    records: list[dict[str, Any]] = result["records"]
    decisions = job.decisions

    if format in ("notebook_py", "notebook_r"):
        return _notebook_response(result, format, job)

    if format == "records_json":
        return JSONResponse(
            records, headers={"Content-Disposition": f'attachment; filename="records_{job.job_id[:8]}.json"'}
        )

    if format == "decisions_csv":
        cols, rows, sep, ext = _DECISIONS_COLS, records, ",", "csv"
    else:
        format = "eitl_tsv"
        cols, sep, ext = _EITL_COLS, "\t", "tsv"
        rows = _eitl_order(records)

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
            w.writerow(_eitl_row(r, dec, len(r["transforms"])))
    return _download(buf.getvalue(), format, ext, job.job_id)


def _export_staged(job: Job, payload: dict[str, Any], grouped: dict[str, Any], format: str) -> Any:
    """A staged run's export: the effective records (see :mod:`backend.export_decisions`) in every format.

    * ``eitl_tsv`` — the legacy columns over the effective records (``concept`` = the reviewer's name,
      ``cdeId`` = the reviewer's pick, ``nTransforms`` counts non-rejected recodes), then
      :data:`_EITL_STAGED_COLS` carrying what the reviewer changed and what the model had.
    * ``records_json`` — the effective records, with the same additive keys.
    * ``notebook_*`` — built over the effective records, so an edited recode is applied as edited and a
      rejected one is left out (and listed as excluded).
    * ``decisions_csv`` — the decision LOG: one row per gate decision with before -> after.
    """
    config = job.config or {}
    records = export_decisions.effective_records(payload, config, grouped)
    # 08-30: the gates Full auto committed, which no person reviewed. Every format below says so — and for a
    # guided run (none) adds nothing, so its files are byte for byte what they were.
    auto = export_decisions.auto_accepted_gates(config)
    if auto:
        decided = dict.fromkeys(auto, "auto")
        records = [{**r, "gateDecidedBy": decided} for r in records]

    if format in ("notebook_py", "notebook_r"):
        extra: dict[str, Any] = {"autoAcceptedGates": auto} if auto else {}
        return _notebook_response({**payload, "records": records, **extra}, format, job)

    if format == "records_json":
        return JSONResponse(
            records, headers={"Content-Disposition": f'attachment; filename="records_{job.job_id[:8]}.json"'}
        )

    buf = io.StringIO()
    if format == "decisions_csv":
        w = csv.writer(buf)
        w.writerow(export_decisions.DECISION_LOG_COLS)
        for row in export_decisions.decision_log_rows(payload, config, grouped):
            w.writerow([_clean(c) for c in row])
        return _download(buf.getvalue(), format, "csv", job.job_id)

    from backend.db import _verdicts_to_legacy

    decisions = _verdicts_to_legacy(grouped.get(VERDICT, [])) if grouped else job.decisions
    w = csv.writer(buf, delimiter="\t")
    # The review queue names the gates nobody reviewed (08-30) in one trailing column — present only on a run Full
    # auto committed, so a guided run's queue keeps its exact columns.
    auto_cols = _EITL_AUTO_COLS if auto else []
    w.writerow(
        _EITL_COLS + _EITL_STAGED_COLS + _EITL_COMBINE_COLS + _EITL_RELATION_COLS + _EITL_REMOVAL_COLS + auto_cols
    )
    for r in _eitl_order(records):
        dec = decisions.get(r["id"], {})
        model_cde = r.get("modelCde") or {}
        edits = export_decisions.transform_edits(r)
        w.writerow(
            _eitl_row(r, dec, len(export_decisions.active_transforms(r)))
            + [
                _clean(r.get("generatedConcept", "")),
                model_cde.get("id", ""),
                r.get("targetPickedBy", "model"),
                _clean(json.dumps(r["gencdeEdit"], sort_keys=True)) if r.get("gencdeEdit") else "",
                ";".join(export_decisions.rejected_sources(r)),
                _clean(json.dumps(edits, sort_keys=True)) if edits else "",
                r.get("modelVerdict", ""),
            ]
            + [_clean(json.dumps(r["combineRules"], sort_keys=True)) if r.get("combineRules") else ""]
            + [
                r.get("relation", ""),
                r.get("relationBy", ""),
                r.get("modelRelation", ""),
                _clean(r.get("relationNote", "")),
            ]
            + [_clean(";".join(r.get("removedMembers") or []))]
            + ([";".join(auto)] if auto else [])
        )
    return _download(buf.getvalue(), "eitl_tsv", "tsv", job.job_id)


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


# Whether each CDE catalog's vectors are already in the shared embedding cache — i.e. whether the next run embeds
# 22,743 catalog rows on the CPU or reads them all back. Checked in a background thread and kept in memory (see
# `cde_cache.WarmthMonitor`): health is polled, and a check loads the catalog and looks up every row. Filled by
# `scripts/warm_cde_cache.py`; re-checked by itself when a catalog file or the cache file changes.
_cde_warmth = cde_cache.WarmthMonitor(lambda: CDE_FILES, lambda path: load_spec(cde_spec_for(path)))


@app.get("/api/health")
def health() -> dict[str, Any]:
    """Liveness/readiness probe: process is up, plus which optional server-side assets are present.

    Used by the deploy runbook (systemd/nginx verification) and any future uptime check. Returns
    200 as soon as the app imports; ``cde``/``frontendBuilt`` flag whether the catalog TSVs and the
    built SPA are in place (a run with ``cdeSet != none`` needs the matching CDE file). ``channel``
    (``prod`` default / ``dev``) and ``coreVersion`` distinguish the dev deployment — which pins the
    core to an unreleased GitHub ref — from prod, which tracks the PyPI release.

    ``cdeCache`` reports, per catalog, how many of its rows the shared embedding cache already holds:
    ``{"checkedAt", "catalogs": {name: {"rows", "cached", "warm"}}}``. It never blocks this probe: the first
    poll starts a background check and reads ``null`` per catalog until it finishes (a couple of seconds on
    the full catalog), and a catalog whose file is gone carries an ``error`` instead of figures. ``cde`` keeps
    its exact shape.
    """
    return {
        "status": "ok",
        "version": app.version,
        "contractVersion": CONTRACT_VERSION,
        "channel": os.environ.get("DDHARMON_CHANNEL", "prod"),
        "coreVersion": _core_version(),
        "cde": {name: path.exists() for name, path in CDE_FILES.items()},
        "cdeCache": _cde_warmth.snapshot(),
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
