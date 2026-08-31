"""Gate 0's export — the reviewer's own file, with what preparation did to it appended.

The question this answers is the one a reviewer actually asks at Gate 0: *the screen tells me 50 variables
changed, but what does my file look like now, and what exactly goes into the model?* The screen can only
show a sample; the export is the whole dictionary.

Three defects it must not have, and each has a test:

  1. **It must not be a new file.** Anything that returns ddharmon's internal view of the dictionary makes
     the reviewer diff two schemas to answer one question. The original columns come back verbatim, in
     their original order, and the prepared values are APPENDED.
  2. **The embedding string must be the real one.** A re-derived approximation is worse than nothing here:
     it would answer "why did these group together?" wrongly while looking authoritative. The column is
     core's own ``to_embedding_text()``.
  3. **A row it cannot attribute must say so.** ``load_dictionary`` keys fields on the variable name and a
     repeated name silently overwrites the earlier row — a named, expensive bug in this project. An export
     that joins on that name would print one row's prepared values against another row's originals. It
     must decline and label the row instead.
"""

from __future__ import annotations

import csv
import io
import json

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.engine.adapter import build_prepared_export

ROLES = {"variable_name": "var", "description": "desc"}


def _read(csv_text: str) -> tuple[list[str], list[dict[str, str]]]:
    reader = csv.DictReader(io.StringIO(csv_text))
    return list(reader.fieldnames or []), list(reader)


def test_the_export_appends_to_the_users_own_columns_and_keeps_their_order(tmp_path):
    """Defect 1: a file the reviewer has to reconcile with their own is not an answer, it is more work."""
    src = tmp_path / "cohortA.csv"
    src.write_text(
        "var,desc,units,notes\n"
        'SMOKE_A,"Current smoking status. <p>Acquired at visit.",,"free text"\n'
        "AGE_A,Age in years,years,\n"
    )

    header, rows = build_prepared_export(src, cohort_name="CohortA", column_roles=ROLES)

    assert header[:4] == ["var", "desc", "units", "notes"], "the reviewer's own columns were reordered"
    assert header[4:] == [
        "ddharmon_variable_name",
        "ddharmon_description",
        "ddharmon_embedding_text",
        "ddharmon_changed",
        "ddharmon_note",
    ]
    assert len(rows) == 2
    # The originals are untouched — including the raw markup preparation strips downstream.
    assert rows[0][:4] == ["SMOKE_A", "Current smoking status. <p>Acquired at visit.", "", "free text"]


def test_the_export_carries_the_exact_string_the_next_step_embeds(tmp_path):
    """Defect 2: the embedding column is core's own composition, asserted against core, not re-derived."""
    from ddharmon.ingestion import load_dictionary
    from ddharmon.ingestion.preprocessor import preprocess_dictionary

    src = tmp_path / "cohortA.csv"
    src.write_text('var,desc\nSMOKE_A,"Current smoking status. <p>Acquired at visit."\nAGE_A,Age in years\n')

    header, rows = build_prepared_export(src, cohort_name="CohortA", column_roles=ROLES)
    embed_col = header.index("ddharmon_embedding_text")

    dd = load_dictionary(src, cohort_name="CohortA", **ROLES)
    preprocess_dictionary(dd)
    expected = {f.raw_variable_name or f.variable_name: f.to_embedding_text() for f in dd.fields.values()}

    for row in rows:
        assert row[embed_col] == expected[row[0]], f"{row[0]} exports a string the model will not see"
    # And it is genuinely the PREPARED text, not the raw one — otherwise the column proves nothing.
    assert "<p>" not in rows[0][embed_col]
    assert rows[0][header.index("ddharmon_changed")] == "description"


def test_a_row_whose_variable_name_repeats_is_labelled_not_guessed(tmp_path):
    """Defect 3: the silent last-wins drop. Two rows, one surviving field — neither may be attributed."""
    src = tmp_path / "dupes.csv"
    src.write_text("var,desc\nBP,Systolic blood pressure\nBP,Diastolic blood pressure\nHR,Heart rate\n")

    header, rows = build_prepared_export(src, cohort_name="CohortA", column_roles=ROLES)
    note = header.index("ddharmon_note")
    prepared = header.index("ddharmon_description")

    dupes = [r for r in rows if r[0] == "BP"]
    assert len(dupes) == 2, "the export dropped a row the reviewer's file has"
    for r in dupes:
        # The note states the fact (how many rows share the name) and the consequence (no attribution),
        # rather than a word: a message that only said "duplicate" would leave the reviewer to guess
        # whether their data was dropped or merely unlabelled.
        assert "appears on 2 rows" in r[note]
        assert "attributed" in r[note]
        assert r[prepared] == "", "a repeated name was attributed to one arbitrary row's values"
    # The unambiguous row is unaffected — the label is per row, not a banner over the file.
    hr = next(r for r in rows if r[0] == "HR")
    assert hr[note] == "" and hr[prepared] == "Heart rate"


def test_a_run_with_no_variable_name_column_declines_rather_than_lining_rows_up_by_luck(tmp_path):
    """With no name to join on, positional alignment is a guess. It must be declared, not performed."""
    src = tmp_path / "nameless.csv"
    src.write_text("desc\nAge in years\nHeart rate\n")

    header, rows = build_prepared_export(src, cohort_name="CohortA", column_roles={"description": "desc"})
    note = header.index("ddharmon_note")
    assert all(r[note] for r in rows), "rows were matched with nothing to match on"


# ── the route ───────────────────────────────────────────────────────────────────────────────


def _submit(client, tmp_path, monkeypatch, body: bytes = b"var,desc\nage,Age in years\n") -> str:
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **kw: None)
    cfg = {
        "dictionaries": [{"filename": "cohortA.csv", "cohortName": "CohortA", "columnRoles": ROLES}],
        "cdeSet": "endorsed",
        "runMode": "preview",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", body, "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["jobId"]


def test_the_export_route_returns_the_prepared_file_as_a_download(monkeypatch, tmp_path):
    client = TestClient(app_module.app)
    job_id = _submit(client, tmp_path, monkeypatch)

    resp = client.get(f"/api/harmonize/jobs/{job_id}/prepared.csv", params={"cohort": "CohortA"})

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers.get("content-disposition", "")
    header, rows = _read(resp.text)
    assert header[:2] == ["var", "desc"]
    assert "ddharmon_embedding_text" in header
    assert rows[0]["ddharmon_embedding_text"] == "Age in years"


def test_the_export_route_404s_on_an_unknown_cohort_rather_than_exporting_the_wrong_one(monkeypatch, tmp_path):
    """Silently falling back to "the first dictionary" would hand the reviewer another cohort's file."""
    client = TestClient(app_module.app)
    job_id = _submit(client, tmp_path, monkeypatch)

    resp = client.get(f"/api/harmonize/jobs/{job_id}/prepared.csv", params={"cohort": "NotMine"})
    assert resp.status_code == 404


def test_the_export_route_is_not_a_new_post_surface(monkeypatch, tmp_path):
    """It reads retained uploads and spends nothing, so it is a GET — and it added no POST of its own.

    The budget itself moved to 16 in 08-14f, which added the PRE-Start siblings of this export (a
    per-dictionary CSV and the whole-set workbook). Those must be POSTs: it runs before a run exists, so the file it describes is in the request body rather
    than on the server. This route's own shape is what is being pinned here, not the total.
    """
    posts = len([1 for r in app_module.app.routes if "POST" in (getattr(r, "methods", None) or set())])
    assert posts == 16, f"the POST surface changed ({posts} != 16)"
