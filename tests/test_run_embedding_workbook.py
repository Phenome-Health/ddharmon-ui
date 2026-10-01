"""The STARTED run's embedding workbook — every dictionary of the run, one sheet each, with the text it embedded.

WHY IT EXISTS (phase-8 final review, round 1). Before Start, Setup offers the whole set as one workbook
(``POST /dictionary/embedding.xlsx``, 08-14f) — but only in the compose stage, because that route needs the
files in the request body. Once a run exists, Setup's "Check your dictionaries yourself" card offered only
per-dictionary CSVs, so the workbook a reviewer had before Start was gone after it. Bhargav: *"missing the
multi sheet excel files of post-embedding text data dicts"*.

The run already retains its uploads (``job.dict_specs``), so the job-scoped version re-reads them — a GET,
$0, no model called, nothing embedded — and builds the SAME workbook through the SAME builder.

Three things it must get right, one test each:

  1. **One sheet per dictionary of the run**, in the run's own order, each the dictionary's own columns plus
     ``ddharmon_embedding_text`` — the same cells the pre-Start workbook and the per-dictionary CSV carry.
  2. **The text is what THIS run embedded.** A run records whether it prepared its dictionaries
     (``config["preprocess"]``, 08-14e); the workbook must follow that record, not the product's current
     default, or it shows a string the run never embedded.
  3. **Refusals, not partial files**: an unknown/invisible run is a 404, a retained upload that is gone is a
     409 — a workbook silently missing a sheet is the failure a reviewer is least likely to notice.
"""

from __future__ import annotations

import io
import json

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.engine.adapter import EMBEDDING_EXPORT_COLUMN, build_embedding_export

ROLES = {"variable_name": "var", "description": "desc"}

#: Preparation strips the markup; an unprepared run embeds it verbatim. So this one row tells the two apart.
_MARKUP = "Current smoking status. <p>Acquired at visit."


def _submit(client, tmp_path, monkeypatch, dictionaries: list[tuple[str, str, str]]) -> str:
    """Start a (stubbed) run over ``(filename, cohortName, csv body)`` triples and return its id."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **kw: None)
    cfg = {
        "dictionaries": [{"filename": f, "cohortName": c, "columnRoles": ROLES} for f, c, _ in dictionaries],
        "cdeSet": "endorsed",
        "runMode": "preview",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", (f, body.encode(), "text/csv")) for f, _, body in dictionaries],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["jobId"]


def _sheets(data: bytes) -> dict[str, list[list[str]]]:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True)
    return {
        name: [[("" if c is None else str(c)) for c in row] for row in wb[name].iter_rows(values_only=True)]
        for name in wb.sheetnames
    }


def test_the_run_workbook_has_one_sheet_per_dictionary_with_the_embedding_column(monkeypatch, tmp_path):
    client = TestClient(app_module.app)
    job_id = _submit(
        client,
        tmp_path,
        monkeypatch,
        [
            ("alpha.csv", "Alpha", "var,desc,units\nA1,alpha one,kg\nA2,alpha two,\n"),
            ("beta.csv", "Beta", "var,desc\nB1,beta one\n"),
        ],
    )

    res = client.get(f"/api/harmonize/jobs/{job_id}/embedding.xlsx")

    assert res.status_code == 200, res.text
    assert "spreadsheetml" in res.headers["content-type"]
    assert "attachment" in res.headers["content-disposition"]
    assert res.headers["x-ddharmon-sheets"] == "2"
    sheets = _sheets(res.content)
    assert list(sheets) == ["Alpha", "Beta"], "a sheet per dictionary, in the run's own order"
    assert sheets["Alpha"][0] == ["var", "desc", "units", EMBEDDING_EXPORT_COLUMN]
    assert sheets["Alpha"][1:] == [["A1", "alpha one", "kg", "alpha one"], ["A2", "alpha two", "", "alpha two"]]
    assert sheets["Beta"][1] == ["B1", "beta one", "beta one"]


def test_the_run_workbook_follows_the_runs_own_recorded_preparation(monkeypatch, tmp_path):
    """The workbook must show what THIS run embedded — its recorded `preprocess`, not today's default."""
    client = TestClient(app_module.app)
    body = f'var,desc\nSMOKE_A,"{_MARKUP}"\nAGE_A,Age in years\n'
    job_id = _submit(client, tmp_path, monkeypatch, [("cohortA.csv", "CohortA", body)])
    source = app_module.store.get(job_id).dict_specs[0]["path"]

    # As created today: the run records `preprocess: False`, so it embedded the markup verbatim.
    assert app_module.store.get(job_id).config["preprocess"] is False
    unprepared = _sheets(client.get(f"/api/harmonize/jobs/{job_id}/embedding.xlsx").content)["CohortA"]
    expected = build_embedding_export(source, cohort_name="CohortA", column_roles=ROLES, prepare=False)
    assert unprepared[1:] == expected.rows
    assert unprepared[1][2] == _MARKUP

    # A run that recorded preparation ON (every run before 08-14e) embedded the PREPARED text instead.
    job = app_module.store.get(job_id)
    app_module.store.update(job_id, config={**job.config, "preprocess": True})
    prepared = _sheets(client.get(f"/api/harmonize/jobs/{job_id}/embedding.xlsx").content)["CohortA"]
    assert "<p>" not in prepared[1][2], "a prepared run's workbook showed the raw, unembedded text"
    assert prepared[1:] == build_embedding_export(source, cohort_name="CohortA", column_roles=ROLES, prepare=True).rows


