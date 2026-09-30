"""Score matching on a STAGED run, hosted on Gate 4 (08-28 1f — live verify 3 F20, decision Q5).

The defect: a staged run keeps its payload in the checkpoint its gates share (D-02), but the composite,
analysis-ideas and regenerate-specs routes read ``job.result`` — which a parked run does not have — so a score
declared at Gate 1 could never be matched: ``POST /composite`` at Gate 4 answered 409 "This run has no
harmonized concepts" while eight records sat in the checkpoint.

What these tests pin:

  * the three routes read the checkpoint-aware payload, over the REVIEWER'S effective records — the same
    records every export serializes (scope, renames, target picks, edits) — so a match is made against the
    concepts as the reviewer left them, never against groups they scoped out;
  * the declared score (the ``composite_swap`` rows Gate 1 wrote) is matched in ONE model call, in the order it
    was declared, billed to the run under the ``composite`` key, and persisted like any derived score;
  * a passed Gate 1 freezes EDITING the declaration, never matching it;
  * the verdict and the recipe leave the tool in the ``score_json`` export.

Nothing is mocked but the LLM client (a scripted stub that logs one priced usage per call) and the worker
spawn, which none of these routes takes.
"""

from __future__ import annotations

import json
import re

import pytest
from ddharmon.llm.cost import TokenUsage, price_usage
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.artifact_kinds import COMPOSITE_SWAP, option_set_key
from backend.checkpoint import read_checkpoint, write_checkpoint

_MODEL = "claude-sonnet-4-6"
_PER_CALL = price_usage(_MODEL, 1000, 500)
_KEY = {"x-anthropic-key": "sk-test"}

_FRIED = {
    "name": "Fried frailty phenotype",
    "citation": "Fried et al. 2001",
    "kind": "criteria_count",
    "combinationRule": "count criteria; >=3 of 5 is frail",
    "threshold": "frail if >=3 of 5",
    "statedNItems": 5,
    "components": [
        {"name": "Weak grip strength", "definition": "", "required": True, "coding": {"kind": "threshold"}},
        {"name": "Weight loss", "definition": "", "required": True, "coding": {"kind": "threshold"}},
    ],
}


def _record(group: str, concept: str, members: list[str]) -> dict:
    return {
        "id": group,
        "clusterId": group.split("#")[0],
        "groupId": group,
        "concept": concept,
        "verdict": "adopt",
        "route": "assigned",
        "cde": {"id": f"CDE-{group}", "externalId": ""},
        "idealCde": f"ideal {concept}",
        "gencde": None,
        "cosines": {"top1": 0.8, "chosen": 0.8},
        "coverageGap": False,
        "floored": False,
        "crossCohort": len({m.split(":")[0] for m in members}) > 1,
        "nMembers": len(members),
        "cohorts": sorted({m.split(":")[0] for m in members}),
        "members": members,
        "memberDetails": [],
        "transforms": [],
        "candidates": [],
        "rationale": "",
        "decidedBy": "llm",
    }


def _result(*, field_index: bool = False) -> dict:
    out = {
        "records": [
            _record("c0#g0", "Hand grip strength in kilograms", ["UKBB:grip", "CLSA:grip"]),
            _record("c1#g0", "Unintentional weight loss in the past year", ["UKBB:wl", "AoU:wl"]),
            # Scoped OUT at Gate 1: it must reach no match, no prompt and no file.
            _record("c2#g0", "Hair colour", ["UKBB:hair"]),
        ],
        "conceptGroups": [{"groupId": g} for g in ("c0#g0", "c1#g0", "c2#g0")],
        "summary": {"nRecords": 3},
        "cost": {"actualUsd": 0.5, "tokens": {"input": 1, "output": 1}, "perStage": {"assigning": {"usd": 0.5}}},
    }
    if field_index:
        out["fieldIndex"] = {
            "UKBB:grip": {"name": "grip", "questionText": "Hand grip strength (left)"},
            "CLSA:grip": {"name": "grip", "questionText": "Grip strength, dominant hand"},
            "UKBB:wl": {"name": "wl", "questionText": "Weight change compared with one year ago"},
            "AoU:wl": {"name": "wl", "questionText": "Lost weight without trying"},
            "UKBB:hair": {"name": "hair", "questionText": "Natural hair colour (before greying)"},
        }
    return out


