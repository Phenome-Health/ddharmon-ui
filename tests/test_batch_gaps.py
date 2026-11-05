"""08-28 — a partial batch is never silently accepted.

Core's ``retrieve_batch`` logs and SKIPS every errored / expired / canceled result, so a batch stage can come back
holding answers for only some of the prompts it asked. ``_batch_stage`` used to hand core whatever came back and
never compare it with what it asked. Two todos measured what that does:

* a split where 6 of 336 cluster prompts errored gave Gate 1 an incomplete partition (≈90 variables missing)
  and parked it ``awaiting_review`` as if complete — the reviewer scoped a set of groups that was not the run's;
* a demo rebuild found 80 prompts across five stages (generate, split, assign, gencde, specs) that the SHIPPED
  demo had been built without, with nothing anywhere saying so.

What these tests pin, per stage class:

* a DECIDING stage (the partition — generate/split — and every verdict or artifact after Gate 1: assign, gencde,
  specgen, refine, the re-pick) re-asks ONLY its unanswered prompts, once, on the leg's own transport; still short,
  it FAILS the leg naming the stage and the ids, so the run stays parked at its last good gate instead of
  presenting a partial result as a complete one;
* an ADVISORY stage (the judge: coherence / distinct_kinds / concept_gate) proceeds — its failure is designed to
  cost the run a flag and nothing else — but the ids it never heard back on are recorded on the result, so a
  reviewer is told "not judged", never "clean";
* only what was actually billed is priced: an errored item costs nothing, the retry's answers are priced once.

Nothing here reaches a provider: core's batch wait, the Batch API and the sync client are fakes.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable
from pathlib import Path

import pytest
from ddharmon.llm.cost import price_usage

from backend import runner as runner_module
from backend.batch_reconcile import TAG_TO_STAGE
from backend.checkpoint import checkpoint_path, read_checkpoint, write_checkpoint
from backend.engine import adapter as adapter_mod
from backend.engine import contract
from backend.jobs import AWAITING_REVIEW, JobStore
from tests.test_checkpoint import StubProvider
from tests.test_cost_ledger import _base_config, _fixture_specs, _one_cluster  # noqa: F401 — a fixture, used by name

_MODEL = "claude-sonnet-4-6"
_BATCH_ITEM = price_usage(_MODEL, 2000, 1000, batch=True)
#: Every answer the fake provider gives: enough shape for each leanb stage to parse something.
_ANSWER = {"ideal_cde": "Smoking status", "verdict": "adopt", "cde_id": "1", "code_map": {}, "confidence": 0.9}

#: The stage classes, READ from the maps the rest of the backend already uses — never a hand-kept third list.
#: ``_note_reconcile_failures`` draws the same line: a tag is advisory iff it caches one of ``_JUDGE_STAGES``.
_ADVISORY_TAGS = sorted(w["tag"] for w in adapter_mod._JUDGE_STAGES.values())
_DECIDING_TAGS = sorted(set(TAG_TO_STAGE) - set(_ADVISORY_TAGS))


def _prompt(pid: str):
    from ddharmon.harmonization.pipeline import PromptRecord

    return PromptRecord(id=pid, system_prompt="sys", user_prompt=f"u-{pid}", schema="{}", model_tag=_MODEL)


def _line(pid: str, response=None) -> str:
    return json.dumps(
        {
            "id": pid,
            "response": response if response is not None else {"ok": pid},
            "usage": {"input_tokens": 2000, "output_tokens": 1000},
            "model": _MODEL,
        }
    )


def _ids(path: Path) -> list[str]:
    return [json.loads(ln)["id"] for ln in path.read_text().splitlines() if ln.strip()] if path.exists() else []


def _fake_core(drop: Callable[[str, int], bool], log: list, *, answer=None, on_call=None):
    """Core's cache-aware ``resume_and_wait``, minus the provider.

    Submits exactly the prompt ids the responses file lacks (``log`` gets that list per call) and writes a result
    for each — unless ``drop(pid, nth)`` says this item errored on its ``nth`` submission, in which case, like
    ``retrieve_batch``, nothing is written for it at all. An errored item is never billed, so it carries no usage.
    """
    seen: Counter = Counter()

    def resume_and_wait(prompts_path, output_path, *, api_key=None, **kw):  # noqa: ARG001
        output_path = Path(output_path)
        have = set(_ids(output_path))
        asked = [json.loads(ln)["id"] for ln in Path(prompts_path).read_text().splitlines() if ln.strip()]
        missing = [pid for pid in asked if pid not in have]
        log.append(missing)
        if on_call is not None:
            on_call()
        written = 0
        with open(output_path, "a") as f:
            for pid in missing:
                seen[pid] += 1
                if drop(pid, seen[pid]):
                    continue
                f.write(_line(pid, answer) + "\n")
                written += 1
        return written

    return resume_and_wait


@pytest.fixture
def no_provider(monkeypatch):
    """Heartbeats at test speed, and every real provider path turned into a test failure."""
    monkeypatch.setattr(adapter_mod, "_BATCH_POLL_SECS", 0.01)
    monkeypatch.setattr(adapter_mod, "_BATCH_STATUS_SECS", 0.0)

    def _never(*a, **k):
        raise AssertionError("a test reached a real provider client")

    for name in ("resume_and_wait", "submit_and_wait", "submit_batch", "retrieve_batch"):
        monkeypatch.setattr(f"ddharmon.llm.batch.{name}", _never)
    monkeypatch.setattr(adapter_mod, "_batches_api", _never)
    monkeypatch.setattr("backend.engine.llm.build_llm_client", _never)


def _noop(*a, **k):
    return None


# ── one batch stage, deciding ─────────────────────────────────────────────────────────────────────


def test_a_deciding_stage_re_asks_only_its_unanswered_prompts_once(monkeypatch, tmp_path, no_provider):
    log: list = []
    monkeypatch.setattr(
        "ddharmon.llm.batch.resume_and_wait", _fake_core(lambda pid, nth: pid == "p2" and nth == 1, log)
    )
    ledger = adapter_mod.CumulativeLedger()
    out = adapter_mod._batch_stage("splitting", _noop, tmp_path, "split", ledger)(
        [_prompt(p) for p in ("p0", "p1", "p2", "p3")]
    )
    assert set(out) == {"p0", "p1", "p2", "p3"}, "the errored prompt was handed on unanswered"
    assert log == [["p0", "p1", "p2", "p3"], ["p2"]], "the retry was not a resubmit of just the gap"
    line = ledger.to_dict()["perStage"]["splitting"]
    assert line["calls"] == 4, "every answer priced exactly once — the errored first try was never billed"
    assert line["usd"] == pytest.approx(4 * _BATCH_ITEM), "the retry was not bought at the batch rate"
    assert sorted(_ids(tmp_path / "prompts_split.jsonl")) == ["p0", "p1", "p2", "p3"], "the prompt record changed"


def test_a_deciding_stage_still_short_after_its_retry_fails_naming_the_stage_and_the_ids(
    monkeypatch, tmp_path, no_provider
):
    log: list = []
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(lambda pid, nth: pid in ("p1", "p3"), log))
    ledger = adapter_mod.CumulativeLedger()
    stage = adapter_mod._batch_stage("splitting", _noop, tmp_path, "split", ledger)
    with pytest.raises(adapter_mod.StageIncompleteError) as caught:
        stage([_prompt(p) for p in ("p0", "p1", "p2", "p3")])

    err = caught.value
    assert err.tag == "split" and err.missing == ["p1", "p3"] and err.asked == 4
    msg = str(err)
    assert "A required step (split)" in msg, "not in the reconcile path's 'a required step failed' vocabulary"
    assert "2 of 4" in msg and "p1" in msg and "p3" in msg, f"the message does not name what is missing: {msg}"
    assert "press Continue to retry" in msg
    assert log == [["p0", "p1", "p2", "p3"], ["p1", "p3"]], "not exactly one retry of just the gap"
    line = ledger.to_dict()["perStage"]["splitting"]
    assert line["calls"] == 2 and line["usd"] == pytest.approx(2 * _BATCH_ITEM), "priced something never billed"
    assert sorted(_ids(tmp_path / "responses_split.jsonl")) == ["p0", "p2"], "paid answers were not kept on disk"


def test_a_long_gap_is_named_in_part_and_carried_whole(monkeypatch, tmp_path, no_provider):
    """The message names the first ids and counts the rest; the exception carries every id for a caller."""
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(lambda pid, nth: pid != "p00", []))
    prompts = [_prompt(f"p{i:02d}") for i in range(25)]
    with pytest.raises(adapter_mod.StageIncompleteError) as caught:
        adapter_mod._batch_stage("assigning", _noop, tmp_path, "assign", adapter_mod.CumulativeLedger())(prompts)
    assert caught.value.missing == [f"p{i:02d}" for i in range(1, 25)]
    assert "24 of 25" in str(caught.value) and "+14 more" in str(caught.value)


@pytest.mark.parametrize("tag", _DECIDING_TAGS)
def test_no_deciding_stage_passes_a_partial_answer_set(monkeypatch, tmp_path, no_provider, tag):
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(lambda pid, nth: pid == "p1", []))
    stage = adapter_mod._batch_stage("specs", _noop, tmp_path, tag, adapter_mod.CumulativeLedger())
    with pytest.raises(adapter_mod.StageIncompleteError):
        stage([_prompt("p0"), _prompt("p1")])


# ── one batch stage, advisory ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("tag", _ADVISORY_TAGS)
def test_an_advisory_stage_proceeds_with_its_gap_and_buys_no_retry(monkeypatch, tmp_path, no_provider, tag):
    """A flag's absence is honest ("not judged"); re-buying it is spend the run can do without."""
    log: list = []
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(lambda pid, nth: pid == "p1", log))
    ledger = adapter_mod.CumulativeLedger()
    out = adapter_mod._batch_stage("specs", _noop, tmp_path, tag, ledger, ledger_key="judging")(
        [_prompt("p0"), _prompt("p1")]
    )
    assert out == {"p0": {"ok": "p0"}}
    assert log == [["p0", "p1"]], "an advisory gap was re-bought"
    assert ledger.to_dict()["perStage"]["judging"]["calls"] == 1


