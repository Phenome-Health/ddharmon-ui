"""A refused ``/batch`` start keeps nothing on disk.

``start_batch`` writes the uploads into ``<work_root>/<job_id>/uploads/`` before it checks them. A refusal (400)
creates no run row, so nothing else would ever delete that directory: no run to delete, no TTL to age out. The
worst case is the participant-level refusal, where the one kind of file we promise never to accept was the one
kept. Every refusal path must leave ``<work_root>`` exactly as it found it.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module

client = TestClient(app_module.app)

_DICTIONARY = b"var,desc\nage,Age in years\nsex,Sex at birth\n"
# One row per PERSON, keyed by a participant identifier that is unique on every row: refused at the door.
_PARTICIPANT_ROWS = b"participant_id,var,desc\nP001,age,41\nP002,age,37\nP003,age,58\n"
_EMPTY_TEXT = b"var,desc\n,\n,\n"


@pytest.fixture
def work_root(monkeypatch, tmp_path):
    root = tmp_path / "work"
    root.mkdir()
    monkeypatch.setattr(app_module, "_WORK_ROOT", root)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    def never_runs(*args, **kwargs):  # a refused start must not reach the pipeline
        raise AssertionError("a refused start reached the pipeline")

    monkeypatch.setattr(app_module, "run_harmonization", never_runs)
    return root


def _dictionary_entry(filename="cohortA.csv", roles=None):
    return {
        "filename": filename,
        "cohortName": "CohortA",
        "columnRoles": roles if roles is not None else {"variable_name": "var", "description": "desc"},
    }


def _post(cfg, upload_name="cohortA.csv", body=_DICTIONARY):
    base = {"cdeSet": "endorsed", "runMode": "preview"}
    return client.post(
        "/api/harmonize/batch",
        files=[("files", (upload_name, body, "text/csv"))],
        data={"config": json.dumps({**base, **cfg})},
        # A key, so a non-preview runMode reaches its own check instead of the key refusal at the door.
        headers={"x-anthropic-key": "sk-test"},
    )


@pytest.mark.parametrize(
    ("cfg", "upload_name", "body"),
    [
        pytest.param(
            {"dictionaries": [_dictionary_entry(filename="declared.csv")]},
            "cohortA.csv",
            _DICTIONARY,
            id="declared-file-not-uploaded",
        ),
        pytest.param(
            {"dictionaries": [_dictionary_entry(roles={"question_text": "desc"})]},
            "cohortA.csv",
            _DICTIONARY,
            id="role-requirement",
        ),
        pytest.param(
            {"dictionaries": [_dictionary_entry()]},
            "cohortA.csv",
            _PARTICIPANT_ROWS,
            id="participant-level",
        ),
        pytest.param(
            {"dictionaries": [_dictionary_entry()]},
            "cohortA.csv",
            _EMPTY_TEXT,
            id="zero-variables",
        ),
        pytest.param(
            {"dictionaries": [_dictionary_entry()], "runMode": "nonsense"},
            "cohortA.csv",
            _DICTIONARY,
            id="bad-run-mode",
        ),
        pytest.param(
            {"dictionaries": [_dictionary_entry()], "reviewMode": "nonsense"},
            "cohortA.csv",
            _DICTIONARY,
            id="bad-review-mode",
        ),
        pytest.param(
            {"dictionaries": [_dictionary_entry()], "cdeSet": "nonsense"},
            "cohortA.csv",
            _DICTIONARY,
            id="unknown-catalog",
        ),
    ],
)
def test_a_refused_start_leaves_no_upload_on_disk(work_root, cfg, upload_name, body):
    resp = _post(cfg, upload_name=upload_name, body=body)

    assert 400 <= resp.status_code < 500, resp.text
    assert list(work_root.iterdir()) == []  # no orphaned <job_id>/uploads/ left behind


def test_an_unexpected_failure_before_the_run_exists_leaves_no_upload_on_disk(work_root, monkeypatch):
    """Not only the 400s: anything that stops the start before ``store.create`` must not strand the upload."""

    def boom(*args, **kwargs):
        raise RuntimeError("catalog unreadable")

    monkeypatch.setattr(app_module, "cde_spec_for", boom)
    failing_client = TestClient(app_module.app, raise_server_exceptions=False)
    resp = failing_client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", _DICTIONARY, "text/csv"))],
        data={
            "config": json.dumps({"cdeSet": "endorsed", "runMode": "preview", "dictionaries": [_dictionary_entry()]})
        },
    )

    assert resp.status_code == 500
    assert list(work_root.iterdir()) == []


def test_a_refused_upload_that_could_not_be_removed_is_reported_not_swallowed(work_root, monkeypatch, caplog):
    """T-08-54: ``rmtree(..., ignore_errors=True)`` reports success for a teardown it did not achieve. A refused
    participant-level file left on the host with no run row and no log line is the leak, made invisible."""
    stuck_uploads: list[Path] = []

    def lock_then_refuse(path):
        stuck_uploads.append(path.parent)
        os.chmod(path.parent, 0o500)  # read+execute only: the upload cannot be unlinked
        return "participant_id"

    monkeypatch.setattr(app_module, "_participant_level_column", lock_then_refuse)
    try:
        with caplog.at_level(logging.WARNING, logger="backend.jobs"):
            resp = _post({"dictionaries": [_dictionary_entry()]}, body=_PARTICIPANT_ROWS)
    finally:
        for uploads in stuck_uploads:
            os.chmod(uploads, 0o700)

    assert resp.status_code == 400, resp.text
    [stuck] = list(work_root.iterdir())  # the premise of the test: the teardown really failed
    assert any(
        "could not be removed" in r.getMessage() and str(stuck) in r.getMessage() for r in caplog.records
    ), f"a refused upload left on disk was reported as removed: {[r.getMessage() for r in caplog.records]}"


def test_an_accepted_start_keeps_its_upload(work_root, monkeypatch):
    """The cleanup is for refusals only: an accepted run's uploads are what a re-run reads back."""
    started = []
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: started.append(a[1]))

    resp = _post({"dictionaries": [_dictionary_entry()]})

    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]
    assert (work_root / job_id / "uploads" / "cohortA.csv").read_bytes() == _DICTIONARY
    client.delete(f"/api/harmonize/jobs/{job_id}")
