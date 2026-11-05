"""The ONE place a paid action outside a worker leg is billed to its run (08-28 1a, live verify 3 F5).

A staged run's worker legs price their own stages into a seeded ledger (see the adapter's
``CumulativeLedger``). Several paid calls happen OUTSIDE a leg, though — the score-component extraction, a
re-adjudication re-split, a recode regeneration, a composite derivation, the analysis-ideas pass — and each
used to spend money that reached no figure anywhere: the run's ``costSoFar`` did not move, no ledger line
named it, and the next Continue's seed could not carry it. Every such route now hands its client (or its
captured usage) to :func:`bill_client` / :func:`bill_usage` under its own ledger key, and this module puts
the spend where the run's cumulative cost lives:

* **Parked at a gate** — into that gate's checkpoint (``result.cost`` + ``realizedCost``). The next Continue
  seeds its leg from that checkpoint, so the spend is carried into every later gate's figure.
* **Finished, payload in the row** (a legacy one-shot run) — into ``job.result["cost"]``.
* **A worker leg is running** — the checkpoint that leg will write has not been written yet, and the one it
  started from has already been read, so the bill waits in ``cost_pending.json`` beside them and the runner
  folds it into the next checkpoint it writes (:func:`take_pending`). Never lost, never counted twice.

In every case the job's live counter moves too, monotonically. The writes are made under the run's
:func:`~backend.checkpoint.checkpoint_lock`, the same lock Continue, the reconciler and the worker's park take,
so a bill can never land in a checkpoint that is being read as a seed or rewritten by someone else.

KEYS AND GATES. Each key is attributed to the gate it is pressed on by ``GATE_LEDGER_KEYS`` in
``frontend/src/lib/estimate.ts`` (pinned by test), which is what makes the spend appear in that gate's rail
figure rather than as unattributed money.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from backend.checkpoint import CheckpointMissingError, checkpoint_lock, load_checkpoint, write_checkpoint
from backend.engine.adapter import cost_block, merge_costs, usage_cost
from backend.engine.contract import UICost
from backend.jobs import AWAITING_REVIEW, TERMINAL_STATES, JobStore, _is_pinned

logger = logging.getLogger(__name__)

#: Gate 1 — the declared-score panel's "extract the components" (one paid model call, 08-16e).
SCORE_COMPONENTS = "score_components"
#: Gate 1 — "accept the division": the re-split of the groups a reviewer named.
READJUDICATE = "readjudicate"
#: Gate 3 — regenerating a record's member→GenCDE recodes after its GenCDE was edited (transform specs).
SPECS_REGEN = "specs_regen"
#: Gate 4 — deriving a composite score against the run's finished concepts (only a finished run has them).
COMPOSITE = "composite"
#: Gate 4 — "Explore analysis ideas", and the run's own opt-in ideas pass at the end of a finished run.
ANALYSIS_IDEAS = "analysis_ideas"

#: Every key this module bills under. Each must be claimed by a gate in the frontend's GATE_LEDGER_KEYS.
BILLING_KEYS: tuple[str, ...] = (SCORE_COMPONENTS, READJUDICATE, SPECS_REGEN, COMPOSITE, ANALYSIS_IDEAS)

#: Where a bill made while a worker leg is running waits for that leg's next checkpoint.
_PENDING_FILE = "cost_pending.json"


def drained(client: Any) -> list[Any]:
    """The usage a client has captured since its last drain, or ``[]`` for a client that captures none.

    Tolerant on purpose: a stub client in a test, or a provider client that reports no usage, prices to $0
    rather than failing the paid action it is attached to.
    """
    drain = getattr(client, "drain_usage", None)
    if not callable(drain):
        return []
    try:
        captured: Any = drain()
        return list(captured or [])
    except Exception:  # noqa: BLE001 — accounting must never fail the action it accounts for
        logger.warning("could not read a client's captured usage; this action is billed $0", exc_info=True)
        return []


def bill_client(store: JobStore, job_id: str, key: str, client: Any) -> float:
    """Bill whatever ``client`` has spent since its last drain to run ``job_id`` under ``key``. Returns USD."""
    return bill_usage(store, job_id, key, drained(client))


def bill_usage(store: JobStore, job_id: str, key: str, usages: Sequence[Any], *, batch: bool = False) -> float:
    """Price ``usages`` under ``key`` and add them to run ``job_id``'s cumulative cost. Returns the USD added."""
    if not usages:
        return 0.0
    cost = usage_cost(key, usages, batch=batch)
    record_cost(store, job_id, cost)
    return float(cost["actualUsd"])


