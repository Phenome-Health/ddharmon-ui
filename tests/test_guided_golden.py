"""Guided review is pinned BYTE FOR BYTE before Full auto touches the start and resume paths (08-30).

Full auto adds a second review mode beside the one every run has used so far. The plan's first promise is that
Guided does not move at all: same stored config, same config and keyword arguments handed to every leg's worker,
same response bodies, same Gate 4 pure read, same progress frame. This file states those values as literals —
captured from the code BEFORE the review-mode change — so any drift in the guided path fails here by name rather
than surfacing as a subtly different run on the server.

Nothing here runs the pipeline: the worker is replaced by a recorder, and each park is written the way the
runner writes it (checkpoint file + ``store.checkpoint``).
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.checkpoint import read_checkpoint, write_checkpoint
from backend.engine.adapter import PREPARE_BEFORE_EMBED_DEFAULT
from backend.jobs import AWAITING_REVIEW

#: What a guided run's stored config holds, minus the per-run work dir (normalised to "<work>").
GUIDED_STORED_CONFIG = {
    "run_mode": "batch",
    "gen_transform_specs": True,
    "gen_analysis_ideas": True,
    "cde_cohort": "NIH_CDE",
    "work_dir": "<work>",
    "cde_set": "endorsed",
    "est_fields": 2,
    "est_cohorts": 1,
    "concept_gate": False,
    "readjudication": True,
    # The product default at creation, read from where it is defined (it is not part of the review mode).
    "preprocess": PREPARE_BEFORE_EMBED_DEFAULT,
}

#: The progress frame's keys. Full auto must not add a key to a GUIDED run's frame.
GUIDED_FRAME_KEYS = {
    "jobId",
    "displayName",
    "status",
    "phase",
    "stopping",
    "completed",
    "total",
    "errorMessage",
    "failedPhase",
    "phaseStartedAt",
    "costSoFar",
    "gatePosition",
    "resultVersion",
    "transport",
    "batch",
    "createdAt",
    "updatedAt",
}


def _norm(config: dict, work: str) -> dict:
    return {k: ("<work>" if v == work else v) for k, v in config.items()}


@pytest.fixture
def rig(monkeypatch, tmp_path):
    """The app on a temp work root and catalog, with every leg's worker replaced by a recorder."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    legs: list[dict] = []

    def record(store, job_id, dict_specs, cde_spec, config, **kwargs):
        legs.append({"job_id": job_id, "config": dict(config), "kwargs": dict(kwargs)})

    monkeypatch.setattr(app_module, "run_harmonization", record)
    with TestClient(app_module.app) as client:
        yield client, legs, tmp_path


def _park(job_id: str, gate: str, result: dict, *, cost: float) -> None:
    job = app_module.store.get(job_id)
    write_checkpoint(
        job.config["work_dir"],
        job_id=job_id,
        gate=gate,
        result=result,
        responses={"generate": {"p": 1}},
        realized_cost=cost,
    )
    app_module.store.checkpoint(
        job_id, gate=gate, checkpoint_ref=f"{job_id}/checkpoint_{gate}.json", realized_cost=cost
    )


