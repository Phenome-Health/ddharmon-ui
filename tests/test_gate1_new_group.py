"""08-28 Wave 2 — "New group" and APPLIED Gate 1 moves, end to end through the backend.

The defect (08-HUMAN-SURFACE-AUDIT Theme A #1; live-verify iteration 0, I14 + I4): a Gate 1 move was recorded
and never consumed — resume threaded no membership and core had no override — so a moved variable was still
matched, spec'd and exported in its ORIGIN group; and a New group could not be created at all (``PUT
gate1_new_group`` -> 400). Now:

* ``gate1_new_group {groupId: "rev:<uuid>", name}`` is a registered Gate 1 decision kind;
* Gate 1's Continue FREEZES the reviewer's regrouping on the run's config (``gate1_overrides``) and the scope it
  sent, New groups included, so every later leg (and the $0 replay) reads the same decisions;
* the adapter hands core ``group_overrides`` on every leg and buys each New group's ideal on its OWN stage
  (``group_generate``) — never through ``generate``, which past Gate 1 stays frozen against partition drift;
* the export's decision log says a move was applied, and logs each New group.

No provider anywhere: stages are injected, embeddings stubbed.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.artifact_kinds import option_set_key
from tests.test_checkpoint import (  # noqa: F401 - _f2_clustering is a fixture used by name
    StubProvider,
    _f2_base,
    _f2_clustering,
    _f2_leg1,
    _f2_stages,
    _scope_fixture,
)

REV = f"rev:{uuid.UUID(int=7)}"
KEY = {"x-anthropic-key": "sk-test"}


def _decision(fields: dict, chosen: str, alternatives: list[str], **extra) -> dict:
    return {
        **fields,
        **extra,
        "chosen": chosen,
        "alternatives": alternatives,
        "optionSetKey": option_set_key(alternatives),
    }


def _new_group(gid: str, name: str) -> dict:
    """The payload the Gate 1 sidebar writes (and scripts/live_verify.py sends)."""
    return _decision({"groupId": gid}, name, [name], name=name)


def _move(member: str, origin: str, dest: str) -> dict:
    return _decision({"memberId": member, "fromGroupId": origin}, dest, [origin, "__unassigned__", dest], movedAt=1)


# ── the decision kind ─────────────────────────────────────────────────────────────────────────────


def test_a_new_group_is_a_registered_gate_1_decision(monkeypatch, tmp_path):
    _scope_fixture(monkeypatch, tmp_path, "ng", "gate1", ["g0"])
    with TestClient(app_module.app) as c:
        ok = c.put("/api/harmonize/jobs/ng/artifacts/gate1_new_group", json=_new_group(REV, "Eye conditions"))
        assert ok.status_code == 200, ok.text
        assert ok.json()["itemKey"] == REV
        rows = c.get("/api/harmonize/jobs/ng/artifacts").json()["artifacts"]["gate1_new_group"]
        assert [(r["groupId"], r["name"]) for r in rows] == [(REV, "Eye conditions")]
        # delete while empty is the sidebar's own verb
        assert c.delete(f"/api/harmonize/jobs/ng/artifacts/gate1_new_group/{REV}").status_code == 204


@pytest.mark.parametrize(
    "payload",
    [
        _new_group("c0#g9", "Not a reviewer id"),  # would collide with the pipeline's own group ids
        _new_group(REV, "  "),  # a nameless group
    ],
    ids=["not-a-rev-id", "blank-name"],
)
def test_a_malformed_new_group_is_refused(monkeypatch, tmp_path, payload):
    _scope_fixture(monkeypatch, tmp_path, "bad", "gate1", ["g0"])
    with TestClient(app_module.app) as c:
        assert c.put("/api/harmonize/jobs/bad/artifacts/gate1_new_group", json=payload).status_code == 400


def test_a_new_group_freezes_with_gate_1(monkeypatch, tmp_path):
    _scope_fixture(monkeypatch, tmp_path, "pst", "gate2", ["g0"])
    with TestClient(app_module.app) as c:
        r = c.put("/api/harmonize/jobs/pst/artifacts/gate1_new_group", json=_new_group(REV, "Too late"))
        assert r.status_code == 409


# ── Gate 1's Continue freezes the regrouping and a scope that includes New groups ─────────────────


def _seed(c: TestClient, job: str, kind: str, payload: dict) -> None:
    r = c.put(f"/api/harmonize/jobs/{job}/artifacts/{kind}", json=payload)
    assert r.status_code == 200, r.text


def test_gate1_continue_freezes_the_regrouping_and_keeps_new_groups_in_scope(monkeypatch, tmp_path):
    configs = _scope_fixture(monkeypatch, tmp_path, "fr", "gate1", ["g0", "g1"])
    with TestClient(app_module.app) as c:
        _seed(c, "fr", "gate1_new_group", _new_group(REV, "Cataract"))
        _seed(c, "fr", "gate1_new_group", _new_group("rev:stale", "Deleted later"))  # an EMPTY one: sent out of scope
        _seed(c, "fr", "gate1_regroup", _move("A:cat", "g0", REV))
        _seed(c, "fr", "gate1_regroup", _move("B:cat", "g1", REV))
        _seed(c, "fr", "gate1_regroup", _move("A:ret", "__unassigned__", "g0"))
        _seed(c, "fr", "gate1_regroup", _move("A:mac", "g1", "__unassigned__"))
        _seed(c, "fr", "gate1_regroup", _move("A:gone", "g0", "c9#g9"))  # a destination no group has
        r = c.post("/api/harmonize/resume/fr", headers=KEY, json={"gate1Scope": ["g0", REV]})
    assert r.status_code == 200, r.text
    cfg = app_module.store.get("fr").config
    assert cfg["gate1_scope"] == ["g0", REV], "the New group was dropped from the frozen scope"
    frozen = cfg["gate1_overrides"]
    assert frozen["moves"] == {"A:cat": REV, "A:mac": None, "A:ret": "g0", "B:cat": REV}
    assert [g["groupId"] for g in frozen["newGroups"]] == sorted([REV, "rev:stale"])
    assert {g["groupId"]: g["name"] for g in frozen["newGroups"]}[REV] == "Cataract"
    leg = configs[-1]
    assert leg["assign_group_ids"] == ["g0", REV]
    assert leg["gate1_overrides"] == frozen


def test_later_legs_keep_new_groups_in_the_frozen_scope(monkeypatch, tmp_path):
    """A Gate 2 checkpoint's conceptGroups are still the split's (a New group is a record, not a split group),
    so filtering the frozen scope by them alone would drop the New group from the Gate 2 -> Gate 3 leg."""
    configs = _scope_fixture(monkeypatch, tmp_path, "l3", "gate2", ["g0", "g1"])
    job = app_module.store.get("l3")
    overrides = {"moves": {"A:cat": REV}, "newGroups": [{"groupId": REV, "name": "Cataract"}]}
    app_module.store.update("l3", config={**job.config, "gate1_scope": ["g0", REV], "gate1_overrides": overrides})
    with TestClient(app_module.app) as c:
        assert c.post("/api/harmonize/resume/l3", headers=KEY).status_code == 200
    assert configs[-1]["assign_group_ids"] == ["g0", REV]
    assert configs[-1]["gate1_overrides"] == overrides


# ── the adapter: overrides on every leg, the New group's ideal on its own stage, the guard intact ─────


def _overrides_for(leg1: dict) -> tuple[dict, str, str, str]:
    """Move one smoking variable and one clustering leftover into a New group, and one recovered-cluster
    variable into the smoking group — the shape of the live walk's eye-condition regrouping."""
    groups = {g["groupId"]: g for g in leg1["conceptGroups"]}
    members = leg1["conceptGroupMembers"]
    smoke = next(gid for gid in groups if any(m.split(":")[1].startswith("SMOKE") for m in members[gid]))
    other = next(gid for gid in groups if gid != smoke)
    grouped = {m for ms in members.values() for m in ms}
    leftover = sorted(set(leg1["fieldIndex"]) - grouped)[0]
    moved_smoke = members[smoke][0]
    moved_other = members[other][0]
    overrides = {
        "moves": {moved_smoke: REV, leftover: REV, moved_other: smoke},
        "newGroups": [{"groupId": REV, "name": "Reviewer group"}],
    }
    return overrides, smoke, moved_smoke, moved_other


