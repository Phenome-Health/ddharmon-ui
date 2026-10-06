"""Full auto (08-30): a run that commits every gate with the pipeline's own proposals and continues by itself.

What Full auto promises, each pinned below on a REAL run (the real ``run_pipeline``, with the embedding provider,
the topic model and every LLM stage stubbed — no provider call, no key used, no cost):

* it walks Gate 1 -> Gate 4 with NO Continue request, through the same internal path Continue uses — so the same
  $0 replay of every earlier leg's paid stages;
* Gate 1's scope is every group, and each auto-committed gate is recorded as decided by ``auto``;
* the BYOK key is carried leg to leg in memory only — never on disk, in the database or in a log line;
* Stop works exactly as on a guided leg, a failed leg stops it, and a run that has no key (or whose server
  restarted) stays parked at the gate it reached, waiting for a manual Continue.

Guided is pinned byte for byte in ``test_guided_golden.py``; nothing here may change it.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from ddharmon.clustering.topic_engine import collect_inputs
from ddharmon.embedding.provider import EmbeddingProvider
from ddharmon.models.cluster import FieldCluster, TopicModelResult
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import runner as runner_module
from backend.checkpoint import checkpoint_path, read_checkpoint, write_checkpoint
from backend.db import JobDB
from backend.jobs import AWAITING_REVIEW, JobStore

DIM = 32
SECRET = "sk-test-SECRET-full-auto-7f3a"


class StubProvider(EmbeddingProvider):
    """Deterministic hash-based embeddings — no model download, no network."""

    @property
    def model_name(self) -> str:
        return "stub-full-auto"

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


@pytest.fixture
def two_clusters(monkeypatch):
    """Two clusters (smoking, age) over the cohort variables — so "every group" means more than one."""

    def fake_topic_model(embedded, **kwargs):
        docs, embeddings, field_refs, cohorts = collect_inputs(embedded)
        src = [r for r in field_refs if r.dictionary_name != "NIH_CDE"]
        smoke = [r for r in src if r.variable_name.startswith("SMOKE")]
        age = [r for r in src if r.variable_name.startswith("AGE")]
        return TopicModelResult(
            model=None,
            docs=docs,
            embeddings=embeddings,
            field_refs=field_refs,
            clusters=[
                FieldCluster(cluster_id=0, label="smoke", members=smoke),
                FieldCluster(cluster_id=1, label="age", members=age),
            ],
            outlier_cluster=None,
            all_cohort_names=cohorts,
        )

    monkeypatch.setattr("ddharmon.clustering.topic_engine.topic_model_dictionaries", fake_topic_model)


def _stages(sink: dict[str, int], hooks: dict | None = None) -> dict:
    """Counting stand-ins for every stage a staged run reaches. ``hooks[name]`` runs before that stage answers."""
    hooks = hooks or {}

    def _count(name, fn):
        def stage(prompts):
            sink[name] = sink.get(name, 0) + len(prompts)
            if name in hooks:
                hooks[name](prompts)
            return fn(prompts)

        return stage

    return {
        "generate": _count("generate", lambda recs: {r.id: {"ideal_cde": "Smoking status"} for r in recs}),
        "split": _count("split", lambda recs: {}),
        "coherence": _count(
            "coherence",
            lambda recs: {
                r.id: {"coherent": True, "summary": "one concept", "granularity": {"verdict": "single"}} for r in recs
            },
        ),
        "classify": _count("classify", lambda recs: {r.id: {"verdict": "adopt", "cde_id": "1"} for r in recs}),
        "gencde": _count("gencde", lambda recs: {}),
        "specgen": _count("specgen", lambda recs: {}),
    }


_CSV = {
    "a.csv": "var,desc,enc\nSMOKE_A,Do you currently smoke cigarettes,1=Yes|0=No\nSMOKE_A2,Ever smoked,1=Yes|0=No\n"
    "AGE_A,Age in years,\nAGE_A2,Age at enrolment in years,\n",
    "b.csv": "var,desc,enc\nSMOKE_B,Current cigarette smoker,Y=Yes|N=No\nSMOKE_B2,Smoked 100 cigarettes,Y=Yes|N=No\n"
    "AGE_B,Age at visit,\nAGE_B2,Participant age,\n",
}
_ROLES = {"variable_name": "var", "description": "desc", "value_encoding": "enc"}


@pytest.fixture
def rig(monkeypatch, tmp_path, two_clusters):
    """The app on a temp work root + catalog, every leg run by the REAL runner with stubbed stages.

    ``legs`` records each worker leg's config and its own stage-call counts; ``hooks`` lets a test step into a
    stage (block it, fail it). ``ANTHROPIC_API_KEY`` is unset, so the only key anywhere is the one a test sends.
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\ttinyId\tdefinition\tquestion_text\tdatatype\tpermissible_values\tclassification\tconcept_codes\n"
        "SmokeCDE\tS1\tSmoking status\t\tValue List\t1=Yes|0=No\t\t\n"
        "AgeCDE\tA1\tAge in years\t\tNumber\t\t\t\n"
    )
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})

    legs: list[dict] = []
    hooks: dict = {}
    real = runner_module.run_harmonization

    def leg(store, job_id, dict_specs, cde_spec, config, **kwargs):
        calls: dict[str, int] = {}
        legs.append({"config": dict(config), "kwargs": sorted(kwargs), "calls": calls})
        real(
            store,
            job_id,
            dict_specs,
            cde_spec,
            {**config, "min_cluster_size": 2, "retrieval_floor": 0.0},
            provider=StubProvider(),
            stage_overrides=_stages(calls, hooks),
            **kwargs,
        )

    monkeypatch.setattr(app_module, "run_harmonization", leg)

    def no_http_resume(*a, **k):  # the auto path must never call the route function
        raise AssertionError("Full auto called the HTTP Continue route")

    monkeypatch.setattr(app_module, "resume_run", no_http_resume)

    def no_provider(*a, **k):  # every stage is stubbed; anything reaching for a real client is a test failure
        raise AssertionError("a test reached for a real LLM client")

    monkeypatch.setattr("backend.engine.llm.build_llm_client", no_provider)
    with TestClient(app_module.app) as client:
        yield client, legs, hooks, tmp_path


