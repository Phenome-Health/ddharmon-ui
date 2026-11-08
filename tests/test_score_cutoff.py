"""Gate 1's score SUGGESTION CUT-OFF as a reviewer decision (`gate1_score_cutoff`, review round 6).

Bhargav, on the live Lavish build: the free search's cut-off "0.62" "should be user-selectable with default 0.62".
The cut-off decides which groups a declared score SUGGESTS — tagged in the queue, seeded into Gate 1's scope — so a
reviewer's choice of it is a decision about scope, persisted per run like the other Gate 1 decisions (so a reload
and the Continue agree), frozen with Gate 1, and named in the decision log. Clearing it (the row deleted) returns to
core's calibrated value, which is why a stored row must always carry a number.
"""

from __future__ import annotations

import pytest

from backend.artifact_kinds import (
    AUTO_REVISABLE_KINDS,
    DECISION_GATE,
    GATE1_SCORE_CUTOFF,
    GATE_DECISION_KINDS,
    SCORE_CUTOFF_SETTING,
    option_set_key,
    score_cutoff_list,
    score_cutoff_setting,
)
from backend.artifacts import registry
from backend.export_decisions import decision_log_rows


def _cutoff(chosen: str = "0.55", default: str = "0.62") -> dict:
    return {
        "setting": SCORE_CUTOFF_SETTING,
        "chosen": chosen,
        "alternatives": [default],
        "optionSetKey": option_set_key([default]),
    }


def test_the_cutoff_is_a_gate1_decision_keyed_on_the_setting():
    assert GATE1_SCORE_CUTOFF == "gate1_score_cutoff"
    assert GATE1_SCORE_CUTOFF in GATE_DECISION_KINDS
    assert DECISION_GATE[GATE1_SCORE_CUTOFF] == "gate1"
    # It moves Gate 1's scope, so a Gate 1 Full auto committed keeps it as committed (like scope itself).
    assert GATE1_SCORE_CUTOFF not in AUTO_REVISABLE_KINDS
    assert registry.get(GATE1_SCORE_CUTOFF).key_for(_cutoff()) == SCORE_CUTOFF_SETTING


@pytest.mark.parametrize("chosen", ["0.30", "0.55", "0.62", "0.95"])
def test_a_cutoff_in_range_is_accepted(chosen):
    registry.get(GATE1_SCORE_CUTOFF).check(_cutoff(chosen))


@pytest.mark.parametrize("chosen", ["", "abc", "0.29", "0.96", "nan", "inf", "1"])
def test_a_cutoff_that_is_not_a_number_in_range_is_refused(chosen):
    with pytest.raises(ValueError):
        registry.get(GATE1_SCORE_CUTOFF).check(_cutoff(chosen))


def test_the_decision_log_names_the_cutoff_against_its_default():
    rows = decision_log_rows({"records": []}, {}, {GATE1_SCORE_CUTOFF: [_cutoff("0.55", "0.62")]})
    row = next(r for r in rows if r[1] == GATE1_SCORE_CUTOFF)
    gate, _kind, action, item, before, after = row[:6]
    assert gate == "Gate 1"
    assert action == "Set the score suggestion cut-off"
    assert item == SCORE_CUTOFF_SETTING
    assert before == "0.62 (default)"
    assert after == "0.55"


# --- one cut-off PER SPOTLIGHT LIST (2026-11-08: "implement per list cutoff") ---------------------------------------
#
# Each declared Spotlight list carries its own cut-off. It is the same kind, keyed on the same one field — the list is
# named IN the setting (`suggestion_cutoff::<list name>`), so the identity table and every stored row are unchanged:
# the run-wide row a run already holds keeps its key, and stays the starting value of every list without one of its
# own. Out-of-range values and malformed settings are still refused.

LIST = "Frailty index"
OTHER_LIST = "SES index"


def _list_cutoff(chosen: str = "0.55", default: str = "0.62", list_name: str = LIST) -> dict:
    return {**_cutoff(chosen, default), "setting": f"{SCORE_CUTOFF_SETTING}::{list_name}"}


def test_a_list_cutoff_is_keyed_on_its_own_setting_so_each_list_is_its_own_row():
    kind = registry.get(GATE1_SCORE_CUTOFF)
    frailty = kind.key_for(_list_cutoff(list_name=LIST))
    ses = kind.key_for(_list_cutoff(list_name=OTHER_LIST))
    run_wide = kind.key_for(_cutoff())
    assert frailty == "suggestion_cutoff::Frailty index"
    assert ses == "suggestion_cutoff::SES index"
    assert run_wide == SCORE_CUTOFF_SETTING
    assert len({frailty, ses, run_wide}) == 3
    # The one builder both halves use, so the key the client writes is the key the server derives.
    assert score_cutoff_setting(LIST) == frailty
    assert score_cutoff_setting(f"  {LIST}  ") == frailty  # a list's name is its trimmed name, as declared


