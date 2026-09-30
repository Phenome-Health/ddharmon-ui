"""08-28 Wave 2 follow-up #1 — "Accept the division" at Gate 1, end to end through the REAL core.

The live finding (2026-09-15): accepting a proposed division returned 200 and changed nothing.
Three things stacked: core picked the groups to re-split from ``result.records``, which is EMPTY at the Gate-1
pause; the adapter's import of core's split-only re-adjudication failed and it silently degraded to "groups
unchanged"; and even a division that had happened lived only on the Gate-1 payload, which the Gate 2 leg rebuilds
from the split — so it could never have reached Gate 2. Every earlier test mocked core's seam, so none saw it.

Now the accept re-splits the group through the real core, and writes the division as the reviewer's own Gate 1
decisions — one New group per part (``gate1_new_group``, ``splitFrom`` = the divided group) and a move of each of
its variables into its part (``gate1_regroup``). Those are what Continue freezes and every later leg applies, so
the parts are listed at Gate 1, survive a reload, are priced by Gate 1's quote like any New group, and are
assigned as themselves at Gate 2.

No provider anywhere: the split is scripted at the stage boundary (the LLM), embeddings are stubbed, and the
replay, core's re-split and the next leg are all real.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.checkpoint import write_checkpoint
from tests.test_checkpoint import (  # noqa: F401 - _f2_clustering is a fixture requested by name
    StubProvider,
    _f2_base,
    _f2_clustering,
    _f2_specs,
    _f2_stages,
)
from tests.test_gate1_new_group import KEY, _counting, _decision

JOB = "div"


def _full_cde(tmp_path: Path) -> dict[str, Any]:
    """A catalog with every column the server's CDE roles name, loaded the way the endpoint loads it."""
    cols = list(dict.fromkeys(app_module.CDE_COLUMN_ROLES.values()))
    rows = [
        {"designation": "SmokeCDE", "tinyId": "t1", "definition": "Smoking status", "permissible_values": "1=Yes|0=No"},
        {"designation": "AgeCDE", "tinyId": "t2", "definition": "Age in years"},
    ]
    path = tmp_path / "cde_full.tsv"
    path.write_text("\t".join(cols) + "\n" + "".join("\t".join(r.get(c, "") for c in cols) + "\n" for r in rows))
    return {"path": str(path), "cohort_name": "NIH_CDE", "column_roles": dict(app_module.CDE_COLUMN_ROLES)}


class Divider:
    """The LLM's answer to the re-split the reviewer pays for: cohort A's smoking items apart from cohort B's."""

    def __init__(self, *, whole: bool = False) -> None:
        self.asked: list[list[str]] = []
        self.whole = whole

    def stage(self, prompts):
        out = {}
        for p in prompts:
            members = p.context["members"]
            self.asked.append([f"{m['dictionary_name']}:{m['variable_name']}" for m in members])
            if self.whole:
                out[p.id] = {"groups": [{"member_ids": [m["member_id"] for m in members], "concept": "Smoking"}]}
                continue
            a = [m["member_id"] for m in members if m["dictionary_name"] == "CohortA"]
            b = [m["member_id"] for m in members if m["dictionary_name"] != "CohortA"]
            out[p.id] = {
                "groups": [
                    {"member_ids": a, "concept": "Currently smokes cigarettes"},
                    {"member_ids": b, "concept": "Current cigarette smoker"},
                ]
            }
        return out


