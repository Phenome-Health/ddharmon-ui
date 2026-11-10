"""Gate 1's free export: every group's variables as the reviewer left them, plus the leftovers (08-31 task 4).

``GET /api/harmonize/jobs/{id}/gate1.csv`` — one row per (group, variable) AFTER the live Gate 1 decisions (moves,
New groups, renames, scope), then the variables in no group under "In no group". Owner-scoped and free like Gate 0's
``prepared.csv``: a read that calls no model and changes no run state. A Preview run never freezes its decisions (it
has no Continue), so the export applies them itself — and the same route serves a paid run parked at Gate 1.

No provider anywhere: the payloads are built by hand or by the Preview row builder.
"""

from __future__ import annotations

import csv
import io

from ddharmon.harmonization.substrate import cluster_content_id
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.checkpoint import write_checkpoint
from tests.test_gate1_new_group import REV, _decision, _move, _new_group
from tests.test_preview_gate1_rows import _GLU, _HEAR, _keys, _preview_job

GLU = cluster_content_id(_keys(_GLU))
HEAR = cluster_content_id(_keys(_HEAR))
HEADER = [
    "group_id",
    "group_label",
    "label_source",
    "in_scope",
    "cohort",
    "variable",
    "description",
    "question_text",
    "value_encoding",
]


def _csv(c: TestClient, job: str) -> list[dict[str, str]]:
    r = c.get(f"/api/harmonize/jobs/{job}/gate1.csv")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0] == HEADER
    return [dict(zip(HEADER, row, strict=True)) for row in rows[1:]]


