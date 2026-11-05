"""Background pipeline runner — a thin shim over :func:`backend.engine.run_pipeline`.

Runs the harmonization adapter in a daemon thread and wires its ``(phase, completed, total)`` progress
callback to the in-memory :class:`~backend.jobs.JobStore`. ALL pipeline knowledge lives in
``backend.engine.adapter`` (the insulation boundary); this file only translates progress into job state
and catches failures so a worker thread never dies silently. The SSE endpoint polls ``Job.to_dict()``.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from backend import billing
from backend.checkpoint import checkpoint_lock, checkpoint_path, write_checkpoint
from backend.engine import run_pipeline
from backend.engine.adapter import CumulativeLedger, LegTransport, StageFn, cost_block, merge_costs
from backend.jobs import AWAITING_REVIEW, GATE_DECIDED_BY_CONFIG_KEY, JobStore, is_auto

logger = logging.getLogger(__name__)

#: OPERATOR-ONLY (08-28 0e): once a batch stage has waited this many seconds, switch the leg to sync — the same
#: flag a reviewer's "Finish now with sync" raises. For the verification loop, which cannot sit in a provider
#: queue for an hour per iteration. Read from the SERVER's environment and never from a run's config: a run's
#: config is user-submitted, and a user-settable timer that re-buys queued work at twice the price is a spend
#: path nobody consented to. Unset, empty, non-numeric or <= 0 means OFF, which is the default.
BATCH_PATIENCE_ENV = "DDHARMON_BATCH_PATIENCE_SECONDS"


def batch_patience_seconds() -> float | None:
    """The operator's batch patience, or ``None`` (off)."""
    raw = os.environ.get(BATCH_PATIENCE_ENV, "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number of seconds — batch patience stays off", BATCH_PATIENCE_ENV, raw)
        return None
    return value if value > 0 else None


class RunCancelledError(Exception):
    """Raised from the progress callback when the user requested a stop, to unwind the pipeline promptly.

    Distinct from a real failure: the runner catches it and marks the job ``cancelled`` (not ``error``), so no
    new LLM work is issued past the current checkpoint. A Batch-API stage already SUBMITTED keeps running
    server-side — cancellation takes effect at the next stage boundary, not mid-batch (see the todo).
    """


#: What Full auto calls after a leg parks (08-30): ``advance(job_id, api_key)``. The app passes its own continue
#: function — the one the Continue route uses — so the runner never learns how a gate is committed.
AutoAdvance = Callable[[str, "str | None"], None]


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
    prior_cost: dict[str, Any] | None = None,
    auto_advance: AutoAdvance | None = None,
) -> None:
    """Run one leg (see :func:`_run_leg`), then — on a Full-auto run that parked cleanly — continue it.

    ``auto_advance`` is handed in only for a Full-auto leg (08-30). It runs AFTER the leg is wholly over (its
    ``finally`` included), so the next leg's worker can never race this one's teardown; it starts that worker
    and returns, so each leg still owns exactly one thread and none blocks on another. The key it is given is
    this leg's own in-memory ``api_key`` — handed from leg to leg, never written anywhere.

    A leg that was stopped, failed or finished does not park for an advance, so nothing continues it: Stop and
    a failure end Full auto exactly where they end a guided leg.
    """
    will_advance = auto_advance is not None and is_auto(config)
    parked = _run_leg(
        store,
        job_id,
        dict_specs,
        cde_spec,
        config,
        provider=provider,
        stage_overrides=stage_overrides,
        api_key=api_key,
        replay_responses=replay_responses,
        prior_cost=prior_cost,
        advance_after_park=will_advance,
    )
    if parked and auto_advance is not None:
        try:
            auto_advance(job_id, api_key)
        except Exception:  # noqa: BLE001 — the advance owns its own failure reporting; never kill the thread
            logger.exception("job %s: Full auto could not continue past its gate", job_id)