@pytest.fixture
def parked(monkeypatch, tmp_path, request):
    """A run parked at Gate 1 by a REAL leg (checkpoint + frozen substrate on disk), opted in to re-adjudication."""
    from backend.engine.adapter import run_pipeline

    request.getfixturevalue("_f2_clustering")  # one smoking cluster + recovered outliers, no UMAP

    work_root = tmp_path / "work"
    wd = work_root / JOB
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", work_root)
    monkeypatch.setattr(app_module.store, "work_root", work_root)
    dict_specs, _small_cde = _f2_specs(tmp_path)
    cde_spec = _full_cde(tmp_path)
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": Path(cde_spec["path"])})
    base = {**_f2_base(tmp_path), "work_dir": str(wd)}
    recorded: dict[str, dict] = {}
    leg1 = run_pipeline(
        dict_specs,
        cde_spec,
        {**base, "stop_at_gate": "gate1"},
        provider=StubProvider(),
        stage_overrides=_f2_stages({}),
        stage_responses=recorded,
    )
    write_checkpoint(wd, job_id=JOB, gate="gate1", result=leg1, responses=recorded, realized_cost=1.0)
    app_module.store.create(
        JOB,
        "Parked",
        {**base, "readjudication": True, "cde_set": "endorsed"},
        owner_subject=None,
        dict_specs=dict_specs,
    )
    app_module.store.checkpoint(JOB, gate="gate1", checkpoint_ref=f"{JOB}/checkpoint_gate1.json", realized_cost=1.0)
    # The two provider boundaries, and nothing else: the embedding model and the LLM.
    import ddharmon.embedding.provider as provider_mod

    monkeypatch.setattr(provider_mod, "SentenceTransformerProvider", StubProvider)
    divider = Divider()
    import backend.engine.adapter as ad
    import backend.engine.llm as llm_mod

    monkeypatch.setattr(llm_mod, "build_llm_client", lambda *a, **k: object())
    monkeypatch.setattr(ad, "specgen_stage_fn", lambda client: divider.stage)
    groups = leg1["conceptGroups"]
    members = leg1["conceptGroupMembers"]
    smoke = next(g["groupId"] for g in groups if any("SMOKE" in m for m in members[g["groupId"]]))
    return {
        "leg1": leg1,
        "responses": recorded,
        "dict_specs": dict_specs,
        "cde_spec": cde_spec,
        "smoke": smoke,
        "other": next(g["groupId"] for g in groups if g["groupId"] != smoke),
        "members": members,
        "divider": divider,
    }


def _accept(c: TestClient, gid: str):
    return c.post(f"/api/harmonize/jobs/{JOB}/readjudicate", json={"groupIds": [gid]}, headers=KEY)


def _decisions(c: TestClient) -> dict[str, list[dict]]:
    return c.get(f"/api/harmonize/jobs/{JOB}/artifacts").json()["artifacts"]


def test_accepting_a_division_writes_its_parts_as_the_reviewers_gate_1_decisions(parked):
    smoke, members = parked["smoke"], parked["members"]
    with TestClient(app_module.app) as c:
        r = _accept(c, smoke)
        assert r.status_code == 200, r.text
        body = r.json()
        stored = _decisions(c)
    assert parked["divider"].asked == [members[smoke]], "the re-split was not asked about the group as it stands"
    parts = body["parts"]
    assert body["nGroups"] == len(parts) == 2
    assert {p["name"] for p in parts} == {"Currently smokes cigarettes", "Current cigarette smoker"}
    assert all(p["splitFrom"] == smoke and p["groupId"].startswith("rev:") for p in parts)
    assert sorted(m for p in parts for m in p["members"]) == sorted(members[smoke])

    new_groups = {g["groupId"]: g for g in stored["gate1_new_group"]}
    assert set(new_groups) == {p["groupId"] for p in parts}, "the parts are not persisted as Gate 1 groups"
    assert all(g["splitFrom"] == smoke for g in new_groups.values())
    moves = {d["memberId"]: d for d in stored["gate1_regroup"]}
    for p in parts:
        for m in p["members"]:
            assert moves[m]["chosen"] == p["groupId"] and moves[m]["fromGroupId"] == smoke, m
    # What the client absorbs is exactly what a reload reads — the same rows, with their versions.
    served = {(k, d.get("groupId") or d.get("memberId")): d for k in stored for d in stored[k]}
    for kind, rows in body["decisions"].items():
        for row in rows:
            assert served[(kind, row.get("groupId") or row.get("memberId"))] == row
    # The checkpoint still holds the split's own groups: the division is a decision, applied like any other.
    ckpt = app_module._checkpoint_for(app_module.store.get(JOB))
    assert [g["groupId"] for g in ckpt.result["conceptGroups"]] == [
        g["groupId"] for g in parked["leg1"]["conceptGroups"]
    ]


