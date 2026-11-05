"""The CDE catalog's embedding-cache warm step (``scripts/warm_cde_cache.py``) and its ``/api/health`` readout.

Every run embeds the CDE catalog next to the cohort dictionaries, through core's content-addressed embedding
cache. The catalog is never preprocessed, so one warm cache serves every run on a server — but nothing used to
fill it, and the first full-catalog run embedded 22,743 rows on the VM's CPU while a person waited.

The property that matters is not "the warm wrote something": it is that a RUN afterwards finds every catalog row
already cached, i.e. the warm and the run produce the same cache keys. So the central test here runs the real
``run_pipeline`` (to its free Gate 0 boundary) after a warm and checks the provider is never handed a catalog row.

Hermetic: a counting fake provider (no model), small catalog fixtures (never the 22k file), and a temp
``DDHARMON_CACHE`` per test — never ``~/.ddharmon`` and never the review rig's cache.
"""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from ddharmon.embedding.provider import EmbeddingProvider
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import cde_cache
from backend.engine import adapter

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("warm_cde_cache", ROOT / "scripts" / "warm_cde_cache.py")
assert _spec is not None and _spec.loader is not None
warm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(warm)

client = TestClient(app_module.app)
DIM = 16
MODEL = "count-warm"

# The real catalogs' columns — the ones `CDE_COLUMN_ROLES` maps — so the fixture loads through the run's own roles.
HEADER = [
    "tinyId",
    "designation",
    "question_text",
    "definition",
    "datatype",
    "permissible_values",
    "classification",
    "concept_codes",
]
ENDORSED_ROWS = [
    ["eW1", "Body Weight Measurement", "What is your weight?", "The mass of the body.", "Number", "", "Vitals", ""],
    ["eS1", "Tobacco Smoking Status", "Do you smoke?", "Current smoking.", "Value List", "Yes; No", "Tobacco", ""],
    ["eA1", "Age Value", "How old are you?", "Age in years at the visit.", "Number", "", "Demographics", ""],
]
FULL_ROWS = [
    ["fP1", "PHQ-9 Total Score", "", "Sum of the nine PHQ items.", "Number", "", "PROMIS", ""],
    ["fH1", "Height Measurement", "How tall are you?", "Standing body height.", "Number", "", "Vitals", ""],
    ["fB1", "Blood Pressure Systolic", "", "Systolic arterial pressure.", "Number", "", "Vitals", ""],
    ["fS1", "Sleep Duration", "Hours of sleep?", "Hours slept per night.", "Number", "", "Sleep", ""],
]


class CountingProvider(EmbeddingProvider):
    """Deterministic hash-based vectors, and a record of every text it was asked to embed."""

    def __init__(self, name: str = MODEL) -> None:
        self._name = name
        self.calls: list[list[str]] = []

    @property
    def model_name(self) -> str:
        return self._name

    @property
    def dimension(self) -> int:
        return DIM

    @property
    def texts(self) -> list[str]:
        return [t for call in self.calls for t in call]

    def embed(self, texts: list[str]) -> np.ndarray:
        self.calls.append(list(texts))
        out = np.zeros((len(texts), DIM), dtype=np.float32)
        for i, t in enumerate(texts):
            v = np.random.default_rng(int(hashlib.sha256(t.encode()).hexdigest()[:8], 16)).standard_normal(DIM)
            out[i] = v / (np.linalg.norm(v) or 1.0)
        return out


def _write_catalog(path: Path, rows: list[list[str]]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh, delimiter="\t")
        w.writerow(HEADER)
        w.writerows(rows)
    return path


@pytest.fixture
def catalogs(tmp_path, monkeypatch):
    """Two small catalogs standing in for `endorsed` / `full`, and a throwaway embedding cache."""
    cache = tmp_path / "embedding-cache"
    monkeypatch.setenv("DDHARMON_CACHE", str(cache))
    endorsed = _write_catalog(tmp_path / "cde" / "nih_endorsed_flat.tsv", ENDORSED_ROWS)
    full = _write_catalog(tmp_path / "cde" / "all_cdes_flat.tsv", FULL_ROWS)
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": endorsed, "full": full})
    return SimpleNamespace(endorsed=endorsed, full=full, cache=cache, db=cache / "embeddings.db")


