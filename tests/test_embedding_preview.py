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


def test_a_row_that_embeds_nothing_is_still_a_row(tmp_path):
    """Defect 3. A variable that reaches no concept group is exactly what the reviewer came to find.

    The empty row is also the join's sharpest edge. Core reads with pandas' ``skip_blank_lines``, so a row
    of ``,`` is NUMBERED and then discarded for being empty while a truly blank line is gone before
    numbering — measured, not assumed. Dropping the ``,`` row here would shift every synthesised index
    after it, so it is kept and reported as embedding nothing, which is what core did to it.
    """
    src = tmp_path / "cohortC.csv"
    src.write_text("var,desc\nHAS_TEXT,a real description\n,\nALSO_FINE,another description\n")

    export = build_embedding_export(src, cohort_name="CohortC", column_roles=ROLES)

    assert len(export.rows) == 3, "a row was dropped for embedding nothing"
    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    assert export.rows[1][cell] == ""
    assert export.n_nothing_to_embed == 1
    # AND IT IS NOT REPORTED AS A REPEATED NAME. Nothing shared a name here, and sending the reviewer to
    # hunt for a duplicate that does not exist is a worse outcome than saying nothing.
    assert export.n_repeated_kept == 0
    assert export.repeated_names == []


def test_the_synthesised_row_index_survives_an_empty_row_and_a_blank_line(tmp_path):
    """The alignment measurement itself, pinned: get this wrong and every later row is mis-attributed."""
    src = tmp_path / "cohortG.csv"
    src.write_text("desc,units\nalpha,kg\n,\nbeta,cm\n\ngamma,m\n")

    export = build_embedding_export(src, cohort_name="CohortG", column_roles={"description": "desc"})

    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    assert [row[cell] for row in export.rows] == ["alpha", "", "beta", "gamma"]


def test_a_repeated_variable_name_keeps_both_rows_each_with_its_own_text(tmp_path):
    """The loader now DISAMBIGUATES a repeated name (never last-wins collapses it), so BOTH rows survive AND
    each carries its OWN text — the earlier row is no longer blanked as a casualty of the survivor."""
    src = tmp_path / "cohortD.csv"
    src.write_text("var,desc\nDUP,first definition\nUNIQ,only definition\nDUP,second definition\n")

    export = build_embedding_export(src, cohort_name="CohortD", column_roles=ROLES)

    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    assert len(export.rows) == 3
    # Each DUP row keeps its own definition — nothing is blanked.
    assert export.rows[0][cell] == "first definition"
    assert export.rows[2][cell] == "second definition"
    assert export.n_rows == 3
    assert export.n_variables == 3, "both DUP rows are kept as distinct variables now"
    assert export.n_repeated_kept == 1, "one repeated name, kept as distinct (not dropped)"
    assert export.repeated_names == ["DUP"]


def test_with_no_variable_name_column_every_row_is_still_attributed(tmp_path):
    """Core synthesises ``_ROW_NNNNN`` names in this case, one per data row, so the join stays exact."""
    src = tmp_path / "cohortE.csv"
    src.write_text("desc,units\nalpha description,kg\nbeta description,cm\n")

    export = build_embedding_export(src, cohort_name="CohortE", column_roles={"description": "desc"})

    cell = export.header.index(EMBEDDING_EXPORT_COLUMN)
    assert [row[cell] for row in export.rows] == ["alpha description", "beta description"]
    assert export.n_repeated_kept == 0


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


def test_the_endpoint_reports_repeated_names_kept_as_distinct():
    """Silent last-wins was this project's longest-standing data loss; the loader now keeps repeats as
    distinct variables and the export surfaces how many there are to check (header name kept for the FE)."""
    client = _client()

    res = _post_csv(client, "dup.csv", "var,desc\nDUP,one\nDUP,two\nX,three\n", ROLES)

    assert res.status_code == 200, res.text
    assert res.headers["x-ddharmon-rows"] == "3"
    assert res.headers["x-ddharmon-variables"] == "3", "both DUP rows are kept as distinct variables"
    assert res.headers["x-ddharmon-collapsed"] == "1", "one repeated name, kept as distinct (not dropped)"
    assert "DUP" in res.headers["x-ddharmon-repeated-names"]