def test_a_keep_stop_during_a_short_stage_buys_no_retry_and_keeps_the_partial(monkeypatch, tmp_path, no_provider):
    """Guard: "stop, keep what you have" means buy nothing new — the retry is a new purchase, so it is skipped,
    and the partial result the reviewer asked for is not turned into an error."""
    mode: dict = {"stop": None}
    log: list = []

    def press_keep():
        mode["stop"] = "keep"

    monkeypatch.setattr(
        "ddharmon.llm.batch.resume_and_wait", _fake_core(lambda pid, nth: pid == "p1", log, on_call=press_keep)
    )
    stage = adapter_mod._batch_stage(
        "splitting", _noop, tmp_path, "split", adapter_mod.CumulativeLedger(), stopping=lambda: mode["stop"]
    )
    assert stage([_prompt("p0"), _prompt("p1")]) == {"p0": {"ok": "p0"}}
    assert log == [["p0", "p1"]]


# ── through the runner and the real pipeline (batch mode, fake provider) ─────────────────────────────


def _batch_run(tmp_path, monkeypatch, drop: Callable[[str, int], bool], log: list):
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(drop, log, answer=_ANSWER))
    dict_specs, cde_spec = _fixture_specs(tmp_path)
    wd = tmp_path / "work" / "j"
    base = {**_base_config(wd), "run_mode": "batch"}
    store = JobStore(work_root=tmp_path / "work")
    store.create("j", "J", base)
    return store, wd, base, dict_specs, cde_spec


