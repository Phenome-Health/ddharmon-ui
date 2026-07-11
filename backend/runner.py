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
    ``api_key`` is the optional per-request BYOK key (in-memory, this job only; never persisted).

    When ``config['gen_analysis_ideas']`` is set (the New Run "Suggest analysis ideas" toggle) and the run
    used an LLM (not preview), one extra pass generates the analysis ideas with the SAME model/provider/key
    the run used, so they're ready on the results page without a second key entry.
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
        fields: dict[str, Any] = {"status": "complete", "phase": "complete", "result": result}
        ideas = _generate_ideas(result, config, api_key)  # None unless opted-in + produced
        if ideas is not None:
            fields["analysis_ideas"] = ideas
        store.update(job_id, **fields)
        logger.info("job %s complete: %d records", job_id, len(result["records"]))
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI rather than crash the thread
        logger.exception("job %s failed", job_id)
        # Capture the stage the run was in BEFORE we overwrite phase to "error", so the UI / an error report
        # can name what broke (e.g. "assigning"). Ignore the non-stage sentinels.
        failing = store.get(job_id)
        failed_phase = failing.phase if failing and failing.phase not in ("error", "pending") else None
        store.update(job_id, status="error", phase="error", error_message=str(exc), failed_phase=failed_phase)


def _generate_ideas(result: dict[str, Any], config: dict[str, Any], api_key: str | None) -> list[dict[str, Any]] | None:
    """Generate "analysis ideas" as part of the run when opted in — using the SAME model/provider/key the
    run used (via :func:`backend.engine.llm.build_llm_client`), so the results page has them with no second
    key entry. Returns the ideas list (possibly empty), or None when skipped/failed.

    Non-fatal by design: a preview run (no LLM), an opted-out run, a run with no records, or any error here
    just yields None — the harmonization still completes, and the user can generate on-demand later.
    """
    if not config.get("gen_analysis_ideas") or config.get("run_mode") == "preview":
        return None
    records = result.get("records") or []
    if not records:
        return None
    try:
        from backend.analysis_ideas import generate_analysis_ideas
        from backend.engine.llm import build_llm_client

        client = build_llm_client(config.get("model_tag"), api_key)
        return generate_analysis_ideas(records, client.complete)["ideas"]
    except Exception:  # noqa: BLE001 — analysis ideas are a bonus; never fail the run over them
        logger.warning("analysis-ideas generation failed (non-fatal)", exc_info=True)
        return None
