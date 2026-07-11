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
    # The pipeline phase a run was in when it FAILED (e.g. "assigning"). The runner captures it on error
    # before ``phase`` is overwritten to "error", so an error report / the UI can name the stage that broke.
    # Persisted, so a report filed later from a run's history still knows the failing stage.
    failed_phase: str | None = None
    result: dict[str, Any] | None = None  # serialized summary + verdicts (camelCase)
    config: dict[str, Any] = field(default_factory=dict)
    # recordId -> verdict dict. The MATCH axis (concept→CDE) writes top-level {decision, note}. The
    # TRANSFORM axis (var→CDE recode spec) is recorded PER SOURCE VARIABLE, nested under
    # {"transforms": {source_variable: {decision, note}}} — one independent verdict per "cohort:var" edge,
    # so a record with several transforms carries several transform verdicts alongside the single match one.
    decisions: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Ownership + re-run support (durable per-user history). owner_subject is the verified Clerk subject
    # (None for demos / when the auth gate is disabled). dict_specs are the per-dictionary load specs
    # (paths + column roles + cohort names) needed to re-execute the run from its retained uploads. Neither
    # is exposed by to_dict() — owner_subject must never leak to the client.
    owner_subject: str | None = None
    dict_specs: list[dict[str, Any]] | None = None
    # Optional post-run "analysis ideas" (LLM-suggested downstream analyses). None = not generated yet;
    # a list once generated (cached so the opt-in LLM pass isn't re-billed on every view). Persisted.
    analysis_ideas: list[dict[str, Any]] | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    # Record count carried on a DB-hydrated summary (result blob not loaded); used by summary_dict when
    # ``result`` is absent so the runs list shows a count without the heavy payload.
    n_records: int = 0

    @classmethod
    def from_db_row(cls, d: dict[str, Any]) -> Job:
        """Rebuild a Job from a :class:`~backend.db.JobDB` record dict (full or summary)."""
        return cls(
            job_id=d["job_id"],
            display_name=d.get("display_name") or "",
            status=d.get("status", "complete"),
            phase=d.get("phase", "complete"),
            completed=d.get("completed", 0),
            total=d.get("total", 0),
            error_message=d.get("error_message"),
            failed_phase=d.get("failed_phase"),
            result=d.get("result"),
            config=d.get("config", {}) or {},
            decisions=d.get("decisions", {}) or {},
            owner_subject=d.get("owner_subject"),
            dict_specs=d.get("dict_specs"),
            analysis_ideas=d.get("analysis_ideas"),
            created_at=d["created_at"],
            updated_at=d["updated_at"],
            n_records=d.get("n_records", 0),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "displayName": self.display_name,
            "status": self.status,
            "phase": self.phase,
            "completed": self.completed,
            "total": self.total,
            "errorMessage": self.error_message,
            "failedPhase": self.failed_phase,
            "result": self.result,
            "config": self.config,
            "decisions": self.decisions,
            "analysisIdeas": self.analysis_ideas,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    def summary_dict(self) -> dict[str, Any]:
        """Lightweight view for the jobs list (omits the heavy result + analysis-ideas payloads)."""
        d = self.to_dict()
        d.pop("result", None)
        d.pop("analysisIdeas", None)
        # Prefer the live result count; fall back to the persisted n_records hint for DB-hydrated summaries.
        d["nRecords"] = len(self.result["records"]) if self.result else self.n_records
        return d


class JobStore:
    """Thread-safe in-memory job registry, mirrored to an optional durable :class:`~backend.db.JobDB`.

    The in-memory layer serves live SSE progress and holds demos. When a ``db`` is attached, real (owned,
    non-pinned) runs are written through to SQLite on **create**, on **terminal** update (complete/error),
    and whenever a **verdict** is recorded — so a user's history survives restarts and is scoped to them.
    Progress ticks are NOT persisted (they live in memory; the SSE endpoint reads them there).
    """

    def __init__(self, ttl_seconds: int = _TTL_SECONDS, work_root: Path | None = None, db: Any | None = None) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._ttl = ttl_seconds
        # Root of the per-job on-disk scratch dirs (``<work_root>/<job_id>`` holds uploads + prompts +
        # substrate). The app sets this after import. Torn down only on explicit delete now — owned runs
        # retain their uploads so they can be re-run (see PERSIST-RUNS-PLAN.md). None -> no teardown
        # (tests, and demos which keep no scratch dir).
        self.work_root = work_root
        # Durable per-user store (backend.db.JobDB) or None (tests / no persistence -> legacy behavior).
        self.db = db

    def _teardown_work_dir(self, job_id: str) -> None:
        """Remove a job's on-disk scratch dir. No-op without a ``work_root`` or if the dir is already gone."""
        if self.work_root is None:
            return
        shutil.rmtree(self.work_root / job_id, ignore_errors=True)

    def _persist(self, job: Job) -> None:
        """Write a job through to the durable store — unless it's pinned (demos/samples aren't persisted)."""
        if self.db is None or _is_pinned(job):
            return
        self.db.upsert(job)

    def create(
        self,
        job_id: str,
        display_name: str,
        config: dict[str, Any],
        owner_subject: str | None = None,
        dict_specs: list[dict[str, Any]] | None = None,
    ) -> Job:
        with self._lock:
            job = Job(
                job_id=job_id,
                display_name=display_name,
                config=config,
                owner_subject=owner_subject,
                dict_specs=dict_specs,
            )
            self._jobs[job_id] = job
        self._persist(job)
        return job

    def get(self, job_id: str) -> Job | None:
        """The live in-memory job, else a durable record hydrated from the DB (evicted / post-restart)."""
        with self._lock:
            job = self._jobs.get(job_id)
        if job is not None:
            return job
        if self.db is not None:
            row = self.db.get(job_id)
            if row is not None:
                return Job.from_db_row(row)
        return None

    def list(self, owner_subject: str | None = None) -> list[Job]:
        """Runs visible to ``owner_subject``: their durable history + any live runs + all demos.

        Without a ``db`` (tests / legacy) this returns every in-memory job, unscoped — the prior behavior.
        """
        with self._lock:
            mem = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        if self.db is None:
            return mem
        demos = [j for j in mem if _is_pinned(j)]
        live_owned = [j for j in mem if not _is_pinned(j) and j.owner_subject == owner_subject]
        live_ids = {j.job_id for j in demos} | {j.job_id for j in live_owned}
        durable = [Job.from_db_row(r) for r in self.db.list_owned(owner_subject) if r["job_id"] not in live_ids]
        return sorted(demos + live_owned + durable, key=lambda j: j.created_at, reverse=True)

    def delete(self, job_id: str) -> bool:
        with self._lock:
            existed = self._jobs.pop(job_id, None) is not None
        if self.db is not None:
            durable = self.db.get(job_id) is not None
            self.db.delete(job_id)
            existed = existed or durable
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
            persist = job.status in TERMINAL_STATES  # mirror only on terminal transitions, not every tick
        if persist:
            self._persist(job)

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

        Works on a past (evicted / post-restart) run too: if it's not live in memory it is hydrated from the
        durable store, the verdict applied, and the whole record re-persisted — so reviewing history later
        records verdicts durably.
        """
        if axis == "transform" and not source_variable:
            return False
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                self._apply_decision(job, record_id, decision, note, axis, source_variable)
        if job is None:  # not live — hydrate the durable record, mutate it, and write it back
            if self.db is None:
                return False
            row = self.db.get(job_id)
            if row is None:
                return False
            job = Job.from_db_row(row)
            self._apply_decision(job, record_id, decision, note, axis, source_variable)
        self._persist(job)  # verdicts must survive a restart
        return True

    def set_analysis_ideas(self, job_id: str, ideas: list[dict[str, Any]]) -> bool:
        """Cache generated analysis ideas on a job (live or DB-hydrated) and persist them, so the opt-in
        LLM pass runs once and survives reload/restart. Returns False if the job doesn't exist."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                job.analysis_ideas = ideas
                job.updated_at = time.time()
        if job is None:
            if self.db is None:
                return False
            row = self.db.get(job_id)
            if row is None:
                return False
            job = Job.from_db_row(row)
            job.analysis_ideas = ideas
            job.updated_at = time.time()
        self._persist(job)
        return True

    @staticmethod
    def _apply_decision(
        job: Job, record_id: str, decision: str, note: str, axis: str, source_variable: str | None
    ) -> None:
        rec = job.decisions.setdefault(record_id, {})
        if axis == "transform":
            transforms: dict[str, Any] = rec.setdefault("transforms", {})
            transforms[source_variable] = {"decision": decision, "note": note}  # type: ignore[index]
        else:
            rec["decision"] = decision
            rec["note"] = note
        job.updated_at = time.time()

    def purge_expired(self) -> None:
        """Evict aged terminal runs from memory (RAM hygiene). Pinned runs (demos) are exempt.

        With a durable ``db``, the row and the on-disk uploads are intentionally RETAINED — the run stays in
        the user's history (served from the DB) and can be re-run until they explicitly delete it. Without a
        ``db`` (legacy single-process), eviction also tears the scratch dir down so uploads never outlive the
        run (the original WS-3 guarantee).
        """
        cutoff = time.time() - self._ttl
        with self._lock:
            stale = [
                jid
                for jid, j in self._jobs.items()
                if j.updated_at < cutoff and j.status in TERMINAL_STATES and not _is_pinned(j)
            ]
            for jid in stale:
                self._jobs.pop(jid, None)
        if self.db is None:  # legacy: no durable copy -> uploads must not outlive the run
            for jid in stale:
                self._teardown_work_dir(jid)


# Module-level singleton used by the app.
store = JobStore()
