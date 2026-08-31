"""The pre-Start embedding export — the reviewer's own file, plus the string that will be clustered.

WHY IT EXISTS AT ALL. With preparation going opt-in and off (08-14e), "check what preparation did" is no
longer the question a reviewer has at Setup. The question that remains is the one that always mattered:
*what text will actually be fed to clustering for each of my variables?* That string is composed by core's
``to_embedding_text()`` and is invisible everywhere else in the product — a reviewer can read their own
description column all day and still not know that a mapped ``question_text`` silently outranks it.

WHY IT IS JOB-LESS, which is the whole engineering content of it. Dictionaries live CLIENT-SIDE until
Start (``lib/api.ts``'s ``startHarmonize`` builds its ``FormData`` at press time), so before a run exists
there is no server-side per-dictionary state to hang an export off. ``POST /api/harmonize/score/extract``
is the precedent: a bare ``UploadFile``, no job id, no run created, no provider called, $0. Routing this
through a draft job instead would create run state whose only purpose is a download — state the product
then has to reap.

The four defects it must not have, one test each:

  1. **It must not be a new file.** The reviewer's columns come back verbatim and in order, with exactly
     ONE column appended. A reshaped file turns a question into a reconciliation exercise.
  2. **The appended string must be the real one.** A re-derivation that looks plausible and is wrong is
     worse than no export, because it would answer "why did these group?" authoritatively and falsely.
     The tests compute the expected value through the RUN's own path and demand equality.
  3. **A row that embeds nothing must still be a row.** A variable that composes empty text reaches no
     concept group. That is the single most useful thing this export can show, so it is never dropped.
  4. **A collapsed row must not be attributed.** ``load_dictionary`` keys on the variable name and is
     LAST-WINS on a repeat, so earlier rows never reach the model. Printing the survivor's text against
     them would state the opposite of what happened.
"""

from __future__ import annotations

import csv
import io
import json

from fastapi.testclient import TestClient

from backend import app as app_module
from backend.engine.adapter import (
    EMBEDDING_EXPORT_COLUMN,
    PREPARE_BEFORE_EMBED_DEFAULT,
    build_embedding_export,
    preprocess_for_run,
)

ROLES = {"variable_name": "var", "description": "desc"}


def _read(csv_text: str) -> tuple[list[str], list[dict[str, str]]]:
    reader = csv.DictReader(io.StringIO(csv_text))
    return list(reader.fieldnames or []), list(reader)


def _embedding_text_the_run_will_use(source, *, cohort_name: str, column_roles: dict[str, str]) -> dict[str, str]:
    """What each variable embeds, computed the way the RUN computes it — deliberately not via the export.

    This is the oracle for defect 2, so it must not share a line of code with the thing under test. It
    walks the run's own path: ``load_dictionary``, then the same preparation the run applies (through
    ``preprocess_for_run``, the function the pipeline itself calls), then core's ``to_embedding_text``.
    """
    from ddharmon.ingestion import load_dictionary

    dd = load_dictionary(source, cohort_name=cohort_name, **column_roles)
    if PREPARE_BEFORE_EMBED_DEFAULT:
        preprocess_for_run(dd, source_path=source)
    return {str(f.raw_variable_name or f.variable_name): str(f.to_embedding_text() or "") for f in dd.fields.values()}


# --- the builder ----------------------------------------------------------------------------------------


def test_exactly_one_column_is_appended_and_the_reviewers_own_columns_keep_their_order(tmp_path):
    """Defect 1. The reviewer opens this in Excel next to their source; a reshaped file is not an answer."""
    src = tmp_path / "cohortA.csv"
    src.write_text("var,desc,units,notes\nSMOKE_A,Current smoking status,,free text\nAGE_A,Age in years,years,\n")

    export = build_embedding_export(src, cohort_name="CohortA", column_roles=ROLES)

    assert export.header[:4] == ["var", "desc", "units", "notes"], "the reviewer's own columns moved"
    assert export.header[4:] == [EMBEDDING_EXPORT_COLUMN], "more than one column was appended"
    assert len(export.rows) == 2
    assert export.rows[0][:4] == ["SMOKE_A", "Current smoking status", "", "free text"]


def test_the_appended_string_is_the_one_the_run_will_embed(tmp_path):
    """Defect 2, and the entire value of the feature. Asserted, never eyeballed.

    The file is chosen so a re-derivation would visibly differ: ``question_text`` OUTRANKS ``description``
    in ``to_embedding_text`` while the UI's display derivation reads them the other way round, and
    ``category`` is appended to the composed string rather than ignored. An export that guessed either
    would pass a shape check and fail this one.
    """
    src = tmp_path / "cohortB.csv"
    src.write_text(
        "var,desc,qt,cat\n"
        "BMI,Body mass index derived from height and weight,What is your BMI?,Anthropometry\n"
        "AGE,Age in years,,Demographics\n"
    )
    roles = {"variable_name": "var", "description": "desc", "question_text": "qt", "category": "cat"}

    export = build_embedding_export(src, cohort_name="CohortB", column_roles=roles)
    expected = _embedding_text_the_run_will_use(src, cohort_name="CohortB", column_roles=roles)

    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    by_name = {row[0]: row[cell] for row in export.rows}
    assert by_name == expected
    # And the precedence is REAL, not incidentally equal: the question wins and the category rides along.
    assert by_name["BMI"] == "What is your BMI? | Category: Anthropometry"
    assert "Body mass index" not in by_name["BMI"]


