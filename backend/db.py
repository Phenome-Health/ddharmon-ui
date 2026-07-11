"""Durable SQLite mirror for harmonization runs (per-user history).

The in-memory :class:`~backend.jobs.JobStore` holds live progress for SSE streaming, but it is lost on
restart and unscoped. This module adds a durable, per-user record so a signed-in user can leave and come
back to *their* past runs (and re-run them). Modeled on biomapper-ui's ``services/database.py`` (SQLite +
hand-written SQL + ``CREATE TABLE IF NOT EXISTS`` on startup), but **synchronous** stdlib ``sqlite3`` —
ddharmon-ui runs the pipeline in threads, not asyncio, so a sync, lock-guarded connection fits its model
and adds no dependency.

Ownership key is the verified Clerk ``Principal.subject`` (never a client-supplied header). Demos are NOT
persisted here — they are re-seeded every boot and are public/ownerless.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.jobs import Job

_SCHEMA_VERSION = 1

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id        TEXT PRIMARY KEY,
    owner_subject TEXT,
    display_name  TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    phase         TEXT NOT NULL DEFAULT 'pending',
    completed     INTEGER NOT NULL DEFAULT 0,
    total         INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    result        TEXT,
    config        TEXT,
    dict_specs    TEXT,
    decisions     TEXT,
    analysis_ideas TEXT,
    n_records     INTEGER NOT NULL DEFAULT 0,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL
)
"""

# Purpose-built for "list my runs, newest first".
_CREATE_INDEX = "CREATE INDEX IF NOT EXISTS idx_jobs_owner_created ON jobs (owner_subject, created_at DESC)"

# Additive columns added after the table first shipped — ALTER-ed in on startup for DB files created by an
# earlier version (CREATE TABLE IF NOT EXISTS won't add a column to an existing table). column -> SQL type.
_ADDITIVE_COLUMNS = {"analysis_ideas": "TEXT"}

# Columns hydrated for the runs LIST. Omits the heavy result/dict_specs blobs but KEEPS the small config
# (the UI reads run_mode/demo from it) and n_records (record count without loading the result payload).
_SUMMARY_COLS = (
    "job_id, owner_subject, display_name, status, phase, completed, total, "
    "error_message, config, decisions, n_records, created_at, updated_at"
)
# A full read adds the heavy blobs (result + dict_specs + analysis_ideas) alongside the summary columns.
_ALL_COLS = _SUMMARY_COLS.replace("config,", "config, result, dict_specs, analysis_ideas,")

# A run is durably terminal only when complete/error. Anything else on disk after a restart means the
# worker thread died mid-run — recover_stale() reconciles those to error.
_TERMINAL = ("complete", "error")


def _loads(text: str | None, default: Any) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return default


class JobDB:
    """Thread-safe synchronous SQLite store for persisted runs.

    One shared connection guarded by a lock (mirrors the JobStore lock discipline). ``check_same_thread``
    is off because the pipeline runs in daemon threads; all access is serialized by ``_lock`` regardless.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._lock = threading.Lock()
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute(_CREATE_TABLE)
            self._conn.execute(_CREATE_INDEX)
            existing = {row["name"] for row in self._conn.execute("PRAGMA table_info(jobs)")}
            for col, sqltype in _ADDITIVE_COLUMNS.items():  # migrate DBs created by an earlier schema
                if col not in existing:
                    self._conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {sqltype}")
            self._conn.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def upsert(self, job: Job) -> None:
        """Write (or overwrite) a job's durable record. Idempotent by ``job_id``."""
        n_records = len(job.result["records"]) if job.result and "records" in job.result else 0
        row = (
            job.job_id,
            job.owner_subject,
            job.display_name,
            job.status,
            job.phase,
            job.completed,
            job.total,
            job.error_message,
            json.dumps(job.result) if job.result is not None else None,
            json.dumps(job.config),
            json.dumps(job.dict_specs) if job.dict_specs is not None else None,
            json.dumps(job.decisions),
            json.dumps(job.analysis_ideas) if job.analysis_ideas is not None else None,
            n_records,
            job.created_at,
            job.updated_at,
        )
        with self._lock:
            self._conn.execute(
                """INSERT INTO jobs (job_id, owner_subject, display_name, status, phase, completed, total,
                                     error_message, result, config, dict_specs, decisions, analysis_ideas,
                                     n_records, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(job_id) DO UPDATE SET
                       owner_subject=excluded.owner_subject,
                       display_name=excluded.display_name,
                       status=excluded.status,
                       phase=excluded.phase,
                       completed=excluded.completed,
                       total=excluded.total,
                       error_message=excluded.error_message,
                       result=excluded.result,
                       config=excluded.config,
                       dict_specs=excluded.dict_specs,
                       decisions=excluded.decisions,
                       analysis_ideas=excluded.analysis_ideas,
                       n_records=excluded.n_records,
                       updated_at=excluded.updated_at""",
                row,
            )
            self._conn.commit()

    def get(self, job_id: str) -> dict[str, Any] | None:
        """Full record (incl. result/config/dict_specs) for one job, or None."""
        with self._lock:
            cur = self._conn.execute(f"SELECT {_ALL_COLS} FROM jobs WHERE job_id = ?", (job_id,))
            row = cur.fetchone()
        return self._row_to_dict(row, full=True) if row else None

    def list_owned(self, owner_subject: str | None) -> list[dict[str, Any]]:
        """Summary rows (no heavy blobs) for one owner, newest first."""
        with self._lock:
            cur = self._conn.execute(
                f"SELECT {_SUMMARY_COLS} FROM jobs WHERE owner_subject IS ? ORDER BY created_at DESC LIMIT 200",
                (owner_subject,),
            )
            rows = cur.fetchall()
        return [self._row_to_dict(r, full=False) for r in rows]

    def delete(self, job_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
            self._conn.commit()

    def recover_stale(self) -> int:
        """On startup, any non-terminal row is a run whose worker died on a prior restart → mark it error."""
        with self._lock:
            cur = self._conn.execute(
                """UPDATE jobs
                   SET status='error', phase='error',
                       error_message='Run interrupted by a server restart. Please re-run.',
                       updated_at=?
                   WHERE status NOT IN (?, ?)""",
                (time.time(), *_TERMINAL),
            )
            self._conn.commit()
            return cur.rowcount

    @staticmethod
    def _row_to_dict(row: sqlite3.Row, *, full: bool) -> dict[str, Any]:
        keys = set(row.keys())
        d: dict[str, Any] = {
            "job_id": row["job_id"],
            "owner_subject": row["owner_subject"],
            "display_name": row["display_name"],
            "status": row["status"],
            "phase": row["phase"],
            "completed": row["completed"],
            "total": row["total"],
            "error_message": row["error_message"],
            "config": _loads(row["config"], {}),  # small; carried in summaries so the UI knows run_mode/demo
            "decisions": _loads(row["decisions"], {}),
            "n_records": row["n_records"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if full and "result" in keys:
            d["result"] = _loads(row["result"], None)
            d["dict_specs"] = _loads(row["dict_specs"], None)
            d["analysis_ideas"] = _loads(row["analysis_ideas"], None)
        return d
