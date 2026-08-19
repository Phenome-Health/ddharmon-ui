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
