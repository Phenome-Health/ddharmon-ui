"""The number a candidate was shown to the model under travels to the review screen (user test, 2026-11-25).

The model's rationale cites candidates by their PROMPT number ("Candidate 2 ... Candidate 1"). Gate 2 now lists
candidates by similarity, so the row's ``#`` must be that number to resolve the citation, not the row position
and not the ranked position. Core 1.4.2 records it as ``CandidateCDE.candidate_number``.
"""

from __future__ import annotations

from types import SimpleNamespace

from ddharmon.harmonization.models import CandidateCDE

from backend.engine.adapter import _candidate_to_ui


def test_the_wire_carries_the_number_the_rationale_cites():
    cand = CandidateCDE(rank=1, cde_id="CDE_2", cosine=0.66, is_chosen=True, llm_suggested=True, candidate_number=2)
    ui = _candidate_to_ui(cand)
    assert ui["candidateNumber"] == 2
    assert ui["rank"] == 1, "rank stays the ranked position"


def test_a_candidate_from_an_older_core_has_no_number_rather_than_a_wrong_one():
    older = SimpleNamespace(
        rank=3, cde_id="X", cde_external_id=None, definition="", cosine=0.5, is_chosen=False, llm_suggested=False
    )
    assert "candidateNumber" not in _candidate_to_ui(older)
