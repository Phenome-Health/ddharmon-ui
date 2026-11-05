"""08-27b: a reviewer's Gate 2 pick (and GenCDE edit) drives the transform specs Gate 3 reviews.

The defect: Gate 2 persisted ``gate2_candidate_pick`` decisions, but nothing read them. ``resume_run`` threaded
no override into the Gate 2 -> Gate 3 leg, so specgen built every recode for the MODEL's CDE and Gate 3 then
showed the reviewer's pick as the target over specs generated for a different element.

The fix is backend-only (no core change): after the leg's own specgen, every group whose persisted pick
differs from the model's is re-targeted and its specs regenerated against the reviewer's target, through the
same core seams the run uses, before the Gate 3 checkpoint is written. Every case here runs the REAL
``run_pipeline`` with stubbed embeddings/clustering and injected stages — no provider, no key, no cost.
"""

from __future__ import annotations

import pytest
from ddharmon.clustering.topic_engine import collect_inputs
from ddharmon.models.cluster import FieldCluster, TopicModelResult
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.checkpoint import write_checkpoint
from tests.test_checkpoint import StubProvider


@pytest.fixture
def _one_cluster(monkeypatch):
    def fake_topic_model(embedded, **kwargs):
        docs, embeddings, field_refs, cohorts = collect_inputs(embedded)
        members = [r for r in field_refs if r.dictionary_name != "NIH_CDE"]
        return TopicModelResult(
            model=None,
            docs=docs,
            embeddings=embeddings,
            field_refs=field_refs,
            clusters=[FieldCluster(cluster_id=0, label="all", members=members)],
            outlier_cluster=None,
            all_cohort_names=cohorts,
        )

    monkeypatch.setattr("ddharmon.clustering.topic_engine.topic_model_dictionaries", fake_topic_model)


def _specs(tmp_path):
    a = tmp_path / "a.tsv"
    a.write_text("var\tdesc\tenc\nSMOKE_A\tCurrent smoking status\t1=Yes|0=No\n")
    b = tmp_path / "b.tsv"
    b.write_text("var\tdesc\tenc\nSMOKE_B\tDo you smoke cigarettes\tY=Yes|N=No\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\tdefinition\tpermissible_values\n"
        "SmokeCDE\tSmoking status\t1=Yes|0=No\n"
        "SmokeAltCDE\tTobacco use status\tC=Current|N=Never\n"
        "AgeCDE\tAge in years\t\n"
    )
    roles = {"variable_name": "var", "description": "desc", "value_encoding": "enc"}
    return (
        [
            {"path": str(a), "cohort_name": "CohortA", "column_roles": roles},
            {"path": str(b), "cohort_name": "CohortB", "column_roles": roles},
        ],
        {
            "path": str(cde),
            "cohort_name": "NIH_CDE",
            "column_roles": {
                "variable_name": "designation",
                "description": "definition",
                "value_encoding": "permissible_values",
            },
        },
    )


def _config(tmp_path, **extra):
    return {
        "run_mode": "batch",
        "cde_cohort": "NIH_CDE",
        "work_dir": str(tmp_path / "w"),
        "min_cluster_size": 2,
        "retrieval_floor": 0.0,
        "stop_at_gate": None,
        "park_at_gate": "gate3",
        **extra,
    }


class _Stages:
    """Injected stages. The model always takes candidate #1 (SmokeAltCDE on this fixture)."""

    def __init__(self, repick_answer=None):
        self.specgen: list = []
        self.repick: list = []
        self.repick_answer = repick_answer or (lambda p: {"code_map": {}, "confidence": 0.9})

    def as_dict(self):
        def specgen(prompts):
            self.specgen.extend(prompts)
            return {p.id: {"code_map": {}, "confidence": 0.9} for p in prompts}

        def repick(prompts):
            self.repick.extend(prompts)
            return {p.id: self.repick_answer(p) for p in prompts}

        return {
            "generate": lambda recs: {r.id: {"ideal_cde": "Smoking status"} for r in recs},
            "split": lambda recs: {},
            "classify": lambda recs: {r.id: {"verdict": "adopt", "cde_id": "1"} for r in recs},
            "gencde": lambda recs: {},
            "specgen": specgen,
            "specgen_repick": repick,
        }


