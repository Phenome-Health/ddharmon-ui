"""The staged-review checkpoint spine — restart, resume, and no-recharge.

Every test's docstring names the DEFECT it prevents, following ``tests/test_artifacts.py``'s idiom. Three
of those defects are latent in the shipped backend and would each destroy a paused run silently:

  1. ``JobDB.recover_stale`` marks EVERY non-terminal row errored on startup. A deploy runs it. A run
     parked at ``awaiting_review`` has no worker by construction (D-01), so the blanket sweep destroys it.
  2. ``backend.db._TERMINAL`` and ``backend.jobs.TERMINAL_STATES`` disagree about ``cancelled``, so a
     cancelled run that kept a partial result is ALREADY flipped to errored today (see test_retention.py).
  3. The SSE stream yields the whole job — ``result`` included — twice a second. That is free only while
     ``result`` is ``None`` until terminal. Checkpointing makes it a multi-megabyte frame at 2 Hz.

No mocks anywhere in the durability cases: a real :class:`~backend.db.JobDB` on a ``tmp_path`` file, and a
SECOND ``JobDB`` opened on the same file to simulate the process restart. That two-``JobDB`` fixture is the
highest-value construct in the file.

The pipeline cases run the REAL ``run_pipeline`` with the embedding provider and BERTopic stubbed and the
LLM stages injected — no provider call, no key, no network, no cost. Reaching Gate 1 on a real run now
costs ``generate(ideal)`` + ``split`` + the judge (UI-SPEC §0.1), and no test here may incur that.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time

import numpy as np
import pytest
from ddharmon.clustering.topic_engine import collect_inputs
from ddharmon.embedding.provider import EmbeddingProvider
from ddharmon.models.cluster import FieldCluster, TopicModelResult
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import runner as runner_module
from backend.checkpoint import (
    CheckpointMissingError,
    checkpoint_path,
    load_checkpoint,
    read_checkpoint,
    write_checkpoint,
)
from backend.db import _LIVE_WORKER_STATUSES, _NEVER_RECOVERED, _TERMINAL, JobDB
from backend.engine.contract import PHASES_PREVIEW, PHASES_RUN
from backend.jobs import AWAITING_REVIEW, FIRST_GATE, TERMINAL_STATES, Job, JobStore

DIM = 32


class StubProvider(EmbeddingProvider):
    """Deterministic hash-based embeddings — no model download, no network."""

    @property
    def model_name(self) -> str:
        return "stub-checkpoint"

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


# ── the two-JobDB restart fixture ───────────────────────────────────────────────────────────


def _paused_job(job_id: str = "paused", *, cost: float = 2.14) -> Job:
    """A run parked at the Gate 1 boundary: no worker, a gate position, a pointer, a realized spend."""
    return Job(
        job_id=job_id,
        display_name="Paused at Gate 1",
        status=AWAITING_REVIEW,
        phase=AWAITING_REVIEW,
        owner_subject="user_A",
        gate_position="gate1",
        checkpoint_ref=f"{job_id}/checkpoint_gate1.json",
        cost_so_far=cost,
        result_version=1,
    )


def test_awaiting_review_survives_restart(tmp_path):
    """T-08-40: ``recover_stale`` swept every non-terminal row, so every deploy destroyed every paused run.

    The single highest-value test in the phase. A paused run has NO worker thread by construction (D-01
    makes a pause an exit, not a block), so "non-terminal" is not evidence that a worker died.
    """
    dbp = tmp_path / "jobs.db"
    db1 = JobDB(dbp)
    db1.upsert(_paused_job())
    db1.close()

    db2 = JobDB(dbp)  # a fresh process opening the same file
    assert db2.recover_stale() == 0, "the startup sweep touched a row that has no worker to have died"
    row = db2.get("paused")
    assert row["status"] == AWAITING_REVIEW
    assert row["gate_position"] == "gate1"
    assert row["checkpoint_ref"] == "paused/checkpoint_gate1.json"
    db2.close()


def test_recover_stale_still_errors_a_row_whose_worker_really_died(tmp_path):
    """Narrowing the sweep must not disable it: a row left mid-stage by a killed worker IS stale."""
    dbp = tmp_path / "jobs.db"
    db1 = JobDB(dbp)
    db1.upsert(Job(job_id="mid", display_name="Died", status="assigning", phase="assigning"))
    db1.close()

    db2 = JobDB(dbp)
    assert db2.recover_stale() == 1
    assert db2.get("mid")["status"] == "error"
    db2.close()


def test_recover_stale_also_reconciles_a_status_this_build_does_not_recognise(tmp_path):
    """The allow-list's own blind spot, closed by the second clause.

    A row written by an older build (or by a stage since renamed) names a status the allow-list has never
    heard of. Recovering only the recognised set would strand it forever in a state no UI can explain —
    the mirror image of T-08-40, and just as invisible.
    """
    dbp = tmp_path / "jobs.db"
    db1 = JobDB(dbp)
    db1.upsert(Job(job_id="legacy", display_name="Old build", status="running", phase="running"))
    db1.close()

    db2 = JobDB(dbp)
    assert db2.recover_stale() == 1
    assert db2.get("legacy")["status"] == "error"
    db2.close()


def test_the_live_worker_allowlist_covers_every_reported_phase():
    """A new pipeline phase must not silently fall OUT of the sweep's allow-list and become unrecoverable.

    ``recover_stale`` is now an allow-list of statuses implying a live worker. An allow-list's failure mode
    is the mirror of the deny-list's: a phase nobody added is never recovered, and its run hangs forever in
    a state no UI explains. The phase vocabulary lives in ``backend.engine.contract``; this asserts the two
    agree without making ``db.py`` import the engine.
    """
    reported = set(PHASES_RUN) | set(PHASES_PREVIEW)
    missing = sorted(p for p in reported if p not in _LIVE_WORKER_STATUSES and p not in _TERMINAL)
    assert not missing, f"reported phase(s) absent from the live-worker allow-list: {missing}"
    # And the mirror: nothing terminal, and nothing checkpointed, may be in the allow-list.
    assert not set(_LIVE_WORKER_STATUSES) & set(TERMINAL_STATES)
    assert AWAITING_REVIEW not in _LIVE_WORKER_STATUSES
    # The two sets the sweep reasons over are disjoint, so no status can be both protected and swept.
    assert not set(_LIVE_WORKER_STATUSES) & set(_NEVER_RECOVERED)
    assert set(_NEVER_RECOVERED) == set(TERMINAL_STATES) | {AWAITING_REVIEW}


def test_the_two_terminal_definitions_agree():
    """R14: ``db._TERMINAL`` omitted ``cancelled``, so a cancelled run was re-flagged errored on restart."""
    assert set(_TERMINAL) == set(TERMINAL_STATES)


def test_rehydrated_paused_run_reports_non_zero_realized_cost(tmp_path):
    """R8/R14 cost transparency: realized spend was LIVE-only, so a resumed run under-reported what it cost.

    Reporting zero after a restart tells the reviewer their paused run is free to continue when ideal +
    split + the judge have already been billed. That is a repudiation defect (T-08-44), not cosmetics.
    """
    dbp = tmp_path / "jobs.db"
    db1 = JobDB(dbp)
    db1.upsert(_paused_job(cost=2.14))
    db1.close()

    store = JobStore(db=JobDB(dbp))
    job = store.get("paused")
    assert job is not None
    assert job.cost_so_far == pytest.approx(2.14)
    assert job.to_dict()["costSoFar"] == pytest.approx(2.14)
    store.db.close()


def test_awaiting_review_is_evicted_from_memory_but_its_row_survives(tmp_path):
    """T-08-39: a paused run held its embeddings in RAM for as long as the human review took.

    Eviction must reach ``awaiting_review`` — and must KEEP the row, so the returning reviewer rehydrates
    from SQLite instead. Evicting without a durable copy would simply lose the run, so eviction of a paused
    run is conditional on a ``db`` being attached.
    """
    dbp = tmp_path / "jobs.db"
    store = JobStore(ttl_seconds=-10, work_root=tmp_path / "work", db=JobDB(dbp))
    store.create("p", "Paused", {}, owner_subject="user_A")
    store.checkpoint("p", gate="gate1", checkpoint_ref="p/checkpoint_gate1.json", realized_cost=1.5)

    store.purge_expired()
    assert "p" not in store._jobs, "a paused run must not hold its run state in RAM through the review"
    rehydrated = store.get("p")
    assert rehydrated is not None and rehydrated.status == AWAITING_REVIEW
    assert rehydrated.gate_position == "gate1"
    store.db.close()


def test_a_paused_runs_work_dir_is_never_torn_down_by_eviction(tmp_path):
    """The checkpoint LIVES in the work dir. Evicting a paused run must not delete the thing it resumes from."""
    work = tmp_path / "work"
    store = JobStore(ttl_seconds=-10, work_root=work, db=None)
    (work / "p").mkdir(parents=True)
    (work / "p" / "checkpoint_gate1.json").write_text("{}")
    store.create("p", "Paused", {})
    store.checkpoint("p", gate="gate1", checkpoint_ref="p/checkpoint_gate1.json", realized_cost=1.0)

    store.purge_expired()
    assert (work / "p" / "checkpoint_gate1.json").exists()
    # With no durable store there is nothing to rehydrate FROM, so the run must stay in memory.
    assert store.get("p") is not None


def test_the_jobs_row_never_stores_the_checkpoint_payload(tmp_path):
    """D-02: the jobs row is rewritten WHOLE on every write, so a stage payload there is copied on each tick.

    Large stage output belongs on the per-run work dir; the row carries the gate position and a POINTER.
    """
    dbp = tmp_path / "jobs.db"
    store = JobStore(work_root=tmp_path / "work", db=JobDB(dbp))
    store.create("p", "Paused", {}, owner_subject="user_A")
    payload = {"conceptGroups": [{"groupId": f"g{i}"} for i in range(500)]}
    write_checkpoint(tmp_path / "work" / "p", job_id="p", gate="gate1", result=payload, responses={}, realized_cost=1.0)
    store.checkpoint("p", gate="gate1", checkpoint_ref="p/checkpoint_gate1.json", realized_cost=1.0)

    raw = sqlite3.connect(dbp).execute("SELECT result, checkpoint_ref FROM jobs WHERE job_id='p'").fetchone()
    assert raw[0] in (None, "null"), "the checkpoint payload leaked into the whole-row-rewritten jobs row"
    assert raw[1] == "p/checkpoint_gate1.json"
    store.db.close()


# ── backend/checkpoint.py: persist + rehydrate on the per-run work dir ──────────────────────


def test_checkpoint_roundtrips_stage_output_on_the_per_run_work_dir(tmp_path):
    """The checkpoint is the durability mechanism, so its write must be readable by a different process."""
    result = {"conceptGroups": [{"groupId": "0:0", "clusterId": "0", "concept": "Smoking status"}]}
    responses = {"generate": {"leanb:ideal:0": {"ideal_cde": "Smoking status"}}}
    written = write_checkpoint(
        tmp_path, job_id="j1", gate="gate1", result=result, responses=responses, realized_cost=2.14
    )
    assert written.path == checkpoint_path(tmp_path, "gate1")

    got = read_checkpoint(tmp_path, "gate1")
    assert got.job_id == "j1"
    assert got.gate == "gate1"
    assert got.result == result
    assert got.responses == responses
    assert got.realized_cost == pytest.approx(2.14)
    assert got.written_at > 0
    assert load_checkpoint(written.path).result == result


def test_read_checkpoint_raises_a_typed_error_naming_the_missing_artifact(tmp_path):
    """T-08-43: rehydrate must be a PURE READ that fails loudly, never a partially-filled run.

    A silent partial rehydrate is worse than an error: the reviewer sees a Gate 1 with fewer groups than
    they scoped and no indication anything was lost.
    """
    with pytest.raises(CheckpointMissingError) as exc:
        read_checkpoint(tmp_path, "gate1")
    assert str(checkpoint_path(tmp_path, "gate1")) in str(exc.value)


def test_a_truncated_checkpoint_raises_rather_than_returning_a_partial_run(tmp_path):
    """A half-written file (a kill mid-write) must not read back as an empty-but-valid run."""
    path = checkpoint_path(tmp_path, "gate1")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"gate": "gate1", "result": {"conceptGrou')
    with pytest.raises(CheckpointMissingError):
        read_checkpoint(tmp_path, "gate1")


def test_a_checkpoint_missing_a_required_key_raises(tmp_path):
    """Structurally valid JSON that is not a checkpoint is still a missing artifact, not a usable run."""
    path = checkpoint_path(tmp_path, "gate1")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"gate": "gate1"}))
    with pytest.raises(CheckpointMissingError):
        read_checkpoint(tmp_path, "gate1")


def test_the_checkpoint_write_is_atomic(tmp_path):
    """A kill between two writes must leave the PREVIOUS checkpoint intact, not a truncated file."""
    write_checkpoint(tmp_path, job_id="j", gate="gate1", result={"v": 1}, responses={}, realized_cost=1.0)
    write_checkpoint(tmp_path, job_id="j", gate="gate1", result={"v": 2}, responses={}, realized_cost=2.0)
    assert read_checkpoint(tmp_path, "gate1").result == {"v": 2}
    assert not list(tmp_path.glob("*.tmp")), "a temp file survived the write"


# ── the thin progress frame (D-03 / T-08-38) ────────────────────────────────────────────────


def test_progress_dict_carries_no_result_payload():
    """T-08-38: the 2 Hz stream yielded ``result``. Free while it is None; 6.78 MB per frame once checkpointed.

    Built POSITIVELY from the live keys — enumerated, not popped off ``to_dict`` — so a future heavy field
    cannot arrive on the 2 Hz path by default.
    """
    job = Job(job_id="j", display_name="J", status="assigning", phase="assigning")
    job.result = {"records": [{"id": "r"} for _ in range(1000)]}
    job.analysis_ideas = [{"idea": "x"}]
    job.decisions = {"r": {"decision": "approve"}}

    frame = job.progress_dict()
    for heavy in ("result", "analysisIdeas", "decisions", "composites", "config"):
        assert heavy not in frame, f"{heavy} must not ride the 2 Hz progress frame"
    # And the live fields the run view actually renders ARE there.
    assert {
        "jobId",
        "status",
        "phase",
        "completed",
        "total",
        "costSoFar",
        "phaseStartedAt",
        "resultVersion",
        "gatePosition",
    } <= set(frame)


def test_progress_dict_result_version_is_stable_across_progress_ticks(tmp_path):
    """The version token must NOT be derived from ``updated_at``: that moves on every tick → a refetch storm.

    This is the whole point of the token. A token that changes twice a second turns "refetch the result when
    it changes" into "refetch a multi-megabyte payload twice a second", which is worse than the defect
    D-03 removed.
    """
    store = JobStore(db=JobDB(tmp_path / "jobs.db"))
    store.create("j", "J", {}, owner_subject="user_A")
    first = store.get("j").progress_dict()["resultVersion"]
    for i in range(5):
        store.update("j", status="assigning", phase="assigning", completed=i, total=5, cost_so_far=0.1 * i)
        assert store.get("j").progress_dict()["resultVersion"] == first
    store.db.close()


def test_result_version_bumps_on_a_checkpoint_write(tmp_path):
    """The client refetches the result only when the token moves, so a checkpoint MUST move it."""
    store = JobStore(work_root=tmp_path / "work", db=JobDB(tmp_path / "jobs.db"))
    store.create("j", "J", {}, owner_subject="user_A")
    before = store.get("j").result_version
    store.checkpoint("j", gate="gate1", checkpoint_ref="j/checkpoint_gate1.json", realized_cost=2.14)
    after = store.get("j").result_version
    assert after > before
    # Monotonic across a restart, so a token can never repeat and hide a change.
    store.db.close()
    store2 = JobStore(db=JobDB(tmp_path / "jobs.db"))
    assert store2.get("j").result_version == after
    store2.db.close()


def test_result_version_bumps_on_a_terminal_result(tmp_path):
    """A finished run also changes the payload, so the token must move there too or the UI never refetches."""
    store = JobStore(db=JobDB(tmp_path / "jobs.db"))
    store.create("j", "J", {}, owner_subject="user_A")
    before = store.get("j").result_version
    store.update("j", status="complete", phase="complete", result={"records": []})
    assert store.get("j").result_version > before
    store.db.close()


# ── the Gate 1 boundary, a simulated kill, and a $0 resume ──────────────────────────────────


def _fixture_specs(tmp_path):
    a = tmp_path / "a.tsv"
    a.write_text("var\tdesc\tenc\nSMOKE_A\tCurrent smoking status\t1=Yes|0=No\nAGE_A\tAge in years\t\n")
    b = tmp_path / "b.tsv"
    b.write_text("var\tdesc\tenc\nSMOKE_B\tDo you smoke cigarettes\tY=Yes|N=No\nAGE_B\tAge at visit\t\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\tdefinition\tpermissible_values\n"
        "SmokeCDE\tSmoking status\t1=Yes|0=No\n"
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


@pytest.fixture
def _one_cluster(monkeypatch):
    """One cluster over every cohort field (CDE rows are the retrieval backbone, never cluster members)."""

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


def test_a_run_that_reaches_gate_1_pauses_with_its_concept_groups(tmp_path, _one_cluster):
    """Gate 1's pause is the SHIPPED ``classify=None`` early return — after ideal and split, before assign.

    No new stop mechanism is invented for entering Gate 1 (08-04's one new named boundary serves Gate 2).
    The result carries the post-split concept groups, which are Gate 1's row source — NOT ``previewClusters``.
    """
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec = _fixture_specs(tmp_path)
    calls: dict[str, int] = {}

    def _count(name, fn):
        def stage(prompts):
            calls[name] = calls.get(name, 0) + len(prompts)
            return fn(prompts)

        return stage

    overrides = {
        "generate": _count("generate", lambda recs: {r.id: {"ideal_cde": "Smoking status"} for r in recs}),
        "split": _count("split", lambda recs: {}),
        "classify": _count("classify", lambda recs: {r.id: {"verdict": "adopt", "cde_id": "1"} for r in recs}),
    }
    config = {
        "run_mode": "batch",
        "cde_cohort": "NIH_CDE",
        "work_dir": str(tmp_path / "work"),
        "min_cluster_size": 2,
        "retrieval_floor": 0.0,
        "stop_at_gate": "gate1",
    }
    result = run_pipeline(dict_specs, cde_spec, config, provider=StubProvider(), stage_overrides=overrides)

    assert result["gatePosition"] == "gate1"
    assert result["conceptGroups"], "Gate 1 has no rows to render"
    group = result["conceptGroups"][0]
    assert {"groupId", "clusterId", "concept", "nMembers", "cohorts", "memberVariableNames"} <= set(group)
    assert group["nMembers"] >= 1
    assert calls.get("generate", 0) > 0 and "classify" not in calls, "assign ran past the Gate 1 boundary"
    # The row source moved off previewClusters; that field is preview run mode's and must not be Gate 1's.
    assert not result.get("previewClusters")


def test_resume_after_a_simulated_kill_preserves_the_paid_stage_and_issues_no_new_paid_call(tmp_path, _one_cluster):
    """MUST NOT discard completed paid stage output on failure, restart or redeploy.

    Leg 1 reaches Gate 1 and is checkpointed. The process is then "killed" (a brand-new store on the same
    files). Leg 2 resumes and must (a) still see leg 1's stage output and (b) call NO paid stage for work
    already done — asserted by counting the injected stage's invocations, so the guarantee does not rest on
    a cache the test cannot observe.
    """
    from backend.engine.adapter import run_pipeline

    dict_specs, cde_spec = _fixture_specs(tmp_path)
    work = tmp_path / "work"
    leg1_calls: dict[str, int] = {}
    leg2_calls: dict[str, int] = {}

    def _stages(sink):
        def _count(name, fn):
            def stage(prompts):
                sink[name] = sink.get(name, 0) + len(prompts)
                return fn(prompts)

            return stage

        return {
            "generate": _count("generate", lambda recs: {r.id: {"ideal_cde": "Smoking status"} for r in recs}),
            "split": _count("split", lambda recs: {}),
            "classify": _count("classify", lambda recs: {r.id: {"verdict": "adopt", "cde_id": "1"} for r in recs}),
            "gencde": _count("gencde", lambda recs: {}),
            "specgen": _count("specgen", lambda recs: {}),
        }

    base = {
        "run_mode": "batch",
        "cde_cohort": "NIH_CDE",
        "work_dir": str(work),
        "min_cluster_size": 2,
        "retrieval_floor": 0.0,
    }
    recorded: dict[str, dict] = {}
    leg1 = run_pipeline(
        dict_specs,
        cde_spec,
        {**base, "stop_at_gate": "gate1"},
        provider=StubProvider(),
        stage_overrides=_stages(leg1_calls),
        stage_responses=recorded,
    )
    assert leg1["gatePosition"] == "gate1"
    assert leg1_calls.get("generate", 0) > 0
    ckpt = write_checkpoint(
        work,
        job_id="j",
        gate="gate1",
        result=leg1,
        responses=recorded,
        realized_cost=2.14,
    )

    # ── the kill: nothing in memory survives; only the work dir does ──
    replayed = load_checkpoint(ckpt.path)
    assert replayed.result["conceptGroups"] == leg1["conceptGroups"], "leg 1's output did not survive"

    leg2 = run_pipeline(
        dict_specs,
        cde_spec,
        {**base, "stop_at_gate": "gate2"},
        provider=StubProvider(),
        stage_overrides=_stages(leg2_calls),
        replay_responses=replayed.responses,
    )
    assert leg2["gatePosition"] == "gate2"
    assert leg2_calls.get("generate", 0) == 0, "resume re-charged for the ideal stage it already paid for"
    assert leg2_calls.get("split", 0) == 0, "resume re-charged for the split stage it already paid for"
    assert leg2_calls.get("classify", 0) > 0, "resume did no new work either"


def test_the_runner_marks_a_gate_boundary_awaiting_review_and_returns(tmp_path, monkeypatch):
    """D-01: a pause is an EXIT, not a blocked thread. The worker must terminate, not sleep on a human."""
    store = JobStore(work_root=tmp_path / "work", db=JobDB(tmp_path / "jobs.db"))
    store.create("j", "J", {"work_dir": str(tmp_path / "work" / "j")}, owner_subject="user_A")

    def fake_pipeline(dict_specs, cde_spec, config, *, progress, **kwargs):
        progress("splitting", 1, 1, 2.14)
        return {
            "gatePosition": "gate1",
            "conceptGroups": [{"groupId": "0:0", "clusterId": "0", "concept": "Smoking status"}],
            "records": [],
            "cost": {"actualUsd": 2.14, "tokens": {"input": 1, "output": 1}, "perStage": {}},
        }

    monkeypatch.setattr(runner_module, "run_pipeline", fake_pipeline)
    thread = threading.Thread(
        target=runner_module.run_harmonization,
        args=(store, "j", [], None, {"work_dir": str(tmp_path / "work" / "j")}),
    )
    thread.start()
    thread.join(timeout=10)
    assert not thread.is_alive(), "the worker blocked on the checkpoint instead of exiting"

    job = store.get("j")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate1"
    assert job.cost_so_far == pytest.approx(2.14)
    assert read_checkpoint(tmp_path / "work" / "j", "gate1").result["conceptGroups"]
    store.db.close()


def test_resuming_a_run_with_no_decisions_lands_on_the_first_gate(tmp_path):
    """UI-SPEC §8.2: "resuming a run with no decisions resumes at the first gate".

    "First gate" means the first UNCOMMITTED gate — the run's own checkpoint when it has one, and Setup
    when it has reached none. Reading it as "always Setup" would contradict R7's resume-where-you-left-off.
    """
    store = JobStore(db=JobDB(tmp_path / "jobs.db"))
    store.create("fresh", "Fresh", {}, owner_subject="user_A")
    assert store.get("fresh").resume_gate() == FIRST_GATE == "setup"

    store.checkpoint("fresh", gate="gate1", checkpoint_ref="fresh/checkpoint_gate1.json", realized_cost=1.0)
    assert store.get("fresh").resume_gate() == "gate1"
    store.db.close()


# ── the endpoints a returning reviewer and a guest actually hit ─────────────────────────────


def _decode_by_token(token: str) -> dict:
    from backend import auth

    subs = {"A": "user_A", "B": "user_B"}
    if token not in subs:
        raise auth.AuthError(401, "bad token")
    return {"sub": subs[token], "email": f"{subs[token]}@example.org"}


def test_the_result_endpoint_rehydrates_a_paused_run_from_its_checkpoint(monkeypatch, tmp_path):
    """The reviewer closed the browser. Reopening must show the SAME groups, read off disk, not re-run."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    # The checkpoint pointer is written RELATIVE to the store's work root and resolved against the same
    # attribute, so a test that moves one and not the other is testing a mismatch it created itself.
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    with TestClient(app_module.app) as c:
        app_module.store.create("p", "Paused", {}, owner_subject=None)
        groups = [{"groupId": "0:0", "clusterId": "0", "concept": "Smoking status", "nMembers": 2}]
        write_checkpoint(
            tmp_path / "work" / "p",
            job_id="p",
            gate="gate1",
            result={"conceptGroups": groups, "records": []},
            responses={},
            realized_cost=2.14,
        )
        app_module.store.checkpoint("p", gate="gate1", checkpoint_ref="p/checkpoint_gate1.json", realized_cost=2.14)

        body = c.get("/api/harmonize/result/p").json()
        assert body["status"] == AWAITING_REVIEW
        assert body["gatePosition"] == "gate1"
        assert body["result"]["conceptGroups"] == groups
        assert body["costSoFar"] == pytest.approx(2.14)


def test_a_foreign_paused_run_is_404_not_403(monkeypatch, tmp_path):
    """T-08-41: a gate/resume path must never confirm that someone else's run exists."""
    from backend import auth

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    # The checkpoint pointer is written RELATIVE to the store's work root and resolved against the same
    # attribute, so a test that moves one and not the other is testing a mismatch it created itself.
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setattr(auth, "_decode_claims", _decode_by_token)
    with TestClient(app_module.app) as c:
        app_module.store.create("pa", "A's paused run", {}, owner_subject="user_A")
        app_module.store.checkpoint("pa", gate="gate1", checkpoint_ref="pa/c.json", realized_cost=1.0)

        hdr = {"authorization": "Bearer B"}
        assert c.get("/api/harmonize/result/pa", headers=hdr).status_code == 404
        assert c.get("/api/harmonize/checkpoint/pa", headers=hdr).status_code == 404
        assert c.post("/api/harmonize/resume/pa", headers=hdr).status_code == 404


def test_a_guest_can_read_a_demo_runs_gate_state_without_signing_in(monkeypatch, tmp_path):
    """R9: "you can walk every gate on the demo without an account" — so the READ paths must be demo-scoped."""
    from backend import auth

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    # The checkpoint pointer is written RELATIVE to the store's work root and resolved against the same
    # attribute, so a test that moves one and not the other is testing a mismatch it created itself.
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setattr(auth, "_decode_claims", _decode_by_token)
    with TestClient(app_module.app) as c:
        app_module.store.create("dg", "Demo", {"demo": True})
        write_checkpoint(
            tmp_path / "work" / "dg",
            job_id="dg",
            gate="gate1",
            result={"conceptGroups": [{"groupId": "0:0"}], "records": []},
            responses={},
            realized_cost=0.0,
        )
        app_module.store.checkpoint("dg", gate="gate1", checkpoint_ref="dg/checkpoint_gate1.json", realized_cost=0.0)

        assert c.get("/api/harmonize/checkpoint/dg").status_code == 200
        assert c.get("/api/harmonize/result/dg").status_code == 200
        # Resume is a SPEND action and stays authenticated even on the demo (T-08-41).
        assert c.post("/api/harmonize/resume/dg").status_code == 401


def test_the_stream_frame_is_the_thin_progress_dict(monkeypatch, tmp_path):
    """T-08-38 at the wire: the SSE endpoint must stop shipping ``result`` at 2 Hz."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        app_module.store.create("s", "S", {"demo": True})
        app_module.store.update("s", status="complete", phase="complete", result={"records": [{"id": "r"}]})
        with c.stream("GET", "/api/harmonize/stream/s") as resp:
            frame = next(json.loads(line[len("data: ") :]) for line in resp.iter_lines() if line.startswith("data: "))
    assert "result" not in frame
    assert "decisions" not in frame
    assert frame["resultVersion"] >= 1


# ── D-04: reconciling paid Batch work that outlived the process that submitted it ────────────
#
# The hole 08-08 did not close. A pause is an exit, so the SUBMITTED-BUT-UNRETRIEVED batch is the case
# that has no owner: ``submit_batch`` charged the account and wrote a manifest, the poll was still
# blocking when the process died, and nothing anywhere ever retrieves that result again. The work is
# paid for and unreachable.
#
# Every test below uses a REAL work dir on ``tmp_path`` (manifests and jsonl written the way core's
# ``submit_batch`` / ``retrieve_batch`` write them) and a FAKE upstream whose call count is observable.
# No provider client is constructed, no key is read, nothing is submitted, nothing is billed.


def _submitted_batch(work_dir, tag: str, batch_id: str, ids: list[str]):
    """Write what core's ``submit_batch`` leaves on disk: the prompts file and the batch manifest.

    The manifest is the durable evidence that money was spent — it survives the process that wrote it,
    which is exactly why reconciliation can be keyed on it.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    prompts = work_dir / f"prompts_{tag}.jsonl"
    prompts.write_text("\n".join(json.dumps({"id": i, "system_prompt": "s", "user_prompt": "u"}) for i in ids) + "\n")
    (work_dir / f"prompts_{tag}.jsonl.batch_manifest.json").write_text(
        json.dumps(
            {
                "batch_id": batch_id,
                "num_requests": len(ids),
                "prompts_path": str(prompts),
                "id_map": {f"req_{n}": i for n, i in enumerate(ids)},
            }
        )
    )
    return prompts


def _wrote_responses(work_dir, tag: str, mapping: dict):
    """What core's ``retrieve_batch`` leaves on disk for the ids that DID come back."""
    path = work_dir / f"responses_{tag}.jsonl"
    path.write_text("\n".join(json.dumps({"id": k, "response": v}) for k, v in mapping.items()) + "\n")
    return path


class FakeUpstream:
    """A batch fetcher whose calls are counted. Never talks to a provider.

    ``by_batch`` maps a batch id to the :class:`~backend.batch_reconcile.FetchResult` the upstream would
    give. A batch id with no entry is treated as still processing, which is the safe default.
    """

    def __init__(self, by_batch: dict):
        self.by_batch = by_batch
        self.calls: list[str] = []

    def __call__(self, batch_id, *, manifest_path=None, api_key=None):
        from backend.batch_reconcile import FetchResult

        self.calls.append(batch_id)
        return self.by_batch.get(batch_id) or FetchResult(status="pending")


def _paused_with_outstanding_batch(tmp_path, *, job_id="r1", tag="split", ids=("0:0", "0:1")):
    """A run parked at Gate 1 whose ``split`` batch was submitted but never retrieved."""
    from backend.checkpoint import write_checkpoint

    store = JobStore(work_root=tmp_path)
    wd = tmp_path / job_id
    _submitted_batch(wd, tag, "batch_abc", list(ids))
    write_checkpoint(
        wd,
        job_id=job_id,
        gate="gate1",
        result={"conceptGroups": [{"groupId": "0:0"}], "records": []},
        responses={"generate": {"c0": {"ideal": "x"}}},
        realized_cost=1.5,
    )
    store.create(job_id, "Paused", {})
    store.checkpoint(job_id, gate="gate1", checkpoint_ref=f"{job_id}/checkpoint_gate1.json", realized_cost=1.5)
    return store, wd


def test_batch_reconcile_idempotent(tmp_path):
    """T-08-53: the interval sweep and the on-open path CAN genuinely race on one run.

    Idempotency here is not an optimization — a second reconcile that re-attached or re-submitted would
    either duplicate a stage's recorded answers (making the next leg's replay disagree with the leg that
    produced the result on screen) or spend money on work already paid for. It is derived from what is
    MISSING ON DISK, not from a lock, so two racing callers converge instead of serializing.
    """
    from backend.batch_reconcile import FetchResult, reconcile_run

    store, wd = _paused_with_outstanding_batch(tmp_path)
    upstream = FakeUpstream(
        {
            "batch_abc": FetchResult(
                status="available",
                records=(
                    {"id": "0:0", "response": {"groups": ["a"]}},
                    {"id": "0:1", "response": {"groups": ["b"]}},
                ),
            )
        }
    )
    version_before = store.get("r1").result_version

    first = reconcile_run("r1", store=store, fetch=upstream)
    assert first.status == "reconciled"
    assert first.attached == {"split": 2}
    assert len(upstream.calls) == 1
    assert store.get("r1").result_version == version_before + 1

    second = reconcile_run("r1", store=store, fetch=upstream)
    assert second.status == "noop", "the second reconcile found work to do that the first should have done"
    assert second.attached == {}
    assert len(upstream.calls) == 1, "a second reconcile issued an additional upstream call"
    assert store.get("r1").result_version == version_before + 1, "a no-op reconcile moved the version token"

    ckpt = read_checkpoint(wd, "gate1")
    assert set(ckpt.responses["split"]) == {"0:0", "0:1"}
    assert ckpt.responses["generate"] == {"c0": {"ideal": "x"}}, "an earlier stage's paid answers were dropped"
    assert ckpt.result["conceptGroups"] == [{"groupId": "0:0"}], "reconcile advanced the run instead of attaching"
    assert ckpt.realized_cost == pytest.approx(1.5)


def test_batch_reconcile_appends_to_the_on_disk_response_cache_without_clobbering_it(tmp_path):
    """``retrieve_batch`` opens its output ``"w"``. Handing it the run's real responses file would ERASE
    every response already retrieved for that stage — the exact paid work this module exists to save."""
    from backend.batch_reconcile import FetchResult, reconcile_run

    store, wd = _paused_with_outstanding_batch(tmp_path, ids=("0:0", "0:1", "0:2"))
    _wrote_responses(wd, "split", {"0:0": {"groups": ["already"]}})
    upstream = FakeUpstream(
        {
            "batch_abc": FetchResult(
                status="available",
                records=({"id": "0:1", "response": {"groups": ["b"]}}, {"id": "0:2", "response": {"groups": ["c"]}}),
            )
        }
    )

    out = reconcile_run("r1", store=store, fetch=upstream)

    assert out.status == "reconciled"
    lines = [json.loads(x) for x in (wd / "responses_split.jsonl").read_text().splitlines() if x.strip()]
    assert {x["id"] for x in lines} == {"0:0", "0:1", "0:2"}
    assert next(x for x in lines if x["id"] == "0:0")["response"] == {"groups": ["already"]}


def test_batch_reconcile_is_a_noop_when_there_is_no_outstanding_submission(tmp_path):
    """A sweep runs over every run on the host. A no-op that still wrote would move every paused run's
    version token on every tick, and the versioned refetch would become a refetch storm (T-08-55)."""
    from backend.batch_reconcile import reconcile_run

    store, wd = _paused_with_outstanding_batch(tmp_path)
    _wrote_responses(wd, "split", {"0:0": {"g": 1}, "0:1": {"g": 2}})
    upstream = FakeUpstream({})
    before = store.get("r1")
    version_before, updated_before = before.result_version, before.updated_at

    out = reconcile_run("r1", store=store, fetch=upstream)

    assert out.status == "noop"
    assert upstream.calls == [], "a fully-retrieved batch was fetched again"
    after = store.get("r1")
    assert after.result_version == version_before
    assert after.updated_at == updated_before, "a no-op reconcile touched the run's updated timestamp"


def test_batch_reconcile_reports_pending_and_leaves_the_run_untouched(tmp_path):
    """A batch that has not ended is NOT an error. Recording it as one would tell the reviewer their work
    was lost while it was still on its way."""
    from backend.batch_reconcile import FetchResult, reconcile_run

    store, wd = _paused_with_outstanding_batch(tmp_path)
    upstream = FakeUpstream({"batch_abc": FetchResult(status="pending", detail="in_progress")})
    version_before = store.get("r1").result_version

    out = reconcile_run("r1", store=store, fetch=upstream)

    assert out.status == "pending"
    assert out.pending == ("split",)
    assert out.attached == {}
    assert store.get("r1").result_version == version_before
    assert "split" not in read_checkpoint(wd, "gate1").responses
    assert not (wd / "responses_split.jsonl").exists()


def test_batch_reconcile_records_a_failure_and_keeps_completed_stage_output(tmp_path):
    """T-08-58: a failed retrieval must never be allowed to discard output that was already completed and
    PAID FOR. The failure is recorded against the run so an operator can see it; the earlier stage's
    answers stay exactly where they were."""
    from backend.batch_reconcile import FetchResult, reconcile_run

    store, wd = _paused_with_outstanding_batch(tmp_path)
    _wrote_responses(wd, "split", {"0:0": {"g": 1}})  # one of the two came back on the first leg
    upstream = FakeUpstream({"batch_abc": FetchResult(status="failed", detail="expired")})

    out = reconcile_run("r1", store=store, fetch=upstream)

    assert out.status == "failed"
    assert out.failed == ("split",)
    body = (wd / "reconcile_failures.jsonl").read_text()
    assert "expired" in body and "split" in body
    lines = [json.loads(x) for x in (wd / "responses_split.jsonl").read_text().splitlines() if x.strip()]
    assert [x["id"] for x in lines] == ["0:0"], "a failed retrieval discarded a response already paid for"
    assert read_checkpoint(wd, "gate1").responses["generate"] == {"c0": {"ideal": "x"}}


def test_batch_reconcile_raises_a_typed_error_naming_the_run_and_the_missing_path(tmp_path):
    """Reporting success for a run whose work dir is gone would mark paid work reconciled when it is in
    fact unrecoverable. The operator's next step is to look at that path, so the error names it."""
    from backend.batch_reconcile import WorkDirMissingError, reconcile_run

    store = JobStore(work_root=tmp_path)
    store.create("ghost", "No work dir", {})

    with pytest.raises(WorkDirMissingError) as exc:
        reconcile_run("ghost", store=store, fetch=FakeUpstream({}))
    assert "ghost" in str(exc.value)
    assert str(tmp_path / "ghost") in str(exc.value)


def test_batch_reconcile_never_submits_anything(tmp_path):
    """Reconciliation RETRIEVES work already charged for; retrieval is free. Reaching for a submitting
    entry point here would make a background sweep able to spend money with no user in the loop
    (T-08-56), which is the opposite of this module's purpose."""
    import inspect

    from backend import batch_reconcile

    src = inspect.getsource(batch_reconcile)
    for submitter in ("submit_batch", "submit_and_wait", "resume_and_wait"):
        assert f"{submitter}(" not in src, f"batch_reconcile calls {submitter} — a sweep must never submit"
    assert "harmonize_leanb" not in src, "pipeline knowledge belongs in the adapter, not here"


def test_the_tag_to_stage_map_matches_the_adapters_batch_wiring():
    """A drift guard, not a tautology. The batch cache tag is NOT the stage kwarg (``classify`` caches to
    ``assign``, ``distinct_kinds`` to ``kinds``), so a hand-written map is the only way this module can
    attach a reconciled response under the name the replay path reads — and a renamed tag in the adapter
    would otherwise silently route paid answers to a stage nobody replays.

    Read out of the adapter's AST rather than by importing it, so this module stays free of the engine.
    """
    import ast
    import inspect

    from backend.batch_reconcile import TAG_TO_STAGE
    from backend.engine import adapter as adapter_module

    tree = ast.parse(inspect.getsource(adapter_module))
    wired: dict[str, str] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if not (isinstance(fn, ast.Name) and fn.id == "_batch_stage"):
            continue
        # _batch_stage(phase, progress, work_dir, tag, ledger, ...) — the tag is the 4th positional.
        if len(node.args) >= 4 and isinstance(node.args[3], ast.Constant):
            wired[str(node.args[3].value)] = "?"
    # The judge stages carry their tag in a table, which IS importable without pipeline knowledge.
    for name, spec in adapter_module._JUDGE_STAGES.items():
        wired[spec["tag"]] = name

    assert set(wired) <= set(
        TAG_TO_STAGE
    ), f"the adapter caches batch tags this module cannot map to a stage: {sorted(set(wired) - set(TAG_TO_STAGE))}"
    for tag, stage in wired.items():
        if stage != "?":
            assert TAG_TO_STAGE[tag] == stage, f"tag {tag!r} maps to {TAG_TO_STAGE[tag]!r}, adapter says {stage!r}"


# ── D-04 wired BOTH ways: startup, interval, and on-open ─────────────────────────────────────


def test_the_startup_hook_sweeps_exactly_once(monkeypatch, tmp_path):
    """A restart is one of the two events that strands a submitted batch (the other is a reviewer who never
    returns). If the sweep only ran on a timer, every redeploy would leave paid work unreachable for a full
    interval; if it ran per request, a busy server would poll the provider once per page view."""
    from backend import batch_reconcile

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    calls: list[str] = []
    monkeypatch.setattr(batch_reconcile, "sweep", lambda **kw: calls.append("swept") or [])

    with TestClient(app_module.app):
        pass

    assert calls == ["swept"], f"the startup sweep ran {len(calls)} time(s)"


def test_the_interval_is_a_documented_constant_not_a_magic_number():
    """T-08-56: the sweep polls an external API on a timer, so the number that decides how often has to be
    stateable and reviewable rather than buried in a call."""
    from backend import batch_reconcile

    assert isinstance(batch_reconcile.RECONCILE_INTERVAL_SECONDS, int)
    assert 60 <= batch_reconcile.RECONCILE_INTERVAL_SECONDS <= 900


def test_reopening_a_paused_run_reconciles_it_before_returning_its_payload(monkeypatch, tmp_path):
    """The fast path. Without it a returning reviewer sees a run short of the work they paid for until the
    next interval tick — up to five minutes of a screen that is quietly wrong."""
    from backend import batch_reconcile
    from backend.batch_reconcile import FetchResult

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    upstream = FakeUpstream(
        {"batch_open": FetchResult(status="available", records=({"id": "0:0", "response": {"groups": ["a"]}},))}
    )
    monkeypatch.setattr(batch_reconcile, "_retrieve_via_core", upstream)

    with TestClient(app_module.app) as c:
        wd = tmp_path / "work" / "reopen"
        _submitted_batch(wd, "split", "batch_open", ["0:0"])
        write_checkpoint(wd, job_id="reopen", gate="gate1", result={"conceptGroups": []}, responses={})
        app_module.store.create("reopen", "Paused", {}, owner_subject=None)
        app_module.store.checkpoint("reopen", gate="gate1", checkpoint_ref="reopen/checkpoint_gate1.json")
        version_before = app_module.store.get("reopen").result_version

        body = c.get("/api/harmonize/checkpoint/reopen").json()

    assert upstream.calls == ["batch_open"], "reopening a paused run did not reconcile it"
    # The payload SERVED must already reflect the reconcile — a version bump the reviewer only learns about
    # on their next poll means the screen they are looking at is the pre-reconcile one.
    assert body["resultVersion"] == version_before + 1
    assert read_checkpoint(tmp_path / "work" / "reopen", "gate1").responses["split"] == {"0:0": {"groups": ["a"]}}


def test_a_result_for_a_gate_the_run_has_already_advanced_past_is_still_attached(tmp_path):
    """D-04's late-arrival case. The reviewer walked away mid-batch, came back, continued past that gate,
    and the result then landed. Dropping it discards work they were charged for on the grounds that they
    were slow — so it is attached to the checkpoint the run is parked at NOW, which is the file the next
    leg replays from."""
    from backend.batch_reconcile import FetchResult, reconcile_run

    store = JobStore(work_root=tmp_path)
    wd = tmp_path / "adv"
    _submitted_batch(wd, "split", "batch_late", ["0:0"])  # a Gate 1 stage
    write_checkpoint(
        wd,
        job_id="adv",
        gate="gate2",  # the run has advanced PAST the gate that batch belongs to
        result={"records": [{"id": "r1"}]},
        responses={"classify": {"g0": {"verdict": "adopt"}}},
        realized_cost=4.0,
    )
    store.create("adv", "Advanced", {})
    store.checkpoint("adv", gate="gate2", checkpoint_ref="adv/checkpoint_gate2.json", realized_cost=4.0)
    upstream = FakeUpstream(
        {"batch_late": FetchResult(status="available", records=({"id": "0:0", "response": {"groups": ["z"]}},))}
    )

    out = reconcile_run("adv", store=store, fetch=upstream)

    assert out.status == "reconciled"
    ckpt = read_checkpoint(wd, "gate2")
    assert ckpt.responses["split"] == {"0:0": {"groups": ["z"]}}
    assert ckpt.responses["classify"] == {"g0": {"verdict": "adopt"}}, "the current gate's own answers were lost"
    assert ckpt.gate == "gate2", "attaching a late result moved the run's gate position"


def test_two_racing_reconciles_have_the_combined_effect_of_one(tmp_path):
    """T-08-53 as a GENUINE race, not an interleaving. The interval sweep and a reviewer's reopen can land
    on the same run at the same instant; the effect count must still be one, or the version token moves
    twice and every connected client refetches twice for one arrival."""
    from backend.batch_reconcile import FetchResult, reconcile_run

    store, wd = _paused_with_outstanding_batch(tmp_path, job_id="race")
    upstream = FakeUpstream(
        {
            "batch_abc": FetchResult(
                status="available",
                records=({"id": "0:0", "response": {"g": 1}}, {"id": "0:1", "response": {"g": 2}}),
            )
        }
    )
    version_before = store.get("race").result_version
    barrier = threading.Barrier(2)
    outcomes: list[object] = []
    # A real fetch is network I/O and RELEASES the GIL, so the window both callers can be inside is wide.
    # Reproduce that here: without it this test passes on scheduling luck and would flip in production —
    # the exact class of "green for the wrong reason" this phase keeps catching.
    slow = upstream

    def fetch(batch_id, **kw):
        time.sleep(0.05)
        return slow(batch_id, **kw)

    def go() -> None:
        barrier.wait()
        outcomes.append(reconcile_run("race", store=store, fetch=fetch))

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(upstream.calls) == 1, f"a genuine race issued {len(upstream.calls)} upstream calls"
    assert store.get("race").result_version == version_before + 1, "the version token moved more than once"
    assert sum(1 for o in outcomes if o.status == "reconciled") == 1
    lines = [json.loads(x) for x in (wd / "responses_split.jsonl").read_text().splitlines() if x.strip()]
    assert len(lines) == 2, "a racing reconcile duplicated records in the response cache"


def test_a_pinned_demo_run_is_never_reconciled(tmp_path):
    """The gate READ path is demo-scoped, so it is the one reconcile trigger an unauthenticated caller can
    reach. A guest must not be able to make the server talk to a provider, and the shared demo is immutable
    anyway (it holds nobody's paid work)."""
    from backend.batch_reconcile import reconcile_run

    store = JobStore(work_root=tmp_path)
    wd = tmp_path / "demo-x"
    _submitted_batch(wd, "split", "batch_demo", ["0:0"])
    store.create("demo-x", "Demo", {"demo": True})
    upstream = FakeUpstream({})

    out = reconcile_run("demo-x", store=store, fetch=upstream)

    assert out.status == "skipped"
    assert upstream.calls == []


def test_no_reconcile_http_route_was_added():
    """D-04's sweep is internal and the on-open path already has a request. A route would be a surface with
    no caller, one more thing to auth-scope, and (being reachable) a way to make the server poll on demand."""
    paths = [getattr(r, "path", "") for r in app_module.app.routes]
    assert not [p for p in paths if "reconcile" in p.lower()], f"a reconcile route exists: {paths}"
    posts = len([1 for r in app_module.app.routes if "POST" in (getattr(r, "methods", None) or set())])
    assert posts == 12, f"the POST surface changed ({posts} != 12)"
