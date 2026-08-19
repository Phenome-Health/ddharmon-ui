"""Durable per-run stage output for the staged review gates — the persistence half of D-01/D-02.

A staged run does not BLOCK on the reviewer; it **exits** (D-01). So durability is the mechanism the
staged flow is built out of, not a feature bolted onto it: between the worker exiting at a gate and the
reviewer coming back — minutes, days, or a redeploy later — the only thing that carries the run is what
was written to disk here.

**Where it lives, and why not the jobs row (D-02).** ``JobDB.upsert`` rewrites the WHOLE row on every
write, including a ``json.dumps`` of ``result``. A run's stage output is megabytes (the shipped demo's
result blob is 6.8 MB), so parking it in the row makes every subsequent progress write copy it. The row
therefore carries only the gate position and a *pointer*; the payload lands on the per-run work dir that
already holds the frozen clustering substrate and the prompt/response jsonl files. Two precedents, one
directory.

**The pointer is stored RELATIVE to the work root.** An absolute path in a database row does not survive
a redeploy that moves the work root — and "the checkpoint file is somewhere the new container cannot see"
is indistinguishable, from the UI, from "the run's paid output is gone".

**Rehydrate is a pure read that FAILS LOUDLY** (T-08-43). Every failure mode — absent file, truncated
write, structurally-valid JSON that is not a checkpoint — raises :class:`CheckpointMissingError` naming
the artifact. Returning a partially-filled run instead would show the reviewer a Gate 1 with fewer concept
groups than they scoped, with nothing anywhere saying something was lost.

**The write is atomic.** A temp file in the same directory plus ``os.replace``, so a kill mid-write leaves
the PREVIOUS checkpoint intact rather than a half-truncated one.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: The six screens, in order. A gate position is a *closed* vocabulary — the same set the contract's
#: ``GatePosition`` literal declares — so a typo can never name a boundary that does not exist.
GATE_ORDER: tuple[str, ...] = ("setup", "gate0", "gate1", "gate2", "gate3", "gate4")

#: Filename stem for a gate's checkpoint inside the per-run work dir. Mirrors the adapter's
#: ``prompts_<tag>.jsonl`` / ``responses_<tag>.jsonl`` layout: one file per stage-ish unit, named for it.
_FILENAME = "checkpoint_{gate}.json"

#: Keys a file must carry to be a checkpoint at all. A structurally-valid JSON object missing any of them
#: is a *missing artifact*, not a usable run — see the module docstring.
_REQUIRED = ("jobId", "gate", "result", "writtenAt")


class CheckpointMissingError(RuntimeError):
    """A checkpoint could not be read as a whole. Always names the artifact it was looking for.

    Deliberately ONE error type for absent / truncated / malformed. The caller's recovery is identical in
    all three cases (tell the reviewer the run's saved state could not be read, do not pretend to resume),
    and splitting them would invite a handler that treats "truncated" as "empty".
    """


@dataclass(frozen=True)
class Checkpoint:
    """One gate's persisted state. Immutable: a rehydrated checkpoint is evidence, not working state."""

    job_id: str
    gate: str
    #: The contract-shaped partial result the gate renders (``conceptGroups`` at Gate 1, records later).
    result: dict[str, Any]
    #: ``{stage_name: {prompt_id: response}}`` for every stage that has ALREADY been paid for. The resume
    #: leg answers those prompt ids from here and calls the provider only for genuinely new ones, which is
    #: what makes "no re-charge for work already done" a property of the code rather than of a cache.
    responses: dict[str, dict[str, Any]] = field(default_factory=dict)
    realized_cost: float = 0.0
    written_at: float = 0.0
    path: Path | None = None


def next_gate(gate: str) -> str | None:
    """The gate a Continue at ``gate`` advances to, or ``None`` at the terminal gate."""
    if gate not in GATE_ORDER:
        raise ValueError(f"unknown gate {gate!r}; expected one of {GATE_ORDER}")
    i = GATE_ORDER.index(gate)
    return GATE_ORDER[i + 1] if i + 1 < len(GATE_ORDER) else None


def checkpoint_path(work_dir: str | Path, gate: str) -> Path:
    """Where ``gate``'s checkpoint lives inside a run's work dir."""
    if gate not in GATE_ORDER:
        raise ValueError(f"unknown gate {gate!r}; expected one of {GATE_ORDER}")
    return Path(work_dir) / _FILENAME.format(gate=gate)


def write_checkpoint(
    work_dir: str | Path,
    *,
    job_id: str,
    gate: str,
    result: dict[str, Any],
    responses: dict[str, dict[str, Any]] | None = None,
    realized_cost: float = 0.0,
) -> Checkpoint:
    """Persist one gate's stage output atomically, and return what is now on disk.

    Returns the :class:`Checkpoint` rather than the path (or a bool) for the same reason
    ``JobDB.upsert_artifact`` does: the defect this replaces is a writer that reports success for a write
    it dropped.
    """
    path = checkpoint_path(work_dir, gate)
    path.parent.mkdir(parents=True, exist_ok=True)
    ckpt = Checkpoint(
        job_id=job_id,
        gate=gate,
        result=result,
        responses=responses or {},
        realized_cost=float(realized_cost),
        written_at=time.time(),
        path=path,
    )
    body = json.dumps(
        {
            "jobId": ckpt.job_id,
            "gate": ckpt.gate,
            "result": ckpt.result,
            "responses": ckpt.responses,
            "realizedCost": ckpt.realized_cost,
            "writtenAt": ckpt.written_at,
        }
    )
    # Same directory as the target, so os.replace is a rename within one filesystem (hence atomic).
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(body)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    logger.info("job %s checkpointed at %s (%.4f USD realized)", job_id, gate, ckpt.realized_cost)
    return ckpt


def load_checkpoint(path: str | Path) -> Checkpoint:
    """Read a checkpoint by path. Raises :class:`CheckpointMissingError` naming ``path`` on any failure."""
    p = Path(path)
    try:
        raw = json.loads(p.read_text())
    except FileNotFoundError as exc:
        raise CheckpointMissingError(f"no checkpoint at {p}") from exc
    except (OSError, ValueError) as exc:  # truncated / unreadable — NOT an empty run
        raise CheckpointMissingError(f"checkpoint at {p} could not be read: {exc}") from exc
    if not isinstance(raw, dict):
        raise CheckpointMissingError(f"checkpoint at {p} is not a checkpoint object")
    missing = [k for k in _REQUIRED if k not in raw]
    if missing:
        raise CheckpointMissingError(f"checkpoint at {p} is missing {', '.join(missing)}")
    return Checkpoint(
        job_id=str(raw["jobId"]),
        gate=str(raw["gate"]),
        result=raw["result"] or {},
        responses=raw.get("responses") or {},
        realized_cost=float(raw.get("realizedCost") or 0.0),
        written_at=float(raw["writtenAt"]),
        path=p,
    )


def read_checkpoint(work_dir: str | Path, gate: str) -> Checkpoint:
    """Read ``gate``'s checkpoint out of a run's work dir. See :func:`load_checkpoint` for the failure mode."""
    return load_checkpoint(checkpoint_path(work_dir, gate))


def has_checkpoint(work_dir: str | Path, gate: str) -> bool:
    """Whether ``gate``'s checkpoint file exists. Presence only — say nothing about readability."""
    return checkpoint_path(work_dir, gate).exists()