def _cohort(tmp_path: Path) -> list[dict]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    p = tmp_path / "cohort.tsv"
    p.write_text("var\tdesc\nWT_KG\tParticipant weight in kilograms\nSMK_EVER\tEver smoked a cigarette\n")
    return [{"path": str(p), "cohort_name": "CohortA", "column_roles": {"variable_name": "var", "description": "desc"}}]


def _run_to_gate0(tmp_path: Path, cde_path: Path, provider: EmbeddingProvider) -> dict:
    """A run, exactly as the app starts one, stopped at its free Gate 0 boundary (load → prepare → embed)."""
    config = {
        "run_mode": "batch",
        "cde_cohort": app_module.CDE_COHORT,
        "work_dir": str(tmp_path / "work"),
        "stop_at_gate": "gate0",
    }
    out = adapter.run_pipeline(_cohort(tmp_path), app_module.cde_spec_for(cde_path), config, provider=provider)
    return dict(out)


# ── the warm ──────────────────────────────────────────────────────────────────────────────────


def test_the_first_warm_caches_every_catalog_row_and_a_second_makes_no_provider_call(catalogs, capsys):
    rows = len(ENDORSED_ROWS) + len(FULL_ROWS)
    first = CountingProvider()
    assert warm.main([], provider=first) == 0
    assert len(first.texts) >= rows  # every row embedded (its semantic vector, plus a value vector where it has one)
    for path, n in ((catalogs.endorsed, len(ENDORSED_ROWS)), (catalogs.full, len(FULL_ROWS))):
        keys = cde_cache.row_keys(adapter.load_spec(app_module.cde_spec_for(path)))
        assert cde_cache.count_cached(keys, MODEL)[0] == n

    second = CountingProvider()
    capsys.readouterr()
    assert warm.main([], provider=second) == 0
    assert second.calls == []  # idempotent: a warm cache costs no embedding at all
    out = capsys.readouterr().out
    assert "0 newly cached" in out


def test_a_run_after_the_warm_hands_the_provider_no_catalog_row(catalogs, tmp_path, monkeypatch):
    """THE property: the warm and a run produce the same cache keys, so the run's catalog embed is all hits."""
    warmer = CountingProvider()
    assert warm.main(["--cde-set", "full"], provider=warmer) == 0
    catalog_texts = set(warmer.texts)

    # Control, on a separate COLD cache: a run embeds exactly those catalog texts (so the check below is not vacuous).
    monkeypatch.setenv("DDHARMON_CACHE", str(tmp_path / "control-cache"))
    cold = CountingProvider()
    _run_to_gate0(tmp_path / "cold", catalogs.full, cold)
    assert catalog_texts <= set(cold.texts)

    # The warmed cache: the run still embeds its cohort, and not one catalog row.
    monkeypatch.setenv("DDHARMON_CACHE", str(catalogs.cache))
    hot = CountingProvider()
    out = _run_to_gate0(tmp_path / "hot", catalogs.full, hot)
    assert out["gatePosition"] == "gate0"
    assert hot.texts, "the run must still embed its cohort rows — otherwise this proves nothing"
    assert not catalog_texts & set(hot.texts)
    assert set(hot.texts) == set(cold.texts) - catalog_texts


def test_the_run_and_the_warm_load_and_embed_through_the_same_helpers(catalogs, tmp_path, monkeypatch):
    """A drift guard: if `run_pipeline` stops going through `load_spec` / `embed_for_run`, the warm can drift from it."""
    specs: list[dict] = []
    embeds: list[str] = []
    real_load, real_embed = adapter.load_spec, adapter.embed_for_run

    def load_spy(spec):
        specs.append(dict(spec))
        return real_load(spec)

    def embed_spy(dd, provider):
        embeds.append(dd.cohort_name)
        return real_embed(dd, provider)

    monkeypatch.setattr(adapter, "load_spec", load_spy)
    monkeypatch.setattr(adapter, "embed_for_run", embed_spy)
    _run_to_gate0(tmp_path, catalogs.full, CountingProvider())
    assert app_module.cde_spec_for(catalogs.full) in specs
    assert app_module.CDE_COHORT in embeds

    specs.clear()
    assert warm.main(["--cde-set", "full"], provider=CountingProvider()) == 0
    assert specs == [app_module.cde_spec_for(catalogs.full)]


