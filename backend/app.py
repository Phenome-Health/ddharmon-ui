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
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from backend.demos import list_demos, load_snapshot
from backend.engine import CONTRACT_VERSION
from backend.jobs import TERMINAL_STATES, store
from backend.notebook import build_notebook
from backend.runner import run_harmonization

# --- CDE catalog (server-side; not uploaded) -------------------------------------------------
# Repo root is the parent of backend/ (this file is backend/app.py). The CDE catalog is NOT
# shipped in this repo (data/cde/ is gitignored) — supply it on the server and/or point
# DDHARMON_CDE_DIR at it. See deploy/README.md. v2 REQUIRES a catalog (cdeSet must be endorsed|full).
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

app = FastAPI(title="ddharmon Harmonization API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dev/testing only: seed a couple of SAMPLE completed runs so the results/workbench/export UI is
# populated before the real pipeline is wired for local runs. Never on unless DDHARMON_UI_SEED is set.
if os.environ.get("DDHARMON_UI_SEED"):
    from backend.seed import seed_jobs

    seed_jobs(store)


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
async def start_batch(files: Annotated[list[UploadFile], File()], config: Annotated[str, Form()]) -> dict[str, str]:
    """Start a v2 harmonization run. ``config`` is a JSON string:

    ``{dictionaries: [{filename, cohortName, columnRoles}], cdeSet: endorsed|full,
       runMode: batch|sync|preview, minClusterSize: int, genTransformSpecs?: bool,
       topK?: int, retrievalFloor?: float, modelTag?: str, displayName?}``

    v2 requires a CDE catalog (assignment to the given backbone is the thesis) — ``cdeSet`` must be
    ``endorsed`` or ``full``. ``runMode`` defaults to ``batch`` (the deployed default).
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

    # v2 REQUIRES a CDE backbone (assignment to the given catalog is the thesis) — no cdeSet=none path.
    cde_set = cfg.get("cdeSet", "endorsed")
    if cde_set not in CDE_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"cdeSet must be one of {sorted(CDE_FILES)} — v2 harmonization requires a CDE catalog",
        )
    cde_path = CDE_FILES[cde_set]
    if not cde_path.exists():
        raise HTTPException(status_code=400, detail=f"CDE file not found: {cde_path} (see deploy/README.md)")
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
        "min_cluster_size": int(cfg.get("minClusterSize", 15)),
        "gen_transform_specs": bool(cfg.get("genTransformSpecs", True)),
        "cde_cohort": CDE_COHORT,
        "work_dir": str(work_dir),
        "cde_set": cde_set,
    }
    # Optional advanced knobs — passed through only when set (else harmonize_leanb's own defaults apply).
    # Adding a new knob here needs no frontend change (the run-options form posts whatever it has).
    for cfg_key, run_key in (("topK", "top_k"), ("retrievalFloor", "retrieval_floor"), ("modelTag", "model_tag")):
        if cfg.get(cfg_key) is not None:
            run_config[run_key] = cfg[cfg_key]
    display = cfg.get("displayName") or f"Run {job_id[:8]}"
    store.create(job_id, display, run_config)
    threading.Thread(
        target=run_harmonization,
        args=(store, job_id, dict_specs, cde_spec, run_config),
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


@app.post("/api/harmonize/demo")
def start_demo(body: DemoBody) -> dict[str, str]:
    """Hydrate a completed job from a precomputed snapshot — no pipeline run, no API credits."""
    snap = load_snapshot(body.datasets)
    if snap is None:
        raise HTTPException(
            status_code=404,
            detail=f"No precomputed demo for {sorted(body.datasets)}. See GET /api/harmonize/demos.",
        )
    result = snap.get("result", snap)
    job_id = "demo-" + uuid.uuid4().hex[:8]
    display = snap.get("displayName") or "Demo run"
    store.create(job_id, display, {"demo": True, "datasets": sorted(body.datasets), "mode": result.get("mode")})
    store.update(job_id, status="complete", phase="complete", result=result)
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
