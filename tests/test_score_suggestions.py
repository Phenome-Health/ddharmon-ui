"""Gate 1 score SUGGESTIONS — the free half of the score match, served for Gate 1 (08-28 Decision 6, option A).

The paid match (retrieval -> one LLM judge) moved to Gate 4 (decision Q5), after Gate 1 is continued, so on a live
run Gate 1 had no matches and its score-seeded scope never seeded anything. ``GET /jobs/{id}/score/suggestions``
runs ONLY core's retrieval half (``suggest_groups``) for each score declared on the run, against Gate 1's
EFFECTIVE groups — the split's membership with the reviewer's moves applied and their New groups included — and
scores each reached group by the dense cosine of its best member. The verdict stays on Gate 4.

What these tests pin: the payload shape (scores -> components -> groups with score + bestMember, and core's
calibrated threshold), that membership is the reviewer's current regrouping, that the route uses the run's
cache-backed embedder and NEVER builds an LLM client or bills, and that with no dense encoder it answers "no
suggestions" with a reason rather than thresholding a lexical score. A hashing embedder stands in for BioLORD.
"""

from __future__ import annotations

import hashlib
import re
import uuid

import numpy as np
import pytest
from ddharmon.harmonization.composite import GATE1_SUGGEST_MIN_COSINE
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.artifact_kinds import COMPOSITE_SWAP, option_set_key
from backend.checkpoint import write_checkpoint

REV = f"rev:{uuid.UUID(int=11)}"


def _vector(text: str) -> np.ndarray:
    v = np.zeros(64, dtype=np.float32)
    for tok in re.findall(r"[a-z0-9]+", text.lower()):
        v[int(hashlib.md5(tok.encode()).hexdigest(), 16) % 64] += 1.0
    n = np.linalg.norm(v)
    return v / n if n else v


def _fake_embedder():
    calls: list[int] = []

    def embed(texts: list[str]) -> np.ndarray:
        calls.append(len(texts))
        return np.stack([_vector(t) for t in texts])

    embed.calls = calls  # type: ignore[attr-defined]
    return embed


def _result() -> dict:
    members = {
        "c0#g0": ["UKBB:grip_l", "UKBB:grip_r", "CLSA:grip"],
        "c1#g0": ["UKBB:walk", "CLSA:gait"],
        "c2#g0": ["UKBB:hair"],
    }
    return {
        "records": [],
        "conceptGroups": [
            {"groupId": g, "memberVariableNames": ms[:1], "nMembers": len(ms)} for g, ms in members.items()
        ],
        "conceptGroupMembers": members,
        "fieldIndex": {
            "UKBB:grip_l": {"name": "Hand grip strength (left)"},
            "UKBB:grip_r": {"name": "Hand grip strength (right)"},
            "CLSA:grip": {"name": "Grip strength dynamometer"},
            "UKBB:walk": {"name": "Usual walking pace"},
            "CLSA:gait": {"name": "Gait speed timed walk"},
            "UKBB:hair": {"name": "Natural hair colour"},
            "UKBB:loose": {"name": "Grip strength repeat measure"},  # in no group: a clustering leftover
        },
        "summary": {},
        "cost": {"actualUsd": 0.5},
    }


