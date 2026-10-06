"""Precomputed demo runs — load a real harmonization result without spending API credits.

A demo is a run we computed once (offline, via ``scripts/build_demos.py``) and shipped as a JSON
snapshot under ``backend/demos/``. The frontend offers the curated demo cohorts as checkboxes; when a
selection matches a precomputed combo, the backend hydrates a *completed* job straight from the
snapshot — no pipeline, no LLM, no key. ``manifest.json`` lists the datasets and which combos exist.

TWO SNAPSHOT SHAPES (08-30). A FINISHED snapshot (``result`` only) seeds a completed run, as it always has. A
STAGED snapshot (``staged: true``) is a Full-auto run parked at Gate 4 together with the result each gate showed —
``checkpoints`` for Gates 1-3 and ``result`` for Gate 4 — and seeds a PINNED run parked at Gate 4 with those four
checkpoints on its work dir. That is the demo P8-D4 asks for: built by Full auto, walked by a guest gate by gate on
the shipped sandbox (pinned runs are immutable server-side; edits live in the guest's tab), never written to.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.jobs import JobStore

logger = logging.getLogger(__name__)

#: The gates a staged demo ships a checkpoint for besides its result (Gate 4's checkpoint IS the result).
STAGED_GATES = ("gate1", "gate2", "gate3")
#: The gate a staged demo is parked at — the end of the walk, where every gate behind it is reachable.
STAGED_DEMO_GATE = "gate4"

#: The run-config keys a staged demo keeps from the run it was built from: what its gate screens read (the review
#: mode and who decided each gate, Gate 1's frozen scope and regrouping) and what describes how it was run. An
#: ALLOW-list, so anything that names the machine it was built on (``work_dir``) or that only a live run uses can
#: never reach the shipped file by default.
DEMO_CONFIG_KEYS = (
    "run_mode",
    "cde_set",
    "review_mode",
    "gate_decided_by",
    "gate1_scope",
    "gate1_overrides",
    "gen_transform_specs",
    "concept_gate",
    "readjudication",
    "preprocess",
    "est_fields",
    "est_cohorts",
    "model_tag",
    "min_cluster_size",
    "top_k",
    "retrieval_floor",
)

_DIR = Path(__file__).resolve().parent / "demos"
_MANIFEST = _DIR / "manifest.json"
# Pre-generated "analysis ideas" per demo, keyed by snapshot filename (a small sidecar so the multi-MB
# snapshots stay untouched). Built offline by ``scripts/build_demo_analysis_ideas.py`` with the SAME
# generator the live feature uses; surfaced on the seeded demo job so a guest sees them without an LLM call.
_IDEAS = _DIR / "analysis_ideas.json"


def _load_manifest() -> dict[str, Any]:
    if not _MANIFEST.exists():
        return {"datasets": [], "combos": []}
    return json.loads(_MANIFEST.read_text())


def _load_demo_ideas() -> dict[str, Any]:
    """Snapshot-filename -> pre-generated analysis ideas (empty when the sidecar is absent)."""
    if not _IDEAS.exists():
        return {}
    try:
        return json.loads(_IDEAS.read_text())
    except (ValueError, OSError):
        return {}


def _key(datasets: list[str]) -> tuple[str, ...]:
    return tuple(sorted(str(d).lower() for d in datasets))


def is_staged(snapshot: dict[str, Any] | None) -> bool:
    """Whether a snapshot is a staged (gate-by-gate) demo rather than a finished-run one."""
    return bool(snapshot and snapshot.get("staged"))


def staged_snapshot(
    *,
    ids: list[str],
    display_name: str,
    config: dict[str, Any],
    checkpoints: dict[str, dict[str, Any]],
    core_version: str | None = None,
    realized_cost: float = 0.0,
) -> dict[str, Any]:
    """The shipped form of a run parked at Gate 4: each gate's result, and nothing else of the run's state.

    ``checkpoints`` maps ``gate1``..``gate4`` to the RESULT each checkpoint holds. Raw stage answers are not taken
    (they are resume fuel, and a pinned demo never resumes), the config passes through :data:`DEMO_CONFIG_KEYS`,
    and Gate 4's result is stamped ``gatePosition: gate4`` — it is Gate 3's carried forward by the pure read, and a
    reader of the file alone should see the gate it is shown at.
    """
    missing = [g for g in (*STAGED_GATES, STAGED_DEMO_GATE) if g not in checkpoints]
    if missing:
        raise ValueError(f"a staged demo needs every gate's checkpoint; missing {missing}")
    result = {**checkpoints[STAGED_DEMO_GATE], "gatePosition": STAGED_DEMO_GATE}
    return {
        "displayName": display_name,
        "datasets": sorted(ids),
        "staged": True,
        "isDemo": True,
        "mode": result.get("mode"),
        "cdeSet": config.get("cde_set"),
        "coreVersion": core_version,
        "realizedCost": float(realized_cost),
        "config": {k: config[k] for k in DEMO_CONFIG_KEYS if k in config},
        "checkpoints": {g: checkpoints[g] for g in STAGED_GATES},
        "result": result,
    }


def list_demos() -> dict[str, Any]:
    """Datasets + combos for the picker; each combo flagged with whether its snapshot is present.

    ``coreVersion`` (stamped by ``scripts/build_demos.py`` into the manifest) is the ddharmon release the
    demo snapshots reflect — surfaced so the demo page can note it (prod lags dev, so its demo may predate
    features already live on dev).
    """
    man = _load_manifest()
    combos = []
    for c in man.get("combos", []):
        available = (_DIR / c["snapshot"]).exists()
        # `staged` tells the demo page to open Gate 1 rather than a results page. The manifest's own flag (the
        # builder writes it) answers without reading a multi-megabyte snapshot; failing that, the snapshot's.
        staged = bool(c.get("staged")) or (available and is_staged(_peek(_DIR / c["snapshot"])))
        combos.append({**c, "available": available, "staged": staged})
    return {"datasets": man.get("datasets", []), "combos": combos, "coreVersion": man.get("coreVersion")}


def _peek(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def load_snapshot(datasets: list[str]) -> dict[str, Any] | None:
    """Return the precomputed snapshot wrapper ({displayName, datasets, result}) for a selection."""
    man = _load_manifest()
    want = _key(datasets)
    for combo in man.get("combos", []):
        if _key(combo["datasets"]) == want:
            snap = _DIR / combo["snapshot"]
            if snap.exists():
                return json.loads(snap.read_text())
    return None


def demo_job_id(datasets: list[str]) -> str:
    """The stable per-combo job id (matches ``POST /demo`` + the static client): ``demo-<sorted datasets>``."""
    return "demo-" + "_".join(sorted(str(d).lower() for d in datasets))


def seed_demos(store: JobStore) -> list[str]:
    """Prepopulate ``store`` with every available precomputed demo as a COMPLETE run — so the Runs page is
    never empty on a fresh boot. Idempotent (skips a demo already present, e.g. a live replay in progress).
    Returns the seeded job ids.

    This is what makes the demo *prepopulated + durable*: re-seeded on every startup (a restart restores it),
    tagged ``demo: True`` so :meth:`JobStore.purge_expired` never evicts it, and keyed by the same stable id
    (:func:`demo_job_id`) the demo page deep-links to for "skip to results".
    """
    ids: list[str] = []
    ideas_by_snapshot = _load_demo_ideas()
    for combo in list_demos().get("combos", []):
        if not combo.get("available"):
            continue
        datasets = combo["datasets"]
        snap = load_snapshot(datasets)
        if snap is None:
            continue
        job_id = demo_job_id(datasets)
        if store.get(job_id) is not None:
            continue  # already present — don't clobber a seeded run or an in-flight replay
        # Pre-generated ideas (sidecar keyed by snapshot filename, else inline on the snapshot) → the demo
        # shows them without an LLM call. Absent → the panel just offers "generate" as for a real run.
        ideas = ideas_by_snapshot.get(combo["snapshot"]) or snap.get("analysisIdeas")
        if seed_snapshot(store, job_id, snap, ideas=ideas):
            ids.append(job_id)
    return ids


def seed_snapshot(store: JobStore, job_id: str, snap: dict[str, Any], *, ideas: Any = None) -> bool:
    """Seed ONE demo snapshot as ``job_id`` — a completed run, or (staged) a pinned run parked at Gate 4.

    Returns False when it could not be seeded: a staged demo needs a work root to hold its checkpoints, and a
    store without one (a bare test store) has nowhere to put them.
    """
    if is_staged(snap):
        return _seed_staged(store, job_id, snap, ideas=ideas)
    result = snap.get("result", snap)
    display = snap.get("displayName") or "Demo run"
    datasets = snap.get("datasets") or []
    store.create(job_id, display, {"demo": True, "datasets": sorted(datasets), "mode": result.get("mode")})
    fields: dict[str, Any] = {"status": "complete", "phase": "complete", "result": result}
    if ideas:
        fields["analysis_ideas"] = ideas
    store.update(job_id, **fields)
    return True


def _seed_staged(store: JobStore, job_id: str, snap: dict[str, Any], *, ideas: Any = None) -> bool:
    """Write the four gate checkpoints to the demo's work dir, then park the pinned run at Gate 4 over them.

    The run is created ``demo: True``, which is what makes it immutable (every write refused), TTL-exempt and
    never persisted to the durable store — so a restart re-seeds it from the shipped file, exactly as before.
    Its realized cost is what the run cost to BUILD (shown on the rail as what each gate spent); a guest is
    never charged anything, since a pinned run cannot be resumed. Gate 4 hosts the analysis ideas, so the
    pre-generated ones ride along, as they do on a finished demo.
    """
    from backend.checkpoint import checkpoint_path, write_checkpoint

    root = store.work_root
    if root is None:
        logger.warning("staged demo %s not seeded: the store has no work root to hold its checkpoints", job_id)
        return False
    work = Path(root) / job_id
    cost = float(snap.get("realizedCost") or 0.0)
    pages = {**(snap.get("checkpoints") or {}), STAGED_DEMO_GATE: snap["result"]}
    for gate in (*STAGED_GATES, STAGED_DEMO_GATE):
        write_checkpoint(work, job_id=job_id, gate=gate, result=pages[gate], responses={}, realized_cost=cost)
    config = {
        **(snap.get("config") or {}),
        "demo": True,
        "datasets": sorted(snap.get("datasets") or []),
        "mode": snap["result"].get("mode"),
    }
    store.create(job_id, snap.get("displayName") or "Demo run", config)
    # Relative to the work root, like every other run's pointer (see backend/checkpoint.py).
    ref = f"{job_id}/{checkpoint_path(work, STAGED_DEMO_GATE).name}"
    store.checkpoint(job_id, gate=STAGED_DEMO_GATE, checkpoint_ref=ref, realized_cost=cost)
    if ideas:
        store.update(job_id, analysis_ideas=ideas)
    return True
