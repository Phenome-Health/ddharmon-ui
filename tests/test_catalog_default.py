"""Which CDE catalog a run matches against — new runs default to the FULL catalog (08-28 Decision 7).

Why the default moved: the NIH-endorsed catalog (177 elements) has no body weight, no PHQ and no PROMIS, so
those common measures came out "novel" (no CDE fits -> a generated element) even though the full catalog
(22,743 elements, ``all_cdes_flat.tsv``) carries a good one. Every benchmark and the validation run used
``full``. ``endorsed`` stays selectable.

Three contracts pinned here:

1. A run created WITHOUT a ``cdeSet`` records and matches against ``full``; an explicit ``endorsed`` still works.
2. A run never switches catalog mid-run: a resumed leg reads the catalog the run RECORDED at creation, and the
   read-back fallback for a run that recorded none stays ``endorsed`` (what such a run actually ran with) —
   it does not follow the new creation default.
3. A server missing the catalog a run asks for refuses BY NAME (the file and the env var to fix it), creates
   nothing, and never silently falls back to the other catalog.
4. A recorded fixture keeps the catalog it was captured with: the live-verify driver starts its run on the
   committed fixture with the fixture's own ``cdeSet`` unless told otherwise. The fixture's designed clusters
   were validated against that catalog, and the catalog's rows are part of the clustered matrix.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.checkpoint import write_checkpoint

_ROW = "designation\tdefinition\nAgeCDE\tAge of participant\n"


def _catalogs(tmp_path, *, full: bool = True, endorsed: bool = True):
    """Two DISTINCT catalog files under their real names, so a test can tell which one a run was given."""
    cde_dir = tmp_path / "cde"
    cde_dir.mkdir(exist_ok=True)
    files = {"endorsed": cde_dir / "nih_endorsed_flat.tsv", "full": cde_dir / "all_cdes_flat.tsv"}
    if endorsed:
        files["endorsed"].write_text(_ROW)
    if full:
        files["full"].write_text(_ROW)
    return files


def _start(monkeypatch, tmp_path, files, cfg_extra: dict):
    """POST a one-dictionary run; returns (response, captured worker calls)."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module, "CDE_FILES", files)
    calls: list[dict] = []

    def fake_runner(store, job_id, dict_specs, cde_spec, config, **kwargs):
        calls.append({"job_id": job_id, "cde_spec": dict(cde_spec), "config": dict(config)})

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)
    cfg = {
        "dictionaries": [
            {"filename": "a.csv", "cohortName": "A", "columnRoles": {"variable_name": "var", "description": "desc"}}
        ],
        "runMode": "batch",
        **cfg_extra,
    }
    # No lifespan (a bare client, as test_backend.py uses): the store stays in-memory, so ``store.list()``
    # is exactly the runs this test created — no seeded demos, no durable rows from other tests.
    resp = TestClient(app_module.app).post(
        "/api/harmonize/batch",
        files=[("files", ("a.csv", b"var,desc\nage,Age in years\nwt,Body weight in kg\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
        headers={"x-anthropic-key": "sk-test"},
    )
    return resp, calls


# ── 1. the creation default ───────────────────────────────────────────────────────────────────────────


def test_a_run_created_without_a_catalog_records_and_matches_against_the_full_one(monkeypatch, tmp_path):
    files = _catalogs(tmp_path)
    resp, calls = _start(monkeypatch, tmp_path, files, {})
    assert resp.status_code == 200, resp.text
    job = app_module.store.get(resp.json()["jobId"])
    assert job.config["cde_set"] == "full"
    assert calls and calls[0]["cde_spec"]["path"] == str(files["full"])


def test_the_endorsed_catalog_is_still_selectable(monkeypatch, tmp_path):
    files = _catalogs(tmp_path)
    resp, calls = _start(monkeypatch, tmp_path, files, {"cdeSet": "endorsed"})
    assert resp.status_code == 200, resp.text
    assert app_module.store.get(resp.json()["jobId"]).config["cde_set"] == "endorsed"
    assert calls[0]["cde_spec"]["path"] == str(files["endorsed"])


# ── 3. a missing catalog is refused by name, at the door ─────────────────────────────────────────────


def test_a_server_without_the_full_catalog_refuses_a_default_run_by_name_and_creates_nothing(monkeypatch, tmp_path):
    """A server that only has the endorsed file (the old default) must not quietly run endorsed instead."""
    files = _catalogs(tmp_path, full=False)
    before = {j.job_id for j in app_module.store.list()}
    resp, calls = _start(monkeypatch, tmp_path, files, {})
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "all_cdes_flat.tsv" in detail  # the missing FILE, by name
    assert "DDHARMON_CDE_DIR" in detail  # and how to fix it
    assert "endorsed" in detail.lower()  # the catalog that IS selectable, named — never silently used
    assert calls == []  # no worker — so nothing embedded, nothing charged
    assert {j.job_id for j in app_module.store.list()} == before  # no run row
    work = tmp_path / "work"
    assert not work.exists() or not any(work.iterdir())  # no work dir / uploads left behind


# ── 2. a resumed leg keeps the catalog the run recorded ──────────────────────────────────────────────


def _parked(monkeypatch, tmp_path, files, job_id: str, config: dict):
    """A run parked at Gate 1 with ``config``; returns the captured worker calls of a resume."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    monkeypatch.setattr(app_module, "CDE_FILES", files)
    calls: list[dict] = []
    monkeypatch.setattr(
        app_module, "run_harmonization", lambda *a, **k: calls.append({"cde_spec": dict(a[3]), "config": dict(a[4])})
    )
    wd = tmp_path / "work" / job_id
    app_module.store.create(
        job_id,
        "Parked",
        {"work_dir": str(wd), **config},
        owner_subject=None,
        dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
    )
    result = {"records": [], "conceptGroups": [{"groupId": "g0"}]}
    write_checkpoint(wd, job_id=job_id, gate="gate1", result=result, responses={}, realized_cost=1.0)
    app_module.store.checkpoint(
        job_id, gate="gate1", checkpoint_ref=f"{job_id}/checkpoint_gate1.json", realized_cost=1.0
    )
    return calls


def test_a_resumed_endorsed_run_stays_on_the_endorsed_catalog(monkeypatch, tmp_path):
    files = _catalogs(tmp_path)
    calls = _parked(monkeypatch, tmp_path, files, "e1", {"cde_set": "endorsed"})
    with TestClient(app_module.app) as c:
        r = c.post("/api/harmonize/resume/e1", headers={"x-anthropic-key": "sk-test"}, json={"gate1Scope": ["g0"]})
    assert r.status_code == 200, r.text
    assert calls[-1]["cde_spec"]["path"] == str(files["endorsed"])


def test_a_run_that_recorded_no_catalog_reads_back_as_endorsed_not_the_new_default(monkeypatch, tmp_path):
    """Every run created through the API records ``cde_set``, so this is a guard, not a live path — but if one
    ever lacks the key, it ran when the creation default was ``endorsed``, and resuming it against ``full``
    would switch its catalog mid-run."""
    files = _catalogs(tmp_path)
    calls = _parked(monkeypatch, tmp_path, files, "legacy", {})
    with TestClient(app_module.app) as c:
        r = c.post("/api/harmonize/resume/legacy", headers={"x-anthropic-key": "sk-test"}, json={"gate1Scope": ["g0"]})
    assert r.status_code == 200, r.text
    assert calls[-1]["cde_spec"]["path"] == str(files["endorsed"])


def test_resuming_a_full_run_on_a_server_without_the_full_catalog_names_the_missing_file(monkeypatch, tmp_path):
    files = _catalogs(tmp_path, full=False)
    calls = _parked(monkeypatch, tmp_path, files, "f1", {"cde_set": "full"})
    with TestClient(app_module.app) as c:
        r = c.post("/api/harmonize/resume/f1", headers={"x-anthropic-key": "sk-test"}, json={"gate1Scope": ["g0"]})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "all_cdes_flat.tsv" in detail
    assert "DDHARMON_CDE_DIR" in detail
    assert calls == []  # not resumed against the endorsed file instead
    assert app_module.store.get("f1").gate_position == "gate1"  # still parked, still resumable


# ── 4. the live-verify driver keeps the fixture's recorded catalog ───────────────────────────────────


def _live_verify():
    """The driver script, loaded the way ``test_live_verify_inflight.py`` loads it (once per session)."""
    if "live_verify" in sys.modules:
        return sys.modules["live_verify"]
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("live_verify", root / "scripts" / "live_verify.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["live_verify"] = module  # its dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


def test_the_live_verify_driver_starts_on_the_catalog_its_fixture_was_captured_with():
    lv = _live_verify()
    assert lv.fixture_cde_set({"cdeSet": "endorsed"}) == "endorsed"
    assert lv.fixture_cde_set({"cdeSet": "full"}) == "full"
    # a fixture that records no catalog is a new run like any other: the product default
    assert lv.fixture_cde_set({}) == app_module.DEFAULT_CDE_SET == "full"
    committed = json.loads((Path(__file__).resolve().parent / "live" / "fixture" / "manifest.json").read_text())
    assert lv.fixture_cde_set(committed) == committed["cdeSet"]


def test_the_frontend_default_is_the_backend_default():
    """Setup and the older New Run page start from the frontend's copy; a run that names none gets the backend's.
    Two copies of one decision drift apart silently, so they are pinned together here."""
    types_ts = (Path(__file__).resolve().parent.parent / "frontend" / "src" / "types.ts").read_text()
    m = re.search(r'export const DEFAULT_CDE_SET: CdeSet = "(\w+)";', types_ts)
    assert m, "frontend/src/types.ts no longer declares DEFAULT_CDE_SET"
    assert m.group(1) == app_module.DEFAULT_CDE_SET