def _start(client, *, review_mode: str | None = "auto", key: str | None = SECRET) -> str:
    cfg: dict = {
        "dictionaries": [
            {"filename": "a.csv", "cohortName": "CohortA", "columnRoles": _ROLES},
            {"filename": "b.csv", "cohortName": "CohortB", "columnRoles": _ROLES},
        ],
        "cdeSet": "endorsed",
        "runMode": "batch",
        "suggestAnalysisIdeas": False,
    }
    if review_mode is not None:
        cfg["reviewMode"] = review_mode
    r = client.post(
        "/api/harmonize/batch",
        files=[("files", (name, body.encode(), "text/csv")) for name, body in _CSV.items()],
        data={"config": json.dumps(cfg)},
        headers={"x-anthropic-key": key} if key else {},
    )
    assert r.status_code == 200, r.text
    return r.json()["jobId"]


def _wait(predicate, *, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("timed out waiting for the run")


def _settled(job_id: str):
    """Parked with nobody continuing it, or terminal — a state nothing will move by itself."""

    def check() -> bool:
        job = app_module.store.get(job_id)
        if job is None:
            return False
        if job.status in ("complete", "error", "cancelled"):
            return True
        return job.status == AWAITING_REVIEW and not job.auto_advance

    return check


# ── the walk ────────────────────────────────────────────────────────────────────────────────────────────────


def test_an_auto_run_walks_gate_1_to_gate_4_by_itself(rig, caplog):
    client, legs, _hooks, tmp = rig
    caplog.set_level(logging.DEBUG)
    job_id = _start(client)
    _wait(_settled(job_id))

    job = app_module.store.get(job_id)
    assert (job.status, job.gate_position) == (AWAITING_REVIEW, "gate4"), job.error_message
    assert job.error_message is None
    work = Path(job.config["work_dir"])
    for gate in ("gate1", "gate2", "gate3", "gate4"):
        assert checkpoint_path(work, gate).exists(), f"no {gate} checkpoint"
    # Three worker legs (Gate 1, Gate 2, Gate 3); Gate 4 is the existing pure read and spawns none.
    assert len(legs) == 3
    assert [leg["config"].get("park_at_gate") for leg in legs] == [None, "gate2", "gate3"]

    # Gate 1's scope is EVERY group, frozen exactly as a Continue freezes one.
    groups = [g["groupId"] for g in read_checkpoint(work, "gate1").result["conceptGroups"]]
    assert len(groups) >= 2, "fixture: the run should have more than one group"
    assert job.config["gate1_scope"] == groups
    assert legs[1]["config"]["assign_group_ids"] == groups
    assert "gate2_picks" not in legs[2]["config"], "Gate 3 was built for something other than the model's picks"

    # Recorded per gate, and stored like the rest of the run's config.
    assert job.config["review_mode"] == "auto"
    assert job.config["gate_decided_by"] == {"gate1": "auto", "gate2": "auto", "gate3": "auto"}

    # The SAME $0 replay a Continue gets: no later leg re-buys an earlier leg's stage.
    first, second, third = (leg["calls"] for leg in legs)
    assert first.get("generate", 0) > 0 and first.get("split", 0) >= 0
    for stage in ("generate", "split", "coherence"):
        assert second.get(stage, 0) == 0 and third.get(stage, 0) == 0, f"a later leg re-bought {stage}"
    assert second.get("classify", 0) > 0, "the Gate 2 leg did no assignment"
    assert third.get("classify", 0) == 0, "the Gate 3 leg re-bought the assignment"
    # Every leg after the first was handed its predecessor's answers and spend, as Continue hands them.
    assert legs[1]["kwargs"] == legs[2]["kwargs"] == ["api_key", "auto_advance", "prior_cost", "replay_responses"]

    # The key never reached disk, the database or a log line.
    for path in tmp.rglob("*"):
        if path.is_file():
            assert SECRET.encode() not in path.read_bytes(), f"the key was written to {path}"
    assert not [r for r in caplog.records if SECRET in r.getMessage()], "the key reached a log line"


def test_a_guided_start_records_no_review_mode_and_never_advances(rig):
    client, legs, _hooks, _tmp = rig
    job_id = _start(client, review_mode=None)
    _wait(_settled(job_id))
    job = app_module.store.get(job_id)
    assert (job.status, job.gate_position) == (AWAITING_REVIEW, "gate1")
    assert "review_mode" not in job.config and "gate_decided_by" not in job.config
    assert len(legs) == 1 and legs[0]["kwargs"] == ["api_key"]
    assert "autoAdvancing" not in job.progress_dict()


def test_an_explicit_guided_start_is_the_same_run(rig):
    client, _legs, _hooks, _tmp = rig
    job_id = _start(client, review_mode="guided")
    _wait(_settled(job_id))
    job = app_module.store.get(job_id)
    assert job.gate_position == "gate1" and "review_mode" not in job.config


def test_an_unknown_review_mode_is_refused_before_anything_is_created(rig):
    client, legs, _hooks, tmp = rig
    cfg = {
        "dictionaries": [{"filename": "a.csv", "cohortName": "CohortA", "columnRoles": _ROLES}],
        "cdeSet": "endorsed",
        "runMode": "batch",
        "reviewMode": "auto-with-gates",
    }
    # What the work root holds BEFORE the start: boot may already have seeded a staged demo's checkpoints there.
    work = tmp / "work"
    before = sorted(work.iterdir()) if work.exists() else []
    jobs_before = {j["jobId"] for j in client.get("/api/harmonize/jobs").json()}
    r = client.post(
        "/api/harmonize/batch",
        files=[("files", ("a.csv", _CSV["a.csv"].encode(), "text/csv"))],
        data={"config": json.dumps(cfg)},
        headers={"x-anthropic-key": SECRET},
    )
    assert r.status_code == 400
    assert "reviewMode" in r.json()["detail"]
    assert legs == []
    after = sorted(work.iterdir()) if work.exists() else []
    assert after == before, "a refused start created a run"
    assert {j["jobId"] for j in client.get("/api/harmonize/jobs").json()} == jobs_before


# ── stopping it ─────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("mode", ["discard", "keep"])
def test_stop_during_an_auto_leg_ends_it_as_a_guided_stop_would(rig, mode):
    client, legs, hooks, _tmp = rig
    entered, release = threading.Event(), threading.Event()

    def block(_prompts):
        entered.set()
        assert release.wait(30), "the test never released the stage"

    hooks["classify"] = block
    job_id = _start(client)
    assert entered.wait(30), "the Gate 2 leg never reached the assign stage"
    r = client.post(f"/api/harmonize/jobs/{job_id}/cancel?mode={mode}")
    assert r.status_code == 200 and r.json() == {"cancelled": True}
    release.set()
    _wait(_settled(job_id))

    job = app_module.store.get(job_id)
    assert job.status == "cancelled"
    assert len(legs) == 2, "a leg started after the stop"
    assert not checkpoint_path(job.config["work_dir"], "gate2").exists()
    assert not job.auto_advance


def test_stop_in_the_moment_between_park_and_advance_halts_auto_and_keeps_the_run_parked(rig):
    """A Stop that lands while the run is parked and about to continue stops Full auto there, at no cost."""
    client, legs, _hooks, tmp = rig
    wd = tmp / "work" / "gap"
    app_module.store.create(
        "gap",
        "Gap",
        {"work_dir": str(wd), "cde_set": "endorsed", "run_mode": "batch", "review_mode": "auto"},
        dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
    )
    write_checkpoint(wd, job_id="gap", gate="gate1", result={"records": [], "conceptGroups": [{"groupId": "g0"}]})
    app_module.store.checkpoint("gap", gate="gate1", checkpoint_ref="gap/checkpoint_gate1.json", auto_advance=True)
    assert app_module.store.get("gap").progress_dict()["autoAdvancing"] is True

    r = client.post("/api/harmonize/jobs/gap/cancel")
    assert r.status_code == 200 and r.json() == {"cancelled": True}
    job = app_module.store.get("gap")
    assert (job.status, job.gate_position, job.auto_advance, job.cancel_mode) == (AWAITING_REVIEW, "gate1", False, None)

    # The advance that was about to run now finds nothing to do: no leg, still parked, still Gate 1.
    app_module._auto_continue("gap", SECRET)
    job = app_module.store.get("gap")
    assert legs == [] and (job.status, job.gate_position) == (AWAITING_REVIEW, "gate1")
    assert "gate_decided_by" not in job.config


# ── what stops it, and what it never does by itself ────────────────────────────────────────────────────────


def test_a_failed_leg_stops_auto_and_leaves_the_run_parked_at_its_last_gate(rig):
    client, legs, hooks, _tmp = rig

    def boom(_prompts):
        raise RuntimeError("the provider fell over")

    hooks["classify"] = boom
    job_id = _start(client)
    _wait(_settled(job_id))
    job = app_module.store.get(job_id)
    assert (job.status, job.gate_position) == (AWAITING_REVIEW, "gate1")
    assert "the provider fell over" in (job.error_message or "")
    assert len(legs) == 2 and not job.auto_advance


def test_with_no_key_an_auto_run_stays_parked_and_says_continue_manually(rig):
    """The key lives in memory for the run's legs only. A leg that has none cannot buy the next one."""
    client, legs, _hooks, tmp = rig
    job_id = _start(client)  # the start itself needs the key; the advance is what is starved of it below
    _wait(_settled(job_id))
    legs.clear()
    # A run of the same shape whose first leg ran with NO key in memory (a server key that has since gone).
    wd = tmp / "work" / "nokey"
    specs = app_module.store.get(job_id).dict_specs
    app_module.store.create(
        "nokey",
        "No key",
        {**app_module.store.get(job_id).config, "work_dir": str(wd)} | {"gate_decided_by": {}},
        dict_specs=specs,
    )
    job = app_module.store.get("nokey")
    job.config.pop("gate_decided_by")
    job.config.pop("gate1_scope", None)
    app_module.run_harmonization(
        app_module.store,
        "nokey",
        specs,
        app_module.cde_spec_for(app_module.CDE_FILES["endorsed"]),
        {**job.config, "stop_at_gate": "gate1"},
        api_key=None,
        auto_advance=app_module._auto_continue,
    )
    job = app_module.store.get("nokey")
    assert (job.status, job.gate_position, job.auto_advance) == (AWAITING_REVIEW, "gate1", False)
    assert len(legs) == 1, "an advance with no key started a leg"
    assert "continue" in (job.error_message or "").lower()
    assert "gate_decided_by" not in job.config, "a gate was marked auto-accepted although it was never committed"


def test_a_restart_never_advances_a_parked_auto_run(monkeypatch, tmp_path):
    """The key is gone with the process, by design: after a restart the run waits at its gate for Continue."""
    dbp = tmp_path / "jobs.db"
    wd = tmp_path / "work" / "rs"
    db = JobDB(dbp)
    store = JobStore(work_root=tmp_path / "work", db=db)
    store.create(
        "rs",
        "Restarted",
        {"work_dir": str(wd), "cde_set": "endorsed", "run_mode": "batch", "review_mode": "auto"},
        owner_subject=None,
        dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
    )
    write_checkpoint(wd, job_id="rs", gate="gate2", result={"records": []}, realized_cost=1.0)
    store.checkpoint("rs", gate="gate2", checkpoint_ref="rs/checkpoint_gate2.json", auto_advance=True)
    db.close()

    monkeypatch.setattr(app_module, "_DB_PATH", dbp)
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    spawned: list = []
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: spawned.append(a))
    with TestClient(app_module.app) as client:
        frame = client.get("/api/harmonize/checkpoint/rs").json()
        job = app_module.store.get("rs")
    assert spawned == []
    assert (frame["status"], frame["gatePosition"]) == (AWAITING_REVIEW, "gate2")
    assert job.auto_advance is False and job.progress_dict()["autoAdvancing"] is False