def _run(tmp_path, picks=None, stages=None):
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec = _specs(tmp_path)
    stages = stages or _Stages()
    extra = {"gate2_picks": picks} if picks is not None else {}
    out = run_pipeline(
        dict_specs, cde_spec, _config(tmp_path, **extra), provider=StubProvider(), stage_overrides=stages.as_dict()
    )
    return out, stages


def _only_record(out):
    assert len(out["records"]) == 1, "fixture should produce exactly one concept group"
    return out["records"][0]


def _group_id(tmp_path):
    out, _ = _run(tmp_path)
    rec = _only_record(out)
    assert rec["cde"]["id"] == "SmokeAltCDE", "fixture drift: the model no longer picks SmokeAltCDE"
    return rec["groupId"]


# ── catalog re-pick ────────────────────────────────────────────────────────────────────────────


def test_a_catalog_repick_regenerates_the_specs_for_the_reviewers_cde(tmp_path, _one_cluster):
    """The core defect: Gate 3's target and the target its transforms were built for must be the same CDE."""
    gid = _group_id(tmp_path)

    def answer(p):  # map the SOURCE codes onto SmokeCDE's 1/0 codes
        if "Y=Yes" in p.user_prompt:
            return {"code_map": {"Y": "1", "N": "0"}, "confidence": 0.9}
        return {"code_map": {"1": "1", "0": "0"}, "confidence": 0.9}

    out, stages = _run(tmp_path, picks={gid: {"chosen": "SmokeCDE"}}, stages=_Stages(answer))
    rec = _only_record(out)

    assert rec["cde"]["id"] == "SmokeCDE", "the record still names the model's CDE"
    assert rec["transforms"], "the re-picked group has no specs at all"
    assert {t["targetCdeId"] for t in rec["transforms"]} == {"SmokeCDE"}, "specs still target the model's CDE"
    by_var = {t["sourceVariable"]: t for t in rec["transforms"]}
    assert by_var["CohortB:SMOKE_B"]["codeMap"] == {"Y": "1", "N": "0"}
    # The regeneration prompt showed the REVIEWER's CDE and its value set, not the model's.
    assert stages.repick and all("TARGET CDE: SmokeCDE" in p.user_prompt for p in stages.repick)
    assert all("1=Yes|0=No" in p.user_prompt for p in stages.repick)
    # The candidate list agrees with the record about which one is chosen.
    chosen = [c["cdeId"] for c in rec["candidates"] if c["isChosen"]]
    assert chosen == ["SmokeCDE"]
    assert rec["reviewerPick"]["kind"] == "catalog"
    assert rec["reviewerPick"]["target"] == "SmokeCDE"
    assert rec["reviewerPick"]["modelTarget"] == "SmokeAltCDE"
    assert rec["decidedBy"] == "reviewer"


def test_accepting_the_models_pick_regenerates_nothing(tmp_path, _one_cluster):
    """A pick that names the model's own CDE is a confirmation, not a change: no paid regeneration."""
    gid = _group_id(tmp_path)
    out, stages = _run(tmp_path, picks={gid: {"chosen": "SmokeAltCDE"}})
    rec = _only_record(out)

    assert stages.repick == [], "confirming the model's pick paid for a regeneration"
    assert rec["cde"]["id"] == "SmokeAltCDE"
    assert {t["targetCdeId"] for t in rec["transforms"]} == {"SmokeAltCDE"}
    assert "reviewerPick" not in rec


def test_a_pick_for_a_group_this_run_does_not_have_is_ignored(tmp_path, _one_cluster):
    _group_id(tmp_path)
    out, stages = _run(tmp_path, picks={"no-such-group#g9": {"chosen": "SmokeCDE"}})
    assert stages.repick == []
    assert _only_record(out)["cde"]["id"] == "SmokeAltCDE"