def _leg(store, base, dict_specs, cde_spec, **kw):
    gate = kw.pop("gate")
    config = {**base, "stop_at_gate": gate, "park_at_gate": gate}
    runner_module.run_harmonization(store, "j", dict_specs, cde_spec, config, provider=StubProvider(), **kw)


def _submitted(log: list, prefix: str) -> list[list[str]]:
    return [[pid for pid in call if pid.startswith(prefix)] for call in log if any(p.startswith(prefix) for p in call)]


@pytest.mark.usefixtures("_one_cluster")
def test_a_first_leg_whose_split_stays_short_errors_instead_of_parking_a_partial_gate1(
    tmp_path, monkeypatch, no_provider
):
    """The identity-drift finding, reproduced: the split prompt errors on the Gate 1 leg. Before this fix the
    cluster was silently dropped and Gate 1 parked as complete; now the leg fails and names the step."""
    log: list = []
    store, wd, base, dict_specs, cde_spec = _batch_run(
        tmp_path, monkeypatch, lambda pid, nth: pid.startswith("leanb:split:"), log
    )
    _leg(store, base, dict_specs, cde_spec, gate="gate1")

    job = store.get("j")
    assert job.status == "error", f"a partial split parked as {job.status!r}"
    assert "A required step (split)" in (job.error_message or "")
    assert "leanb:split:" in job.error_message, "the error does not name the unanswered prompt"
    assert job.gate_position is None and not checkpoint_path(wd, "gate1").exists(), "a partial Gate 1 was written"
    assert len(_submitted(log, "leanb:split:")) == 2, "the split gap was not retried exactly once"


