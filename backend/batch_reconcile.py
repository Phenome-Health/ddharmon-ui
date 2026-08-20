"""Reconcile paid Batch API work that outlived the process which submitted it — D-04.

08-08 made a run parked at a gate survive a restart. This module covers the other half of R14: work that
was **already charged for and is still in flight at the provider** when the process goes away.

**The hole, precisely.** A batch stage calls core's ``resume_and_wait``, which submits the prompts (the
account is charged at that moment, and a submitted batch cannot be un-submitted) and then blocks polling
until the batch ends. If the process dies during that poll — a redeploy, a crash, an OOM — nobody ever
retrieves the result. The manifest core wrote (``prompts_<tag>.jsonl.batch_manifest.json``, carrying the
``batch_id``) is still on the run's work dir, so the money is provably spent and the output is provably
reachable; there was simply no code that ever went back for it.

**Retrieval is FREE.** Everything here reads an already-submitted batch. This module never submits: no
``submit_batch``, no ``submit_and_wait``, no ``resume_and_wait`` (which submits the gap). A background
sweep that could submit would be a timer able to spend a user's money with nobody in the loop (T-08-56),
so the absence of a submitter is asserted by test, not just intended.

**Idempotency is derived from disk, never from a lock** (T-08-53). The gap is
``ids the manifest says were submitted`` MINUS ``ids already in responses_<tag>.jsonl``. A reconcile over
a work dir with no gap does nothing at all: no fetch, no write, no version bump. That is the same
mechanism the adapter's batch stages already rely on ("only missing ids are (re)submitted, so a re-run
over a frozen work dir is a byte-identical zero-cost replay"), which is why the interval sweep and the
on-open path can genuinely race and still produce exactly one effect.

**A per-run lock is politeness, NOT the correctness mechanism.** Two callers in one process are
serialized by :func:`_lock_for` so the second one re-reads the gap and finds it closed — which is what
makes "the version token moves exactly once per arrival" (T-08-55) structural rather than a scheduling
accident that would flip the moment the fetch does real network I/O. Correctness does not rest on it: a
second PROCESS holds no such lock, and the disk-derived gap is what makes that case converge too.

**What "attach" means, and what it deliberately does not mean.** A reconciled response is attached to the
run's checkpointed *stage output* — the replay fuel the next leg answers its prompts from — and nothing
else. It does not re-render the gate payload, re-assign records or advance the run: doing any of that
would require the pipeline, and the pipeline is the adapter's business. So a late result becomes $0
replay fuel for the reviewer's next Continue rather than a silent mutation of what they are looking at.

**A late result for a gate the run has already passed is still attached** (D-04), into the checkpoint the
run is currently parked at, because that is the file the next leg reads. Dropping it would mean throwing
away work the user paid for on the grounds that they were slow to come back.

**Never overwrite a recorded answer.** Only ids the checkpoint has no entry for are filled. An id the
first leg recorded as asked-but-unanswered stays that way: the leg that recorded it already produced the
result now on the reviewer's screen, and quietly changing that leg's inputs after the fact would make the
run's own history disagree with itself. The retrieved record still lands in ``responses_<tag>.jsonl``, so
a future full re-run over this work dir replays it for free.

**BYOK limit, stated rather than hidden.** A per-request Anthropic key is never persisted, so the
background sweep has no key of its own and can only retrieve when the host supplies one
(``ANTHROPIC_API_KEY``). On a pure bring-your-own-key deployment the sweep records the retrieval as failed
and the on-open path — which does carry the reviewer's key — is what actually recovers the work.
"""

from __future__ import annotations

import contextlib
import json
import logging
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol

from backend.checkpoint import load_checkpoint, write_checkpoint

logger = logging.getLogger(__name__)

#: How often the interval sweep runs, in seconds.
#:
#: The tradeoff, explicitly: shorter means a reviewer who never comes back gets their paid work sooner,
#: and means more polling of the provider from a process that may have hundreds of idle runs on disk.
#: Five minutes is chosen against the Batch API's own scale — batches take minutes to hours, so anything
#: under a minute polls many times per batch for no information, and anything over ~15 minutes stops
#: being "the reviewer's work is here when they return". The startup sweep, not this interval, is what
#: covers a restart; the on-open reconcile, not this interval, is what covers a returning reviewer. This
#: number only has to cover the reviewer who NEVER returns, which is not a latency-sensitive case.
RECONCILE_INTERVAL_SECONDS = 300

