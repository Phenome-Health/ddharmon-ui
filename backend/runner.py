"""Background pipeline runner — a thin shim over :func:`backend.engine.run_pipeline`.

Runs the harmonization adapter in a daemon thread and wires its ``(phase, completed, total)`` progress
callback to the in-memory :class:`~backend.jobs.JobStore`. ALL pipeline knowledge lives in
``backend.engine.adapter`` (the insulation boundary); this file only translates progress into job state
and catches failures so a worker thread never dies silently. The SSE endpoint polls ``Job.to_dict()``.
"""

from __future__ import annotations

import logging
from typing import Any

from backend.engine import run_pipeline
from backend.engine.adapter import StageFn
from backend.jobs import JobStore

logger = logging.getLogger(__name__)


def run_harmonization(
    store: JobStore,
    job_id: str,
    dict_specs: list[dict[str, Any]],
    cde_spec: dict[str, Any] | None,
    config: dict[str, Any],
    *,
    provider: Any | None = None,
    stage_overrides: dict[str, StageFn] | None = None,
    api_key: str | None = None,
) -> None:
    """Run a job to completion, reporting phase progress to ``store``. Safe to run in a thread.

    ``provider`` and ``stage_overrides`` are injected by tests to avoid any model download / LLM call.
    ``api_key`` is the optional per-request BYOK Anthropic key (in-memory, this job only; never persisted).
    """

    def progress(phase: str, completed: int = 0, total: int = 0) -> None:
        store.update(job_id, status=phase, phase=phase, completed=completed, total=total)

    try:
        result = run_pipeline(
            dict_specs,
            cde_spec,
            config,
            progress=progress,
            provider=provider,
            stage_overrides=stage_overrides,
            api_key=api_key,
        )
        store.update(job_id, status="complete", phase="complete", result=result)
        logger.info("job %s complete: %d records", job_id, len(result["records"]))
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI rather than crash the thread
        logger.exception("job %s failed", job_id)
        # Capture the stage the run was in BEFORE we overwrite phase to "error", so the UI / an error report
        # can name what broke (e.g. "assigning"). Ignore the non-stage sentinels.
        failing = store.get(job_id)
        failed_phase = failing.phase if failing and failing.phase not in ("error", "pending") else None
        store.update(job_id, status="error", phase="error", error_message=str(exc), failed_phase=failed_phase)
