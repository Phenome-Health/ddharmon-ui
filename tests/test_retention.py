"""WS-3 data-retention: a job's on-disk scratch dir (uploads + prompts + substrate) must not
outlive the job. The JobStore tears ``<work_root>/<job_id>`` down when a job is deleted or ages out.

Also guards the inverse — what a restart must NOT throw away. The startup sweep
(:meth:`backend.db.JobDB.recover_stale`) is a retention decision too: it decides which rows a restart is
allowed to destroy. So "a cancelled run that kept its partial result survives a restart" lives here.
"""

from __future__ import annotations

from backend.db import JobDB
from backend.jobs import Job, JobStore


def test_delete_removes_work_dir(tmp_path):
    store = JobStore(work_root=tmp_path)
    job_dir = tmp_path / "job-1"
    (job_dir / "uploads").mkdir(parents=True)
    (job_dir / "uploads" / "cohort.csv").write_text("var,desc\n")
    store.create("job-1", "t", {})

    assert store.delete("job-1") is True
    assert not job_dir.exists()  # uploaded dictionary is gone with the job


def test_purge_expired_removes_work_dir(tmp_path):
    # ttl_seconds=-10 -> cutoff is in the future, so any terminal job is immediately stale.
    store = JobStore(ttl_seconds=-10, work_root=tmp_path)
    job_dir = tmp_path / "job-2"
    job_dir.mkdir(parents=True)
    (job_dir / "prompts_assign.jsonl").write_text("{}\n")
    store.create("job-2", "t", {})
    store.update("job-2", status="complete")

    store.purge_expired()
    assert store.get("job-2") is None
    assert not job_dir.exists()


def test_pinned_demo_survives_purge(tmp_path):
    # A pinned/demo job is exempt from TTL purging and its (nonexistent) scratch dir teardown is a no-op.
    store = JobStore(ttl_seconds=-10, work_root=tmp_path)
    store.create("demo-x", "Demo", {"demo": True})
    store.update("demo-x", status="complete")

    store.purge_expired()
    assert store.get("demo-x") is not None


def test_teardown_is_noop_without_work_root():
    # No work_root configured (the default) -> delete still succeeds and never touches the filesystem.
    store = JobStore()
    store.create("j", "t", {})
    assert store.delete("j") is True


def test_a_cancelled_run_with_a_kept_partial_is_not_flipped_to_error_by_a_restart(tmp_path):
    """R14, and a LIVE defect independent of the staged gates.

    ``backend.jobs.TERMINAL_STATES`` counts ``cancelled`` as terminal; ``backend.db._TERMINAL`` did not.
    So a "keep" stop — the user finishing the in-flight stage to collect work they already paid for — was
    re-labelled ``error`` on the next restart, along with a message telling them to re-run and pay again.
    """
    dbp = tmp_path / "jobs.db"
    db1 = JobDB(dbp)
    db1.upsert(
        Job(
            job_id="kept",
            display_name="Stopped, partial kept",
            status="cancelled",
            phase="cancelled",
            owner_subject="user_A",
            result={"records": [{"id": "r1"}]},
        )
    )
    db1.close()

    db2 = JobDB(dbp)  # the restart
    assert db2.recover_stale() == 0
    row = db2.get("kept")
    assert row["status"] == "cancelled"
    assert row["error_message"] is None
    assert row["result"]["records"][0]["id"] == "r1", "the partial the user paid for was discarded"
    db2.close()


# ── 08-10: a paused run's retention, and the reaper that keeps it from being unbounded ────────
#
# RESEARCH §Q5 found the two halves of this and they pull opposite ways. A paused run holds work the user
# has ALREADY PAID FOR, which under R14 makes it more valuable than a completed run, not less — so it is
# retained indefinitely, and no TTL may reach it. But under the checkpoint model its work dir now holds
# stage output, so "retained indefinitely" with no teardown anywhere is unbounded growth on one small
# host (T-08-54). The resolution is that the reaper is keyed on DELETION, never on age.


