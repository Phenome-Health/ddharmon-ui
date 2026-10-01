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

        def park(
            gate: str = "gate4", *, job_id: str = "st", config: dict | None = None, result: dict | None = None
        ) -> str:
            wd = tmp_path / "work" / job_id
            app_module.store.create(
                job_id,
                "Staged run",
                {"work_dir": str(wd), "cde_set": "endorsed", **(config or {})},
                owner_subject=None,
                dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
            )
            write_checkpoint(
                wd, job_id=job_id, gate="gate3", result=result or _result(), responses={}, realized_cost=5.0
            )
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


def _put(client, job_id: str, kind: str, payload: dict, subject: str | None = None) -> None:
    """Seed a decision AS IF it was made at its own gate.

    Written straight to the artifact store, not through the route: the fixture parks the run at Gate 3/4 first,
    and the server now refuses writes to gates a run has passed (08-27 audit B4) — which is exactly right in
    production, where each decision was made while its gate was open.
    """
    from backend.jobs import principal_of

    alternatives = payload.pop("alternatives", [payload["chosen"]])
    body = {**payload, "alternatives": alternatives, "optionSetKey": option_set_key(alternatives)}
    job = app_module.store.get(job_id)
    app_module.store.artifacts.put(
        owner=principal_of(subject, job), job_id=job_id, kind=kind, payload=body, pinned=False
    )


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
    _put(
        client,
        job_id,
        "gate1_rename",
        {"groupId": "c0#g0", "chosen": "Participant age", "alternatives": ["Age in years", "Participant age"]},
        subject="user_A",
    )

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
    assert {"gate1_scope_frozen", "gate1_rename", "gate1_regroup", "gate2_candidate_pick", "gate3_spec_edit",
            "gate3_member_exclusion"} <= kinds  # fmt: skip
    assert any(r[-1] == "true" for r in fixture["expectedRows"]), "the fixture must exercise a stale decision"


def _exported_projection(records: list[dict]) -> list[dict]:
    """What the client mirror must agree on — the fields Gate 4's Sankey and previews read (``gate4.spec.ts`` twin)."""
    return [
        {
            "groupId": r["groupId"],
            "concept": r["concept"],
            "verdict": r["verdict"],
            "cdeId": (r.get("cde") or {}).get("id"),
            "cohorts": r["cohorts"],
            "members": r["members"],
            "nMembers": r.get("nMembers"),
            "crossCohort": r.get("crossCohort"),
            "removedMembers": r.get("removedMembers"),
            "memberDetailIds": [d.get("id") for d in r.get("memberDetails") or []],
            "transforms": [
                {"sourceVariable": t.get("sourceVariable"), "rejected": bool(t.get("rejected"))}
                for t in r.get("transforms") or []
            ],
            "gencdeSources": (r.get("gencde") or {}).get("sourceVariables"),
            "gencdeCohorts": (r.get("gencde") or {}).get("sourceCohorts"),
        }
        for r in records
    ]


def test_the_exported_records_match_the_pinned_parity_fixture():
    """Gate 4's Sankey and previews (final review round 2) read the records the EXPORT carries, re-derived on the
    client (``frontend/src/lib/gate4.ts::exportedRecords``) so they work in the backend-less build. Both sides are
    pinned to the same literal projection of :func:`effective_records`, so neither can drift from the files (the e2e
    twin is in ``gate4.spec.ts``)."""
    from pathlib import Path

    from backend.export_decisions import effective_records

    here = Path(__file__).parent.parent / "frontend/tests/e2e/fixtures"
    parity = json.loads((here / "decision-log-parity.json").read_text("utf-8"))
    fixture = json.loads((here / "exported-records-parity.json").read_text("utf-8"))
    assert fixture["source"] == "decision-log-parity.json"
    for case in fixture["cases"]:
        result = case.get("result") or parity["result"]
        config = parity["config"] if case.get("useParityDecisions") else case["config"]
        grouped = parity["grouped"] if case.get("useParityDecisions") else case["grouped"]
        assert _exported_projection(effective_records(result, config, grouped)) == case["expected"], case["name"]
    # The cases exercise every rule the client mirrors: a frozen scope, an explicit "out", an export exclude, a
    # Gate 3 removal (incl. a generated element's sources), an unapplied pick, "none of these", a rejected recode.
    expected = [c["expected"] for c in fixture["cases"]]
    names = [[r["groupId"] for r in e] for e in expected]
    assert "c2#g0" not in names[0] and "c1#g0" not in names[1] and "c3#g0" not in names[1]
    removed = [m for e in expected for r in e for m in r["removedMembers"]]
    assert {"B:smk", "B:age_yrs", "A:smoke", "B:hair_c"} <= set(removed)
    assert any(t["rejected"] for e in expected for r in e for t in r["transforms"])
    assert expected[3][0]["gencdeSources"] == ["A:hair"]


