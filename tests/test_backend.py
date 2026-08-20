"""Tests for the ddharmon GUI backend (backend/) — split-aware contract.

Covers: /detect role suggestion, /health, the in-memory JobStore, the contract mapping
(``_record_to_ui`` / ``build_ui_result`` — the single churn-absorbing surface), the full HTTP flow with a
fake runner (canned UIResult), and a deterministic end-to-end ``run_pipeline`` with the three leanb LLM
stages mocked + BERTopic and embeddings monkeypatched (no model download / API key / network).
"""

from __future__ import annotations

import csv
import io
import json
import time

import numpy as np
import pytest
from ddharmon.clustering.topic_engine import collect_inputs
from ddharmon.embedding.provider import EmbeddingProvider
from ddharmon.harmonization.leanb import LeanBResult
from ddharmon.harmonization.models import CandidateCDE, LeanBRecord, TransformKind, TransformSpec
from ddharmon.models.cluster import FieldCluster, TopicModelResult
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.db import JobDB
from backend.demos import demo_job_id, seed_demos
from backend.engine import contract as contract_module
from backend.engine.adapter import build_ui_result, run_pipeline
from backend.jobs import Job, JobStore

client = TestClient(app_module.app)
DIM = 32


class StubProvider(EmbeddingProvider):
    """Deterministic hash-based embeddings — no model download."""

    @property
    def model_name(self) -> str:
        return "stub-ui"

    @property
    def dimension(self) -> int:
        return DIM

    def embed(self, texts: list[str]) -> np.ndarray:
        import hashlib

        out = np.zeros((len(texts), DIM), dtype=np.float32)
        for i, t in enumerate(texts):
            seed = int(hashlib.sha256(t.encode()).hexdigest()[:8], 16)
            v = np.random.default_rng(seed).standard_normal(DIM).astype(np.float32)
            out[i] = v / (np.linalg.norm(v) or 1.0)
        return out


# ── /detect ────────────────────────────────────────────────────


def test_detect_suggests_roles():
    resp = client.post("/api/harmonize/detect", json={"columns": ["Column Name", "Description", "answer_options"]})
    assert resp.status_code == 200
    roles = resp.json()["columnRoles"]
    assert roles.get("variable_name") == "Column Name"
    assert roles.get("description") == "Description"


# ── health ─────────────────────────────────────────────────────


def test_health_ok():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["contractVersion"] == "5"
    assert set(body["cde"]) == {"endorsed", "full"}
    assert "frontendBuilt" in body


# ── JobStore ───────────────────────────────────────────────────


def test_jobstore_lifecycle():
    s = JobStore()
    s.create("j1", "Run 1", {"run_mode": "batch"})
    assert s.get("j1").status == "pending"
    s.update("j1", status="generating", phase="generating", completed=3, total=10)
    assert s.get("j1").completed == 3
    assert s.set_decision("j1", "c1#g0", "approve", "looks good")
    assert s.get("j1").decisions["c1#g0"]["decision"] == "approve"
    assert [j.job_id for j in s.list()] == ["j1"]
    assert s.delete("j1") is True
    assert s.get("j1") is None


def test_jobstore_stamps_phase_start_timings():
    """Each first entry into a phase is timestamped (for the run view's elapsed/ETA + stage timeline); a later
    tick in the same phase does NOT reset it, the terminal phase is stamped, and it surfaces as phaseStartedAt."""
    s = JobStore()
    s.create("jt", "Timed run", {"run_mode": "batch"})
    assert s.get("jt").phase_timings == {}  # create() doesn't stamp "pending"
    s.update("jt", status="embedding", phase="embedding", completed=0, total=100)
    first = s.get("jt").phase_timings["embedding"]
    s.update("jt", status="embedding", phase="embedding", completed=50, total=100)  # later tick, same phase
    assert s.get("jt").phase_timings["embedding"] == first  # kept the START time, not reset
    s.update("jt", status="assigning", phase="assigning")
    s.update("jt", status="complete", phase="complete")
    timings = s.get("jt").phase_timings
    assert set(timings) >= {"embedding", "assigning", "complete"}
    assert timings["embedding"] <= timings["assigning"] <= timings["complete"]
    assert s.get("jt").to_dict()["phaseStartedAt"] == timings


# ── contract mapping (the insulation boundary) ──────────────────


def _canned_records() -> list[LeanBRecord]:
    return [
        LeanBRecord(
            cluster_id="c1",
            verdict="adopt",
            route="assigned",
            group_id="c1#g0",
            concept="age in years",
            cde_id="AgeCDE",
            cde_external_id="cde_age",
            ideal_cde="participant age in years",
            top1_cos=0.91,
            chosen_cos=0.88,
            member_variable_names=["CohortA:age", "CohortB:age_yrs"],
            cohorts=["CohortA", "CohortB"],
            cross_cohort=True,
            n_members=2,
            transforms=[
                TransformSpec(
                    source_variable="CohortB:age_yrs",
                    target_cde_id="AgeCDE",
                    kind=TransformKind.IDENTITY,
                    confidence=0.9,
                    coverage=1.0,
                )
            ],
            candidates=[
                CandidateCDE(
                    rank=1,
                    cde_id="AgeCDE",
                    cde_external_id="cde_age",
                    definition="age of participant",
                    cosine=0.88,
                    is_chosen=True,
                    llm_suggested=True,
                ),
                CandidateCDE(
                    rank=2, cde_id="BirthYearCDE", cde_external_id="cde_by", definition="year of birth", cosine=0.71
                ),
            ],
            rationale="same concept",
            decided_by="llm",
        ),
        LeanBRecord(
            cluster_id="c2",
            verdict="novel",
            route="gencde_residual",
            group_id="c2#g0",
            concept="bespoke item",
            cde_id=None,
            ideal_cde="bespoke item",
            top1_cos=0.2,
            chosen_cos=None,
            coverage_gap=True,
            member_variable_names=["CohortA:weird"],
            cohorts=["CohortA"],
            cross_cohort=False,
            n_members=1,
            rationale="no match",
            decided_by="llm",
        ),
    ]


def test_contract_mapping_record_and_summary():
    result = build_ui_result(LeanBResult(records=_canned_records()), mode="batch", phases=["loading"])
    assert result["contractVersion"] == "5"
    assert result["mode"] == "batch"
    rec0 = result["records"][0]
    assert rec0["id"] == "c1#g0"
    assert rec0["verdict"] == "adopt" and rec0["route"] == "assigned"
    assert rec0["cde"] == {"id": "AgeCDE", "externalId": "cde_age"}
    assert rec0["cosines"] == {"top1": 0.91, "chosen": 0.88}
    assert rec0["crossCohort"] is True
    assert rec0["transforms"][0]["kind"] == "identity"
    assert rec0["transforms"][0]["sourceVariable"] == "CohortB:age_yrs"
    assert len(rec0["candidates"]) == 2
    assert rec0["candidates"][0] == {
        "rank": 1,
        "cdeId": "AgeCDE",
        "cdeExternalId": "cde_age",
        "definition": "age of participant",
        "cosine": 0.88,
        "isChosen": True,
        "llmSuggested": True,
    }
    assert result["atlas"] == []  # canned build has no embeddings to project
    rec1 = result["records"][1]
    assert rec1["cde"] is None and rec1["coverageGap"] is True
    s = result["summary"]
    assert s["nRecords"] == 2
    assert s["counts"] == {"adopt": 1, "novel": 1}
    assert s["nCrossCohort"] == 1 and s["nAssigned"] == 1 and s["nGencdeResidual"] == 1
    assert s["nWithTransforms"] == 1
    assert s["cohorts"] == ["CohortA", "CohortB"]
    # No member_index given -> memberDetails falls back to the "cohort:var" id parts.
    assert rec0["memberDetails"][0] == {
        "id": "CohortA:age",
        "cohort": "CohortA",
        "name": "age",
        "text": "age",
    }


def test_gencde_maps_to_contract():
    """A novel record's synthesized GenCDE surfaces on UIRecord.gencde (distinct from the free-text idealCde);
    records without one map to null, and the prompt counts carry a gencde entry."""
    from ddharmon.harmonization.models import GenCDE
    from ddharmon.models.data_dictionary import ResponseOption

    novel = LeanBRecord(
        cluster_id="c9",
        group_id="c9#g0",
        concept="Ever smoked",
        verdict="novel",
        route="gencde_residual",
        cohorts=["AoU", "CLSA"],
        member_variable_names=["AoU:smk", "CLSA:smoke"],
        ideal_cde="Whether the participant ever smoked.",
        gencde=GenCDE(
            gencde_id="GENCDE:c9#g0",
            preferred_name="ever_smoked",
            definition="Whether the participant has ever smoked cigarettes.",
            data_type="binary",
            permissible_values=[ResponseOption(code="1", label="Yes"), ResponseOption(code="0", label="No")],
            source_variables=["AoU:smk", "CLSA:smoke"],
            source_cohorts=["AoU", "CLSA"],
            value_coverage=1.0,
            confidence=0.9,
            needs_review=False,
        ),
    )
    result = build_ui_result(LeanBResult(records=[novel]), mode="batch", phases=["loading"])
    rec = result["records"][0]
    assert rec["idealCde"].startswith("Whether")  # the free-text anchor is untouched
    g = rec["gencde"]
    assert g is not None
    assert g["gencdeId"] == "GENCDE:c9#g0"
    assert g["preferredName"] == "ever_smoked"
    assert g["dataType"] == "binary"
    assert g["permissibleValues"] == [{"code": "1", "label": "Yes"}, {"code": "0", "label": "No"}]
    assert g["valueCoverage"] == 1.0 and g["needsReview"] is False
    assert "gencde" in result["prompts"]
    # a record without a synthesized GenCDE -> null
    plain = build_ui_result(LeanBResult(records=_canned_records()), mode="batch", phases=["loading"])
    assert plain["records"][0]["gencde"] is None
    # a from-scratch element claims no parent, so the UI renders it as a proposal, not a refinement
    assert "parentCdeId" not in g


def test_refined_cde_carries_its_derivation_to_the_contract():
    """A `refine` record's element is DERIVED from a real CDE, and the UI must be able to say so.

    Without the parent, relation and delta the workbench would render a refinement identically to a
    from-scratch GenCDE — hiding which standard element is being changed and how, which is the only thing
    a reviewer can actually check.
    """
    from ddharmon.harmonization.models import GenCDE
    from ddharmon.models.data_dictionary import ResponseOption

    refined = LeanBRecord(
        cluster_id="c4",
        group_id="c4#g1",
        concept="Right carotid bulb plaque surface morphology",
        verdict="refine",
        route="assigned",
        cde_id="Imaging plaque surface type",
        cde_external_id="tiny999",
        cohorts=["MESA"],
        member_variable_names=["MESA:cplq1"],
        gencde=GenCDE(
            gencde_id="REFCDE:c4#g1",
            preferred_name="carotid_bulb_plaque_surface_right",
            definition="Surface morphology of plaque at the right carotid bulb.",
            data_type="categorical",
            permissible_values=[
                ResponseOption(code="1", label="Regular"),
                ResponseOption(code="2", label="Irregular"),
            ],
            source_variables=["MESA:cplq1"],
            source_cohorts=["MESA"],
            confidence=0.82,
            parent_cde_id="Imaging plaque surface type",
            parent_cde_external_id="tiny999",
            relation="skos:narrowMatch",
            refinement_axis="qualifier",
            qualifier_added="right carotid bulb",
            added_permissible_values=[ResponseOption(code="3", label="Ulcerated")],
            deprecated_values=["9"],
            changed_fields=["question_text"],
            completed_fields=["definition"],
            delta_size=0.167,
        ),
    )
    result = build_ui_result(LeanBResult(records=[refined]), mode="batch", phases=["loading"])
    g = result["records"][0]["gencde"]
    assert g is not None
    assert g["parentCdeId"] == "Imaging plaque surface type"
    assert g["parentCdeExternalId"] == "tiny999"  # drives the link-out to the NIH repository entry
    assert g["relation"] == "skos:narrowMatch"
    assert g["refinementAxis"] == "qualifier"
    assert g["qualifierAdded"] == "right carotid bulb"
    assert g["addedPermissibleValues"] == [{"code": "3", "label": "Ulcerated"}]
    assert g["deprecatedValues"] == ["9"]
    # changed vs completed is load-bearing: filling an EMPTY parent slot is not a contradiction of it
    assert g["changedFields"] == ["question_text"]
    assert g["completedFields"] == ["definition"]
    assert g["deltaSize"] == 0.167
    assert g["overRefined"] is False


def test_over_refined_element_surfaces_the_warning():
    """When the tool judges its own delta a rewrite rather than a refinement, the reviewer must see that."""
    from ddharmon.harmonization.models import GenCDE

    rec = LeanBRecord(
        cluster_id="c5",
        group_id="c5#g0",
        concept="Food frequency",
        verdict="refine",
        route="assigned",
        cde_id="Some CDE",
        gencde=GenCDE(gencde_id="REFCDE:c5#g0", parent_cde_id="Some CDE", over_refined=True, delta_size=0.83),
    )
    g = build_ui_result(LeanBResult(records=[rec]), mode="batch", phases=["loading"])["records"][0]["gencde"]
    assert g["overRefined"] is True and g["deltaSize"] == 0.83


def test_member_details_enriched_from_index():
    """With a member_index, each record's memberDetails carry the source field's human text."""
    from types import SimpleNamespace

    from backend.engine.adapter import build_member_index

    def field(desc="", qtext="", short=""):
        return SimpleNamespace(description=desc, question_text=qtext, short_label=short)

    dd = SimpleNamespace(
        cohort_name="CohortA",
        name="CohortA",
        fields={
            "age": field(desc="Age of the participant in years"),
            "_ROW_0001": field(desc="", qtext="", short="What is your marital status?"),  # AoU-style fallback
        },
    )
    index = build_member_index([SimpleNamespace(dictionary=dd)])
    assert index["CohortA:age"]["text"] == "Age of the participant in years"
    assert index["CohortA:_ROW_0001"]["text"] == "What is your marital status?"  # short_label fallback

    rec = LeanBRecord(
        cluster_id="c1",
        verdict="adopt",
        route="assigned",
        group_id="c1#g0",
        member_variable_names=["CohortA:age", "CohortA:_ROW_0001", "CohortB:missing"],
        cohorts=["CohortA", "CohortB"],
        n_members=3,
    )
    result = build_ui_result(LeanBResult(records=[rec]), mode="batch", phases=["loading"], member_index=index)
    details = result["records"][0]["memberDetails"]
    assert [d["text"] for d in details[:2]] == ["Age of the participant in years", "What is your marital status?"]
    # a member absent from the index still resolves (falls back to its id parts, never drops)
    assert details[2] == {"id": "CohortB:missing", "cohort": "CohortB", "name": "missing", "text": "missing"}