def _paused(store, job_id, *, work_root, cost=2.14):
    """A run parked at Gate 1 with a real checkpoint on a real work dir."""
    from backend.checkpoint import write_checkpoint

    wd = work_root / job_id
    (wd / "uploads").mkdir(parents=True, exist_ok=True)
    (wd / "uploads" / "cohort.csv").write_text("var,desc\n")
    write_checkpoint(wd, job_id=job_id, gate="gate1", result={"conceptGroups": []}, responses={}, realized_cost=cost)
    store.create(job_id, "Paused at Gate 1", {}, owner_subject="user_A")
    store.checkpoint(job_id, gate="gate1", checkpoint_ref=f"{job_id}/checkpoint_gate1.json", realized_cost=cost)
    return wd


def test_a_paused_run_survives_a_ttl_purge_with_its_row_its_uploads_and_its_work_dir(tmp_path):
    """R14/§8.6: retention for a paused run is INDEFINITE until the reviewer deletes it.

    The TTL purge is the one automatic thing in this backend that removes state, so this is the assertion
    that the standing assurance ("resume any time", no countdown) is true of the code and not only of the
    copy. Its work dir must survive too: under D-02 the work dir IS the checkpoint.
    """
    db = JobDB(tmp_path / "jobs.db")
    store = JobStore(ttl_seconds=-10, work_root=tmp_path, db=db)  # cutoff in the future -> everything stale
    wd = _paused(store, "paused-1", work_root=tmp_path)

    store.purge_expired()

    assert db.get("paused-1")["status"] == "awaiting_review", "the TTL purge removed a run holding paid work"
    assert wd.exists(), "the TTL purge tore down the work dir a paused run resumes FROM"
    assert (wd / "checkpoint_gate1.json").exists()
    assert (wd / "uploads" / "cohort.csv").exists()
    rehydrated = store.get("paused-1")
    assert rehydrated is not None and rehydrated.gate_position == "gate1"
    db.close()


def test_a_paused_run_evicted_from_memory_rehydrates_from_the_database_on_reopen(tmp_path):
    """Eviction is the RAM half of the same policy: a review takes days, so holding the run in memory for
    the duration is a leak (T-08-39). That is only safe because the row is what the reviewer comes back to,
    so the rehydrated run must still know its gate, its pointer and — for cost transparency — its spend."""
    db = JobDB(tmp_path / "jobs.db")
    store = JobStore(ttl_seconds=-10, work_root=tmp_path, db=db)
    _paused(store, "paused-2", work_root=tmp_path, cost=3.75)

    store.purge_expired()
    assert "paused-2" not in store._jobs, "a paused run stayed in memory for the whole review"

    back = store.get("paused-2")
    assert back is not None
    assert back.status == "awaiting_review"
    assert back.gate_position == "gate1"
    assert back.checkpoint_ref == "paused-2/checkpoint_gate1.json"
    assert back.cost_so_far == 3.75, "a rehydrated paused run reported zero spend to someone already billed"
    db.close()


def test_deleting_a_run_reaps_its_work_dir_even_when_the_run_lives_only_in_the_database(tmp_path):
    """T-08-54, the unbounded-growth half. ``purge_expired`` only tears a work dir down when NO database is
    attached, so in production nothing ages out — and a paused run's dir now holds stage output. The reaper
    therefore has to be keyed on deletion, and it has to fire for a run that has been evicted from memory,
    which is the normal state of exactly the runs whose dirs are largest."""
    db = JobDB(tmp_path / "jobs.db")
    store = JobStore(ttl_seconds=-10, work_root=tmp_path, db=db)
    wd = _paused(store, "paused-3", work_root=tmp_path)
    store.purge_expired()  # evicted from memory; row and dir retained

    assert store.delete("paused-3") is True
    assert not wd.exists(), "deleting a run left its stage output on the host forever"
    assert db.get("paused-3") is None
    db.close()


