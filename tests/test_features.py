"""Tests for the guide/tooltips-adjacent backend features: notebook export, demos, and the dev seed.

Pure-serializer + endpoint coverage — no model download / API key (the seed builds canned UIResults).
"""

from __future__ import annotations

import ast
import json
import time

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.demos import list_demos, load_snapshot
from backend.notebook import build_notebook
from backend.seed import seed_jobs

client = TestClient(app_module.app)


# ── seed ───────────────────────────────────────────────────────────────────────


def test_seed_builds_completed_runs_matching_contract():
    from backend.jobs import JobStore

    store = JobStore()
    ids = seed_jobs(store)
    assert len(ids) == 2
    for jid in ids:
        job = store.get(jid)
        assert job is not None and job.status == "complete" and job.result is not None
        res = job.result
        assert res["contractVersion"] == "1"
        assert res["summary"]["nRecords"] == len(res["records"])
        for r in res["records"]:  # every record has the required contract keys
            assert {"id", "concept", "verdict", "route", "cohorts", "members", "transforms", "candidates"} <= r.keys()
            assert r["verdict"] in {"adopt", "refine", "novel", "unclassified"}
        # summary counts are internally consistent
        assert res["summary"]["nWithTransforms"] == sum(1 for r in res["records"] if r["transforms"])
        assert res["summary"]["nAssigned"] == sum(1 for r in res["records"] if r["route"] == "assigned")


# ── notebook export ─────────────────────────────────────────────────────────────


def _sample_result() -> dict:
    from backend.jobs import JobStore

    s = JobStore()
    jid = seed_jobs(s)[0]
    return s.get(jid).result  # type: ignore[union-attr]


def test_build_notebook_python_is_valid_and_parses():
    nb = build_notebook(_sample_result(), "py", "Test run")
    assert nb["nbformat"] == 4
    assert nb["metadata"]["kernelspec"]["language"] == "python"
    code_cells = [c for c in nb["cells"] if c["cell_type"] == "code"]
    assert code_cells, "expected code cells"
    for c in code_cells:  # every python cell must be syntactically valid
        ast.parse("".join(c["source"]))
    blob = "\n".join("".join(c["source"]) for c in code_cells)
    assert "pd.read_csv" in blob and ".map(_map)" in blob  # categorical recode rendered
    json.dumps(nb)  # must be JSON-serializable


def test_build_notebook_r_is_valid():
    nb = build_notebook(_sample_result(), "r", "Test run")
    assert nb["metadata"]["kernelspec"]["language"] == "R"
    blob = "\n".join("".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code")
    assert "read.csv" in blob and "<-" in blob
    json.dumps(nb)


def test_notebook_export_endpoint():
    ids = seed_jobs(app_module.store)  # insert into the module store the endpoint reads
    try:
        resp = client.get(f"/api/harmonize/jobs/{ids[0]}/export", params={"format": "notebook_py"})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-ipynb+json")
        assert ".ipynb" in resp.headers["content-disposition"]
        nb = resp.json()
        assert nb["nbformat"] == 4
    finally:
        for jid in ids:
            app_module.store.delete(jid)


# ── demos ───────────────────────────────────────────────────────────────────────


def test_demos_endpoint_lists_datasets():
    resp = client.get("/api/harmonize/demos")
    assert resp.status_code == 200
    body = resp.json()
    assert {d["id"] for d in body["datasets"]} == {"aou", "clsa", "ukbb", "mesa", "aireadi"}
    assert body["combos"] and all("available" in c for c in body["combos"])


def test_demo_load_replays_and_marks_demo(monkeypatch):
    """The shipped snapshot loads as a live-paced replay job, tagged demo:true, that completes with records."""
    monkeypatch.setenv("DDHARMON_DEMO_REPLAY_SECS", "0")  # instant replay (skip the pacing sleeps) for the test
    combo = ["aou", "clsa", "ukbb", "mesa", "aireadi"]
    assert load_snapshot(combo) is not None, "demo snapshot must be shipped"

    resp = client.post("/api/harmonize/demo", json={"datasets": combo})
    assert resp.status_code == 200
    job_id = resp.json()["jobId"]

    body = None
    for _ in range(100):
        body = client.get(f"/api/harmonize/result/{job_id}").json()
        if body["status"] == "complete":
            break
        time.sleep(0.02)
    assert body and body["status"] == "complete"
    assert body["config"].get("demo") is True
    assert body["result"] and len(body["result"]["records"]) > 0

    # shows in the Runs list, demo-marked
    row = next(j for j in client.get("/api/harmonize/jobs").json() if j["jobId"] == job_id)
    assert row["config"].get("demo") is True


def test_demo_load_404_for_unknown_combo():
    """An unknown dataset combo has no snapshot → hydration 404s (not 500)."""
    assert load_snapshot(["nope"]) is None
    resp = client.post("/api/harmonize/demo", json={"datasets": ["nope"]})
    assert resp.status_code == 404


def test_list_demos_matches_manifest():
    demos = list_demos()
    assert [c["datasets"] for c in demos["combos"]] == [["aou", "clsa", "ukbb", "mesa", "aireadi"]]


def test_seed_demos_surfaces_pregenerated_analysis_ideas():
    """A seeded demo carries its PRE-GENERATED analysis ideas (from the sidecar) so a guest sees them
    without an LLM call — surfaced both on the Job and via to_dict()'s analysisIdeas."""
    from backend.demos import _load_demo_ideas, demo_job_id, seed_demos
    from backend.jobs import JobStore

    ideas_by_snapshot = _load_demo_ideas()
    store = JobStore()
    seed_demos(store)
    for combo in list_demos()["combos"]:
        expected = ideas_by_snapshot.get(combo["snapshot"])
        if not combo.get("available") or not expected:
            continue
        job = store.get(demo_job_id(combo["datasets"]))
        assert job is not None
        assert job.analysis_ideas == expected  # pre-generated ideas set on the demo job
        assert job.to_dict()["analysisIdeas"] == expected  # ...and streamed to the client
    # The shipped 5-cohort demo must actually carry ideas (guards against a missing/empty sidecar).
    shipped = ideas_by_snapshot.get("aireadi_aou_clsa_mesa_ukbb.json")
    assert shipped and len(shipped) > 0
