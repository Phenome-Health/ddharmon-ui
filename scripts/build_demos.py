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


def records_fingerprint(result: dict) -> str:
    """SHA-256 of the harmonization RECORDS + summary (the reproducibility-relevant output).

    Excludes the atlas (a 2D projection of floats) and prompt counts — the reproducibility claim is about the
    mapping DECISIONS (verdicts, CDE matches, transforms), not the visualization coordinates.
    """
    import hashlib

    payload = {"records": result.get("records", []), "summary": result.get("summary", {})}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def run_once(dict_specs, cde_spec, mode, mcs, cde_set, work_dir, substrate_path):
    """One production-path run via run_pipeline, timing each phase (for realistic replay pacing)."""
    import time

    timings: dict[str, float] = {}
    state = {"phase": None, "t0": time.time()}

    def progress(phase: str, c: int = 0, t: int = 0) -> None:
        if phase != state["phase"]:
            now = time.time()
            if state["phase"] is not None:
                timings[state["phase"]] = round(now - state["t0"], 2)
            state["phase"], state["t0"] = phase, now
        print(f"  · {phase} {c}/{t}")

    config = {
        "run_mode": mode,
        "min_cluster_size": mcs,
        "gen_transform_specs": True,
        "cde_cohort": CDE_COHORT,
        "work_dir": str(work_dir),
        "cde_set": cde_set,
    }
    result = run_pipeline(dict_specs, cde_spec, config, progress=progress, substrate_path=substrate_path)
    if state["phase"] is not None:
        timings[state["phase"]] = round(time.time() - state["t0"], 2)
    return result, timings


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", nargs="+", default=["aou", "clsa", "ukbb"])
    ap.add_argument("--mode", choices=["preview", "sync", "batch"], default="preview")
    ap.add_argument("--cde-set", choices=["endorsed", "full"], default="full")
    ap.add_argument("--min-cluster-size", type=int, default=4)
    ap.add_argument(
        "--replay",
        type=int,
        default=0,
        help="after the run, replay N times reusing the frozen "
        "substrate + cached responses; assert the records are byte-identical (reproducibility proof).",
    )
    ap.add_argument(
        "--fresh-drift",
        action="store_true",
        help="also run once in a FRESH work dir (new UMAP + "
        "new LLM calls — costs money) and report how much the records drift vs the frozen run.",
    )
    ap.add_argument("--keep-work", action="store_true", help="keep the persistent work dir (default: kept for replay).")
    ap.add_argument(
        "--fixtures-only",
        action="store_true",
        help="skip the pipeline entirely; re-emit the Netlify static fixtures from the EXISTING snapshot "
        "(no LLM, $0, preserves the snapshot's reproducibility block).",
    )
    args = ap.parse_args()

    ids = sorted(d.lower() for d in args.datasets)

    if args.fixtures_only:
        snap_path = DEMO_DIR / f"{'_'.join(ids)}.json"
        if not snap_path.exists():
            raise SystemExit(f"no snapshot at {snap_path} — build it first (drop --fixtures-only)")
        write_static_fixtures(ids, json.loads(snap_path.read_text()))
        return

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

    # Persistent work dir (gitignored) so the frozen substrate + response cache survive for replay.
    work = DEMO_DIR / ".work" / "_".join(ids)
    work.mkdir(parents=True, exist_ok=True)
    substrate_path = work / "substrate.json"
    fresh_build = not substrate_path.exists()

    print(f"\nRunning pipeline (mode={args.mode}, mcs={args.min_cluster_size}) over {ids} — work={work} …")
    result, timings = run_once(
        dict_specs, cde_spec, args.mode, args.min_cluster_size, args.cde_set, work, substrate_path
    )
    fp0 = records_fingerprint(result)
    n = len(result.get("records", []))
    print(f"\nship run: {n} records | substrate {'BUILT' if fresh_build else 'reused'} | records-fp {fp0[:12]}")

    # --- reproducibility: replay N times reusing the frozen substrate + cached responses -> assert identical ---
    repro = {"shipFingerprint": fp0, "replays": [], "freshDrift": None}
    all_identical = True
    for i in range(args.replay):
        r, _ = run_once(dict_specs, cde_spec, args.mode, args.min_cluster_size, args.cde_set, work, substrate_path)
        fp = records_fingerprint(r)
        identical = fp == fp0
        all_identical = all_identical and identical
        repro["replays"].append({"fingerprint": fp, "identical": identical})
        print(f"replay {i + 1}/{args.replay}: records-fp {fp[:12]} -> {'IDENTICAL ✓' if identical else 'DIFFERENT ✗'}")
    if args.replay:
        print(
            f"\nREPRODUCIBILITY (frozen substrate + response cache): "
            f"{'ALL IDENTICAL ✓' if all_identical else 'MISMATCH ✗'} over {args.replay} replay(s)"
        )

    # --- fresh-run drift: new work dir, no frozen substrate (new UMAP + new LLM calls). Quantify real variance. ---
    if args.fresh_drift:
        with tempfile.TemporaryDirectory(prefix="ddharmon_demo_fresh_") as fresh:
            rf, _ = run_once(dict_specs, cde_spec, args.mode, args.min_cluster_size, args.cde_set, Path(fresh), None)
        fpf = records_fingerprint(rf)
        nf = len(rf.get("records", []))
        v0 = {rec["id"]: rec.get("verdict") for rec in result.get("records", [])}
        vf = {rec["id"]: rec.get("verdict") for rec in rf.get("records", [])}
        shared = set(v0) & set(vf)
        same_verdict = sum(1 for k in shared if v0[k] == vf[k])
        repro["freshDrift"] = {
            "fingerprint": fpf,
            "identical": fpf == fp0,
            "nRecords": nf,
            "recordOverlap": f"{len(shared)}/{max(len(v0), len(vf))}",
            "verdictAgreement": f"{same_verdict}/{len(shared)}" if shared else "n/a",
        }
        print(
            f"\nfresh run (no frozen substrate): {nf} records, records-fp {fpf[:12]} -> "
            f"{'IDENTICAL' if fpf == fp0 else 'DRIFT (expected — UMAP/HDBSCAN + LLM not bitwise-reproducible)'}"
        )
        print(
            f"  record overlap {len(shared)}/{max(len(v0), len(vf))} | verdict agreement on shared: {same_verdict}/{len(shared) if shared else 0}"
        )

    # --- write the snapshot (from the ship run) ---
    label = " + ".join(COHORT_LABELS.get(d, d) for d in ids)
    snapshot = {
        "displayName": f"Demo · {label}",
        "datasets": ids,
        "mode": args.mode,
        "minClusterSize": args.min_cluster_size,
        "cdeSet": args.cde_set,
        "isDemo": True,
        "phaseTimings": timings,  # wall-clock per phase from the real run -> realistic replay pacing
        "reproducibility": repro,
        "result": result,
    }
    out = DEMO_DIR / f"{'_'.join(ids)}.json"
    out.write_text(json.dumps(snapshot))
    print(f"\nWrote {out.relative_to(REPO)}  ({n} records, {out.stat().st_size // 1024} KB, mode={args.mode})")
    write_static_fixtures(ids, snapshot)
    if args.mode == "preview":
        print(
            "NOTE: preview snapshot has clusters only (no verdicts/transforms). Re-run with --mode batch for the full demo."
        )


