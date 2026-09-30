"""08-28 item 1c — how the notebook applies a recode, and what it does with one that could not be produced.

Three findings from the 2026-09-29 live walk (08-LIVE-VERIFY-3.md), each pinned by the behaviour an analyst
relies on when they run the notebook:

  F16  A spec of kind ``none`` (the model produced an EMPTY code map — nothing could be mapped) was emitted as
       ``h[...] = raw[...]`` "(copy)": raw yes/no codes landed in a 35-value disease column with no warning.
       It must be a commented REVIEW REQUIRED stub. Same for a ``unit`` spec with no conversion factor
       (``needs_units`` — the units could not be reconciled), which rendered ``raw * 1.0 + 0.0``.
  F18  A reviewer's mapping edit saved target LABELS on a GenCDE whose codes differ from its labels, so one
       harmonized column mixed ``"1"``/``"0"`` (the model's recodes) with ``"Yes"``/``"No"`` (the edit). New
       edits store codes (the Gate 3 editor); an edit saved before that fix is applied in the target's CODES,
       resolved through the target's permissible-value table, so every format carries one code space.
"""

from __future__ import annotations

import pytest

from backend.export_decisions import effective_records
from backend.notebook import build_notebook

GENCDE = {
    "isGenerated": True,
    "gencdeId": "GENCDE:c9#g0",
    "preferredName": "Migraine",
    "permissibleValues": [
        {"code": "1", "label": "Yes"},
        {"code": "0", "label": "No"},
        {"code": "9", "label": "Don't know"},
    ],
}


def _t(source: str, target: str, kind: str, **kw) -> dict:
    return {
        "sourceVariable": source,
        "targetCdeId": target,
        "kind": kind,
        "confidence": 0.5,
        "coverage": 0.0,
        "needsUnits": False,
        "needsData": False,
        "needsReview": True,
        "rationale": "",
        "generatedBy": "llm",
        **kw,
    }


def _rec(group: str, members: list[str], transforms: list[dict], *, cde: dict | None = None, **kw) -> dict:
    return {
        "id": group,
        "clusterId": group.split("#")[0],
        "groupId": group,
        "concept": f"concept {group}",
        "verdict": kw.get("verdict", "adopt" if cde else "novel"),
        "route": "assigned" if cde else "gencde_residual",
        "cde": cde,
        "gencde": kw.get("gencde"),
        "members": members,
        "transforms": transforms,
        "candidates": [],
        "cohorts": sorted({m.split(":")[0] for m in members}),
    }