def _counting(sink: dict) -> dict:
    stages = _f2_stages(sink)

    def group_generate(prompts):
        sink["group_generate"] = sink.get("group_generate", 0) + len(prompts)
        return {p.id: {"ideal_cde": "A group the reviewer formed"} for p in prompts}

    return {**stages, "group_generate": group_generate}


@pytest.mark.usefixtures("_f2_clustering")
def test_every_later_leg_applies_the_regrouping_and_buys_the_new_groups_ideal_once(tmp_path):
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec, leg1, responses = _f2_leg1(tmp_path)
    overrides, smoke, moved_smoke, moved_other = _overrides_for(leg1)
    cfg = {**_f2_base(tmp_path), "gate1_overrides": overrides}

    calls: dict[str, int] = {}
    recorded: dict[str, dict] = {}
    leg2 = run_pipeline(
        dict_specs,
        cde_spec,
        {**cfg, "stop_at_gate": "gate2"},
        provider=StubProvider(),
        stage_overrides=_counting(calls),
        replay_responses=responses,
        stage_responses=recorded,
    )
    by = {r["groupId"]: r for r in leg2["records"]}
    assert REV in by, "the New group is not its own record at Gate 2"
    assert set(by[REV]["members"]) >= {moved_smoke}, by[REV]["members"]
    assert by[REV]["concept"] == "Reviewer group"
    assert moved_smoke not in by[smoke]["members"], "the move out of the smoking group was not applied"
    assert moved_other in by[smoke]["members"], "the move into the smoking group was not applied"
    # Option B: the New group, and the two existing groups whose members changed, each buy exactly one ideal.
    assert calls.get("group_generate") == 3, "each New or edited group buys exactly one ideal"
    for stage in ("generate", "split", "coherence"):
        assert calls.get(stage, 0) == 0, f"the Gate 1 -> Gate 2 leg bought a {stage} prompt"
    assert set(recorded.get("generate") or {}) == set(responses["generate"]), "the New group's ideal hid in generate"
    assert list(recorded["group_generate"]) == [
        p for p in recorded["group_generate"] if p.startswith("leanb:groupideal:")
    ]

    # Gate 2 -> Gate 3: the same frozen overrides replay every answer, the New group's ideal included, for $0.
    leg3_calls: dict[str, int] = {}
    leg3 = run_pipeline(
        dict_specs,
        cde_spec,
        {**cfg, "stop_at_gate": None, "park_at_gate": "gate3"},
        provider=StubProvider(),
        stage_overrides=_counting(leg3_calls),
        replay_responses={**responses, **recorded},
    )
    for stage in ("generate", "split", "coherence", "group_generate", "classify"):
        assert leg3_calls.get(stage, 0) == 0, f"the Gate 2 -> Gate 3 leg re-bought {stage}"
    by3 = {r["groupId"]: r for r in leg3["records"]}
    assert REV in by3 and moved_smoke not in by3[smoke]["members"] and moved_other in by3[smoke]["members"]