# ── GenCDE edit / own CDE ─────────────────────────────────────────────────────────────────────────


def test_a_gencde_edit_reaches_specgen_as_permissible_values(tmp_path, _one_cluster):
    """The reviewer's edited value list is the target domain the recode prompts are built against."""
    gid = _group_id(tmp_path)
    edit = {
        "name": "smoking_now",
        "definition": "Whether the participant currently smokes. Testing Testing",
        "units": "",
        "values": "C=Current smoker / N=Never smoked",
    }

    def answer(p):
        return {"code_map": {"Y": "C", "N": "N", "1": "C", "0": "N"}, "confidence": 0.9}

    out, stages = _run(tmp_path, picks={gid: {"chosen": "", "gencdeEdit": edit}}, stages=_Stages(answer))
    rec = _only_record(out)

    g = rec["gencde"]
    assert g is not None, "the reviewer's own CDE was not carried onto the record"
    assert g["preferredName"] == "smoking_now"
    assert g["definition"].endswith("Testing Testing"), "the edited definition never reached the result"
    assert g["permissibleValues"] == [
        {"code": "C", "label": "Current smoker"},
        {"code": "N", "label": "Never smoked"},
    ]
    assert rec["cde"] is None and rec["verdict"] == "novel"
    assert stages.repick and all("C=Current smoker|N=Never smoked" in p.user_prompt for p in stages.repick)
    assert {t["targetCdeId"] for t in rec["transforms"]} == {g["gencdeId"]}
    assert rec["reviewerPick"]["kind"] == "gencde"
    assert rec["reviewerPick"]["target"] == g["gencdeId"]


def test_none_of_these_with_no_generated_element_leaves_no_specs_and_says_why(tmp_path, _one_cluster):
    """``chosen: ""`` with nothing to fall back on: no target, so no specs — and a stated reason, not silence."""
    gid = _group_id(tmp_path)
    out, stages = _run(tmp_path, picks={gid: {"chosen": ""}})
    rec = _only_record(out)

    assert stages.repick == [], "there is no target to generate specs for, so nothing should be paid for"
    assert rec["transforms"] == []
    assert rec["cde"] is None
    assert rec["verdict"] == "novel"
    assert rec["reviewerPick"]["kind"] == "none"
    assert rec["reviewerPick"]["target"] == ""
    assert "none of these" in rec["reviewerPick"]["reason"].lower()


def test_parse_permissible_values_accepts_the_shapes_a_reviewer_types():
    from backend.engine.adapter import parse_permissible_values

    def pairs(text):
        return [(o.code, o.label) for o in parse_permissible_values(text)]

    assert pairs("1=Yes / 0=No") == [("1", "Yes"), ("0", "No")]  # what Gate 2 pre-fills
    assert pairs("1=Yes|0=No") == [("1", "Yes"), ("0", "No")]
    assert pairs("1 = Yes\n0 = No\n") == [("1", "Yes"), ("0", "No")]
    assert pairs("1=mg/dL high / 2=low") == [("1", "mg/dL high"), ("2", "low")], "a slash inside a label split"
    assert pairs("Yes / No") == [("Yes", "Yes"), ("No", "No")]  # labels only -> code = label
    assert pairs("  ") == []


# ── cost: the regeneration is paid work and must reach the realized cost ─────────────────────────


