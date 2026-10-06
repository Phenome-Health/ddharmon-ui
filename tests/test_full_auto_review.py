"""After a Full-auto run (08-30): its gates stay open to review, and every export says nobody reviewed them.

A guided run's passed gates are RECORDS — their decisions were consumed by a paid leg, so the server refuses to
change them (08-27 audit B4). An auto-accepted gate was never reviewed at all, so freezing it would forbid the
review the run skipped. The edits a reviewer can still make are the ones the export applies WITHOUT re-running
anything — the same set a finished run is re-decided with: a group's name, the Gate 2 target and its generated
element, the Gate 3 recodes and how variables combine. Gate 1's grouping (scope, moves, new groups) and the score
declaration stay as committed: changing them means re-running those groups, and that incremental top-up is not
built — so they are refused, not silently ignored.

Every format carries the provenance: the decision log has one "Auto-accepted — not reviewed" row per gate, the
records JSON and the review queue say which gates were auto-accepted, and so does the notebook's header. A guided
run's files gain nothing.
"""

from __future__ import annotations

import pytest

from backend import app as app_module
from backend.artifact_kinds import option_set_key
from backend.export_decisions import AUTO_ACCEPTED_LABEL, decision_log_rows
from tests.test_export_staged import _export, _notebook_code, _result, _rows
from tests.test_export_staged import parked as parked  # noqa: F401 — the shared fixture

AUTO = {"review_mode": "auto", "gate_decided_by": {"gate1": "auto", "gate2": "auto", "gate3": "auto"}}


def _auto_run(park, decided: dict | None = None) -> str:
    """A run parked at Gate 4 whose gates Full auto committed.

    Parked through the shared fixture (whose Gate 3 -> 4 step is a person's Continue), THEN given the record
    Full auto writes — a person's Continue takes its gate off that record, which is the rule under test elsewhere.
    """
    job_id = park("gate4")
    job = app_module.store.get(job_id)
    record = AUTO["gate_decided_by"] if decided is None else decided
    app_module.store.update(job_id, config={**job.config, "review_mode": "auto", "gate_decided_by": record})
    return job_id


def _body(payload: dict) -> dict:
    alternatives = payload.pop("alternatives", [payload["chosen"]])
    return {**payload, "alternatives": alternatives, "optionSetKey": option_set_key(alternatives)}


REVISABLE = [
    ("gate1_rename", {"groupId": "c0#g0", "chosen": "Age (years)"}),
    ("gate2_candidate_pick", {"groupId": "c0#g0", "chosen": "AgeAtVisitCDE"}),
    ("gate2_relation", {"groupId": "c0#g0", "targetId": "AgeCDE", "chosen": "skos:closeMatch"}),
    ("gate3_spec_edit", {"sourceVariable": "A:smoke", "chosen": "edited", "mapping": {"1": "1"}}),
    ("gate3_combine_rule", {"cohort": "A", "targetId": "SmokeCDE", "chosen": "coalesce"}),
    ("gate3_member_exclusion", {"groupId": "c1#g0", "memberId": "A:smoke", "chosen": "exclude"}),
]
STRUCTURAL = [
    ("gate1_group_scope", {"groupId": "c0#g0", "chosen": "out", "alternatives": ["in", "out"]}),
    ("gate1_regroup", {"memberId": "A:age", "chosen": "c1#g0", "fromGroupId": "c0#g0"}),
    ("gate1_new_group", {"groupId": "rev:abc", "chosen": "rev:abc", "name": "Mine"}),
    ("composite_swap", {"scoreName": "S", "componentName": "c", "chosen": "c0#g0"}),
]


@pytest.mark.parametrize(("kind", "payload"), REVISABLE, ids=[k for k, _ in REVISABLE])
def test_an_auto_accepted_gate_can_still_be_reviewed(parked, kind, payload):  # noqa: F811
    client, park = parked
    job_id = _auto_run(park)
    r = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{kind}", json=_body(dict(payload)))
    assert r.status_code == 200, r.text