class _Stub:
    """A scripted provider: transcribes Fried, then matches each component onto the first id it was shown.

    Logs one priced usage per call so billing has something to drain, and records every (system, prompt).
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.log: list[TokenUsage] = []

    def complete(self, prompt, *, system=None, max_tokens=512):  # noqa: ARG002 — the client signature
        self.calls.append((system or "", prompt))
        self.log.append(TokenUsage(_MODEL, 1000, 500))
        if "TRANSCRIBER" in (system or ""):
            return json.dumps(_FRIED)
        # The match pass: bind each component key to the first candidate id listed under it.
        matches = []
        for key, block in re.findall(r"\[(C\d+)\] COMPONENT:(.*?)(?=\[C\d+\] COMPONENT:|\Z)", prompt, re.S):
            ids = re.findall(r"^ {10}\[([^\]]+)\]", block, re.M)
            if ids:
                matches.append({"componentKey": key, "conceptId": ids[0], "confidence": 0.9, "rationale": "r"})
        return json.dumps({"matches": matches})

    def drain_usage(self):
        log, self.log = self.log, []
        return log


@pytest.fixture
def staged(monkeypatch, tmp_path):
    """A run PARKED at ``gate`` with a real checkpoint and a frozen two-group scope. Yields (client, park, stub)."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: None)  # noqa: ARG005
    stub = _Stub()
    monkeypatch.setattr("backend.engine.llm.build_llm_client", lambda *a, **k: stub)

    with TestClient(app_module.app) as client:

        def park(gate: str = "gate4", *, job_id: str = "st", field_index: bool = False) -> str:
            wd = tmp_path / "work" / job_id
            app_module.store.create(
                job_id,
                "Staged run",
                {"work_dir": str(wd), "cde_set": "endorsed", "gate1_scope": ["c0#g0", "c1#g0"]},
                owner_subject=None,
                dict_specs=[{"path": "x.csv", "cohort_name": "UKBB", "column_roles": {}}],
            )
            write_checkpoint(
                wd, job_id=job_id, gate=gate, result=_result(field_index=field_index), responses={}, realized_cost=0.5
            )
            app_module.store.checkpoint(
                job_id, gate=gate, checkpoint_ref=f"{job_id}/checkpoint_{gate}.json", realized_cost=0.5
            )
            app_module.store.update(job_id, cost_so_far=0.5)
            assert app_module.store.get(job_id).result is None, "the fixture must exercise the checkpoint path"
            return job_id

        yield client, park, stub


def _seed(job_id: str, kind: str, payload: dict) -> None:
    """Seed a decision AS IF made at its own gate (the server refuses writes to a gate the run has passed)."""
    from backend.jobs import principal_of

    alternatives = payload.pop("alternatives", [payload["chosen"]])
    body = {**payload, "alternatives": alternatives, "optionSetKey": option_set_key(alternatives)}
    job = app_module.store.get(job_id)
    app_module.store.artifacts.put(owner=principal_of(None, job), job_id=job_id, kind=kind, payload=body, pinned=False)


def _declare(job_id: str, score: str, components: list[str]) -> None:
    """Gate 1's "Declare these components": one ``composite_swap`` row per component, chosen "" (not matched)."""
    for name in components:
        _seed(
            job_id,
            COMPOSITE_SWAP,
            {"scoreName": score, "componentName": name, "chosen": "", "alternatives": components},
        )


def _match_prompts(stub: _Stub) -> list[str]:
    return [p for s, p in stub.calls if "TRANSCRIBER" not in s]


# --- F20: the routes read the checkpoint, not job.result ----------------------------------------------------


def test_a_run_parked_at_gate4_can_derive_a_composite(staged):
    """The live-verify driver's own Gate 4 check (`scripts/live_verify.py::gate4`): 409 before this fix."""
    client, park, _stub = staged
    job_id = park("gate4")
    r = client.post(
        f"/api/harmonize/jobs/{job_id}/composite", json={"sourceText": "Fried: five criteria."}, headers=_KEY
    )
    assert r.status_code == 200, r.text
    assert r.json()["definition"]["name"] == "Fried frailty phenotype"