def test_a_manual_continue_on_a_degraded_auto_run_is_recorded_as_the_reviewers(rig):
    """Once a person presses Continue at a gate, that gate is theirs — it is no longer 'auto — not reviewed'."""
    client, legs, _hooks, tmp = rig
    monkeypatch_runner = []
    app_module.run_harmonization, real = (lambda *a, **k: monkeypatch_runner.append(k)), app_module.run_harmonization
    try:
        wd = tmp / "work" / "mc"
        app_module.store.create(
            "mc",
            "Manual",
            {
                "work_dir": str(wd),
                "cde_set": "endorsed",
                "run_mode": "batch",
                "review_mode": "auto",
                "gate1_scope": ["g0"],
                "gate_decided_by": {"gate1": "auto"},
            },
            dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
        )
        write_checkpoint(wd, job_id="mc", gate="gate2", result={"records": []}, realized_cost=1.0)
        app_module.store.checkpoint("mc", gate="gate2", checkpoint_ref="mc/checkpoint_gate2.json")
        # The HTTP route is the reviewer's Continue; call the real one (the fixture's spy guards the auto path).
        from backend.app import _continue_run

        body = _continue_run("mc", subject=None, api_key=SECRET, gate1_scope=None)
    finally:
        app_module.run_harmonization = real
    assert body["target"] == "gate3"
    assert app_module.store.get("mc").config["gate_decided_by"] == {"gate1": "auto"}
    assert len(monkeypatch_runner) == 1
    # A degraded run is guided from here: the reviewer's leg is not handed the auto-advance hook.
    assert "auto_advance" not in monkeypatch_runner[0]