def test_field_index_and_unassigned_fields():
    """fieldIndex covers EVERY embedded non-CDE field with its read-in attributes (uncapped, CDE cohort
    excluded); unassignedFields lists source fields that landed in no record (with x,y when in the atlas)."""
    from types import SimpleNamespace

    from backend.engine.adapter import build_field_index

    def opt(code, label, order=None):
        return SimpleNamespace(code=code, label=label, order=order)

    def field(desc="", qtext="", short="", enc=None, units=None, dtype=None, options=None):
        return SimpleNamespace(
            description=desc,
            question_text=qtext,
            short_label=short,
            value_encoding_raw=enc,
            units=units,
            data_type=dtype,
            response_options=options or [],
        )

    dd = SimpleNamespace(
        cohort_name="CohortA",
        name="CohortA",
        fields={
            "age": field(desc="Age of the participant in years", units="years", dtype="integer"),
            "smoke": field(desc="Current smoker", enc="1=Yes|2=No", options=[opt("1", "Yes", 1), opt("2", "No", 2)]),
            "weird": field(desc="Bespoke unclustered item"),  # never lands in a record
        },
    )
    cde = SimpleNamespace(cohort_name="NIH_CDE", name="NIH_CDE", fields={"AgeCDE": field(desc="Age of participant")})
    embedded = [SimpleNamespace(dictionary=dd), SimpleNamespace(dictionary=cde)]

    field_index = build_field_index(embedded, cde_cohort="NIH_CDE")
    # every non-CDE field is present; the CDE cohort (the backbone) is excluded
    assert set(field_index) == {"CohortA:age", "CohortA:smoke", "CohortA:weird"}
    # read-in attributes surfaced; a key appears only when the source value is non-empty
    age = field_index["CohortA:age"]
    assert age["name"] == "age" and age["text"] == "Age of the participant in years"
    assert age["description"] == "Age of the participant in years"
    assert age["units"] == "years" and age["dataType"] == "integer"
    assert "valueEncoding" not in age and "responseOptions" not in age
    smoke = field_index["CohortA:smoke"]
    assert smoke["valueEncoding"] == "1=Yes|2=No"
    assert smoke["responseOptions"] == [
        {"code": "1", "label": "Yes", "order": 1},
        {"code": "2", "label": "No", "order": 2},
    ]

    # a record that clusters only age + smoke; "weird" lands in NO record
    rec = LeanBRecord(
        cluster_id="c1",
        verdict="adopt",
        route="assigned",
        group_id="c1#g0",
        member_variable_names=["CohortA:age", "CohortA:smoke"],
        cohorts=["CohortA"],
        n_members=2,
    )
    atlas = [
        {"cohort": "CohortA", "variable": "age", "x": 0.1, "y": 0.2},
        {"cohort": "CohortA", "variable": "weird", "x": -0.5, "y": 0.7},
    ]
    result = build_ui_result(
        LeanBResult(records=[rec]), mode="batch", phases=["loading"], atlas=atlas, field_index=field_index
    )
    # fieldIndex passes through whole — covers the clustered AND the unclustered field
    assert result["fieldIndex"] == field_index
    assert "CohortA:weird" in result["fieldIndex"]
    # unassignedFields = source fields in no record; clustered ones excluded, x/y attached from the atlas
    unassigned = result["unassignedFields"]
    assert [u["variable"] for u in unassigned] == ["weird"]
    assert unassigned[0] == {
        "cohort": "CohortA",
        "variable": "weird",
        "text": "Bespoke unclustered item",
        "x": -0.5,
        "y": 0.7,
    }
    assert all(u["variable"] != "age" and u["variable"] != "smoke" for u in unassigned)


def test_build_ui_result_defaults_field_index_empty():
    """Without a field_index (e.g. canned-record tests), fieldIndex is {} and unassignedFields is []."""
    result = build_ui_result(LeanBResult(records=_canned_records()), mode="batch", phases=["loading"])
    assert result["fieldIndex"] == {}
    assert result["unassignedFields"] == []


# ── full HTTP flow with a fake runner ──────────────────────────

_CANNED_RESULT = build_ui_result(LeanBResult(records=_canned_records()), mode="batch", phases=["loading"])


def test_batch_flow_with_fake_runner(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    # Point the CDE catalog at a real (if tiny) file so start_batch's existence check passes.
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None, api_key=None):
        store.update(job_id, status="complete", phase="complete", result=_CANNED_RESULT)

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)

    cfg = {
        "dictionaries": [
            {
                "filename": "cohortA.csv",
                "cohortName": "CohortA",
                "columnRoles": {"variable_name": "var", "description": "desc"},
            }
        ],
        "cdeSet": "endorsed",
        "runMode": "batch",
        "minClusterSize": 5,
        "displayName": "Test run",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", b"var,desc\nage,Age in years\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]

    # fake runner completes in a daemon thread — poll briefly.
    for _ in range(50):
        r = client.get(f"/api/harmonize/result/{job_id}")
        if r.json()["status"] == "complete":
            break
        time.sleep(0.02)
    assert r.json()["status"] == "complete"
    assert len(r.json()["result"]["records"]) == 2

    # jobs list (summary carries nRecords, not the heavy payload)
    summaries = client.get("/api/harmonize/jobs").json()
    assert any(j["jobId"] == job_id and j["nRecords"] == 2 for j in summaries)

    # human decision by recordId
    dec = client.post(
        f"/api/harmonize/jobs/{job_id}/verdict", json={"recordId": "c1#g0", "decision": "approve", "note": "ok"}
    )
    assert dec.status_code == 200

    # export: EITL TSV (refine→novel→adopt ordering; carries the human decision)
    tsv = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "eitl_tsv"})
    assert tsv.status_code == 200
    lines = tsv.text.strip().splitlines()
    assert lines[0].split("\t")[0] == "recordId"
    assert any("c1#g0" in ln and "approve" in ln for ln in lines)
    assert lines[1].split("\t")[4] == "novel"  # novel sorts before adopt

    # export: records JSON + decisions CSV
    recs = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "records_json"})
    assert recs.status_code == 200 and len(recs.json()) == 2
    dec_csv = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "decisions_csv"})
    assert dec_csv.text.strip().splitlines()[0].split(",")[0] == "recordId"

    # delete
    assert client.delete(f"/api/harmonize/jobs/{job_id}").status_code == 204
    assert client.get(f"/api/harmonize/result/{job_id}").status_code == 404


def test_transform_verdict_axis_persists_and_exports(monkeypatch, tmp_path):
    """The transform axis is a second, independent verdict recorded PER SOURCE VARIABLE: each ``cohort:var``
    edge gets its own approve/refine/reject, persisted under ``decisions[rec]["transforms"][sourceVariable]``
    and serialized into a single trailing ``transformDecisions`` JSON export column. ``sourceVariable`` is
    REQUIRED on the transform axis; ``refine`` is now valid there too."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None, api_key=None):
        store.update(job_id, status="complete", phase="complete", result=_CANNED_RESULT)

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)

    cfg = {
        "dictionaries": [{"filename": "cohortA.csv", "cohortName": "CohortA", "columnRoles": {"variable_name": "var"}}],
        "cdeSet": "endorsed",
        "runMode": "batch",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", b"var,desc\nage,Age in years\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]
    for _ in range(50):
        if client.get(f"/api/harmonize/result/{job_id}").json()["status"] == "complete":
            break
        time.sleep(0.02)

    # match verdict + a PER-VARIABLE transform verdict on the same record, on independent axes
    m = client.post(
        f"/api/harmonize/jobs/{job_id}/verdict", json={"recordId": "c1#g0", "decision": "refine", "note": "m"}
    )
    assert m.status_code == 200
    t = client.post(
        f"/api/harmonize/jobs/{job_id}/verdict",
        json={
            "recordId": "c1#g0",
            "decision": "approve",
            "axis": "transform",
            "sourceVariable": "CohortB:age_yrs",
            "note": "unit ok",
        },
    )
    assert t.status_code == 200
    # refine IS valid on the transform axis now (full triad, per variable) — last write on the edge wins
    ok_refine = client.post(
        f"/api/harmonize/jobs/{job_id}/verdict",
        json={"recordId": "c1#g0", "decision": "refine", "axis": "transform", "sourceVariable": "CohortB:age_yrs"},
    )
    assert ok_refine.status_code == 200
    # transform axis REQUIRES sourceVariable
    bad = client.post(
        f"/api/harmonize/jobs/{job_id}/verdict",
        json={"recordId": "c1#g0", "decision": "approve", "axis": "transform"},
    )
    assert bad.status_code == 400

    # persisted per-variable, nested under decisions[rec]["transforms"][sourceVariable]
    snap = client.get(f"/api/harmonize/result/{job_id}").json()
    tx = snap["decisions"]["c1#g0"]["transforms"]["CohortB:age_yrs"]
    assert tx["decision"] == "refine"  # last write wins on the same edge
    assert snap["decisions"]["c1#g0"]["decision"] == "refine"  # match axis coexists, untouched

    # EITL TSV: single trailing transformDecisions JSON column, keyed by sourceVariable (parse via csv to
    # undo the quoting csv.writer applies to the JSON's embedded quotes/commas)
    tsv = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "eitl_tsv"})
    assert tsv.status_code == 200
    rows = list(csv.reader(io.StringIO(tsv.text), delimiter="\t"))
    header = rows[0]
    assert header[-2] == "transformDecisions" and header[-1] == "gencdeDecision"  # two trailing verdict cols
    ti = header.index("transformDecisions")
    row = next(r for r in rows[1:] if r[0] == "c1#g0")
    tj = json.loads(row[ti])
    assert tj["CohortB:age_yrs"]["decision"] == "refine"
    assert row[header.index("humanDecision")] == "refine"  # match axis unchanged

    # decisions CSV likewise carries the per-variable transform verdicts in its own trailing column
    dec_csv = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "decisions_csv"})
    drows = list(csv.reader(io.StringIO(dec_csv.text)))
    dheader = drows[0]
    assert dheader[-2] == "transformDecisions" and dheader[-1] == "gencdeDecision"
    drow = next(r for r in drows[1:] if r[0] == "c1#g0")
    assert json.loads(drow[dheader.index("transformDecisions")])["CohortB:age_yrs"]["decision"] == "refine"

    assert client.delete(f"/api/harmonize/jobs/{job_id}").status_code == 204


def test_verdict_clear_unsets_each_axis(monkeypatch, tmp_path):
    """``decision="clear"`` un-sets a previously-recorded verdict on any axis (the reviewer toggled it off in
    the workbench). Match clears the top-level decision/note; transform clears only its sourceVariable edge;
    gencde clears the gencde entry. A record whose every axis is cleared is pruned entirely, leaving no residue."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None, api_key=None):
        store.update(job_id, status="complete", phase="complete", result=_CANNED_RESULT)

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)
    cfg = {
        "dictionaries": [{"filename": "cohortA.csv", "cohortName": "CohortA", "columnRoles": {"variable_name": "var"}}],
        "cdeSet": "endorsed",
        "runMode": "batch",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", b"var,desc\nage,Age in years\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]
    for _ in range(50):
        if client.get(f"/api/harmonize/result/{job_id}").json()["status"] == "complete":
            break
        time.sleep(0.02)

    def verdict(**body):
        return client.post(f"/api/harmonize/jobs/{job_id}/verdict", json={"recordId": "c1#g0", **body})

    # set a verdict on all three independent axes
    assert verdict(decision="approve", note="m").status_code == 200
    assert verdict(decision="approve", axis="transform", sourceVariable="CohortB:age_yrs").status_code == 200
    assert verdict(decision="reject", axis="gencde").status_code == 200
    snap = client.get(f"/api/harmonize/result/{job_id}").json()["decisions"]["c1#g0"]
    assert snap["decision"] == "approve" and snap["gencde"]["decision"] == "reject"
    assert snap["transforms"]["CohortB:age_yrs"]["decision"] == "approve"

    # clear the transform edge — only that edge goes; match + gencde remain
    assert verdict(decision="clear", axis="transform", sourceVariable="CohortB:age_yrs").status_code == 200
    snap = client.get(f"/api/harmonize/result/{job_id}").json()["decisions"]["c1#g0"]
    assert "CohortB:age_yrs" not in snap.get("transforms", {})
    assert snap["decision"] == "approve" and "gencde" in snap

    # clear the gencde axis — match verdict still stands
    assert verdict(decision="clear", axis="gencde").status_code == 200
    snap = client.get(f"/api/harmonize/result/{job_id}").json()["decisions"]["c1#g0"]
    assert "gencde" not in snap and snap["decision"] == "approve"

    # clear the match axis — the record is now fully empty and pruned entirely
    assert verdict(decision="clear").status_code == 200
    assert "c1#g0" not in client.get(f"/api/harmonize/result/{job_id}").json()["decisions"]

    # an unknown decision is still rejected
    assert verdict(decision="bogus").status_code == 400

    assert client.delete(f"/api/harmonize/jobs/{job_id}").status_code == 204


