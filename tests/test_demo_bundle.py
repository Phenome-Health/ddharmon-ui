"""Guard the shipped demo column-assignment manifest against drift.

The New Run flow prefills a demo CSV's column mapping from
``frontend/src/data/demo-column-assignments.json`` (emitted by ``scripts/build_demo_bundle.py`` from
``build_demos.COHORT_ROLES``). If the canonical roles or a demo CSV's header change, the manifest must be
regenerated — this test fails loudly to force that, so the prefill can't silently reproduce a stale run.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

import build_demo_bundle as bdb  # noqa: E402
from build_demos import COHORT_ROLES  # noqa: E402

MANIFEST = REPO / "frontend" / "src" / "data" / "demo-column-assignments.json"


def test_demo_manifest_matches_cohort_roles_and_headers() -> None:
    manifest = json.loads(MANIFEST.read_text())
    by_cohort = {e["cohort"]: e for e in manifest["entries"]}
    for cohort, filename in bdb.DEMO_CSVS.items():
        roles = COHORT_ROLES.get(cohort)
        if roles is None:
            continue
        assert cohort in by_cohort, f"{cohort} missing from manifest — rerun scripts/build_demo_bundle.py"
        entry = by_cohort[cohort]
        assert entry["roles"] == dict(roles), f"{cohort} roles drifted — rerun scripts/build_demo_bundle.py"
        headers = bdb._read_header(REPO / "backend" / "demos" / "data" / filename)
        assert entry["signature"] == bdb._header_signature(
            headers
        ), f"{cohort} header signature drifted — rerun scripts/build_demo_bundle.py"


def test_header_signature_is_order_and_case_independent() -> None:
    # Must stay identical to the frontend headerSignature() (lib/column-prefill.ts).
    assert bdb._header_signature([" Name ", "Age", "SEX"]) == bdb._header_signature(["sex", "age", "name"])
    assert bdb._header_signature(["A", "b", ""]) == "a|b"
