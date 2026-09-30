"""A Stop on a PARKED run, and the retained uploads a prefilled re-run reads back (08-28).

Two defects with one root: surfaces built before the staged flow treat a parked run as a running one.

1. **A Stop on a parked run killed its NEXT leg.** A pause is an exit (08 D-01), so a parked run has no
   worker to stop. But ``request_cancel`` flagged any non-terminal run, ``awaiting_review`` included, and
   nothing ever cleared ``cancel_mode``. The next Continue spawned a fresh worker whose first progress tick
   read the stale "discard" and raised, so the reviewer's paid Continue ended the whole run ``cancelled``.
2. **Re-run fired a PAID run from the Runs list with no chance to review it.** The UI now opens Setup
   prefilled with the earlier run's inputs instead, and Setup needs the run's retained uploads handed back
   to their owner to do that. The legacy ``/rerun`` route is unchanged for API callers.

No provider is called anywhere here: the pipeline is stubbed and every key is a dummy.
"""

from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from backend import app as app_module
from backend import runner as runner_module
from backend.checkpoint import write_checkpoint
from backend.jobs import AWAITING_REVIEW, JobStore


def _isolate(monkeypatch, tmp_path: Path) -> Path:
    """Point the app at a throwaway work root, DB and CDE catalogue. Returns the work root."""
    work = tmp_path / "work"
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", work)
    monkeypatch.setattr(app_module.store, "work_root", work)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    return work


def _park(job_id: str, work: Path, *, gate: str = "gate1", owner: str | None = None) -> None:
    """A run parked at ``gate`` exactly as a finished leg leaves one: checkpoint on disk, row at the gate."""
    wd = work / job_id
    uploads = wd / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    (uploads / "a.csv").write_text("varname,desc\nage,Age in years\n")
    app_module.store.create(
        job_id,
        "Parked run",
        {"work_dir": str(wd), "cde_set": "endorsed", "run_mode": "batch"},
        owner_subject=owner,
        dict_specs=[
            {
                "path": str(uploads / "a.csv"),
                "cohort_name": "A",
                "column_roles": {"variable_name": "varname", "description": "desc"},
            }
        ],
    )
    app_module.store.update(job_id, status="assigning", phase="assigning")
    write_checkpoint(wd, job_id=job_id, gate=gate, result={"records": []}, responses={}, realized_cost=1.0)
    app_module.store.checkpoint(job_id, gate=gate, checkpoint_ref=f"{job_id}/checkpoint_{gate}.json", realized_cost=1.0)


# ── 1. a Stop on a parked run ────────────────────────────────────────────────────────────────


def test_request_cancel_refuses_a_parked_run():
    """The store-level half: a parked run has no worker, so there is nothing for a stop flag to reach.

    Refused under the store lock, so a Stop that raced the park (the route saw an in-flight run, the run
    parked before the flag was written) is refused too rather than slipping a flag onto a parked row.
    """
    s = JobStore()
    s.create("p", "Parked", {"run_mode": "batch"})
    s.checkpoint("p", gate="gate1", checkpoint_ref="p/checkpoint_gate1.json")
    assert s.request_cancel("p") is False
    assert s.request_cancel("p", "keep") is False
    assert s.cancel_mode("p") is None
    assert s.get("p").to_dict()["stopping"] is False


def test_a_park_clears_a_stop_that_raced_it():
    """A Stop pressed in the window between the runner deciding to park and the park landing.

    The runner parks only when no stop is set, but it reads that BEFORE it writes the (possibly
    megabytes-large) checkpoint, and a Stop can land in between. The park is itself an exit — nothing is
    spent past it — so the stop has had its effect, and a flag left behind would both read as "Stopping…"
    forever and kill the next Continue.
    """
    s = JobStore()
    s.create("r", "Raced", {"run_mode": "batch"})
    s.update("r", status="assigning", phase="assigning")
    assert s.request_cancel("r") is True  # in flight: a real stop, legitimately recorded
    s.checkpoint("r", gate="gate2", checkpoint_ref="r/checkpoint_gate2.json")
    assert s.cancel_mode("r") is None
    assert s.get("r").to_dict()["stopping"] is False


def test_a_stop_on_a_parked_run_is_refused_with_a_reason_and_sets_no_flag(monkeypatch, tmp_path):
    """The API half: an API caller pressing Stop on a parked run is told why nothing happened.

    409 rather than a silent ``{"cancelled": false}``: the request conflicts with the run's state in a way
    the caller can act on (the run is waiting on a review, not spending), which is the same language the
    resume route already uses for "not paused at a gate".
    """
    work = _isolate(monkeypatch, tmp_path)
    with TestClient(app_module.app) as c:
        _park("parked", work)
        r = c.post("/api/harmonize/jobs/parked/cancel")
        assert r.status_code == 409, r.text
        detail = r.json()["detail"].lower()
        assert "paused" in detail and "nothing" in detail
        assert app_module.store.cancel_mode("parked") is None
        job = app_module.store.get("parked")
        assert job is not None and job.status == AWAITING_REVIEW and job.gate_position == "gate1"
        assert job.to_dict()["stopping"] is False


