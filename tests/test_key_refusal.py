"""A missing-key refusal is MACHINE-READABLE (08-28, the BYOK-key-on-Continue blocker).

ddharmon is bring-your-own-key: the key lives in the browser tab's memory only, so a reload — or a run opened
from the runs list — reaches a paid gate action holding no key. Every staged route that would spend refuses such
a call at the door with a 400, before anything is committed or charged, and the gate screens reveal an inline key
field on exactly that refusal. Matching the English sentence to decide that would couple the UI to copy, so each
missing-key refusal carries a stable ``code`` BESIDE its human ``detail``, which stays the same string every
existing caller (the API client, the live-verify driver) already reads.

The per-route refusals are pinned beside each route's own tests (start / re-run in ``test_cost_ledger.py``, the
division in ``test_backend.py``, extraction in ``test_score_components.py``, the Gate 4 match in
``test_score_staged.py``); Continue — the route the blocker was found on — is asserted here, end to end.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.checkpoint import write_checkpoint
from backend.jobs import AWAITING_REVIEW
from backend.llm_errors import KEY_REJECTED, KEY_REQUIRED, as_http_error

_FAKE_KEY = "sk-ant-test-0000"


def _sdk_error(status: int) -> Exception:
    exc = type("FakeSDKError", (Exception,), {"__module__": "anthropic"})("boom")
    exc.status_code = status  # type: ignore[attr-defined]
    return exc


@pytest.fixture
def parked(monkeypatch, tmp_path):
    """A keyless server and one owned run parked at Gate 1 with a single group — the dev.ddharmon.io shape."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    spawned: list[dict] = []
    monkeypatch.setattr(
        app_module, "run_harmonization", lambda store, job_id, *a, **k: spawned.append({"job": job_id, **k})
    )
    with TestClient(app_module.app) as c:
        wd = tmp_path / "work" / "k1"
        app_module.store.create(
            "k1",
            "Parked at Gate 1",
            {"work_dir": str(wd), "cde_set": "endorsed", "run_mode": "batch"},
            owner_subject=None,
            dict_specs=[{"path": "x.csv", "cohort_name": "A", "column_roles": {}}],
        )
        result = {"records": [], "conceptGroups": [{"groupId": "g1"}], "conceptGroupMembers": {"g1": ["A:x", "A:y"]}}
        write_checkpoint(wd, job_id="k1", gate="gate1", result=result, responses={}, realized_cost=1.0)
        app_module.store.checkpoint("k1", gate="gate1", checkpoint_ref="k1/checkpoint_gate1.json", realized_cost=1.0)
        yield c, spawned


def test_a_keyless_continue_is_refused_with_the_code_and_the_gate_is_untouched(parked):
    client, spawned = parked
    before = dict(app_module.store.get("k1").config)

    r = client.post("/api/harmonize/resume/k1", json={"gate1Scope": ["g1"]})

    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == KEY_REQUIRED
    # The human sentence is unchanged and still a STRING — every existing caller reads `detail` as one.
    assert isinstance(body["detail"], str)
    assert body["detail"].startswith("Enter your Anthropic API key to continue")
    # Refused BEFORE anything was committed: still parked at the same gate, nothing frozen, no worker.
    job = app_module.store.get("k1")
    assert job.status == AWAITING_REVIEW and job.gate_position == "gate1"
    assert job.config == before, "a refused Continue froze the scope or the regrouping anyway"
    assert spawned == []


def test_the_same_continue_with_the_key_goes_through_and_the_key_reaches_only_the_worker(parked):
    client, spawned = parked
    client.post("/api/harmonize/resume/k1", json={"gate1Scope": ["g1"]})  # refused first, as after a reload

    r = client.post("/api/harmonize/resume/k1", json={"gate1Scope": ["g1"]}, headers={"x-anthropic-key": _FAKE_KEY})

    assert r.status_code == 200, r.text
    assert "code" not in r.json()
    assert [s["api_key"] for s in spawned] == [_FAKE_KEY]
    assert _FAKE_KEY not in repr(app_module.store.get("k1").config), "the key was written into the run config"


def test_a_refusal_that_is_not_about_the_key_carries_no_code(parked):
    """The code means ONE thing — "a key would let this through" — so no other refusal may wear it."""
    client, _spawned = parked
    missing = client.post("/api/harmonize/resume/nope")
    assert missing.status_code == 404 and "code" not in missing.json()
    client.post("/api/harmonize/resume/k1", json={"gate1Scope": ["g1"]}, headers={"x-anthropic-key": _FAKE_KEY})
    not_parked = client.post("/api/harmonize/resume/k1", headers={"x-anthropic-key": _FAKE_KEY})
    assert not_parked.status_code == 409 and "code" not in not_parked.json()


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_key_carries_its_own_code(status):
    """A key the provider REJECTED is also one a reviewer fixes by entering a key — its own code, not the same one."""
    http = as_http_error(_sdk_error(status))
    assert http is not None and getattr(http, "code", None) == KEY_REJECTED


@pytest.mark.parametrize("status", [400, 404, 429, 529, 500])
def test_other_provider_conditions_carry_no_key_code(status):
    http = as_http_error(_sdk_error(status))
    assert http is not None and getattr(http, "code", None) is None