def test_gencde_verdict_axis_persists_and_exports(monkeypatch, tmp_path):
    """The GenCDE axis is a THIRD independent verdict — the reviewer's approve/refine/reject on the synthesized
    GenCDE itself, recorded once per record under ``decisions[rec]["gencde"]`` and serialized into the trailing
    ``gencdeDecision`` export column. It needs no ``sourceVariable`` and coexists with the match + transform axes."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None, api_key=None):
        store.update(job_id, status="complete", phase="complete", result=_CANNED_RESULT)

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)
    cfg = {
        "dictionaries": [{"filename": "cohortA.csv", "cohortName": "CohortA", "columnRoles": {"variable_name": "var"}}],
        "cdeSet": "endorsed",
        "runMode": "batch",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", b"var,desc\nage,Age in years\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]
    for _ in range(50):
        if client.get(f"/api/harmonize/result/{job_id}").json()["status"] == "complete":
            break
        time.sleep(0.02)

    # match + transform + gencde verdicts on the same record, all on independent axes
    assert (
        client.post(
            f"/api/harmonize/jobs/{job_id}/verdict", json={"recordId": "c1#g0", "decision": "approve"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/harmonize/jobs/{job_id}/verdict",
            json={"recordId": "c1#g0", "decision": "reject", "axis": "gencde", "note": "wrong concept"},
        ).status_code
        == 200
    )
    # gencde axis takes no sourceVariable, and an unknown axis is rejected
    assert (
        client.post(
            f"/api/harmonize/jobs/{job_id}/verdict", json={"recordId": "c1#g0", "decision": "approve", "axis": "bogus"}
        ).status_code
        == 400
    )

    # persisted under decisions[rec]["gencde"], coexisting with the untouched match verdict
    snap = client.get(f"/api/harmonize/result/{job_id}").json()
    assert snap["decisions"]["c1#g0"]["gencde"] == {"decision": "reject", "note": "wrong concept"}
    assert snap["decisions"]["c1#g0"]["decision"] == "approve"  # match axis untouched

    # both exports carry the GenCDE verdict in the trailing gencdeDecision column
    for fmt, delim in (("eitl_tsv", "\t"), ("decisions_csv", ",")):
        exp = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": fmt})
        assert exp.status_code == 200
        erows = list(csv.reader(io.StringIO(exp.text), delimiter=delim))
        eheader = erows[0]
        assert eheader[-1] == "gencdeDecision"
        erow = next(r for r in erows[1:] if r[0] == "c1#g0")
        assert json.loads(erow[eheader.index("gencdeDecision")])["decision"] == "reject"

    # a gencde REFINE may carry the reviewer's CORRECTED GenCDE fields in ``edited`` — those round-trip on the
    # decision AND flow to the trailing gencdeDecision export column (the export already dumps the whole dict).
    edited = {"definition": "corrected definition", "permissibleValues": [{"code": "1", "label": "Yes"}], "units": "yr"}
    assert (
        client.post(
            f"/api/harmonize/jobs/{job_id}/verdict",
            json={"recordId": "c1#g0", "decision": "refine", "axis": "gencde", "note": "fixed", "edited": edited},
        ).status_code
        == 200
    )
    snap2 = client.get(f"/api/harmonize/result/{job_id}").json()
    gd = snap2["decisions"]["c1#g0"]["gencde"]
    assert gd["decision"] == "refine" and gd["note"] == "fixed" and gd["edited"] == edited
    tsv2 = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "eitl_tsv"})
    trows = list(csv.reader(io.StringIO(tsv2.text), delimiter="\t"))
    theader = trows[0]
    trow = next(r for r in trows[1:] if r[0] == "c1#g0")
    exported = json.loads(trow[theader.index("gencdeDecision")])
    assert exported["decision"] == "refine" and exported["edited"]["definition"] == "corrected definition"

    assert client.delete(f"/api/harmonize/jobs/{job_id}").status_code == 204


def test_gencde_recode_regeneration_replaces_stale_specs_and_byok_not_persisted(monkeypatch, tmp_path):
    """Refine → regen: the targeted endpoint re-maps a record's member→GenCDE recodes against the corrected
    value domain (fresh transforms REPLACE the stale one), reloading the run's retained source dictionary for
    the source value set. BYOK: the key builds the client for this request only and is NEVER persisted."""
    from ddharmon.harmonization.leanb import LeanBResult
    from ddharmon.harmonization.models import GenCDE, LeanBRecord, TransformKind, TransformSpec
    from ddharmon.models.data_dictionary import ResponseOption

    from backend.engine.adapter import build_ui_result

    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    # A novel record with a categorical GenCDE and a STALE member→GenCDE recode (only 1 of 2 source codes).
    novel = LeanBRecord(
        cluster_id="c9",
        group_id="c9#g0",
        concept="Ever smoked",
        verdict="novel",
        route="gencde_residual",
        cohorts=["CohortA"],
        member_variable_names=["CohortA:smk"],
        n_members=1,
        ideal_cde="Whether the participant ever smoked.",
        gencde=GenCDE(
            gencde_id="GENCDE:c9#g0",
            preferred_name="ever_smoked",
            definition="Whether the participant has ever smoked.",
            data_type="categorical",
            permissible_values=[ResponseOption(code="1", label="Yes"), ResponseOption(code="0", label="No")],
            source_variables=["CohortA:smk"],
            source_cohorts=["CohortA"],
            value_coverage=1.0,
            confidence=0.9,
        ),
        transforms=[
            TransformSpec(
                source_variable="CohortA:smk",
                target_cde_id="GENCDE:c9#g0",
                kind=TransformKind.CATEGORICAL,
                coverage=0.5,
                confidence=0.4,
                code_map={"1": "1"},  # stale: source code "2" unmapped
                needs_review=True,
            )
        ],
    )
    custom_result = build_ui_result(LeanBResult(records=[novel]), mode="batch", phases=["loading"])

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None, api_key=None):
        store.update(job_id, status="complete", phase="complete", result=custom_result)

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)

    # The spec-gen LLM is stubbed at the SDK client: it returns a full recode (both source codes mapped).
    seen_keys: list[str | None] = []

    class StubClient:
        def __init__(self, *a, **k):
            seen_keys.append(k.get("api_key"))

        def complete(self, prompt, *, system=None, max_tokens=512):
            return json.dumps({"code_map": {"1": "1", "2": "0"}, "confidence": 0.95, "notes": "remapped"})

    monkeypatch.setattr("ddharmon.llm.anthropic_client.AnthropicClient", StubClient)

    cfg = {
        "dictionaries": [
            {
                "filename": "cohortA.csv",
                "cohortName": "CohortA",
                "columnRoles": {"variable_name": "var", "description": "desc", "value_encoding": "enc"},
            }
        ],
        "cdeSet": "endorsed",
        "runMode": "batch",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", b"var,desc,enc\nsmk,Ever smoked,1=Yes|2=No\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]
    for _ in range(50):
        if client.get(f"/api/harmonize/result/{job_id}").json()["status"] == "complete":
            break
        time.sleep(0.02)

    # regenerate the recodes for the novel record, supplying the BYOK key. The record id "c9#g0" has a "#",
    # so it must be URL-encoded in the path (mirrors the frontend's encodeURIComponent).
    from urllib.parse import quote

    reg = client.post(
        f"/api/harmonize/jobs/{job_id}/records/{quote('c9#g0', safe='')}/regenerate-specs",
        headers={"x-anthropic-key": "sk-ant-regen-secret"},
    )
    assert reg.status_code == 200, reg.text
    transforms = reg.json()["record"]["transforms"]
    # exactly one GenCDE-target recode, now covering BOTH source codes (the stale partial one is gone)
    gencde_tx = [t for t in transforms if t["targetCdeId"] == "GENCDE:c9#g0"]
    assert len(gencde_tx) == 1
    assert gencde_tx[0]["kind"] == "categorical"
    assert gencde_tx[0]["codeMap"] == {"1": "1", "2": "0"}
    assert gencde_tx[0]["coverage"] == 1.0  # was 0.5

    # the fresh transforms are written back onto the job's result blob
    snap = client.get(f"/api/harmonize/result/{job_id}").json()
    rec = next(r for r in snap["result"]["records"] if r["id"] == "c9#g0")
    assert rec["transforms"][0]["codeMap"] == {"1": "1", "2": "0"}

    # BYOK invariant: the key reached the client constructor but is NOWHERE in the persisted job.
    assert "sk-ant-regen-secret" in (seen_keys or [None])  # client built with the key
    assert "sk-ant-regen-secret" not in json.dumps(snap)
    persisted = next(j for j in client.get("/api/harmonize/jobs").json() if j["jobId"] == job_id)
    assert "sk-ant-regen-secret" not in json.dumps(persisted)

    # a record with no GenCDE / an unknown record → 409 / 404 (never a crash)
    assert client.post(f"/api/harmonize/jobs/{job_id}/records/nope/regenerate-specs").status_code == 404

    assert client.delete(f"/api/harmonize/jobs/{job_id}").status_code == 204


def test_gencde_recode_regeneration_numeric_runs_n1_n2(monkeypatch, tmp_path):
    """Refine → regen for a NUMERIC GenCDE (no permissible_values): the endpoint runs the deterministic N1
    unit pass + the N2 arithmetic residual upgrade (an LLM formula), replacing the stale numeric recode with
    a fresh ARITHMETIC spec that always routes to review."""
    from ddharmon.harmonization.leanb import LeanBResult
    from ddharmon.harmonization.models import GenCDE, LeanBRecord, TransformKind, TransformSpec

    from backend.engine.adapter import build_ui_result

    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    # A novel record with a NUMERIC GenCDE and a STALE numeric recode targeting it.
    novel = LeanBRecord(
        cluster_id="c9",
        group_id="c9#g0",
        concept="Age",
        verdict="novel",
        route="gencde_residual",
        cohorts=["CohortA"],
        member_variable_names=["CohortA:agemo"],
        n_members=1,
        gencde=GenCDE(
            gencde_id="GENCDE:c9#g0",
            preferred_name="age_years",
            definition="Participant age in years.",
            data_type="numeric",
            permissible_values=[],  # numeric -> the N1/N2 path, not a categorical recode
            source_variables=["CohortA:agemo"],
            source_cohorts=["CohortA"],
        ),
        transforms=[
            TransformSpec(
                source_variable="CohortA:agemo",
                target_cde_id="GENCDE:c9#g0",
                kind=TransformKind.ARITHMETIC,
                formula="source * 999",  # stale
                inputs=["source"],
                needs_review=True,
            )
        ],
    )
    custom_result = build_ui_result(LeanBResult(records=[novel]), mode="batch", phases=["loading"])

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None, api_key=None):
        store.update(job_id, status="complete", phase="complete", result=custom_result)

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)

    # The N2 arith LLM is stubbed at the SDK client: it proposes a fixed months->years formula.
    seen_keys: list[str | None] = []

    class StubClient:
        def __init__(self, *a, **k):
            seen_keys.append(k.get("api_key"))

        def complete(self, prompt, *, system=None, max_tokens=512):
            return json.dumps({"formula": "source / 12", "confidence": 0.9, "notes": "months to years"})

    monkeypatch.setattr("ddharmon.llm.anthropic_client.AnthropicClient", StubClient)

    cfg = {
        "dictionaries": [
            {
                "filename": "cohortA.csv",
                "cohortName": "CohortA",
                "columnRoles": {"variable_name": "var", "description": "desc"},
            }
        ],
        "cdeSet": "endorsed",
        "runMode": "batch",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", b"var,desc\nagemo,Age in months\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]
    for _ in range(50):
        if client.get(f"/api/harmonize/result/{job_id}").json()["status"] == "complete":
            break
        time.sleep(0.02)

    from urllib.parse import quote

    reg = client.post(
        f"/api/harmonize/jobs/{job_id}/records/{quote('c9#g0', safe='')}/regenerate-specs",
        headers={"x-anthropic-key": "sk-ant-numeric-secret"},
    )
    assert reg.status_code == 200, reg.text
    gencde_tx = [t for t in reg.json()["record"]["transforms"] if t["targetCdeId"] == "GENCDE:c9#g0"]
    assert len(gencde_tx) == 1
    assert gencde_tx[0]["kind"] == "arithmetic"  # N1 residual upgraded by the N2 formula
    assert gencde_tx[0]["formula"] == "source / 12"  # the stale "source * 999" is gone
    assert gencde_tx[0]["needsReview"] is True  # LLM-proposed arithmetic always routes to review

    # BYOK invariant: the key built the client but is nowhere in the persisted job.
    snap = client.get(f"/api/harmonize/result/{job_id}").json()
    assert "sk-ant-numeric-secret" in (seen_keys or [None])
    assert "sk-ant-numeric-secret" not in json.dumps(snap)

    assert client.delete(f"/api/harmonize/jobs/{job_id}").status_code == 204


def test_byok_key_threaded_to_runner_and_never_persisted(monkeypatch, tmp_path):
    """The x-anthropic-key header reaches run_harmonization as api_key, but never lands in run_config.

    run_config is persisted by store.create, so a key there would leak to disk/logs. This locks the
    two BYOK invariants: (1) the header is threaded through; (2) it stays out of the persisted config.
    """
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    captured: dict = {}

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None, api_key=None):
        captured["api_key"] = api_key
        captured["config"] = dict(config)
        store.update(job_id, status="complete", phase="complete", result=_CANNED_RESULT)

    monkeypatch.setattr(app_module, "run_harmonization", fake_runner)

    cfg = {
        "dictionaries": [
            {
                "filename": "cohortA.csv",
                "cohortName": "CohortA",
                "columnRoles": {"variable_name": "var", "description": "desc"},
            }
        ],
        "cdeSet": "endorsed",
        "runMode": "batch",
        "minClusterSize": 5,
    }
    files = [("files", ("cohortA.csv", b"var,desc\nage,Age in years\n", "text/csv"))]

    # (1) header present -> threaded as api_key, absent from persisted config
    resp = client.post(
        "/api/harmonize/batch",
        files=files,
        data={"config": json.dumps(cfg)},
        headers={"x-anthropic-key": "sk-ant-byok-secret"},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]
    for _ in range(50):
        if client.get(f"/api/harmonize/result/{job_id}").json()["status"] == "complete":
            break
        time.sleep(0.02)
    assert captured["api_key"] == "sk-ant-byok-secret"
    assert "api_key" not in captured["config"]
    assert "sk-ant-byok-secret" not in json.dumps(captured["config"])
    # and the same invariant against what actually got persisted on the job
    persisted = next(j for j in client.get("/api/harmonize/jobs").json() if j["jobId"] == job_id)
    assert "sk-ant-byok-secret" not in json.dumps(persisted)

    # (2) no header -> api_key is None (unchanged ANTHROPIC_API_KEY env behavior)
    captured.clear()
    resp2 = client.post("/api/harmonize/batch", files=files, data={"config": json.dumps(cfg)})
    assert resp2.status_code == 200
    job2 = resp2.json()["jobId"]
    for _ in range(50):
        if client.get(f"/api/harmonize/result/{job2}").json()["status"] == "complete":
            break
        time.sleep(0.02)
    assert captured["api_key"] is None


def test_batch_rejects_missing_required_role(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: None)
    cfg = {"dictionaries": [{"filename": "x.csv", "cohortName": "X", "columnRoles": {}}], "cdeSet": "endorsed"}
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("x.csv", b"a,b\n1,2\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 400


def test_batch_rejects_missing_cde_catalog(monkeypatch, tmp_path):
    """The pipeline requires a CDE backbone — cdeSet=none (or any non-endorsed/full) is rejected."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: None)
    cfg = {
        "dictionaries": [{"filename": "x.csv", "cohortName": "X", "columnRoles": {"variable_name": "var"}}],
        "cdeSet": "none",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("x.csv", b"var,desc\nage,Age\n", "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 400
    assert "CDE" in resp.json()["detail"]


# ── deterministic end-to-end run_pipeline (leanb stages + BERTopic mocked) ────


def test_run_pipeline_end_to_end(monkeypatch, tmp_path):
    # Two cohort dicts + a CDE catalog, as small CSV/TSV files.
    a = tmp_path / "cohortA.csv"
    a.write_text("var,desc,enc\nage,Age in years,\nsmoke,Do you smoke,1=Yes|2=No\n")
    b = tmp_path / "cohortB.csv"
    b.write_text("var,desc,enc\nage_yrs,Age in years,\nsmoke_b,Current smoker,1=Yes|0=No\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\tdefinition\tpermissible_values\nAgeCDE\tAge of participant\tyears\n"
        "SmokeCDE\tSmoking status\t1=Yes|0=No\n"
    )

    dict_specs = [
        {
            "path": str(a),
            "cohort_name": "CohortA",
            "column_roles": {"variable_name": "var", "description": "desc", "value_encoding": "enc"},
        },
        {
            "path": str(b),
            "cohort_name": "CohortB",
            "column_roles": {"variable_name": "var", "description": "desc", "value_encoding": "enc"},
        },
    ]
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {
            "variable_name": "designation",
            "description": "definition",
            "value_encoding": "permissible_values",
        },
    }

    # Fake BERTopic: one cluster over every COHORT field (CDE fields are the backbone, not cluster members).
    def fake_topic_model(embedded, **kwargs):
        docs, embeddings, field_refs, cohorts = collect_inputs(embedded)
        members = [r for r in field_refs if r.dictionary_name != "NIH_CDE"]
        cluster = FieldCluster(cluster_id=0, label="all", members=members)
        return TopicModelResult(
            model=None,
            docs=docs,
            embeddings=embeddings,
            field_refs=field_refs,
            clusters=[cluster],
            outlier_cluster=None,
            all_cohort_names=cohorts,
        )

    # harmonize_leanb imports topic_model_dictionaries lazily from its source module — patch there.
    monkeypatch.setattr("ddharmon.clustering.topic_engine.topic_model_dictionaries", fake_topic_model)

    # Mock the three LLM stages. An empty split response triggers the single-group fallback, so we don't
    # have to reconstruct member-ids; classify adopts the top candidate (cde_id "1" = candidate #1).
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1, 2], "rationale": "mock"} for r in recs
        },
        "specgen": lambda recs: {},
    }

    config = {
        "run_mode": "batch",
        "cde_cohort": "NIH_CDE",
        "work_dir": str(tmp_path),
        "min_cluster_size": 2,
        "retrieval_floor": 0.0,  # don't downgrade adopts (StubProvider cosines are arbitrary)
        "gen_transform_specs": True,
    }

    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert result["contractVersion"] == "5"
    # v3 additive: every result carries a realized-cost block. Zero here (stage_overrides bypass the priced
    # sync/batch stages); a real run populates it from captured token usage.
    assert result["cost"] == {"actualUsd": 0.0, "tokens": {"input": 0, "output": 0}, "perStage": {}}
    assert result["mode"] == "batch"
    assert result["phases"][0] == "loading"
    assert len(result["records"]) >= 1
    rec = result["records"][0]
    assert {"id", "verdict", "route", "cde", "cosines", "members", "transforms", "candidates"}.issubset(rec)
    assert result["summary"]["nRecords"] == len(result["records"])
    # candidates persisted through the real assemble; atlas projected from the stub embeddings
    assert any(r["candidates"] for r in result["records"])
    assert isinstance(result["atlas"], list) and len(result["atlas"]) >= 1
    assert {"cohort", "variable", "x", "y"}.issubset(result["atlas"][0])
    # fieldIndex covers the embedded non-CDE fields (uncapped) and excludes the CDE cohort; every clustered
    # member resolves in it and no unassigned field is also a member (backward-compatible additive keys).
    assert result["fieldIndex"], "fieldIndex should be populated from the embedded dictionaries"
    assert not any(k.startswith("NIH_CDE:") for k in result["fieldIndex"])
    members = {m for r in result["records"] for m in r["members"]}
    assert members and members.issubset(result["fieldIndex"])
    assert isinstance(result["unassignedFields"], list)
    unassigned_keys = {f"{u['cohort']}:{u['variable']}" for u in result["unassignedFields"]}
    assert unassigned_keys.isdisjoint(members)


def _spy_on_core(monkeypatch, seen):
    """Record the kwargs the adapter hands ``harmonize_leanb``.

    ``functools.wraps`` matters: the adapter signature-guards optional knobs with
    ``inspect.signature(harmonize_leanb)``, so a naive ``(embedded, **kw)`` wrapper would hide the real
    parameters and make the guard skip the very kwarg under test — a false pass.
    """
    import functools

    import ddharmon.harmonization as core

    orig = core.harmonize_leanb

    @functools.wraps(orig)
    def spy(embedded, **kw):
        seen["refine_cdes"] = kw.get("refine_cdes", "ABSENT")
        seen["refine_cb"] = kw.get("refine") is not None
        return orig(embedded, **kw)

    monkeypatch.setattr(core, "harmonize_leanb", spy)