def test_matching_reads_the_reviewers_effective_records(staged):
    """Scoped-out groups are not in the closed world, and a renamed group is matched under the reviewer's name."""
    client, park, stub = staged
    job_id = park("gate4")
    _seed(job_id, "gate1_rename", {"groupId": "c0#g0", "chosen": "Grip strength (dominant hand)"})
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"sourceText": "Fried."}, headers=_KEY)
    assert r.status_code == 200, r.text
    (prompt,) = _match_prompts(stub)
    assert "Grip strength (dominant hand)" in prompt
    assert "Hair colour" not in prompt, "a group scoped out at Gate 1 was offered to the matcher"


def test_the_variable_index_is_limited_to_the_final_records(staged):
    """Variable-level matching indexes the run's fieldIndex: on a staged run only the final records' members."""
    client, park, stub = staged
    job_id = park("gate4", field_index=True)
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"sourceText": "Fried."}, headers=_KEY)
    assert r.status_code == 200, r.text
    (prompt,) = _match_prompts(stub)
    assert "UKBB:grip" in prompt
    assert "UKBB:hair" not in prompt, "a variable of a scoped-out group took a shortlist slot"


# --- Q5: the declared score is matched on Gate 4 -------------------------------------------------------------


def test_a_declared_score_is_matched_in_one_call_in_declared_order(staged):
    client, park, stub = staged
    job_id = park("gate4")
    _declare(job_id, "Fried", ["Weight loss", "Weak grip strength"])
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Fried"}, headers=_KEY)
    assert r.status_code == 200, r.text
    spec = r.json()
    # ONE model call — the match. The declaration IS the definition, so nothing is transcribed.
    assert len(stub.calls) == 1 and "TRANSCRIBER" not in stub.calls[0][0]
    assert spec["definition"]["name"] == "Fried"
    assert [c["name"] for c in spec["definition"]["components"]] == ["Weight loss", "Weak grip strength"]
    assert spec["sourceKind"] == "declaration"
    assert spec["feasibility"]["verdict"] in ("full", "partial", "infeasible")
    assert {m["component"]: m["conceptId"] for m in spec["matches"]} == {
        "Weight loss": "c1#g0",
        "Weak grip strength": "c0#g0",
    }
    # Persisted like any derived score, so Gate 4 shows it after a reload.
    body = client.get(f"/api/harmonize/result/{job_id}").json()
    assert [c["definition"]["name"] for c in body["composites"]] == ["Fried"]


def test_matching_is_billed_to_the_runs_gate4_checkpoint(staged, tmp_path):
    client, park, _stub = staged
    job_id = park("gate4")
    _declare(job_id, "Fried", ["Weight loss", "Weak grip strength"])
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Fried"}, headers=_KEY)
    assert r.status_code == 200, r.text
    assert r.json()["billedUsd"] == pytest.approx(_PER_CALL)
    ckpt = read_checkpoint(tmp_path / "work" / job_id, "gate4")
    line = ckpt.result["cost"]["perStage"].get("composite")
    assert line is not None and line["calls"] == 1 and line["usd"] == pytest.approx(_PER_CALL)
    assert ckpt.result["cost"]["actualUsd"] == pytest.approx(0.5 + _PER_CALL)
    assert app_module.store.get(job_id).cost_so_far == pytest.approx(0.5 + _PER_CALL)


def test_a_passed_gate1_freezes_the_declaration_but_never_the_match(staged):
    client, park, _stub = staged
    job_id = park("gate4")
    _declare(job_id, "Fried", ["Weight loss"])
    edit = {
        "scoreName": "Fried",
        "componentName": "Grip",
        "chosen": "",
        "alternatives": ["Grip"],
        "optionSetKey": option_set_key(["Grip"]),
    }
    refused = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{COMPOSITE_SWAP}", json=edit)
    assert refused.status_code == 409, "editing a declaration after Gate 1 must be refused"
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Fried"}, headers=_KEY)
    assert r.status_code == 200, r.text


def test_matching_a_score_that_was_never_declared_is_refused_before_spending(staged):
    client, park, stub = staged
    job_id = park("gate4")
    _declare(job_id, "Fried", ["Weight loss"])
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Not declared"}, headers=_KEY)
    assert r.status_code == 409, r.text
    assert "declared" in r.json()["detail"]
    assert stub.calls == []


def test_matching_a_declared_score_without_a_key_is_refused_before_spending(staged, monkeypatch):
    client, park, stub = staged
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    job_id = park("gate4")
    _declare(job_id, "Fried", ["Weight loss"])
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Fried"})
    assert r.status_code == 400, r.text
    assert stub.calls == []