def test_the_regeneration_spend_is_in_the_realized_cost(tmp_path, _one_cluster, monkeypatch):
    """Sync mode with a fake client: the re-pick specgen is billed under its own ledger key."""
    from ddharmon.llm.cost import TokenUsage

    import backend.engine.llm as llm_mod
    from backend.engine.adapter import run_pipeline

    class FakeClient:
        def __init__(self):
            self.log = []

        def complete(self, prompt, *, system=None, max_tokens=512):
            self.log.append(TokenUsage("claude-sonnet-4-6", 1000, 500))  # $0.0105 per call
            return {"ideal_cde": "Smoking status", "verdict": "adopt", "cde_id": "1", "code_map": {}, "confidence": 0.9}

        def drain_usage(self):
            log, self.log = self.log, []
            return log

    monkeypatch.setattr(llm_mod, "build_llm_client", lambda *a, **k: FakeClient())
    dict_specs, cde_spec = _specs(tmp_path)
    base = _config(tmp_path, run_mode="sync")
    first = run_pipeline(dict_specs, cde_spec, base, provider=StubProvider())
    gid = _only_record(first)["groupId"]

    out = run_pipeline(
        dict_specs, cde_spec, {**base, "gate2_picks": {gid: {"chosen": "SmokeCDE"}}}, provider=StubProvider()
    )
    per = out["cost"]["perStage"]
    assert per["specs_repick"]["calls"] == 2, "each re-picked coded edge is one paid specgen call"
    assert abs(out["cost"]["actualUsd"] - (first["cost"]["actualUsd"] + per["specs_repick"]["usd"])) < 1e-9


def test_the_repick_batch_tag_is_reconcilable():
    """A batch-mode regeneration caches under its own tag; the reconcile map must route it to a stage."""
    from backend.batch_reconcile import TAG_TO_STAGE

    assert TAG_TO_STAGE.get("specgen_repick") == "specgen_repick"


# ── the resume wire: Gate 2 -> Gate 3 hands the persisted picks to the leg ───────────────────────


def _parked_at(tmp_path, monkeypatch, gate, job_id):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    seen: dict[str, object] = {}
    monkeypatch.setattr(app_module, "run_harmonization", lambda store, jid, ds, cs, config, **kw: seen.update(config))
    wd = tmp_path / "work" / job_id
    app_module.store.create(
        job_id,
        "Parked",
        {"work_dir": str(wd), "cde_set": "endorsed"},
        owner_subject=None,
        dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
    )
    groups = [{"groupId": "g1"}, {"groupId": "g2"}]
    write_checkpoint(
        wd, job_id=job_id, gate=gate, result={"records": [], "conceptGroups": groups}, responses={}, realized_cost=1.0
    )
    app_module.store.checkpoint(job_id, gate=gate, checkpoint_ref=f"{job_id}/checkpoint_{gate}.json", realized_cost=1.0)
    return seen


def _put_pick(c, job_id, payload):
    from backend.artifact_kinds import option_set_key

    alts = payload.get("alternatives", ["CDE:1", "CDE:2"])
    body = {"alternatives": alts, "optionSetKey": option_set_key(alts), **payload}
    r = c.put(f"/api/harmonize/jobs/{job_id}/artifacts/gate2_candidate_pick", json=body)
    assert r.status_code == 200, r.text


def test_resuming_from_gate_2_threads_the_persisted_picks_into_the_leg(tmp_path, monkeypatch):
    seen = _parked_at(tmp_path, monkeypatch, "gate2", "p2")
    edit = {"name": "mine", "definition": "d", "units": "", "values": "1=Yes / 0=No"}
    with TestClient(app_module.app) as c:
        _put_pick(c, "p2", {"groupId": "g1", "chosen": "CDE:2"})
        _put_pick(c, "p2", {"groupId": "g2", "chosen": "", "gencdeEdit": edit})
        r = c.post("/api/harmonize/resume/p2", headers={"x-anthropic-key": "sk-test"})
        assert r.status_code == 200, r.text

    assert seen["park_at_gate"] == "gate3"
    assert seen["gate2_picks"] == {
        "g1": {"chosen": "CDE:2", "gencdeEdit": None},
        "g2": {"chosen": "", "gencdeEdit": edit},
    }