def _refine_fixture(tmp_path, monkeypatch):
    """Minimal two-cohort + CDE setup whose single concept classifies as ``refine``."""
    a = tmp_path / "cohortA.csv"
    a.write_text("var,desc,enc\nsmoke,Do you smoke,1=Yes|2=No\n")
    b = tmp_path / "cohortB.csv"
    b.write_text("var,desc,enc\nsmoke_b,Current smoker,1=Yes|0=No\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\tpermissible_values\nSmokeCDE\tSmoking status\t1=Yes|0=No\n")

    roles = {"variable_name": "var", "description": "desc", "value_encoding": "enc"}
    dict_specs = [
        {"path": str(a), "cohort_name": "CohortA", "column_roles": roles},
        {"path": str(b), "cohort_name": "CohortB", "column_roles": roles},
    ]
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {
            "variable_name": "designation",
            "description": "definition",
            "value_encoding": "permissible_values",
        },
    }

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

    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "refine", "cde_id": "1", "ranking": [1], "rationale": "mock"} for r in recs
        },
        "specgen": lambda recs: {},
        "refine": lambda recs: {},
    }
    config = {
        "run_mode": "batch",
        "cde_cohort": "NIH_CDE",
        "work_dir": str(tmp_path),
        "min_cluster_size": 2,
        "retrieval_floor": 0.0,
        "gen_transform_specs": True,
    }
    return dict_specs, cde_spec, config, overrides


def test_refine_cdes_is_wired_through_to_core(monkeypatch, tmp_path):
    """The adapter must pass BOTH ``refine_cdes=True`` and a ``refine`` stage to core.

    Regression guard for a silent gap: core defaults ``refine_cdes`` OFF and the knobs passthrough is an
    allowlist, so for a while the refine bucket named a CDE but had nothing to harmonize ONTO and the
    Refined CDE panel could never populate. This asserts the wiring rather than an LLM call, because
    whether a prompt is actually produced is core's triage decision (a mis-assigned or deterministically
    settled record correctly yields no paid call).
    """
    dict_specs, cde_spec, config, overrides = _refine_fixture(tmp_path, monkeypatch)
    seen: dict = {}
    _spy_on_core(monkeypatch, seen)

    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert any(r["verdict"] == "refine" for r in result["records"]), "fixture should produce a refine record"
    assert seen["refine_cdes"] is True, "refine_cdes never reached core — the refine bucket gets no target"
    assert seen["refine_cb"], "the refine stage callback was not passed to core"
    assert "refine" in result["phases"], "the refine phase should be advertised to the UI"


def test_refine_cdes_can_be_gated_off(monkeypatch, tmp_path):
    """``refine_cdes=false`` suppresses it — refinement costs an LLM call per group core can't settle free."""
    dict_specs, cde_spec, config, overrides = _refine_fixture(tmp_path, monkeypatch)
    config["refine_cdes"] = False
    seen: dict = {}
    _spy_on_core(monkeypatch, seen)

    run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert seen["refine_cdes"] == "ABSENT", "refine_cdes=false should not pass the flag to core"
    assert not seen["refine_cb"], "refine_cdes=false should not pass the refine callback either"


def test_run_pipeline_reports_progress_phases(monkeypatch, tmp_path):
    """The adapter reports phases via the progress callback (data-driven progress for the UI)."""
    a = tmp_path / "cohortA.csv"
    a.write_text("var,desc\nage,Age in years\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")

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
    seen: list[str] = []
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "novel", "cde_id": None, "ranking": [], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    run_pipeline(
        [{"path": str(a), "cohort_name": "CohortA", "column_roles": {"variable_name": "var", "description": "desc"}}],
        {
            "path": str(cde),
            "cohort_name": "NIH_CDE",
            "column_roles": {"variable_name": "designation", "description": "definition"},
        },
        {"run_mode": "batch", "cde_cohort": "NIH_CDE", "work_dir": str(tmp_path), "min_cluster_size": 1},
        progress=lambda phase, completed=0, total=0: seen.append(phase),
        provider=StubProvider(),
        stage_overrides=overrides,
    )
    assert "loading" in seen and "embedding" in seen and "clustering" in seen


def test_spa_deep_link_falls_back_to_index_html():
    """A hard GET of a client-side route serves the SPA (index.html), so refresh/bookmark/deep links work —
    while /api stays JSON and a real missing asset still 404s. Skips when the frontend isn't built."""
    if not app_module._DIST.exists():
        pytest.skip("frontend/dist not built")
    r = client.get("/methods")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    # /api is registered before the SPA mount -> not swallowed by the fallback (public demos route = JSON)
    demos = client.get("/api/harmonize/demos")
    assert demos.status_code == 200 and "application/json" in demos.headers["content-type"]
    # a missing asset (has an extension) still 404s -> the fallback doesn't mask real asset misses
    assert client.get("/definitely-missing.js").status_code == 404


def test_run_pipeline_empty_dictionary_raises_clear_error(tmp_path):
    """A file with no usable fields (header-only, or columns that didn't map) must fail with a clear,
    actionable message — NOT a cryptic ``need at least one array to stack`` from an empty embedding stack.

    Regression: an empty embedded dictionary reached ``_atlas_points``/``collect_inputs``, which did
    ``np.stack([])`` on its (empty) vectors and raised deep in numpy. Reported live as "Error 3/3:
    need at least one array to stack" on a run whose uploaded file had only a header row.
    """
    empty = tmp_path / "empty.csv"
    empty.write_text("var,desc\n")  # header only -> zero data rows -> zero fields
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    dict_specs = [
        {"path": str(empty), "cohort_name": "CohortA", "column_roles": {"variable_name": "var", "description": "desc"}}
    ]
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {"variable_name": "designation", "description": "definition"},
    }
    config = {"run_mode": "preview", "cde_cohort": "NIH_CDE", "work_dir": str(tmp_path)}
    with pytest.raises(ValueError, match="No usable fields"):
        run_pipeline(dict_specs, cde_spec, config, provider=StubProvider())


class _StructuredStubProvider(EmbeddingProvider):
    """Deterministic embeddings clustered around K latent centroids (+ small noise) so REAL UMAP/HDBSCAN
    find stable clusters with few outliers — no model download, no all-outlier degeneracy, no flakiness."""

    K = 6

    def __init__(self) -> None:
        rng = np.random.default_rng(0)
        c = rng.standard_normal((self.K, DIM)).astype(np.float32)
        self._centroids = c / np.linalg.norm(c, axis=1, keepdims=True)

    @property
    def model_name(self) -> str:
        return "structured-stub"

    @property
    def dimension(self) -> int:
        return DIM

    def embed(self, texts: list[str]) -> np.ndarray:
        import hashlib

        out = np.zeros((len(texts), DIM), dtype=np.float32)
        for i, t in enumerate(texts):
            seed = int(hashlib.sha256(t.encode()).hexdigest()[:12], 16)
            bucket = seed % self.K
            noise = np.random.default_rng(seed).standard_normal(DIM).astype(np.float32)
            v = self._centroids[bucket] + 0.12 * noise
            out[i] = v / (np.linalg.norm(v) or 1.0)
        return out


def test_run_pipeline_real_clustering_smoke(tmp_path):
    """Drive the REAL clustering path (UMAP + HDBSCAN + BERTopic via ``topic_model_dictionaries``) end to
    end in preview mode — NO monkeypatch, NO LLM. Guards the class of empty-collection / real-clustering
    crashes (#8 ``len()``, #11 ``np.stack([])``) that slip through every other run_pipeline test because
    they all fake ``topic_model_dictionaries``. Deterministic structured embeddings keep it stable.
    """
    pytest.importorskip("bertopic")
    pytest.importorskip("umap")
    pytest.importorskip("hdbscan")

    cohort = tmp_path / "cohort.csv"
    cohort.write_text("var,desc\n" + "\n".join(f"v{i},Health measure about topic {i}" for i in range(40)) + "\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\tdefinition\n" + "\n".join(f"CDE{i}\tCommon data element definition {i}" for i in range(60)) + "\n"
    )
    dict_specs = [
        {"path": str(cohort), "cohort_name": "CohortA", "column_roles": {"variable_name": "var", "description": "desc"}}
    ]
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {"variable_name": "designation", "description": "definition"},
    }
    config = {"run_mode": "preview", "cde_cohort": "NIH_CDE", "work_dir": str(tmp_path)}

    # No stage_overrides -> the adapter takes the real preview branch: real cluster + retrieve, no LLM.
    result = run_pipeline(dict_specs, cde_spec, config, provider=_StructuredStubProvider())

    assert result["contractVersion"] == "5"
    assert result["mode"] == "preview"
    assert result["phases"] and "clustering" in result["phases"]
    assert isinstance(result["atlas"], list) and len(result["atlas"]) >= 1  # 40 cohort fields projected
    assert result["fieldIndex"]  # per-field detail populated from the embedded cohort
    # Preview enrichment (contract v4): the deterministic front half surfaces clusters + RETRIEVED CDE
    # candidates (no LLM ran), so a preview shows something to look at instead of a bare status string.
    preview_clusters = result.get("previewClusters")
    assert isinstance(preview_clusters, list) and preview_clusters, "preview should surface >=1 cluster"
    for pc in preview_clusters:
        assert pc["clusterId"] and pc["nMembers"] >= 1
        assert isinstance(pc["members"], list) and isinstance(pc["candidates"], list)
        assert len(pc["members"]) <= pc["nMembers"]  # capped sample, never more than the true size
        for cand in pc["candidates"]:
            assert cand["cdeId"] and isinstance(cand["cosine"], float)


def test_run_pipeline_auto_derives_min_cluster_size_when_unset(monkeypatch, tmp_path):
    """A run that does NOT pin ``min_cluster_size`` must auto-scale it from the corpus size.

    Regression: the auto-scale branch summed field counts with ``len(dd)`` on a ``DataDictionary``
    (no ``__len__``) → ``TypeError: object of type 'DataDictionary' has no len()``. Every real UI run
    hits this branch (only the bundled demos pin ``min_cluster_size``, which is why demos worked and
    fresh user runs crashed). Assert the auto path completes and produces a valid result.
    """
    a = tmp_path / "cohortA.csv"
    a.write_text("var,desc\nage,Age in years\nsmoke,Do you smoke\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")

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
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "novel", "cde_id": None, "ranking": [], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    # NOTE: config deliberately omits "min_cluster_size" — forces the _auto_min_cluster_size branch.
    result = run_pipeline(
        [{"path": str(a), "cohort_name": "CohortA", "column_roles": {"variable_name": "var", "description": "desc"}}],
        {
            "path": str(cde),
            "cohort_name": "NIH_CDE",
            "column_roles": {"variable_name": "designation", "description": "definition"},
        },
        {"run_mode": "batch", "cde_cohort": "NIH_CDE", "work_dir": str(tmp_path)},
        provider=StubProvider(),
        stage_overrides=overrides,
    )
    assert result["contractVersion"] == "5"


def test_seed_demos_prepopulates_a_complete_run():
    """seed_demos hydrates the bundled precomputed demo(s) as COMPLETE runs, so Runs is never empty on boot."""
    store = JobStore()
    ids = seed_demos(store)
    assert ids, "expected at least one bundled demo snapshot to seed"
    jid = demo_job_id(["aou", "clsa", "ukbb", "mesa", "aireadi"])
    assert jid in ids
    job = store.get(jid)
    assert job is not None and job.status == "complete" and job.phase == "complete"
    assert job.config.get("demo") is True
    assert job.summary_dict()["nRecords"] > 0
    # idempotent: re-seeding neither duplicates nor clobbers the existing run
    assert seed_demos(store) == []
    assert store.get(jid) is job


# ── durable per-user run persistence ─────────────────────────────────────────


def test_jobdb_roundtrip_scope_and_recover(tmp_path):
    """The durable store round-trips a full record, lists per-owner (summary only), and reconciles stale runs."""
    db = JobDB(tmp_path / "jobs.db")
    a = Job(
        job_id="a", display_name="A", status="complete", owner_subject="user_A",
        result={"records": [{"id": "r1"}, {"id": "r2"}]}, config={"x": 1}, dict_specs=[{"path": "/tmp/a.csv"}],
    )  # fmt: skip
    b = Job(job_id="b", display_name="B", status="running", owner_subject="user_B")
    db.upsert(a)
    db.upsert(b)

    got = db.get("a")
    assert got["owner_subject"] == "user_A" and got["n_records"] == 2
    assert got["result"]["records"][0]["id"] == "r1" and got["dict_specs"][0]["path"] == "/tmp/a.csv"

    rows_a = db.list_owned("user_A")
    assert [r["job_id"] for r in rows_a] == ["a"]
    assert "result" not in rows_a[0] and rows_a[0]["n_records"] == 2  # summary omits the heavy blob
    assert rows_a[0]["config"] == {"x": 1}  # ...but keeps the small config (UI needs run_mode/demo)
    assert [r["job_id"] for r in db.list_owned("user_B")] == ["b"]

    # A worker that died mid-run (non-terminal on disk) is reconciled to error; terminal rows untouched.
    assert db.recover_stale() == 1
    assert db.get("b")["status"] == "error" and db.get("a")["status"] == "complete"

    db.delete("a")
    assert db.get("a") is None
    db.close()


def test_jobstore_scopes_persists_and_hydrates(tmp_path):
    """JobStore write-through: per-owner list scoping, demos unpersisted, evicted runs served from the DB."""
    s = JobStore(db=JobDB(tmp_path / "jobs.db"))
    s.create("demo1", "Demo", {"demo": True})  # pinned/ownerless -> public, NOT persisted
    s.create("ja", "A run", {}, owner_subject="user_A")
    s.update("ja", status="complete", result={"records": [{"id": "r"}]})
    s.create("jb", "B run", {}, owner_subject="user_B")
    s.update("jb", status="complete", result={"records": []})

    # A sees own run + the demo, never B's; the demo is not written to the durable store.
    assert {j.job_id for j in s.list("user_A")} == {"ja", "demo1"}
    assert {j.job_id for j in s.list("user_B")} == {"jb", "demo1"}
    assert s.db.get("demo1") is None and s.db.get("ja") is not None

    # Age every run and evict from memory: the demo survives, owned terminal runs drop from RAM but persist.
    for j in list(s._jobs.values()):
        j.updated_at = 0.0
    s.purge_expired()
    assert "ja" not in s._jobs and "demo1" in s._jobs
    hydrated = s.get("ja")
    assert hydrated is not None and hydrated.result["records"][0]["id"] == "r"
    assert any(j.job_id == "ja" for j in s.list("user_A"))  # still in the owner's history

    # A verdict recorded on the evicted (DB-only) run is persisted.
    assert s.set_decision("ja", "r", "approve", axis="match")
    assert s.db.get("ja")["decisions"]["r"]["decision"] == "approve"
    s.db.close()


def test_persistence_survives_a_new_store(tmp_path):
    """A fresh JobStore over the same DB file sees prior runs — the restart-survival guarantee."""
    dbp = tmp_path / "jobs.db"
    s1 = JobStore(db=JobDB(dbp))
    s1.create("keep", "Keeps", {}, owner_subject="user_A")
    s1.update("keep", status="complete", result={"records": [{"id": "x"}]})
    s1.db.close()

    s2 = JobStore(db=JobDB(dbp))  # simulate a process restart
    assert s2.get("keep") is not None and s2.get("keep").result["records"][0]["id"] == "x"
    assert [j.job_id for j in s2.list("user_A")] == ["keep"]
    s2.db.close()


# ── run-error reporting (failing stage capture + persistence) ────────────────


def test_runner_captures_failing_phase(monkeypatch):
    """A run that dies mid-pipeline records the STAGE it failed in (failed_phase), not just status=error —
    and that stage flows into to_dict(), which feeds the 'Report this problem' link."""
    from backend import runner as runner_module

    def boom(
        dict_specs, cde_spec, config, *, progress, provider=None, stage_overrides=None, api_key=None, stopping=None
    ):
        progress("assigning", 3, 10)  # got partway before dying
        raise RuntimeError("assign stage exploded")

    monkeypatch.setattr(runner_module, "run_pipeline", boom)
    s = JobStore()
    s.create("jf", "Failing run", {"run_mode": "batch"})
    runner_module.run_harmonization(s, "jf", [], None, {"run_mode": "batch"})

    job = s.get("jf")
    assert job.status == "error" and job.phase == "error"
    assert job.failed_phase == "assigning"  # the stage it was in, preserved before the "error" overwrite
    assert "exploded" in (job.error_message or "")
    assert job.to_dict()["failedPhase"] == "assigning"


# ── run cancellation (Stop) ──────────────────────────────────────────────────