# --- the other two routes F20 named ---------------------------------------------------------------------------


def test_analysis_ideas_on_a_staged_run_reads_the_effective_records(staged, monkeypatch):
    client, park, _stub = staged
    job_id = park("gate4")
    seen: list[list[dict]] = []

    def fake_ideas(records, complete):  # noqa: ARG001
        seen.append(records)
        return {"ideas": [], "nConcepts": len(records)}

    monkeypatch.setattr("backend.analysis_ideas.generate_analysis_ideas", fake_ideas)
    r = client.post(f"/api/harmonize/jobs/{job_id}/analysis-ideas", headers=_KEY)
    assert r.status_code == 200, r.text
    assert [rec["groupId"] for rec in seen[0]] == ["c0#g0", "c1#g0"]


def test_regenerating_recodes_at_gate3_reads_and_writes_the_checkpoint(staged, monkeypatch, tmp_path):
    client, park, _stub = staged
    job_id = park("gate3")
    wd = tmp_path / "work" / job_id
    ckpt = read_checkpoint(wd, "gate3")
    ckpt.result["records"][1]["gencde"] = {"gencdeId": "GEN:wl", "preferredName": "Weight loss"}
    write_checkpoint(wd, job_id=job_id, gate="gate3", result=ckpt.result, responses={}, realized_cost=0.5)
    fresh = {"sourceVariable": "UKBB:wl", "targetCdeId": "GEN:wl", "kind": "categorical", "codeMap": {"1": "1"}}

    def fake_regen(rec_ui, dict_specs, *, model_tag, stage_fn):  # noqa: ARG001
        return {**rec_ui, "transforms": [fresh]}

    monkeypatch.setattr("backend.engine.adapter.regenerate_gencde_specs", fake_regen)
    r = client.post(f"/api/harmonize/jobs/{job_id}/records/c1%23g0/regenerate-specs", headers=_KEY)
    assert r.status_code == 200, r.text
    after = read_checkpoint(wd, "gate3")
    rec = next(x for x in after.result["records"] if x["id"] == "c1#g0")
    assert rec["transforms"] == [fresh]
    assert app_module.store.get(job_id).result is None, "a staged run's record lives in its checkpoint"


def test_regenerating_recodes_past_gate3_is_refused_before_spending(staged, monkeypatch):
    client, park, stub = staged
    job_id = park("gate4")
    monkeypatch.setattr(
        "backend.engine.adapter.regenerate_gencde_specs",
        lambda *a, **k: pytest.fail("a regeneration past Gate 3 must not run"),  # noqa: ARG005
    )
    r = client.post(f"/api/harmonize/jobs/{job_id}/records/c1%23g0/regenerate-specs", headers=_KEY)
    assert r.status_code == 409, r.text
    assert stub.calls == []


# --- the verdict and the recipe leave the tool ----------------------------------------------------------------


def test_the_score_export_carries_the_declaration_then_the_verdict_and_recipe(staged):
    client, park, _stub = staged
    job_id = park("gate4")
    _declare(job_id, "Fried", ["Weight loss", "Weak grip strength"])

    before = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "score_json"})
    assert before.status_code == 200, before.text
    assert "attachment" in before.headers["content-disposition"]
    (score,) = before.json()["scores"]
    assert score["scoreName"] == "Fried"
    assert score["declaredComponents"] == ["Weight loss", "Weak grip strength"]
    # Declared, not matched: stated, never a negative verdict assembled from no evidence.
    assert score["status"] == "declared" and score["verdict"] == "indeterminate" and score["spec"] is None

    assert client.post(
        f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Fried"}, headers=_KEY
    ).is_success
    (score,) = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "score_json"}).json()["scores"]
    assert score["status"] == "matched"
    assert score["verdict"] == score["spec"]["feasibility"]["verdict"]
    assert score["spec"]["derivation"], "the recipe must travel with the verdict"


def test_the_existing_export_formats_are_untouched_by_a_score(staged):
    """The score rides its OWN file: the records JSON stays a bare array of records."""
    client, park, _stub = staged
    job_id = park("gate4")
    _declare(job_id, "Fried", ["Weight loss"])
    assert client.post(
        f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Fried"}, headers=_KEY
    ).is_success
    records = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "records_json"}).json()
    assert isinstance(records, list) and [r["groupId"] for r in records] == ["c0#g0", "c1#g0"]