def test_the_division_survives_continue_and_the_next_leg_assigns_each_part_as_itself(parked, monkeypatch):
    """The whole point of carrying it as decisions: the Gate 1 -> Gate 2 leg re-runs the split (which keeps the
    group whole) and applies the frozen regrouping, so each part is its own record and the divided group is gone."""
    from backend.engine.adapter import run_pipeline

    smoke = parked["smoke"]
    configs: list[dict] = []
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: configs.append(dict(a[4])))
    with TestClient(app_module.app) as c:
        parts = _accept(c, smoke).json()["parts"]
        scope = [p["groupId"] for p in parts] + [parked["other"]]
        assert c.post(f"/api/harmonize/resume/{JOB}", headers=KEY, json={"gate1Scope": scope}).status_code == 200
    leg_cfg = configs[-1]
    frozen = leg_cfg["gate1_overrides"]
    assert {g["groupId"] for g in frozen["newGroups"]} == {p["groupId"] for p in parts}
    assert all(g.get("splitFrom") == smoke for g in frozen["newGroups"]), "the provenance was dropped at Continue"

    calls: dict[str, int] = {}
    leg2 = run_pipeline(
        parked["dict_specs"],
        parked["cde_spec"],
        {**leg_cfg, "stop_at_gate": "gate2"},
        provider=StubProvider(),
        stage_overrides=_counting(calls),
        replay_responses=parked["responses"],
    )
    by = {r["groupId"]: r for r in leg2["records"]}
    assert smoke not in by, "the divided group was assigned"
    for p in parts:
        assert sorted(by[p["groupId"]]["members"]) == sorted(p["members"])
        assert by[p["groupId"]]["concept"] == p["name"]
        assert by[p["groupId"]].get("readjudicatedFrom") == smoke
    assert calls.get("group_generate") == 2, "each part buys exactly one ideal of its own (and nothing else does)"
    for stage in ("generate", "split", "coherence"):
        assert calls.get(stage, 0) == 0, f"the Gate 1 -> Gate 2 leg bought a {stage} prompt"


def test_a_group_the_reviewer_already_reshaped_is_divided_as_it_now_stands(parked):
    """A variable the reviewer moved OUT before accepting is not divided back in — and keeps its own move."""
    smoke, other, members = parked["smoke"], parked["other"], parked["members"]
    moved = members[smoke][0]
    alts = [smoke, "__unassigned__", other]
    with TestClient(app_module.app) as c:
        seeded = c.put(
            f"/api/harmonize/jobs/{JOB}/artifacts/gate1_regroup",
            json=_decision({"memberId": moved, "fromGroupId": smoke}, other, alts, movedAt=1),
        )
        assert seeded.status_code == 200, seeded.text
        r = _accept(c, smoke)
        assert r.status_code == 200, r.text
        stored = {d["memberId"]: d for d in _decisions(c)["gate1_regroup"]}
    (asked,) = parked["divider"].asked
    assert moved not in asked and sorted(asked) == sorted(m for m in members[smoke] if m != moved)
    assert stored[moved]["chosen"] == other, "the reviewer's own earlier move was overwritten by the division"


def test_a_re_split_that_keeps_the_group_whole_changes_nothing_and_says_so(parked):
    parked["divider"].whole = True
    with TestClient(app_module.app) as c:
        r = _accept(c, parked["smoke"])
        assert r.status_code == 200, r.text
        stored = _decisions(c)
    assert r.json()["nGroups"] == 0 and r.json()["parts"] == []
    assert not stored.get("gate1_new_group") and not stored.get("gate1_regroup")


def test_a_group_with_fewer_than_two_variables_left_is_refused_before_anything_is_bought(parked):
    smoke, other, members = parked["smoke"], parked["other"], parked["members"]
    alts = [smoke, "__unassigned__", other]
    with TestClient(app_module.app) as c:
        for m in members[smoke][1:]:
            c.put(
                f"/api/harmonize/jobs/{JOB}/artifacts/gate1_regroup",
                json=_decision({"memberId": m, "fromGroupId": smoke}, other, alts, movedAt=1),
            )
        r = _accept(c, smoke)
    assert r.status_code == 409, r.text
    assert "two" in r.json()["detail"].lower()
    assert parked["divider"].asked == []


def test_accepting_a_division_past_gate_1_is_refused(parked):
    """The grouping was committed by Gate 1's Continue; a division now would change nothing any leg reads."""
    app_module.store.update(JOB, gate_position="gate2")
    with TestClient(app_module.app) as c:
        r = _accept(c, parked["smoke"])
    assert r.status_code == 409
    assert "gate 1" in r.json()["detail"].lower()
    assert parked["divider"].asked == []


def test_an_unknown_group_is_refused_before_anything_is_bought(parked):
    with TestClient(app_module.app) as c:
        r = _accept(c, "c0000000000000#g9")
    assert r.status_code == 404
    assert parked["divider"].asked == []