def test_request_cancel_sets_mode_only_on_live_nonterminal():
    """request_cancel records a stop MODE on a live run (default discard); no-op for unknown/terminal. The
    raw mode never leaks to the client — only a derived ``stopping`` bool does."""
    s = JobStore()
    s.create("j1", "R", {"run_mode": "batch"})
    assert s.request_cancel("j1") is True  # default mode
    assert s.cancel_mode("j1") == "discard" and s.is_cancel_requested("j1") is True
    assert s.get("j1").to_dict()["stopping"] is True  # derived flag surfaces while non-terminal
    assert s.request_cancel("j1", "keep") is True  # last mode wins (escalate/rewrite)
    assert s.cancel_mode("j1") == "keep"
    assert s.request_cancel("j1", "bogus") is True and s.cancel_mode("j1") == "discard"  # invalid -> discard
    assert s.request_cancel("nope") is False  # unknown job
    s.update("j1", status="complete", phase="complete")
    assert s.request_cancel("j1") is False  # already terminal -> nothing to stop
    d = s.get("j1").to_dict()
    assert "cancel_mode" not in d and "cancelMode" not in d  # raw mode never serialized
    assert d["stopping"] is False  # terminal -> not stopping


def test_runner_cancellation_marks_cancelled(monkeypatch):
    """A stop requested mid-run makes the runner abort at the NEXT progress checkpoint and mark the job
    ``cancelled`` (terminal, not ``error``): no error_message, and no stage past the checkpoint runs."""
    from backend import runner as runner_module

    reached: list[str] = []

    def pipeline(
        dict_specs, cde_spec, config, *, progress, provider=None, stage_overrides=None, api_key=None, stopping=None
    ):
        progress("embedding", 1, 3)  # first checkpoint: not yet cancelled -> proceeds
        reached.append("embedding")
        progress("assigning", 0, 10)  # Stop was pressed by now -> this checkpoint raises RunCancelledError
        reached.append("assigning")  # must NOT be reached
        return {"records": []}

    s = JobStore()
    s.create("jc", "Cancelling run", {"run_mode": "batch"})

    # Simulate the user pressing Stop right after the first tick: flag the job once it enters "embedding".
    real_update = s.update

    def update_then_stop(job_id, **fields):
        real_update(job_id, **fields)
        if fields.get("phase") == "embedding":
            s.request_cancel(job_id)

    monkeypatch.setattr(s, "update", update_then_stop)
    monkeypatch.setattr(runner_module, "run_pipeline", pipeline)
    runner_module.run_harmonization(s, "jc", [], None, {"run_mode": "batch"})

    job = s.get("jc")
    assert job.status == "cancelled" and job.phase == "cancelled"
    assert job.error_message is None  # a stop is not a failure
    assert reached == ["embedding"]  # aborted before the assigning stage issued any work


def test_cancel_endpoint():
    """POST /jobs/{id}/cancel records the requested stop mode (default discard; ?mode=keep), is a no-op on a
    terminal run, and 404s on an unknown run — mirroring the other job routes' ownership/visibility."""
    app_module.store.create("live1", "Live", {"run_mode": "batch"})  # pending, ownerless -> visible, live
    r = client.post("/api/harmonize/jobs/live1/cancel")  # default -> discard
    assert r.status_code == 200 and r.json()["cancelled"] is True
    assert app_module.store.cancel_mode("live1") == "discard"

    app_module.store.create("live2", "Live2", {"run_mode": "batch"})
    r_keep = client.post("/api/harmonize/jobs/live2/cancel", params={"mode": "keep"})
    assert r_keep.status_code == 200 and r_keep.json()["cancelled"] is True
    assert app_module.store.cancel_mode("live2") == "keep"

    app_module.store.create("done1", "Done", {})
    app_module.store.update("done1", status="complete", phase="complete")
    r2 = client.post("/api/harmonize/jobs/done1/cancel")
    assert r2.status_code == 200 and r2.json()["cancelled"] is False  # terminal -> nothing to stop

    assert client.post("/api/harmonize/jobs/does-not-exist/cancel").status_code == 404


def test_runner_keep_stop_preserves_partial_result(monkeypatch):
    """A 'keep' stop lets the pipeline return its partial result; the runner marks the run cancelled WITH that
    result (not discarded), and doesn't raise — the inverse of the discard path."""
    from backend import runner as runner_module

    partial = {"records": [{"id": "r1"}, {"id": "r2"}]}

    def pipeline(
        dict_specs, cde_spec, config, *, progress, provider=None, stage_overrides=None, api_key=None, stopping=None
    ):
        progress("generating", 0, 1)  # keep mode -> progress does NOT raise; the stage finishes
        assert stopping() == "keep"  # the runner threaded the live stop mode through
        return partial  # engine finished the in-flight stage, skipped the rest -> partial result

    s = JobStore()
    s.create("jk", "Keep run", {"run_mode": "batch"})
    s.request_cancel("jk", "keep")
    monkeypatch.setattr(runner_module, "run_pipeline", pipeline)
    runner_module.run_harmonization(s, "jk", [], None, {"run_mode": "batch"})

    job = s.get("jk")
    assert job.status == "cancelled" and job.phase == "cancelled"
    assert job.result == partial  # partial result KEPT
    assert job.error_message is None


def test_batch_stage_skips_not_yet_started_stage_on_keep(monkeypatch, tmp_path):
    """A 'keep' stop already in effect when a later stage begins skips that stage entirely — it never submits
    a batch — so no downstream cost is incurred after the Stop."""
    from types import SimpleNamespace

    from backend.engine import adapter as adapter_mod

    submitted = {"resume": False}

    def fake_resume_and_wait(prompts_path, output_path, *, api_key=None, **kw):
        submitted["resume"] = True  # must NOT be reached

    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", fake_resume_and_wait)
    monkeypatch.setattr("ddharmon.harmonization.write_prompts_jsonl", lambda prompts, path: None)

    from ddharmon.llm.cost import CostLedger

    stage = adapter_mod._batch_stage(
        "assigning", lambda *a, **k: None, tmp_path, "assign", CostLedger(), stopping=lambda: "keep"
    )
    assert stage([SimpleNamespace(id="p1")]) == {}  # skipped -> empty responses
    assert submitted["resume"] is False  # the batch was never submitted


def test_batch_stage_aborts_mid_poll_on_cancel(monkeypatch, tmp_path):
    """A Stop during a Batch-API poll aborts within a heartbeat instead of waiting out resume_and_wait.

    The blocking batch wait runs off-thread; the stage calls progress() on a short interval, and progress
    (the runner's cancellation signal) raises RunCancelledError when Stop was pressed. Regression guard for
    the batch-mode Stop being deferred until the whole batch returned.
    """
    import threading
    from types import SimpleNamespace

    from backend.engine import adapter as adapter_mod
    from backend.runner import RunCancelledError

    monkeypatch.setattr(adapter_mod, "_BATCH_POLL_SECS", 0.02)
    release = threading.Event()  # gates the fake batch so it's still "polling" when we cancel

    def fake_resume_and_wait(prompts_path, output_path, *, api_key=None, **kw):
        release.wait(timeout=5)  # block like a live batch poll until released in teardown

    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", fake_resume_and_wait)
    monkeypatch.setattr("ddharmon.harmonization.write_prompts_jsonl", lambda prompts, path: None)

    calls = {"n": 0}

    def progress(phase, completed=0, total=0, cost=None):
        calls["n"] += 1
        if calls["n"] >= 2:  # Stop pressed: raise on the first heartbeat after the start tick
            raise RunCancelledError

    from ddharmon.llm.cost import CostLedger

    stage = adapter_mod._batch_stage("generating", progress, tmp_path, "generate", CostLedger())
    try:
        with pytest.raises(RunCancelledError):
            stage([SimpleNamespace(id="p1")])  # non-empty so the stage actually runs the wait
    finally:
        release.set()  # let the abandoned daemon thread exit cleanly


def test_sync_stage_runs_concurrently_and_aggregates_realized_cost():
    """A sync stage fans its prompts across the pool, returns every response, and folds the clients' realized
    token usage into the ledger (sync = full price) — surfacing the running total on the progress callback."""
    from types import SimpleNamespace

    from ddharmon.llm.cost import CostLedger, TokenUsage

    from backend.engine import adapter as adapter_mod

    class _FakeClient:
        def __init__(self) -> None:
            self.usage_log: list = []

        def complete(self, prompt, *, system=None, max_tokens=512):
            self.usage_log.append(TokenUsage("claude-sonnet-4-6", 1000, 500))  # 1000 in @ $3/M + 500 out @ $15/M
            return {"echo": prompt}

        def drain_usage(self):
            log = self.usage_log
            self.usage_log = []
            return log

    ledger = CostLedger()
    seen_cost: list[float] = []

    def progress(phase, completed=0, total=0, cost=None):
        if cost is not None:
            seen_cost.append(cost)

    prompts = [SimpleNamespace(id=f"p{i}", system_prompt="sys", schema="{}", user_prompt=f"u{i}") for i in range(5)]
    stage = adapter_mod._sync_stage("assigning", progress, _FakeClient(), ledger)
    out = stage(prompts)

    assert set(out) == {f"p{i}" for i in range(5)}  # every prompt answered despite concurrency
    # 5 calls × (1000/1e6·$3 + 500/1e6·$15) = 5 × $0.0105 = $0.0525
    assert abs(ledger.total_usd - 0.0525) < 1e-6
    assert ledger.to_dict()["perStage"]["assigning"]["calls"] == 5
    assert seen_cost and abs(seen_cost[-1] - 0.0525) < 1e-6  # the live running total was reported


def test_batch_stage_prices_preserved_usage_at_half(monkeypatch, tmp_path):
    """A batch stage reads the usage the retrieve now preserves in the responses JSONL and prices it at the
    Batch 50% discount, folding it into the ledger."""
    from types import SimpleNamespace

    from ddharmon.llm.cost import CostLedger

    from backend.engine import adapter as adapter_mod

    def fake_resume_and_wait(prompts_path, output_path, *, api_key=None, **kw):
        with open(output_path, "w") as f:
            f.write(
                json.dumps(
                    {
                        "id": "p1",
                        "response": {"ok": 1},
                        "usage": {"input_tokens": 2000, "output_tokens": 1000},
                        "model": "claude-sonnet-4-6",
                    }
                )
                + "\n"
            )

    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", fake_resume_and_wait)
    monkeypatch.setattr("ddharmon.harmonization.write_prompts_jsonl", lambda prompts, path: None)

    ledger = CostLedger()
    stage = adapter_mod._batch_stage("assigning", lambda *a, **k: None, tmp_path, "assign", ledger)
    out = stage([SimpleNamespace(id="p1", system_prompt="sys", schema="{}", user_prompt="u")])

    assert out == {"p1": {"ok": 1}}
    # (2000/1e6·$3 + 1000/1e6·$15) × 0.5 = ($0.006 + $0.015) × 0.5 = $0.0105
    assert abs(ledger.total_usd - 0.0105) < 1e-6


def test_failed_phase_persists_and_migrates(tmp_path):
    """failed_phase round-trips through the DB (incl. the runs-list summary) and is ALTER-ed into an older
    DB that predates the column — the additive-migration guarantee (a bad migration breaks the live Runs list)."""
    import sqlite3

    # An OLD-schema DB created before failed_phase (and analysis_ideas) existed — a valid legacy 'jobs' table.
    dbp = tmp_path / "jobs.db"
    old = sqlite3.connect(dbp)
    old.execute(
        "CREATE TABLE jobs (job_id TEXT PRIMARY KEY, owner_subject TEXT, display_name TEXT, status TEXT, "
        "phase TEXT, completed INTEGER, total INTEGER, error_message TEXT, result TEXT, config TEXT, "
        "dict_specs TEXT, decisions TEXT, n_records INTEGER, created_at REAL, updated_at REAL)"
    )
    old.execute(
        "INSERT INTO jobs (job_id, owner_subject, status, phase, created_at, updated_at) "
        "VALUES ('legacy', 'user_A', 'error', 'error', 0, 0)"
    )
    old.commit()
    old.close()

    db = JobDB(dbp)  # opening the old DB must ALTER the missing columns in, not crash
    assert db.get("legacy")["failed_phase"] is None  # legacy error row: column now present, value null

    err = Job(
        job_id="e1", display_name="E", status="error", phase="error",
        failed_phase="clustering", error_message="boom", owner_subject="user_A",
    )  # fmt: skip
    db.upsert(err)
    assert db.get("e1")["failed_phase"] == "clustering"
    summ = {r["job_id"]: r for r in db.list_owned("user_A")}
    assert summ["e1"]["failed_phase"] == "clustering"  # carried in the runs-list summary too
    db.close()


def _decode_by_token(token: str) -> dict:
    """Test tokens 'A'/'B' map to distinct Clerk subjects; anything else is rejected."""
    from backend import auth

    subs = {"A": "user_A", "B": "user_B"}
    if token not in subs:
        raise auth.AuthError(401, "bad token")
    return {"sub": subs[token], "email": f"{subs[token]}@example.org"}


def test_runs_scoped_per_user_via_api(monkeypatch, tmp_path):
    """End-to-end ownership: user B can neither list, read, delete, nor verdict user A's run (404, not 403)."""
    from backend import auth

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setattr(auth, "_decode_claims", _decode_by_token)

    with TestClient(app_module.app) as c:  # `with` runs the lifespan -> attaches the DB
        app_module.store.create("ja", "A run", {}, owner_subject="user_A")
        app_module.store.update("ja", status="complete", result={"records": [{"id": "r"}]})

        def hdr(t: str) -> dict:
            return {"authorization": f"Bearer {t}"}

        list_a = c.get("/api/harmonize/jobs", headers=hdr("A")).json()
        assert any(j["jobId"] == "ja" for j in list_a)
        assert c.get("/api/harmonize/result/ja", headers=hdr("A")).status_code == 200

        assert not any(j["jobId"] == "ja" for j in c.get("/api/harmonize/jobs", headers=hdr("B")).json())
        assert c.get("/api/harmonize/result/ja", headers=hdr("B")).status_code == 404
        assert c.delete("/api/harmonize/jobs/ja", headers=hdr("B")).status_code == 404
        verdict = c.post(
            "/api/harmonize/jobs/ja/verdict", headers=hdr("B"), json={"recordId": "r", "decision": "approve"}
        )
        assert verdict.status_code == 404


def test_rerun_clones_uploads_as_new_owned_run(monkeypatch, tmp_path):
    """Re-run copies a past run's retained uploads into a fresh owned job; another user can't re-run it."""
    from backend import auth

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": tmp_path / "cde.tsv"})
    (tmp_path / "cde.tsv").write_text("designation\tdefinition\nX\tY\n")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setattr(auth, "_decode_claims", _decode_by_token)

    started: dict = {}

    def fake_run(store, job_id, dict_specs, cde_spec, config, *, api_key=None):
        started.update(job_id=job_id, dict_specs=dict_specs, cde_spec=cde_spec)
        store.update(job_id, status="complete", result={"records": []})

    monkeypatch.setattr(app_module, "run_harmonization", fake_run)

    with TestClient(app_module.app) as c:
        src_up = tmp_path / "work" / "src" / "uploads"
        src_up.mkdir(parents=True)
        (src_up / "a.csv").write_text("var,desc\nage,Age\n")
        app_module.store.create(
            "src", "My run",
            {"work_dir": str(tmp_path / "work" / "src"), "cde_set": "endorsed", "run_mode": "preview"},
            owner_subject="user_A",
            dict_specs=[{"path": str(src_up / "a.csv"), "cohort_name": "A",
                         "column_roles": {"variable_name": "var", "description": "desc"}}],
        )  # fmt: skip
        app_module.store.update("src", status="complete", result={"records": []})

        assert c.post("/api/harmonize/jobs/src/rerun", headers={"authorization": "Bearer B"}).status_code == 404

        resp = c.post("/api/harmonize/jobs/src/rerun", headers={"authorization": "Bearer A"})
        assert resp.status_code == 200
        new_id = resp.json()["jobId"]
        assert new_id != "src"
        new_upload = tmp_path / "work" / new_id / "uploads" / "a.csv"
        assert new_upload.exists()  # uploads copied synchronously before the run is spawned
        assert app_module.store.get(new_id).owner_subject == "user_A"

        for _ in range(200):  # the run itself is spawned in a thread
            if started:
                break
            time.sleep(0.01)
        assert started["job_id"] == new_id
        assert started["dict_specs"][0]["path"] == str(new_upload)  # remapped into the new job dir
        assert started["cde_spec"]["path"].endswith("cde.tsv")