def _by_member(rows: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    return {f"{r['cohort']}:{r['variable']}": r for r in rows}


def _rename(group_id: str, generated: str, name: str) -> dict:
    """The payload Gate 1's rename writes: the reviewer's name, with the label it replaced kept beside it."""
    return _decision({"groupId": group_id}, name, [generated, name], generatedName=generated)


def _scope(group_id: str, chosen: str) -> dict:
    return _decision({"groupId": group_id}, chosen, ["in", "out"])


# ── Preview runs ──────────────────────────────────────────────────────────────────────────────────


def test_a_preview_exports_every_cluster_and_the_leftovers(monkeypatch, tmp_path):
    result = _preview_job(monkeypatch, tmp_path, "pv")
    labels = {g["groupId"]: g["concept"] for g in result["conceptGroups"]}
    with TestClient(app_module.app) as c:
        rows = _csv(c, "pv")
    by = _by_member(rows)
    # Every variable exactly once: the clusters' members, then the clustering's outlier in no group.
    assert len(rows) == len(result["fieldIndex"]) == len(by)
    for m in _GLU:
        assert (by[m]["group_id"], by[m]["group_label"], by[m]["label_source"]) == (GLU, labels[GLU], "keywords")
    for m in _HEAR:
        assert by[m]["group_id"] == HEAR
    odd = by["A:odd"]
    assert (odd["group_id"], odd["group_label"], odd["label_source"]) == ("", "In no group", "")
    assert rows[-1] is odd, "the leftovers come after every group"
    # A Preview sends nothing on to Gate 2, so no row claims a scope either way.
    assert {r["in_scope"] for r in rows} == {""}


def test_a_move_and_a_new_group_on_a_preview_are_what_the_file_says(monkeypatch, tmp_path):
    _preview_job(monkeypatch, tmp_path, "pm")
    with TestClient(app_module.app) as c:
        for kind, payload in [
            ("gate1_regroup", _move("A:hear3", HEAR, GLU)),  # between clusters
            ("gate1_regroup", _move("A:glu1", GLU, "__unassigned__")),  # out of every group
            ("gate1_regroup", _move("A:odd", "__unassigned__", REV)),  # a leftover, placed in a New group
            ("gate1_new_group", _new_group(REV, "Pets")),
        ]:
            r = c.put(f"/api/harmonize/jobs/pm/artifacts/{kind}", json=payload)
            assert r.status_code == 200, r.text
        rows = _csv(c, "pm")
    by = _by_member(rows)
    assert by["A:hear3"]["group_id"] == GLU
    assert by["A:glu1"]["group_id"] == "" and by["A:glu1"]["group_label"] == "In no group"
    assert (by["A:odd"]["group_id"], by["A:odd"]["group_label"], by["A:odd"]["label_source"]) == (REV, "Pets", "yours")
    assert len(rows) == len(by), "a moved variable is listed twice"
    # The reviewer's New groups lead, as they lead Gate 1's list.
    assert rows[0]["group_id"] == REV


def test_a_rename_on_a_preview_is_the_label_and_says_whose_it_is(monkeypatch, tmp_path):
    result = _preview_job(monkeypatch, tmp_path, "pr")
    glu_label = next(g["concept"] for g in result["conceptGroups"] if g["groupId"] == GLU)
    with TestClient(app_module.app) as c:
        r = c.put("/api/harmonize/jobs/pr/artifacts/gate1_rename", json=_rename(GLU, glu_label, "Blood sugar"))
        assert r.status_code == 200, r.text
        rows = _csv(c, "pr")
    by = _by_member(rows)
    assert {(by[m]["group_label"], by[m]["label_source"]) for m in _GLU} == {("Blood sugar", "yours")}
    assert {by[m]["label_source"] for m in _HEAR} == {"keywords"}


def test_the_export_is_free_and_changes_nothing(monkeypatch, tmp_path):
    _preview_job(monkeypatch, tmp_path, "pf")
    with TestClient(app_module.app) as c:
        before = app_module.store.get("pf")
        _csv(c, "pf")
        after = app_module.store.get("pf")
        artifacts = c.get("/api/harmonize/jobs/pf/artifacts").json()["artifacts"]
    assert (after.status, after.config, after.cost_so_far) == (before.status, before.config, before.cost_so_far)
    assert not any(artifacts.values()), "a read wrote a decision"


# ── who may read it ───────────────────────────────────────────────────────────────────────────────


def test_someone_elses_run_is_not_found(monkeypatch, tmp_path):
    result = _preview_job(monkeypatch, tmp_path, "mine")
    with TestClient(app_module.app) as c:
        # The same Preview, but OWNED by somebody else — and this caller is not them.
        app_module.store.create("theirs", "Theirs", {"run_mode": "preview"}, owner_subject="user_B")
        app_module.store.update("theirs", status="complete", phase="complete", result=result)
        theirs = c.get("/api/harmonize/jobs/theirs/gate1.csv")
        missing = c.get("/api/harmonize/jobs/nope/gate1.csv")
        mine = c.get("/api/harmonize/jobs/mine/gate1.csv")
    assert theirs.status_code == 404
    assert missing.status_code == 404
    assert mine.status_code == 200


def test_a_run_with_no_groups_yet_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    with TestClient(app_module.app) as c:
        app_module.store.create("early", "Still clustering", {"run_mode": "preview"})
        r = c.get("/api/harmonize/jobs/early/gate1.csv")
    assert r.status_code == 409
    assert "Gate 1" in r.json()["detail"]


# ── a paid run parked at Gate 1 ───────────────────────────────────────────────────────────────────


def _paid_job(monkeypatch, tmp_path, job_id: str) -> dict:
    """A paid run parked at Gate 1: generated names, a judged group, a split leftover, the uncapped membership."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    fields = {
        "A:glu1": {"name": "glu1", "text": "Fasting glucose", "description": "Fasting glucose", "valueEncoding": ""},
        "A:glu2": {"name": "glu2", "text": "Glucose after a meal", "questionText": "Glucose 2h after eating?"},
        "A:hear1": {
            "name": "hear1",
            "text": "Hearing aid",
            "responseOptions": [{"code": "1", "label": "Yes"}, {"code": "0", "label": "No"}],
        },
        "A:hear2": {"name": "hear2", "text": "Hearing loss", "valueEncoding": "1=Yes|0=No"},
        "A:odd": {"name": "odd", "text": "Number of pets"},
    }
    group = {"conceptIsGenerated": True, "idealCde": "", "coherence": "single", "coherenceSummary": ""}
    result = {
        "mode": "batch",
        "records": [],
        "conceptGroups": [
            {**group, "groupId": "c1#g0", "clusterId": "c1", "concept": "Blood glucose"},
            {**group, "groupId": "c2#g0", "clusterId": "c2", "concept": "Hearing aid use"},
            # The split's leftover: unnamed by the split, so it is a placeholder, never a generated name.
            {**group, "groupId": "c2#g1", "clusterId": "c2", "concept": "", "coherence": "not_judged"},
        ],
        "conceptGroupMembers": {"c1#g0": ["A:glu1", "A:glu2"], "c2#g0": ["A:hear1"], "c2#g1": ["A:hear2"]},
        "fieldIndex": fields,
    }
    wd = tmp_path / "work" / job_id
    app_module.store.create(job_id, "Parked", {"work_dir": str(wd), "cde_set": "endorsed"}, owner_subject=None)
    write_checkpoint(wd, job_id=job_id, gate="gate1", result=result, responses={}, realized_cost=1.0)
    app_module.store.checkpoint(
        job_id, gate="gate1", checkpoint_ref=f"{job_id}/checkpoint_gate1.json", realized_cost=1.0
    )
    return result


def test_a_paid_run_parked_at_gate_1_exports_its_groups_and_their_scope(monkeypatch, tmp_path):
    _paid_job(monkeypatch, tmp_path, "paid")
    with TestClient(app_module.app) as c:
        for kind, payload in [
            ("gate1_group_scope", _scope("c1#g0", "in")),
            ("gate1_rename", _rename("c2#g0", "Hearing aid use", "Hearing aids")),
            ("gate1_regroup", _move("A:hear2", "c2#g1", "c2#g0")),
        ]:
            r = c.put(f"/api/harmonize/jobs/paid/artifacts/{kind}", json=payload)
            assert r.status_code == 200, r.text
        rows = _csv(c, "paid")
    by = _by_member(rows)
    assert (by["A:glu1"]["group_label"], by["A:glu1"]["label_source"], by["A:glu1"]["in_scope"]) == (
        "Blood glucose",
        "generated",
        "yes",
    )
    # Not ticked: Gate 1's default is out, and the file says so rather than leaving it to be guessed.
    assert by["A:hear1"]["in_scope"] == "no"
    assert (by["A:hear2"]["group_id"], by["A:hear2"]["group_label"], by["A:hear2"]["label_source"]) == (
        "c2#g0",
        "Hearing aids",
        "yours",
    )
    # The emptied leftover has no variable left, so it has no row; nothing is in no group here.
    assert "c2#g1" not in {r["group_id"] for r in rows}
    assert by["A:odd"]["group_id"] == "" and by["A:odd"]["in_scope"] == ""
    # The variable's own fields, verbatim — and a coded answer list where the source gave no inline encoding.
    assert by["A:glu2"]["question_text"] == "Glucose 2h after eating?"
    assert by["A:glu1"]["description"] == "Fasting glucose"
    assert by["A:hear2"]["value_encoding"] == "1=Yes|0=No"
    assert by["A:hear1"]["value_encoding"] == "1=Yes|0=No"


def test_a_split_leftover_keeps_its_placeholder_and_a_passed_gate_reads_its_frozen_scope(monkeypatch, tmp_path):
    _paid_job(monkeypatch, tmp_path, "frz")
    job = app_module.store.get("frz")
    app_module.store.update("frz", config={**job.config, "gate1_scope": ["c2#g1"]})
    with TestClient(app_module.app) as c:
        rows = _csv(c, "frz")
    by = _by_member(rows)
    assert by["A:hear2"]["group_label"].startswith("Not named by the split")
    assert by["A:hear2"]["label_source"] == "placeholder"
    assert (by["A:hear2"]["in_scope"], by["A:glu1"]["in_scope"]) == ("yes", "no")