def test_a_warm_cache_never_loads_the_embedding_model(catalogs, monkeypatch):
    """On a warm cache the script finishes in seconds: the model (a ~440 MB load) is built only when a row needs it."""
    built: list[CountingProvider] = []

    def factory():
        built.append(CountingProvider())
        return built[-1]

    monkeypatch.setattr(adapter, "default_embedding_provider", factory)
    monkeypatch.setattr(adapter, "default_embedding_model_name", lambda: MODEL)
    assert warm.main([]) == 0
    assert len(built) == 1  # cold: built once, shared by both catalogs
    assert warm.main([]) == 0
    assert warm.main(["--check"]) == 0
    assert len(built) == 1  # warm: never built again


def test_a_catalog_update_rewarms_only_the_changed_rows(catalogs, capsys):
    assert warm.main(["--cde-set", "full"], provider=CountingProvider()) == 0
    edited = [list(r) for r in FULL_ROWS]
    edited[0][3] = "Total of the nine PHQ-9 depression items."
    _write_catalog(catalogs.full, edited)

    capsys.readouterr()
    assert warm.main(["--check", "--cde-set", "full"], provider=CountingProvider()) == 1
    assert f"{len(FULL_ROWS) - 1} / {len(FULL_ROWS)} rows cached" in capsys.readouterr().out

    again = CountingProvider()
    assert warm.main(["--cde-set", "full"], provider=again) == 0
    assert 1 <= len(again.texts) <= 2  # the one edited row (its semantic vector; its value text did not change)


# ── --check ───────────────────────────────────────────────────────────────────────────────────


def test_check_exits_nonzero_on_a_cold_cache_and_zero_on_a_warm_one_and_never_embeds(catalogs, capsys):
    probe = CountingProvider()
    assert warm.main(["--check"], provider=probe) == 1
    assert probe.calls == []
    assert not catalogs.db.exists()  # a check on a never-warmed server does not even create the cache file
    out = capsys.readouterr().out
    assert f"0 / {len(ENDORSED_ROWS)} rows cached" in out and f"0 / {len(FULL_ROWS)} rows cached" in out

    assert warm.main([], provider=CountingProvider()) == 0
    capsys.readouterr()
    after = CountingProvider()
    assert warm.main(["--check"], provider=after) == 0
    assert after.calls == []
    assert "COLD" not in capsys.readouterr().out


def test_check_is_per_catalog(catalogs):
    assert warm.main(["--cde-set", "endorsed"], provider=CountingProvider()) == 0
    assert warm.main(["--check", "--cde-set", "endorsed"], provider=CountingProvider()) == 0
    assert warm.main(["--check", "--cde-set", "full"], provider=CountingProvider()) == 1
    assert warm.main(["--check"], provider=CountingProvider()) == 1  # both: one cold catalog is not warm


def test_a_drifted_count_can_never_pass_a_cold_cache_as_warm(catalogs, monkeypatch):
    """`count_cached` mirrors core's hashing; a mirror can go stale. A "fully cached" count is only ever trusted
    after core's own embed path confirms it — so a wrong count costs a re-embed, never a cold first run."""
    monkeypatch.setattr(cde_cache, "count_cached", lambda keys, model_name, db_path=None: (len(keys), DIM))
    probe = CountingProvider()
    assert warm.main(["--check"], provider=probe) == 1  # core says otherwise
    assert probe.calls == []
    warmer = CountingProvider()
    warm.main([], provider=warmer)
    assert warmer.texts  # the warm still embedded the catalog


def test_a_missing_catalog_is_named_and_nothing_is_embedded(catalogs, monkeypatch, capsys):
    gone = catalogs.full.parent / "elsewhere" / "all_cdes_flat.tsv"
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": catalogs.endorsed, "full": gone})
    for argv in ([], ["--cde-set", "full"], ["--check"]):
        probe = CountingProvider()
        assert warm.main(argv, provider=probe) == 2
        assert probe.calls == []
        err = capsys.readouterr().err
        assert "all_cdes_flat.tsv" in err and "DDHARMON_CDE_DIR" in err
    assert warm.main(["--cde-set", "endorsed"], provider=CountingProvider()) == 0  # the other one is unaffected