def test_analysis_ideas_digest_and_grounding():
    """Digest keeps only cross-cohort concepts (the pooling signal), and generation drops any idea whose
    concepts are hallucinated (not present in this run)."""
    from backend.analysis_ideas import build_concept_digest, generate_analysis_ideas

    records = [
        {"concept": "Smoking status", "cohorts": ["A", "B"], "verdict": "adopt", "cde": {"id": "SmokeCDE"}, "nMembers": 4},
        {"concept": "CVD", "cohorts": ["A", "B", "C"], "verdict": "refine", "cde": None, "nMembers": 6},
        {"concept": "Local-only", "cohorts": ["A"], "verdict": "novel", "cde": None, "nMembers": 1},
    ]  # fmt: skip
    digest = build_concept_digest(records)
    assert {d["concept"] for d in digest} == {"Smoking status", "CVD"}  # single-cohort concept dropped
    assert digest[0]["concept"] == "CVD"  # most cohorts first

    def fake_complete(prompt, *, system=None, max_tokens=512):
        return json.dumps(
            {
                "ideas": [
                    {"title": "Pooled smoking→CVD", "hypothesis": "h", "concepts": ["Smoking status", "CVD"],
                     "cohorts": ["A", "B"], "method": "logistic regression", "whyNewlyPossible": "w", "category": "association"},
                    {"title": "Hallucinated", "hypothesis": "h", "concepts": ["Made-up concept"],
                     "cohorts": ["A"], "method": "m", "whyNewlyPossible": "w", "category": "x"},
                ]
            }
        )  # fmt: skip

    out = generate_analysis_ideas(records, fake_complete)
    assert out["nConcepts"] == 2
    titles = [i["title"] for i in out["ideas"]]
    assert "Pooled smoking→CVD" in titles and "Hallucinated" not in titles  # ungrounded idea dropped


def test_parse_ideas_salvages_truncated_json():
    """A verbose response that hits the token cap mid-array (invalid JSON) must not collapse to zero — the
    complete idea objects are salvaged and the incomplete trailing one is dropped."""
    from backend.analysis_ideas import _parse_ideas

    truncated = (
        '{"ideas":[{"title":"One","hypothesis":"h","concepts":["A"],"cohorts":["X"],"method":"m",'
        '"whyNewlyPossible":"w","category":"c"},{"title":"Two","hypothesis":"cut off here and never clo'
    )
    ideas = _parse_ideas(truncated, allowed={"A", "B"})
    assert len(ideas) == 1
    assert ideas[0]["title"] == "One" and ideas[0]["concepts"] == ["A"]


def test_build_llm_client_pins_model_and_routes():
    """The shared client-builder honors the run's picked Claude model (the SDK's own default is a stale
    snapshot), falls back to a current default, strips a proxy prefix, and buckets providers correctly."""
    from backend.engine.llm import DEFAULT_CLAUDE_MODEL, build_llm_client, is_anthropic_model

    assert is_anthropic_model(None) and is_anthropic_model("claude-sonnet-4-6") and is_anthropic_model("anthropic/x")
    assert not is_anthropic_model("gpt-4o") and not is_anthropic_model("gemini/gemini-1.5-pro")
    # Anthropic path (construction is lazy — no API call): model pinned / defaulted / de-prefixed.
    assert build_llm_client("claude-sonnet-4-6", "k").model_name == "claude-sonnet-4-6"
    assert build_llm_client(None, "k").model_name == DEFAULT_CLAUDE_MODEL
    assert build_llm_client("anthropic/claude-opus-4-8", "k").model_name == "claude-opus-4-8"


def test_generate_ideas_during_run_uses_the_runs_model(monkeypatch):
    """When opted in (and not preview), the run generates ideas with the SAME model/provider/key it used —
    no second key entry. build_llm_client is monkeypatched so no real LLM call is made."""
    from backend import runner as runner_module

    captured: dict = {}

    class _FakeClient:
        def complete(self, prompt, *, system=None, max_tokens=512):
            return '{"ideas": []}'  # exercised generation; no cross-cohort idea survives here

    def fake_build(model_tag, api_key):
        captured["model_tag"] = model_tag
        captured["api_key"] = api_key
        return _FakeClient()

    monkeypatch.setattr("backend.engine.llm.build_llm_client", fake_build)
    result = {"records": [{"concept": "BP", "cohorts": ["A", "B"], "verdict": "adopt", "cde": None, "nMembers": 2}]}
    config = {"gen_analysis_ideas": True, "run_mode": "sync", "model_tag": "claude-sonnet-4-6"}

    ideas = runner_module._generate_ideas(result, config, "sk-test")
    assert ideas == []  # generation ran (empty result), not skipped
    assert captured == {"model_tag": "claude-sonnet-4-6", "api_key": "sk-test"}


def test_generate_ideas_skipped_when_not_applicable():
    """No ideas pass for a preview run, an opted-out run, or a run with no records (all non-fatal → None)."""
    from backend import runner as runner_module

    recs = {"records": [{"concept": "BP", "cohorts": ["A", "B"]}]}
    assert runner_module._generate_ideas(recs, {"gen_analysis_ideas": True, "run_mode": "preview"}, "k") is None
    assert runner_module._generate_ideas(recs, {"gen_analysis_ideas": False, "run_mode": "sync"}, "k") is None
    assert runner_module._generate_ideas({"records": []}, {"gen_analysis_ideas": True, "run_mode": "sync"}, "k") is None


def test_sync_run_builds_client_with_the_picked_model(monkeypatch, tmp_path):
    """Sync mode constructs its LLM client via build_llm_client with the run's PICKED model_tag (not the
    SDK's stale default, which 404s and ignored the picker). The spy raises at construction, so no real
    stage / LLM call runs — we only assert the model routing."""
    a = tmp_path / "cohortA.csv"
    a.write_text("var,desc\nage,Age in years\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")

    def fake_topic_model(embedded, **kwargs):
        docs, embeddings, field_refs, cohorts = collect_inputs(embedded)
        members = [r for r in field_refs if r.dictionary_name != "NIH_CDE"]
        return TopicModelResult(
            model=None, docs=docs, embeddings=embeddings, field_refs=field_refs,
            clusters=[FieldCluster(cluster_id=0, label="all", members=members)],
            outlier_cluster=None, all_cohort_names=cohorts,
        )  # fmt: skip

    monkeypatch.setattr("ddharmon.clustering.topic_engine.topic_model_dictionaries", fake_topic_model)

    captured: dict = {}

    class _StopError(Exception):
        pass

    def spy_build(model_tag, api_key):
        captured.update(model_tag=model_tag, api_key=api_key)
        raise _StopError()  # stop before any real LLM call

    monkeypatch.setattr("backend.engine.llm.build_llm_client", spy_build)

    dict_specs = [{"path": str(a), "cohort_name": "A", "column_roles": {"variable_name": "var", "description": "desc"}}]
    cde_spec = {
        "path": str(cde), "cohort_name": "NIH_CDE",
        "column_roles": {"variable_name": "designation", "description": "definition"},
    }  # fmt: skip
    config = {"run_mode": "sync", "cde_cohort": "NIH_CDE", "work_dir": str(tmp_path), "model_tag": "claude-opus-4-8"}

    with pytest.raises(_StopError):
        run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), api_key="sk-test")
    assert captured == {"model_tag": "claude-opus-4-8", "api_key": "sk-test"}


def test_analysis_ideas_endpoint_caches_scopes_and_gates(monkeypatch, tmp_path):
    """The endpoint generates via one BYOK LLM call, caches (no re-bill), regenerates on demand, scopes to
    the owner (404 for others), and 409s when the run has no concepts."""
    from backend import auth

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setattr(auth, "_decode_claims", _decode_by_token)

    calls = {"n": 0}

    class StubClient:
        def __init__(self, *a, **k):
            pass

        def complete(self, prompt, *, system=None, max_tokens=512):
            calls["n"] += 1
            return json.dumps(
                {"ideas": [{"title": "Pooled smoking→CVD", "hypothesis": "h", "concepts": ["Smoking"],
                            "cohorts": ["A", "B"], "method": "m", "whyNewlyPossible": "w", "category": "association"}]}
            )  # fmt: skip

    monkeypatch.setattr("ddharmon.llm.anthropic_client.AnthropicClient", StubClient)

    def hdr(t: str) -> dict:
        return {"authorization": f"Bearer {t}", "x-anthropic-key": "sk-test"}

    with TestClient(app_module.app) as c:
        app_module.store.create("ja", "A run", {}, owner_subject="user_A")
        app_module.store.update(
            "ja",
            status="complete",
            result={
                "records": [
                    {"concept": "Smoking", "cohorts": ["A", "B"], "verdict": "adopt", "cde": None, "nMembers": 3}
                ]
            },
        )
        # user B can't generate for A's run
        assert c.post("/api/harmonize/jobs/ja/analysis-ideas", headers=hdr("B")).status_code == 404
        # A generates (one LLM call)
        b1 = c.post("/api/harmonize/jobs/ja/analysis-ideas", headers=hdr("A")).json()
        assert b1["cached"] is False and len(b1["ideas"]) == 1 and calls["n"] == 1
        # second call is served from cache (no second LLM call)
        b2 = c.post("/api/harmonize/jobs/ja/analysis-ideas", headers=hdr("A")).json()
        assert b2["cached"] is True and calls["n"] == 1
        # ?regenerate=true forces a fresh pass
        b3 = c.post("/api/harmonize/jobs/ja/analysis-ideas?regenerate=true", headers=hdr("A")).json()
        assert b3["cached"] is False and calls["n"] == 2

        # a run with no concepts -> 409, not a crash
        app_module.store.create("empty", "Empty", {}, owner_subject="user_A")
        app_module.store.update("empty", status="complete", result={"records": []})
        assert c.post("/api/harmonize/jobs/empty/analysis-ideas", headers=hdr("A")).status_code == 409


def test_purge_exempts_demo_but_evicts_user_runs():
    """The TTL purge evicts stale terminal USER runs but never the prepopulated (pinned) demo run."""
    store = JobStore()
    store.create("user-1", "User run", {})
    store.update("user-1", status="complete", result={"records": []})
    seed_demos(store)
    jid = demo_job_id(["aou", "clsa", "ukbb", "mesa", "aireadi"])
    for j in store.list():  # age every run well past the TTL
        j.updated_at = 0.0
    store.purge_expired()
    assert store.get("user-1") is None  # ordinary terminal run aged out
    assert store.get(jid) is not None  # demo run is pinned → survives


# ── 08-09: the coherence judge in the PRODUCT path, the opt-ins, and Gate 1's group shape ─────
#
# The debt these close: before this, `harmonize_leanb()` in the product injected neither `coherence=`
# nor `distinct_kinds=`, so the judge never executed at all and every shipped artifact had an incoherent
# count of zero (WINDOWS id3 / STGD-02's adapter half). Twelve triage signals were dark for the same or
# an adjacent reason. None of the tests below make a paid call: the stages are injected callables, so a
# "real run" here means a real PIPELINE run with no provider anywhere in it.


def _one_cluster_topic_model():
    """A fake BERTopic that pools every non-CDE field into ONE cluster (the CDEs are the backbone)."""

    def fake_topic_model(embedded, **kwargs):
        docs, embeddings, field_refs, cohorts = collect_inputs(embedded)
        members = [r for r in field_refs if r.dictionary_name != "NIH_CDE"]
        cluster = FieldCluster(cluster_id=0, label="all", members=members)
        return TopicModelResult(
            model=None,
            docs=docs,
            embeddings=embeddings,
            field_refs=field_refs,
            clusters=[cluster],
            outlier_cluster=None,
            all_cohort_names=cohorts,
        )

    return fake_topic_model


def _judge_fixture(tmp_path, monkeypatch, *, n_per_cohort: int = 5):
    """A two-cohort run whose single concept group is big enough for the judge to be ASKED about it.

    ``prepare_coherence`` builds no prompt below its member floor (a small group is left explicitly
    unjudged), so a fixture with three variables would exercise the wiring and prove nothing about the
    judge. ``n_per_cohort=5`` gives ten members, comfortably above the floor.
    """
    rows_a = "".join(f"v{i},Blood pressure reading {i} taken at the clinic,\n" for i in range(n_per_cohort))
    rows_b = "".join(f"w{i},Blood pressure measurement {i} recorded by nurse,\n" for i in range(n_per_cohort))
    a = tmp_path / "cohortA.csv"
    a.write_text("var,desc,enc\n" + rows_a)
    b = tmp_path / "cohortB.csv"
    b.write_text("var,desc,enc\n" + rows_b)
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\tdefinition\tpermissible_values\nBpCDE\tBlood pressure\tmmHg\nPulseCDE\tPulse rate\tbpm\n"
    )
    roles = {"variable_name": "var", "description": "desc", "value_encoding": "enc"}
    dict_specs = [
        {"path": str(a), "cohort_name": "CohortA", "column_roles": roles},
        {"path": str(b), "cohort_name": "CohortB", "column_roles": roles},
    ]
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {
            "variable_name": "designation",
            "description": "definition",
            "value_encoding": "permissible_values",
        },
    }
    monkeypatch.setattr("ddharmon.clustering.topic_engine.topic_model_dictionaries", _one_cluster_topic_model())
    config = {
        "run_mode": "batch",
        "cde_cohort": "NIH_CDE",
        "work_dir": str(tmp_path),
        "min_cluster_size": 2,
        "retrieval_floor": 0.0,
        "gen_transform_specs": True,
    }
    return dict_specs, cde_spec, config


def _split_verdict(recs):
    """A judge response that flags every group it is asked about as an over-merge (verdict `split`)."""
    return {
        r.id: {
            "coherent": False,
            "summary": "systolic, diastolic and pulse fused into one group",
            "granularity": {"verdict": "split", "axis": "measurand", "distinct_values": ["systolic", "pulse"]},
            "outliers": [1],
        }
        for r in recs
    }


def _spy_kwargs(monkeypatch, seen):
    """Record every kwarg the adapter hands ``harmonize_leanb`` (functools.wraps keeps the real signature,
    or the adapter's own inspect.signature guards would skip the very kwarg under test)."""
    import functools

    import ddharmon.harmonization as core

    orig = core.harmonize_leanb

    @functools.wraps(orig)
    def spy(embedded, **kw):
        seen.update(kw)
        return orig(embedded, **kw)

    monkeypatch.setattr(core, "harmonize_leanb", spy)


def _no_op_batch_stages(monkeypatch, built):
    """Replace the Batch-API stage factory with a recorder — proves which stages the PRODUCT path builds
    without constructing a client, submitting a batch or spending anything."""
    from backend.engine import adapter as ad

    def fake_batch_stage(phase, progress, work_dir, tag, ledger, api_key=None, stopping=None, ledger_key=None):
        built.append({"phase": phase, "tag": tag, "cost": ledger_key or phase})

        def stage(prompts):
            return {}

        return stage

    monkeypatch.setattr(ad, "_batch_stage", fake_batch_stage)


def test_adapter_injects_coherence_runners(monkeypatch, tmp_path):
    """STGD-02's adapter half. The PRODUCT path (batch mode, no injected overrides) must hand core BOTH
    judge runners — otherwise the judge never executes and every Gate 1 row reads as coherent."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    seen, built = {}, []
    _spy_kwargs(monkeypatch, seen)
    _no_op_batch_stages(monkeypatch, built)

    run_pipeline(dict_specs, cde_spec, config, provider=StubProvider())

    assert seen.get("coherence") is not None, "the product path injected no coherence runner"
    assert seen.get("distinct_kinds") is not None, "the product path injected no distinct-kinds runner (R2)"
    tags = {b["tag"] for b in built}
    assert {"coherence", "kinds"} <= tags, f"expected judge stages to be built, got {sorted(tags)}"


def test_judge_precedes_assign(monkeypatch, tmp_path):
    """The judge's verdict pass runs after `split` and BEFORE `classify` (08-04's reorder). Gate 1 pauses
    at the classify boundary, so a verdict stamped after assign does not exist when the screen needs it."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    order = []

    def _stage(name, payload):
        def stage(recs):
            order.append(name)
            return payload(recs)

        return stage

    overrides = {
        "generate": _stage("generate", lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs}),
        "split": _stage("split", lambda recs: {}),
        "coherence": _stage("coherence", _split_verdict),
        "classify": _stage(
            "classify",
            lambda recs: {r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs},
        ),
        "specgen": _stage("specgen", lambda recs: {}),
    }
    run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert "coherence" in order, "the coherence runner was never called"
    assert "classify" in order
    assert order.index("coherence") < order.index("classify")
    assert order.index("split") < order.index("coherence")


