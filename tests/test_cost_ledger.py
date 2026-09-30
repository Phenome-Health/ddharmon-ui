"""08-28 1a: a staged run's realized cost is CUMULATIVE across its legs — never one leg's share.

A staged run is walked through gates, and every Continue starts a NEW worker leg that replays the earlier
legs' recorded answers for $0 and pays only for new work. Each leg used to build a fresh ``CostLedger``, so
the checkpoint written at the next gate carried only that leg's spend. Live verify 3 (run 6c66731c) measured
what that does to a reviewer:

* F14 — Gate 3's checkpoint said ``realizedCost`` $0.05 (that leg's specs + refine + re-pick) on a run that
  had cost ~$0.82, and Gates 3/4 told the reviewer "Already spent to reach this gate: $0.05".
* F10 — a stage the resumed leg only REPLAYED (the coherence judge) added no ledger line, so it vanished from
  the next checkpoint and Gate 1's rail "spent" changed after the fact.
* F3 — the live "spent so far" chip dropped from $0.70 to $0.13 when the resumed leg reported its own total.
* F5 — the paid score-component extraction was recorded nowhere.
* F8 — a keyless start was not refused at the door; the run errored after embedding.

Every case runs without a provider: embeddings and clustering are stubbed and the "LLM" is a fake client that
logs one priced usage per call, so the cost arithmetic is real and nothing is ever billed.
"""

from __future__ import annotations

import threading

import pytest
from ddharmon.clustering.topic_engine import collect_inputs
from ddharmon.llm.cost import TokenUsage, price_usage
from ddharmon.models.cluster import FieldCluster, TopicModelResult

from backend import runner as runner_module
from backend.checkpoint import read_checkpoint
from backend.jobs import AWAITING_REVIEW, JobStore
from tests.test_checkpoint import StubProvider

_MODEL = "claude-sonnet-4-6"
#: What one fake sync call costs. Priced by core, not hardcoded, so a price-map change cannot break the test.
_PER_CALL = price_usage(_MODEL, 1000, 500)


class _FakeClient:
    """A sync LLM client that answers every prompt and logs one usage record per call. No network, no key."""

    def __init__(self) -> None:
        self.log: list[TokenUsage] = []
        self.calls = 0
        self._lock = threading.Lock()

    def complete(self, prompt, *, system=None, max_tokens=512):  # noqa: ARG002 — the client signature
        with self._lock:
            self.log.append(TokenUsage(_MODEL, 1000, 500))
            self.calls += 1
        return {"ideal_cde": "Smoking status", "verdict": "adopt", "cde_id": "1", "code_map": {}, "confidence": 0.9}

    def drain_usage(self):
        with self._lock:
            log, self.log = self.log, []
        return log


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


def _fixture_specs(tmp_path):
    """Two cohorts, eight variables: one cluster big enough for the coherence judge (it skips groups < 6)."""
    rows = {
        "a": [
            "SMOKE_A\tCurrent smoking status",
            "CIG_A\tCigarettes per day",
            "PIPE_A\tPipe smoking",
            "QUIT_A\tAge quit",
        ],
        "b": ["SMOKE_B\tDo you smoke", "CIG_B\tCigarettes smoked daily", "CIGAR_B\tCigar use", "START_B\tAge started"],
    }
    specs = []
    roles = {"variable_name": "var", "description": "desc"}
    for name, lines in rows.items():
        path = tmp_path / f"{name}.tsv"
        path.write_text("var\tdesc\n" + "\n".join(lines) + "\n")
        specs.append({"path": str(path), "cohort_name": f"Cohort{name.upper()}", "column_roles": roles})
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nSmokeCDE\tSmoking status\nAgeCDE\tAge in years\n")
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {"variable_name": "designation", "description": "definition"},
    }
    return specs, cde_spec


def _base_config(work_dir) -> dict:
    return {
        "run_mode": "sync",
        "cde_cohort": "NIH_CDE",
        "work_dir": str(work_dir),
        "min_cluster_size": 2,
        "retrieval_floor": 0.0,
        "model_tag": _MODEL,
    }


# ── fix 1: every leg's ledger is seeded with the legs before it ─────────────────────────────────────────


