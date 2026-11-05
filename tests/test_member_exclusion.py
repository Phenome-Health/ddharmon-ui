"""Removing a rogue variable from one concept at Gate 3 (review round 2, Gate 3 note 2).

Bhargav, on the final run: "take a look at 'LV renamed · Self-reported overall general health sta', somehow a
self-reported weight var slipped in. User should have ability at this gate to remove a rogue var from a group."

The semantics, and nothing beyond them:

* a REVIEWER DECISION, persisted as its own gate-decision kind ``gate3_member_exclusion`` keyed on the
  (group, variable) pair it removes — so it rehydrates, carries a version for the two-tab notice, and rides the
  guest sandbox and the clone exactly as every other kind does;
* the variable is dropped from that concept's transform specs and from EVERY export — every format is built on
  ``export_decisions.effective_records``, so that is the one place it is applied — and the decision log lists
  the removal;
* it is reversible (deleting the row) while Gate 3 is live, and refused once the run has passed Gate 3, like
  every other kind;
* it re-runs nothing and costs nothing.
"""

from __future__ import annotations

import copy
from urllib.parse import quote

import pytest

from backend import app as app_module
from backend.artifact_kinds import (
    _DECISION_IDENTITY_FIELDS,
    DECISION_GATE,
    GATE3_COMBINE_RULE,
    GATE3_MEMBER_EXCLUSION,
    GATE_DECISION_KINDS,
    MEMBER_EXCLUDE,
    MEMBER_KEEP,
    option_set_key,
)
from backend.artifacts import registry
from backend.export_decisions import decision_log_rows, effective_records
from tests.test_export_staged import (  # noqa: F401 - `parked` is a fixture requested by name
    _export,
    _notebook_code,
    _put,
    _record,
    _result,
    _rows,
    _transform,
    parked,
)

KIND = GATE3_MEMBER_EXCLUSION
ROGUE = "B:weight"
SMOKING = "c1#g0"


def _exclusion(group: str = SMOKING, member: str = ROGUE) -> dict:
    alternatives = [MEMBER_KEEP, MEMBER_EXCLUDE]
    return {
        "groupId": group,
        "memberId": member,
        "chosen": MEMBER_EXCLUDE,
        "alternatives": alternatives,
        "optionSetKey": option_set_key(alternatives),
    }


def _with_rogue() -> dict:
    """The staged fixture, with a self-reported weight variable sitting in the smoking concept — the shape of the
    final run's rogue member: in the group's members, its member details, and its transform specs."""
    result = _result()
    smoking = next(r for r in result["records"] if r["groupId"] == SMOKING)
    smoking["members"] = ["A:smoke", "B:smk", ROGUE]
    smoking["nMembers"] = 3
    smoking["memberDetails"] = [
        {"id": "A:smoke", "cohort": "A", "name": "smoke", "text": "Do you smoke?"},
        {"id": "B:smk", "cohort": "B", "name": "smk", "text": "Smoker"},
        {"id": ROGUE, "cohort": "B", "name": "weight", "text": "Weight (Kilograms) - self-reported"},
    ]
    smoking["transforms"].append(_transform(ROGUE, "SmokeCDE", {"70": "Yes"}))
    return result


def _by_group(records: list[dict]) -> dict[str, dict]:
    return {r["groupId"]: r for r in records}


# --- the kind -------------------------------------------------------------------------------------------------


def test_the_kind_is_registered_keyed_on_the_group_and_the_variable():
    assert KIND == "gate3_member_exclusion"
    assert KIND in GATE_DECISION_KINDS
    assert DECISION_GATE[KIND] == "gate3", "a removal is a Gate 3 decision and freezes with Gate 3"
    assert _DECISION_IDENTITY_FIELDS[KIND] == ("groupId", "memberId")
    kind = registry.get(KIND)
    assert not kind.singleton
    assert kind.key_for(_exclusion()) == f"{SMOKING}|{ROGUE}"
    kind.check(_exclusion())


@pytest.mark.parametrize("chosen", ["", MEMBER_KEEP, "out", "B:weight"])
def test_only_a_removal_is_stored(chosen):
    """A row of this kind MEANS the variable is out of the concept; Undo deletes the row. A row saying anything
    else would be read as a removal by every reader, so it is refused."""
    with pytest.raises(ValueError, match="exclude"):
        registry.get(KIND).check({**_exclusion(), "chosen": chosen})


