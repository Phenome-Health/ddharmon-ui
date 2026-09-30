"""08-28 1h (F13): a Gate 2 pick carries the catalog's own id (tinyId) BESIDE the name, and the id wins.

THE DEFECT. ``gate2_candidate_pick.chosen`` stores the CDE's name (core's CDE id IS the catalog designation), and
catalog names are not unique: the NIH-endorsed catalog repeats "Age", "Age Units" and "Employment Status" (the
full catalog: 374 names over 848 rows, "Age" x4). Core's loader keeps every row by minting ``Age__2`` for the
later ones, but a pick that says only "Age" cannot say WHICH "Age" the reviewer meant.

THE DEFAULT TAKEN (08-28-PLAN "Defaults taken"): no core id switch in this pass. Instead the pick also records
``externalId`` (the tinyId), every place a pick is applied resolves through it first, and duplicate names are
disambiguated visibly on Gate 2 (the wire marks them with ``sharedName``).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from ddharmon.harmonization.models import CandidateCDE, LeanBRecord
from ddharmon.ingestion import load_dictionary
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.engine.adapter import _candidate_to_ui, apply_reviewer_picks, build_cde_catalog_index
from backend.export_decisions import _catalog_ref, effective_records
from tests.test_gate2_picks import _parked_at, _put_pick

CDE_ROLES = {
    "variable_name": "designation",
    "field_id": "tinyId",
    "description": "definition",
    "data_type": "datatype",
    "value_encoding": "permissible_values",
}

#: The two endorsed-catalog "Age" elements (tinyIds as in ``nih_endorsed_flat.tsv``), in catalog order.
AGE_FIRST, AGE_SECOND = "PDjBiGXjO", "fmMMaUGpKS"


def _catalog(tmp_path: Path) -> SimpleNamespace:
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\ttinyId\tdefinition\tdatatype\tpermissible_values\n"
        f"Age\t{AGE_FIRST}\tAge of the participant at the visit\tNumber\t\n"
        "Sex\tSx1\tBiological sex\tValue List\tMale | Female\n"
        f"Age\t{AGE_SECOND}\tAge in years at enrollment\tNumber\t\n"
    )
    return SimpleNamespace(dictionary=load_dictionary(str(cde), cohort_name="NIH_CDE", **CDE_ROLES))


def _age_record(model_pick: str = "Age") -> LeanBRecord:
    ext = {"Age": AGE_FIRST, "Age__2": AGE_SECOND}
    return LeanBRecord(
        cluster_id="c1",
        group_id="c1#g0",
        concept="age",
        verdict="adopt",
        route="assigned",
        cde_id=model_pick,
        cde_external_id=ext[model_pick],
        member_variable_names=["CLSA:age"],
        cohorts=["CLSA"],
        n_members=1,
        candidates=[
            CandidateCDE(
                rank=1,
                cde_id="Age",
                cde_external_id=AGE_FIRST,
                definition="visit age",
                cosine=0.8,
                is_chosen=model_pick == "Age",
            ),
            CandidateCDE(
                rank=2,
                cde_id="Age__2",
                cde_external_id=AGE_SECOND,
                definition="enrollment age",
                cosine=0.7,
                is_chosen=model_pick == "Age__2",
            ),
        ],
    )


def _no_stage(prompts):  # a numeric catalog target needs no paid recode; anything asked is a test failure
    assert not prompts, "a pick on a no-value-list target should not reach a paid stage"
    return {}


# ── the wire: duplicate catalog names are marked so Gate 2 can show which is which ────────────────────────


def test_a_repeated_catalog_name_is_marked_on_every_row_that_shares_it(tmp_path):
    idx = build_cde_catalog_index([_catalog(tmp_path)], "NIH_CDE")
    assert idx["Age"]["sharedName"] == "Age"
    assert idx["Age__2"]["sharedName"] == "Age", "the minted id must still name the catalog's own designation"
    assert "sharedName" not in idx["Sex"], "a unique name needs no disambiguation"


def test_the_candidate_on_the_wire_carries_the_shared_name(tmp_path):
    idx = build_cde_catalog_index([_catalog(tmp_path)], "NIH_CDE")
    ui = [_candidate_to_ui(c, idx) for c in _age_record().candidates]
    assert [(c["cdeId"], c["cdeExternalId"], c.get("sharedName")) for c in ui] == [
        ("Age", AGE_FIRST, "Age"),
        ("Age__2", AGE_SECOND, "Age"),
    ]


def test_the_endorsed_catalog_marks_exactly_its_three_repeated_names():
    path = app_module.CDE_FILES["endorsed"]
    if not Path(path).exists():
        pytest.skip("the endorsed CDE catalog is not on this machine (data/cde is gitignored)")
    from backend.app import CDE_COHORT, CDE_COLUMN_ROLES

    dd = load_dictionary(str(path), cohort_name=CDE_COHORT, **CDE_COLUMN_ROLES)
    idx = build_cde_catalog_index([SimpleNamespace(dictionary=dd)], CDE_COHORT)
    # the index is keyed by the dictionary key AND by tinyId; count the catalog rows once each
    shared = {k: v["sharedName"] for k, v in idx.items() if k in dd.fields and "sharedName" in v}
    assert sorted(set(shared.values())) == ["Age", "Age Units", "Employment Status"]
    assert len(shared) == 6


# ── applying a pick (the Gate 2 -> Gate 3 leg): the catalog id resolves an ambiguous name ────────────────


def test_an_ambiguous_name_resolves_by_external_id(tmp_path):
    """The model picked the first "Age"; the reviewer picked the SECOND one — same name, different element."""
    cat = _catalog(tmp_path)
    rec = _age_record("Age")
    changed = apply_reviewer_picks(
        [rec],
        {"c1#g0": {"chosen": "Age", "externalId": AGE_SECOND}},
        [cat],
        dict(cat.dictionary.fields),
        model_tag=None,
        stage_fn=_no_stage,
    )
    assert changed == ["c1#g0"], "the pick was read as a confirmation of the model's same-named CDE"
    assert (rec.cde_id, rec.cde_external_id) == ("Age__2", AGE_SECOND)
    assert [c.cde_id for c in rec.candidates if c.is_chosen] == ["Age__2"]
    assert rec.raw["reviewer_pick"]["target"] == "Age__2"


def test_the_external_id_of_the_models_own_pick_is_a_confirmation(tmp_path):
    cat = _catalog(tmp_path)
    rec = _age_record("Age")
    changed = apply_reviewer_picks(
        [rec],
        {"c1#g0": {"chosen": "Age", "externalId": AGE_FIRST}},
        [cat],
        dict(cat.dictionary.fields),
        model_tag=None,
        stage_fn=_no_stage,
    )
    assert changed == [] and rec.cde_id == "Age"


def test_a_pick_without_an_external_id_is_read_by_name_as_before(tmp_path):
    cat = _catalog(tmp_path)
    rec = _age_record("Age")
    changed = apply_reviewer_picks(
        [rec], {"c1#g0": {"chosen": "Age__2"}}, [cat], dict(cat.dictionary.fields), model_tag=None, stage_fn=_no_stage
    )
    assert changed == ["c1#g0"] and (rec.cde_id, rec.cde_external_id) == ("Age__2", AGE_SECOND)


def test_the_resume_leg_is_handed_the_picks_external_id(tmp_path, monkeypatch):
    seen = _parked_at(tmp_path, monkeypatch, "gate2", "x2")
    with TestClient(app_module.app) as c:
        _put_pick(c, "x2", {"groupId": "g1", "chosen": "Age", "externalId": AGE_SECOND})
        _put_pick(c, "x2", {"groupId": "g2", "chosen": ""})  # "none of these" has no catalog id
        assert c.post("/api/harmonize/resume/x2", headers={"x-anthropic-key": "sk-test"}).status_code == 200
    assert seen["gate2_picks"] == {
        "g1": {"chosen": "Age", "gencdeEdit": None, "externalId": AGE_SECOND},
        "g2": {"chosen": "", "gencdeEdit": None},
    }


# ── the exports: the reviewer's element, by its catalog id ───────────────────────────────────────────────


def _wire_record(model_pick: str = "Age") -> dict:
    ext = {"Age": AGE_FIRST, "Age__2": AGE_SECOND}
    return {
        "id": "c1#g0",
        "groupId": "c1#g0",
        "concept": "age",
        "verdict": "adopt",
        "cde": {"id": model_pick, "externalId": ext[model_pick]},
        "gencde": None,
        "transforms": [],
        "candidates": [
            {"rank": 1, "cdeId": "Age", "cdeExternalId": AGE_FIRST, "isChosen": model_pick == "Age"},
            {"rank": 2, "cdeId": "Age__2", "cdeExternalId": AGE_SECOND, "isChosen": model_pick == "Age__2"},
        ],
    }


def _pick(chosen: str, **extra) -> dict:
    return {"groupId": "c1#g0", "chosen": chosen, "alternatives": ["Age", "Age__2"], "optionSetKey": "k", **extra}


def test_the_catalog_ref_resolves_an_ambiguous_name_by_external_id():
    assert _catalog_ref(_wire_record(), "Age", AGE_SECOND) == {"id": "Age__2", "externalId": AGE_SECOND}
    assert _catalog_ref(_wire_record(), "Age") == {"id": "Age", "externalId": AGE_FIRST}  # no id: by name


def test_an_exported_repick_names_the_element_the_reviewer_chose():
    grouped = {"gate2_candidate_pick": [_pick("Age", externalId=AGE_SECOND)]}
    [rec] = effective_records({"records": [_wire_record()]}, {}, grouped)
    assert rec["cde"] == {"id": "Age__2", "externalId": AGE_SECOND}
    assert rec["targetPickedBy"] == "reviewer"


def test_an_exported_confirmation_by_external_id_stays_the_models():
    grouped = {"gate2_candidate_pick": [_pick("Age", externalId=AGE_FIRST)]}
    [rec] = effective_records({"records": [_wire_record()]}, {}, grouped)
    assert rec["cde"] == {"id": "Age", "externalId": AGE_FIRST}
    assert rec["targetPickedBy"] == "model"