def _code(nb: dict) -> str:
    return "\n".join("".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code")


def _run_py(nb: dict, frames: dict[str, dict], tmp_path, monkeypatch) -> dict:
    """Execute a Python notebook's per-cohort cells against in-memory raw frames; return the namespace."""
    pd = pytest.importorskip("pandas")
    monkeypatch.chdir(tmp_path)
    for cohort, cols in frames.items():
        pd.DataFrame(cols).to_csv(f"{cohort}.csv", index=False)
    ns: dict = {}
    for cell in nb["cells"]:
        src = "".join(cell["source"])
        if cell["cell_type"] == "code" and "harmonized" not in src:
            exec(src, ns)  # noqa: S102 — the point is to run the generated code
    return ns


# --- F16: a spec that could not be produced is a stub, never a copy ------------------------------------


@pytest.mark.parametrize("lang", ["py", "r"])
def test_a_kind_none_spec_is_a_review_stub_never_a_copy(lang):
    rec = _rec("c1#g0", ["A:diab"], [_t("A:diab", "DiseaseCDE", "none")], cde={"id": "DiseaseCDE", "externalId": ""})
    code = _code(build_notebook({"records": [rec]}, lang))
    assert "REVIEW REQUIRED" in code
    assert "(copy)" not in code
    assign_py, assign_r = 'h_A["DiseaseCDE"] =', 'h_A[["DiseaseCDE"]] <-'
    live = [ln for ln in code.splitlines() if not ln.lstrip().startswith("#")]
    assert not any(assign_py in ln or assign_r in ln for ln in live), "a kind-none spec must not assign the column"


@pytest.mark.parametrize("lang", ["py", "r"])
def test_a_unit_spec_with_no_conversion_factor_is_a_review_stub(lang):
    t = _t("A:wt", "WeightCDE", "unit", needsUnits=True, sourceUnit="stone")  # units not reconcilable, no factor
    rec = _rec("c2#g0", ["A:wt"], [t], cde={"id": "WeightCDE", "externalId": ""})
    code = _code(build_notebook({"records": [rec]}, lang))
    assert "REVIEW REQUIRED" in code
    assert "* 1.0 + 0.0" not in code, "a unit spec with no factor must not be applied as a no-op conversion"
    live = [ln for ln in code.splitlines() if not ln.lstrip().startswith("#")]
    assert not any("WeightCDE" in ln and "raw_A" in ln for ln in live)


@pytest.mark.parametrize("lang", ["py", "r"])
def test_a_kind_the_notebook_cannot_apply_is_a_review_stub_not_a_copy(lang):
    """The fall-through (e.g. a wide→long reshape) used to copy the raw column onto the target as well."""
    rec = _rec("c6#g0", ["A:bp_1"], [_t("A:bp_1", "BPCDE", "wide_to_long")], cde={"id": "BPCDE", "externalId": ""})
    code = _code(build_notebook({"records": [rec]}, lang))
    assert "REVIEW REQUIRED" in code and "wide_to_long" in code
    live = [ln for ln in code.splitlines() if not ln.lstrip().startswith("#")]
    assert not any("BPCDE" in ln and "raw_A" in ln for ln in live)


@pytest.mark.parametrize("lang", ["py", "r"])
def test_a_unit_spec_with_a_factor_still_converts_and_identity_still_copies(lang):
    rec = _rec(
        "c3#g0",
        ["A:ht", "A:age"],
        [
            _t("A:ht", "HeightCDE", "unit", factor=2.54, offset=0.0, sourceUnit="in", targetUnit="cm"),
            _t("A:age", "AgeCDE", "identity"),
        ],
        cde={"id": "HeightCDE", "externalId": ""},
    )
    code = _code(build_notebook({"records": [rec]}, lang))
    assert "* 2.54 + 0.0" in code
    assert ('h_A["AgeCDE"] = raw_A["age"]' in code) or ('h_A[["AgeCDE"]] <- raw_A[["age"]]' in code)


def test_a_reviewer_mapping_on_a_kind_none_spec_is_applied(tmp_path, monkeypatch):
    """The stub is for the MODEL's failure. Once the reviewer maps the codes at Gate 3, that mapping is applied."""
    rec = _rec("c4#g0", ["A:diab"], [_t("A:diab", "DiseaseCDE", "none")], cde={"id": "DiseaseCDE", "externalId": ""})
    grouped = {
        "gate3_spec_edit": [
            {"sourceVariable": "A:diab", "chosen": "A:diab", "alternatives": [], "optionSetKey": "k",
             "mapping": {"1": "Diabetes", "2": "__missing__"}},
        ]
    }  # fmt: skip
    records = effective_records({"records": [rec]}, {}, grouped)
    nb = build_notebook({"records": records}, "py")
    assert "REVIEW REQUIRED" not in _code(nb)
    ns = _run_py(nb, {"A": {"diab": ["1", "2"]}}, tmp_path, monkeypatch)
    import pandas as pd

    assert [None if pd.isna(v) else v for v in ns["h_A"]["DiseaseCDE"]] == ["Diabetes", None]


# --- F18: one code space per column ----------------------------------------------------------------------


def _gencde_record(transforms: list[dict]) -> dict:
    return _rec("c9#g0", [t["sourceVariable"] for t in transforms], transforms, gencde=GENCDE)


def test_a_mapping_saved_in_the_targets_codes_is_applied_as_codes(tmp_path, monkeypatch):
    t = _t("A:mig", GENCDE["gencdeId"], "categorical", codeMap={"1": "1", "2": "0"}, unmappedSourceCodes=["-121"])
    grouped = {
        "gate3_spec_edit": [
            {"sourceVariable": "A:mig", "chosen": "A:mig", "alternatives": [], "optionSetKey": "k",
             "mapping": {"1": "1", "2": "0", "-121": "9", "-818": "__missing__"}},
        ]
    }  # fmt: skip
    records = effective_records({"records": [_gencde_record([t])]}, {}, grouped)
    nb = build_notebook({"records": records}, "py")
    ns = _run_py(nb, {"A": {"mig": ["1", "2", "-121", "-818"]}}, tmp_path, monkeypatch)
    import pandas as pd

    col = ns["h_A"][GENCDE["gencdeId"]]
    assert [None if pd.isna(v) else v for v in col] == ["1", "0", "9", None]


def test_a_legacy_label_mapping_is_applied_in_the_targets_codes(tmp_path, monkeypatch):
    """An edit saved before the fix holds LABELS. Applied verbatim it would mix "Yes" into a column of "1"s (F18),
    so it is resolved through the target's permissible values — in every format, since they all read the
    effective records."""
    edited = _t("A:mig", GENCDE["gencdeId"], "categorical", codeMap={"1": "1", "2": "0"})
    model = _t("B:mig", GENCDE["gencdeId"], "categorical", codeMap={"Y": "1", "N": "0"})
    grouped = {
        "gate3_spec_edit": [
            {"sourceVariable": "A:mig", "chosen": "A:mig", "alternatives": [], "optionSetKey": "k",
             "mapping": {"1": "Yes", "2": "No", "-121": "Don't know", "-818": "__missing__"}},
        ]
    }  # fmt: skip
    records = effective_records({"records": [_gencde_record([edited, model])]}, {}, grouped)
    by_src = {t["sourceVariable"]: t for t in records[0]["transforms"]}
    assert by_src["A:mig"]["reviewerEdit"]["mapping"] == {"1": "1", "2": "0", "-121": "9", "-818": "__missing__"}

    code = _code(build_notebook({"records": records}, "py"))
    assert "'Yes'" not in code and '"Yes"' not in code, "a label reached the notebook as a target value"
    ns = _run_py(
        build_notebook({"records": records}, "py"), {"A": {"mig": ["1", "-121"]}, "B": {"mig": ["Y", "N"]}}, tmp_path,
        monkeypatch,
    )  # fmt: skip
    assert list(ns["h_A"][GENCDE["gencdeId"]]) == ["1", "9"]
    assert list(ns["h_B"][GENCDE["gencdeId"]]) == ["1", "0"]


def test_a_legacy_label_binning_is_applied_in_the_targets_codes():
    t = _t("A:n", GENCDE["gencdeId"], "none")
    grouped = {
        "gate3_spec_edit": [
            {"sourceVariable": "A:n", "chosen": "A:n", "alternatives": [], "optionSetKey": "k",
             "bins": [{"band": "No", "min": None, "max": 0}, {"band": "Yes", "min": 1, "max": None}]},
        ]
    }  # fmt: skip
    records = effective_records({"records": [_gencde_record([t])]}, {}, grouped)
    bins = records[0]["transforms"][0]["reviewerEdit"]["bins"]
    assert [b["band"] for b in bins] == ["0", "1"]


def test_a_catalog_targets_mapping_is_left_as_saved():
    """A catalog CDE's value IS its label, so there is nothing to translate — and a value the table does not
    know is never rewritten."""
    t = _t("A:s", "SmokeCDE", "categorical", codeMap={"1": "Current"})
    rec = _rec("c5#g0", ["A:s"], [t], cde={"id": "SmokeCDE", "externalId": ""})
    grouped = {
        "gate3_spec_edit": [
            {"sourceVariable": "A:s", "chosen": "A:s", "alternatives": [], "optionSetKey": "k",
             "mapping": {"1": "Current", "2": "Never"}},
        ]
    }  # fmt: skip
    records = effective_records({"records": [rec]}, {}, grouped)
    assert records[0]["transforms"][0]["reviewerEdit"]["mapping"] == {"1": "Current", "2": "Never"}