# ── /api/health ───────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def monitor(catalogs, monkeypatch):
    """A health monitor over the fixture catalogs whose check can be held mid-flight."""
    gate = threading.Event()
    gate.set()
    loads: list[Path] = []

    def load(path: Path):
        assert gate.wait(10)
        loads.append(path)
        return adapter.load_spec(app_module.cde_spec_for(path))

    m = cde_cache.WarmthMonitor(lambda: app_module.CDE_FILES, load, model_name=lambda: MODEL, min_interval=0)
    monkeypatch.setattr(app_module, "_cde_warmth", m)
    return SimpleNamespace(m=m, gate=gate, loads=loads)


def _health() -> dict:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    return resp.json()


def test_health_answers_before_the_check_finishes_and_keeps_the_cde_booleans(monitor):
    monitor.gate.clear()  # hold the warmth check mid-flight
    t0 = time.perf_counter()
    body = _health()
    assert time.perf_counter() - t0 < 2  # never waits on the check
    assert body["cde"] == {"endorsed": True, "full": True}  # unchanged: prod tooling reads `cde.full`
    assert body["cdeCache"] == {"checkedAt": None, "catalogs": {"endorsed": None, "full": None}}

    monitor.gate.set()
    assert monitor.m.wait(10)
    body = _health()
    assert body["cde"] == {"endorsed": True, "full": True}
    assert body["cdeCache"]["checkedAt"]
    assert body["cdeCache"]["catalogs"] == {
        "endorsed": {"rows": len(ENDORSED_ROWS), "cached": 0, "warm": False},
        "full": {"rows": len(FULL_ROWS), "cached": 0, "warm": False},
    }


def test_health_reports_the_warm_once_the_cache_changes(monitor):
    _health()
    assert monitor.m.wait(10)
    assert warm.main([], provider=CountingProvider()) == 0
    _health()  # the cache file changed since the last check -> one re-check, in the background
    assert monitor.m.wait(10)
    body = _health()
    assert body["cdeCache"]["catalogs"] == {
        "endorsed": {"rows": len(ENDORSED_ROWS), "cached": len(ENDORSED_ROWS), "warm": True},
        "full": {"rows": len(FULL_ROWS), "cached": len(FULL_ROWS), "warm": True},
    }
    assert len(monitor.loads) == 2  # the catalogs did not change, so their rows were not re-read


def test_health_does_not_recheck_while_nothing_changed(monitor, catalogs):
    assert warm.main([], provider=CountingProvider()) == 0
    assert catalogs.db.exists()  # a real cache file, which the check opens
    for _ in range(25):
        _health()
        assert monitor.m.wait(10)
    assert len(monitor.loads) == 2  # one load per catalog, ever
    assert monitor.m.checks == 1  # and one check: opening the cache to count does not change it and re-trigger


def test_health_rechecks_at_most_once_per_interval(catalogs, monkeypatch):
    m = cde_cache.WarmthMonitor(
        lambda: app_module.CDE_FILES,
        lambda path: adapter.load_spec(app_module.cde_spec_for(path)),
        model_name=lambda: MODEL,
        min_interval=3600,
    )
    monkeypatch.setattr(app_module, "_cde_warmth", m)
    _health()
    assert m.wait(10)
    assert warm.main([], provider=CountingProvider()) == 0
    for _ in range(5):
        body = _health()
        assert m.wait(10)
    assert m.checks == 1  # the cache changed, but the interval has not passed: no second check yet
    assert body["cdeCache"]["catalogs"]["full"]["cached"] == 0  # the last check's figures, served as they were


def test_health_names_a_missing_catalog_without_failing(monitor, catalogs, monkeypatch):
    gone = catalogs.full.parent / "elsewhere" / "all_cdes_flat.tsv"
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": catalogs.endorsed, "full": gone})
    _health()
    assert monitor.m.wait(10)
    body = _health()
    assert body["cde"] == {"endorsed": True, "full": False}
    assert body["cdeCache"]["catalogs"]["full"] == {
        "rows": None,
        "cached": None,
        "warm": False,
        "error": "all_cdes_flat.tsv is missing",
    }
    assert body["cdeCache"]["catalogs"]["endorsed"]["rows"] == len(ENDORSED_ROWS)
