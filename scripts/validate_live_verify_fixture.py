#!/usr/bin/env python3
"""$0 check that the live-verify fixture clusters the way its manifest intends — no LLM call is made.

    python scripts/validate_live_verify_fixture.py --json-out run1.json
    python scripts/validate_live_verify_fixture.py --json-out run2.json --compare run1.json
    python scripts/validate_live_verify_fixture.py --json-out sweep.json --seeds 10   # + a UMAP-seed sweep
    python scripts/validate_live_verify_fixture.py --markdown run1.json               # re-render a report

Loads ``tests/live/fixture/`` with the manifest's column roles (exactly what the driver sends), loads the
CDE catalog the way the app does (``backend.app`` constants), embeds locally, and runs core
``harmonize_leanb`` with EVERY LLM stage unset — the call the adapter's preview mode makes, with the
adapter's own auto-scaled ``min_cluster_size``. With ``generate=None`` core returns right after clustering
(+ M10 outlier recovery) and retrieval, carrying the prepared generate-ideal prompts; nothing is sent to any
provider, and no API key is read.

What it can show at $0: which cluster every path variable lands in, which variables end up as ungrouped
leftovers, whether the repeated name survives loading, whether the repeating measure is detected, what the
hybrid retriever returns for the units / "(e.g., ...)" items, and which unit conversions are deterministic.
What it cannot: how the paid split / assign stages partition, label or route a cluster.

``--seeds N`` re-runs the clustering prefix of ``harmonize_leanb`` (UMAP+HDBSCAN, then M10 recovery) at UMAP
seeds 0..N-1 and reports how often each check holds. The pipeline always uses seed 42, but UMAP is not
bit-reproducible across machines (or even across embedding-cache states), so the sweep is the honest
measure of how much a check depends on one lucky partition.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
FIXTURE = REPO / "tests" / "live" / "fixture"

# backend.app reads these at import; keep a validation run from touching the real work dir / job store.
_SCRATCH = tempfile.mkdtemp(prefix="ddharmon-fixture-validate-")
os.environ.setdefault("DDHARMON_UI_WORK", _SCRATCH)
os.environ.setdefault("DDHARMON_UI_DB", os.path.join(_SCRATCH, "jobs.db"))

#: Retrieval is reported per variable for these paths (the others only need their cluster).
RETRIEVAL_PATHS = ("verdict_mix", "units_arithmetic", "eg_permissible_values")
#: Target units tried when reporting whether a path-3 variable's declared unit converts deterministically.
UNIT_TARGETS = ("cm", "kg", "year")
LEFTOVER = "leftover"


def _load(fixture: Path, cde_set: str) -> tuple[dict, list[Any], dict, int]:
    from ddharmon.embedding.provider import SentenceTransformerProvider
    from ddharmon.embedding.service import embed_dictionary
    from ddharmon.ingestion import load_dictionary

    from backend.app import CDE_COHORT, CDE_COLUMN_ROLES, CDE_FILES
    from backend.engine.adapter import _auto_min_cluster_size

    manifest = json.loads((fixture / "manifest.json").read_text(encoding="utf-8"))
    dicts = [
        load_dictionary(str(fixture / c["file"]), cohort_name=c["cohortName"], **c["columnRoles"])
        for c in manifest["cohorts"]
    ]
    loaded = {
        c["cohortName"]: {"rows": c["rows"], "variables": len(d.fields)}
        for c, d in zip(manifest["cohorts"], dicts, strict=True)
    }
    dicts.append(load_dictionary(str(CDE_FILES[cde_set]), cohort_name=CDE_COHORT, **CDE_COLUMN_ROLES))
    provider = SentenceTransformerProvider()
    embedded = [embed_dictionary(d, provider=provider) for d in dicts]
    n_fields = sum(len(d.fields) for d in dicts if d.cohort_name != CDE_COHORT)
    return manifest, embedded, loaded, _auto_min_cluster_size(n_fields)


def _key(member_id: str) -> tuple[str, str]:
    """``"<cohort>:<variable>"`` -> ``(cohort, variable)`` (a variable name may itself contain ':')."""
    cohort, _, var = member_id.partition(":")
    return cohort, var


def _labelled(member_sets: list[list[str]]) -> tuple[list[list[str]], dict[str, str]]:
    """Sort clusters (largest first, then members) and map every member to its K-label."""
    ordered = sorted((sorted(m) for m in member_sets if m), key=lambda m: (-len(m), m))
    return ordered, {v: f"K{i}" for i, m in enumerate(ordered, 1) for v in m}


def _seed_partition(embedded: list[Any], mcs: int, seed: int) -> list[list[str]]:
    """``harmonize_leanb``'s clustering prefix at a given UMAP seed: UMAP+HDBSCAN, then M10 recovery."""
    from ddharmon.clustering.topic_engine import topic_model_dictionaries
    from ddharmon.harmonization.leanb import recover_outlier_clusters
    from ddharmon.harmonization.substrate import build_substrate

    from backend.app import CDE_COHORT

    tm = topic_model_dictionaries(embedded, min_cluster_size=mcs, random_state=seed)
    sub = build_substrate(tm.clusters, min_cluster_size=mcs, outlier=tm.outlier_cluster, n_fields=len(tm.field_refs))
    clusters, _sub = recover_outlier_clusters(tm.clusters, sub, tm.embeddings, tm.field_refs)
    return [
        [f"{m.dictionary_name}:{m.variable_name}" for m in c.members if m.dictionary_name != CDE_COHORT]
        for c in clusters
    ]


