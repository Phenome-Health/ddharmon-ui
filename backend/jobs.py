"""In-memory job store for harmonization runs (mirrors biomapper-ui services/jobs.py).

A run is a long, mostly-CPU-bound pipeline (embed → BERTopic → sub-cluster → anchor
→ classify), so it executes in a daemon thread and reports progress by mutating its
:class:`Job` under a lock. The SSE endpoint polls ``to_dict()`` every 0.5s.

State is in-memory only — jobs are lost on restart (acceptable for the single-user
GUI; swap in SQLite later if persistence is needed).
"""

from __future__ import annotations

import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Non-terminal phases double as ``status`` values so the UI can show a phase label.
TERMINAL_STATES = {"complete", "error"}
_TTL_SECONDS = 3600

# Runs the TTL purge must never evict: the prepopulated demo (``demo``) and any pinned/sample run. These
# are always terminal, so without this exemption they would age out after the TTL and vanish from Runs.
_PINNED_CONFIG_KEYS = ("demo", "pinned", "sample")


def _is_pinned(job: Job) -> bool:
    """A pinned run (demo/sample/explicitly-pinned) is exempt from TTL purging — it stays in Runs forever."""
    return any(job.config.get(k) for k in _PINNED_CONFIG_KEYS)


@dataclass
class Job:
    """A single harmonization run."""

    job_id: str
    display_name: str
    # pending|loading|embedding|clustering|generating|splitting|assigning|specs|prepared|complete|error.
    # The phase set is REPORTED by the engine adapter (data-driven), not enumerated here — this comment is
    # just the default set for reference; the UI renders whatever phases a run reports (see result["phases"]).
    status: str = "pending"
    phase: str = "pending"
    completed: int = 0
    total: int = 0
    error_message: str | None = None
    result: dict[str, Any] | None = None  # serialized summary + verdicts (camelCase)
    config: dict[str, Any] = field(default_factory=dict)
    # recordId -> verdict dict. The MATCH axis (concept→CDE) writes top-level {decision, note}. The
    # TRANSFORM axis (var→CDE recode spec) is recorded PER SOURCE VARIABLE, nested under
    # {"transforms": {source_variable: {decision, note}}} — one independent verdict per "cohort:var" edge,
    # so a record with several transforms carries several transform verdicts alongside the single match one.
    decisions: dict[str, dict[str, Any]] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "displayName": self.display_name,
            "status": self.status,
            "phase": self.phase,
            "completed": self.completed,
            "total": self.total,
            "errorMessage": self.error_message,
            "result": self.result,
            "config": self.config,
            "decisions": self.decisions,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    def summary_dict(self) -> dict[str, Any]:
        """Lightweight view for the jobs list (omits the heavy result payload)."""
        d = self.to_dict()
        d.pop("result", None)
        d["nRecords"] = len(self.result["records"]) if self.result else 0
        return d


class JobStore:
    """Thread-safe in-memory job registry with TTL purging."""

    def __init__(self, ttl_seconds: int = _TTL_SECONDS, work_root: Path | None = None) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._ttl = ttl_seconds
        # Root of the per-job on-disk scratch dirs (``<work_root>/<job_id>`` holds uploads + prompts +
        # substrate). The app sets this after import. When a job is deleted or ages out we tear its dir
        # down so uploaded dictionaries never outlive the run (WS-3 data-retention guarantee). None ->
        # no teardown (tests, and demos which keep no scratch dir).
        self.work_root = work_root

    def _teardown_work_dir(self, job_id: str) -> None:
        """Remove a job's on-disk scratch dir. No-op without a ``work_root`` or if the dir is already gone."""
        if self.work_root is None:
            return
        shutil.rmtree(self.work_root / job_id, ignore_errors=True)

    def create(self, job_id: str, display_name: str, config: dict[str, Any]) -> Job:
        with self._lock:
            job = Job(job_id=job_id, display_name=display_name, config=config)
            self._jobs[job_id] = job
            return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def delete(self, job_id: str) -> bool:
        with self._lock:
            existed = self._jobs.pop(job_id, None) is not None
        # rmtree outside the lock — filesystem I/O shouldn't block the registry. Idempotent either way.
        self._teardown_work_dir(job_id)
        return existed

    def update(self, job_id: str, **fields: Any) -> None:
        """Set attributes on a job (status/phase/completed/total/error_message/result)."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for key, value in fields.items():
                setattr(job, key, value)
            job.updated_at = time.time()

    def set_decision(
        self,
        job_id: str,
        record_id: str,
        decision: str,
        note: str = "",
        axis: str = "match",
        source_variable: str | None = None,
    ) -> bool:
        """Persist a human verdict on one of two independent axes.

        ``axis="match"`` (default) writes the concept→CDE verdict as top-level ``decision``/``note`` (unchanged).
        ``axis="transform"`` records a PER-SOURCE-VARIABLE recode-spec verdict under
        ``decisions[record_id]["transforms"][source_variable] = {"decision", "note"}`` — one verdict per
        ``cohort:var`` edge, so a record's several transforms carry independent verdicts without clobbering the
        match verdict. A transform-axis call without ``source_variable`` is a no-op (caller must supply it).
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            rec = job.decisions.setdefault(record_id, {})
            if axis == "transform":
                if not source_variable:
                    return False
                transforms: dict[str, Any] = rec.setdefault("transforms", {})
                transforms[source_variable] = {"decision": decision, "note": note}
            else:
                rec["decision"] = decision
                rec["note"] = note
            job.updated_at = time.time()
            return True

    def purge_expired(self) -> None:
        cutoff = time.time() - self._ttl
        with self._lock:
            stale = [
                jid
                for jid, j in self._jobs.items()
                if j.updated_at < cutoff and j.status in TERMINAL_STATES and not _is_pinned(j)
            ]
            for jid in stale:
                self._jobs.pop(jid, None)
        for jid in stale:  # tear scratch dirs down outside the lock (see delete)
            self._teardown_work_dir(jid)


# Module-level singleton used by the app.
store = JobStore()
