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
