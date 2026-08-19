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
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.artifacts import Artifact
    from backend.jobs import Job

_SCHEMA_VERSION = 3  # 3: staged-review checkpoint columns (gate position, pointer, realized cost, version)

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
    failed_phase  TEXT,
    result        TEXT,
    config        TEXT,
    dict_specs    TEXT,
    decisions     TEXT,
    analysis_ideas TEXT,
    composites    TEXT,
    n_records     INTEGER NOT NULL DEFAULT 0,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL,
    -- Staged review (08 D-01/D-02). A run parked at a gate has no worker; these four columns are how it
    -- is found again. `gate_position` is the screen it is parked on; `checkpoint_ref` is a path RELATIVE
    -- to the work root (an absolute path does not survive a redeploy that moves it) pointing at the
    -- payload on the per-run work dir; `realized_cost` is what has actually been spent so far, persisted
    -- so a rehydrated run cannot report zero; `result_version` is the token the progress stream carries
    -- so the client knows WHEN to refetch the payload instead of being handed it twice a second.
    gate_position  TEXT,
    checkpoint_ref TEXT,
    realized_cost  REAL NOT NULL DEFAULT 0,
    result_version INTEGER NOT NULL DEFAULT 0
)
"""

# Purpose-built for "list my runs, newest first".
_CREATE_INDEX = "CREATE INDEX IF NOT EXISTS idx_jobs_owner_created ON jobs (owner_subject, created_at DESC)"

# A user's own work ON a run — verdicts, composite specs, analysis ideas (see backend/artifacts.py). Keyed
# by (owner, job, kind, item_key) because these belong to a (user, run) PAIR, not to the run: the canonical
# demo is one shared row, so storing annotations on it made every user's work visible to all of them.
# The UNIQUE constraint is the upsert semantics — re-voting a record or re-deriving a score replaces it.
_CREATE_ARTIFACTS = """
CREATE TABLE IF NOT EXISTS user_artifacts (
    artifact_id    TEXT PRIMARY KEY,
    owner_subject  TEXT NOT NULL,
    job_id         TEXT NOT NULL,
    kind           TEXT NOT NULL,
    item_key       TEXT NOT NULL DEFAULT '',
    payload        TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at     REAL NOT NULL,
    updated_at     REAL NOT NULL,
    UNIQUE (owner_subject, job_id, kind, item_key)
)
"""
_CREATE_ARTIFACT_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_artifacts_owner_job ON user_artifacts (owner_subject, job_id)",
    "CREATE INDEX IF NOT EXISTS idx_artifacts_job ON user_artifacts (job_id)",  # cascade on run delete
)

# Additive columns added after the table first shipped — ALTER-ed in on startup for DB files created by an
# earlier version (CREATE TABLE IF NOT EXISTS won't add a column to an existing table). column -> SQL type.
_ADDITIVE_COLUMNS = {
    "analysis_ideas": "TEXT",
    "failed_phase": "TEXT",
    "composites": "TEXT",
    "gate_position": "TEXT",
    "checkpoint_ref": "TEXT",
    "realized_cost": "REAL NOT NULL DEFAULT 0",
    "result_version": "INTEGER NOT NULL DEFAULT 0",
}

# Columns hydrated for the runs LIST. Omits the heavy result/dict_specs blobs but KEEPS the small config
# (the UI reads run_mode/demo from it), failed_phase (an error row's failing stage, for the report link),
# and n_records (record count without loading the result payload).
_SUMMARY_COLS = (
    "job_id, owner_subject, display_name, status, phase, completed, total, "
    "error_message, failed_phase, config, decisions, n_records, created_at, updated_at, "
    # All four checkpoint columns are tiny scalars, so the runs LIST can say "Paused at Gate 1 · spent
    # $2.14" without loading a result blob — which is the whole reason the payload is not in this row.
    "gate_position, checkpoint_ref, realized_cost, result_version"
)
# A full read adds the heavy blobs (result + dict_specs + analysis_ideas) alongside the summary columns.
_ALL_COLS = _SUMMARY_COLS.replace("config,", "config, result, dict_specs, analysis_ideas, composites,")

# Durably terminal. MUST stay identical to ``backend.jobs.TERMINAL_STATES`` — asserted by
# ``tests/test_checkpoint.py::test_the_two_terminal_definitions_agree``. It omitted ``cancelled`` until
# 08-08, so a "keep" stop (the user finishing the in-flight stage to collect work they had already paid
# for) was re-labelled ``error`` on the next restart, with a message telling them to re-run and pay again.
_TERMINAL = ("complete", "error", "cancelled")

# Statuses that imply a LIVE WORKER THREAD. `recover_stale` is an ALLOW-LIST over these, not a deny-list
# over the terminal set, because "non-terminal" is not evidence that a worker died: a run parked at
# ``awaiting_review`` has no worker BY CONSTRUCTION (08 D-01 makes a gate pause an exit, not a block).
# The old blanket `WHERE status NOT IN (terminal)` therefore destroyed every paused run on every deploy
# — T-08-40, the single most expensive defect in this phase.
#
# Held as a literal rather than imported from ``backend.engine.contract`` so this module stays free of the
# engine; ``tests/test_checkpoint.py::test_the_live_worker_allowlist_covers_every_reported_phase`` asserts
# it covers every phase the engine reports, which is the drift this literal would otherwise invite.
# The two states the sweep must NEVER touch. Kept minimal and explicit, because this is the set whose
# membership decides whether a user's paid work survives a deploy.
_NEVER_RECOVERED = _TERMINAL + ("awaiting_review",)

_LIVE_WORKER_STATUSES = (
    "pending",
    "loading",
    "embedding",
    "clustering",
    "generating",
    "splitting",
    "assigning",
    "gencde",
    "specs",
    "refine",
    "prepared",
)


def _loads(text: str | None, default: Any) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return default


def _verdicts_from_legacy(record_id: str, verdict: Any) -> list[dict[str, Any]]:
    """Flatten one legacy ``decisions[record_id]`` blob into per-axis verdict payloads.

    The legacy shape nested three independent axes under one record key::

        {"decision": …, "note": …,
         "transforms": {source_variable: {"decision": …, "note": …}},
         "gencde": {"decision": …, "note": …, "edited": …}}

    Each axis becomes its own row, which is what makes concurrent writes on different axes stop clobbering
    each other. A blob with no top-level decision (only transforms) yields no match-axis row.
    """
    if not isinstance(verdict, dict):
        return []
    out: list[dict[str, Any]] = []
    if verdict.get("decision"):
        out.append(
            {
                "recordId": record_id,
                "axis": "match",
                "decision": verdict["decision"],
                "note": verdict.get("note", ""),
            }
        )
    for source_variable, entry in (verdict.get("transforms") or {}).items():
        if isinstance(entry, dict) and entry.get("decision"):
            out.append(
                {
                    "recordId": record_id,
                    "axis": "transform",
                    "sourceVariable": source_variable,
                    "decision": entry["decision"],
                    "note": entry.get("note", ""),
                }
            )
    gencde = verdict.get("gencde")
    if isinstance(gencde, dict) and gencde.get("decision"):
        payload = {
            "recordId": record_id,
            "axis": "gencde",
            "decision": gencde["decision"],
            "note": gencde.get("note", ""),
        }
        if gencde.get("edited"):
            payload["edited"] = gencde["edited"]
        out.append(payload)
    return out


def _verdicts_to_legacy(payloads: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Rebuild the legacy ``decisions`` mapping from per-axis verdict artifacts.

    The wire contract the frontend reads (``result.decisions``) is unchanged by this refactor, so the
    resolved artifacts are re-nested into the shape the workbench already understands.
    """
    out: dict[str, dict[str, Any]] = {}
    for payload in payloads:
        record_id = str(payload.get("recordId") or "")
        if not record_id:
            continue
        entry = out.setdefault(record_id, {})
        axis = payload.get("axis") or "match"
        if axis == "match":
            entry["decision"] = payload.get("decision")
            entry["note"] = payload.get("note", "")
        elif axis == "transform":
            transforms = entry.setdefault("transforms", {})
            transforms[str(payload.get("sourceVariable") or "")] = {
                "decision": payload.get("decision"),
                "note": payload.get("note", ""),
            }
        elif axis == "gencde":
            gencde: dict[str, Any] = {"decision": payload.get("decision"), "note": payload.get("note", "")}
            if payload.get("edited"):
                gencde["edited"] = payload["edited"]
            entry["gencde"] = gencde
    return out


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
            self._conn.execute(_CREATE_ARTIFACTS)
            for stmt in _CREATE_ARTIFACT_INDEXES:
                self._conn.execute(stmt)
            existing = {row["name"] for row in self._conn.execute("PRAGMA table_info(jobs)")}
            for col, sqltype in _ADDITIVE_COLUMNS.items():  # migrate DBs created by an earlier schema
                if col not in existing:
                    self._conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {sqltype}")
            was = self._conn.execute("PRAGMA user_version").fetchone()[0]
            self._conn.commit()
        if was < 2:
            self.backfill_artifacts()
        with self._lock:
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
            job.failed_phase,
            json.dumps(job.result) if job.result is not None else None,
            json.dumps(job.config),
            json.dumps(job.dict_specs) if job.dict_specs is not None else None,
            json.dumps(job.decisions),
            json.dumps(job.analysis_ideas) if job.analysis_ideas is not None else None,
            json.dumps(job.composites) if job.composites is not None else None,
            n_records,
            job.created_at,
            job.updated_at,
            job.gate_position,
            job.checkpoint_ref,
            job.cost_so_far,
            job.result_version,
        )
        with self._lock:
            self._conn.execute(
                """INSERT INTO jobs (job_id, owner_subject, display_name, status, phase, completed, total,
                                     error_message, failed_phase, result, config, dict_specs, decisions,
                                     analysis_ideas, composites, n_records, created_at, updated_at,
                                     gate_position, checkpoint_ref, realized_cost, result_version)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(job_id) DO UPDATE SET
                       owner_subject=excluded.owner_subject,
                       display_name=excluded.display_name,
                       status=excluded.status,
                       phase=excluded.phase,
                       completed=excluded.completed,
                       total=excluded.total,
                       error_message=excluded.error_message,
                       failed_phase=excluded.failed_phase,
                       result=excluded.result,
                       config=excluded.config,
                       dict_specs=excluded.dict_specs,
                       decisions=excluded.decisions,
                       analysis_ideas=excluded.analysis_ideas,
                       composites=excluded.composites,
                       n_records=excluded.n_records,
                       updated_at=excluded.updated_at,
                       gate_position=excluded.gate_position,
                       checkpoint_ref=excluded.checkpoint_ref,
                       realized_cost=excluded.realized_cost,
                       result_version=excluded.result_version""",
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

    # --- user artifacts (see backend/artifacts.py) ---------------------------------------------

    def upsert_artifact(
        self,
        *,
        artifact_id: str,
        owner_subject: str,
        job_id: str,
        kind: str,
        item_key: str,
        payload: dict[str, Any],
        schema_version: int,
    ) -> Artifact:
        """Insert or replace one artifact and return what is now stored.

        Returning the row (rather than a bool) is deliberate: the bug this table replaces was a setter that
        reported success for a write it had silently dropped.
        """
        now = time.time()
        with self._lock:
            self._conn.execute(
                """INSERT INTO user_artifacts (artifact_id, owner_subject, job_id, kind, item_key,
                                               payload, schema_version, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(owner_subject, job_id, kind, item_key) DO UPDATE SET
                       payload=excluded.payload,
                       schema_version=excluded.schema_version,
                       updated_at=excluded.updated_at""",
                (
                    artifact_id,
                    owner_subject,
                    job_id,
                    kind,
                    item_key,
                    json.dumps(payload),
                    schema_version,
                    now,
                    now,
                ),
            )
            self._conn.commit()
            row = self._conn.execute(
                """SELECT * FROM user_artifacts
                   WHERE owner_subject=? AND job_id=? AND kind=? AND item_key=?""",
                (owner_subject, job_id, kind, item_key),
            ).fetchone()
        return self._row_to_artifact(row)

    def list_artifacts(self, *, owner_subject: str, job_id: str) -> list[Artifact]:
        """Every artifact one owner holds for one run. Scoped by owner by construction."""
        with self._lock:
            rows = self._conn.execute(
                """SELECT * FROM user_artifacts WHERE owner_subject=? AND job_id=?
                   ORDER BY kind, item_key""",
                (owner_subject, job_id),
            ).fetchall()
        return [self._row_to_artifact(r) for r in rows]

    def delete_artifact(self, *, owner_subject: str, job_id: str, kind: str, item_key: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                """DELETE FROM user_artifacts
                   WHERE owner_subject=? AND job_id=? AND kind=? AND item_key=?""",
                (owner_subject, job_id, kind, item_key),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def delete_artifacts(self, *, job_id: str | None = None, owner_subject: str | None = None) -> int:
        """Bulk delete by run (cascade on run deletion) or by owner (delete-my-data)."""
        if job_id is None and owner_subject is None:
            raise ValueError("delete_artifacts needs a job_id or an owner_subject")
        clauses, params = [], []
        if job_id is not None:
            clauses.append("job_id=?")
            params.append(job_id)
        if owner_subject is not None:
            clauses.append("owner_subject=?")
            params.append(owner_subject)
        with self._lock:
            cur = self._conn.execute(f"DELETE FROM user_artifacts WHERE {' AND '.join(clauses)}", params)
            self._conn.commit()
            return cur.rowcount

    def backfill_artifacts(self) -> int:
        """One-shot migration of the per-job artifact columns into ``user_artifacts``.

        Only rows with an ``owner_subject`` are migrated. Ownerless (demo/pinned) rows are DROPPED on
        purpose: their columns hold the cross-user mixture that the shared-demo bug produced, so there is no
        single user they can honestly be attributed to.

        Idempotent — re-running cannot duplicate, because the upsert is keyed by artifact identity.
        """
        from backend.artifact_kinds import ANALYSIS_IDEAS, VERDICT  # local: avoids an import cycle

        migrated = 0
        with self._lock:
            rows = self._conn.execute("""SELECT job_id, owner_subject, decisions, analysis_ideas FROM jobs
                   WHERE owner_subject IS NOT NULL""").fetchall()
        for row in rows:
            owner, job_id = row["owner_subject"], row["job_id"]
            for record_id, verdict in (_loads(row["decisions"], {}) or {}).items():
                for payload in _verdicts_from_legacy(record_id, verdict):
                    self.upsert_artifact(
                        artifact_id=uuid.uuid4().hex,
                        owner_subject=owner,
                        job_id=job_id,
                        kind=VERDICT,
                        item_key=f"{payload['recordId']}|{payload['axis']}|{payload.get('sourceVariable') or ''}",
                        payload=payload,
                        schema_version=1,
                    )
                    migrated += 1
            # No key guard: the SELECT above names this column, and `"x" in row` on a sqlite3.Row tests its
            # VALUES rather than its keys — a guard written that way silently skipped every ideas payload.
            ideas = _loads(row["analysis_ideas"], None)
            if ideas:
                self.upsert_artifact(
                    artifact_id=uuid.uuid4().hex,
                    owner_subject=owner,
                    job_id=job_id,
                    kind=ANALYSIS_IDEAS,
                    item_key="",
                    payload={"ideas": ideas},
                    schema_version=1,
                )
                migrated += 1
        return migrated

    @staticmethod
    def _row_to_artifact(row: sqlite3.Row) -> Artifact:
        from backend.artifacts import Artifact as _Artifact

        return _Artifact(
            artifact_id=row["artifact_id"],
            owner_subject=row["owner_subject"],
            job_id=row["job_id"],
            kind=row["kind"],
            item_key=row["item_key"],
            payload=_loads(row["payload"], {}),
            schema_version=row["schema_version"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def recover_stale(self) -> int:
        """On startup, reconcile rows whose WORKER died on a prior restart → mark them error.

        An ALLOW-LIST over :data:`_LIVE_WORKER_STATUSES`, deliberately not a deny-list over the terminal
        set. The old blanket ``WHERE status NOT IN (terminal)`` treated "non-terminal" as "its worker
        died", which is false for a run parked at ``awaiting_review``: a gate pause is an EXIT (08 D-01),
        so a paused run has no worker to have died and the sweep destroyed it — on every deploy, silently,
        after the user had paid for the stages it held (T-08-40).

        Two clauses, each doing a different job:

        1. **The allow-list.** A status naming a pipeline stage in flight positively implies a thread that
           no longer exists. This is the set the sweep is FOR.
        2. **The unknown-status catch-all.** A status this build does not recognise — written by an older
           version, or by a stage since renamed — is not one of the two states we protect, and leaving it
           alone strands the run forever in a state no UI can explain. An allow-list alone has exactly
           that blind spot; the shipped ``jobs`` table already contains such a row in one test fixture.

        What survives is therefore only what :data:`_NEVER_RECOVERED` names, which is the point: that set
        is small, explicit, and is the one whose membership decides whether a user's paid work survives.
        """
        known = _LIVE_WORKER_STATUSES + _NEVER_RECOVERED
        live = ",".join("?" for _ in _LIVE_WORKER_STATUSES)
        allknown = ",".join("?" for _ in known)
        with self._lock:
            cur = self._conn.execute(
                f"""UPDATE jobs
                   SET status='error', phase='error',
                       error_message='Run interrupted by a server restart. Please re-run.',
                       updated_at=?
                   WHERE status IN ({live})
                      OR status NOT IN ({allknown})""",
                (time.time(), *_LIVE_WORKER_STATUSES, *known),
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
            "failed_phase": row["failed_phase"] if "failed_phase" in keys else None,
            "config": _loads(row["config"], {}),  # small; carried in summaries so the UI knows run_mode/demo
            "decisions": _loads(row["decisions"], {}),
            "n_records": row["n_records"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            # Guarded like failed_phase: a row read through a legacy SELECT (or a DB opened before the
            # ALTER ran) has no such column, and `"x" in row.keys()` is the only correct membership test
            # here — `"x" in row` on a sqlite3.Row tests its VALUES.
            "gate_position": row["gate_position"] if "gate_position" in keys else None,
            "checkpoint_ref": row["checkpoint_ref"] if "checkpoint_ref" in keys else None,
            "realized_cost": (row["realized_cost"] or 0.0) if "realized_cost" in keys else 0.0,
            "result_version": (row["result_version"] or 0) if "result_version" in keys else 0,
        }
        if full and "result" in keys:
            d["result"] = _loads(row["result"], None)
            d["dict_specs"] = _loads(row["dict_specs"], None)
            d["analysis_ideas"] = _loads(row["analysis_ideas"], None)
            d["composites"] = _loads(row["composites"], None) if "composites" in keys else None
        return d