@pytest.mark.parametrize(("kind", "payload"), STRUCTURAL, ids=[k for k, _ in STRUCTURAL])
def test_gate_1_grouping_stays_as_auto_committed_because_changing_it_needs_a_re_run(
    parked, kind, payload  # noqa: F811
):
    client, park = parked
    job_id = _auto_run(park)
    r = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{kind}", json=_body(dict(payload)))
    assert r.status_code == 409, r.text
    assert "re-run" in r.json()["detail"]


@pytest.mark.parametrize(("kind", "payload"), REVISABLE, ids=[k for k, _ in REVISABLE])
def test_a_guided_runs_passed_gates_are_still_records(parked, kind, payload):  # noqa: F811
    client, park = parked
    job_id = park("gate4")
    r = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{kind}", json=_body(dict(payload)))
    assert r.status_code == 409


def test_a_gate_reviewed_by_a_person_is_a_record_even_on_an_auto_run(parked):  # noqa: F811
    """Only the gates Full auto committed are open. One a reviewer continued from is theirs, and frozen."""
    client, park = parked
    job_id = _auto_run(park, {"gate1": "auto", "gate2": "auto"})
    kind, payload = REVISABLE[3]  # a Gate 3 spec edit
    r = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{kind}", json=_body(dict(payload)))
    assert r.status_code == 409


# ── provenance in every format ─────────────────────────────────────────────────────────────────────────────


def test_the_decision_log_has_one_auto_accepted_row_per_gate(parked):  # noqa: F811
    client, park = parked
    job_id = _auto_run(park)
    rows = _rows(_export(client, job_id, "decisions_csv").text, ",")
    auto = [r for r in rows if r["kind"] == "gate_auto_accepted"]
    assert [(r["gate"], r["action"], r["after"]) for r in auto] == [
        ("Gate 1", AUTO_ACCEPTED_LABEL, "auto — not reviewed"),
        ("Gate 2", AUTO_ACCEPTED_LABEL, "auto — not reviewed"),
        ("Gate 3", AUTO_ACCEPTED_LABEL, "auto — not reviewed"),
    ]
    assert AUTO_ACCEPTED_LABEL == "Auto-accepted — not reviewed"


def test_the_auto_rows_lead_the_log_in_gate_order_and_reviewer_rows_follow():
    config = {**AUTO, "gate1_scope": ["c0#g0"]}
    rows = decision_log_rows(_result(), config, {})
    kinds = [r[1] for r in rows]
    assert kinds[:4] == ["gate_auto_accepted", "gate1_scope_frozen", "gate_auto_accepted", "gate_auto_accepted"]


def test_records_and_the_review_queue_say_which_gates_were_auto_accepted(parked):  # noqa: F811
    client, park = parked
    job_id = _auto_run(park)
    records = _export(client, job_id, "records_json").json()
    assert records and all(r["gateDecidedBy"] == AUTO["gate_decided_by"] for r in records)
    rows = _rows(_export(client, job_id, "eitl_tsv").text, "\t")
    assert rows and all(r["gatesAutoAccepted"] == "gate1;gate2;gate3" for r in rows)
    for fmt in ("notebook_py", "notebook_r"):
        assert "Auto-accepted — not reviewed: Gate 1, Gate 2, Gate 3" in _notebook_code(client, job_id, fmt)


def test_a_guided_runs_files_carry_no_auto_provenance(parked):  # noqa: F811
    client, park = parked
    job_id = park("gate4")
    rows = _rows(_export(client, job_id, "decisions_csv").text, ",")
    assert not [r for r in rows if r["kind"] == "gate_auto_accepted"]
    assert all("gateDecidedBy" not in r for r in _export(client, job_id, "records_json").json())
    header = _export(client, job_id, "eitl_tsv").text.splitlines()[0].split("\t")
    assert "gatesAutoAccepted" not in header
    assert "Auto-accepted" not in _notebook_code(client, job_id)