def checks(
    where: dict[str, str], n_leftovers: int, loaded: dict, w2l: dict | None, manifest: dict
) -> list[tuple[str, bool, str]]:
    """The landings the fixture must show at $0 (paths 1, 4, 6, 7, 8, 10)."""
    paths = manifest["paths"]

    def at(name: str, key: str = "variables") -> list[str]:
        return [where.get(v["memberId"], LEFTOVER) for v in paths.get(name, {}).get(key, [])]

    out: list[tuple[str, bool, str]] = []
    ks = at("heterogeneous_split")
    out.append(
        ("1 split candidate: all in ONE cluster", len(set(ks)) == 1 and LEFTOVER not in ks, f"{sorted(set(ks))}")
    )
    ks = at("wide_to_long")
    ok = len(set(ks)) == 1 and LEFTOVER not in ks and w2l is not None
    out.append(("4 repeating measure: together + detected", ok, f"{sorted(set(ks))}; detector: {w2l}"))
    pairs: dict[str, list[str]] = defaultdict(list)
    for v in paths.get("many_to_one_same_cohort", {}).get("variables", []):
        pairs[v["pair"]].append(where.get(v["memberId"], LEFTOVER))
    held = sorted(p for p, c in pairs.items() if len(set(c)) == 1 and LEFTOVER not in c)
    out.append(
        ("6 twin pairs: each pair in one cluster", len(held) == len(pairs) >= 2, f"{len(held)}/{len(pairs)} pairs")
    )
    ukbb = loaded.get("UKBB", {})
    ok = ukbb.get("rows") == ukbb.get("variables")
    out.append(
        (
            "7 repeated name: every UKBB row survives",
            ok,
            f"rows {ukbb.get('rows')} -> variables {ukbb.get('variables')}",
        )
    )
    out.append(("8 leftovers: at least one", n_leftovers >= 1, f"{n_leftovers} ungrouped"))
    ks = at("ungrouped_leftovers")
    out.append(
        (
            "8 leftovers: the manifest's reference set",
            bool(ks) and set(ks) == {LEFTOVER},
            f"{ks.count(LEFTOVER)}/{len(ks)} are leftovers",
        )
    )
    ks = sorted({k for k in at("eye_conditions_spread") if k != LEFTOVER})
    out.append(("10 eye items: >= 2 clusters", len(ks) >= 2, f"{ks}"))
    return out


