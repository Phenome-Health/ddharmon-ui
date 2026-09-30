"""08-28 0e — the batch → sync switch, v1.

A batch run spends most of its wall clock in the provider's queue. The switch lets a reviewer (or the operator's
``batch_patience_seconds``) stop waiting: the in-flight batch is CANCELLED, whatever it still hands back is
kept at the batch rate, and only the ids still missing are run synchronously, at the full rate, under the same
ledger key. The leg then stays sync for its remaining stages; the next leg starts in batch again.

The hazards these tests pin, because each one is a way to lose or double-bill paid work:

* core's ``retrieve_batch`` opens ``responses_<tag>.jsonl`` with ``"w"`` — a sync answer written before the
  batch worker thread has exited is erased by it;
* the reconciler derives its gap from that same file — a sync answer written anywhere else reads as a stage
  that "failed", and the reviewer is told a required step broke;
* a stage prices only what THIS call bought — the batch items at 50%, the sync remainder at 100%.

Nothing here reaches a provider: the Batch API, core's poll and the sync client are all fakes.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from ddharmon.llm.cost import TokenUsage, price_usage

from backend.engine import adapter as adapter_mod

_MODEL = "claude-sonnet-4-6"
_BATCH_ID = "msgbatch_live"
_BATCH_ITEM = price_usage(_MODEL, 2000, 1000, batch=True)
_SYNC_ITEM = price_usage(_MODEL, 1000, 500, batch=False)


def _prompt(pid: str):
    from ddharmon.harmonization.pipeline import PromptRecord

    return PromptRecord(id=pid, system_prompt="sys", user_prompt=f"u-{pid}", schema="{}", model_tag=_MODEL)


def _batch_line(pid: str) -> str:
    return json.dumps(
        {
            "id": pid,
            "response": {"ok": pid, "via": "batch"},
            "usage": {"input_tokens": 2000, "output_tokens": 1000},
            "model": _MODEL,
        }
    )


def _lines(path: Path) -> list[dict]:
    return [json.loads(ln) for ln in path.read_text().splitlines() if ln.strip()]


class _FakeBatches:
    """``client.messages.batches`` minus the provider: a status that a cancel moves, and a call log."""

    def __init__(self, status: str = "in_progress") -> None:
        self.status = status
        self.cancelled = threading.Event()
        self.cancel_calls: list[str] = []
        self.retrieve_calls: list[str] = []

    def retrieve(self, batch_id: str):
        self.retrieve_calls.append(batch_id)
        # Per-item counts stay 0 until the batch ENDS — which is why they cannot be the switch's trigger.
        counts = SimpleNamespace(succeeded=0, processing=0, errored=0, canceled=0, expired=0)
        return SimpleNamespace(id=batch_id, processing_status=self.status, request_counts=counts)

    def cancel(self, batch_id: str):
        self.cancel_calls.append(batch_id)
        self.status = "canceling"
        self.cancelled.set()
        return SimpleNamespace(id=batch_id, processing_status="canceling")


def _fake_core(batches: _FakeBatches, returned: list[str], events: dict, *, manifest_delay: float = 0.0):
    """Core's ``resume_and_wait`` on the first-submit path, minus the provider.

    Writes the manifest ``submit_batch`` writes, then polls until the batch ends — which here means until the
    stage cancels it (or ``events['release']`` is set) — and retrieves the way ``retrieve_batch`` does: by
    opening the responses file with ``"w"``, so anything written there first is erased.
    """

    def resume_and_wait(prompts_path, output_path, *, api_key=None, **kw):  # noqa: ARG001
        prompts_path = Path(prompts_path)
        ids = [json.loads(ln)["id"] for ln in prompts_path.read_text().splitlines() if ln.strip()]
        if manifest_delay:
            time.sleep(manifest_delay)
        manifest = prompts_path.parent / f"{prompts_path.name}.batch_manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "batch_id": _BATCH_ID,
                    "num_requests": len(ids),
                    "id_map": {f"c{i}": pid for i, pid in enumerate(ids)},
                }
            )
        )
        release: threading.Event = events.setdefault("release", threading.Event())
        deadline = time.monotonic() + 5
        while not (batches.cancelled.is_set() or release.is_set()) and time.monotonic() < deadline:
            time.sleep(0.005)
        time.sleep(0.05)  # the cancel lands a poll later; a racing sync write would happen in this window
        batches.status = "ended"
        with open(output_path, "w") as f:  # retrieve_batch: "w"
            for pid in returned:
                f.write(_batch_line(pid) + "\n")
        events["worker_exited_at"] = time.monotonic()
        return len(returned)

    return resume_and_wait


class _FakeSyncClient:
    """A sync client sent requests exactly as a batch request would be. Logs one priced usage per call."""

    def __init__(self, events: dict) -> None:
        self.events = events
        self.log: list[TokenUsage] = []
        self.prompts: list[str] = []
        self.sent_while_worker_alive = 0
        self._lock = threading.Lock()

    def complete_request(
        self, prompt, *, system=None, max_tokens=2048, temperature=0.0, model=None, **kw
    ):  # noqa: ARG002
        with self._lock:
            if "worker_exited_at" not in self.events:
                self.sent_while_worker_alive += 1
            self.prompts.append(prompt)
            self.log.append(TokenUsage(_MODEL, 1000, 500))
        return json.dumps({"ok": prompt, "via": "sync"})

    def drain_usage(self):
        with self._lock:
            out, self.log = self.log, []
        return out


@pytest.fixture
def fast(monkeypatch):
    """Heartbeats and status probes at test speed, and a Batch API that is never the real one."""
    monkeypatch.setattr(adapter_mod, "_BATCH_POLL_SECS", 0.01)
    monkeypatch.setattr(adapter_mod, "_BATCH_STATUS_SECS", 0.0)

    def _never(*a, **k):
        raise AssertionError("a test reached core's real Batch API client")

    for name in ("resume_and_wait", "submit_and_wait", "submit_batch", "retrieve_batch"):
        monkeypatch.setattr(f"ddharmon.llm.batch.{name}", _never)
    batches = _FakeBatches()
    monkeypatch.setattr(adapter_mod, "_batches_api", lambda api_key=None: batches)
    return batches


def _transport(client, *, requested=lambda: False, patience=None, reports=None):
    return adapter_mod.LegTransport(
        requested=requested,
        report=(lambda transport, batch: reports.append((transport, batch))) if reports is not None else None,
        patience_seconds=patience,
        client_factory=lambda: client,
    )


# ── the switch itself ─────────────────────────────────────────────────────────────────────────────


def test_switch_while_in_progress_cancels_keeps_what_returned_and_syncs_only_the_rest(monkeypatch, tmp_path, fast):
    events: dict = {}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0", "p1"], events))
    client = _FakeSyncClient(events)
    ledger = adapter_mod.CumulativeLedger()
    stage = adapter_mod._batch_stage(
        "generating",
        lambda *a, **k: None,
        tmp_path,
        "generate",
        ledger,
        transport=_transport(client, requested=lambda: True),
    )
    out = stage([_prompt(p) for p in ("p0", "p1", "p2", "p3")])

    assert fast.cancel_calls == [_BATCH_ID], "the in-flight batch was not cancelled exactly once"
    assert sorted(client.prompts) == ["u-p2", "u-p3"], "sync ran something the cancelled batch had returned"
    assert out["p0"] == {"ok": "p0", "via": "batch"}, "an item the batch returned was not kept"
    assert out["p2"] == {"ok": "u-p2", "via": "sync"}
    assert set(out) == {"p0", "p1", "p2", "p3"}

    lines = {rec["id"]: rec for rec in _lines(tmp_path / "responses_generate.jsonl")}
    assert set(lines) == {"p0", "p1", "p2", "p3"}, "a sync answer is missing from the stage's responses file"
    assert lines["p2"]["transport"] == "sync" and lines["p3"]["transport"] == "sync"
    assert "transport" not in lines["p0"], "a batch answer was relabelled"

    line = ledger.to_dict()["perStage"]["generating"]
    assert line["calls"] == 4, "one ledger key, every answer priced once"
    assert line["usd"] == pytest.approx(2 * _BATCH_ITEM + 2 * _SYNC_ITEM), "returned ×0.5, sync remainder ×1.0"


def test_no_sync_request_goes_out_before_the_batch_worker_has_exited(monkeypatch, tmp_path, fast):
    """``retrieve_batch`` opens the responses file with "w": a sync answer written first would be erased."""
    events: dict = {}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0"], events))
    client = _FakeSyncClient(events)
    stage = adapter_mod._batch_stage(
        "generating",
        lambda *a, **k: None,
        tmp_path,
        "generate",
        adapter_mod.CumulativeLedger(),
        transport=_transport(client, requested=lambda: True),
    )
    stage([_prompt(p) for p in ("p0", "p1", "p2")])
    assert client.sent_while_worker_alive == 0, "a sync call went out while the batch worker was still running"
    ids = [rec["id"] for rec in _lines(tmp_path / "responses_generate.jsonl")]
    assert sorted(ids) == ["p0", "p1", "p2"], "the worker's 'w' erased sync answers written before it exited"


def test_a_batch_that_is_not_in_progress_is_never_cancelled(monkeypatch, tmp_path, fast):
    """Only ``in_progress`` is cancellable. An ending batch is left to land; the switch still holds for the leg."""
    fast.status = "canceling"
    events: dict = {}
    events["release"] = threading.Event()
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0", "p1"], events))
    client = _FakeSyncClient(events)
    transport = _transport(client, requested=lambda: True)
    stage = adapter_mod._batch_stage(
        "generating", lambda *a, **k: None, tmp_path, "generate", adapter_mod.CumulativeLedger(), transport=transport
    )
    timer = threading.Timer(0.15, events["release"].set)
    timer.start()
    try:
        out = stage([_prompt("p0"), _prompt("p1")])
    finally:
        timer.cancel()
    assert fast.cancel_calls == [], "a batch that was not in_progress was cancelled"
    assert client.prompts == [], "nothing was missing, so nothing should have been bought at the sync rate"
    assert set(out) == {"p0", "p1"}
    assert transport.switched, "a requested switch holds for the rest of the leg even when nothing was cancelled"


def test_a_stale_manifest_from_an_earlier_call_is_never_the_one_cancelled(monkeypatch, tmp_path, fast):
    """The gap sidecar's manifest survives its batch. Only one written at or after THIS call's start counts."""
    from ddharmon.harmonization import write_prompts_jsonl

    write_prompts_jsonl([_prompt("old")], tmp_path / "prompts_generate.jsonl")
    stale = tmp_path / "prompts_generate.jsonl.gap.batch_manifest.json"
    stale.write_text(json.dumps({"batch_id": "msgbatch_stale", "id_map": {"c0": "old"}}))
    an_hour_ago = time.time() - 3600
    os.utime(stale, (an_hour_ago, an_hour_ago))

    events: dict = {}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0"], events, manifest_delay=0.1))
    client = _FakeSyncClient(events)
    stage = adapter_mod._batch_stage(
        "generating",
        lambda *a, **k: None,
        tmp_path,
        "generate",
        adapter_mod.CumulativeLedger(),
        transport=_transport(client, requested=lambda: True),
    )
    stage([_prompt("p0"), _prompt("p1")])
    assert "msgbatch_stale" not in fast.retrieve_calls + fast.cancel_calls, "acted on an earlier call's batch"
    assert fast.cancel_calls == [_BATCH_ID]


def test_the_switch_is_sticky_for_the_rest_of_the_leg(monkeypatch, tmp_path, fast):
    """Once a leg switched, its later stages run sync from the start — no batch is submitted for them."""
    events: dict = {}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0"], events))
    client = _FakeSyncClient(events)
    asked = {"n": 1}
    transport = _transport(client, requested=lambda: asked["n"] == 1)  # the flag is only up for the first stage
    ledger = adapter_mod.CumulativeLedger()
    first = adapter_mod._batch_stage(
        "generating", lambda *a, **k: None, tmp_path, "generate", ledger, transport=transport
    )
    first([_prompt("p0"), _prompt("p1")])
    asked["n"] = 2

    submitted: list = []
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", lambda *a, **k: submitted.append(a))
    later = adapter_mod._batch_stage("splitting", lambda *a, **k: None, tmp_path, "split", ledger, transport=transport)
    out = later([_prompt("s0"), _prompt("s1")])

    assert submitted == [], "a later stage of a switched leg submitted a batch"
    assert out == {"s0": {"ok": "u-s0", "via": "sync"}, "s1": {"ok": "u-s1", "via": "sync"}}
    split = ledger.to_dict()["perStage"]["splitting"]
    assert split["calls"] == 2 and split["usd"] == pytest.approx(2 * _SYNC_ITEM), "a sync stage is full price"
    recs = _lines(tmp_path / "responses_split.jsonl")
    assert {r["id"] for r in recs} == {"s0", "s1"} and all(r["transport"] == "sync" for r in recs)


def test_a_sticky_sync_stage_still_replays_answers_already_on_disk_for_free(monkeypatch, tmp_path, fast):
    (tmp_path / "responses_split.jsonl").write_text(_batch_line("s0") + "\n")
    client = _FakeSyncClient({"worker_exited_at": 0})
    transport = _transport(client)
    transport.commit()
    ledger = adapter_mod.CumulativeLedger()
    out = adapter_mod._batch_stage("splitting", lambda *a, **k: None, tmp_path, "split", ledger, transport=transport)(
        [_prompt("s0"), _prompt("s1")]
    )
    assert client.prompts == ["u-s1"], "a cached answer was bought again"
    assert out["s0"] == {"ok": "s0", "via": "batch"}
    assert ledger.to_dict()["perStage"]["splitting"]["calls"] == 1


def test_batch_patience_sets_the_same_switch_after_n_seconds(monkeypatch, tmp_path, fast):
    events: dict = {}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, [], events))
    client = _FakeSyncClient(events)
    transport = _transport(client, patience=0.05)  # nobody pressed anything
    stage = adapter_mod._batch_stage(
        "generating", lambda *a, **k: None, tmp_path, "generate", adapter_mod.CumulativeLedger(), transport=transport
    )
    out = stage([_prompt("p0"), _prompt("p1")])
    assert fast.cancel_calls == [_BATCH_ID], "patience elapsed but the batch was not cancelled"
    assert sorted(client.prompts) == ["u-p0", "u-p1"]
    assert set(out) == {"p0", "p1"} and transport.switched


def test_without_patience_or_a_request_the_batch_is_waited_out(monkeypatch, tmp_path, fast):
    events: dict = {"release": threading.Event()}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0", "p1"], events))
    client = _FakeSyncClient(events)
    transport = _transport(client)
    stage = adapter_mod._batch_stage(
        "generating", lambda *a, **k: None, tmp_path, "generate", adapter_mod.CumulativeLedger(), transport=transport
    )
    timer = threading.Timer(0.15, events["release"].set)
    timer.start()
    try:
        out = stage([_prompt("p0"), _prompt("p1")])
    finally:
        timer.cancel()
    assert fast.cancel_calls == [] and client.prompts == [] and not transport.switched
    assert set(out) == {"p0", "p1"}


def test_the_in_flight_batch_is_reported_with_a_sync_estimate_while_it_is_switchable(monkeypatch, tmp_path, fast):
    events: dict = {"release": threading.Event()}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0", "p1", "p2"], events))
    reports: list = []
    transport = _transport(_FakeSyncClient(events), reports=reports)
    stage = adapter_mod._batch_stage(
        "generating", lambda *a, **k: None, tmp_path, "generate", adapter_mod.CumulativeLedger(), transport=transport
    )
    timer = threading.Timer(0.15, events["release"].set)
    timer.start()
    try:
        stage([_prompt("p0"), _prompt("p1"), _prompt("p2")])
    finally:
        timer.cancel()
    live = [b for _, b in reports if b]
    assert live, "the in-flight batch was never reported"
    info = live[0]
    assert info["tag"] == "generate" and info["nItems"] == 3
    assert info["status"] == "in_progress" and info["switchable"] is True
    expected = adapter_mod._sync_estimate_usd([_prompt("p0"), _prompt("p1"), _prompt("p2")])
    assert info["syncEstimateUsd"] == pytest.approx(expected) and expected > 0
    assert all(t == "batch" for t, _ in reports)
    assert reports[-1][1] is None, "a finished stage left a batch reported as in flight"


def test_the_sync_estimate_never_quotes_below_a_realistic_call(monkeypatch):
    """R8 is one-directional: the estimate may over-quote, never under-quote, the sync remainder."""
    p = _prompt("p0")
    est = adapter_mod._sync_estimate_usd([p, _prompt("p1")])
    chars = len(p.system_prompt) + len(p.schema) + len(p.user_prompt)
    # A call's input can be no more tokens than it has characters; its reply is bounded by its budget.
    floor = 2 * price_usage(_MODEL, chars // 4, 0)
    assert est is not None and est > floor
    assert adapter_mod._sync_estimate_usd([]) is None
    unpriceable = _prompt("x")
    unpriceable.model_tag = "no-such-model-anywhere"
    assert adapter_mod._sync_estimate_usd([unpriceable]) is None, "an unpriceable remainder is quoted as $0"


def test_the_reconciler_sees_the_sync_answered_ids_so_nothing_reads_as_failed(monkeypatch, tmp_path, fast):
    """The cancelled batch's manifest still lists every id it was sent. Its gap must be closed on disk."""
    from backend.batch_reconcile import outstanding_submissions, reconcile_run
    from backend.checkpoint import write_checkpoint
    from backend.jobs import JobStore

    wd = tmp_path / "j"
    wd.mkdir()
    events: dict = {}
    monkeypatch.setattr("ddharmon.llm.batch.resume_and_wait", _fake_core(fast, ["p0"], events))
    client = _FakeSyncClient(events)
    adapter_mod._batch_stage(
        "generating",
        lambda *a, **k: None,
        wd,
        "generate",
        adapter_mod.CumulativeLedger(),
        transport=_transport(client, requested=lambda: True),
    )([_prompt("p0"), _prompt("p1"), _prompt("p2")])

    assert outstanding_submissions(wd) == [], "the switched ids read as a gap the cancelled batch still owes"

    store = JobStore(work_root=tmp_path)
    store.create("j", "J", {})
    write_checkpoint(wd, job_id="j", gate="gate1", result={}, responses={})
    store.checkpoint("j", gate="gate1", checkpoint_ref="j/checkpoint_gate1.json")
    fetched: list = []

    def fetch(batch_id, *, manifest_path=None, api_key=None):  # noqa: ARG001
        fetched.append(batch_id)
        raise AssertionError("the reconciler went back to a batch whose gap is closed")

    outcome = reconcile_run("j", store=store, fetch=fetch)
    assert outcome.status == "noop" and outcome.failed == () and fetched == []
    assert not (wd / "reconcile_failures.jsonl").exists()