def test_resuming_from_gate_1_carries_no_picks(tmp_path, monkeypatch):
    """Picks are Gate 2's output; the leg INTO Gate 2 must not read (stale) ones."""
    seen = _parked_at(tmp_path, monkeypatch, "gate1", "p1")
    with TestClient(app_module.app) as c:
        _put_pick(c, "p1", {"groupId": "g1", "chosen": "CDE:2"})
        r = c.post("/api/harmonize/resume/p1", headers={"x-anthropic-key": "sk-test"}, json={"gate1Scope": ["g1"]})
        assert r.status_code == 200, r.text
    assert "gate2_picks" not in seen


def test_resuming_drops_picks_on_groups_gate_1_scoped_out(tmp_path, monkeypatch):
    seen = _parked_at(tmp_path, monkeypatch, "gate2", "p3")
    job = app_module.store.get("p3")
    app_module.store.update("p3", config={**job.config, app_module.GATE1_SCOPE_CONFIG_KEY: ["g1"]})
    with TestClient(app_module.app) as c:
        _put_pick(c, "p3", {"groupId": "g1", "chosen": "CDE:2"})
        _put_pick(c, "p3", {"groupId": "g2", "chosen": "CDE:2"})
        assert c.post("/api/harmonize/resume/p3", headers={"x-anthropic-key": "sk-test"}).status_code == 200
    assert set(seen["gate2_picks"]) == {"g1"}, "a scoped-out group's pick would pay for specs nobody wanted"


# ── an EXISTING generated element, edited ──────────────────────────────────────────────────────────


def _novel_with_gencde(tmp_path):
    from types import SimpleNamespace

    from ddharmon.harmonization.models import GenCDE, LeanBRecord, TransformKind, TransformSpec
    from ddharmon.ingestion import load_dictionary
    from ddharmon.models.data_dictionary import ResponseOption

    dict_specs, _ = _specs(tmp_path)
    embedded = [
        SimpleNamespace(dictionary=load_dictionary(s["path"], cohort_name=s["cohort_name"], **s["column_roles"]))
        for s in dict_specs
    ]
    g = GenCDE(
        gencde_id="GENCDE:c0#g0",
        preferred_name="smoking_status",
        definition="Smokes",
        permissible_values=[ResponseOption("1", "Yes"), ResponseOption("0", "No")],
    )
    stale = TransformSpec(source_variable="CohortA:SMOKE_A", target_cde_id=g.gencde_id, kind=TransformKind.IDENTITY)
    rec = LeanBRecord(
        cluster_id="c0",
        group_id="c0#g0",
        verdict="novel",
        route="gencde_residual",
        member_variable_names=["CohortA:SMOKE_A", "CohortB:SMOKE_B"],
        cohorts=["CohortA", "CohortB"],
        gencde=g,
        transforms=[stale],
    )
    return rec, embedded


def test_an_edited_generated_element_is_the_target_its_recodes_are_rebuilt_against(tmp_path):
    from backend.engine.adapter import apply_reviewer_picks

    rec, embedded = _novel_with_gencde(tmp_path)
    asked: list = []

    def stage(prompts):
        asked.extend(prompts)
        return {p.id: {"code_map": {"1": "1", "0": "0", "Y": "1", "N": "0"}, "confidence": 0.9} for p in prompts}

    edit = {"name": "smoking_status", "definition": "Smokes", "units": "", "values": "1=Yes / 0=No / 9=Unknown"}
    changed = apply_reviewer_picks(
        [rec], {"c0#g0": {"chosen": "GENCDE:c0#g0", "gencdeEdit": edit}}, embedded, {}, model_tag=None, stage_fn=stage
    )

    assert changed == ["c0#g0"]
    assert [(o.code, o.label) for o in rec.gencde.permissible_values] == [("1", "Yes"), ("0", "No"), ("9", "Unknown")]
    assert asked and all("9=Unknown" in p.user_prompt for p in asked), "specgen never saw the edited values"
    assert all(p.id.startswith("leanb:repick:") for p in asked), "an edited target reused the stale prompt id"
    assert {t.target_cde_id for t in rec.transforms} == {"GENCDE:c0#g0"}
    assert all(t.kind != "identity" or t.code_map for t in rec.transforms), "the stale recode survived"
    assert rec.raw["reviewer_pick"]["kind"] == "gencde"