@pytest.fixture
def gate1(monkeypatch, tmp_path):
    """A run PARKED at Gate 1 with a real checkpoint. Yields (client, embed) — the embedder the route must use."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: None)  # noqa: ARG005

    def no_llm(*a, **k):  # noqa: ARG001
        raise AssertionError("a Gate 1 suggestion built an LLM client — it must be $0")

    monkeypatch.setattr("backend.engine.llm.build_llm_client", no_llm)
    embed = _fake_embedder()
    monkeypatch.setattr("backend.composite._embedder", lambda: embed)
    monkeypatch.setattr("backend.composite.encoder_available", lambda: True)

    with TestClient(app_module.app) as client:
        wd = tmp_path / "work" / "g1"
        app_module.store.create(
            "g1",
            "Parked at Gate 1",
            {"work_dir": str(wd), "cde_set": "endorsed"},
            owner_subject=None,
            dict_specs=[{"path": "x.csv", "cohort_name": "UKBB", "column_roles": {}}],
        )
        write_checkpoint(wd, job_id="g1", gate="gate1", result=_result(), responses={}, realized_cost=0.5)
        app_module.store.checkpoint("g1", gate="gate1", checkpoint_ref="g1/checkpoint_gate1.json", realized_cost=0.5)
        app_module.store.update("g1", cost_so_far=0.5)
        yield client, embed


def _seed(kind: str, payload: dict) -> None:
    from backend.jobs import principal_of

    alternatives = payload.pop("alternatives", [payload["chosen"]])
    body = {**payload, "alternatives": alternatives, "optionSetKey": option_set_key(alternatives)}
    job = app_module.store.get("g1")
    app_module.store.artifacts.put(owner=principal_of(None, job), job_id="g1", kind=kind, payload=body, pinned=False)


def _declare(score: str, components: list[str]) -> None:
    for name in components:
        _seed(COMPOSITE_SWAP, {"scoreName": score, "componentName": name, "chosen": "", "alternatives": components})


def _groups(body: dict, score: str, component: str) -> dict[str, dict]:
    s = next(x for x in body["scores"] if x["scoreName"] == score)
    c = next(x for x in s["components"] if x["component"] == component)
    return {g["groupId"]: g for g in c["groups"]}


def test_each_declared_component_gets_the_groups_its_free_search_reached(gate1):
    client, _embed = gate1
    _declare("Fried", ["Grip strength", "Walking speed"])
    r = client.get("/api/harmonize/jobs/g1/score/suggestions")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scored"] is True
    assert body["scoreKind"] == "dense_cosine"
    assert body["threshold"] == GATE1_SUGGEST_MIN_COSINE  # core's calibrated cut-off, carried, never re-declared
    assert body["billedUsd"] == 0
    grip = _groups(body, "Fried", "Grip strength")
    assert grip["c0#g0"]["bestMember"] in {"UKBB:grip_l", "UKBB:grip_r", "CLSA:grip"}
    assert 0 < grip["c0#g0"]["score"] <= 1
    # Components keep their declared order.
    assert [c["component"] for c in body["scores"][0]["components"]] == ["Grip strength", "Walking speed"]


def test_suggestions_read_the_effective_gate1_membership(gate1):
    """A variable moved into a New group is suggested THERE, not in the group it came from; a leftover the
    reviewer placed into a group counts for that group."""
    client, _embed = gate1
    _declare("Fried", ["Grip strength dynamometer"])
    _seed("gate1_new_group", {"groupId": REV, "chosen": "My grip", "name": "My grip"})
    _seed(
        "gate1_regroup",
        {"memberId": "CLSA:grip", "fromGroupId": "c0#g0", "chosen": REV, "alternatives": ["c0#g0", REV], "movedAt": 1},
    )
    body = client.get("/api/harmonize/jobs/g1/score/suggestions").json()
    got = _groups(body, "Fried", "Grip strength dynamometer")
    assert got[REV]["bestMember"] == "CLSA:grip"
    assert got["c0#g0"]["bestMember"] != "CLSA:grip"


def test_a_leftover_placed_into_a_group_counts_for_it(gate1):
    client, _embed = gate1
    _declare("Fried", ["Grip strength repeat measure"])
    _seed(
        "gate1_regroup",
        {
            "memberId": "UKBB:loose",
            "fromGroupId": "__unassigned__",
            "chosen": "c2#g0",
            "alternatives": ["__unassigned__", "c2#g0"],
            "movedAt": 1,
        },
    )
    got = _groups(
        client.get("/api/harmonize/jobs/g1/score/suggestions").json(), "Fried", "Grip strength repeat measure"
    )
    assert got["c2#g0"]["bestMember"] == "UKBB:loose"


def test_it_uses_the_runs_embedder_and_never_bills(gate1):
    client, embed = gate1
    _declare("Fried", ["Grip strength"])
    before = app_module.store.get("g1").cost_so_far
    assert client.get("/api/harmonize/jobs/g1/score/suggestions").status_code == 200
    assert embed.calls, "the route did not use the run's cache-backed embedder"
    assert app_module.store.get("g1").cost_so_far == before


def test_no_dense_encoder_means_no_suggestions_and_a_reason(gate1, monkeypatch):
    client, embed = gate1
    monkeypatch.setattr("backend.composite.encoder_available", lambda: False)
    _declare("Fried", ["Grip strength"])
    body = client.get("/api/harmonize/jobs/g1/score/suggestions").json()
    assert body["scored"] is False
    assert body["scores"][0]["components"][0]["groups"] == []
    assert "comparable" in body["reason"].lower()
    assert not embed.calls


def test_nothing_declared_is_an_empty_answer_not_an_error(gate1):
    client, embed = gate1
    body = client.get("/api/harmonize/jobs/g1/score/suggestions").json()
    assert body["scores"] == []
    assert not embed.calls  # nothing to search for, nothing embedded


def test_an_unknown_run_is_404(gate1):
    client, _embed = gate1
    assert client.get("/api/harmonize/jobs/nope/score/suggestions").status_code == 404


def test_gate1_membership_applies_moves_and_new_groups():
    result = _result()
    overrides = {
        "moves": {"CLSA:grip": REV, "UKBB:walk": None, "UKBB:loose": "c2#g0"},
        "newGroups": [{"groupId": REV, "name": "Mine"}],
    }
    m = app_module._gate1_membership(result, overrides)
    assert m["c0#g0"] == ["UKBB:grip_l", "UKBB:grip_r"]
    assert m["c1#g0"] == ["CLSA:gait"]
    assert m["c2#g0"] == ["UKBB:hair", "UKBB:loose"]
    assert m[REV] == ["CLSA:grip"]
    assert app_module._gate1_membership(result, None)["c0#g0"] == result["conceptGroupMembers"]["c0#g0"]