def write_static_fixtures(ids: list[str], snapshot: dict) -> None:
    """Emit the demo as a static (backend-less) fixture for the Netlify build.

    Writes ``frontend/public/static-data/result-<jobId>.json`` (a JobResult wrapper the SPA loads in
    ``VITE_STATIC`` mode) and merges the demo into ``static-data/jobs.json`` so it shows on the Runs page,
    demo-marked. The client-side replay (``useHarmonizeStream``) paces it using ``phaseTimings``. Keeps the
    existing seeded sample runs in jobs.json (prepend + de-dup by jobId).
    """
    import time

    static_dir = REPO / "frontend" / "public" / "static-data"
    static_dir.mkdir(parents=True, exist_ok=True)
    result = snapshot.get("result", snapshot)
    job_id = "demo-" + "_".join(ids)
    now = int(time.time())
    job = {
        "jobId": job_id,
        "displayName": snapshot.get("displayName", "Demo run"),
        "status": "complete",
        "phase": "complete",
        "completed": 0,
        "total": 0,
        "errorMessage": None,
        "result": result,
        "config": {"demo": True, "datasets": ids, "mode": result.get("mode")},
        "decisions": {},
        "createdAt": now,
        "updatedAt": now,
        "phaseTimings": snapshot.get("phaseTimings", {}),
    }
    (static_dir / f"result-{job_id}.json").write_text(json.dumps(job))

    jobs_path = static_dir / "jobs.json"
    existing = json.loads(jobs_path.read_text()) if jobs_path.exists() else []
    summary = {k: v for k, v in job.items() if k != "result"}
    summary["nRecords"] = len(result.get("records", []))
    merged = [summary] + [j for j in existing if j.get("jobId") != job_id]
    jobs_path.write_text(json.dumps(merged, indent=2))
    print(f"static fixtures: result-{job_id}.json + jobs.json merge ({summary['nRecords']} records)")


if __name__ == "__main__":
    main()