# --- 08-28 1e: provenance & the decision log ---------------------------------------------------------------
#
# The walk of run 6c66731c (08-LIVE-VERIFY-3 F17) found that once the Gate 2 -> 3 leg APPLIES a pick (the
# adapter re-targets the record and regenerates its specs), the record's own cde / candidates / verdict say
# the PICK — so the TSV read targetPickedBy=model with modelCdeId = the pick, and the log read
# "Disabilities -> Disabilities". The model's pick survives only on ``reviewerPick`` (stamped by the adapter,
# ``tests/test_gate2_picks.py``), and these pin every reader to it.

_PV_ORIG = [{"code": "1", "label": "Yes"}, {"code": "0", "label": "No"}]
_PV_EDIT = [{"code": "E1", "label": "Yes"}, {"code": "E0", "label": "No"}]


def _applied_result() -> dict:
    """A Gate 3/4 checkpoint AFTER the adapter applied three Gate 2 picks (the shapes ``apply_reviewer_picks``
    writes): c0 catalog -> catalog, c2 novel with its GenCDE edited, c3 novel -> a catalog CDE."""
    age = _record(
        "c0#g0",
        "Age in years",
        "adopt",
        {"id": "AgeAtVisitCDE", "externalId": "tiny-visit"},
        ["A:age", "B:age_yrs"],
        candidates=[_cand(1, "AgeCDE", "tiny-age", False), _cand(2, "AgeAtVisitCDE", "tiny-visit", True)],
        transforms=[_transform("A:age", "AgeAtVisitCDE", {"1": "1"})],
    )
    age["reviewerPick"] = {
        "chosen": "AgeAtVisitCDE", "kind": "catalog", "target": "AgeAtVisitCDE", "modelTarget": "AgeCDE",
        "reason": "", "modelCde": {"id": "AgeCDE", "externalId": "tiny-age"}, "modelVerdict": "adopt",
        "modelGencde": None,
    }  # fmt: skip
    hair = _record(
        "c2#g0",
        "Hair colour",
        "novel",
        None,
        ["A:hair"],
        gencde={"isGenerated": True, "gencdeId": "GEN:hair", "preferredName": "Hair colour", "permissibleValues": _PV_EDIT},
        transforms=[_transform("A:hair", "GEN:hair", {"1": "E1", "0": "E0"})],
    )  # fmt: skip
    hair["reviewerPick"] = {
        "chosen": "", "kind": "gencde", "target": "GEN:hair", "modelTarget": "GEN:hair", "reason": "",
        "modelCde": None, "modelVerdict": "novel",
        "modelGencde": {"gencdeId": "GEN:hair", "preferredName": "Hair colour", "permissibleValues": _PV_ORIG},
    }  # fmt: skip
    dm = _record(
        "c3#g0",
        "Diabetes",
        "adopt",
        {"id": "DiabetesCDE", "externalId": "tiny-dm"},
        ["A:dm"],
        candidates=[_cand(1, "DiabetesCDE", "tiny-dm", True)],
        transforms=[_transform("A:dm", "DiabetesCDE", {"1": "Yes"})],
    )
    dm["reviewerPick"] = {
        "chosen": "DiabetesCDE", "kind": "catalog", "target": "DiabetesCDE", "modelTarget": "GENCDE:c3#g0",
        "reason": "", "modelCde": None, "modelVerdict": "novel",
        "modelGencde": {"gencdeId": "GENCDE:c3#g0", "preferredName": "diabetes_ind", "permissibleValues": _PV_ORIG},
    }  # fmt: skip
    base = _result()
    return {**base, "records": [age, base["records"][1], hair, dm]}


