"""A run that parks at Gate 1 warms Gate 1's free Concept Spotlight search (user test 2026-11-03).

Found on dev.ddharmon.io (run 379c70ce): the tester declared three Spotlight items and the free search's FIRST call
on the run embedded every grouped variable from scratch — 93 seconds on dev's two CPUs, because the run's own
embeddings were hashed over different text and cannot be reused. The panel said nothing meanwhile and the tester
left for the demo before the answer arrived. The park now runs the same core search once, with a placeholder
item, so the variables' vectors are in the embedding cache before the reviewer asks; the reviewer's first search
then embeds only its own item queries.

The warm-up is a convenience: it never delays or fails the park, does not run when there is no dense encoder,
and does not run on any other gate or on a Full-auto park that the server continues at once.
"""

from __future__ import annotations

import numpy as np

from backend import runner as runner_module
from backend.declared_score import gate1_suggestions
from backend.gate1_membership import gate1_membership
from backend.jobs import AWAITING_REVIEW, JobStore
from tests.test_score_suggestions import _result, _vector


class _Recorder:
    """A deterministic embedder that remembers every text it was asked for."""

    def __init__(self, fail: bool = False) -> None:
        self.asked: list[str] = []
        self.fail = fail

    def __call__(self, texts: list[str]) -> np.ndarray:
        if self.fail:
            raise RuntimeError("encoder exploded")
        self.asked.extend(texts)
        return np.stack([_vector(t) for t in texts])


def _park(
    monkeypatch, tmp_path, gate: str, embed: _Recorder, *, encoder: bool = True, auto: bool = False
) -> tuple[JobStore, dict]:
    monkeypatch.setattr(runner_module, "WARM_GATE1_SEARCH", True)  # the suite turns it off (conftest)
    monkeypatch.setattr("backend.composite.encoder_available", lambda: encoder)
    monkeypatch.setattr("backend.composite._embedder", lambda: embed)
    store = JobStore(work_root=tmp_path / "work")
    store.create("g1", "G1", {})
    result = {**_result(), "gatePosition": gate}
    monkeypatch.setattr(runner_module, "run_pipeline", lambda *a, **k: dict(result))
    config = {"work_dir": str(tmp_path / "work" / "g1"), "run_mode": "sync"}
    if auto:
        config["review_mode"] = "auto"
    runner_module.run_harmonization(
        store, "g1", [], None, config, auto_advance=(lambda job_id, key: None) if auto else None
    )
    return store, result


def test_a_run_parking_at_gate_1_warms_its_free_search(monkeypatch, tmp_path):
    warm = _Recorder()
    store, result = _park(monkeypatch, tmp_path, "gate1", warm)
    job = store.get("g1")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate1"
    assert warm.asked, "nothing was embedded when the run parked at Gate 1"

    # The reviewer's first search after the park: everything it asks for that is not its own item was warmed.
    first = _Recorder()
    declared = [{"scoreName": "Frailty", "components": ["grip strength"]}]
    gate1_suggestions(declared, result["fieldIndex"], gate1_membership(result, None), embed=first)
    corpus = [t for t in first.asked if "grip strength" not in t.lower()]
    assert corpus, "the search asked for no variable text at all — the test would prove nothing"
    assert set(corpus) <= set(warm.asked)


def test_a_failed_warm_up_never_fails_the_park(monkeypatch, tmp_path):
    store, _ = _park(monkeypatch, tmp_path, "gate1", _Recorder(fail=True))
    job = store.get("g1")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate1"


def test_no_dense_encoder_no_warm_up(monkeypatch, tmp_path):
    warm = _Recorder()
    _park(monkeypatch, tmp_path, "gate1", warm, encoder=False)
    assert warm.asked == []


def test_only_the_gate_1_park_warms(monkeypatch, tmp_path):
    warm = _Recorder()
    _park(monkeypatch, tmp_path, "gate2", warm)
    assert warm.asked == []


def test_a_full_auto_park_continued_at_once_does_not_warm(monkeypatch, tmp_path):
    """Full auto commits Gate 1 with every group the moment it is reached: no one searches there, so no warm-up."""
    warm = _Recorder()
    _park(monkeypatch, tmp_path, "gate1", warm, auto=True)
    assert warm.asked == []


def test_a_finished_preview_run_warms_its_free_search(monkeypatch, tmp_path):
    """A Preview run never parks — it completes — but its Gate 1 is where the reviewer searches (08-31)."""
    warm = _Recorder()
    monkeypatch.setattr(runner_module, "WARM_GATE1_SEARCH", True)
    monkeypatch.setattr("backend.composite.encoder_available", lambda: True)
    monkeypatch.setattr("backend.composite._embedder", lambda: warm)
    store = JobStore(work_root=tmp_path / "work")
    store.create("pv", "Preview", {})
    result = {**_result(), "mode": "preview"}
    monkeypatch.setattr(runner_module, "run_pipeline", lambda *a, **k: dict(result))
    config = {"work_dir": str(tmp_path / "work" / "pv"), "run_mode": "preview"}
    runner_module.run_harmonization(store, "pv", [], None, config)
    assert store.get("pv").status == "complete"
    assert warm.asked, "nothing was embedded when the Preview run finished"


def test_a_finished_paid_run_does_not_warm(monkeypatch, tmp_path):
    """A one-shot paid run that completes is read on its results page, not searched at Gate 1."""
    warm = _Recorder()
    monkeypatch.setattr(runner_module, "WARM_GATE1_SEARCH", True)
    monkeypatch.setattr("backend.composite.encoder_available", lambda: True)
    monkeypatch.setattr("backend.composite._embedder", lambda: warm)
    store = JobStore(work_root=tmp_path / "work")
    store.create("pd", "Paid", {})
    monkeypatch.setattr(runner_module, "run_pipeline", lambda *a, **k: {**_result(), "mode": "sync"})
    runner_module.run_harmonization(
        store, "pd", [], None, {"work_dir": str(tmp_path / "work" / "pd"), "run_mode": "sync"}
    )
    assert store.get("pd").status == "complete"
    assert warm.asked == []