def test_a_real_run_flags_at_least_one_group_incoherent(monkeypatch, tmp_path):
    """The truth WINDOWS id3 records as unmet: every shipped artifact had an incoherent count of zero,
    because the judge never ran. With the runner injected, a flagged group reaches the wire."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "coherence": _split_verdict,
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert any(r["incoherent"] for r in result["records"]), "no record reached the wire flagged incoherent"
    assert any(r["coherence"] == "split" for r in result["records"])
    flagged = next(r for r in result["records"] if r["incoherent"])
    assert flagged["coherenceAxis"] == "measurand"
    assert flagged["coherenceDistinctValues"] == ["systolic", "pulse"]
    assert flagged["coherenceSummary"]
    # a FLAG, not a gate: the group is surfaced, never auto-split into children
    assert not any(r.get("readjudicatedFrom") for r in result["records"])


def test_the_free_win_signals_reach_the_wire(monkeypatch, tmp_path):
    """matrix_suspect / coherence_gap / adopt_demoted are computed on every run today and were merely
    unmapped (08-RESEARCH §Item #10). Presence of the key is the assertion — an absent key is what made
    them dark."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "coherence": _split_verdict,
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)
    rec = result["records"][0]
    for key in ("matrixSuspect", "coherenceGap", "adoptDemoted", "coherence", "incoherent", "coherenceKind"):
        assert key in rec, f"{key} is still dark on the wire"


def test_a_judge_error_arrives_as_not_judged_never_as_coherent(monkeypatch, tmp_path):
    """T-08-46. A runner that raises or times out must not unwind a run whose paid stages completed, and
    must not leave the group looking blessed. Both halves: the run finishes, and the cell says not_judged."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)

    def exploding_judge(recs):
        raise TimeoutError("the judge timed out")

    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "coherence": exploding_judge,
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert result["records"], "a judge failure must not cost the run its paid records"
    assert all(r["coherence"] == "not_judged" for r in result["records"])
    assert not any(r["incoherent"] for r in result["records"])


def test_an_older_core_without_the_judge_keywords_still_completes(monkeypatch, tmp_path):
    """T-08-49. Prod pins core to a PyPI version and dev to a git ref, so the adapter must degrade on an
    optional enhancement rather than raise. Stub a signature with none of the new keywords."""
    import functools

    import ddharmon.harmonization as core

    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    orig = core.harmonize_leanb
    seen = {}

    def legacy(
        embedded_dicts,
        generate=None,
        split=None,
        classify=None,
        gencde=None,
        specgen=None,
        cde_cohort="NIH_CDE",
        min_cluster_size=15,
        top_k=25,
        retrieval_floor=0.0,
        model_tag="",
        substrate=None,
    ):
        seen["called"] = True
        return orig(
            embedded_dicts,
            generate=generate,
            split=split,
            classify=classify,
            gencde=gencde,
            specgen=specgen,
            cde_cohort=cde_cohort,
            min_cluster_size=min_cluster_size,
            top_k=top_k,
            retrieval_floor=retrieval_floor,
        )

    monkeypatch.setattr(core, "harmonize_leanb", functools.wraps(orig)(legacy) if False else legacy)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "coherence": _split_verdict,
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)
    assert seen.get("called") is True
    assert result["records"]
    # nothing was judged (the pinned core cannot), and that reads as not_judged — not as clean
    assert all(r["coherence"] == "not_judged" for r in result["records"])


# ── the opt-in concept gate (STGD-16) ────────────────────────────────────────────────────────


def test_concept_gate_off_by_default(monkeypatch, tmp_path):
    """T-08-54. A run must never be charged for a stage it did not ask for, so 'off' means NO runner is
    constructed at all — not a runner that returns early."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    seen, built = {}, []
    _spy_kwargs(monkeypatch, seen)
    _no_op_batch_stages(monkeypatch, built)

    run_pipeline(dict_specs, cde_spec, config, provider=StubProvider())

    assert seen.get("concept_gate") is None, "the concept gate ran without being asked for"
    assert "concept_gate" not in {b["tag"] for b in built}, "a provider stage was constructed for a declined gate"


def test_concept_gate_on_emits_signal(monkeypatch, tmp_path):
    """With the opt-in set, the concept-mismatch signal is a REAL value on the wire and leaves the
    not-computed register."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    config["concept_gate"] = True
    seen = {}
    _spy_kwargs(monkeypatch, seen)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "coherence": _split_verdict,
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
        "concept_gate": lambda recs: {r.id: {"match": False, "reason": "different measurand"} for r in recs},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert seen.get("concept_gate") is not None
    assert any(r["conceptMismatch"] for r in result["records"]), "the gate ran but its signal never landed"
    registered = {e["signal"] for e in result["notComputed"]}
    assert "concept_mismatch" not in registered


def test_the_register_rides_on_the_result_and_explains_a_declined_opt_in(monkeypatch, tmp_path):
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "coherence": _split_verdict,
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)
    by_signal = {e["signal"]: e for e in result["notComputed"]}
    assert by_signal["concept_mismatch"]["kind"] == "per_run"
    assert by_signal["readjudicated_from"]["kind"] == "per_run"
    assert by_signal["preprocessing_rule_provenance"]["kind"] == "permanent"
    assert all(e["reason"].strip() for e in result["notComputed"])


# ── re-adjudication: caller-invoked, explicit group ids, never automatic ──────────────────────


def test_readjudicate_requires_explicit_group_ids(monkeypatch, tmp_path):
    """T-08-53 and the standing prohibition. Core's own docstring makes human triggering the contract:
    'the pipeline never re-splits automatically'. An empty or absent id list must be REFUSED, not
    defaulted to every record carrying the incoherent flag — that fallback IS the prohibited
    auto-resolution, and it is one keystroke away in core (`group_ids=None` selects every flagged
    record)."""
    from backend.engine.adapter import readjudicate_groups

    called = {"n": 0}

    def _never(prompts):
        called["n"] += 1
        return {}

    result = LeanBResult(records=_canned_records())
    for bad in ([], None):
        with pytest.raises(ValueError, match="group_ids"):
            readjudicate_groups(result, [], group_ids=bad, split=_never, classify=_never)
    assert called["n"] == 0, "a refused re-adjudication must not run (or pay for) a single stage"


def test_readjudicate_carries_the_provenance_signal_on_its_children(monkeypatch, tmp_path):
    """A re-split child names the parent group it was carved from, so a reviewer can see that a row is a
    re-adjudication product rather than an original grouping."""
    from backend.engine import adapter as ad

    seen = {}

    def fake_core_readjudicate(result, embedded, embeddings, field_refs, **kw):
        seen.update(kw)
        parent = result.records[0]
        child = LeanBRecord(
            cluster_id=parent.cluster_id,
            group_id=f"{parent.group_id}#r0",
            verdict="novel",
            route="gencde_residual",
            readjudicated_from=parent.group_id,
        )
        result.records = [child]
        return result

    monkeypatch.setattr(ad, "_core_readjudicate", lambda: fake_core_readjudicate)
    monkeypatch.setattr(ad, "_collect_inputs", lambda embedded: ([], [], []))

    result = LeanBResult(records=_canned_records())
    gid = result.records[0].group_id or result.records[0].cluster_id
    out = ad.readjudicate_groups(result, [], group_ids=[gid], split=lambda p: {}, classify=lambda p: {})

    assert seen["group_ids"] == [gid], "the explicit id list must reach core verbatim"
    assert [r["readjudicatedFrom"] for r in out] == [gid]


def test_readjudicate_degrades_on_a_core_that_lacks_it(monkeypatch):
    """An older pinned core has no `readjudicate`; the caller gets its records back unchanged rather than
    an exception, and the register still says the provenance signal was not computed."""
    from backend.engine import adapter as ad

    def _absent():
        raise ImportError("no readjudicate in this core")

    monkeypatch.setattr(ad, "_core_readjudicate", _absent)
    result = LeanBResult(records=_canned_records())
    gid = result.records[0].group_id or result.records[0].cluster_id
    out = ad.readjudicate_groups(result, [], group_ids=[gid], split=lambda p: {}, classify=lambda p: {})
    assert len(out) == len(result.records)
    assert not any(r.get("readjudicatedFrom") for r in out)


# ── Gate 1's group shape: deterministic order, collapsed cap, uncapped expansion ──────────────


def _stub_groups(*specs):
    """A LeanBResult carrying just enough ConceptGroup shape for the mapper (order as given)."""
    from types import SimpleNamespace

    return SimpleNamespace(
        concept_groups=[
            SimpleNamespace(
                cluster_id=cid,
                group_id=gid,
                concept=f"concept {gid}",
                ideal_cde="ideal",
                top1_cos=None,
                member_variable_names=[f"CohortA:v{i}" for i in range(n)],
                cohorts=["CohortA"],
                cross_cohort=False,
                n_members=n,
                coherent=True,
                coherence_verdict=verdict,
                coherence_summary="",
                coherence_axis="",
                coherence_distinct_values=[],
                coherence_outliers=[],
                coherence_kind="",
                incoherent=verdict == "split",
                matrix_suspect=False,
            )
            for cid, gid, n, verdict in specs
        ]
    )


def test_concept_group_order_is_stable_and_tie_broken_by_id():
    from backend.engine.adapter import _concept_groups_to_ui

    a = _stub_groups(("c2", "c2#g0", 4, ""), ("c1", "c1#g0", 4, ""), ("c3", "c3#g0", 9, ""))
    b = _stub_groups(("c1", "c1#g0", 4, ""), ("c3", "c3#g0", 9, ""), ("c2", "c2#g0", 4, ""))
    order_a = [g["groupId"] for g in _concept_groups_to_ui(a)]
    order_b = [g["groupId"] for g in _concept_groups_to_ui(b)]
    assert order_a == order_b == ["c3#g0", "c1#g0", "c2#g0"]


def test_an_expanded_group_row_carries_every_member():
    """A collapsed row carries a capped SAMPLE plus the TRUE count; the expanded read carries all of it.
    A regroup verb writes back the membership it was shown, so against a 25-of-40 sample it would silently
    drop the 15 members it never saw."""
    from backend.engine.adapter import _GROUP_MEMBER_CAP, build_ui_result, expand_concept_group

    stub = _stub_groups(("c1", "c1#g0", 40, ""))
    result = build_ui_result(
        LeanBResult(records=[], concept_groups=stub.concept_groups), mode="batch", phases=["loading"]
    )
    group = result["conceptGroups"][0]
    assert group["nMembers"] == 40
    assert len(group["memberVariableNames"]) == _GROUP_MEMBER_CAP
    assert group["membersTruncated"] is True
    assert len(expand_concept_group(result, "c1#g0")) == 40


def test_a_group_the_judge_skipped_is_not_judged_not_coherent():
    from backend.engine.adapter import _concept_groups_to_ui

    groups = _concept_groups_to_ui(_stub_groups(("c1", "c1#g0", 3, ""), ("c2", "c2#g0", 9, "split")))
    by_id = {g["groupId"]: g for g in groups}
    assert by_id["c1#g0"]["coherence"] == "not_judged"
    assert by_id["c1#g0"]["incoherent"] is False
    assert by_id["c2#g0"]["coherence"] == "split"
    assert by_id["c2#g0"]["incoherent"] is True
    assert all(g["conceptIsGenerated"] is True for g in groups)


# ── preview run mode: a shipped $0 capability this phase does not remove ──────────────────────


def test_preview_cluster_order_stable():
    """Deterministic across repeated requests, INCLUDING when two clusters have equal member counts. The
    predecessor sorted on member count alone, so equal-sized clusters kept whatever order the prompts came
    back in — and 'the list reordered itself between two looks at the same paused run' is indistinguishable
    from the run having changed."""
    from types import SimpleNamespace

    from backend.engine.adapter import _preview_clusters

    def ctx(cid, n):
        return SimpleNamespace(
            context={
                "cluster_id": cid,
                "n_members": n,
                "members": [],
                "candidates": [],
                "cohorts": [],
                "cross_cohort": False,
                "top1_cos": None,
            }
        )

    a = SimpleNamespace(ideal_prompts=[ctx("c2", 5), ctx("c1", 5), ctx("c3", 9)])
    b = SimpleNamespace(ideal_prompts=[ctx("c1", 5), ctx("c3", 9), ctx("c2", 5)])
    ids_a = [c["clusterId"] for c in _preview_clusters(a)]
    ids_b = [c["clusterId"] for c in _preview_clusters(b)]
    assert ids_a == ids_b == ["c3", "c1", "c2"]


def test_preview_returns_clusters(monkeypatch, tmp_path):
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    config["run_mode"] = "preview"
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider())
    assert result["previewClusters"], "preview mode returned no clusters"
    assert {"clusterId", "nMembers", "members", "candidates"} <= set(result["previewClusters"][0])


def test_preview_mode_still_returns_preview_clusters(monkeypatch, tmp_path):
    """Gate 1 no longer reads `previewClusters` (its rows are post-split concept groups, UI-SPEC §0.1),
    but preview run mode is a SHIPPED $0 capability that calls no model and this phase does not remove it.
    Deleting the field because Gate 1 stopped reading it would silently take that capability with it."""
    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    config["run_mode"] = "preview"
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider())
    assert result["previewClusters"]
    # and a preview never reaches the Gate 1 boundary, so it has no groups — the two are not substitutes
    assert result["conceptGroups"] == []


# ── 08-09 Task 3: preprocessing RUNS in the product path, and its report reaches the wire ─────
#
# The escalation 08-RESEARCH found: Gate 0 did not merely lack a report — `preprocess_dictionary` was
# never called in the product at all, so there was no behaviour to report on. Turning it on CHANGES THE
# EMBEDDED TEXT, hence the clustering, hence every downstream result: runs from before and after this
# change are NOT comparable, and the pinned demo has to be regenerated (08-21).


def _dup_name_dictionary(tmp_path):
    """A dictionary whose variable name repeats — `load_dictionary` keys on it, so a row VANISHES."""
    from ddharmon.ingestion import load_dictionary

    path = tmp_path / "dupes.csv"
    path.write_text("var,desc\nage,Age in years\nage,Age at last birthday\nsex,Sex at birth\n")
    dd = load_dictionary(str(path), cohort_name="Dup", variable_name="var", description="desc")
    return path, dd


def test_pipeline_preprocesses(monkeypatch, tmp_path):
    """Preprocessing runs BETWEEN loading and embedding, for every source dictionary, and its report
    reaches the UI through the contract."""
    from ddharmon.ingestion import preprocessor as pre

    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    seen = []
    orig = pre.preprocess_dictionary

    def spy(dd, **kw):
        seen.append(getattr(dd, "cohort_name", None) or dd.name)
        return orig(dd, **kw)

    monkeypatch.setattr(pre, "preprocess_dictionary", spy)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert sorted(seen) == ["CohortA", "CohortB"], f"preprocessing ran on {seen}"
    # The CDE backbone is deliberately NOT preprocessed — see the adapter's note (core owns CDE text
    # hygiene via `clean_cde_text`, and these rules would mutate the retrieval backbone).
    assert "NIH_CDE" not in seen
    reports = result["preprocessing"]
    assert {r["cohort"] for r in reports} == {"CohortA", "CohortB"}
    assert all(r["ran"] and not r["failed"] for r in reports)
    assert all(r["rules"] for r in reports)


def test_preprocessing_counts_match_field_count(tmp_path):
    """Counts are over dictionary ROWS. A rule's denominator is the number of variables it was applied
    to, and the report's `nVariables` is the file's row count — so the arithmetic closes against a number
    the reviewer can see on their own file."""
    from ddharmon.ingestion import load_dictionary

    from backend.engine.adapter import preprocess_for_run

    path = tmp_path / "d.csv"
    path.write_text("var,desc\n" + "".join(f"v{i},Description number {i}\n" for i in range(7)))
    dd = load_dictionary(str(path), cohort_name="C", variable_name="var", description="desc")
    report = preprocess_for_run(dd, source_path=path)

    assert report["nVariables"] == 7
    assert report["nUniqueVariableNames"] == 7
    assert report["nDuplicateVariableNames"] == 0
    assert report["nUniqueVariableNames"] + report["nDuplicateVariableNames"] == report["nVariables"]
    assert all(rule["nVariables"] == 7 for rule in report["rules"])
    assert all(0 <= rule["nChanged"] <= rule["nVariables"] for rule in report["rules"])


def test_preprocessing_reports_the_row_count_and_the_unique_name_count(tmp_path):
    """The silent last-wins drop, surfaced. `load_dictionary` keys fields on the variable name, so a
    repeated name makes a variable VANISH with no error — a known and expensive debugging cost here."""
    from backend.engine.adapter import preprocess_for_run

    path, dd = _dup_name_dictionary(tmp_path)
    report = preprocess_for_run(dd, source_path=path)

    assert report["nVariables"] == 3, "the file has three data rows"
    assert report["nUniqueVariableNames"] == 2, "one row was dropped, last-wins, on the repeated name"
    assert report["nDuplicateVariableNames"] == 1


def test_no_rules_fired_is_distinct(tmp_path):
    """Three distinguishable claims, and the two that get collapsed are opposites: 'the rule ran and
    found nothing to fix' versus 'the rule never ran'."""
    from ddharmon.ingestion import load_dictionary

    from backend.engine.adapter import preprocess_for_run

    path = tmp_path / "clean.csv"
    path.write_text("var,desc\nalpha,A tidy description\nbeta,Another tidy description\n")
    dd = load_dictionary(str(path), cohort_name="C", variable_name="var", description="desc")
    report = preprocess_for_run(dd, source_path=path)

    by_rule = {r["rule"]: r for r in report["rules"]}
    # whitespace normalisation always runs; nothing here needs it
    assert by_rule["whitespace_normalization"]["outcome"] == "no_change"
    assert by_rule["whitespace_normalization"]["nChanged"] == 0
    # stopword removal has nothing configured, so it genuinely did NOT run — a different claim
    assert by_rule["stopword_removal"]["outcome"] == "not_run"
    assert {r["outcome"] for r in report["rules"]} <= set(contract_module.RULE_OUTCOMES)
    assert "no_change" in {r["outcome"] for r in report["rules"]}
    assert "not_run" in {r["outcome"] for r in report["rules"]}