def record_cost(store: JobStore, job_id: str, cost: Any, *, already_live: bool = False) -> None:
    """Add a cost block to wherever run ``job_id``'s cumulative cost lives (see the module docstring).

    ``already_live`` says the job's live counter has ALREADY counted this spend — true for a worker leg's own
    ledger, whose stages report their totals through progress as they go, so adding it again would count it
    twice. A paid route's bill is not live, so it also moves the counter.
    """
    block = cost_block(cost)
    usd = block["actualUsd"]
    if usd <= 0 and not block["perStage"]:
        return
    with checkpoint_lock(job_id):
        job = store.get(job_id)
        if job is None or _is_pinned(job):
            return
        bump = 0.0 if already_live else usd
        counter = float(job.cost_so_far or 0.0) + bump
        if job.status == AWAITING_REVIEW and job.checkpoint_ref:
            path = _checkpoint_file(store, job)
            try:
                ckpt = load_checkpoint(path)
            except CheckpointMissingError:
                # The parked state is unreadable (08-08's loud-failure path owns that). Keep the money on the
                # counter at least — never drop it for want of a file.
                logger.warning("run %s: billed %.4f USD but its checkpoint is unreadable; counter only", job_id, usd)
                store.update(job_id, cost_so_far=counter)
                return
            prior = cost_block(ckpt.result.get("cost"))
            total = max(ckpt.realized_cost, prior["actualUsd"]) + usd
            write_checkpoint(
                ckpt.path.parent if ckpt.path is not None else path.parent,
                job_id=ckpt.job_id,
                gate=ckpt.gate,
                result={**ckpt.result, "cost": merge_costs(prior, block)},
                responses=ckpt.responses,
                realized_cost=total,
            )
            # The payload changed (the rail reads its cost block), so the version token moves once.
            store.update(job_id, cost_so_far=max(counter, total), result_version=job.result_version + 1)
            return
        if job.status in TERMINAL_STATES:
            if job.result is not None:
                merged = merge_costs(job.result.get("cost"), block)
                store.update(
                    job_id, result={**job.result, "cost": merged}, cost_so_far=max(counter, merged["actualUsd"])
                )
            else:
                store.update(job_id, cost_so_far=counter)
            return
        # A worker leg is running: queue for the checkpoint it writes next (see take_pending).
        work_dir = _work_dir(store, job)
        if work_dir is not None:
            _write_pending(work_dir, merge_costs(_read_pending(work_dir), block))
        store.update(job_id, cost_so_far=counter)


def take_pending(work_dir: str | Path) -> UICost | None:
    """Remove and return the bills queued for a run while a leg was running, or ``None`` when there are none.

    Called by the worker, under the run's checkpoint lock, as it writes the checkpoint (or the finished result)
    the queued spend belongs in — so the queue is consumed by exactly the write that absorbs it.
    """
    path = Path(work_dir) / _PENDING_FILE
    pending = _read_pending(Path(work_dir))
    path.unlink(missing_ok=True)
    if pending is None or (pending["actualUsd"] <= 0 and not pending["perStage"]):
        return None
    return pending


def _checkpoint_file(store: JobStore, job: Any) -> Path:
    ref = Path(job.checkpoint_ref)
    if ref.is_absolute():
        return ref
    if store.work_root is not None:
        return Path(store.work_root) / ref
    return Path((job.config or {}).get("work_dir", ".")) / ref.name


def _work_dir(store: JobStore, job: Any) -> Path | None:
    """The directory the run's worker writes its checkpoints to — the same one :func:`take_pending` reads."""
    configured = (job.config or {}).get("work_dir")
    if configured:
        return Path(configured)
    if store.work_root is not None:
        return Path(store.work_root) / job.job_id
    return None


def _read_pending(work_dir: Path) -> UICost | None:
    path = work_dir / _PENDING_FILE
    if not path.exists():
        return None
    try:
        return cost_block(json.loads(path.read_text()))
    except (OSError, ValueError):
        logger.warning("unreadable pending cost file %s — treated as empty", path)
        return None


def _write_pending(work_dir: Path, cost: UICost) -> None:
    """Atomic, like the checkpoint write: a kill mid-write leaves the previous queue, not half of one."""
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / _PENDING_FILE
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(cost))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


__all__ = [
    "ANALYSIS_IDEAS",
    "BILLING_KEYS",
    "COMPOSITE",
    "READJUDICATE",
    "SCORE_COMPONENTS",
    "SPECS_REGEN",
    "bill_client",
    "bill_usage",
    "drained",
    "record_cost",
    "take_pending",
]
