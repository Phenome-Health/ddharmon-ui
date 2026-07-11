"""Precomputed demo runs — load a real harmonization result without spending API credits.

A demo is a run we computed once (offline, via ``scripts/build_demos.py``) and shipped as a JSON
snapshot under ``backend/demos/``. The frontend offers the curated demo cohorts as checkboxes; when a
selection matches a precomputed combo, the backend hydrates a *completed* job straight from the
snapshot — no pipeline, no LLM, no key. ``manifest.json`` lists the datasets and which combos exist.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.jobs import JobStore

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


def list_demos() -> dict[str, Any]:
    """Datasets + combos for the picker; each combo flagged with whether its snapshot is present."""
    man = _load_manifest()
    combos = [{**c, "available": (_DIR / c["snapshot"]).exists()} for c in man.get("combos", [])]
    return {"datasets": man.get("datasets", []), "combos": combos}


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
        result = snap.get("result", snap)
        display = snap.get("displayName") or "Demo run"
        store.create(job_id, display, {"demo": True, "datasets": sorted(datasets), "mode": result.get("mode")})
        fields: dict[str, Any] = {"status": "complete", "phase": "complete", "result": result}
        # Pre-generated ideas (sidecar keyed by snapshot filename, else inline on the snapshot) → the demo
        # shows them without an LLM call. Absent → the panel just offers "generate" as for a real run.
        ideas = ideas_by_snapshot.get(combo["snapshot"]) or snap.get("analysisIdeas")
        if ideas:
            fields["analysis_ideas"] = ideas
        store.update(job_id, **fields)
        ids.append(job_id)
    return ids