def test_a_guided_run_walks_setup_to_gate_4_exactly_as_before(rig):
    client, legs, _tmp = rig
    cfg = {
        "dictionaries": [
            {"filename": "a.csv", "cohortName": "A", "columnRoles": {"variable_name": "var", "description": "desc"}}
        ],
        "cdeSet": "endorsed",
        "runMode": "batch",
        "estFields": 2,
        "estCohorts": 1,
    }
    r = client.post(
        "/api/harmonize/batch",
        files=[("files", ("a.csv", b"var,desc\nage,Age in years\nsex,Sex at birth\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
        headers={"x-anthropic-key": "sk-test"},
    )
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"jobId"}
    job_id = r.json()["jobId"]
    job = app_module.store.get(job_id)
    work = job.config["work_dir"]

    # ── Start: the stored config, and the first leg's config + keyword arguments ──
    assert _norm(job.config, work) == GUIDED_STORED_CONFIG
    assert len(legs) == 1
    assert _norm(legs[0]["config"], work) == {**GUIDED_STORED_CONFIG, "stop_at_gate": "gate1"}
    assert legs[0]["kwargs"] == {"api_key": "sk-test"}
    assert set(job.progress_dict()) == GUIDED_FRAME_KEYS

    # ── Gate 1 -> Gate 2 ──
    groups = [{"groupId": "g0"}, {"groupId": "g1"}]
    _park(job_id, "gate1", {"records": [], "conceptGroups": groups, "cost": {"actualUsd": 1.0}}, cost=1.0)
    assert set(app_module.store.get(job_id).progress_dict()) == GUIDED_FRAME_KEYS
    r = client.post(
        f"/api/harmonize/resume/{job_id}", headers={"x-anthropic-key": "sk-test"}, json={"gate1Scope": ["g1"]}
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"jobId": job_id, "resumedFrom": "gate1", "target": "gate2"}
    stored = {**GUIDED_STORED_CONFIG, "gate1_scope": ["g1"]}
    assert _norm(app_module.store.get(job_id).config, work) == stored
    assert _norm(legs[1]["config"], work) == {
        **stored,
        "stop_at_gate": "gate2",
        "park_at_gate": "gate2",
        "assign_group_ids": ["g1"],
    }
    assert legs[1]["kwargs"] == {
        "api_key": "sk-test",
        "replay_responses": {"generate": {"p": 1}},
        "prior_cost": {"actualUsd": 1.0},
    }
    job = app_module.store.get(job_id)
    assert (job.status, job.phase, job.cancel_mode, set(job.phase_timings)) == ("pending", "pending", None, {"pending"})

    # ── Gate 2 -> Gate 3 ──
    _park(job_id, "gate2", {"records": [], "conceptGroups": groups, "cost": {"actualUsd": 2.0}}, cost=2.0)
    r = client.post(f"/api/harmonize/resume/{job_id}", headers={"x-anthropic-key": "sk-test"})
    assert r.status_code == 200, r.text
    assert r.json() == {"jobId": job_id, "resumedFrom": "gate2", "target": "gate3"}
    assert _norm(legs[2]["config"], work) == {
        **stored,
        "stop_at_gate": None,
        "park_at_gate": "gate3",
        "assign_group_ids": ["g1"],
    }
    assert legs[2]["kwargs"] == {
        "api_key": "sk-test",
        "replay_responses": {"generate": {"p": 1}},
        "prior_cost": {"actualUsd": 2.0},
    }

    # ── Gate 3 -> Gate 4: a pure read, no worker ──
    final = {"records": [{"id": "r1"}], "conceptGroups": groups, "cost": {"actualUsd": 3.0}}
    _park(job_id, "gate3", final, cost=3.0)
    r = client.post(f"/api/harmonize/resume/{job_id}")
    assert r.status_code == 200, r.text
    # `resumedFrom` reads "gate4" here, not "gate3": the pure-read branch parks the live Job object before it
    # builds the reply. A pre-existing quirk (no client reads the field), pinned as-is because this file pins
    # Guided exactly as it was.
    assert r.json() == {"jobId": job_id, "resumedFrom": "gate4", "target": "gate4"}
    assert len(legs) == 3, "the Gate 4 leg spawned a worker"
    job = app_module.store.get(job_id)
    assert (job.status, job.gate_position, job.cost_so_far) == (AWAITING_REVIEW, "gate4", 3.0)
    assert _norm(job.config, work) == stored
    ckpt = read_checkpoint(work, "gate4")
    assert ckpt.result == final and ckpt.responses == {"generate": {"p": 1}} and ckpt.realized_cost == 3.0
    assert set(job.progress_dict()) == GUIDED_FRAME_KEYS

    # ── The final gate refuses another Continue, as before ──
    r = client.post(f"/api/harmonize/resume/{job_id}")
    assert r.status_code == 409


def test_a_guided_runs_stream_closes_at_its_gate(rig):
    """A guided park is an exit: the stream sends one frame and closes, so no client polls a run with no worker."""
    client, _legs, tmp = rig
    wd = tmp / "work" / "gs"
    app_module.store.create("gs", "Guided", {"work_dir": str(wd), "cde_set": "endorsed", "run_mode": "batch"})
    _park("gs", "gate1", {"records": [], "conceptGroups": []}, cost=0.5)
    with client.stream("GET", "/api/harmonize/stream/gs") as resp:
        frames = [line for line in resp.iter_lines() if line.startswith("data:")]
    assert len(frames) == 1
    assert set(json.loads(frames[0][len("data: ") :])) == GUIDED_FRAME_KEYS


def test_a_guided_parked_run_still_refuses_a_stop(rig):
    client, _legs, tmp = rig
    wd = tmp / "work" / "gp"
    app_module.store.create("gp", "Guided", {"work_dir": str(wd), "cde_set": "endorsed", "run_mode": "batch"})
    _park("gp", "gate2", {"records": []}, cost=0.5)
    r = client.post("/api/harmonize/jobs/gp/cancel")
    assert r.status_code == 409
    assert app_module.store.get("gp").cancel_mode is None
