"""Precomputed demo runs — load a real harmonization result without spending API credits.

A demo is a run we computed once (offline, via ``scripts/build_demos.py``) and shipped as a JSON
snapshot under ``backend/demos/``. The frontend offers the curated demo cohorts as checkboxes; when a
selection matches a precomputed combo, the backend hydrates a *completed* job straight from the
snapshot — no pipeline, no LLM, no key. ``manifest.json`` lists the datasets and which combos exist.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_DIR = Path(__file__).resolve().parent / "demos"
_MANIFEST = _DIR / "manifest.json"


def _load_manifest() -> dict[str, Any]:
    if not _MANIFEST.exists():
        return {"datasets": [], "combos": []}
    return json.loads(_MANIFEST.read_text())


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
