#!/usr/bin/env python3
"""Precompute a demo harmonization run and ship it as a snapshot the app can load instantly.

Runs the SAME pipeline the app runs (``backend.engine.run_pipeline``) over the curated demo
dictionaries (``backend/demos/data/*.csv``), then writes a snapshot wrapper to
``backend/demos/<ids>.json``. The app's ``POST /api/harmonize/demo`` hydrates a completed job from
that snapshot — so end users spend zero API credits.

    # free plumbing check (no LLM, no key) — produces clusters only:
    python scripts/build_demos.py --mode preview

    # the real shipped demo (needs ANTHROPIC_API_KEY) — adopt/refine/novel + transform specs:
    ANTHROPIC_API_KEY=sk-... python scripts/build_demos.py --mode sync --datasets aou clsa ukbb

Column roles are auto-detected with ddharmon's SchemaRegistry (same as the app's /detect).
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from backend.app import CDE_COHORT, CDE_COLUMN_ROLES, CDE_FILES  # noqa: E402
from backend.engine import run_pipeline  # noqa: E402

DEMO_DIR = REPO / "backend" / "demos"
DATA_DIR = DEMO_DIR / "data"
COHORT_LABELS = {"aou": "AoU", "clsa": "CLSA", "ukbb": "UKBB"}


def detect_roles(headers: list[str]) -> dict[str, str]:
    """Best column→role map for these headers (mirrors backend.app.detect)."""
    from ddharmon.ingestion.schema_registry import SchemaRegistry

    mapping = SchemaRegistry().detect_roles(headers)
    best: dict[str, tuple[float, str]] = {}
    for column, match in mapping.role_map.items():
        kw = match.role.value
        if kw not in best or match.confidence > best[kw][0]:
            best[kw] = (match.confidence, column)
    return {kw: col for kw, (_c, col) in best.items()}


def read_headers(path: Path) -> list[str]:
    import csv

    with open(path, newline="") as fh:
        return next(csv.reader(fh))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", nargs="+", default=["aou", "clsa", "ukbb"])
    ap.add_argument("--mode", choices=["preview", "sync", "batch"], default="preview")
    ap.add_argument("--cde-set", choices=["endorsed", "full"], default="full")
    ap.add_argument("--min-cluster-size", type=int, default=4)
    args = ap.parse_args()

    ids = sorted(d.lower() for d in args.datasets)
    dict_specs = []
    for did in ids:
        path = DATA_DIR / f"{did}.csv"
        if not path.exists():
            raise SystemExit(f"missing curated demo file: {path} (run scripts/build_demo_data.py first)")
        roles = detect_roles(read_headers(path))
        if not any(k in roles for k in ("variable_name", "description", "question_text")):
            raise SystemExit(f"{did}: no variable_name/description/question_text detected in {list(roles)}")
        dict_specs.append({"path": str(path), "cohort_name": COHORT_LABELS.get(did, did), "column_roles": roles})
        print(f"  {did}: roles={roles}")

    cde_path = CDE_FILES[args.cde_set]
    if not cde_path.exists():
        raise SystemExit(f"CDE catalog not found: {cde_path} (set DDHARMON_CDE_DIR)")
    cde_spec = {"path": str(cde_path), "cohort_name": CDE_COHORT, "column_roles": dict(CDE_COLUMN_ROLES)}

    with tempfile.TemporaryDirectory(prefix="ddharmon_demo_") as work:
        config = {
            "run_mode": args.mode,
            "min_cluster_size": args.min_cluster_size,
            "gen_transform_specs": True,
            "cde_cohort": CDE_COHORT,
            "work_dir": work,
            "cde_set": args.cde_set,
        }
        print(f"Running pipeline (mode={args.mode}, min_cluster_size={args.min_cluster_size}) over {ids} …")
        result = run_pipeline(dict_specs, cde_spec, config, progress=lambda p, c=0, t=0: print(f"  · {p} {c}/{t}"))

    label = " + ".join(COHORT_LABELS.get(d, d) for d in ids)
    snapshot = {
        "displayName": f"Demo · {label}",
        "datasets": ids,
        "mode": args.mode,
        "minClusterSize": args.min_cluster_size,
        "cdeSet": args.cde_set,
        "result": result,
    }
    out = DEMO_DIR / f"{'_'.join(ids)}.json"
    out.write_text(json.dumps(snapshot))
    n = len(result.get("records", []))
    print(f"\nWrote {out.relative_to(REPO)}  ({n} records, {out.stat().st_size // 1024} KB, mode={args.mode})")
    if args.mode == "preview":
        print(
            "NOTE: preview snapshot has clusters only (no verdicts/transforms). Re-run with --mode sync for the full demo."
        )


if __name__ == "__main__":
    main()