def test_the_stream_stays_open_while_the_server_continues_an_auto_run(rig):
    """A guided park closes the stream (nothing left to report). A park Full auto is about to continue must not."""
    client, _legs, _hooks, tmp = rig
    wd = tmp / "work" / "st"
    app_module.store.create("st", "Stream", {"work_dir": str(wd), "run_mode": "batch", "review_mode": "auto"})
    write_checkpoint(wd, job_id="st", gate="gate1", result={"records": []})
    app_module.store.checkpoint("st", gate="gate1", checkpoint_ref="st/checkpoint_gate1.json", auto_advance=True)
    threading.Timer(0.2, lambda: app_module.store.update("st", status="complete", phase="complete")).start()
    with client.stream("GET", "/api/harmonize/stream/st") as resp:
        frames = [json.loads(line[len("data: ") :]) for line in resp.iter_lines() if line.startswith("data:")]
    assert len(frames) >= 2, "the stream closed on a park the server was about to continue"
    assert frames[0]["autoAdvancing"] is True and frames[0]["reviewMode"] == "auto"
    assert frames[-1]["status"] == "complete"


def test_rerun_of_an_auto_run_does_not_inherit_its_decided_by_record(rig):
    client, legs, _hooks, _tmp = rig
    job_id = _start(client)
    _wait(_settled(job_id))
    legs.clear()
    r = client.post(f"/api/harmonize/jobs/{job_id}/rerun", headers={"x-anthropic-key": SECRET})
    assert r.status_code == 200, r.text
    new = app_module.store.get(r.json()["jobId"])
    assert new.config["review_mode"] == "auto"
    assert "gate_decided_by" not in new.config
    _wait(_settled(new.job_id))


