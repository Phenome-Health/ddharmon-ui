#!/usr/bin/env python3
"""Enrich the demo fixture's CDE candidates with catalog metadata (08-16g).

    python scripts/enrich_candidates.py

The run contract's ``UICandidate`` carries only rank/id/definition/cosine — not the permissible values or
the richness fields a reviewer actually picks on (Gate 2). Those live in the CDE catalog, keyed by
``tinyId`` (== the candidate's ``cdeExternalId``). This script joins them into the shipped demo fixture so
the Gate 2 expand shows real metadata WITHOUT the reviewer leaving the app.

WHY A DEV SCRIPT, NOT A HAND-EDIT. The fields it writes (``questionText``, ``dataType``, ``units``,
``permissibleValues``, ``stewardOrg``, ``endorsed``) are exactly what the BACKEND enrichment must emit on
``UICandidate`` for real runs (todo: extend contract.py + core retrieval). This script is the prototype of
that join, and it is idempotent — re-running re-derives the same fields.

The catalog is INTERNAL and gitignored; it lives in the sibling research repo, so the join degrades
gracefully when it is absent (candidates keep their existing fields; the UI shows "view on the repo").
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]  # ddharmon-ui-gate23/
FIXTURE = REPO / "frontend" / "public" / "static-data" / "result-demo-aireadi_aou_clsa_mesa_ukbb.json"
CATALOG = REPO.parent / "ph-arpa-data-harmonization" / "data" / "examples" / "all_cdes_flat.tsv"

PV_CAP = 60  # a very long value list is capped in the fixture; the repo link has the full one.


def load_catalog(path: Path) -> dict[str, dict]:
    by_tiny: dict[str, dict] = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            tiny = (row.get("tinyId") or "").strip()
            if not tiny:
                continue
            pv_raw = (row.get("permissible_values") or "").strip()
            pv = [v.strip() for v in pv_raw.split("|") if v.strip()][:PV_CAP] if pv_raw else []
            by_tiny[tiny] = {
                "questionText": (row.get("question_text") or "").strip(),
                "dataType": (row.get("datatype") or "").strip(),
                "units": (row.get("uom") or "").strip(),
                "permissibleValues": pv,
                "stewardOrg": (row.get("steward_org") or "").strip(),
                "endorsed": (row.get("nih_endorsed") or "").strip().lower() == "true",
            }
    return by_tiny


def main() -> int:
    if not FIXTURE.exists():
        print(f"fixture not found: {FIXTURE}", file=sys.stderr)
        return 1
    if not CATALOG.exists():
        print(f"catalog not found (internal, gitignored): {CATALOG} — nothing to enrich", file=sys.stderr)
        return 0

    catalog = load_catalog(CATALOG)
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    records = data.get("result", {}).get("records", [])

    enriched = 0
    seen = 0
    for rec in records:
        for cand in rec.get("candidates", []) or []:
            seen += 1
            meta = catalog.get((cand.get("cdeExternalId") or "").strip())
            if not meta:
                continue
            # Only write non-empty fields; leave the rest for the UI's graceful "view on repo".
            for k, v in meta.items():
                if v not in ("", [], None):
                    cand[k] = v
            enriched += 1

    FIXTURE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"catalog: {len(catalog)} CDEs · candidates seen: {seen} · enriched: {enriched}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