def test_a_setting_names_its_list_or_none_for_the_run_wide_row():
    assert score_cutoff_list(SCORE_CUTOFF_SETTING) is None
    assert score_cutoff_list("suggestion_cutoff::Frailty index") == "Frailty index"
    # Everything after the first separator is the name, separators included.
    assert score_cutoff_list("suggestion_cutoff::A::B") == "A::B"
    with pytest.raises(ValueError):
        score_cutoff_list("not_a_setting")


@pytest.mark.parametrize("chosen", ["0.30", "0.55", "0.62", "0.95"])
def test_a_list_cutoff_in_range_is_accepted(chosen):
    registry.get(GATE1_SCORE_CUTOFF).check(_list_cutoff(chosen))


@pytest.mark.parametrize("chosen", ["", "abc", "0.29", "0.96", "nan", "inf", "1"])
def test_a_list_cutoff_that_is_not_a_number_in_range_is_refused(chosen):
    with pytest.raises(ValueError):
        registry.get(GATE1_SCORE_CUTOFF).check(_list_cutoff(chosen))


@pytest.mark.parametrize(
    "setting",
    [
        "cutoff",
        "Suggestion_cutoff",
        "suggestion_cutoff:Frailty index",  # one colon is not the separator
        "suggestion_cutoffFrailty index",
        "suggestion_cutoff::",  # a list needs a name
        "suggestion_cutoff::   ",
        "suggestion_cutoff:: Frailty index",  # never a name the declaration would have trimmed
        "suggestion_cutoff::Frailty index ",
        "Frailty index",
    ],
)
def test_a_malformed_setting_is_refused(setting):
    with pytest.raises(ValueError):
        registry.get(GATE1_SCORE_CUTOFF).check({**_cutoff(), "setting": setting})


def test_the_decision_log_names_the_list_a_cutoff_belongs_to_and_keeps_the_run_wide_wording():
    rows = decision_log_rows(
        {"records": []},
        {},
        {
            GATE1_SCORE_CUTOFF: [
                _cutoff("0.80", "0.62"),
                _list_cutoff("0.55", "0.62"),
                _list_cutoff("0.70", "0.62", OTHER_LIST),
            ]
        },
    )
    by_item = {r[3]: r for r in rows if r[1] == GATE1_SCORE_CUTOFF}
    assert set(by_item) == {SCORE_CUTOFF_SETTING, "suggestion_cutoff::Frailty index", "suggestion_cutoff::SES index"}
    # The run-wide row reads exactly as it always has.
    gate, _kind, action, _item, before, after = by_item[SCORE_CUTOFF_SETTING][:6]
    assert (gate, action, before, after) == ("Gate 1", "Set the score suggestion cut-off", "0.62 (default)", "0.80")
    # A list's row says which list it is.
    _gate, _kind, action, _item, before, after = by_item["suggestion_cutoff::Frailty index"][:6]
    assert action == "Set the score suggestion cut-off — Frailty index"
    assert (before, after) == ("0.62 (default)", "0.55")
    assert by_item["suggestion_cutoff::SES index"][2] == "Set the score suggestion cut-off — SES index"
    assert by_item["suggestion_cutoff::SES index"][5] == "0.70"


def test_list_cutoffs_round_trip_through_the_store_and_reset_deletes_only_that_list(tmp_path, monkeypatch):
    """Through the API: three rows (the run-wide one and two lists') stay three, a list's reset deletes its row alone,
    and the server refuses an out-of-range value or a malformed setting with a 400 rather than storing it."""
    from urllib.parse import quote

    from fastapi.testclient import TestClient

    import backend.app as app_module

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    url = "/api/harmonize/jobs/j1/artifacts/gate1_score_cutoff"
    with TestClient(app_module.app) as c:
        app_module.store.create("j1", "A run", {}, owner_subject=None)
        app_module.store.update("j1", status="complete", result={"records": []})
        for payload in (_cutoff("0.80"), _list_cutoff("0.55"), _list_cutoff("0.70", list_name=OTHER_LIST)):
            put = c.put(url, json=payload)
            assert put.status_code == 200, put.text
        assert put.json()["itemKey"] == "suggestion_cutoff::SES index"
        held = c.get("/api/harmonize/jobs/j1/artifacts").json()["artifacts"][GATE1_SCORE_CUTOFF]
        assert sorted((r["setting"], r["chosen"]) for r in held) == [
            ("suggestion_cutoff", "0.80"),
            ("suggestion_cutoff::Frailty index", "0.55"),
            ("suggestion_cutoff::SES index", "0.70"),
        ]

        assert c.delete(f"{url}/{quote('suggestion_cutoff::Frailty index', safe='')}").status_code == 204
        held = c.get("/api/harmonize/jobs/j1/artifacts").json()["artifacts"][GATE1_SCORE_CUTOFF]
        assert sorted(r["setting"] for r in held) == ["suggestion_cutoff", "suggestion_cutoff::SES index"]

        assert c.put(url, json=_list_cutoff("0.99")).status_code == 400
        assert c.put(url, json={**_cutoff(), "setting": "suggestion_cutoff::"}).status_code == 400
        assert c.put(url, json={**_cutoff(), "setting": "something_else"}).status_code == 400
