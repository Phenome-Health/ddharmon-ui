"""FastAPI app for the ddharmon harmonization GUI.

Endpoints (all under /api/harmonize):
    POST /detect            columns -> suggested column->role map (SchemaRegistry)
    POST /batch             multipart upload of dict files + config -> {jobId}
    GET  /stream/{job_id}   SSE progress (event: progress)
    GET  /result/{job_id}   full job snapshot (REST fallback)
    GET  /jobs              list jobs (summaries)
    DELETE /jobs/{job_id}   delete a job
    POST /jobs/{job_id}/verdict   persist a human approve/refine/reject decision (by recordId)
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
import os
import shutil
import threading
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from backend.demos import demo_job_id, list_demos, load_snapshot, seed_demos
from backend.engine import CONTRACT_VERSION
from backend.jobs import TERMINAL_STATES, store
from backend.notebook import build_notebook
from backend.runner import run_harmonization

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


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Prepopulate the Runs page with the precomputed demo(s) on startup so a fresh boot / restart is never
    empty. Durable by construction: re-seeded every startup, and demo jobs are exempt from TTL purging.
    No-op when no snapshot is bundled (e.g. a minimal deploy)."""
    seed_demos(store)
    yield


app = FastAPI(title="ddharmon Harmonization API", version="1.0.0", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    files: Annotated[list[UploadFile], File()],
    config: Annotated[str, Form()],
    x_anthropic_key: Annotated[str | None, Header()] = None,
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
        "cde_cohort": CDE_COHORT,
        "work_dir": str(work_dir),
        "cde_set": cde_set,
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
    display = cfg.get("displayName") or f"Run {job_id[:8]}"
    store.create(job_id, display, run_config)
    # api_key rides as a thread kwarg (in-memory, this job only) — never in run_config, which is persisted.
    threading.Thread(
        target=run_harmonization,
        args=(store, job_id, dict_specs, cde_spec, run_config),
        kwargs={"api_key": x_anthropic_key},
        daemon=True,
    ).start()
    return {"jobId": job_id}


# --- SSE + result ----------------------------------------------------------------------------
def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _fmt(x: float | None) -> str:
    return "" if x is None else f"{x:.3f}"


def _clean(s: Any) -> str:
    return str(s).replace("\t", " ").replace("\n", " ").replace("\r", " ")


@app.get("/api/harmonize/stream/{job_id}")
async def stream(job_id: str) -> StreamingResponse:
    if store.get(job_id) is None:
        raise HTTPException(status_code=404, detail="Job not found")

    async def gen() -> Any:
        store.purge_expired()
        while True:
            job = store.get(job_id)
            if job is None:
                yield _sse("error", {"message": "Job not found"})
                return
            yield _sse("progress", job.to_dict())
            if job.status in TERMINAL_STATES:
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/api/harmonize/result/{job_id}")
def result(job_id: str) -> dict[str, Any]:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


# --- jobs list / delete ----------------------------------------------------------------------
@app.get("/api/harmonize/jobs")
def list_jobs() -> list[dict[str, Any]]:
    return [j.summary_dict() for j in store.list()]


@app.delete("/api/harmonize/jobs/{job_id}", status_code=204)
def delete_job(job_id: str) -> None:
    if not store.delete(job_id):
        raise HTTPException(status_code=404, detail="Job not found")


# --- human decisions -------------------------------------------------------------------------
class VerdictBody(BaseModel):
    recordId: str
    decision: str  # approve | refine | reject
    note: str = ""


@app.post("/api/harmonize/jobs/{job_id}/verdict")
def submit_verdict(job_id: str, body: VerdictBody) -> dict[str, bool]:
    if body.decision not in ("approve", "refine", "reject"):
        raise HTTPException(status_code=400, detail="decision must be approve|refine|reject")
    if not store.set_decision(job_id, body.recordId, body.decision, body.note):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


# --- export ----------------------------------------------------------------------------------
# Export is built from the stable UIRecord contract (not from ddharmon) — one more place insulated from
# pipeline churn. eitl_tsv mirrors export_leanb_eitl_queue's intent (refine→novel→adopt first).
_EITL_COLS = [
    "recordId", "clusterId", "groupId", "concept", "verdict", "route", "cdeId", "cdeExternalId",
    "top1Cos", "chosenCos", "coverageGap", "floored", "crossCohort", "nMembers", "cohorts", "members",
    "nTransforms", "idealCde", "rationale", "humanDecision", "humanNote",
]  # fmt: skip
_DECISIONS_COLS = ["recordId", "concept", "verdict", "cdeId", "chosenCos", "humanDecision", "humanNote"]
_EITL_RANK = {"refine": 0, "novel": 1, "adopt": 2}


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
_DEMO_PHASES = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "specs"]


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
@app.get("/api/health")
def health() -> dict[str, Any]:
    """Liveness/readiness probe: process is up, plus which optional server-side assets are present.

    Used by the deploy runbook (systemd/nginx verification) and any future uptime check. Returns
    200 as soon as the app imports; ``cde``/``frontendBuilt`` flag whether the catalog TSVs and the
    built SPA are in place (a run with ``cdeSet != none`` needs the matching CDE file).
    """
    return {
        "status": "ok",
        "version": app.version,
        "contractVersion": CONTRACT_VERSION,
        "cde": {name: path.exists() for name, path in CDE_FILES.items()},
        "frontendBuilt": _DIST.exists(),
    }


# --- static frontend (prod) ------------------------------------------------------------------
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