def run(fixture: Path, cde_set: str, top_n: int, seeds: int) -> dict:
    from ddharmon.clustering.topic_engine import collect_inputs
    from ddharmon.harmonization import harmonize_leanb
    from ddharmon.harmonization.anchor import build_field_lookup
    from ddharmon.harmonization.leanb import DEFAULT_TOP_K, _build_backbone, _member_text, _retrieve
    from ddharmon.harmonization.positional import detect_positional_enumeration
    from ddharmon.harmonization.transform import _field_label
    from ddharmon.values.units import UnitCanonicalizer

    from backend.app import CDE_COHORT

    manifest, embedded, loaded, mcs = _load(fixture, cde_set)

    # The $0 call: no generate / split / classify / ... callable -> core stops after clustering + retrieval.
    result = harmonize_leanb(embedded, cde_cohort=CDE_COHORT, min_cluster_size=mcs)
    top_of: dict[str, list] = {}
    member_sets = []
    for pr in result.ideal_prompts:
        ctx = pr.context or {}
        members = sorted(f"{m['dictionary_name']}:{m['variable_name']}" for m in ctx.get("members", []))
        member_sets.append(members)
        top_of[json.dumps(members)] = [
            (c["designation"], round(float(c["cos"]), 3)) for c in ctx.get("candidates", [])[:top_n]
        ]
    ordered, where = _labelled(member_sets)
    sources = [ed for ed in embedded if ed.dictionary.cohort_name != CDE_COHORT]
    all_fields = sorted(f"{ed.dictionary.cohort_name}:{v}" for ed in sources for v in ed.get_variable_names())
    leftovers = [f for f in all_fields if f not in where]
    clusters = [
        {
            "label": f"K{i}",
            "nMembers": len(m),
            "cohorts": sorted({x.partition(":")[0] for x in m}),
            "members": m,
            "top": top_of[json.dumps(m)],
        }
        for i, m in enumerate(ordered, 1)
    ]

    # Per-variable hybrid retrieval (the dense vector of ONE row + BM25, fused by RRF) over the backbone core
    # builds by default (M5 clean CDE text on) — what a single-variable group is re-retrieved against.
    _docs, embeddings, field_refs, _c = collect_inputs(embedded)
    lookup = build_field_lookup(embedded)
    cde_dict = next(ed for ed in embedded if ed.dictionary.cohort_name == CDE_COHORT)
    backbone = _build_backbone(embedded, lookup, CDE_COHORT, cde_dict, clean_text=True)
    cde_fields = cde_dict.dictionary.fields
    row_of = {(r.dictionary_name, r.variable_name): i for i, r in enumerate(field_refs)}
    ref_of = {(r.dictionary_name, r.variable_name): r for r in field_refs}
    canon = UnitCanonicalizer()

    def retrieve(member_id: str) -> list[dict]:
        key = _key(member_id)
        if key not in row_of:
            return []
        text = _member_text(lookup.get(key), ref_of[key])
        cands, _top1 = _retrieve([row_of[key]], [text], embeddings, backbone, DEFAULT_TOP_K)
        out = []
        for c in cands[:top_n]:
            fld = cde_fields.get(c["designation"])
            pvs = (fld.value_encoding_raw or "") if fld is not None else ""
            if fld is not None and not pvs:
                pvs = " | ".join(o.label or o.code for o in fld.response_options)
            out.append({"cde": c["designation"], "cos": round(float(c["cos"]), 3), "egLabels": "(e.g.," in pvs})
        return out

    def unit_of(member_id: str) -> dict:
        fld = lookup.get(_key(member_id))
        unit = (fld.units or "").strip() if fld is not None else ""
        conv = next(((t, canon.convert(unit, t)) for t in UNIT_TARGETS if unit and canon.convert(unit, t)), None)
        return {"unit": unit, "conversion": None if conv is None else {"to": conv[0], "factor": conv[1][0]}}

    paths_out: dict[str, list[dict]] = {}
    for name, spec in manifest["paths"].items():
        rows = []
        for v in spec["variables"]:
            entry: dict[str, Any] = {"memberId": v["memberId"], "cluster": where.get(v["memberId"], LEFTOVER)}
            if name in RETRIEVAL_PATHS:
                entry["retrieval"] = retrieve(v["memberId"])
            if name == "units_arithmetic":
                entry.update(unit_of(v["memberId"]))
            rows.append(entry)
        paths_out[name] = rows

    # The repeating measure: detected on the labels the wide->long pre-pass reads?
    labels = [_field_label(lookup.get(_key(v["memberId"]))) for v in manifest["paths"]["wide_to_long"]["variables"]]
    pe = detect_positional_enumeration(labels)
    w2l = (
        None
        if pe is None
        else {"signature": pe.signature, "occurrences": pe.n_occurrences, "range": list(pe.int_range)}
    )

    fingerprint = hashlib.sha256(json.dumps({"p": ordered, "o": leftovers}).encode()).hexdigest()[:16]
    rep: dict[str, Any] = {
        "cdeSet": cde_set,
        "minClusterSize": mcs,
        "nSourceFields": len(all_fields),
        "loaded": loaded,
        "nClusters": len(clusters),
        "clusters": clusters,
        "leftovers": leftovers,
        "paths": paths_out,
        "wideToLong": w2l,
        "checks": [list(c) for c in checks(where, len(leftovers), loaded, w2l, manifest)],
        "fingerprint": fingerprint,
    }

    if seeds:
        passes: Counter[str] = Counter()
        left_freq: Counter[str] = Counter()
        n_left = []
        for seed in range(seeds):
            _o, w = _labelled(_seed_partition(embedded, mcs, seed))
            left = [f for f in all_fields if f not in w]
            left_freq.update(left)
            n_left.append(len(left))
            for name, ok, _detail in checks(w, len(left), loaded, w2l, manifest):
                passes[name] += bool(ok)
        rep["seedSweep"] = {
            "seeds": seeds,
            "passRate": {name: f"{passes[name]}/{seeds}" for name, _ok, _d in rep["checks"]},
            "leftoversPerSeed": n_left,
            "leftoverFrequency": left_freq.most_common(),
        }
    return rep