#: Batch cache tag -> the pipeline stage kwarg whose replay fuel it is.
#:
#: These are NOT the same string: ``classify`` caches to ``assign`` and ``distinct_kinds`` to ``kinds``.
#: Held as a literal here (the pattern ``backend.db._LIVE_WORKER_STATUSES`` set) so this module stays free
#: of the engine, with ``tests/test_checkpoint.py::test_the_tag_to_stage_map_matches_the_adapters_batch_wiring``
#: reading the adapter's AST to make drift a test failure rather than a paid answer filed under a stage
#: name nobody replays.
TAG_TO_STAGE: dict[str, str] = {
    "generate": "generate",
    "split": "split",
    "assign": "classify",
    "gencde": "gencde",
    "specgen": "specgen",
    "refine": "refine",
    "coherence": "coherence",
    "kinds": "distinct_kinds",
    "concept_gate": "concept_gate",
}

_MANIFEST_SUFFIX = ".batch_manifest.json"
_GAP_SUFFIX = ".resume"  # core's sidecar for a gap re-submission; survives a kill mid-poll
_PROMPTS_PREFIX = "prompts_"
_JSONL = ".jsonl"

#: Where a failed retrieval is recorded: on the run's own durable work dir, beside the artifacts it
#: describes. Deliberately not a jobs-row column — the row is rewritten whole on every write (D-02), and
#: an operator diagnosing "why is this run's split short" wants the file next to the responses.
_FAILURES_FILE = "reconcile_failures.jsonl"

FetchStatus = Literal["available", "pending", "failed"]

#: Terminal-ish outcome of reconciling one run.
ReconcileStatus = Literal["noop", "reconciled", "pending", "failed", "skipped"]


class WorkDirMissingError(RuntimeError):
    """A run's per-run work dir is not on disk, so its paid batch output cannot be reached.

    Raised rather than reported as success: "reconciled, nothing to do" and "the directory holding this
    run's paid output is gone" are opposite facts, and conflating them would mark unrecoverable work as
    recovered. Always names the run and the path.
    """


@dataclass(frozen=True)
class FetchResult:
    """What the upstream says about one submitted batch.

    Three outcomes, kept distinct on purpose. ``pending`` is not an error (the batch has not ended and the
    work is still coming); ``failed`` is not an empty success (the batch ended without the records, and
    saying nothing would leave a short stage looking complete).
    """

    status: FetchStatus
    #: ``{"id": <prompt id>, "response": ..., "usage"?: ...}`` records, exactly the jsonl line shape core's
    #: ``retrieve_batch`` writes and the adapter's response loader reads.
    records: tuple[dict[str, Any], ...] = ()
    detail: str = ""


class FetchFn(Protocol):
    """Retrieve one already-submitted batch. Injected so a test can count calls without a provider."""

    def __call__(
        self, batch_id: str, *, manifest_path: Path | None = None, api_key: str | None = None
    ) -> FetchResult: ...


@dataclass(frozen=True)
class Submission:
    """One batch this run submitted whose results are not fully on disk yet."""

    tag: str
    stage: str
    batch_id: str
    manifest_path: Path
    responses_path: Path
    #: Prompt ids the manifest says were submitted and that ``responses_<tag>.jsonl`` still lacks.
    missing: tuple[str, ...]


@dataclass(frozen=True)
class ReconcileOutcome:
    """What one reconcile did. ``status`` is the worst thing that happened, so a caller can log one line."""

    job_id: str
    status: ReconcileStatus
    #: stage name -> how many responses were newly attached to the checkpoint.
    attached: dict[str, int] = field(default_factory=dict)
    #: tags whose batch has not ended upstream.
    pending: tuple[str, ...] = ()
    #: tags whose retrieval failed.
    failed: tuple[str, ...] = ()
    #: How many times the upstream was asked anything — the number a race test asserts on.
    fetches: int = 0
    detail: str = ""

    @property
    def changed(self) -> bool:
        """Whether this reconcile altered the run. Exactly the condition that moves the version token."""
        return bool(self.attached)


# ── reading what is on disk ──────────────────────────────────────────────────────────────────


def _tag_of_manifest(manifest: Path) -> str | None:
    """The batch cache tag a manifest belongs to, or None when the file is not one of ours.

    Derived from the FILE NAME, never from the manifest's own ``prompts_path``: that field is absolute as
    of submit time and a redeploy that moves the work root would make every manifest point at nothing —
    the same failure mode 08-08 avoided by storing the checkpoint pointer relative to the root.
    """
    name = manifest.name[: -len(_MANIFEST_SUFFIX)]
    if name.endswith(_GAP_SUFFIX):  # core's gap sidecar, left behind when a kill skipped its cleanup
        name = name[: -len(_GAP_SUFFIX)]
    if not (name.startswith(_PROMPTS_PREFIX) and name.endswith(_JSONL)):
        return None
    return name[len(_PROMPTS_PREFIX) : -len(_JSONL)] or None