def test_a_stale_stop_flag_cannot_kill_the_next_leg(monkeypatch, tmp_path):
    """THE REPORTED DEFECT: Stop at a gate, then Continue, and the run ended ``cancelled``.

    The flag is planted directly because every path that used to leave one (a parked-run Stop, a Stop that
    raced a park, a row from a server build before this fix) is refused or cleared above — and this is the
    guard that holds regardless of how one got there: a resume clears it, atomically with the flip to
    ``pending``, before the new worker exists. The REAL runner runs, so the worker's first progress tick is
    exactly the check that used to raise.
    """
    work = _isolate(monkeypatch, tmp_path)
    ticks: list[str] = []

    def pipeline(dict_specs, cde_spec, config, *, progress, **_kw):
        progress("assigning", 0, 1)  # a surviving "discard" raises RunCancelledError right here
        ticks.append("assigning")
        return {"records": [], "gatePosition": "gate2"}

    monkeypatch.setattr(runner_module, "run_pipeline", pipeline)
    with TestClient(app_module.app) as c:
        _park("stale", work)
        app_module.store._jobs["stale"].cancel_mode = "discard"
        r = c.post("/api/harmonize/resume/stale", headers={"x-anthropic-key": "sk-test-not-a-real-key"})
        assert r.status_code == 200, r.text
        deadline = time.time() + 10
        while time.time() < deadline:
            job = app_module.store.get("stale")
            if job is not None and (job.status == "cancelled" or job.gate_position == "gate2"):
                break
            time.sleep(0.02)

    job = app_module.store.get("stale")
    assert job is not None
    assert job.status == AWAITING_REVIEW, f"the Continue ended the run {job.status!r}"
    assert job.gate_position == "gate2"
    assert ticks == ["assigning"]


# ── 2. the retained uploads a prefilled re-run reads back ───────────────────────────────────────


def _decode_by_token(token: str) -> dict:
    """Test tokens 'A'/'B' map to distinct Clerk subjects; anything else is rejected."""
    from backend import auth

    subs = {"A": "user_A", "B": "user_B"}
    if token not in subs:
        raise auth.AuthError(401, "bad token")
    return {"sub": subs[token], "email": f"{subs[token]}@example.org"}


def test_a_runs_retained_upload_is_handed_back_to_its_owner_and_nobody_else(monkeypatch, tmp_path):
    """Setup's prefilled re-run reads each dictionary back from the run's own retained uploads.

    Only the OWNER gets it, only for a file the run actually declared, and never by a path that walks out
    of the run's uploads directory. The bytes are the owner's own dictionary, so this widens nothing — but
    every one of those three refusals is the difference between that and a file server.
    """
    from backend import auth

    work = _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setattr(auth, "_decode_claims", _decode_by_token)

    def hdr(t: str) -> dict:
        return {"authorization": f"Bearer {t}"}

    with TestClient(app_module.app) as c:
        _park("mine", work, owner="user_A")
        app_module.store.update("mine", status="complete", phase="complete")
        (work / "mine" / "secret.txt").write_text("not an upload")

        ok = c.get("/api/harmonize/jobs/mine/uploads/a.csv", headers=hdr("A"))
        assert ok.status_code == 200, ok.text
        assert ok.content == b"varname,desc\nage,Age in years\n"

        # Another user cannot tell the run exists.
        assert c.get("/api/harmonize/jobs/mine/uploads/a.csv", headers=hdr("B")).status_code == 404
        # A file the run never declared is not served, even when it sits beside the uploads.
        assert c.get("/api/harmonize/jobs/mine/uploads/secret.txt", headers=hdr("A")).status_code == 404
        assert c.get("/api/harmonize/jobs/mine/uploads/..%2Fsecret.txt", headers=hdr("A")).status_code == 404
        # Unauthenticated: gated like every other real-run route.
        assert c.get("/api/harmonize/jobs/mine/uploads/a.csv").status_code == 401

        # The upload is gone (deleted from disk): say so, rather than serving nothing.
        (work / "mine" / "uploads" / "a.csv").unlink()
        gone = c.get("/api/harmonize/jobs/mine/uploads/a.csv", headers=hdr("A"))
        assert gone.status_code == 404
        assert "no longer" in gone.json()["detail"].lower()
