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
    assert body["contractVersion"] == "2"
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
    assert result["contractVersion"] == "2"
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

    assert result["contractVersion"] == "2"
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

    assert result["contractVersion"] == "2"
    assert result["mode"] == "preview"
    assert result["phases"] and "clustering" in result["phases"]
    assert isinstance(result["atlas"], list) and len(result["atlas"]) >= 1  # 40 cohort fields projected
    assert result["fieldIndex"]  # per-field detail populated from the embedded cohort


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
    assert result["contractVersion"] == "2"


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

    def boom(dict_specs, cde_spec, config, *, progress, provider=None, stage_overrides=None, api_key=None):
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


def test_request_cancel_only_flags_live_nonterminal():
    """request_cancel flags a live in-flight run; it's a no-op for an unknown or already-terminal run."""
    s = JobStore()
    s.create("j1", "R", {"run_mode": "batch"})
    assert s.request_cancel("j1") is True
    assert s.get("j1").cancel_requested is True and s.is_cancel_requested("j1") is True
    assert s.request_cancel("nope") is False  # unknown job
    s.update("j1", status="complete", phase="complete")
    assert s.request_cancel("j1") is False  # already terminal -> nothing to stop
    # cancel_requested is transient: it never surfaces in the serialized job (must not leak to the client)
    assert "cancel_requested" not in s.get("j1").to_dict()
    assert "cancelRequested" not in s.get("j1").to_dict()


def test_runner_cancellation_marks_cancelled(monkeypatch):
    """A stop requested mid-run makes the runner abort at the NEXT progress checkpoint and mark the job
    ``cancelled`` (terminal, not ``error``): no error_message, and no stage past the checkpoint runs."""
    from backend import runner as runner_module

    reached: list[str] = []

    def pipeline(dict_specs, cde_spec, config, *, progress, provider=None, stage_overrides=None, api_key=None):
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
    """POST /jobs/{id}/cancel flags a live run (cancelled=True), is a no-op on a terminal run (False), and
    404s on an unknown run — mirroring the ownership/visibility of the other job routes."""
    app_module.store.create("live1", "Live", {"run_mode": "batch"})  # pending, ownerless -> visible, live
    r = client.post("/api/harmonize/jobs/live1/cancel")
    assert r.status_code == 200 and r.json()["cancelled"] is True
    assert app_module.store.get("live1").cancel_requested is True

    app_module.store.create("done1", "Done", {})
    app_module.store.update("done1", status="complete", phase="complete")
    r2 = client.post("/api/harmonize/jobs/done1/cancel")
    assert r2.status_code == 200 and r2.json()["cancelled"] is False  # terminal -> nothing to stop

    assert client.post("/api/harmonize/jobs/does-not-exist/cancel").status_code == 404


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