def _ids_in_jsonl(path: Path) -> set[str]:
    """Record ids present in a jsonl file. A missing or unreadable line is simply not present."""
    ids: set[str] = set()
    if not path.exists():
        return ids
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ids.add(str(json.loads(line)["id"]))
            except (ValueError, KeyError, TypeError):
                continue
    return ids


def _submitted_ids(manifest: dict[str, Any], work_dir: Path, tag: str) -> set[str]:
    """The prompt ids a manifest's batch covers, in the original (un-sanitized) id space.

    ``id_map`` is core's sanitized-custom-id -> original-id map, which is the authoritative answer. A
    manifest written without one falls back to the prompts file the tag was built from.
    """
    id_map = manifest.get("id_map") or {}
    if isinstance(id_map, dict) and id_map:
        return {str(v) for v in id_map.values()}
    return _ids_in_jsonl(work_dir / f"{_PROMPTS_PREFIX}{tag}{_JSONL}")


def outstanding_submissions(work_dir: str | Path) -> list[Submission]:
    """Every batch this run submitted whose results are not fully on disk — the gap, read off disk.

    This is the whole idempotency mechanism: an empty list means there is nothing to do and nothing to
    write, which is what makes a repeated reconcile free and a racing pair of reconciles converge.
    """
    wd = Path(work_dir)
    if not wd.is_dir():
        return []
    out: list[Submission] = []
    for manifest_path in sorted(wd.glob(f"*{_MANIFEST_SUFFIX}")):
        tag = _tag_of_manifest(manifest_path)
        if tag is None:
            continue
        stage = TAG_TO_STAGE.get(tag)
        if stage is None:
            # A tag this build has no stage for. Logged rather than guessed: filing a paid answer under a
            # made-up stage name would put it somewhere no replay ever reads.
            logger.warning("work dir %s has a batch manifest for unknown tag %r — not reconciled", wd, tag)
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, ValueError) as exc:
            logger.warning("unreadable batch manifest %s (%s) — not reconciled", manifest_path, exc)
            continue
        batch_id = str(manifest.get("batch_id") or "")
        if not batch_id:
            continue
        responses_path = wd / f"responses_{tag}{_JSONL}"
        missing = _submitted_ids(manifest, wd, tag) - _ids_in_jsonl(responses_path)
        if not missing:
            continue
        out.append(
            Submission(
                tag=tag,
                stage=stage,
                batch_id=batch_id,
                manifest_path=manifest_path,
                responses_path=responses_path,
                missing=tuple(sorted(missing)),
            )
        )
    return out


# ── the default upstream: a RETRIEVAL, never a submission ────────────────────────────────────


def _retrieve_via_core(batch_id: str, *, manifest_path: Path | None = None, api_key: str | None = None) -> FetchResult:
    """Fetch one already-submitted batch through core's ``retrieve_batch``. Free; never submits.

    ``retrieve_batch`` opens its output path with ``"w"``, so it is pointed at a THROWAWAY sidecar and the
    records are read back from there. Handing it the run's real ``responses_<tag>.jsonl`` would erase every
    response already retrieved for that stage — the precise paid work this module exists to preserve.

    It reports "still processing" by returning before it ever creates that file, which is how a genuine
    pending is told apart from a batch that ended with nothing for us.
    """
    from ddharmon.llm.batch import retrieve_batch

    tmpdir = Path(tempfile.mkdtemp(prefix="ddharmon-reconcile-"))
    sidecar = tmpdir / "responses.jsonl"
    try:
        try:
            written = retrieve_batch(batch_id, sidecar, manifest_path=manifest_path, api_key=api_key)
        except Exception as exc:  # noqa: BLE001 — an upstream error must not unwind a sweep over other runs
            return FetchResult(status="failed", detail=f"{type(exc).__name__}: {exc}")
        if not sidecar.exists():
            return FetchResult(status="pending", detail=f"batch {batch_id} has not ended")
        records: list[dict[str, Any]] = []
        with open(sidecar) as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
        if not records:
            return FetchResult(status="failed", detail=f"batch {batch_id} ended with no usable results")
        logger.info("batch %s retrieved %d record(s) (%d written)", batch_id, len(records), written)
        return FetchResult(status="available", records=tuple(records))
    finally:
        sidecar.unlink(missing_ok=True)
        with contextlib.suppress(OSError):
            tmpdir.rmdir()


# ── the one reconcile entry point ────────────────────────────────────────────────────────────