def test_a_removal_needs_both_the_group_and_the_variable():
    for missing in ("groupId", "memberId"):
        payload = {k: v for k, v in _exclusion().items() if k != missing}
        with pytest.raises(ValueError, match=missing):
            registry.get(KIND).key_for(payload)


# --- the effective records ------------------------------------------------------------------------------------


def test_a_removed_variable_leaves_its_concept_and_the_concepts_specs():
    result = _with_rogue()
    raw = copy.deepcopy(result)
    records = _by_group(effective_records(result, {}, {KIND: [_exclusion()]}))
    smoking = records[SMOKING]
    assert smoking["members"] == ["A:smoke", "B:smk"]
    assert [m["id"] for m in smoking["memberDetails"]] == ["A:smoke", "B:smk"]
    assert [t["sourceVariable"] for t in smoking["transforms"]] == ["A:smoke", "B:smk"]
    assert smoking["nMembers"] == 2
    assert smoking["removedMembers"] == [ROGUE]
    # every other record is untouched, and says so
    assert all(r["removedMembers"] == [] for gid, r in records.items() if gid != SMOKING)
    assert result == raw, "the checkpoint payload is never mutated"


def test_without_a_removal_every_record_keeps_its_members():
    records = _by_group(effective_records(_with_rogue(), {}, {}))
    assert records[SMOKING]["members"] == ["A:smoke", "B:smk", ROGUE]
    assert records[SMOKING]["nMembers"] == 3
    assert records[SMOKING]["removedMembers"] == []


def test_a_removal_keyed_on_another_group_changes_nothing():
    """Keyed on the (group, variable) pair: the decision removes the variable from the concept it was made on."""
    records = _by_group(effective_records(_with_rogue(), {}, {KIND: [_exclusion(group="c0#g0")]}))
    assert ROGUE in records[SMOKING]["members"]
    assert records[SMOKING]["removedMembers"] == []
    assert records["c0#g0"]["removedMembers"] == []


def test_the_cohorts_follow_the_variables_that_remain():
    """Removing a concept's only cohort-B variable leaves a single-cohort concept, and the record says so."""
    result = _result()
    records = _by_group(effective_records(result, {}, {KIND: [_exclusion(group="c0#g0", member="B:age_yrs")]}))
    age = records["c0#g0"]
    assert age["members"] == ["A:age"]
    assert age["cohorts"] == ["A"]
    assert age["crossCohort"] is False


def test_a_removed_variable_is_no_longer_a_source_of_the_generated_element():
    result = _result()
    hair = next(r for r in result["records"] if r["groupId"] == "c2#g0")
    hair["members"] = ["A:hair", "B:hair_col", "B:weight"]
    hair["gencde"]["sourceVariables"] = ["A:hair", "B:hair_col", "B:weight"]
    hair["gencde"]["sourceCohorts"] = ["A", "B"]
    records = _by_group(effective_records(result, {}, {KIND: [_exclusion(group="c2#g0")]}))
    assert records["c2#g0"]["gencde"]["sourceVariables"] == ["A:hair", "B:hair_col"]
    assert records["c2#g0"]["gencde"]["sourceCohorts"] == ["A", "B"]
    only_a = _by_group(
        effective_records(
            result,
            {},
            {KIND: [_exclusion(group="c2#g0"), _exclusion(group="c2#g0", member="B:hair_col")]},
        )
    )
    assert only_a["c2#g0"]["gencde"]["sourceCohorts"] == ["A"]


def test_a_removed_variable_no_longer_writes_a_shared_column():
    """Two of cohort B's variables on one target were a combine group; once one is removed there is nothing left
    to combine, so no rule rides the record (and the notebook writes the column once)."""
    result = _with_rogue()
    before = _by_group(effective_records(result, {}, {}))[SMOKING]["combineRules"]
    assert [rule["members"] for rule in before] == [["B:smk", ROGUE]]
    after = _by_group(effective_records(result, {}, {KIND: [_exclusion()], GATE3_COMBINE_RULE: []}))
    assert after[SMOKING]["combineRules"] == []


# --- the decision log -----------------------------------------------------------------------------------------


def test_the_decision_log_lists_the_removal():
    rows = decision_log_rows(_with_rogue(), {}, {KIND: [_exclusion()]})
    row = next(r for r in rows if r[1] == KIND)
    assert row == [
        "Gate 3",
        KIND,
        "Removed a variable from a concept",
        f"{SMOKING}|{ROGUE}",
        SMOKING,
        "removed",
        "",
        "",
        "false",
    ]