@pytest.mark.usefixtures("_f2_clustering")
def test_the_drift_guard_still_fails_a_leg_whose_partition_moved(tmp_path):
    """New groups are sanctioned through their own stage, so the frozen generate stage is exactly as strict as
    before: a cluster ideal the Gate 1 leg never asked for still fails the leg before anything is bought."""
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec, leg1, responses = _f2_leg1(tmp_path)
    overrides, *_ = _overrides_for(leg1)
    dropped = sorted(responses["generate"])[0]
    drifted = {**responses, "generate": {k: v for k, v in responses["generate"].items() if k != dropped}}
    calls: dict[str, int] = {}
    with pytest.raises(RuntimeError, match=re.escape(dropped)) as exc:
        run_pipeline(
            dict_specs,
            cde_spec,
            {**_f2_base(tmp_path), "gate1_overrides": overrides, "stop_at_gate": "gate2"},
            provider=StubProvider(),
            stage_overrides=_counting(calls),
            replay_responses=drifted,
        )
    assert exc.type.__name__ == "PartitionDriftError"
    assert "classify" not in calls and "group_generate" not in calls


@pytest.mark.usefixtures("_f2_clustering")
def test_without_a_dedicated_runner_the_ideal_still_bypasses_the_frozen_generate(tmp_path):
    """A caller that injects no ``group_generate`` (older tests, one-off tools) gets ``generate``'s function —
    but recorded under its OWN stage, so the frozen ``generate`` wrapper never sees the New group's prompt."""
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec, leg1, responses = _f2_leg1(tmp_path)
    overrides, *_ = _overrides_for(leg1)
    recorded: dict[str, dict] = {}
    leg2 = run_pipeline(
        dict_specs,
        cde_spec,
        {**_f2_base(tmp_path), "gate1_overrides": overrides, "stop_at_gate": "gate2"},
        provider=StubProvider(),
        stage_overrides=_f2_stages({}),
        replay_responses=responses,
        stage_responses=recorded,
    )
    assert REV in {r["groupId"] for r in leg2["records"]}
    assert recorded.get("group_generate")