def markdown(rep: dict) -> str:
    lines = [
        f"- CDE catalog `{rep['cdeSet']}`; {rep['nSourceFields']} source variables; `min_cluster_size` "
        f"{rep['minClusterSize']} (the adapter's auto-scale)",
        f"- {rep['nClusters']} clusters, {len(rep['leftovers'])} ungrouped leftovers; partition fingerprint "
        f"`{rep['fingerprint']}`",
        "",
        "| Cluster | Size | Cohorts | Members | Top retrieved CDEs (cosine) |",
        "|---|---|---|---|---|",
    ]
    for c in rep["clusters"]:
        top = "; ".join(f"{n} ({s})" for n, s in c["top"][:3])
        lines.append(
            f"| {c['label']} | {c['nMembers']} | {', '.join(c['cohorts'])} | {', '.join(c['members'])} | {top} |"
        )
    lines += ["", "Ungrouped leftovers: " + (", ".join(rep["leftovers"]) or "none"), ""]
    lines += ["| Check | Result | Detail |", "|---|---|---|"]
    lines += [f"| {n} | {'PASS' if ok else 'FAIL'} | {d} |" for n, ok, d in rep["checks"]]
    if "seedSweep" in rep:
        sw = rep["seedSweep"]
        lines += ["", f"UMAP-seed sweep (seeds 0..{sw['seeds'] - 1}): leftovers per seed {sw['leftoversPerSeed']}", ""]
        lines += ["| Check | Pass rate |", "|---|---|"] + [f"| {n} | {r} |" for n, r in sw["passRate"].items()]
        lines += ["", "Most frequent leftovers: " + ", ".join(f"{v} ({k})" for v, k in sw["leftoverFrequency"][:8])]
    lines += ["", '| Path | Variable | Cluster | Top retrieved CDEs (cosine; e.g. = has "(e.g.," labels) | Unit |']
    lines += ["|---|---|---|---|---|"]
    for name, rows in rep["paths"].items():
        for v in rows:
            ret = "; ".join(
                f"{r['cde']} ({r['cos']}{', e.g.' if r['egLabels'] else ''})" for r in v.get("retrieval", [])[:3]
            )
            unit = ""
            if "unit" in v:
                conv = v["conversion"]
                unit = f"`{v['unit'] or '-'}`" + (
                    f" -> {conv['to']} x{conv['factor']:g}" if conv else " (no deterministic conversion)"
                )
            lines.append(f"| {name} | {v['memberId']} | {v['cluster']} | {ret} | {unit} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--fixture", default=str(FIXTURE))
    ap.add_argument("--cde-set", choices=["endorsed", "full"], default="endorsed")
    ap.add_argument("--top", type=int, default=5, help="candidates kept per cluster / variable")
    ap.add_argument("--seeds", type=int, default=0, help="also sweep UMAP seeds 0..N-1 (clustering only)")
    ap.add_argument("--json-out", help="write the run report here")
    ap.add_argument("--compare", help="a previous --json-out: report whether the partition is identical")
    ap.add_argument("--markdown", help="render a previous --json-out as markdown instead of running")
    args = ap.parse_args()
    if args.markdown:
        print(markdown(json.loads(Path(args.markdown).read_text(encoding="utf-8"))), end="")
        return
    rep = run(Path(args.fixture), args.cde_set, args.top, args.seeds)
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(rep, indent=2) + "\n", encoding="utf-8")
    print(markdown(rep), end="")
    if args.compare:
        prev = json.loads(Path(args.compare).read_text(encoding="utf-8"))
        same = prev["fingerprint"] == rep["fingerprint"]
        verdict = "IDENTICAL" if same else "DIFFERENT"
        print(f"\npartition vs {Path(args.compare).name}: {verdict} ({prev['fingerprint']} vs {rep['fingerprint']})")


if __name__ == "__main__":
    main()