def _append_records(responses_path: Path, records: list[dict[str, Any]]) -> None:
    """Append newly-retrieved records to the run's response cache. Append, never rewrite."""
    responses_path.parent.mkdir(parents=True, exist_ok=True)
    with open(responses_path, "a") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")


def _record_failure(work_dir: Path, tag: str, detail: str) -> None:
    """Record a failed retrieval against the run, beside the artifacts it is about."""
    line = json.dumps({"at": time.time(), "tag": tag, "detail": detail})
    with open(work_dir / _FAILURES_FILE, "a") as f:
        f.write(line + "\n")
    logger.warning("work dir %s: retrieving the %s batch failed (%s)", work_dir, tag, detail)


def _attach_to_checkpoint(work_dir: Path, job: Any, by_stage: dict[str, dict[str, Any]]) -> dict[str, int]:
    """Merge reconciled stage answers into the checkpoint the run is parked at. Returns per-stage counts.

    Only ids the checkpoint has NO entry for are filled — see the module docstring on why a recorded
    answer is never overwritten. A run with no readable checkpoint attaches nothing here; its retrieved
    records are still on disk, where a re-run replays them for free.
    """
    ref = getattr(job, "checkpoint_ref", None)
    gate = getattr(job, "gate_position", None)
    if not ref or not gate:
        return {}
    path = work_dir.parent / ref if not Path(ref).is_absolute() else Path(ref)
    try:
        ckpt = load_checkpoint(path)
    except Exception as exc:  # noqa: BLE001 — an unreadable checkpoint is 08-08's loud-failure path, not ours
        logger.warning("run %s: checkpoint %s could not be read (%s) — records left on disk", job.job_id, path, exc)
        return {}
    merged = {stage: dict(answers) for stage, answers in ckpt.responses.items()}
    counts: dict[str, int] = {}
    for stage, answers in by_stage.items():
        target = merged.setdefault(stage, {})
        added = 0
        for pid, response in answers.items():
            if pid in target:
                continue
            target[pid] = response
            added += 1
        if added:
            counts[stage] = added
    if not counts:
        return {}
    write_checkpoint(
        work_dir,
        job_id=ckpt.job_id,
        gate=ckpt.gate,
        result=ckpt.result,
        responses=merged,
        realized_cost=ckpt.realized_cost,
    )
    return counts


def work_dir_for(job: Any, store: Any) -> Path:
    """A run's per-run work dir: ``<work_root>/<job_id>``, relative-to-root exactly like the checkpoint.

    Falls back to the absolute ``config["work_dir"]`` the run recorded only when there is no work root to
    resolve against, because an absolute path in a stored record does not survive a redeploy that moves
    the root (08-08's decision, and the same reasoning applies here).
    """
    root = getattr(store, "work_root", None)
    if root is not None:
        return Path(root) / job.job_id
    configured = (getattr(job, "config", None) or {}).get("work_dir")
    if configured:
        return Path(configured)
    raise WorkDirMissingError(f"run {job.job_id!r} has no work dir: no work root configured and no recorded path")


#: One lock per run, created on demand. See the module docstring: this serializes two IN-PROCESS callers
#: so the redundant work and the second version bump do not happen; it is not what makes the operation
#: idempotent, because a second process cannot see it. One small lock object per run that has ever had an
#: outstanding batch in this process — bounded by the runs on disk.
_run_locks: dict[str, threading.Lock] = {}
_run_locks_guard = threading.Lock()


def _lock_for(job_id: str) -> threading.Lock:
    with _run_locks_guard:
        return _run_locks.setdefault(job_id, threading.Lock())


def reconcile_run(
    job_id: str,
    *,
    store: Any,
    fetch: FetchFn | None = None,
    api_key: str | None = None,
) -> ReconcileOutcome:
    """Reconcile one run's outstanding batch submissions. THE entry point — every caller uses this one.

    Idempotent by construction (see the module docstring): the work is derived from the gap on disk, so a
    second call over a complete work dir fetches nothing, writes nothing and moves no version token.

    Raises :class:`WorkDirMissingError` when the run's work dir is absent, because reporting success there
    would mark unreachable paid work as recovered.
    """
    with _lock_for(job_id):
        return _reconcile_one(job_id, store=store, fetch=fetch, api_key=api_key)