def test_a_resumed_legs_checkpoint_carries_the_whole_runs_spend(tmp_path, _one_cluster, monkeypatch):
    """F14 + F10 + F3 in one walk: Gate 2's checkpoint holds Gate 1's spend too — including a replayed stage.

    Leg 1 reaches Gate 1 (ideal + split + the coherence judge, all priced). Leg 2 replays all three for $0 and
    pays for assign + GenCDE. Its checkpoint must carry every Gate 1 line UNCHANGED (``judging`` included, the
    line the live run lost), and a total equal to leg 1's plus exactly the calls leg 2 made. The live counter,
    sampled after every job write, must never go backwards across the resume.
    """
    client = _FakeClient()
    monkeypatch.setattr("backend.engine.llm.build_llm_client", lambda *a, **k: client)
    dict_specs, cde_spec = _fixture_specs(tmp_path)
    wd = tmp_path / "work" / "j"
    base = _base_config(wd)
    store = JobStore(work_root=tmp_path / "work")
    store.create("j", "J", base)

    live: list[float] = []
    real_update = store.update

    def spy(job_id, **fields):
        ok = real_update(job_id, **fields)
        live.append(store.get(job_id).cost_so_far)
        return ok

    monkeypatch.setattr(store, "update", spy)

    runner_module.run_harmonization(
        store, "j", dict_specs, cde_spec, {**base, "stop_at_gate": "gate1"}, provider=StubProvider()
    )
    g1 = read_checkpoint(wd, "gate1")
    leg1 = g1.result["cost"]
    assert {"generating", "splitting", "judging"} <= set(leg1["perStage"]), leg1["perStage"]
    assert leg1["actualUsd"] > 0
    assert g1.realized_cost == pytest.approx(leg1["actualUsd"])
    calls_after_leg1 = client.calls

    # What resume_run does: flip the run to pending, then hand the worker the checkpoint's answers and cost.
    store.update("j", status="pending", phase="pending", phase_timings={})
    runner_module.run_harmonization(
        store,
        "j",
        dict_specs,
        cde_spec,
        {**base, "stop_at_gate": "gate2", "park_at_gate": "gate2"},
        provider=StubProvider(),
        replay_responses=g1.responses,
        prior_cost=leg1,
    )
    g2 = read_checkpoint(wd, "gate2")
    leg2 = g2.result["cost"]
    new_calls = client.calls - calls_after_leg1
    assert new_calls > 0, "leg 2 bought nothing — the fixture no longer exercises a paid resume"

    for key in leg1["perStage"]:
        assert key in leg2["perStage"], f"the resumed leg dropped Gate 1's {key!r} line (F10)"
    assert leg2["perStage"]["judging"] == leg1["perStage"]["judging"], "a replayed stage's line changed"
    assert leg2["perStage"]["generating"] == leg1["perStage"]["generating"], "a replay was charged again"
    assert "assigning" in leg2["perStage"]
    assert leg2["actualUsd"] == pytest.approx(leg1["actualUsd"] + new_calls * _PER_CALL), "not cumulative (F14)"
    assert g2.realized_cost == pytest.approx(leg2["actualUsd"])
    assert store.get("j").cost_so_far == pytest.approx(leg2["actualUsd"])
    assert live == sorted(live), f"the live spend counter went backwards across the resume (F3): {live}"


def test_the_live_counter_never_goes_backwards_when_a_leg_reports_less(tmp_path, monkeypatch):
    """F3's belt: whatever a leg reports, the job's spent figure is monotonic.

    A leg whose ledger was not seeded (a legacy checkpoint with no cost block, say) reports only its own spend.
    Showing that to a reviewer who has already been charged more is the backwards chip the live run caught.
    """
    store = JobStore(work_root=tmp_path / "work")
    store.create("p", "Parked", {"work_dir": str(tmp_path / "work" / "p")})
    store.checkpoint("p", gate="gate1", checkpoint_ref="p/checkpoint_gate1.json", realized_cost=0.70)
    store.update("p", status="pending", phase="pending")
    during: list[float] = []

    def fake_pipeline(dict_specs, cde_spec, config, *, progress, **kwargs):
        progress("assigning", 1, 2, 0.13)
        during.append(store.get("p").cost_so_far)
        raise RuntimeError("stop here")  # a resumed leg's failure leaves the run parked

    monkeypatch.setattr(runner_module, "run_pipeline", fake_pipeline)
    runner_module.run_harmonization(
        store, "p", [], None, {"work_dir": str(tmp_path / "work" / "p")}, replay_responses={"generate": {}}
    )
    assert during == [pytest.approx(0.70)], "the live counter dropped to the new leg's own total"
    assert store.get("p").status == AWAITING_REVIEW


def test_a_checkpoint_never_lowers_what_the_run_is_said_to_have_cost(tmp_path):
    """The park write is monotonic too: re-parking with a smaller figure cannot rewind the counter."""
    store = JobStore(work_root=tmp_path / "work")
    store.create("m", "M", {})
    store.checkpoint("m", gate="gate2", checkpoint_ref="m/checkpoint_gate2.json", realized_cost=0.82)
    store.checkpoint("m", gate="gate3", checkpoint_ref="m/checkpoint_gate3.json", realized_cost=0.05)
    assert store.get("m").cost_so_far == pytest.approx(0.82)