def test_a_discard_stop_that_lands_after_the_last_progress_tick_still_ends_the_leg_cancelled(tmp_path, monkeypatch):
    """A discard means "no result": a pipeline that returns anyway must not be recorded complete (or parked).

    Found driving Full auto: a stage that does not tick progress after the stop was pressed let the leg return
    normally, and the runner marked the run COMPLETE — and a finishing leg then made the paid ideas call.
    """
    store = JobStore(work_root=tmp_path / "work", db=None)
    store.create("d", "D", {"work_dir": str(tmp_path / "work" / "d"), "gen_analysis_ideas": True})
    store.update("d", status="assigning", phase="assigning")

    def pipeline(dict_specs, cde_spec, config, *, progress, **kwargs):
        store.request_cancel("d", "discard")  # pressed after the last tick this leg will make
        return {"records": [{"id": "r"}], "cost": {"actualUsd": 0.0}}

    monkeypatch.setattr(runner_module, "run_pipeline", pipeline)
    monkeypatch.setattr(runner_module, "_generate_ideas", lambda *a, **k: pytest.fail("a discarded run bought ideas"))
    runner_module.run_harmonization(store, "d", [], None, {"work_dir": str(tmp_path / "work" / "d")})
    job = store.get("d")
    assert job.status == "cancelled" and job.result is None
