"""Gate 4's exports on a STAGED run (08-27 Tasks 2 + 3).

Two defects, each pinned here by the behaviour a reviewer relies on:

  1. ``/export`` required ``job.result``. A run parked at a gate keeps its payload in the checkpoint (D-02),
     so every Gate 4 download on a staged run 404'd with "Job not found or not complete".
  2. ``/export`` read the raw pipeline records plus the legacy workbench verdicts only, so NONE of the
     reviewer's gate decisions reached a file: Gate 1 scope / rename / regroup, the Gate 2 target pick, the
     Gate 3 recode edits and rejections, the Gate 4 export selection.

The run is parked at Gate 3 with a real checkpoint and walked to Gate 4 through the resume route (the same
path the Continue button takes); decisions are seeded through the PUT artifact route (the same path the gate
screens write through). Nothing is mocked except the worker spawn, which a Gate 3 -> Gate 4 leg never does.
"""

from __future__ import annotations

import ast
import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.artifact_kinds import option_set_key
from backend.checkpoint import write_checkpoint

FORMATS = ("eitl_tsv", "decisions_csv", "records_json", "notebook_py", "notebook_r")


def _cand(rank: int, cde_id: str, ext: str, chosen: bool) -> dict:
    return {
        "rank": rank,
        "cdeId": cde_id,
        "cdeExternalId": ext,
        "definition": f"{cde_id} definition",
        "cosine": 0.9 - rank / 10,
        "isChosen": chosen,
        "llmSuggested": chosen,
    }


def _transform(source: str, target: str, code_map: dict[str, str]) -> dict:
    return {
        "sourceVariable": source,
        "targetCdeId": target,
        "kind": "categorical",
        "confidence": 0.8,
        "coverage": 1.0,
        "needsUnits": False,
        "needsData": False,
        "needsReview": False,
        "rationale": "",
        "generatedBy": "llm",
        "codeMap": code_map,
        "unmappedSourceCodes": [],
    }


def _record(group: str, concept: str, verdict: str, cde: dict | None, members: list[str], **kw) -> dict:
    return {
        "id": group,
        "clusterId": group.split("#")[0],
        "groupId": group,
        "concept": concept,
        "verdict": verdict,
        "route": "assigned" if cde else "gencde_residual",
        "cde": cde,
        "idealCde": f"ideal {concept}",
        "gencde": kw.get("gencde"),
        "cosines": {"top1": 0.8, "chosen": 0.8 if cde else None},
        "coverageGap": False,
        "floored": False,
        "crossCohort": True,
        "nMembers": len(members),
        "cohorts": sorted({m.split(":")[0] for m in members}),
        "members": members,
        "memberDetails": [],
        "transforms": kw.get("transforms", []),
        "candidates": kw.get("candidates", []),
        "rationale": "because",
        "decidedBy": "llm",
    }


def _result() -> dict:
    return {
        "records": [
            _record(
                "c0#g0",
                "Age in years",
                "adopt",
                {"id": "AgeCDE", "externalId": "tiny-age"},
                ["A:age", "B:age_yrs"],
                candidates=[_cand(1, "AgeCDE", "tiny-age", True), _cand(2, "AgeAtVisitCDE", "tiny-visit", False)],
            ),
            _record(
                "c1#g0",
                "Smoking status",
                "refine",
                {"id": "SmokeCDE", "externalId": "tiny-smoke"},
                ["A:smoke", "B:smk"],
                candidates=[_cand(1, "SmokeCDE", "tiny-smoke", True), _cand(2, "TobaccoCDE", "tiny-tob", False)],
                transforms=[
                    _transform("A:smoke", "SmokeCDE", {"1": "Yes", "2": "No"}),
                    _transform("B:smk", "SmokeCDE", {"Y": "Yes", "N": "No"}),
                ],
            ),
            _record(
                "c2#g0",
                "Hair colour",
                "novel",
                None,
                ["A:hair"],
                gencde={"isGenerated": True, "gencdeId": "GEN:hair", "preferredName": "Hair colour"},
            ),
        ],
        "conceptGroups": [{"groupId": g} for g in ("c0#g0", "c1#g0", "c2#g0")],
        "summary": {"nRecords": 3, "cohorts": ["A", "B"]},
        "cost": {"actualUsd": 5.0},
    }