def test_a_removal_that_took_effect_nowhere_says_so():
    rows = decision_log_rows(
        _with_rogue(),
        {},
        {KIND: [_exclusion(group="zz#g9"), _exclusion(group="c0#g0", member=ROGUE)]},
    )
    detail = {r[3]: r[7] for r in rows if r[1] == KIND}
    assert detail["zz#g9|B:weight"] == '{"notApplied":"no record for this group in the run\'s results"}'
    assert detail["c0#g0|B:weight"] == '{"notApplied":"not a variable of this group in the run\'s results"}'


# --- every export, through the routes -------------------------------------------------------------------------


def test_every_export_leaves_the_removed_variable_out(request):
    client, park = request.getfixturevalue("parked")
    job_id = park("gate4", result=_with_rogue())
    _put(client, job_id, KIND, _exclusion())

    tsv = next(r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t") if r["recordId"] == SMOKING)
    assert tsv["members"] == "A:smoke;B:smk"
    assert tsv["nMembers"] == "2"
    assert tsv["nTransforms"] == "2"
    assert tsv["removedMembers"] == ROGUE

    rec = next(r for r in _export(client, job_id, "records_json").json() if r["groupId"] == SMOKING)
    assert ROGUE not in rec["members"]
    assert ROGUE not in [t["sourceVariable"] for t in rec["transforms"]]
    assert rec["removedMembers"] == [ROGUE]

    for fmt in ("notebook_py", "notebook_r"):
        nb = _export(client, job_id, fmt).json()
        code = "\n".join("".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code")
        prose = "\n".join("".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "markdown")
        assert "weight" not in code, f"{fmt} still harmonizes the removed variable"
        assert "Removed from a concept" in prose and ROGUE in prose, f"{fmt} drops it silently"

    log = _rows(_export(client, job_id, "decisions_csv").text, ",")
    removal = next(r for r in log if r["kind"] == KIND)
    assert removal["action"] == "Removed a variable from a concept"
    assert removal["item"] == f"{SMOKING}|{ROGUE}"
    assert removal["after"] == "removed"


# --- the write path -------------------------------------------------------------------------------------------


def _item_url(job_id: str, item_key: str) -> str:
    return f"/api/harmonize/jobs/{job_id}/artifacts/{KIND}/{quote(item_key, safe='')}"


def test_a_removal_is_free_reversible_at_gate3_and_refused_once_gate3_is_passed(request, monkeypatch):
    client, park = request.getfixturevalue("parked")
    spawned: list[object] = []
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: spawned.append(a))  # noqa: ARG005

    job_id = park("gate3", job_id="g3", result=_with_rogue())
    before = app_module.store.get(job_id)
    r = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{KIND}", json=_exclusion())
    assert r.status_code == 200, r.text
    assert r.json()["itemKey"] == f"{SMOKING}|{ROGUE}"
    listed = client.get(f"/api/harmonize/jobs/{job_id}/artifacts").json()["artifacts"]
    assert [d["memberId"] for d in listed[KIND]] == [ROGUE]
    rec = next(x for x in _export(client, job_id, "records_json").json() if x["groupId"] == SMOKING)
    assert ROGUE not in rec["members"]

    # it re-runs nothing and costs nothing: no worker, the run still parked where it was, the bill unchanged
    after = app_module.store.get(job_id)
    assert spawned == []
    assert (after.gate_position, after.status) == (before.gate_position, before.status)
    assert after.cost_so_far == before.cost_so_far

    # Undo: the row goes, and the variable is back in every export
    assert client.delete(_item_url(job_id, f"{SMOKING}|{ROGUE}")).status_code == 204
    assert not client.get(f"/api/harmonize/jobs/{job_id}/artifacts").json()["artifacts"].get(KIND)
    rec = next(x for x in _export(client, job_id, "records_json").json() if x["groupId"] == SMOKING)
    assert ROGUE in rec["members"]

    # past Gate 3 the screen is a record: a removal, and its undo, are refused
    passed = park("gate4", job_id="g4", result=_with_rogue())
    assert client.put(f"/api/harmonize/jobs/{passed}/artifacts/{KIND}", json=_exclusion()).status_code == 409
    assert client.delete(_item_url(passed, f"{SMOKING}|{ROGUE}")).status_code == 409
