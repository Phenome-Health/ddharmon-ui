"""Candidate catalog metadata on the wire (08-26 Task 1, live-test-2 #7).

THE BUG THIS PINS. Gate 3 chooses its recode surface from the chosen target's ``dataType`` + permissible
values. Core's ``CandidateCDE`` carries only rank/id/definition/cosine, and ``_candidate_to_ui`` passed
exactly that through — the catalog metadata the recode editor keys off was joined in ONLY for the shipped
demo fixture, by an offline dev script (``scripts/enrich_candidates.py``). So every REAL run (e.g.
573cf61f) put candidates on the wire with no ``dataType`` and no ``permissibleValues``, and the UI read
"no type, no values" as a number: a coded Yes/No target (``Current Pregnancy Indicator``, a catalog
``Value List``) rendered the numeric code->number editor ("numeric responses pass through").

The fix is the join the dev script prototyped, done where the catalog already lives: the CDE dictionary
is one of the run's embedded dictionaries, so the adapter reads each candidate's metadata off it.
"""

from __future__ import annotations

from types import SimpleNamespace

from ddharmon.harmonization.leanb import LeanBResult
from ddharmon.harmonization.models import CandidateCDE, LeanBRecord
from ddharmon.ingestion import load_dictionary

from backend.engine.adapter import build_cde_catalog_index, build_ui_result

CDE_ROLES = {
    "variable_name": "designation",
    "field_id": "tinyId",
    "description": "definition",
    "question_text": "question_text",
    "data_type": "datatype",
    "value_encoding": "permissible_values",
}


def _catalog(tmp_path):
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\ttinyId\tdefinition\tquestion_text\tdatatype\tpermissible_values\n"
        "Current Pregnancy Indicator\tLiUWCWluP\tpregnancy status\tAre you pregnant now?\tValue List\t"
        "Yes | No | Unknown\n"
        "Age\tfmMMaUGpKS\tage in years\t\tNumber\t\n"
    )
    dd = load_dictionary(str(cde), cohort_name="NIH_CDE", **CDE_ROLES)
    src = tmp_path / "src.csv"
    src.write_text("var,desc,enc\npreg,Are you pregnant,1=Yes|2=No\n")
    sdd = load_dictionary(str(src), cohort_name="CLSA", variable_name="var", description="desc", value_encoding="enc")
    return [SimpleNamespace(dictionary=sdd), SimpleNamespace(dictionary=dd)]


def _record() -> LeanBRecord:
    return LeanBRecord(
        cluster_id="c1",
        group_id="c1#g0",
        concept="pregnancy",
        verdict="adopt",
        route="assigned",
        cde_id="Current Pregnancy Indicator",
        member_variable_names=["CLSA:preg"],
        cohorts=["CLSA"],
        n_members=1,
        candidates=[
            CandidateCDE(
                rank=1,
                cde_id="Current Pregnancy Indicator",
                cde_external_id="LiUWCWluP",
                definition="pregnancy status",
                cosine=0.74,
                is_chosen=True,
            ),
            CandidateCDE(rank=2, cde_id="Age", cde_external_id="fmMMaUGpKS", definition="age", cosine=0.3),
            CandidateCDE(rank=3, cde_id="Not In Catalog", cde_external_id="", definition="?", cosine=0.1),
        ],
    )


def test_catalog_index_reads_type_and_values_off_the_cde_dictionary(tmp_path):
    idx = build_cde_catalog_index(_catalog(tmp_path), "NIH_CDE")
    preg = idx["Current Pregnancy Indicator"]
    assert preg["dataType"] == "Value List"
    assert preg["permissibleValues"] == ["Yes", "No", "Unknown"]
    assert preg["questionText"] == "Are you pregnant now?"
    # source (non-CDE) dictionaries are not the catalog and never land in it
    assert "preg" not in idx
    # a Number CDE carries its type and NO value list (an absent list is omitted, not emitted empty)
    assert idx["Age"]["dataType"] == "Number"
    assert "permissibleValues" not in idx["Age"]


def test_candidates_on_the_wire_carry_catalog_type_and_values(tmp_path):
    idx = build_cde_catalog_index(_catalog(tmp_path), "NIH_CDE")
    result = build_ui_result(LeanBResult(records=[_record()]), mode="batch", phases=["loading"], cde_index=idx)
    cands = result["records"][0]["candidates"]
    assert cands[0]["dataType"] == "Value List"
    assert cands[0]["permissibleValues"] == ["Yes", "No", "Unknown"]
    assert cands[1]["dataType"] == "Number" and "permissibleValues" not in cands[1]
    # a candidate the catalog does not know keeps its bare shape — never an invented type
    assert "dataType" not in cands[2] and "permissibleValues" not in cands[2]
    # the core fields are untouched by the join
    assert cands[0]["cdeId"] == "Current Pregnancy Indicator" and cands[0]["rank"] == 1


def test_no_catalog_index_keeps_the_legacy_bare_candidate(tmp_path):
    result = build_ui_result(LeanBResult(records=[_record()]), mode="batch", phases=["loading"])
    assert "dataType" not in result["records"][0]["candidates"][0]
