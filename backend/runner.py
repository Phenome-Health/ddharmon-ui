"""Background pipeline runner — a thin shim over :func:`backend.engine.run_pipeline`.

Runs the harmonization adapter in a daemon thread and wires its ``(phase, completed, total)`` progress
callback to the in-memory :class:`~backend.jobs.JobStore`. ALL pipeline knowledge lives in
``backend.engine.adapter`` (the insulation boundary); this file only translates progress into job state
and catches failures so a worker thread never dies silently. The SSE endpoint polls ``Job.to_dict()``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from backend.checkpoint import checkpoint_path, write_checkpoint
from backend.engine import run_pipeline
from backend.engine.adapter import StageFn
from backend.jobs import JobStore

logger = logging.getLogger(__name__)


class RunCancelledError(Exception):
    """Raised from the progress callback when the user requested a stop, to unwind the pipeline promptly.

    Distinct from a real failure: the runner catches it and marks the job ``cancelled`` (not ``error``), so no
    new LLM work is issued past the current checkpoint. A Batch-API stage already SUBMITTED keeps running
    server-side — cancellation takes effect at the next stage boundary, not mid-batch (see the todo).
    """


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
    replay_responses: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Run a job to completion, reporting phase progress to ``store``. Safe to run in a thread.

    ``provider`` and ``stage_overrides`` are injected by tests to avoid any model download / LLM call.
    ``api_key`` is the optional per-request BYOK key (in-memory, this job only; never persisted).

    When ``config['gen_analysis_ideas']`` is set (the New Run "Suggest analysis ideas" toggle) and the run
    used an LLM (not preview), one extra pass generates the analysis ideas with the SAME model/provider/key
    the run used, so they're ready on the results page without a second key entry.

    ``replay_responses`` is a resumed leg's already-paid stage answers, read out of the previous gate's
    checkpoint and handed to the adapter so no prompt is bought twice.

    STAGED RUNS. When ``config['stop_at_gate']`` names a boundary, the adapter stops there and the result
    carries ``gatePosition``. This function then writes the checkpoint, parks the run at
    ``awaiting_review`` and **returns** — the worker thread ends. That exit IS the pause (08 D-01): a
    thread parked on a human for days is what this design exists to avoid.

    Note what this file still does not know: WHERE the boundaries are, or how to stop at one. It reads a
    gate position off the result and lands it. All pipeline knowledge stays in the adapter; a checkpoint
    model that sequenced stages from the runner is the named prior mistake this module's header warns of.
    """

    def progress(phase: str, completed: int = 0, total: int = 0, cost: float | None = None) -> None:
        # Cancellation at every phase/tick checkpoint. "discard" aborts here (raise -> the run unwinds with no
        # result). "keep" does NOT raise: the current stage finishes (delivering work already paid for) and the
        # engine's stage callbacks skip the remaining stages, so run_pipeline RETURNS a partial result below.
        if store.cancel_mode(job_id) == "discard":
            raise RunCancelledError
        fields: dict[str, Any] = {"status": phase, "phase": phase, "completed": completed, "total": total}
        # The LLM stages pass the run's realized cost-so-far (USD) after pricing their usage; fold it into the
        # job for the live "spent so far" counter. Pre-LLM phases call with 3 args (cost=None) -> not touched.
        if cost is not None:
            fields["cost_so_far"] = cost
        store.update(job_id, **fields)

    recorded: dict[str, dict[str, Any]] = {}
    # Recording every stage answer costs memory proportional to the run's LLM output, so it is done ONLY
    # for a staged leg — the one that has a later leg to hand them to. A one-shot run is unchanged, and its
    # call into run_pipeline carries neither new keyword.
    staged: dict[str, Any] = {}
    if config.get("stop_at_gate") or replay_responses is not None:
        staged["stage_responses"] = recorded
    if replay_responses:
        staged["replay_responses"] = replay_responses
    try:
        result = run_pipeline(
            dict_specs,
            cde_spec,
            config,
            progress=progress,
            provider=provider,
            stage_overrides=stage_overrides,
            api_key=api_key,
            stopping=lambda: store.cancel_mode(job_id),
            **staged,
        )
        # A plain dict view of the contract result. `UIResult` is a TypedDict, so it is not assignable to
        # `dict[str, Any]`; taking one copy here keeps the checkpoint writer and the ideas pass honest about
        # what they receive instead of casting at three call sites.
        payload: dict[str, Any] = dict(result)
        gate = payload.get("gatePosition")
        if gate and store.cancel_mode(job_id) is None:
            # Gate boundary. Shaped like the keep-partial branch below — deliver work already paid for and
            # stop — but the run is NOT terminal: it is parked, and pressing Continue spawns a fresh worker.
            # The payload goes to the per-run work dir, never into the jobs row (D-02): that row is
            # rewritten whole on every write, and a Gate 2 partial is megabytes.
            work_dir = Path(config.get("work_dir", "."))
            ckpt = write_checkpoint(
                work_dir,
                job_id=job_id,
                gate=gate,
                result=payload,
                responses=recorded,
                # The LEDGER's number, never a hardcoded per-stage guess: whatever stages actually ran to
                # reach this gate are what the reviewer is told they spent. Falls back to the live counter
                # for a result built without a ledger.
                realized_cost=float((payload.get("cost") or {}).get("actualUsd") or 0.0)
                or float(getattr(store.get(job_id), "cost_so_far", 0.0) or 0.0),
            )
            store.checkpoint(
                job_id,
                gate=gate,
                # RELATIVE to the work root, so the pointer survives a redeploy that moves it.
                checkpoint_ref=_relative_ref(store, job_id, ckpt.path or checkpoint_path(work_dir, gate)),
                realized_cost=ckpt.realized_cost,
            )
            logger.info("job %s paused at %s (%.4f USD realized)", job_id, gate, ckpt.realized_cost)
            return
        if store.cancel_mode(job_id) == "keep":
            # "Keep" stop: the pipeline finished the in-flight stage and skipped the rest, returning a PARTIAL
            # result. Mark the run cancelled but attach that result so the user gets what they paid for.
            store.update(job_id, status="cancelled", phase="cancelled", result=result)
            logger.info("job %s stopped (keep): %d partial records", job_id, len(result.get("records", [])))
            return
        fields: dict[str, Any] = {"status": "complete", "phase": "complete", "result": result}
        ideas = _generate_ideas(payload, config, api_key)  # None unless opted-in + produced
        if ideas is not None:
            fields["analysis_ideas"] = ideas
        store.update(job_id, **fields)
        logger.info("job %s complete: %d records", job_id, len(result["records"]))
    except RunCancelledError:
        # "Discard" stop: terminal but NOT an error, and NO result — the user chose to throw away in-flight
        # work. Leave error_message unset; the run stays re-runnable from its retained uploads.
        logger.info("job %s stopped (discard)", job_id)
        store.update(job_id, status="cancelled", phase="cancelled")
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI rather than crash the thread
        logger.exception("job %s failed", job_id)
        # Capture the stage the run was in BEFORE we overwrite phase to "error", so the UI / an error report
        # can name what broke (e.g. "assigning"). Ignore the non-stage sentinels.
        failing = store.get(job_id)
        failed_phase = failing.phase if failing and failing.phase not in ("error", "pending") else None
        store.update(job_id, status="error", phase="error", error_message=str(exc), failed_phase=failed_phase)


def _relative_ref(store: JobStore, job_id: str, path: Path) -> str:
    """The checkpoint pointer as stored: relative to the work root when possible, else ``<job_id>/<name>``.

    Never an absolute path. A redeploy that moves the work root would leave every stored pointer aimed at
    a directory the new process cannot see, and "your paid output is somewhere unreachable" is
    indistinguishable, from the UI, from "your paid output is gone".
    """
    root = store.work_root
    if root is not None:
        try:
            return path.resolve().relative_to(Path(root).resolve()).as_posix()
        except ValueError:  # the work dir is not under the root (tests, an explicit override)
            pass
    return f"{job_id}/{path.name}"


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