def test_a_field_over_the_default_csv_size_limit_is_read_not_crashed():
    """A single field larger than Python's default csv.field_size_limit (128 KB) — a long notes /
    value-encoding blob, as UKBB has — used to abort the read with 'field larger than field limit (131072)'
    and 400 the download. The export must lift the limit so a big field is read, not a crash."""
    client = _client()
    big = "x" * (200 * 1024)  # 200 KB — over the 131072 (128 KB) default
    res = _post_csv(client, "big.csv", f"var,desc\nA,{big}\nB,beta\n", ROLES)
    assert res.status_code == 200, res.text
    _, rows = _read(res.text)
    assert any(len(r[EMBEDDING_EXPORT_COLUMN]) >= 200 * 1024 for r in rows), "the large field was dropped"


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


# --- the workbook ---------------------------------------------------------------------------------------
#
# ONE SHEET PER DICTIONARY, and the same computation as the CSV above rather than a second one. Two
# implementations of "what string gets embedded" is precisely the duplication that produces two different
# answers, and the reviewer would have no way to tell which was lying.


def _sheet_rows(data: bytes, title: str) -> list[list[str]]:
    import io as _io

    from openpyxl import load_workbook

    wb = load_workbook(_io.BytesIO(data), read_only=True)
    return [[("" if c is None else str(c)) for c in row] for row in wb[title].iter_rows(values_only=True)]


def _spec(path, cohort: str, roles: dict[str, str] | None = None) -> dict:
    from pathlib import Path as _Path

    return {
        "path": path,
        "filename": _Path(path).name,
        "cohort_name": cohort,
        "column_roles": roles or ROLES,
    }


def test_one_sheet_per_dictionary_each_carrying_its_own_rows_plus_the_embedding_column(tmp_path):
    from openpyxl import load_workbook

    from backend.export.workbook import build_embedding_workbook

    a = tmp_path / "alpha.csv"
    a.write_text("var,desc\nA1,alpha one\nA2,alpha two\n")
    b = tmp_path / "beta.csv"
    b.write_text("var,desc,units\nB1,beta one,kg\n")

    data = build_embedding_workbook([_spec(a, "Alpha"), _spec(b, "Beta")])

    wb = load_workbook(io.BytesIO(data), read_only=True)
    assert wb.sheetnames == ["Alpha", "Beta"]
    rows = _sheet_rows(data, "Alpha")
    assert rows[0] == ["var", "desc", EMBEDDING_EXPORT_COLUMN]
    assert rows[1] == ["A1", "alpha one", "alpha one"]
    assert _sheet_rows(data, "Beta")[0] == ["var", "desc", "units", EMBEDDING_EXPORT_COLUMN]


def test_one_dictionary_still_produces_a_workbook(tmp_path):
    """A reviewer may have uploaded one. A workbook of one sheet is a valid answer, not a degenerate case."""
    from backend.export.workbook import build_embedding_workbook

    a = tmp_path / "solo.csv"
    a.write_text("var,desc\nX,ex\n")

    data = build_embedding_workbook([_spec(a, "Solo")])

    assert _sheet_rows(data, "Solo")[1] == ["X", "ex", "ex"]


def test_two_long_names_differing_only_in_their_tail_get_distinct_sheets():
    """Excel caps a sheet name at 31 characters, so a naive truncation collides silently and loses a sheet."""
    from backend.export.workbook import sheet_names_for

    names = sheet_names_for(
        [
            "cohort_with_a_very_long_name_alpha",
            "cohort_with_a_very_long_name_beta",
            "cohort_with_a_very_long_name_beta",
        ]
    )

    assert len(set(names)) == 3, f"sheet names collided: {names}"
    assert all(len(n) <= 31 for n in names), names


def test_a_sheet_name_survives_excels_forbidden_characters_and_an_empty_name():
    from backend.export.workbook import sheet_names_for

    names = sheet_names_for(["a/b:c*d?e[f]g", "   ", ""])

    for n in names:
        assert n, "a sheet name may not be empty"
        assert len(n) <= 31
        assert not set(n) & set(r"[]:*?/\\"), n
    assert len(set(names)) == 3