def test_a_variable_that_embeds_nothing_keeps_its_row_and_an_empty_cell(tmp_path):
    """Defect 3. A variable that reaches no concept group is exactly what the reviewer came to find."""
    src = tmp_path / "cohortC.csv"
    # An opaque identity-only code with no primary text embeds the empty string — core's own
    # `_embed_variable_name` branch, and a silent loss everywhere else in the product.
    src.write_text("var,desc\nHAS_TEXT,a real description\n,\nALSO_FINE,another description\n")

    export = build_embedding_export(src, cohort_name="CohortC", column_roles=ROLES)

    assert len(export.rows) == 3, "a row was dropped for embedding nothing"
    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    assert export.rows[1][cell] == ""
    assert export.n_nothing_to_embed >= 1


def test_a_repeated_variable_name_is_counted_and_only_the_surviving_row_carries_the_text(tmp_path):
    """Defect 4. Last-wins is the loader's documented behaviour, so the LAST row is the one that survives."""
    src = tmp_path / "cohortD.csv"
    src.write_text("var,desc\nDUP,first definition\nUNIQ,only definition\nDUP,second definition\n")

    export = build_embedding_export(src, cohort_name="CohortD", column_roles=ROLES)

    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    assert len(export.rows) == 3, "a collapsed row must still be present"
    assert export.rows[0][cell] == "", "the row the loader discarded was credited with text it never gave"
    assert export.rows[2][cell] == "second definition", "the surviving row lost its text"
    assert export.n_rows == 3
    assert export.n_variables == 2
    assert export.n_collapsed == 1
    assert export.repeated_names == ["DUP"]


def test_with_no_variable_name_column_every_row_is_still_attributed(tmp_path):
    """Core synthesises ``_ROW_NNNNN`` names in this case, one per data row, so the join stays exact."""
    src = tmp_path / "cohortE.csv"
    src.write_text("desc,units\nalpha description,kg\nbeta description,cm\n")

    export = build_embedding_export(src, cohort_name="CohortE", column_roles={"description": "desc"})

    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    assert [row[cell] for row in export.rows] == ["alpha description", "beta description"]
    assert export.n_collapsed == 0


def test_the_same_file_twice_produces_byte_identical_output(tmp_path):
    """No run state, no ordering dependence — the export is a pure function of file plus mapping."""
    src = tmp_path / "cohortF.csv"
    src.write_text("var,desc\nA,alpha\nB,beta\nC,gamma\n")

    first = build_embedding_export(src, cohort_name="CohortF", column_roles=ROLES)
    second = build_embedding_export(src, cohort_name="CohortF", column_roles=ROLES)

    assert first.header == second.header
    assert first.rows == second.rows


def test_a_file_that_describes_no_variables_is_refused_rather_than_half_exported(tmp_path):
    """A stated error beats a plausible empty file: an empty download reads as "my dictionary is empty"."""
    import pytest

    src = tmp_path / "empty.csv"
    src.write_text("var,desc\n")

    with pytest.raises(ValueError, match="no variables"):
        build_embedding_export(src, cohort_name="Empty", column_roles=ROLES)


# --- the endpoint ---------------------------------------------------------------------------------------


def _client() -> TestClient:
    return TestClient(app_module.app)


def _post_csv(client: TestClient, name: str, body: str, roles: dict[str, str], cohort: str = "CohortA"):
    return client.post(
        "/api/harmonize/dictionary/embedding.csv",
        files={"files": (name, body, "text/csv")},
        data={"config": json.dumps({"dictionaries": [{"filename": name, "cohortName": cohort, "columnRoles": roles}]})},
    )


def test_the_endpoint_needs_no_job_and_creates_none(tmp_path):
    """The central constraint: dictionaries are client-side until Start, so this cannot depend on a run."""
    client = _client()
    before = set(app_module.store.list_ids()) if hasattr(app_module.store, "list_ids") else None

    res = _post_csv(client, "cohortA.csv", "var,desc\nA,alpha\nB,beta\n", ROLES)

    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")
    assert "attachment" in res.headers["content-disposition"]
    header, rows = _read(res.text)
    assert header[-1] == EMBEDDING_EXPORT_COLUMN
    assert [r[EMBEDDING_EXPORT_COLUMN] for r in rows] == ["alpha", "beta"]
    if before is not None:
        assert set(app_module.store.list_ids()) == before, "the export created run state"


def test_the_endpoint_reports_how_many_rows_the_loader_collapsed():
    """Silent last-wins is this project's longest-standing data loss; the export is where it becomes visible."""
    client = _client()

    res = _post_csv(client, "dup.csv", "var,desc\nDUP,one\nDUP,two\nX,three\n", ROLES)

    assert res.status_code == 200, res.text
    assert res.headers["x-ddharmon-rows"] == "3"
    assert res.headers["x-ddharmon-variables"] == "2"
    assert res.headers["x-ddharmon-collapsed"] == "1"
    assert "DUP" in res.headers["x-ddharmon-repeated-names"]


def test_an_unusable_mapping_is_refused_with_a_reason():
    """The same requirement `/batch` enforces at the door — refused here too, so the two cannot disagree."""
    client = _client()

    res = _post_csv(client, "nomap.csv", "a,b\n1,2\n", {"units": "b"})

    assert res.status_code == 400
    assert "variable_name" in res.json()["detail"]


def test_participant_level_data_is_refused_here_too():
    """A standing product prohibition belongs at every door, not only at the one that starts a run."""
    client = _client()
    body = "participant_id,age\n" + "\n".join(f"P{1000 + i},{40 + i}" for i in range(10)) + "\n"

    res = _post_csv(client, "people.csv", body, {"variable_name": "participant_id"})

    assert res.status_code == 400
    assert "participant" in res.json()["detail"].lower()
