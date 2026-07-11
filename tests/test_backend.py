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
from ddharmon.clustering.topic_engine import collect_inputs
from ddharmon.embedding.provider import EmbeddingProvider
from ddharmon.harmonization.leanb import LeanBResult
from ddharmon.harmonization.models import CandidateCDE, LeanBRecord, TransformKind, TransformSpec
from ddharmon.models.cluster import FieldCluster, TopicModelResult
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.demos import demo_job_id, seed_demos
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
    # No member_index given -> memberDetails falls back to the "cohort:var" id parts.
    assert rec0["memberDetails"][0] == {
        "id": "CohortA:age",
        "cohort": "CohortA",
        "name": "age",
        "text": "age",
    }


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
    assert header[-1] == "transformDecisions"
    ti = header.index("transformDecisions")
    row = next(r for r in rows[1:] if r[0] == "c1#g0")
    tj = json.loads(row[ti])
    assert tj["CohortB:age_yrs"]["decision"] == "refine"
    assert row[header.index("humanDecision")] == "refine"  # match axis unchanged

    # decisions CSV likewise carries the per-variable transform verdicts in its own trailing column
    dec_csv = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "decisions_csv"})
    drows = list(csv.reader(io.StringIO(dec_csv.text)))
    dheader = drows[0]
    assert dheader[-1] == "transformDecisions"
    drow = next(r for r in drows[1:] if r[0] == "c1#g0")
    assert json.loads(drow[dheader.index("transformDecisions")])["CohortB:age_yrs"]["decision"] == "refine"

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
    assert result["contractVersion"] == "1"


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