def _reconcile_one(
    job_id: str,
    *,
    store: Any,
    fetch: FetchFn | None = None,
    api_key: str | None = None,
) -> ReconcileOutcome:
    """The body of :func:`reconcile_run`, run under that run's lock. Never call this directly."""
    from backend.jobs import _is_pinned

    fetch = fetch or _retrieve_via_core
    job = store.get(job_id)
    if job is None:
        return ReconcileOutcome(job_id=job_id, status="skipped", detail="unknown run")
    if _is_pinned(job):
        # The shared demo is immutable and holds nobody's paid work; it is also the only run an
        # unauthenticated caller can reach, so this is what keeps a guest read from touching an upstream.
        return ReconcileOutcome(job_id=job_id, status="skipped", detail="pinned run")

    work_dir = work_dir_for(job, store)
    if not work_dir.is_dir():
        raise WorkDirMissingError(f"run {job_id!r}: work dir {work_dir} is missing, so its batch output is unreachable")

    submissions = outstanding_submissions(work_dir)
    if not submissions:
        return ReconcileOutcome(job_id=job_id, status="noop", detail="no outstanding submission")

    by_stage: dict[str, dict[str, Any]] = {}
    pending: list[str] = []
    failed: list[str] = []
    fetches = 0
    for sub in submissions:
        fetches += 1
        result = fetch(sub.batch_id, manifest_path=sub.manifest_path, api_key=api_key)
        if result.status == "pending":
            pending.append(sub.tag)
            continue
        if result.status == "failed":
            failed.append(sub.tag)
            _record_failure(work_dir, sub.tag, result.detail or "retrieval failed")
            continue
        wanted = set(sub.missing)
        new_records = [r for r in result.records if str(r.get("id")) in wanted]
        if not new_records:
            # The batch ended and carried nothing for the gap. Recorded as a failure rather than a quiet
            # success: a stage short of the answers it was billed for must not look complete (T-08-58).
            failed.append(sub.tag)
            _record_failure(work_dir, sub.tag, result.detail or "batch ended without the missing responses")
            continue
        _append_records(sub.responses_path, new_records)
        stage_answers = by_stage.setdefault(sub.stage, {})
        for rec in new_records:
            stage_answers[str(rec["id"])] = rec.get("response")

    attached = _attach_to_checkpoint(work_dir, job, by_stage) if by_stage else {}
    if attached:
        # Exactly one version bump per reconcile that changed something (T-08-55), so a connected client
        # refetches once rather than on every tick of the sweep.
        store.mark_reconciled(job_id)

    status: ReconcileStatus = "noop"
    detail = ""
    if attached:
        status = "reconciled"
    if pending and not attached:
        status = "pending"
    if failed and not attached:
        status = "failed"
    if by_stage and not attached:
        # Everything retrieved was already recorded against the run. The records are on disk (a free future
        # replay) but nothing about the run changed, so this must NOT move the version token.
        status = "noop"
        detail = "retrieved records were already recorded against this run"
    outcome = ReconcileOutcome(
        job_id=job_id,
        status=status,
        attached=attached,
        pending=tuple(pending),
        failed=tuple(failed),
        fetches=fetches,
        detail=detail,
    )
    logger.info(
        "reconciled run %s: status=%s attached=%s pending=%s failed=%s",
        job_id,
        outcome.status,
        outcome.attached,
        outcome.pending,
        outcome.failed,
    )
    return outcome


def sweep(*, store: Any, fetch: FetchFn | None = None, api_key: str | None = None) -> list[ReconcileOutcome]:
    """Reconcile every run on the host that has an outstanding submission. Startup and interval both use this.

    Enumerated from the WORK ROOT rather than from job statuses, deliberately: a run whose row says
    ``error`` because its worker died mid-poll still has a paid, retrievable batch, and a status-based
    sweep would be exactly the sweep that misses it.

    Never raises. A sweep that unwound on one bad run would abandon every run after it, and this runs on
    the startup path.
    """
    root = getattr(store, "work_root", None)
    if root is None:
        return []
    root = Path(root)
    if not root.is_dir():
        return []
    outcomes: list[ReconcileOutcome] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        if not outstanding_submissions(entry):  # cheap disk check before touching the store
            continue
        try:
            outcomes.append(reconcile_run(entry.name, store=store, fetch=fetch, api_key=api_key))
        except Exception as exc:  # noqa: BLE001 — one unreconcilable run must not abandon the rest
            logger.warning("sweep: reconciling %s failed (%s: %s)", entry.name, type(exc).__name__, exc)
    changed = [o for o in outcomes if o.changed]
    if changed:
        logger.info("reconcile sweep attached late batch results to %d run(s)", len(changed))
    return outcomes


__all__ = [
    "RECONCILE_INTERVAL_SECONDS",
    "TAG_TO_STAGE",
    "FetchResult",
    "ReconcileOutcome",
    "Submission",
    "WorkDirMissingError",
    "outstanding_submissions",
    "reconcile_run",
    "sweep",
    "work_dir_for",
]
