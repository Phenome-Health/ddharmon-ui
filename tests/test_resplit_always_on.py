"""Re-splitting a group at Gate 1 is always available on a new run — no opt-in at Setup (final review, round 1).

Bhargav: *"'Allow re-splitting a group during review' should be on by default since user can decide for
themselves whether to use it or not at gate 1. doesnt need a checkbox"*. The opt-in existed because a run should
only pay for a stage it asked for — but a re-split is never bought by the run: it is bought one group at a time,
by a reviewer pressing "Accept this division" at Gate 1 on a priced proposal. Asking twice (once blind at Setup,
once informed at Gate 1) only made the second, informed decision unreachable when the first was left off.

What is pinned here:

  1. **Every new run records ``readjudication: True``** — whatever the create payload says. The Setup control is
     gone, and an API caller sending ``false`` gets the same capability (it still costs nothing unless used).
  2. **A re-run is a new run**, so it is always-on too, even when the run it copies recorded OFF.
  3. **An old run that recorded OFF replays as it was**: ``/readjudicate`` still refuses it (its quote never
     included the capability), and the refusal no longer points at a Setup control that no longer exists.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.jobs import AWAITING_REVIEW

ROLES = {"variable_name": "var", "description": "desc"}


def _start(client, tmp_path, monkeypatch, extra: dict | None = None) -> str:
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **kw: None)
    cfg = {
        "dictionaries": [{"filename": "cohortA.csv", "cohortName": "CohortA", "columnRoles": ROLES}],
        "cdeSet": "endorsed",
        "runMode": "preview",
        **(extra or {}),
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", b"var,desc\nage,Age in years\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["jobId"]


def test_a_new_run_records_resplitting_on_without_being_asked(monkeypatch, tmp_path):
    client = TestClient(app_module.app)
    job_id = _start(client, tmp_path, monkeypatch)

    assert app_module.store.get(job_id).config["readjudication"] is True


def test_a_create_payload_cannot_turn_it_off(monkeypatch, tmp_path):
    """The capability is always on; whether to SPEND on it is the reviewer's call at Gate 1, per group."""
    client = TestClient(app_module.app)
    job_id = _start(client, tmp_path, monkeypatch, {"allowReadjudication": False})

    assert app_module.store.get(job_id).config["readjudication"] is True


def test_a_rerun_of_a_run_that_recorded_it_off_is_a_new_run_with_it_on(monkeypatch, tmp_path):
    client = TestClient(app_module.app)
    src_id = _start(client, tmp_path, monkeypatch)
    src = app_module.store.get(src_id)
    # Simulate a run created before this change, with the checkbox left off.
    app_module.store.update(src_id, config={**src.config, "readjudication": False})

    resp = client.post(f"/api/harmonize/jobs/{src_id}/rerun")

    assert resp.status_code == 200, resp.text
    assert app_module.store.get(resp.json()["jobId"]).config["readjudication"] is True
    # The source is untouched: it replays as it was recorded.
    assert app_module.store.get(src_id).config["readjudication"] is False


def test_an_old_run_that_recorded_it_off_is_still_refused_and_not_sent_to_a_dead_control(monkeypatch):
    app_module.store.create("j-old-off", "Old run", {"readjudication": False}, owner_subject=None)
    app_module.store.update("j-old-off", status=AWAITING_REVIEW, gate_position="gate1")

    resp = TestClient(app_module.app).post("/api/harmonize/jobs/j-old-off/readjudicate", json={"groupIds": ["g1"]})

    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "not enabled" in detail.lower()
    # There is no Setup control any more, so the refusal must not tell the reviewer to "enable" one.
    assert "enabled;" not in detail and "with it enabled" not in detail
    assert "new run" in detail.lower()
