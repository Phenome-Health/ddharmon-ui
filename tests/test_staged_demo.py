"""The guest demo as a pinned STAGED run (08-30 task 4): built by Full auto, walked gate by gate, never written.

P8-D4/D5 and STGD-09: the new-user demo is a frozen run a guest WALKS through Gates 1-4 on the shipped sandbox —
the server holds it immutable, edits stay in the guest's tab, and keeping work means an explicit clone. Until now
a demo was a FINISHED-run snapshot with no gate checkpoints, so there was nothing behind Gate 1 to walk.

The chain pinned here, end to end, on a synthetic run (real pipeline, stubbed stages — $0):

    a Full-auto run parks at Gate 4  ->  scripts/build_demos.py snapshots it (four checkpoints + result)
    ->  backend/demos.py seeds it at boot as a pinned run parked at Gate 4  ->  a guest reads every gate,
    every write is refused, and nothing on disk or in the store changes.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import demos as demos_module
from backend.checkpoint import read_checkpoint
from backend.jobs import AWAITING_REVIEW, JobStore
from tests.test_full_auto import SECRET, _settled, _start, _wait, rig, two_clusters  # noqa: F401

REPO = Path(__file__).resolve().parents[1]
# The demo's pre-generated analysis ideas, shipped in the sidecar beside the snapshot.
IDEAS = [{"title": "Pooled prevalence of X", "concepts": ["X"], "cohorts": ["A", "B"]}]


def _builder():
    spec = importlib.util.spec_from_file_location("build_demos", REPO / "scripts" / "build_demos.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def built(rig):  # noqa: F811
    """A real Full-auto run walked to Gate 4, then snapshotted by the builder exactly as task 5 will."""
    client, _legs, _hooks, tmp = rig
    job_id = _start(client)
    _wait(_settled(job_id))
    assert app_module.store.get(job_id).gate_position == "gate4"
    snap = _builder().snapshot_from_run(
        job_id,
        work_root=tmp / "work",
        db_path=tmp / "jobs.db",
        ids=["cohorta", "cohortb"],
        core_version="9.9.9",
    )
    return snap, job_id, tmp


def test_the_builder_snapshots_a_staged_run_with_its_four_gates(built):
    snap, job_id, tmp = built
    assert snap["staged"] is True and snap["isDemo"] is True
    assert sorted(snap["checkpoints"]) == ["gate1", "gate2", "gate3"]
    work = tmp / "work" / job_id
    for gate in ("gate1", "gate2", "gate3"):
        assert snap["checkpoints"][gate] == read_checkpoint(work, gate).result
    # Gate 4's checkpoint IS the result (a pure read of Gate 3's), stamped with the gate it is shown at.
    assert snap["result"]["records"] == read_checkpoint(work, "gate4").result["records"]
    assert snap["result"]["gatePosition"] == "gate4"
    # What the gate screens read is carried; nothing that points at the machine it was built on is.
    cfg = snap["config"]
    assert cfg["review_mode"] == "auto"
    assert cfg["gate_decided_by"] == {"gate1": "auto", "gate2": "auto", "gate3": "auto"}
    assert cfg["gate1_scope"]
    assert "work_dir" not in cfg and "demo" not in cfg
    blob = json.dumps(snap)
    assert str(tmp) not in blob, "a local path reached the shipped snapshot"
    assert SECRET not in blob, "the key reached the shipped snapshot"
    assert '"responses"' not in blob, "raw stage answers are resume fuel, not demo content"


def test_the_builder_refuses_a_run_that_is_not_parked_at_gate_4(rig):  # noqa: F811
    client, _legs, _hooks, tmp = rig
    job_id = _start(client, review_mode=None)  # guided: parks at Gate 1 and waits
    _wait(_settled(job_id))
    with pytest.raises(SystemExit, match="Gate 4"):
        _builder().snapshot_from_run(job_id, work_root=tmp / "work", db_path=tmp / "jobs.db", ids=["x"])


@pytest.fixture
def seeded(built, monkeypatch, tmp_path):
    """The snapshot shipped in a demo dir and seeded at boot into a FRESH app (a new process, a new work root)."""
    snap, _job_id, _tmp = built
    demo_dir = tmp_path / "demos"
    demo_dir.mkdir()
    (demo_dir / "cohorta_cohortb.json").write_text(json.dumps(snap))
    manifest = {
        "datasets": [{"id": "cohorta", "label": "A", "nFields": 4}, {"id": "cohortb", "label": "B", "nFields": 4}],
        "combos": [{"datasets": ["cohorta", "cohortb"], "snapshot": "cohorta_cohortb.json", "label": "A + B"}],
    }
    (demo_dir / "manifest.json").write_text(json.dumps(manifest))
    (demo_dir / "analysis_ideas.json").write_text(json.dumps({"cohorta_cohortb.json": IDEAS}))
    monkeypatch.setattr(demos_module, "_DIR", demo_dir)
    monkeypatch.setattr(demos_module, "_MANIFEST", demo_dir / "manifest.json")
    monkeypatch.setattr(demos_module, "_IDEAS", demo_dir / "analysis_ideas.json")
    app_module.store._jobs.clear()
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "boot" / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "boot" / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "boot" / "work")
    (tmp_path / "boot").mkdir()
    with TestClient(app_module.app) as client:
        yield client, snap, demos_module.demo_job_id(["cohorta", "cohortb"]), tmp_path / "boot" / "work"


def test_a_staged_demo_is_seeded_at_boot_parked_at_gate_4(seeded):
    _client, snap, demo_id, work = seeded
    job = app_module.store.get(demo_id)
    assert job is not None
    assert (job.status, job.gate_position) == (AWAITING_REVIEW, "gate4")
    assert job.config["demo"] is True and job.config["review_mode"] == "auto"
    assert job.config["gate_decided_by"] == snap["config"]["gate_decided_by"]
    for gate in ("gate1", "gate2", "gate3"):
        assert read_checkpoint(work / demo_id, gate).result == snap["checkpoints"][gate]
    assert read_checkpoint(work / demo_id, "gate4").result == snap["result"]
    listed = demos_module.list_demos()["combos"][0]
    assert listed["available"] is True and listed["staged"] is True


def test_a_guest_walks_every_gate_and_nothing_persists(seeded, monkeypatch):
    """With the sign-in gate ON, a guest reads the run behind every gate; every write is refused; nothing moves."""
    client, snap, demo_id, work = seeded
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.test")
    before = {p: p.read_bytes() for p in (work / demo_id).iterdir()}

    ckpt = client.get(f"/api/harmonize/checkpoint/{demo_id}")
    assert ckpt.status_code == 200, ckpt.text
    assert ckpt.json()["gatePosition"] == "gate4"
    result = client.get(f"/api/harmonize/result/{demo_id}")
    assert result.status_code == 200
    body = result.json()
    # Gate 1 renders the groups, Gates 2-3 the records and specs, Gate 4 the export set — all from this read.
    assert body["result"]["conceptGroups"] and body["result"]["records"]
    assert body["config"]["review_mode"] == "auto" and body["autoAdvancing"] is False
    assert client.get(f"/api/harmonize/jobs/{demo_id}/artifacts").status_code == 200

    # The spend path and every write stay shut to a guest.
    assert client.post(f"/api/harmonize/resume/{demo_id}").status_code == 401
    assert client.put(f"/api/harmonize/jobs/{demo_id}/artifacts/gate1_rename", json={}).status_code == 401
    monkeypatch.delenv("CLERK_ISSUER")
    # And to a signed-in user too: the demo is one shared row, so it holds nobody's work.
    from backend.artifact_kinds import option_set_key

    pick = {"groupId": "x", "chosen": "y", "alternatives": ["y"], "optionSetKey": option_set_key(["y"])}
    assert client.put(f"/api/harmonize/jobs/{demo_id}/artifacts/gate2_candidate_pick", json=pick).status_code == 403
    assert client.post(f"/api/harmonize/resume/{demo_id}", headers={"x-anthropic-key": "k"}).status_code == 403

    job = app_module.store.get(demo_id)
    assert (job.status, job.gate_position) == (AWAITING_REVIEW, "gate4")
    assert {p: p.read_bytes() for p in (work / demo_id).iterdir()} == before, "the demo's files changed"
    assert app_module.store.artifacts_for(job, None) == {}


def test_a_guest_sees_the_staged_demos_pregenerated_analysis_ideas(seeded):
    """Gate 4 hosts the ideas, so a demo parked there shows the ones baked for it — with no LLM call.

    Two drops used to hide them: the staged seeding path never received the ideas, and the result read blanked
    them, because a demo's per-user work resolves to ``{}``. The ideas are shipped content, not anyone's work.
    """
    client, _snap, demo_id, _work = seeded
    assert app_module.store.get(demo_id).analysis_ideas == IDEAS
    assert client.get(f"/api/harmonize/result/{demo_id}").json()["analysisIdeas"] == IDEAS
    # The panel's read is served from the shipped ideas: cached, never a paid pass.
    r = client.post(f"/api/harmonize/jobs/{demo_id}/analysis-ideas")
    assert r.status_code == 200 and r.json() == {"ideas": IDEAS, "cached": True}


def test_loading_a_staged_demo_returns_it_without_a_replay(seeded):
    client, _snap, demo_id, _work = seeded
    r = client.post("/api/harmonize/demo", json={"datasets": ["cohortb", "cohorta"]})
    assert r.status_code == 200 and r.json() == {"jobId": demo_id}
    job = app_module.store.get(demo_id)
    assert (job.status, job.gate_position) == (AWAITING_REVIEW, "gate4"), "a staged demo was replayed as finished"


def test_a_staged_demo_can_be_cloned_into_a_run_of_your_own(seeded):
    client, snap, demo_id, _work = seeded
    r = client.post(f"/api/harmonize/jobs/{demo_id}/clone", json={"displayName": "Mine"})
    assert r.status_code == 200, r.text
    copy = app_module.store.get(r.json()["jobId"])
    assert copy.status == "complete" and copy.result["records"] == snap["result"]["records"]
    assert "demo" not in copy.config and copy.config["review_mode"] == "auto"


def test_seeding_twice_is_idempotent_and_a_finished_snapshot_still_seeds_as_before(seeded):
    _client, _snap, demo_id, _work = seeded
    store = app_module.store
    assert demos_module.seed_demos(store) == []  # already present
    finished = JobStore(work_root=None, db=None)
    snap = {"displayName": "Old", "result": {"records": [{"id": "r"}], "mode": "batch"}}
    demos_module.seed_snapshot(finished, "demo-old", snap)
    job = finished.get("demo-old")
    assert (job.status, job.gate_position, job.result["records"]) == ("complete", None, [{"id": "r"}])


def test_the_static_fixture_of_a_staged_demo_is_parked_at_gate_4(built, tmp_path):
    snap, _job_id, _tmp = built
    static = tmp_path / "static"
    _builder().write_static_fixtures(["cohorta", "cohortb"], snap, static_dir=static, manifest_path=None)
    job = json.loads((static / "result-demo-cohorta_cohortb.json").read_text())
    assert (job["status"], job["gatePosition"]) == ("awaiting_review", "gate4")
    assert job["config"]["demo"] is True and job["config"]["gate_decided_by"] == snap["config"]["gate_decided_by"]
    assert job["result"]["gatePosition"] == "gate4"
    listed = json.loads((static / "jobs.json").read_text())
    assert listed[0]["jobId"] == "demo-cohorta_cohortb" and "result" not in listed[0]
