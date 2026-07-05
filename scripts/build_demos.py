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

# Per-cohort role pins for source files that fool generic auto-detection. AoU ships a REDCap codebook whose
# real identifier is "Item Concept" (not detected) and whose question is "Field Label" (only found as
# short_label), while auto-detect mis-assigns description->"Branching Logic" (skip-logic) and field_id->a
# validation bound. Pinning these gives real member ids + clean text on the next demo build. (The frozen
# snapshot's ids stay _ROW_N; enrich_members recovers the real codes by raw row index — see below.)
COHORT_ROLE_OVERRIDES: dict[str, dict[str, str]] = {
    "aou": {"variable_name": "Item Concept", "question_text": "Field Label"},
}


def roles_for(did: str, headers: list[str]) -> dict[str, str]:
    """Auto-detected column roles, with any per-cohort override pins applied (see COHORT_ROLE_OVERRIDES)."""
    roles = detect_roles(headers)
    override = COHORT_ROLE_OVERRIDES.get(did)
    if override:
        # the mis-detected description/field_id for these codebooks are wrong columns — drop them so the
        # pinned question_text/variable_name win and no skip-logic text leaks into the embedding.
        roles.pop("description", None)
        roles.pop("field_id", None)
        roles.update(override)
    return roles


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
    ap.add_argument(
        "--enrich-members",
        action="store_true",
        help="skip the pipeline; add per-member field text (memberDetails) to the EXISTING snapshot by "
        "re-loading the demo CSVs (no LLM, $0). Verdicts/decisions are untouched — only member metadata "
        "is added. Re-emits the static fixtures.",
    )
    args = ap.parse_args()

    ids = sorted(d.lower() for d in args.datasets)

    if args.enrich_members:
        enrich_members(ids)
        return

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
        roles = roles_for(did, read_headers(path))
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


def enrich_members(ids: list[str]) -> None:
    """Add ``memberDetails`` (source field name + text) to an existing demo snapshot — no pipeline, $0.

    Re-loads the curated demo CSVs with the SAME auto-detected roles the build used, so member ids match
    exactly, then attaches each member's human text (description/question/label) via the adapter's
    ``build_member_index`` — the single source of truth for that mapping. Only ADDS member metadata; the
    verdicts, CDE matches, transforms and reproducibility block are left untouched.
    """
    from types import SimpleNamespace

    from backend.engine.adapter import _member_ui, build_member_index  # noqa: PLC0415
    from ddharmon.ingestion import load_dictionary  # noqa: PLC0415

    snap_path = DEMO_DIR / f"{'_'.join(ids)}.json"
    if not snap_path.exists():
        raise SystemExit(f"no snapshot at {snap_path} — build it first (drop --enrich-members)")
    snapshot = json.loads(snap_path.read_text())

    import csv as _csv  # noqa: PLC0415

    dicts = []
    for did in ids:
        path = DATA_DIR / f"{did}.csv"
        if not path.exists():
            raise SystemExit(f"missing curated demo file: {path}")
        # AUTO-detect (not roles_for): the frozen snapshot's member ids were built with auto-detected roles,
        # so we must reproduce them exactly (AoU -> _ROW_N) for the join to hit. Text is already good here
        # (the loader backfills description from the label); we upgrade the shown id below.
        roles = detect_roles(read_headers(path))
        dd = load_dictionary(str(path), cohort_name=COHORT_LABELS.get(did, did), **roles)
        dicts.append(SimpleNamespace(dictionary=dd))
    index = build_member_index(dicts)

    # Build a _ROW_N -> real-id rename map for cohorts with a pinned variable_name (REDCap codebooks): the
    # _ROW_N id IS the raw CSV data-row index, so we read that column by row index. Applied across members,
    # memberDetails, and transform sourceVariables so the frozen demo reads with real codes everywhere (a
    # full rebuild via roles_for would produce these ids natively).
    rename: dict[str, str] = {}
    for did in ids:
        override = COHORT_ROLE_OVERRIDES.get(did)
        id_col = override.get("variable_name") if override else None
        if not id_col:
            continue
        label = COHORT_LABELS.get(did, did)
        with open(DATA_DIR / f"{did}.csv", newline="") as fh:
            for i, row in enumerate(_csv.DictReader(fh)):
                real = (row.get(id_col) or "").strip()
                if real:
                    rename[f"{label}:_ROW_{i:05d}"] = f"{label}:{real}"
    # Alias the index under the real ids too, so re-running enrich (after members are already renamed) still
    # resolves text — keeps this idempotent.
    for old, new in rename.items():
        if old in index:
            index[new] = {**index[old], "id": new, "name": new.split(":", 1)[1]}

    result = snapshot.get("result", snapshot)
    records = result.get("records", [])
    resolved = missing = 0
    for rec in records:
        new_members = [rename.get(m, m) for m in rec.get("members", [])]
        rec["members"] = new_members
        rec["memberDetails"] = [_member_ui(m, index) for m in new_members]
        resolved += sum(1 for m in new_members if m in index)
        missing += sum(1 for m in new_members if m not in index)
        for t in rec.get("transforms", []):
            if t.get("sourceVariable") in rename:
                t["sourceVariable"] = rename[t["sourceVariable"]]
    # Keep the embedding-atlas point ids in sync with the renamed member ids, else atlas points no longer
    # join to their record and render as "unassigned" (the bug this whole rename would otherwise introduce).
    for p in result.get("atlas", []):
        new = rename.get(f"{p.get('cohort')}:{p.get('variable')}")
        if new:
            p["variable"] = new.split(":", 1)[1]
    snap_path.write_text(json.dumps(snapshot))
    total = resolved + missing
    pct = (100 * resolved // total) if total else 0
    print(f"enriched {len(records)} records — {resolved}/{total} members resolved to dict text ({pct}%), {missing} fallback")
    write_static_fixtures(ids, snapshot)


def write_static_fixtures(ids: list[str], snapshot: dict) -> None:
    """Emit the demo as a static (backend-less) fixture for the Netlify build.

    Writes ``frontend/public/static-data/result-<jobId>.json`` (a JobResult wrapper the SPA loads in
    ``VITE_STATIC`` mode) and merges the demo into ``static-data/jobs.json`` so it shows on the Runs page,
    demo-marked. The client-side replay (``useHarmonizeStream``) paces it using ``phaseTimings``. The Runs
    page shows only real runs now (the demo + any user runs) — the demo is prepended + de-duped by jobId.
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

    # Mark this combo available in the static demos.json (in VITE_STATIC mode the SPA reads it as-is — there's
    # no backend to compute availability). Without this the demo page shows "being prepared" and won't load.
    demos_path = static_dir / "demos.json"
    if demos_path.exists():
        demos = json.loads(demos_path.read_text())
        for combo in demos.get("combos", []):
            if sorted(str(x).lower() for x in combo.get("datasets", [])) == ids:
                combo["available"] = True
        demos_path.write_text(json.dumps(demos, indent=2))

    print(
        f"static fixtures: result-{job_id}.json + jobs.json merge + demos.json availability ({summary['nRecords']} records)"
    )


if __name__ == "__main__":
    main()