@pytest.fixture
def parked(monkeypatch, tmp_path):
    """A run parked at Gate 3 with a real checkpoint. Returns a ``park(gate)`` that walks it to ``gate``."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: None)  # noqa: ARG005

    with TestClient(app_module.app) as client:

        def park(gate: str = "gate4", *, job_id: str = "st", config: dict | None = None) -> str:
            wd = tmp_path / "work" / job_id
            app_module.store.create(
                job_id,
                "Staged run",
                {"work_dir": str(wd), "cde_set": "endorsed", **(config or {})},
                owner_subject=None,
                dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
            )
            write_checkpoint(wd, job_id=job_id, gate="gate3", result=_result(), responses={}, realized_cost=5.0)
            app_module.store.checkpoint(
                job_id, gate="gate3", checkpoint_ref=f"{job_id}/checkpoint_gate3.json", realized_cost=5.0
            )
            if gate == "gate4":
                # The Continue button's own path: Gate 3 -> Gate 4 is a pure read that re-checkpoints.
                assert client.post(f"/api/harmonize/resume/{job_id}").json()["target"] == "gate4"
            assert app_module.store.get(job_id).gate_position == gate
            assert app_module.store.get(job_id).result is None, "the fixture must exercise the checkpoint path"
            return job_id

        yield client, park


def _put(client, job_id: str, kind: str, payload: dict) -> None:
    alternatives = payload.pop("alternatives", [payload["chosen"]])
    body = {**payload, "alternatives": alternatives, "optionSetKey": option_set_key(alternatives)}
    r = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{kind}", json=body)
    assert r.status_code == 200, r.text


def _rows(text: str, sep: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text), delimiter=sep))


def _export(client, job_id: str, fmt: str):
    r = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": fmt})
    assert r.status_code == 200, f"{fmt}: {r.status_code} {r.text}"
    return r


def _notebook_code(client, job_id: str, fmt: str = "notebook_py") -> str:
    nb = _export(client, job_id, fmt).json()
    return "\n".join("".join(c["source"]) for c in nb["cells"])


# --- Task 2: every tile downloads on a staged run ----------------------------------------------------------


@pytest.mark.parametrize("gate", ["gate3", "gate4"])
@pytest.mark.parametrize("fmt", FORMATS)
def test_every_gate4_tile_downloads_on_a_parked_run(parked, gate, fmt):
    """The reproduced defect: a parked run's payload lives in its checkpoint, so /export 404'd on every tile."""
    client, park = parked
    job_id = park(gate)
    r = _export(client, job_id, fmt)
    assert r.content, f"{fmt} downloaded an empty file"


def test_an_unparked_run_with_no_result_still_404s(parked):
    client, _ = parked
    app_module.store.create("np", "Nothing yet", {}, owner_subject=None)
    assert client.get("/api/harmonize/jobs/np/export").status_code == 404


# --- Task 3: the reviewer's decisions reach every file ----------------------------------------------------


def test_the_frozen_gate1_scope_removes_out_of_scope_groups_from_every_format(parked):
    client, park = parked
    job_id = park("gate4", config={"gate1_scope": ["c0#g0", "c1#g0"]})
    # A stale "in" decision on the out-of-scope group loses to the frozen list the reviewer continued with.
    _put(client, job_id, "gate1_group_scope", {"groupId": "c2#g0", "chosen": "in", "alternatives": ["in", "out"]})

    tsv = _rows(_export(client, job_id, "eitl_tsv").text, "\t")
    assert {r["recordId"] for r in tsv} == {"c0#g0", "c1#g0"}
    assert {r["id"] for r in _export(client, job_id, "records_json").json()} == {"c0#g0", "c1#g0"}
    assert "hair" not in _notebook_code(client, job_id).lower()


def test_without_a_frozen_scope_an_out_decision_still_removes_the_group(parked):
    """Legacy staged runs (passed Gate 1 before 08-27) carry no frozen list: the default-in rule the paid
    assign applied to them is the rule the export applies, so the file matches what was billed."""
    client, park = parked
    job_id = park("gate4")
    _put(client, job_id, "gate1_group_scope", {"groupId": "c0#g0", "chosen": "out", "alternatives": ["in", "out"]})
    tsv = _rows(_export(client, job_id, "eitl_tsv").text, "\t")
    assert {r["recordId"] for r in tsv} == {"c1#g0", "c2#g0"}


def test_a_renamed_group_exports_the_reviewers_name_with_the_generated_one_alongside(parked):
    client, park = parked
    job_id = park("gate4")
    _put(
        client,
        job_id,
        "gate1_rename",
        {
            "groupId": "c0#g0",
            "chosen": "Participant age",
            "alternatives": ["Age in years", "Participant age"],
            "generatedName": "Age in years",
        },
    )
    row = next(r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t") if r["recordId"] == "c0#g0")
    assert row["concept"] == "Participant age"
    assert row["generatedConcept"] == "Age in years"
    rec = next(r for r in _export(client, job_id, "records_json").json() if r["id"] == "c0#g0")
    assert rec["concept"] == "Participant age" and rec["generatedConcept"] == "Age in years"
    assert "Participant age" in _notebook_code(client, job_id)


def test_the_cde_column_is_the_reviewers_pick_with_the_models_alongside(parked):
    client, park = parked
    job_id = park("gate4")
    _put(
        client,
        job_id,
        "gate2_candidate_pick",
        {"groupId": "c0#g0", "chosen": "AgeAtVisitCDE", "alternatives": ["AgeCDE", "AgeAtVisitCDE"]},
    )
    rows = {r["recordId"]: r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t")}
    assert rows["c0#g0"]["cdeId"] == "AgeAtVisitCDE"
    assert rows["c0#g0"]["cdeExternalId"] == "tiny-visit"
    assert rows["c0#g0"]["modelCdeId"] == "AgeCDE"
    assert rows["c0#g0"]["targetPickedBy"] == "reviewer"
    # An un-picked group keeps the model's target and says so.
    assert rows["c1#g0"]["cdeId"] == "SmokeCDE" and rows["c1#g0"]["targetPickedBy"] == "model"
    rec = next(r for r in _export(client, job_id, "records_json").json() if r["id"] == "c0#g0")
    assert rec["cde"]["id"] == "AgeAtVisitCDE" and rec["modelCde"]["id"] == "AgeCDE"
    code = _notebook_code(client, job_id)
    assert '"AgeAtVisitCDE"' in code and 'h_A["AgeCDE"]' not in code


def test_none_of_these_clears_the_catalog_target(parked):
    client, park = parked
    job_id = park("gate4")
    _put(
        client,
        job_id,
        "gate2_candidate_pick",
        {
            "groupId": "c0#g0",
            "chosen": "",
            "alternatives": ["AgeCDE", "AgeAtVisitCDE"],
            "gencdeEdit": {"name": "My age", "definition": "Age, my way", "units": "years", "values": ""},
        },
    )
    row = next(r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t") if r["recordId"] == "c0#g0")
    assert row["cdeId"] == "" and row["modelCdeId"] == "AgeCDE" and row["targetPickedBy"] == "reviewer"
    assert json.loads(row["gencdeEdit"])["name"] == "My age"


def test_an_edited_recode_exports_as_edited_and_a_rejected_one_is_excluded_from_the_notebook(parked):
    client, park = parked
    job_id = park("gate4")
    _put(
        client,
        job_id,
        "gate3_spec_edit",
        {
            "sourceVariable": "A:smoke",
            "chosen": "A:smoke",
            "note": "codes checked against the codebook",
            "mapping": {"1": "Current", "2": "Never", "9": "__missing__"},
            "upstream": None,
        },
    )
    _put(client, job_id, "gate3_spec_edit", {"sourceVariable": "B:smk", "chosen": "", "rejected": True})

    for fmt in ("notebook_py", "notebook_r"):
        code = _notebook_code(client, job_id, fmt)
        assert "Current" in code and "Never" in code, f"{fmt} did not apply the reviewer's mapping"
        applied = code.split("Rejected recodes")[0]
        assert '"Yes"' not in applied and "'Yes'" not in applied, f"{fmt} still applies the model's map"
        assert 'raw_B["smk"]' not in code and 'raw_B[["smk"]]' not in code, f"{fmt} still emits the rejection"
        assert "B:smk" in code.split("Rejected recodes")[1], f"{fmt} dropped the rejection silently"
    for cell in _export(client, job_id, "notebook_py").json()["cells"]:
        if cell["cell_type"] == "code":
            ast.parse("".join(cell["source"]))  # the edited recode is still runnable Python

    row = next(r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t") if r["recordId"] == "c1#g0")
    assert row["rejectedTransforms"] == "B:smk"
    assert row["nTransforms"] == "1"
    edits = json.loads(row["transformEdits"])
    assert edits["A:smoke"]["mapping"]["1"] == "Current"
    assert edits["A:smoke"]["note"] == "codes checked against the codebook"

    rec = next(r for r in _export(client, job_id, "records_json").json() if r["id"] == "c1#g0")
    by_src = {t["sourceVariable"]: t for t in rec["transforms"]}
    assert by_src["A:smoke"]["reviewerEdit"]["mapping"]["2"] == "Never"
    assert by_src["B:smk"]["rejected"] is True


def test_the_decision_log_lists_each_gate_decision_with_before_and_after(parked):
    client, park = parked
    job_id = park("gate4", config={"gate1_scope": ["c0#g0", "c1#g0"]})
    _put(
        client,
        job_id,
        "gate1_rename",
        {"groupId": "c0#g0", "chosen": "Participant age", "generatedName": "Age in years"},
    )
    _put(client, job_id, "gate1_regroup", {"memberId": "B:age_yrs", "fromGroupId": "c0#g0", "chosen": "c1#g0"})
    _put(client, job_id, "gate2_candidate_pick", {"groupId": "c0#g0", "chosen": "AgeAtVisitCDE"})
    _put(client, job_id, "gate3_spec_edit", {"sourceVariable": "A:smoke", "chosen": "A:smoke", "note": "checked"})
    _put(client, job_id, "gate3_spec_edit", {"sourceVariable": "B:smk", "chosen": "", "rejected": True})

    text = _export(client, job_id, "decisions_csv").text
    rows = _rows(text, ",")
    assert list(rows[0].keys()) == ["gate", "kind", "action", "item", "before", "after", "note", "detail", "stale"]
    by = {(r["kind"], r["item"]): r for r in rows}
    assert by[("gate1_rename", "c0#g0")]["before"] == "Age in years"
    assert by[("gate1_rename", "c0#g0")]["after"] == "Participant age"
    assert by[("gate1_regroup", "B:age_yrs")]["before"] == "c0#g0"
    assert by[("gate1_regroup", "B:age_yrs")]["after"] == "c1#g0"
    assert by[("gate2_candidate_pick", "c0#g0")]["before"] == "AgeCDE"
    assert by[("gate2_candidate_pick", "c0#g0")]["after"] == "AgeAtVisitCDE"
    assert by[("gate3_spec_edit", "A:smoke")]["note"] == "checked"
    assert by[("gate3_spec_edit", "B:smk")]["after"] == "rejected"
    assert "categorical" in by[("gate3_spec_edit", "B:smk")]["before"]
    frozen = by[("gate1_scope_frozen", "")]
    assert frozen["gate"] == "Gate 1" and "2" in frozen["after"]
    assert all(r["gate"] for r in rows)


def test_a_gate4_exclusion_removes_a_record_and_absence_is_a_no_op(parked):
    """``gate4_export_selection`` is registered but NO screen writes it today (tile selection is component
    state). The filter is therefore a no-op until one does — and is proven to work once one does."""
    client, park = parked
    job_id = park("gate4")
    assert len(_export(client, job_id, "records_json").json()) == 3
    _put(
        client,
        job_id,
        "gate4_export_selection",
        {"recordId": "c2#g0", "chosen": "exclude", "alternatives": ["include", "exclude"]},
    )
    _put(
        client,
        job_id,
        "gate4_export_selection",
        {"recordId": "c1#g0", "chosen": "include", "alternatives": ["include", "exclude"]},
    )
    assert {r["id"] for r in _export(client, job_id, "records_json").json()} == {"c0#g0", "c1#g0"}
    assert {r["recordId"] for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t")} == {"c0#g0", "c1#g0"}


def test_the_export_is_scoped_to_the_caller(parked, monkeypatch):
    """Decisions are per user, and so is the run: another signed-in user cannot download it at all, and the
    owner's file carries the owner's decisions."""
    client, park = parked
    job_id = park("gate4")
    app_module.store.update(job_id, owner_subject="user_A")
    from backend import auth

    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.delenv("DDHARMON_ALLOWED_EMAIL_DOMAINS", raising=False)
    monkeypatch.setattr(auth, "_decode_claims", lambda token: {"email": f"{token}@x.org", "sub": token})
    a = {"Authorization": "Bearer user_A"}
    alts = ["Age in years", "Participant age"]
    body = {"groupId": "c0#g0", "chosen": "Participant age", "alternatives": alts, "optionSetKey": option_set_key(alts)}
    assert client.put(f"/api/harmonize/jobs/{job_id}/artifacts/gate1_rename", json=body, headers=a).status_code == 200

    mine = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "eitl_tsv"}, headers=a)
    assert mine.status_code == 200
    assert "Participant age" in mine.text
    theirs = client.get(
        f"/api/harmonize/jobs/{job_id}/export",
        params={"format": "eitl_tsv"},
        headers={"Authorization": "Bearer user_B"},
    )
    assert theirs.status_code == 404


def test_a_recode_left_unedited_after_a_target_repick_is_shown_for_review_not_applied(parked):
    """Gate 3's specs were generated for the MODEL's CDE. Re-picked at Gate 2 and not re-mapped, their codes
    were written for a different target, so the notebook names the new target and leaves the recode commented."""
    client, park = parked
    job_id = park("gate4")
    _put(
        client,
        job_id,
        "gate2_candidate_pick",
        {"groupId": "c1#g0", "chosen": "TobaccoCDE", "alternatives": ["SmokeCDE", "TobaccoCDE"]},
    )
    _put(
        client,
        job_id,
        "gate3_spec_edit",
        {"sourceVariable": "B:smk", "chosen": "B:smk", "mapping": {"Y": "Daily", "N": "Never"}},
    )
    code = _notebook_code(client, job_id)
    assert "REVIEW REQUIRED: target re-picked" in code
    assert '# h_A["TobaccoCDE"] = raw_A["smoke"]' in code, "the stale recode must be commented, not applied"
    assert 'h_B["TobaccoCDE"] = raw_B["smk"]' in code, "the recode the reviewer re-mapped IS applied"
    rec = next(r for r in _export(client, job_id, "records_json").json() if r["id"] == "c1#g0")
    by_src = {t["sourceVariable"]: t for t in rec["transforms"]}
    assert by_src["A:smoke"]["targetRepicked"] is True and by_src["A:smoke"]["modelTargetCdeId"] == "SmokeCDE"
    assert "targetRepicked" not in by_src["B:smk"]


def test_the_edited_python_notebook_runs_and_applies_every_edit_shape(tmp_path, monkeypatch):
    """Each Gate 3 editor (value map, code -> number, binning) produces a recode that EXECUTES and yields the
    reviewer's values — a scaffold that only parses would still ship a wrong number."""
    pd = pytest.importorskip("pandas")
    from backend.export_decisions import effective_records
    from backend.notebook import build_notebook

    def t(src, kind="categorical"):
        return {**_transform(src, "T", {"1": "Yes"}), "kind": kind}

    rec = _record(
        "c9#g0", "Edited", "refine", {"id": "T", "externalId": ""}, ["A:cat", "A:num", "A:bin"],
        transforms=[t("A:cat"), t("A:num"), t("A:bin", "unit")],
    )  # fmt: skip
    grouped = {
        "gate3_spec_edit": [
            {"sourceVariable": "A:cat", "chosen": "A:cat", "alternatives": [], "optionSetKey": "k",
             "mapping": {"1": "Current", "2": "Never", "9": "__missing__"}},
            {"sourceVariable": "A:num", "chosen": "A:num", "alternatives": [], "optionSetKey": "k",
             "numberMap": {"98": {"action": "number", "value": 60}, "99": {"action": "missing", "value": None}}},
            {"sourceVariable": "A:bin", "chosen": "A:bin", "alternatives": [], "optionSetKey": "k",
             "bins": [{"band": "young", "min": None, "max": 29}, {"band": "old", "min": 30, "max": None}]},
        ]
    }  # fmt: skip
    records = effective_records({"records": [rec]}, {}, grouped)
    monkeypatch.chdir(tmp_path)
    pd.DataFrame({"cat": ["1", "2", "9"], "num": [12, 98, 99], "bin": [20, 30, 45]}).to_csv("A.csv", index=False)
    # The three recodes target the same CDE column, so each is run on its own.
    for src, expect in (
        ("cat", ["Current", "Never", None]),
        ("num", [12.0, 60.0, None]),
        ("bin", ["young", "old", "old"]),
    ):
        nb = build_notebook({"records": [{**records[0], "members": [f"A:{src}"]}]}, "py")
        ns: dict = {}
        for cell in nb["cells"]:
            if cell["cell_type"] == "code" and "harmonized" not in "".join(cell["source"]):
                exec("".join(cell["source"]), ns)  # noqa: S102 — the point is to run the generated code
        got = [None if pd.isna(v) else v for v in ns["h_A"]["T"]]
        assert got == expect, f"{src}: {got}"


def test_the_decision_log_matches_the_pinned_parity_fixture():
    """The Gate 4 preview (``frontend/src/lib/gate4.ts::decisionLogCsvRows``) re-derives the log on the client
    so it works in the backend-less build. Both implementations are pinned to the SAME literal rows, so the
    preview cannot drift from the file the download carries (the e2e twin is in ``gate4.spec.ts``)."""
    from pathlib import Path

    from backend.export_decisions import DECISION_LOG_COLS, decision_log_rows

    fixture = json.loads(
        (Path(__file__).parent.parent / "frontend/tests/e2e/fixtures/decision-log-parity.json").read_text("utf-8")
    )
    assert fixture["columns"] == DECISION_LOG_COLS
    assert decision_log_rows(fixture["result"], fixture["config"], fixture["grouped"]) == fixture["expectedRows"]
    kinds = {r[1] for r in fixture["expectedRows"]}
    assert {"gate1_scope_frozen", "gate1_rename", "gate1_regroup", "gate2_candidate_pick", "gate3_spec_edit"} <= kinds
    assert any(r[-1] == "true" for r in fixture["expectedRows"]), "the fixture must exercise a stale decision"