def test_the_runner_hands_the_prior_cost_to_the_pipeline(tmp_path, monkeypatch):
    """The seed must actually reach the adapter; a runner that swallowed it would re-open F14 silently."""
    store = JobStore(work_root=tmp_path / "work")
    store.create("s", "S", {"work_dir": str(tmp_path / "work" / "s")})
    seen: dict = {}

    def fake_pipeline(dict_specs, cde_spec, config, *, progress, **kwargs):
        seen.update(kwargs)
        return {"gatePosition": "gate2", "records": [], "cost": kwargs.get("prior_cost") or {}}

    monkeypatch.setattr(runner_module, "run_pipeline", fake_pipeline)
    prior = {"actualUsd": 0.7, "tokens": {"input": 1, "output": 1}, "perStage": {"judging": {"usd": 0.04}}}
    runner_module.run_harmonization(
        store,
        "s",
        [],
        None,
        {"work_dir": str(tmp_path / "work" / "s"), "stop_at_gate": "gate2"},
        replay_responses={"generate": {}},
        prior_cost=prior,
    )
    assert seen.get("prior_cost") == prior


def _parked(monkeypatch, tmp_path, job_id: str, gate: str, *, cost: dict, realized: float, job_cost: float):
    """A run parked at ``gate`` whose checkpoint carries ``cost``; returns the captured worker kwargs."""
    from backend import app as app_module
    from backend.checkpoint import write_checkpoint

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    spawned: list[dict] = []
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: spawned.append(dict(k)))
    wd = tmp_path / "work" / job_id
    app_module.store.create(
        job_id,
        "Parked",
        {"work_dir": str(wd), "cde_set": "endorsed"},
        owner_subject=None,
        dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
    )
    result = {"records": [{"id": "r1"}], "conceptGroups": [{"groupId": "g0"}], "cost": cost}
    write_checkpoint(wd, job_id=job_id, gate=gate, result=result, responses={"generate": {}}, realized_cost=realized)
    app_module.store.checkpoint(job_id, gate=gate, checkpoint_ref=f"{job_id}/checkpoint_{gate}.json", realized_cost=0)
    app_module.store.update(job_id, cost_so_far=job_cost)
    return app_module, wd, spawned


_GATE1_COST = {
    "actualUsd": 0.6992,
    "tokens": {"input": 10, "output": 5},
    "perStage": {
        "generating": {"usd": 0.127, "inputTokens": 4, "outputTokens": 2, "calls": 9},
        "splitting": {"usd": 0.528, "inputTokens": 4, "outputTokens": 2, "calls": 9},
        "judging": {"usd": 0.0442, "inputTokens": 2, "outputTokens": 1, "calls": 3},
    },
}


def test_continue_hands_the_checkpoints_cost_to_the_next_leg(monkeypatch, tmp_path):
    """The seed's source: Continue must pass the parked checkpoint's cost block to the worker it spawns."""
    from fastapi.testclient import TestClient

    app_module, _wd, spawned = _parked(
        monkeypatch, tmp_path, "c1", "gate1", cost=_GATE1_COST, realized=0.6992, job_cost=0.6992
    )
    with TestClient(app_module.app) as c:
        r = c.post("/api/harmonize/resume/c1", headers={"x-anthropic-key": "sk-test"}, json={"gate1Scope": ["g0"]})
    assert r.status_code == 200, r.text
    assert spawned and spawned[-1].get("prior_cost") == _GATE1_COST


def test_the_gate_4_hop_carries_the_cumulative_cost_and_never_lowers_it(monkeypatch, tmp_path):
    """Gate 4 is a pure read, so it carries the Gate 3 figure — the cumulative one, consistently.

    Its checkpoint's ``realizedCost`` must agree with the result's own cost block (the one the rail reads), and
    the run's counter must not drop to a smaller carried figure.
    """
    from fastapi.testclient import TestClient

    gate3_cost = {**_GATE1_COST, "actualUsd": 0.82}
    app_module, wd, spawned = _parked(
        monkeypatch, tmp_path, "c4", "gate3", cost=gate3_cost, realized=0.0495, job_cost=0.85
    )
    with TestClient(app_module.app) as c:
        r = c.post("/api/harmonize/resume/c4")
    assert r.status_code == 200, r.text
    assert spawned == []
    g4 = read_checkpoint(wd, "gate4")
    assert g4.realized_cost == pytest.approx(0.82), "Gate 4 carried a per-leg figure the result contradicts"
    assert g4.result["cost"] == gate3_cost
    assert app_module.store.get("c4").cost_so_far == pytest.approx(0.85), "a pure read rewound the counter"


# ── fix 2: a batch stage prices only what THIS call bought ──────────────────────────────────────────────