@pytest.mark.usefixtures("_f2_clustering")
def test_the_zero_cost_replay_applies_the_frozen_regrouping(tmp_path):
    from backend.engine.adapter import replay_leanb_result, run_pipeline

    dict_specs, cde_spec, leg1, responses = _f2_leg1(tmp_path)
    overrides, smoke, moved_smoke, _ = _overrides_for(leg1)
    cfg = {**_f2_base(tmp_path), "gate1_overrides": overrides}
    recorded: dict[str, dict] = {}
    run_pipeline(
        dict_specs,
        cde_spec,
        {**cfg, "stop_at_gate": "gate2"},
        provider=StubProvider(),
        stage_overrides=_counting({}),
        replay_responses=responses,
        stage_responses=recorded,
    )
    missing: list[tuple[str, list[str]]] = []
    result, _embedded = replay_leanb_result(
        dict_specs,
        cde_spec,
        cfg,
        replay_responses={**responses, **recorded},
        provider=StubProvider(),
        on_missing=lambda stage, ids: missing.append((stage, ids)),
    )
    assert not missing, missing
    by = {r.group_id: r for r in result.records}
    assert REV in by and moved_smoke not in by[smoke].member_variable_names


@pytest.mark.usefixtures("_f2_clustering")
def test_moves_naming_a_variable_the_run_does_not_have_are_dropped_not_fatal(tmp_path):
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec, leg1, responses = _f2_leg1(tmp_path)
    overrides, *_ = _overrides_for(leg1)
    overrides["moves"]["CohortA:NOT_A_FIELD"] = REV
    leg2 = run_pipeline(
        dict_specs,
        cde_spec,
        {**_f2_base(tmp_path), "gate1_overrides": overrides, "stop_at_gate": "gate2"},
        provider=StubProvider(),
        stage_overrides=_counting({}),
        replay_responses=responses,
    )
    assert REV in {r["groupId"] for r in leg2["records"]}


def test_the_new_group_ideal_bills_under_its_own_key_attributed_to_gate_2():
    """R8: the spend is recorded under a key the estimator attributes — Gate 2's figure, beside the assign that
    the same Continue buys."""
    from backend.batch_reconcile import TAG_TO_STAGE
    from backend.engine import adapter

    src = (Path(__file__).resolve().parents[1] / "frontend/src/lib/estimate.ts").read_text()
    m = re.search(r"GATE_LEDGER_KEYS[^=]*=\s*\{(.*?)\n\};", src, re.S)
    assert m
    gate2 = re.search(r"gate2:\s*\[([^\]]*)\]", m.group(1))
    assert gate2 and f'"{adapter.GROUP_IDEAL_COST_KEY}"' in gate2.group(1)
    assert TAG_TO_STAGE[adapter.GROUP_IDEAL_TAG] == "group_generate"


# ── the export: moves read as applied, New groups are logged ────────────────────────────────────────


def test_the_decision_log_says_a_move_was_applied_and_logs_the_new_group():
    from backend.export_decisions import decision_log_rows

    result = {"records": [{"id": REV, "groupId": REV, "concept": "Cataract", "members": ["A:cat"]}]}
    grouped = {
        "gate1_new_group": [_new_group(REV, "Cataract")],
        "gate1_regroup": [_move("A:cat", "g0", REV), _move("A:late", "g0", "g1")],
    }
    config = {"gate1_scope": [REV], "gate1_overrides": {"moves": {"A:cat": REV}, "newGroups": [{"groupId": REV}]}}
    rows = {(r[1], r[3]): r for r in decision_log_rows(result, config, grouped)}
    assert rows[("gate1_new_group", REV)][2:6] == ["Created a group", REV, "", "Cataract"]
    assert rows[("gate1_regroup", "A:cat")][7] == "applied"
    # a move the frozen regrouping does not carry (the run passed Gate 1 before moves were applied)
    assert rows[("gate1_regroup", "A:late")][7] == "not applied"
    # still at Gate 1: nothing frozen yet, so nothing is claimed either way
    pending = {(r[1], r[3]): r for r in decision_log_rows(result, {}, grouped)}
    assert pending[("gate1_regroup", "A:cat")][7] == ""