def test_a_cell_over_excels_limit_is_truncated_with_a_visible_marker(tmp_path):
    """Excel's 32,767-character cell limit is real, and a SILENT cut would misrepresent the one thing this
    export exists to show — so the cell says it was cut and by how much."""
    from backend.export.workbook import CELL_CHAR_LIMIT, build_embedding_workbook

    long_description = "x" * (CELL_CHAR_LIMIT + 500)
    a = tmp_path / "long.csv"
    a.write_text(f"var,desc\nBIG,{long_description}\nSMALL,short\n")

    data = build_embedding_workbook([_spec(a, "Long")])

    rows = _sheet_rows(data, "Long")
    cell = rows[1][2]
    assert len(cell) <= CELL_CHAR_LIMIT
    assert "truncated" in cell.lower(), "a cut cell must say it was cut"
    # THE COUNT IS MEASURED AGAINST THE WHOLE STRING, including the characters the marker itself
    # displaces — so it is 537, not the 500 by which the text merely exceeded the cap. The larger number
    # is the true one: 537 characters of this variable's embedding text are not in the cell.
    kept, marker = cell.split(" …[truncated, ")
    assert marker == f"{len(long_description) - len(kept)} characters omitted]"
    assert rows[2][2] == "short", "a normal cell was touched"


def test_a_control_character_does_not_fail_the_whole_workbook(tmp_path):
    """Real exports carry control characters; openpyxl refuses them. Losing every sheet to one stray byte
    in one cell is a worse answer than the cell arriving cleaned."""
    from backend.export.workbook import build_embedding_workbook

    a = tmp_path / "ctrl.csv"
    a.write_text("var,desc\nA,before\x07after\n")

    data = build_embedding_workbook([_spec(a, "Ctrl")])

    assert "beforeafter" in _sheet_rows(data, "Ctrl")[1][2]


def test_the_workbook_and_the_per_dictionary_csv_agree_on_every_cell(tmp_path):
    """Neither replaces the other, so they must not be able to disagree — they share one row builder."""
    from backend.export.workbook import build_embedding_workbook

    a = tmp_path / "same.csv"
    a.write_text("var,desc,qt\nA,definition,the question?\nB,,\n")
    roles = {"variable_name": "var", "description": "desc", "question_text": "qt"}

    from_csv = build_embedding_export(a, cohort_name="Same", column_roles=roles)
    rows = _sheet_rows(build_embedding_workbook([_spec(a, "Same", roles)]), "Same")

    assert rows[0] == from_csv.header
    assert rows[1:] == from_csv.rows


def test_the_workbook_endpoint_needs_no_job_either():
    client = _client()
    files = [
        ("files", ("one.csv", "var,desc\nA,alpha\n", "text/csv")),
        ("files", ("two.csv", "var,desc\nB,beta\n", "text/csv")),
    ]
    config = json.dumps(
        {
            "dictionaries": [
                {"filename": "one.csv", "cohortName": "One", "columnRoles": ROLES},
                {"filename": "two.csv", "cohortName": "Two", "columnRoles": ROLES},
            ]
        }
    )

    res = client.post("/api/harmonize/dictionary/embedding.xlsx", files=files, data={"config": config})

    assert res.status_code == 200, res.text
    assert "spreadsheetml" in res.headers["content-type"]
    assert "attachment" in res.headers["content-disposition"]
    assert _sheet_rows(res.content, "One")[1] == ["A", "alpha", "alpha"]
    assert _sheet_rows(res.content, "Two")[1] == ["B", "beta", "beta"]


def test_openpyxl_is_declared_and_not_merely_installed():
    """Undeclared-but-present is how this works locally and 500s on the server the first time it deploys."""
    from pathlib import Path as _Path

    pyproject = _Path(__file__).resolve().parents[1] / "pyproject.toml"
    assert "openpyxl" in pyproject.read_text(), "the workbook export's dependency is not declared"
