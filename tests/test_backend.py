"""Tests for the ddharmon GUI backend (backend/) — v2 split-aware contract.

Covers: /detect role suggestion, /health, the in-memory JobStore, the contract mapping
(``_record_to_ui`` / ``build_ui_result`` — the single churn-absorbing surface), the full HTTP flow with a
fake runner (canned UIResult), and a deterministic end-to-end ``run_pipeline`` with the three leanb LLM
stages mocked + BERTopic and embeddings monkeypatched (no model download / API key / network).
"""

from __future__ import annotations

import json
import time

import numpy as np
from ddharmon.clustering.topic_engine import collect_inputs
from ddharmon.embedding.provider import EmbeddingProvider
from ddharmon.harmonization.leanb import LeanBResult
from ddharmon.harmonization.models import CandidateCDE, LeanBRecord, TransformKind, TransformSpec
from ddharmon.models.cluster import FieldCluster, TopicModelResult
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.engine.adapter import build_ui_result, run_pipeline
from backend.jobs import JobStore

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
    assert body["contractVersion"] == "1"
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
    assert result["contractVersion"] == "1"
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


# ── full HTTP flow with a fake runner ──────────────────────────

_CANNED_RESULT = build_ui_result(LeanBResult(records=_canned_records()), mode="batch", phases=["loading"])


def test_batch_flow_with_fake_runner(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    # Point the CDE catalog at a real (if tiny) file so start_batch's existence check passes.
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    def fake_runner(store, job_id, dict_specs, cde_spec, config, *, provider=None, stage_overrides=None):
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
    """v2 requires a CDE backbone — cdeSet=none (or any non-endorsed/full) is rejected."""
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

    assert result["contractVersion"] == "1"
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