def _run_leg(
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
    prior_cost: dict[str, Any] | None = None,
    advance_after_park: bool = False,
) -> bool:
    """Run a job to completion, reporting phase progress to ``store``. Safe to run in a thread.

    Returns True only when the leg parked at a gate FOR FULL AUTO TO CONTINUE (``advance_after_park`` and no
    stop raced the park) — the one case :func:`run_harmonization` goes on from.

    ``provider`` and ``stage_overrides`` are injected by tests to avoid any model download / LLM call.
    ``api_key`` is the optional per-request BYOK key (in-memory, this job only; never persisted).

    When ``config['gen_analysis_ideas']`` is set (the New Run "Suggest analysis ideas" toggle) and the run
    used an LLM (not preview), one extra pass generates the analysis ideas with the SAME model/provider/key
    the run used, so they're ready on the results page without a second key entry.

    ``replay_responses`` is a resumed leg's already-paid stage answers, read out of the previous gate's
    checkpoint and handed to the adapter so no prompt is bought twice.

    ``prior_cost`` is that checkpoint's ``cost`` block. It seeds the leg's ledger, so the live counter and the
    checkpoint this leg writes carry the RUN's cumulative spend, never one leg's share (08-28 1a, F14). The
    ledger is built HERE and handed to the adapter, so that what a leg bought before it failed can still be
    read afterwards and kept on the parked run's bill. Bills made by paid routes while this leg ran (queued by
    :mod:`backend.billing`) are folded into whatever this leg writes last — its checkpoint or its result.

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
        # The store keeps it monotonic (max with what the job already shows), so a figure below what the run
        # has been charged can never rewind the counter.
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
    # The leg's ledger, seeded with every earlier leg's spend (08-28 1a). Owned here rather than inside the
    # adapter so the failure branches below can still read what this leg bought.
    leg_ledger = CumulativeLedger(prior_cost)
    if staged:
        staged["ledger"] = leg_ledger
    work_dir = Path(config.get("work_dir", "."))
    # The leg's batch -> sync switch (08-28 0e). ONE per leg, built here like the ledger: a switch is sticky for
    # the leg it was pressed in, and the next leg — a fresh worker, a fresh transport, the run's flag reset — is a
    # fresh cost decision. Only a batch leg has a batch to switch away from, so only it is handed one.
    mode = config.get("run_mode", "batch")
    store.reset_transport(job_id, mode if mode in ("batch", "sync") else None)
    leg: dict[str, Any] = {}
    if mode == "batch":
        leg["transport"] = LegTransport(
            requested=lambda: store.switch_requested(job_id),
            report=lambda transport, batch: store.set_transport(job_id, transport, batch),
            patience_seconds=batch_patience_seconds(),
        )
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
            **leg,
        )
        # A plain dict view of the contract result. `UIResult` is a TypedDict, so it is not assignable to
        # `dict[str, Any]`; taking one copy here keeps the checkpoint writer and the ideas pass honest about
        # what they receive instead of casting at three call sites.
        payload: dict[str, Any] = dict(result)
        if store.cancel_mode(job_id) == "discard":
            # A discard pressed after the leg's LAST progress tick: the pipeline never got to raise, and returned
            # normally. "Discard" still means no result — so it ends here exactly as a raised one does, never as a
            # completed (or parked) run, and never with the paid ideas pass a completed run would then buy.
            raise RunCancelledError
        gate = payload.get("gatePosition")
        if gate and store.cancel_mode(job_id) is None:
            # Gate boundary. Shaped like the keep-partial branch below — deliver work already paid for and
            # stop — but the run is NOT terminal: it is parked, and pressing Continue spawns a fresh worker.
            # The payload goes to the per-run work dir, never into the jobs row (D-02): that row is
            # rewritten whole on every write, and a Gate 2 partial is megabytes.
            #
            # Under the run's checkpoint lock, so a paid route billing this run cannot slip a bill between the
            # queue being absorbed and the run being parked (it then lands in THIS checkpoint instead).
            with checkpoint_lock(job_id):
                _absorb_pending(payload, work_dir)
                ckpt = write_checkpoint(
                    work_dir,
                    job_id=job_id,
                    gate=gate,
                    result=payload,
                    responses=recorded,
                    # The LEDGER's number, never a hardcoded per-stage guess: whatever stages actually ran to
                    # reach this gate — in THIS leg and every earlier one (the ledger is seeded) — are what the
                    # reviewer is told they spent. Falls back to the live counter for a result with no ledger.
                    realized_cost=float((payload.get("cost") or {}).get("actualUsd") or 0.0)
                    or float(getattr(store.get(job_id), "cost_so_far", 0.0) or 0.0),
                )
                store.checkpoint(
                    job_id,
                    gate=gate,
                    # RELATIVE to the work root, so the pointer survives a redeploy that moves it.
                    checkpoint_ref=_relative_ref(store, job_id, ckpt.path or checkpoint_path(work_dir, gate)),
                    realized_cost=ckpt.realized_cost,
                    # Full auto (08-30): parked only until the server continues it. A stop that raced this park
                    # keeps the flag down (see JobStore.checkpoint), so the run stays parked as a guided one would.
                    **({"auto_advance": True} if advance_after_park else {}),
                )
                parked_for_advance = bool(advance_after_park and getattr(store.get(job_id), "auto_advance", False))
            logger.info("job %s paused at %s (%.4f USD realized)", job_id, gate, ckpt.realized_cost)
            return parked_for_advance
        if store.cancel_mode(job_id) == "keep":
            # "Keep" stop: the pipeline finished the in-flight stage and skipped the rest, returning a PARTIAL
            # result. Mark the run cancelled but attach that result so the user gets what they paid for.
            with checkpoint_lock(job_id):
                _absorb_pending(payload, work_dir)
                store.update(job_id, status="cancelled", phase="cancelled", result=payload, cost_so_far=_total(payload))
            logger.info("job %s stopped (keep): %d partial records", job_id, len(result.get("records", [])))
            return False
        # None unless opted-in + produced. Its spend is billed while this worker still owns the run, so it is
        # queued and folded into the finished result's cost just below.
        ideas = _generate_ideas(payload, config, api_key, store=store, job_id=job_id)
        with checkpoint_lock(job_id):
            _absorb_pending(payload, work_dir)
            # The counter ends on the result's own (cumulative) figure; the store keeps it monotonic.
            fields: dict[str, Any] = {
                "status": "complete",
                "phase": "complete",
                "result": payload,
                "cost_so_far": _total(payload),
            }
            if ideas is not None:
                fields["analysis_ideas"] = ideas
            store.update(job_id, **fields)
        logger.info("job %s complete: %d records", job_id, len(result["records"]))
    except RunCancelledError:
        # "Discard" stop: terminal but NOT an error, and NO result — the user chose to throw away in-flight
        # work. Leave error_message unset; the run stays re-runnable from its retained uploads.
        logger.info("job %s stopped (discard)", job_id)
        store.update(job_id, status="cancelled", phase="cancelled")
        _keep_leg_spend(store, job_id, leg_ledger, work_dir)
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI rather than crash the thread
        logger.exception("job %s failed", job_id)
        # Capture the stage the run was in BEFORE we overwrite phase to "error", so the UI / an error report
        # can name what broke (e.g. "assigning"). Ignore the non-stage sentinels.
        failing = store.get(job_id)
        failed_phase = failing.phase if failing and failing.phase not in ("error", "pending") else None
        # A RESUMED leg (replay_responses given) still has its prior gate's checkpoint on disk and its
        # gate_position/checkpoint_ref unchanged. A failed continue must NOT flip to a terminal `error` — that
        # hides the served gate (/result) and blocks `resume` (409), which is what forced a manual jobs.db
        # status flip in the live test. Leave the run PARKED at its last good gate, recording the failure via
        # error_message as "the last continue failed — retry". A FIRST leg (no replay) has no prior gate to
        # fall back to, so it still errors as before.
        if replay_responses is not None and failing and failing.gate_position and failing.checkpoint_ref:
            store.update(
                job_id,
                status=AWAITING_REVIEW,
                phase=AWAITING_REVIEW,
                error_message=str(exc),
                failed_phase=failed_phase,
                **_undo_auto_commit(failing.config, failing.gate_position),
            )
        else:
            store.update(job_id, status="error", phase="error", error_message=str(exc), failed_phase=failed_phase)
        _keep_leg_spend(store, job_id, leg_ledger, work_dir)
    finally:
        # The leg is over, however it ended: its switch and its in-flight batch end with it.
        store.reset_transport(job_id)
    return False


def _undo_auto_commit(config: dict[str, Any] | None, gate: str) -> dict[str, Any]:
    """The config write that takes ``gate`` back out of the auto-committed set, or nothing.

    A Full-auto leg that FAILS leaves the run parked back at the gate it started from (as any failed continue
    does). That gate's commit did not take, so it must not keep reading "auto-accepted" while the run waits there
    for a person. A run with no such record — every guided run — gets no config write at all.
    """
    decided = (config or {}).get(GATE_DECIDED_BY_CONFIG_KEY)
    if not isinstance(decided, dict) or gate not in decided:
        return {}
    kept = {g: v for g, v in decided.items() if g != gate}
    return {"config": {**(config or {}), GATE_DECIDED_BY_CONFIG_KEY: kept}}


def _total(payload: dict[str, Any]) -> float:
    """The run total a payload's cost block states (0 when it carries none)."""
    return float(cost_block(payload.get("cost"))["actualUsd"])