def test_an_unchanged_anchor_save_on_a_novel_group_costs_nothing(tmp_path):
    """Gate 2's Save writes every anchor field; re-saving the generated values verbatim is not an edit."""
    from backend.engine.adapter import apply_reviewer_picks

    rec, embedded = _novel_with_gencde(tmp_path)
    edit = {"name": "smoking_status", "definition": "Smokes", "units": "", "values": "1=Yes / 0=No"}

    def stage(prompts):
        raise AssertionError("an unchanged anchor paid for a regeneration")

    assert (
        apply_reviewer_picks(
            [rec], {"c0#g0": {"chosen": "", "gencdeEdit": edit}}, embedded, {}, model_tag=None, stage_fn=stage
        )
        == []
    )


# ── 08-28 1e: the record keeps the MODEL's pick once it is re-targeted (F17) ─────────────────────────
#
# After the re-pick the record's own ``cde`` / candidates / verdict / ``gencde`` describe the REVIEWER's
# target, so an export reading them for "what the model chose" reported the pick as the model's own
# (targetPickedBy=model, modelCde = the pick, a log row reading "X -> X"). The adapter therefore stamps the
# model's pick on ``reviewerPick`` before it overwrites anything, and every downstream reader uses the stamp.


def test_a_catalog_repick_stamps_the_models_cde_and_verdict(tmp_path, _one_cluster):
    model_rec = _only_record(_run(tmp_path)[0])
    out, _ = _run(tmp_path, picks={model_rec["groupId"]: {"chosen": "SmokeCDE"}})
    pick = _only_record(out)["reviewerPick"]

    assert pick["modelCde"] == {"id": "SmokeAltCDE", "externalId": model_rec["cde"]["externalId"]}
    assert pick["modelVerdict"] == model_rec["verdict"]
    assert pick["modelGencde"] is None, "the model had no generated element on this group"


def test_an_edited_generated_element_stamps_the_models_unedited_one(tmp_path):
    from backend.engine.adapter import apply_reviewer_picks

    rec, embedded = _novel_with_gencde(tmp_path)

    def stage(prompts):
        return {p.id: {"code_map": {"1": "1", "0": "0"}, "confidence": 0.9} for p in prompts}

    edit = {"name": "smoking_status", "definition": "Smokes", "units": "", "values": "E1=Yes / E0=No"}
    apply_reviewer_picks(
        [rec], {"c0#g0": {"chosen": "", "gencdeEdit": edit}}, embedded, {}, model_tag=None, stage_fn=stage
    )
    pick = rec.raw["reviewer_pick"]

    assert pick["modelCde"] is None, "the model picked no catalog CDE for a novel group"
    assert pick["modelVerdict"] == "novel"
    assert pick["modelGencde"]["gencdeId"] == "GENCDE:c0#g0"
    assert [(v["code"], v["label"]) for v in pick["modelGencde"]["permissibleValues"]] == [("1", "Yes"), ("0", "No")]
    # ...while the record itself now carries the EDITED element.
    assert [o.code for o in rec.gencde.permissible_values] == ["E1", "E0"]


def test_a_novel_group_repicked_to_a_catalog_cde_keeps_the_models_generated_element(tmp_path):
    from backend.engine.adapter import apply_reviewer_picks

    rec, embedded = _novel_with_gencde(tmp_path)
    apply_reviewer_picks(
        [rec], {"c0#g0": {"chosen": "SmokeCDE"}}, embedded, {}, model_tag=None, stage_fn=lambda prompts: {}
    )
    pick = rec.raw["reviewer_pick"]

    assert rec.gencde is None and rec.cde_id == "SmokeCDE"
    assert pick["modelTarget"] == "GENCDE:c0#g0"
    assert pick["modelCde"] is None and pick["modelVerdict"] == "novel"
    assert pick["modelGencde"]["gencdeId"] == "GENCDE:c0#g0"