def test_long_cohort_names_still_get_one_distinct_sheet_each(monkeypatch, tmp_path):
    """Excel's 31-character sheet-name cap must not fold two of the run's dictionaries onto one sheet."""
    client = TestClient(app_module.app)
    long_a = "cohort_with_a_very_long_name_alpha"
    long_b = "cohort_with_a_very_long_name_beta"
    job_id = _submit(
        client,
        tmp_path,
        monkeypatch,
        [("a.csv", long_a, "var,desc\nA,alpha\n"), ("b.csv", long_b, "var,desc\nB,beta\n")],
    )

    sheets = _sheets(client.get(f"/api/harmonize/jobs/{job_id}/embedding.xlsx").content)

    assert len(sheets) == 2, f"two dictionaries collapsed onto one sheet: {list(sheets)}"
    assert all(len(n) <= 31 for n in sheets), list(sheets)


def test_an_unknown_run_is_a_404(monkeypatch, tmp_path):
    client = TestClient(app_module.app)
    _submit(client, tmp_path, monkeypatch, [("a.csv", "A", "var,desc\nA,alpha\n")])

    assert client.get("/api/harmonize/jobs/not-a-run/embedding.xlsx").status_code == 404


def test_a_run_whose_upload_is_gone_refuses_rather_than_dropping_a_sheet(monkeypatch, tmp_path):
    from pathlib import Path

    client = TestClient(app_module.app)
    job_id = _submit(
        client,
        tmp_path,
        monkeypatch,
        [("a.csv", "A", "var,desc\nA,alpha\n"), ("b.csv", "B", "var,desc\nB,beta\n")],
    )
    Path(app_module.store.get(job_id).dict_specs[1]["path"]).unlink()

    res = client.get(f"/api/harmonize/jobs/{job_id}/embedding.xlsx")

    assert res.status_code == 409
    assert "B" in res.json()["detail"]


def test_the_per_dictionary_csv_and_the_run_workbook_agree_on_the_embedding_text(monkeypatch, tmp_path):
    """Both downloads sit on one card at Setup, so they must not name two different strings for one variable.

    The per-dictionary CSV used to ALWAYS prepare, so on a run that did not prepare (every run since 08-14e) its
    ``ddharmon_embedding_text`` was text the run never embedded — and it would contradict the workbook beside it.
    """
    import csv

    client = TestClient(app_module.app)
    body = f'var,desc\nSMOKE_A,"{_MARKUP}"\nAGE_A,Age in years\n'
    job_id = _submit(client, tmp_path, monkeypatch, [("cohortA.csv", "CohortA", body)])

    workbook = _sheets(client.get(f"/api/harmonize/jobs/{job_id}/embedding.xlsx").content)["CohortA"]
    res = client.get(f"/api/harmonize/jobs/{job_id}/prepared.csv", params={"cohort": "CohortA"})
    rows = list(csv.DictReader(io.StringIO(res.text)))

    assert [r["ddharmon_embedding_text"] for r in rows] == [r[2] for r in workbook[1:]]
    # Nothing was prepared on this run, so the CSV must not claim preparation changed anything.
    assert all(r["ddharmon_changed"] == "" for r in rows)