@pytest.mark.usefixtures("_one_cluster")
def test_a_split_the_retry_recovers_parks_a_complete_gate1(tmp_path, monkeypatch, no_provider):
    log: list = []
    store, wd, base, dict_specs, cde_spec = _batch_run(
        tmp_path, monkeypatch, lambda pid, nth: pid.startswith("leanb:split:") and nth == 1, log
    )
    _leg(store, base, dict_specs, cde_spec, gate="gate1")

    job = store.get("j")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate1", job.error_message
    g1 = read_checkpoint(wd, "gate1")
    split = g1.responses["split"]
    assert split and adapter_mod._NO_ANSWER not in split.values(), "Gate 1 was checkpointed with a split unanswered"
    assert g1.result["conceptGroups"], "the recovered cluster is missing from Gate 1"
    assert g1.result["unanswered"] == [], "a complete run must say so, not omit the register"


@pytest.mark.usefixtures("_one_cluster")
def test_a_resumed_leg_whose_assign_stays_short_stays_parked_and_the_next_continue_recovers_it(
    tmp_path, monkeypatch, no_provider
):
    """The stages after Gate 1 (the second todo): a short assign fails the leg; the run stays parked at Gate 1,
    resumable; the next Continue re-asks only what never came back."""
    failing = {"on": False}
    log: list = []
    store, wd, base, dict_specs, cde_spec = _batch_run(
        tmp_path, monkeypatch, lambda pid, nth: failing["on"] and pid.startswith("leanb:groupassign:"), log
    )
    _leg(store, base, dict_specs, cde_spec, gate="gate1")
    g1 = read_checkpoint(wd, "gate1")

    failing["on"] = True
    store.update("j", status="pending", phase="pending", phase_timings={})
    _leg(store, base, dict_specs, cde_spec, gate="gate2", replay_responses=g1.responses, prior_cost=g1.result["cost"])
    job = store.get("j")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate1", f"{job.status} at {job.gate_position}"
    assert "A required step (assign)" in (job.error_message or ""), job.error_message
    assert not checkpoint_path(wd, "gate2").exists(), "a Gate 2 built on missing verdicts was written"
    asked = _submitted(log, "leanb:groupassign:")
    assert len(asked) == 2 and asked[1] == asked[0], "the assign gap was not retried exactly once"

    failing["on"] = False
    answered_before = {pid for f in wd.glob("responses_*.jsonl") for pid in _ids(f)}
    mark = len(log)
    store.update("j", status="pending", phase="pending", phase_timings={})
    _leg(store, base, dict_specs, cde_spec, gate="gate2", replay_responses=g1.responses, prior_cost=g1.result["cost"])
    job = store.get("j")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate2", job.error_message
    retried = {pid for call in log[mark:] for pid in call}
    assert set(asked[0]) <= retried, "the retry Continue did not re-ask the unanswered assign prompts"
    assert not retried & answered_before, "the retry Continue re-bought prompts that were already answered"
    assert read_checkpoint(wd, "gate2").result["records"], "the recovered verdicts are missing from Gate 2"