_EDIT = {"name": "Hair colour", "definition": "", "units": "", "values": "E1=Yes / E0=No"}


def _put_applied_picks(client, job_id: str) -> None:
    _put(client, job_id, "gate2_candidate_pick", {"groupId": "c0#g0", "chosen": "AgeAtVisitCDE"})
    _put(client, job_id, "gate2_candidate_pick", {"groupId": "c2#g0", "chosen": "", "gencdeEdit": dict(_EDIT)})
    _put(client, job_id, "gate2_candidate_pick", {"groupId": "c3#g0", "chosen": "DiabetesCDE"})


def test_an_applied_repick_exports_the_reviewer_as_the_picker_and_the_models_pick_alongside(parked):
    client, park = parked
    job_id = park("gate4", result=_applied_result())
    _put_applied_picks(client, job_id)

    rows = {r["recordId"]: r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t")}
    assert rows["c0#g0"]["cdeId"] == "AgeAtVisitCDE"
    assert rows["c0#g0"]["targetPickedBy"] == "reviewer", "an applied re-pick exported as the model's own pick"
    assert rows["c0#g0"]["modelCdeId"] == "AgeCDE", "modelCdeId reported the reviewer's pick as the model's"
    assert rows["c0#g0"]["modelVerdict"] == "adopt"
    assert rows["c3#g0"]["targetPickedBy"] == "reviewer" and rows["c3#g0"]["modelCdeId"] == ""
    assert rows["c3#g0"]["modelVerdict"] == "novel" and rows["c3#g0"]["verdict"] == "adopt"
    assert rows["c2#g0"]["targetPickedBy"] == "reviewer" and rows["c2#g0"]["modelVerdict"] == "novel"
    assert rows["c1#g0"]["targetPickedBy"] == "model" and rows["c1#g0"]["modelVerdict"] == "refine"

    recs = {r["id"]: r for r in _export(client, job_id, "records_json").json()}
    assert recs["c0#g0"]["modelCde"] == {"id": "AgeCDE", "externalId": "tiny-age"}
    assert recs["c3#g0"]["modelCde"] is None
    assert recs["c3#g0"]["modelGencde"]["gencdeId"] == "GENCDE:c3#g0"
    assert recs["c2#g0"]["modelGencde"]["permissibleValues"] == _PV_ORIG, "the model's UNEDITED element is kept"
    assert recs["c2#g0"]["gencde"]["permissibleValues"] == _PV_EDIT
    # The specs were REGENERATED for the pick, so they are trustworthy on it: not flagged, and applied.
    assert not any(t.get("targetRepicked") for r in recs.values() for t in r["transforms"])
    code = _notebook_code(client, job_id)
    assert "REVIEW REQUIRED: target re-picked" not in code
    assert 'h_A["AgeAtVisitCDE"]' in code and '# h_A["AgeAtVisitCDE"]' not in code


def test_a_pre_0828_reviewer_pick_still_reads_the_model_from_model_target(parked):
    """A checkpoint written before the stamp carries only ``modelTarget``: the model's CdeRef is recovered from
    the candidate list, never from the record's (re-targeted) ``cde``."""
    client, park = parked
    result = _applied_result()
    for r in result["records"]:
        for k in ("modelCde", "modelVerdict", "modelGencde"):
            (r.get("reviewerPick") or {}).pop(k, None)
    job_id = park("gate4", result=result)
    _put_applied_picks(client, job_id)

    rows = {r["recordId"]: r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t")}
    assert rows["c0#g0"]["targetPickedBy"] == "reviewer" and rows["c0#g0"]["modelCdeId"] == "AgeCDE"
    rec = next(r for r in _export(client, job_id, "records_json").json() if r["id"] == "c0#g0")
    assert rec["modelCde"] == {"id": "AgeCDE", "externalId": "tiny-age"}


def test_the_decision_log_reads_an_applied_repick_as_a_change_from_the_models_pick():
    """F17: "Disabilities -> Disabilities" and "none of these -> none of these" read as no-ops."""
    from backend.export_decisions import decision_log_rows

    grouped = {
        "gate2_candidate_pick": [
            {"groupId": "c0#g0", "chosen": "AgeAtVisitCDE", "alternatives": [], "optionSetKey": "k"},
            {"groupId": "c2#g0", "chosen": "", "gencdeEdit": dict(_EDIT), "alternatives": [], "optionSetKey": "k"},
            {"groupId": "c3#g0", "chosen": "DiabetesCDE", "alternatives": [], "optionSetKey": "k"},
        ]
    }
    by = {r[3]: r for r in decision_log_rows(_applied_result(), {}, grouped) if r[1] == "gate2_candidate_pick"}
    assert (by["c0#g0"][4], by["c0#g0"][5]) == ("AgeCDE", "AgeAtVisitCDE")
    assert (by["c3#g0"][4], by["c3#g0"][5]) == ("GENCDE:c3#g0", "DiabetesCDE")
    assert (by["c2#g0"][4], by["c2#g0"][5]) == ("GEN:hair", "GEN:hair (edited)")
    assert json.loads(by["c2#g0"][7])["gencdeEdit"]["values"] == "E1=Yes / E0=No"


def test_a_pick_on_a_group_the_run_does_not_have_is_logged_as_not_applied():
    """F7 (second half): a Gate 2 pick on a group absent from the results was listed as if it took effect."""
    from backend.export_decisions import decision_log_rows

    grouped = {"gate2_candidate_pick": [{"groupId": "zz#g9", "chosen": "AgeCDE", "alternatives": [], "optionSetKey": "k"}]}  # fmt: skip
    (row,) = [r for r in decision_log_rows(_result(), {}, grouped) if r[1] == "gate2_candidate_pick"]
    assert row[5] == "AgeCDE"
    assert "notApplied" in json.loads(row[7])


def _spec(sv: str, **extra) -> dict:
    return {"sourceVariable": sv, "chosen": sv, "alternatives": [sv], "optionSetKey": "k", **extra}


def test_a_gate3_row_is_annotated_only_when_it_carries_a_note():
    """F7: an empty save (note "", no edit) was logged "annotated"; it is the model's spec standing."""
    from backend.export_decisions import decision_log_rows

    grouped = {"gate3_spec_edit": [_spec("A:smoke", note=""), _spec("B:smk", note="  checked  ")]}
    by = {r[3]: r for r in decision_log_rows(_result(), {}, grouped)}
    assert by["A:smoke"][5] == "reverted to model spec"
    assert by["B:smk"][5] == "annotated"


def test_a_mapping_edit_logs_a_per_code_diff_against_the_models_map_in_target_codes():
    """Q3: the log's detail names each code whose TARGET code changed, ``-121: 9 -> missing``, in code order."""
    from backend.export_decisions import decision_log_rows

    rec = _record(
        "c9#g0", "Migraine", "novel", None, ["U:mig"],
        transforms=[_transform("U:mig", "GEN:mig", {"1": "1", "0": "0", "-121": "9", "10": "1"})],
    )  # fmt: skip
    edit = _spec("U:mig", mapping={"1": "1", "0": "0", "-121": "__missing__", "-818": "9", "10": "0"})
    (row,) = decision_log_rows({"records": [rec]}, {}, {"gate3_spec_edit": [edit]})
    assert row[5] == "edited"
    assert row[7] == "-818: missing → 9; -121: 9 → missing; 10: 1 → 0"


def test_an_unchanged_mapping_save_says_so_and_other_edit_shapes_stay_json():
    from backend.export_decisions import decision_log_rows

    rec = _record(
        "c9#g0", "x", "adopt", {"id": "T", "externalId": ""}, ["A:v", "A:n"],
        transforms=[_transform("A:v", "T", {"1": "1"}), _transform("A:n", "T", {})],
    )  # fmt: skip
    grouped = {
        "gate3_spec_edit": [
            _spec("A:v", mapping={"1": "1"}),
            _spec("A:n", numberMap={"98": {"action": "missing", "value": None}}),
        ]
    }
    by = {r[3]: r for r in decision_log_rows({"records": [rec]}, {}, grouped)}
    assert by["A:v"][7] == "no code changed"
    assert by["A:n"][7] == '{"numberMap":{"98":{"action":"missing","value":null}}}'


def test_a_score_declaration_is_one_log_row_per_score_not_one_per_component():
    """H9: 48 "Declared a score component -> none of these" rows read like 48 rejections."""
    from backend.export_decisions import decision_log_rows

    def comp(score: str, name: str, chosen: str = "") -> dict:
        return {"scoreName": score, "componentName": name, "chosen": chosen, "alternatives": [], "optionSetKey": "k"}

    grouped = {
        "composite_swap": [
            comp("Frailty", "grip"),
            comp("Frailty", "gait", "c1#g0"),
            comp("Frailty", "weight loss"),
            comp("PHQ", "mood"),
        ]
    }
    rows = [r for r in decision_log_rows(_result(), {}, grouped) if r[1] == "composite_swap"]
    assert [r[3] for r in rows] == ["Frailty", "PHQ"]
    frailty = rows[0]
    assert frailty[0] == "Composite" and frailty[2] == "Declared a score"
    assert frailty[5] == "3 components, 1 matched"
    assert json.loads(frailty[7]) == {"components": ["grip", "gait", "weight loss"], "matched": {"gait": "c1#g0"}}
    assert rows[1][5] == "1 component" and json.loads(rows[1][7]) == {"components": ["mood"]}


# --- 08-28 3f: the Gate 2 relation (SKOS predicate + note) reaches every export ----------------------------
#
# ``gate2_relation`` was a registered kind no screen wrote and no export read. A relation is a claim about ONE
# (group, target) edge: the export carries the one on the group's EFFECTIVE target (the reviewer's pick, else
# the model's), who asserted it, and the model's own relation beside it so the override never erases it.

_REL = "gate2_relation"
_SKOS = [
    "skos:exactMatch",
    "skos:closeMatch",
    "skos:narrowMatch",
    "skos:broadMatch",
    "skos:relatedMatch",
]


def _relation(group: str, target: str, chosen: str, **extra) -> dict:
    return {"groupId": group, "targetId": target, "chosen": chosen, "alternatives": list(_SKOS), **extra}


def _refined_result() -> dict:
    """``_result()`` with the refine group carrying core's derived element — the one place core STAMPS a relation."""
    res = _result()
    res["records"][1]["gencde"] = {
        "isGenerated": True,
        "gencdeId": "GEN:smoke",
        "preferredName": "Current smoking status",
        "parentCdeId": "SmokeCDE",
        "relation": "skos:narrowMatch",
    }
    return res


def _records(client, job_id: str) -> dict[str, dict]:
    return {r["id"]: r for r in _export(client, job_id, "records_json").json()}


def test_the_reviewers_relation_exports_over_the_models_with_the_models_alongside(parked):
    client, park = parked
    job_id = park("gate4", result=_refined_result())
    _put(client, job_id, _REL, _relation("c0#g0", "AgeCDE", "skos:closeMatch", note="age at consent, not at visit"))

    recs = _records(client, job_id)
    assert recs["c0#g0"]["relation"] == "skos:closeMatch" and recs["c0#g0"]["relationBy"] == "reviewer"
    assert recs["c0#g0"]["modelRelation"] == "skos:exactMatch", "an adopt is the element taken as-is"
    assert recs["c0#g0"]["relationNote"] == "age at consent, not at visit"
    # Untouched: the relation core stamped on the refinement, and said to be the model's.
    assert (recs["c1#g0"]["relation"], recs["c1#g0"]["relationBy"]) == ("skos:narrowMatch", "model")
    assert recs["c1#g0"]["modelRelation"] == "skos:narrowMatch"
    # A novel's own element: nobody asserted a relation, and the export does not invent one.
    assert (recs["c2#g0"]["relation"], recs["c2#g0"]["relationBy"], recs["c2#g0"]["modelRelation"]) == ("", "", "")

    rows = {r["recordId"]: r for r in _rows(_export(client, job_id, "eitl_tsv").text, "\t")}
    c0 = rows["c0#g0"]
    assert (c0["relation"], c0["relationBy"], c0["modelRelation"]) == ("skos:closeMatch", "reviewer", "skos:exactMatch")
    assert c0["relationNote"] == "age at consent, not at visit"
    assert rows["c1#g0"]["relationBy"] == "model" and rows["c1#g0"]["relationNote"] == ""
    header = _export(client, job_id, "eitl_tsv").text.splitlines()[0].split("\t")
    # Appended after combineRules, so no index moves; review round 2's removedMembers was appended after them.
    relation_at = header.index("combineRules") + 1
    assert header[relation_at : relation_at + 4] == ["relation", "relationBy", "modelRelation", "relationNote"]
    assert header[relation_at + 4 :] == ["removedMembers"], "appended, so no index moves"


def test_a_relation_follows_the_target_it_was_set_on(parked):
    """After a re-pick the relation set on the OLD target does not describe the new one — and the model never judged
    the new one, so it has no model relation either. One set on the new target is what exports."""
    client, park = parked
    job_id = park("gate4")
    _put(client, job_id, _REL, _relation("c0#g0", "AgeCDE", "skos:closeMatch", note="on the old target"))
    _put(
        client,
        job_id,
        "gate2_candidate_pick",
        {"groupId": "c0#g0", "chosen": "AgeAtVisitCDE", "alternatives": ["AgeCDE", "AgeAtVisitCDE"]},
    )
    rec = _records(client, job_id)["c0#g0"]
    assert rec["cde"]["id"] == "AgeAtVisitCDE"
    assert (rec["relation"], rec["relationBy"], rec["relationNote"]) == ("", "", "")
    assert rec["modelRelation"] == "skos:exactMatch", "the model's relation is to ITS target, kept discoverable"

    _put(client, job_id, _REL, _relation("c0#g0", "AgeAtVisitCDE", "skos:broadMatch"))
    rec = _records(client, job_id)["c0#g0"]
    assert (rec["relation"], rec["relationBy"]) == ("skos:broadMatch", "reviewer")


def test_a_note_with_no_relation_asserted_keeps_the_models_relation(parked):
    """``chosen: ""`` is a note, not a relation — it must not blank the model's predicate or claim the reviewer's."""
    client, park = parked
    job_id = park("gate4")
    _put(client, job_id, _REL, _relation("c0#g0", "AgeCDE", "", note="unsure between exact and close"))
    rec = _records(client, job_id)["c0#g0"]
    assert (rec["relation"], rec["relationBy"]) == ("skos:exactMatch", "model")
    assert rec["relationNote"] == "unsure between exact and close"


def test_a_note_on_the_groups_own_element_exports_under_either_of_its_ids(parked):
    """The group's own element is one target however it is named: its GenCDE id, or ``own`` when the reviewer
    authored one on a concept core generated nothing for (the pick's ``chosen`` is then "")."""
    client, park = parked
    job_id = park("gate4")
    _put(client, job_id, _REL, _relation("c2#g0", "GEN:hair", "", note="definition checked with the PI"))
    _put(client, job_id, "gate2_candidate_pick", {"groupId": "c0#g0", "chosen": "", "alternatives": ["AgeCDE"]})
    _put(client, job_id, _REL, _relation("c0#g0", "own", "", note="no catalog age fits this cohort"))
    recs = _records(client, job_id)
    assert recs["c2#g0"]["relationNote"] == "definition checked with the PI" and recs["c2#g0"]["relation"] == ""
    assert recs["c0#g0"]["cde"] is None and recs["c0#g0"]["relationNote"] == "no catalog age fits this cohort"
    assert recs["c0#g0"]["relation"] == "" and recs["c0#g0"]["modelRelation"] == "skos:exactMatch"


def test_an_applied_repick_reads_the_models_relation_from_the_stamp(parked):
    """Once the Gate 2 -> 3 leg re-targets a record, its own verdict / cde say the PICK (F17). The model's relation
    is read from the ``reviewerPick`` stamp — an adopt of AgeCDE stays exact to AgeCDE, a novel stays none."""
    client, park = parked
    job_id = park("gate4", result=_applied_result())
    _put_applied_picks(client, job_id)
    _put(client, job_id, _REL, _relation("c3#g0", "DiabetesCDE", "skos:narrowMatch"))
    recs = _records(client, job_id)
    assert recs["c0#g0"]["modelRelation"] == "skos:exactMatch"
    assert (recs["c0#g0"]["relation"], recs["c0#g0"]["relationBy"]) == ("", ""), "AgeAtVisitCDE was never judged"
    assert recs["c3#g0"]["modelRelation"] == "", "the model's target was its own generated element"
    assert (recs["c3#g0"]["relation"], recs["c3#g0"]["relationBy"]) == ("skos:narrowMatch", "reviewer")


def _rel_rows(result: dict, grouped: dict) -> dict[str, list[str]]:
    from backend.export_decisions import decision_log_rows

    return {r[3]: r for r in decision_log_rows(result, {}, grouped) if r[1] == _REL}


def _logged(chosen: str, group: str, target: str, **extra) -> dict:
    return {**_relation(group, target, chosen, **extra), "optionSetKey": option_set_key(_SKOS)}


def test_the_decision_log_reads_a_relation_as_the_models_then_the_reviewers():
    """``before`` is the model's relation for that edge ("" where it implied none), ``after`` the reviewer's, the note
    in ``note`` — and a note with no relation reads as exactly that, never as "none of these"."""
    grouped = {
        _REL: [
            _logged("skos:closeMatch", "c0#g0", "AgeCDE", note="consent age"),
            _logged("", "c1#g0", "SmokeCDE", note="unsure"),
            _logged("", "c2#g0", "GEN:hair", note="definition checked"),
        ]
    }
    by = _rel_rows(_refined_result(), grouped)
    age = by["c0#g0|AgeCDE"]
    assert age[:3] == ["Gate 2", _REL, "Set a relation"]
    assert (age[4], age[5], age[6], age[7]) == ("skos:exactMatch", "skos:closeMatch", "consent age", "")
    smoke = by["c1#g0|SmokeCDE"]
    assert (smoke[4], smoke[5], smoke[6]) == ("skos:narrowMatch", "no relation asserted", "unsure")
    hair = by["c2#g0|GEN:hair"]
    assert (hair[4], hair[5], hair[7]) == ("", "no relation asserted", ""), "the own element is the current target"


def test_a_relation_that_reaches_no_record_is_logged_as_not_applied():
    """F7's rule for picks, applied to relations: a row that took effect nowhere says so — the group is absent, or the
    edge is not the target the group takes (the reviewer re-picked after setting it)."""
    grouped = {
        _REL: [
            _logged("skos:closeMatch", "c0#g0", "AgeCDE"),
            _logged("skos:broadMatch", "c0#g0", "AgeAtVisitCDE"),
            _logged("skos:exactMatch", "zz#g9", "AgeCDE"),
        ],
        "gate2_candidate_pick": [
            {"groupId": "c0#g0", "chosen": "AgeAtVisitCDE", "alternatives": ["AgeCDE", "AgeAtVisitCDE"], "optionSetKey": "k"}
        ],
    }  # fmt: skip
    by = _rel_rows(_result(), grouped)
    assert json.loads(by["c0#g0|AgeCDE"][7]) == {"notApplied": "not this group's current target"}
    assert by["c0#g0|AgeCDE"][4] == "skos:exactMatch", "the model's relation to its own target is still the before"
    assert (by["c0#g0|AgeAtVisitCDE"][4], by["c0#g0|AgeAtVisitCDE"][7]) == ("", ""), "the pick: applied, never judged"
    assert json.loads(by["zz#g9|AgeCDE"][7]) == {"notApplied": "no record for this group in the run's results"}