def _absorb_pending(payload: dict[str, Any], work_dir: Path) -> None:
    """Fold bills queued while this leg ran into the payload's cost block. Caller holds the checkpoint lock."""
    pending = billing.take_pending(work_dir)
    if pending is not None:
        payload["cost"] = merge_costs(payload.get("cost"), pending)


def _keep_leg_spend(store: JobStore, job_id: str, ledger: CumulativeLedger, work_dir: Path) -> None:
    """Keep what a leg that did not finish had already bought — plus any bill queued for it — on the run.

    A failed resumed leg stays parked at its old gate, so this lands in that gate's checkpoint and the retry's
    seed includes it; a first leg that errored has no checkpoint, so only the counter holds it. Both were
    already reported live (the stages' progress and the queue both moved the counter), so the counter is not
    bumped a second time. Never raises: this runs on the failure path.
    """
    try:
        with checkpoint_lock(job_id):
            spent = merge_costs(ledger.leg_cost(), billing.take_pending(work_dir))
            billing.record_cost(store, job_id, spent, already_live=True)
    except Exception:  # noqa: BLE001 — accounting must not mask the failure being reported
        logger.warning("job %s: could not keep the failed leg's spend on the run", job_id, exc_info=True)


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


def _generate_ideas(
    result: dict[str, Any],
    config: dict[str, Any],
    api_key: str | None,
    *,
    store: JobStore | None = None,
    job_id: str | None = None,
) -> list[dict[str, Any]] | None:
    """Generate "analysis ideas" as part of the run when opted in — using the SAME model/provider/key the
    run used (via :func:`backend.engine.llm.build_llm_client`), so the results page has them with no second
    key entry. Returns the ideas list (possibly empty), or None when skipped/failed.

    Non-fatal by design: a preview run (no LLM), an opted-out run, a run with no records, or any error here
    just yields None — the harmonization still completes, and the user can generate on-demand later.

    It is a paid call, so with ``store``/``job_id`` its spend is billed to the run (08-28 1a) — even when the
    reply could not be used, because the call was still charged.
    """
    if not config.get("gen_analysis_ideas") or config.get("run_mode") == "preview":
        return None
    records = result.get("records") or []
    if not records:
        return None
    client: Any = None
    try:
        from backend.analysis_ideas import generate_analysis_ideas
        from backend.engine.llm import build_llm_client

        client = build_llm_client(config.get("model_tag"), api_key)
        return generate_analysis_ideas(records, client.complete)["ideas"]
    except Exception:  # noqa: BLE001 — analysis ideas are a bonus; never fail the run over them
        logger.warning("analysis-ideas generation failed (non-fatal)", exc_info=True)
        return None
    finally:
        if store is not None and job_id is not None and client is not None:
            billing.bill_client(store, job_id, billing.ANALYSIS_IDEAS, client)