def test_a_work_dir_the_reaper_could_not_remove_is_reported_not_swallowed(tmp_path, caplog):
    """``shutil.rmtree(..., ignore_errors=True)`` reports success for a teardown it did not achieve. Under
    the checkpoint model that silence IS the unbounded-growth failure: the run is gone from the UI, the
    bytes are still on the disk, and nothing anywhere says so."""
    import logging
    import os

    store = JobStore(work_root=tmp_path)
    wd = tmp_path / "stuck"
    wd.mkdir()
    (wd / "checkpoint_gate1.json").write_text("{}")
    store.create("stuck", "t", {})
    os.chmod(tmp_path, 0o500)  # read+execute only: the child cannot be unlinked
    try:
        with caplog.at_level(logging.WARNING, logger="backend.jobs"):
            store.delete("stuck")
    finally:
        os.chmod(tmp_path, 0o700)

    assert wd.exists()  # the premise of the test
    assert any(
        "could not be removed" in r.getMessage() and "stuck" in r.getMessage() for r in caplog.records
    ), f"a work dir that could not be removed was reported as torn down: {[r.getMessage() for r in caplog.records]}"
    assert store._teardown_work_dir.__doc__ is not None


def test_no_payload_puts_a_countdown_or_an_expiry_on_a_paused_run(tmp_path):
    """§8.6: retention is indefinite, so the honest surface is a resume affordance.

    Asserted on the PAYLOADS a paused run actually produces rather than on the source text, because the
    defect is a field on the wire (a client cannot render a comment). A countdown here would be a
    user-facing retention policy the developer never chose, invented by the backend.
    """
    from backend.checkpoint import write_checkpoint

    store = JobStore(work_root=tmp_path)
    write_checkpoint(tmp_path / "p", job_id="p", gate="gate1", result={}, responses={})
    store.create("p", "Paused", {})
    store.checkpoint("p", gate="gate1", checkpoint_ref="p/checkpoint_gate1.json", realized_cost=1.0)
    job = store.get("p")
    assert job is not None

    banned = ("countdown", "expires", "expiry", "expiresat", "ttl", "timeremaining", "deletedat")
    for payload in (job.to_dict(), job.progress_dict(), job.summary_dict()):
        for key in payload:
            assert key.lower().replace("_", "") not in banned, f"{key} on a paused run's payload — see §8.6"


# ── the pre-deploy report ────────────────────────────────────────────────────────────────────


def _report_fn():
    """Import the report script the way this repo's other script test does (``tests/test_demo_bundle.py``)."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    from inflight_report import report

    return report


def test_the_inflight_report_counts_both_categories(tmp_path):
    """The deploy runbook's warn gate covers in-flight runs only. A paused run is equally interruptible
    from the reviewer's point of view — a restart mid-``Continue`` is a lost leg — so the operator needs
    both numbers before they restart the unit."""
    report = _report_fn()

    db = JobDB(tmp_path / "jobs.db")
    db.upsert(Job(job_id="live-1", display_name="Running", status="assigning", phase="assigning"))
    db.upsert(Job(job_id="paused-1", display_name="Paused", status="awaiting_review", phase="awaiting_review"))
    db.upsert(Job(job_id="done-1", display_name="Done", status="complete", phase="complete"))
    db.close()

    text = report(tmp_path / "jobs.db")

    assert "in flight" in text.lower() and "awaiting review" in text.lower()
    assert "live-1" in text and "paused-1" in text
    assert "done-1" not in text, "a finished run is not interruptible and must not pad the warn gate"


def test_the_inflight_report_prints_explicit_zeros_on_an_empty_store(tmp_path):
    """ "Checked, nothing in flight" and "the check did not run" must not look the same to an operator who
    is about to restart production."""
    report = _report_fn()

    JobDB(tmp_path / "jobs.db").close()

    text = report(tmp_path / "jobs.db")

    assert "0" in text
    assert "in flight" in text.lower() and "awaiting review" in text.lower()
    assert text.strip(), "an empty store printed nothing at all"


def test_the_inflight_report_runs_as_a_command_and_exits_zero(tmp_path):
    """It is a runbook step, so the thing that must work is the command line, not just the function."""
    import subprocess
    import sys

    JobDB(tmp_path / "jobs.db").close()
    proc = subprocess.run(
        [sys.executable, "scripts/inflight_report.py", str(tmp_path / "jobs.db")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert "awaiting review" in proc.stdout.lower()