def _prompt(pid: str):
    from ddharmon.harmonization.pipeline import PromptRecord

    return PromptRecord(id=pid, system_prompt="sys", user_prompt=f"u-{pid}", schema="{}", model_tag=_MODEL)


def _line(pid: str) -> str:
    import json

    return json.dumps(
        {
            "id": pid,
            "response": {"ok": pid},
            "usage": {"input_tokens": 2000, "output_tokens": 1000},
            "model": _MODEL,
        }
    )


def _fake_core_resume(submitted: list):
    """Core's cache-aware ``resume_and_wait``, minus the provider: append a response for each MISSING id."""
    import json

    def resume_and_wait(prompts_path, output_path, *, api_key=None, **kw):  # noqa: ARG001
        have = set()
        try:
            with open(output_path) as f:
                have = {json.loads(ln)["id"] for ln in f if ln.strip()}
        except FileNotFoundError:
            pass
        with open(prompts_path) as f:
            ids = [json.loads(ln)["id"] for ln in f if ln.strip()]
        missing = [i for i in ids if i not in have]
        submitted.append({"prompts_path": str(prompts_path), "missing": missing})
        with open(output_path, "a") as f:
            for i in missing:
                f.write(_line(i) + "\n")
        return len(missing)

    return resume_and_wait


def test_a_batch_stage_prices_only_the_ids_new_in_this_call(monkeypatch, tmp_path):
    """The side finding: ``_batch_stage`` priced EVERY id in ``responses_<tag>.jsonl``, not only the new ones.

    A resumed leg (or a recursive split level) asking for two new prompts re-billed every answer the earlier
    leg had already paid for — and rewrote ``prompts_<tag>.jsonl`` with the two-prompt gap, erasing leg 1's
    record of what it asked. Only the new ids may be priced, and leg 1's prompt record must survive.
    """
    from ddharmon.harmonization import write_prompts_jsonl

    from backend.engine import adapter as adapter_mod

    wd = tmp_path / "w"
    wd.mkdir()
    leg1_ids = ["c0", "c1", "c2"]
    write_prompts_jsonl([_prompt(i) for i in leg1_ids], wd / "prompts_generate.jsonl")
    (wd / "responses_generate.jsonl").write_text("".join(_line(i) + "\n" for i in leg1_ids))
    leg1_record = (wd / "prompts_generate.jsonl").read_text()

    submitted: list = []
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core_resume(submitted))
    ledger = adapter_mod.CumulativeLedger()
    stage = adapter_mod._batch_stage("generating", lambda *a, **k: None, wd, "generate", ledger)
    out = stage([_prompt("c3"), _prompt("c4")])

    per_call = price_usage(_MODEL, 2000, 1000, batch=True)
    line = ledger.to_dict()["perStage"]["generating"]
    assert line["calls"] == 2, f"priced {line['calls']} answers for a 2-prompt call (re-billed the cache)"
    assert out == {"c3": {"ok": "c3"}, "c4": {"ok": "c4"}}, "the stage answered prompts it was not asked"
    assert ledger.total_usd == pytest.approx(2 * per_call)
    assert submitted and submitted[-1]["missing"] == ["c3", "c4"]
    assert (wd / "prompts_generate.jsonl").read_text().startswith(leg1_record), "leg 1's prompt record was erased"

    # The $0 replay property is untouched: asking again for the same prompts submits and prices nothing.
    again = stage([_prompt("c3"), _prompt("c4")])
    assert again == out
    assert submitted[-1]["missing"] == []
    assert ledger.total_usd == pytest.approx(2 * per_call), "a cache replay was priced"


def test_a_gap_submitted_from_the_sidecar_is_still_reconcilable(tmp_path):
    """A gap batch submitted from the sidecar leaves its manifest under the sidecar's name; the reconciler
    must still route it to the stage, or a kill mid-poll strands paid work under a tag nobody replays."""
    import json

    from backend.batch_reconcile import outstanding_submissions

    wd = tmp_path / "w"
    wd.mkdir()
    (wd / "responses_split.jsonl").write_text(_line("0:0") + "\n")
    for name in ("prompts_split.jsonl.gap.resume.batch_manifest.json", "prompts_split.jsonl.gap.batch_manifest.json"):
        (wd / name).write_text(json.dumps({"batch_id": f"b-{name}", "id_map": {"r0": "0:1"}}))
    subs = outstanding_submissions(wd)
    assert sorted(s.tag for s in subs) == ["split", "split"]
    assert {s.stage for s in subs} == {"split"}

    from backend import batch_reconcile
    from backend.engine.adapter import BATCH_GAP_SUFFIX

    assert batch_reconcile._SIDECAR_SUFFIX == BATCH_GAP_SUFFIX, "the reconciler no longer knows the sidecar name"