def test_a_rule_that_raised_is_a_third_state(monkeypatch, tmp_path):
    """A preprocessing failure is neither 'changed nothing' nor 'did not run' — reporting it as either
    would claim the data was checked and found clean."""
    from ddharmon.ingestion import load_dictionary
    from ddharmon.ingestion import preprocessor as pre

    from backend.engine.adapter import preprocess_for_run

    path = tmp_path / "d.csv"
    path.write_text("var,desc\nv0,A description\n")
    dd = load_dictionary(str(path), cohort_name="C", variable_name="var", description="desc")

    def boom(dd, **kw):
        raise RuntimeError("stopwords config is corrupt")

    monkeypatch.setattr(pre, "preprocess_dictionary", boom)
    report = preprocess_for_run(dd, source_path=path)

    assert report["failed"] is True
    assert "corrupt" in report["error"]
    outcomes = {r["outcome"] for r in report["rules"]}
    assert outcomes == {"failed"}, "a failure must not be reported as zero-change or not-run"
    assert all(r["error"] for r in report["rules"])
    assert all(r["nChanged"] == 0 for r in report["rules"])


def test_a_preprocessing_failure_does_not_cost_the_run_its_dictionaries(monkeypatch, tmp_path):
    """Preprocessing is a preparation step, not a decision: it must not be able to fail a paid run."""
    from ddharmon.ingestion import preprocessor as pre

    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)

    def boom(dd, **kw):
        raise RuntimeError("nope")

    monkeypatch.setattr(pre, "preprocess_dictionary", boom)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)
    assert result["records"]
    assert all(r["failed"] for r in result["preprocessing"])


def test_the_before_after_example_is_carried_as_data(tmp_path):
    """T-08-48: uploaded text is echoed back to the browser here. It travels as plain strings — nothing
    in the payload names a renderable-HTML channel, and the diff carries no rule name (the pipeline does
    not stamp per-variable provenance, and claiming it does would be the lie)."""
    from ddharmon.ingestion import load_dictionary

    from backend.engine.adapter import preprocess_for_run

    path = tmp_path / "mojibake.csv"
    path.write_text('var,desc\nv0,"Weight in kilogrammes â\x80\x94 measured"\nv1,"<b>Height</b> in cm"\n')
    dd = load_dictionary(str(path), cohort_name="C", variable_name="var", description="desc")
    report = preprocess_for_run(dd, source_path=path)

    assert report["nChangedVariables"] >= 1, "the mojibake fixture should have changed something"
    for entry in report["diff"]:
        assert isinstance(entry["rawDescription"], str)
        assert isinstance(entry["cleanedDescription"], str)
        assert "rule" not in entry
        assert not any("html" in k.lower() for k in entry)


def test_preprocessing_can_be_gated_off(monkeypatch, tmp_path):
    """A knob, because turning preprocessing on changes the embedded text and therefore every downstream
    result — a caller reproducing a pre-08-09 run needs to be able to say so."""
    from ddharmon.ingestion import preprocessor as pre

    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    config["preprocess"] = False
    seen = []
    monkeypatch.setattr(pre, "preprocess_dictionary", lambda dd, **kw: seen.append(dd) or dd)
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)
    assert seen == []
    # Absent, not an entry claiming it ran and changed nothing.
    assert result.get("preprocessing", []) == []


# ── 08-11: Setup's job-independent extraction, the opt-in re-adjudication endpoint, and the upload refusal ──


def _clerk_on(monkeypatch):
    """Turn the SSO gate on with the JWT seam faked, so a "guest" here is a caller with no token."""
    from backend import auth

    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.delenv("DDHARMON_ALLOWED_EMAIL_DOMAINS", raising=False)
    monkeypatch.setattr(auth, "_decode_claims", lambda token: {"email": token, "sub": token})


def _no_llm(monkeypatch):
    """Explode if any provider client is constructed. Asserting a cost of zero would pass for a stub that
    called out and was billed later; asserting no client exists is the property R13 actually needs."""
    import backend.engine.llm as llm_mod

    def boom(*_a, **_k):
        raise AssertionError("a provider client was constructed on a path that must not spend")

    monkeypatch.setattr(llm_mod, "build_llm_client", boom)


class _Source:
    text = "Fried frailty phenotype: five components, each scored 0 or 1."
    provenance = "uploaded document"
    sha256 = "abc123"


def test_score_extract_needs_no_run(monkeypatch):
    """Setup has to price and scope a score BEFORE a run exists, so this cannot be job-scoped: the
    job-scoped sibling requires a run id, and at Setup there is nothing to pass."""
    import backend.composite as composite_mod

    monkeypatch.setattr(composite_mod, "resolve_source", lambda **_k: _Source())
    _no_llm(monkeypatch)
    resp = client.post(
        "/api/harmonize/score/extract",
        files=[("file", ("score.pdf", b"%PDF-1.4 fake", "application/pdf"))],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"].startswith("Fried frailty phenotype")
    assert body["nChars"] == len(_Source.text)


def test_score_extract_is_auth_required_not_a_generic_error(monkeypatch):
    """A guest gets a signal the UI renders as "sign in to do this" — extraction reads an uploaded
    document, which is not a demo surface."""
    _clerk_on(monkeypatch)
    resp = client.post(
        "/api/harmonize/score/extract",
        files=[("file", ("score.pdf", b"%PDF-1.4 fake", "application/pdf"))],
    )
    assert resp.status_code == 401
    assert resp.json()["detail"]


_PARTICIPANT_CSV = (
    b"participant_id,age,bmi,sbp\n"
    b"P0001,54,26.1,131\n"
    b"P0002,61,23.8,118\n"
    b"P0003,47,31.2,142\n"
)


def _batch_config(filename="cohortA.csv"):
    return {
        "dictionaries": [
            {
                "filename": filename,
                "cohortName": "CohortA",
                "columnRoles": {"variable_name": "participant_id", "description": "age"},
            }
        ],
        "cdeSet": "endorsed",
        "runMode": "batch",
    }


def test_rejects_row_level_upload(monkeypatch, tmp_path):
    """A data dictionary is one row per VARIABLE. A file shaped like participant records is refused before
    anything is stored or transmitted — a standing product prohibition, not a Phase 8 nicety."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    started = []
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: started.append(a))

    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", _PARTICIPANT_CSV, "text/csv"))],
        data={"config": json.dumps(_batch_config())},
    )
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "one row per variable" in detail.lower()
    assert "participant_id" in detail, "the response has to name what it found"
    assert started == [], "no run may start from a rejected upload"
    assert app_module.store.get(resp.json().get("jobId", "")) is None


def test_a_real_dictionary_is_not_mistaken_for_participant_data(monkeypatch, tmp_path):
    """The refusal must be precise: dictionaries legitimately DESCRIBE participant identifiers, and a rule
    that keyed on the word alone would reject the very files this product exists to harmonize."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: None)

    dictionary = b"var,desc\nparticipant_id,Unique participant identifier\nage,Age in years\n"
    cfg = {
        "dictionaries": [
            {
                "filename": "cohortA.csv",
                "cohortName": "CohortA",
                "columnRoles": {"variable_name": "var", "description": "desc"},
            }
        ],
        "cdeSet": "endorsed",
    }
    resp = client.post(
        "/api/harmonize/batch",
        files=[("files", ("cohortA.csv", dictionary, "text/csv"))],
        data={"config": json.dumps(cfg)},
    )
    assert resp.status_code == 200, resp.text


# --- the re-adjudication endpoint: three refusals, each a prohibition made mechanical -----------


def _readjudicable_run(job_id="j-re", *, opt_in=False, config=None):
    cfg = {"readjudication": opt_in, **(config or {})}
    app_module.store.create(job_id, "A run", cfg, owner_subject=None)
    app_module.store.update(job_id, status="complete", result={"records": [{"id": "r1"}]})
    return job_id


def _spy_readjudicate(monkeypatch):
    calls = []
    import backend.engine.adapter as ad

    def spy(leanb_result, embedded, *, group_ids, **kw):
        calls.append({"group_ids": list(group_ids), "kwargs": sorted(kw)})
        return [{"id": "r1", "groupId": "g1"}]

    monkeypatch.setattr(ad, "readjudicate_groups", spy)
    return calls


def test_readjudicate_endpoint_refuses_when_opt_in_off(monkeypatch):
    """Default off. No run pays for a stage it did not ask for, and the reason has to be renderable as the
    honest "not enabled for this run" tile rather than a generic error."""
    calls = _spy_readjudicate(monkeypatch)
    _no_llm(monkeypatch)
    job_id = _readjudicable_run("j-optout", opt_in=False)
    resp = client.post(f"/api/harmonize/jobs/{job_id}/readjudicate", json={"groupIds": ["g1"]})
    assert resp.status_code == 409
    assert "not enabled" in resp.json()["detail"].lower()
    assert calls == [], "no paid work may start on the refused path"


def test_readjudicate_endpoint_refuses_empty_group_ids(monkeypatch):
    """Never fall back to "every group carrying the incoherent flag": that is auto-resolving an over-merge
    without human review, which core's own readjudicate docstring forbids the pipeline from doing."""
    calls = _spy_readjudicate(monkeypatch)
    _no_llm(monkeypatch)
    job_id = _readjudicable_run("j-noids", opt_in=True)
    for body in ({"groupIds": []}, {}):
        resp = client.post(f"/api/harmonize/jobs/{job_id}/readjudicate", json=body)
        assert resp.status_code == 400, resp.text
        assert "group" in resp.json()["detail"].lower()
    assert calls == []


def test_readjudicate_is_rejected_on_a_pinned_demo_run(monkeypatch):
    """A guest walk cannot spend money. Rejected for being pinned BEFORE the opt-in is even consulted, so
    a demo that happened to carry the flag is still refused."""
    calls = _spy_readjudicate(monkeypatch)
    _no_llm(monkeypatch)
    job_id = _readjudicable_run("j-demo-re", opt_in=True, config={"demo": True})
    resp = client.post(f"/api/harmonize/jobs/{job_id}/readjudicate", json={"groupIds": ["g1"]})
    assert resp.status_code == 403
    assert calls == []


def test_readjudicate_on_a_foreign_run_is_404_not_403(monkeypatch):
    """404 so the API never confirms that someone else's run exists."""
    _clerk_on(monkeypatch)
    app_module.store.create("j-theirs", "Theirs", {"readjudication": True}, owner_subject="somebody_else")
    app_module.store.update("j-theirs", status="complete", result={"records": []})
    resp = client.post(
        "/api/harmonize/jobs/j-theirs/readjudicate",
        json={"groupIds": ["g1"]},
        headers={"Authorization": "Bearer me@example.com"},
    )
    assert resp.status_code == 404


def test_readjudicate_forwards_exactly_the_named_groups(monkeypatch, tmp_path):
    """The opt-in run's happy path: the endpoint hands core's seam the ids the human named and nothing else,
    and the run's records are updated in place."""
    calls = _spy_readjudicate(monkeypatch)
    import backend.engine.adapter as ad

    monkeypatch.setattr(ad, "replay_leanb_result", lambda *a, **k: (object(), []))
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    job_id = _readjudicable_run("j-ok", opt_in=True, config={"work_dir": str(tmp_path / "j-ok")})
    resp = client.post(f"/api/harmonize/jobs/{job_id}/readjudicate", json={"groupIds": ["g1", "g2"]})
    assert resp.status_code == 200, resp.text
    assert calls and calls[0]["group_ids"] == ["g1", "g2"]
    assert app_module.store.get(job_id).result["records"] == [{"id": "r1", "groupId": "g1"}]
    assert app_module.store.get(job_id).status == "complete", "re-deciding must not un-finish the run"


# --- the $0 front-half replay that rebuilds core's inputs (WINDOWS id22) ------------------------


def test_replay_rebuilds_core_inputs_without_calling_a_single_stage(monkeypatch, tmp_path):
    """08-09 left `readjudicate_groups` needing a LeanBResult + embedded dictionaries, which the backend
    does not persist — the checkpoint holds the CONTRACT shape. This rebuilds both by replaying the
    deterministic front half against the frozen substrate and the recorded stage answers, and it is $0 by
    CONSTRUCTION: the stages it installs cannot call out, they can only look an answer up."""
    from backend.engine.adapter import replay_leanb_result

    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    config = {**config, "stop_at_gate": None, "coherence": False}
    recorded: dict = {}
    overrides = {
        "generate": lambda recs: {r.id: {"ideal_cde": "ideal"} for r in recs},
        "split": lambda recs: {},
        "classify": lambda recs: {
            r.id: {"verdict": "adopt", "cde_id": "1", "ranking": [1], "rationale": "m"} for r in recs
        },
        "specgen": lambda recs: {},
    }
    first = run_pipeline(
        dict_specs,
        cde_spec,
        config,
        provider=StubProvider(),
        stage_overrides=overrides,
        stage_responses=recorded,
        substrate_path=tmp_path / "substrate.joblib",
    )
    assert recorded, "the fixture run recorded no stage answers, so there is nothing to replay"

    calls = []
    result, embedded = replay_leanb_result(
        dict_specs,
        cde_spec,
        config,
        replay_responses=recorded,
        provider=StubProvider(),
        substrate_path=tmp_path / "substrate.joblib",
        on_missing=lambda stage, ids: calls.append((stage, ids)),
    )
    assert calls == [], f"the replay had to buy new work: {calls}"
    assert embedded, "the replay returned no embedded dictionaries for core to re-derive inputs from"
    assert [r.id for r in result.records] == [r["id"] for r in first["records"]]


def test_replay_refuses_without_recorded_answers(monkeypatch, tmp_path):
    """A run that was never staged has no recorded answers, so there is nothing to replay and the honest
    outcome is a refusal — not a silent re-run that charges for the whole front half again."""
    from backend.engine.adapter import ReplayUnavailableError, replay_leanb_result

    dict_specs, cde_spec, config = _judge_fixture(tmp_path, monkeypatch)
    with pytest.raises(ReplayUnavailableError, match="recorded"):
        replay_leanb_result(dict_specs, cde_spec, config, replay_responses={}, provider=StubProvider())