@pytest.mark.usefixtures("_one_cluster")
def test_an_unanswered_judge_prompt_is_recorded_as_not_judged_and_carried_to_the_next_gate(
    tmp_path, monkeypatch, no_provider
):
    log: list = []
    store, wd, base, dict_specs, cde_spec = _batch_run(
        tmp_path, monkeypatch, lambda pid, nth: pid.startswith("leanb:coherence:"), log
    )
    _leg(store, base, dict_specs, cde_spec, gate="gate1")

    job = store.get("j")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate1", job.error_message
    g1 = read_checkpoint(wd, "gate1")
    asked = _submitted(log, "leanb:coherence:")
    assert len(asked) == 1 and len(asked[0]) == 1, "the fixture no longer asks the judge exactly one prompt"
    assert g1.result["unanswered"] == [
        {"stage": "coherence", "kind": "advisory", "asked": 1, "unanswered": 1, "promptIds": asked[0]}
    ]
    assert {g["coherence"] for g in g1.result["conceptGroups"]} == {"not_judged"}, "an unjudged group reads clean"

    store.update("j", status="pending", phase="pending", phase_timings={})
    _leg(store, base, dict_specs, cde_spec, gate="gate2", replay_responses=g1.responses, prior_cost=g1.result["cost"])
    g2 = read_checkpoint(wd, "gate2")
    assert [g["stage"] for g in g2.result["unanswered"]] == ["coherence"], "the next gate forgot the judge's gap"


# ── the wire: additive on the result, a count on the checkpoint read ────────────────────────────────


def test_the_unanswered_register_is_an_additive_result_field():
    assert "unanswered" in contract.UIResult.__annotations__
    # The contract module defers annotations, so NotRequired is read off the annotation, not __optional_keys__.
    assert "NotRequired" in str(contract.UIResult.__annotations__["unanswered"]), "a new result field must be additive"
    assert set(contract.UIStageGap.__required_keys__) == {"stage", "kind", "asked", "unanswered", "promptIds"}


def test_the_checkpoint_read_carries_the_unanswered_count(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from backend import app as app_module

    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    wd = tmp_path / "work" / "gap"
    app_module.store.create("gap", "Gap", {"work_dir": str(wd)})
    gaps = [
        {"stage": "coherence", "kind": "advisory", "asked": 9, "unanswered": 2, "promptIds": ["a", "b"]},
        {"stage": "concept_gate", "kind": "advisory", "asked": 4, "unanswered": 1, "promptIds": ["c"]},
    ]
    write_checkpoint(wd, job_id="gap", gate="gate1", result={"records": [], "unanswered": gaps}, responses={})
    app_module.store.checkpoint("gap", gate="gate1", checkpoint_ref="gap/checkpoint_gate1.json", realized_cost=0)

    body = TestClient(app_module.app).get("/api/harmonize/checkpoint/gap").json()
    assert body["unansweredPrompts"] == 3
    assert body["result"]["unanswered"] == gaps

    app_module.store.create("clean", "Clean", {"work_dir": str(tmp_path / "work" / "clean")})
    write_checkpoint(tmp_path / "work" / "clean", job_id="clean", gate="gate1", result={"records": []}, responses={})
    app_module.store.checkpoint("clean", gate="gate1", checkpoint_ref="clean/checkpoint_gate1.json", realized_cost=0)
    assert TestClient(app_module.app).get("/api/harmonize/checkpoint/clean").json()["unansweredPrompts"] == 0