def test_no_screen_still_says_moves_are_not_applied():
    root = Path(__file__).resolve().parents[1] / "frontend/src/pages/run"
    for page in ("gate1.tsx", "gate2.tsx"):
        src = (root / page).read_text()
        assert "moves-not-applied" not in src, page
        assert not re.search(r"not (yet )?applied to matching", src), f"{page} still says moves are not applied"


# ── Option B (2026-09-18): a group EDITED at Gate 1 gets its ideal regenerated, on the same stage ───────────


def _moves_only(leg1: dict) -> tuple[dict, str, str, str]:
    """No New group: one variable moved from one group into another, so BOTH groups' memberships change."""
    groups = [g["groupId"] for g in leg1["conceptGroups"]]
    members = leg1["conceptGroupMembers"]
    src = max(groups, key=lambda g: len(members[g]))
    dest = next(g for g in groups if g != src)
    moved = members[src][0]
    return {"moves": {moved: dest}, "newGroups": []}, src, dest, moved


@pytest.mark.usefixtures("_f2_clustering")
def test_a_moves_only_regrouping_buys_the_changed_groups_ideals_on_their_own_stage(tmp_path):
    """The ideal anchors the novel decision, so each group whose members changed is assigned against one written
    for its final members — bought on ``group_generate`` even when the reviewer made no New group. Before, that
    stage was built only for New groups, so core fell back to the FROZEN ``generate`` and the leg died of
    "partition drift" over the reviewer's own, sanctioned edit."""
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec, leg1, responses = _f2_leg1(tmp_path)
    overrides, src, dest, moved = _moves_only(leg1)
    cfg = {**_f2_base(tmp_path), "gate1_overrides": overrides}
    calls: dict[str, int] = {}
    recorded: dict[str, dict] = {}
    leg2 = run_pipeline(
        dict_specs,
        cde_spec,
        {**cfg, "stop_at_gate": "gate2"},
        provider=StubProvider(),
        stage_overrides=_f2_stages(calls),  # no dedicated runner: the production sync/batch paths build their own
        replay_responses=responses,
        stage_responses=recorded,
    )
    by = {r["groupId"]: r for r in leg2["records"]}
    assert moved in by[dest]["members"] and moved not in by[src]["members"]
    ideals = sorted(recorded.get("group_generate") or {})
    assert [i.split("@")[0] for i in ideals] == sorted(f"leanb:groupideal:{g}" for g in (src, dest)), ideals
    assert set(recorded.get("generate") or {}) == set(responses["generate"]), "an edited group's ideal hid in generate"

    leg3_calls: dict[str, int] = {}
    run_pipeline(
        dict_specs,
        cde_spec,
        {**cfg, "stop_at_gate": None, "park_at_gate": "gate3"},
        provider=StubProvider(),
        stage_overrides=_counting(leg3_calls),
        replay_responses={**responses, **recorded},
    )
    assert leg3_calls.get("group_generate", 0) == 0, "the Gate 2 -> Gate 3 leg re-bought a regenerated ideal"


@pytest.mark.usefixtures("_f2_clustering")
def test_an_out_of_scope_edited_group_buys_no_ideal(tmp_path):
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec, leg1, responses = _f2_leg1(tmp_path)
    overrides, src, dest, _moved = _moves_only(leg1)
    calls: dict[str, int] = {}
    recorded: dict[str, dict] = {}
    run_pipeline(
        dict_specs,
        cde_spec,
        {**_f2_base(tmp_path), "gate1_overrides": overrides, "stop_at_gate": "gate2", "assign_group_ids": [dest]},
        provider=StubProvider(),
        stage_overrides=_counting(calls),
        replay_responses=responses,
        stage_responses=recorded,
    )
    assert [i.split("@")[0] for i in recorded.get("group_generate") or {}] == [f"leanb:groupideal:{dest}"]
    assert calls.get("group_generate") == 1
