#!/usr/bin/env python3
"""Curate small, overlapping demo dictionaries from the shipped public example cohorts.

Produces 200-field subsets of All of Us / CLSA / UK Biobank / MESA / AI-READI, filtered to a shared set of
common health & demographic domains so a cross-cohort demo run has real matches to find. Rows are grouped by
the domain keyword they hit and taken round-robin, so the subset spans domains (sex, age, smoking, blood
pressure, …) rather than piling up in one section; if a cohort has fewer than `cap` domain-matched fields,
the rest is filled with its remaining fields so every cohort contributes the same count.

Outputs (committed as demo assets):
    backend/demos/data/{aou,clsa,ukbb,mesa,aireadi}.csv

Usage:
    # point --source-dir at a checkout of the ddharmon repo's data/examples (the full public example data),
    # or set DDHARMON_EXAMPLES_DIR:
    python scripts/build_demo_data.py --source-dir /path/to/ddharmon/data/examples [--cap 200]
"""

from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path

# Source-cohort layout: which columns carry searchable text, and which is the variable id.
COHORTS = {
    "aou": {
        "src": "all_of_us_surveys.csv",
        "text": ["Field Label", "Item Concept", "Section Header"],
        "id": "Item Concept",
    },
    "clsa": {"src": "clsa_baseline.csv", "text": ["label:en", "question:en", "comment:en"], "id": "name"},
    "ukbb": {"src": "ukbb_showcase.csv", "text": ["field_name", "description"], "id": "field_id"},
    "mesa": {"src": "mesa_dbgap.csv", "text": ["variable_name", "description"], "id": "variable_name"},
    "aireadi": {"src": "aireadi_surveys.csv", "text": ["field_label", "variable_name"], "id": "variable_name"},
}

# Shared domains — each cohort is filtered to rows touching one of these, giving cross-cohort overlap.
DOMAINS = [
    "sex",
    "gender",
    "age",
    "date of birth",
    "race",
    "ethnic",
    "education",
    "school",
    "degree",
    "income",
    "marital",
    "married",
    "employ",
    "occupation",
    "smok",
    "cigarett",
    "tobacco",
    "alcohol",
    "drink",
    "height",
    "weight",
    "body mass",
    "bmi",
    "waist",
    "blood pressure",
    "systolic",
    "diastolic",
    "hypertension",
    "diabetes",
    "glucose",
    "cholesterol",
    "heart",
    "stroke",
    "cancer",
    "asthma",
    "depress",
    "anxiety",
    "mental health",
    "sleep",
    "physical activity",
    "exercise",
    "walk",
    "diet",
    "fruit",
    "vegetable",
    "pain",
    "general health",
    "overall health",
    "disability",
    "medication",
]

# The full public example CSVs live in the ddharmon repo under data/examples/. Point --source-dir there (or
# set DDHARMON_EXAMPLES_DIR). No personal/absolute default — this script ships in the user-facing demo bundle.
DEFAULT_SOURCE = Path(os.environ.get("DDHARMON_EXAMPLES_DIR", "data/examples"))
OUT_DIR = Path(__file__).resolve().parents[1] / "backend" / "demos" / "data"


def _match_domain(row: dict[str, str], text_cols: list[str]) -> str | None:
    blob = " ".join(str(row.get(c, "")) for c in text_cols).lower()
    for kw in DOMAINS:
        if kw in blob:
            return kw
    return None


def curate(name: str, spec: dict, source_dir: Path, cap: int) -> int:
    src = source_dir / spec["src"]
    with open(src, newline="") as fh:
        reader = csv.DictReader(fh)
        fieldnames = reader.fieldnames or []
        # Bucket rows by the shared domain they hit (for cross-cohort overlap); dedupe by variable id.
        # Rows that hit no domain go to `remainder` — used to fill the cohort up to `cap` so every cohort
        # contributes the SAME field count (a balanced demo), domain-overlapping fields taken first.
        buckets: dict[str, list[dict]] = {kw: [] for kw in DOMAINS}
        remainder: list[dict] = []
        seen: set[str] = set()
        for row in reader:
            vid = str(row.get(spec["id"], "")).strip()
            if not vid or vid in seen:
                continue
            seen.add(vid)
            kw = _match_domain(row, spec["text"])
            (buckets[kw] if kw is not None else remainder).append(row)

    # Round-robin across domain buckets until we hit the cap → a spread, not a pile-up.
    picked: list[dict] = []
    idx = 0
    while len(picked) < cap:
        added = False
        for kw in DOMAINS:
            if idx < len(buckets[kw]):
                picked.append(buckets[kw][idx])
                added = True
                if len(picked) >= cap:
                    break
        if not added:
            break
        idx += 1

    # Fill to the cap with non-domain-matched fields so every cohort contributes exactly `cap` fields.
    n_domain = len(picked)
    if len(picked) < cap:
        picked.extend(remainder[: cap - len(picked)])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{name}.csv"
    with open(out, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(picked)
    domains_hit = sum(1 for kw in DOMAINS if buckets[kw])
    fill = len(picked) - n_domain
    fill_note = f" (+{fill} fill)" if fill else ""
    print(
        f"  {name:8s}: {len(picked):4d} fields — {n_domain} across {domains_hit} domains{fill_note} "
        f"-> {out.relative_to(OUT_DIR.parents[2])}"
    )
    return len(picked)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE)
    ap.add_argument("--cap", type=int, default=200)
    args = ap.parse_args()
    if not args.source_dir.exists():
        raise SystemExit(f"source dir not found: {args.source_dir}")
    print(f"Curating demo dictionaries (cap {args.cap}) from {args.source_dir}")
    for name, spec in COHORTS.items():
        curate(name, spec, args.source_dir, args.cap)


if __name__ == "__main__":
    main()
