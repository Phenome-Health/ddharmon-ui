#!/usr/bin/env python3
"""Report which UI content manifests are unverified against the pipeline being deployed.

The Methods / Benchmarks / Design / Roadmap pages restate pipeline facts as hand-authored prose.
The mechanically-checkable parts (stage list, phase order, demo phase list) are enforced by
`tests/test_content_drift.py`. The rest can only be re-read by a human — so each manifest carries a
`VERIFIED_AGAINST` stamp (see frontend/src/data/content-provenance.ts) recording the core commit and
contract version it was last checked against. This script diffs those stamps against the pipeline you
are about to ship and prints what needs a re-read.

    # against the local checkout's contract + the core installed here
    python scripts/check_content_provenance.py

    # against the core actually running on a deploy target (read its direct_url.json first)
    python scripts/check_content_provenance.py --core-commit f92abb6

Exit codes: 0 = every manifest is current, 1 = at least one is stale or unbaselined. The deploy skill
treats a non-zero exit as "ask the operator", NOT as a hard block — stale prose is a judgement call
(a core bump often does not touch what a given page claims), and auto-blocking would train people to
bypass the check.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA_DIR = REPO / "frontend" / "src" / "data"

# manifest file -> the page it backs, for a message that says where to look
MANIFESTS = {
    "pipeline-stages.ts": "Methods",
    "benchmarks.ts": "Benchmarks",
    "design-choices.ts": "Design",
    "roadmap.ts": "Roadmap",
}

UNVERIFIED = {"unverified", "unknown", "never", ""}


def read_stamp(path: Path) -> dict[str, str] | None:
    """Parse the `VERIFIED_AGAINST` object literal out of a manifest, or None if it has no stamp."""
    m = re.search(r"VERIFIED_AGAINST\s*:\s*ContentProvenance\s*=\s*\{(.*?)\}", path.read_text(), re.S)
    if not m:
        return None
    return dict(re.findall(r'(\w+)\s*:\s*"([^"]*)"', m.group(1)))


def current_contract_version() -> str:
    src = (REPO / "backend" / "engine" / "contract.py").read_text()
    m = re.search(r'CONTRACT_VERSION\s*=\s*"([^"]+)"', src)
    return m.group(1) if m else "?"


def installed_core_commit() -> str:
    """Short commit of the ddharmon core installed in THIS environment (best-effort)."""
    try:
        out = subprocess.run(
            [
                sys.executable,
                "-c",
                "import importlib.metadata as m,json;"
                "print(json.loads(m.distribution('ddharmon').read_text('direct_url.json'))"
                ".get('vcs_info',{}).get('commit_id',''))",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return (out.stdout or "").strip()[:7]
    except Exception:  # noqa: BLE001 — advisory tool; an unknown core is reported, not fatal
        return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--core-commit", default=None, help="core commit being deployed (else: installed core)")
    args = ap.parse_args()

    core = (args.core_commit or installed_core_commit() or "")[:7]
    contract = current_contract_version()
    print(f"pipeline being checked against: core={core or '(unknown)'} contract={contract}\n")

    stale: list[str] = []
    for fname, page in MANIFESTS.items():
        path = DATA_DIR / fname
        if not path.exists():
            print(f"  ?  {page:<11} {fname} — not found")
            continue
        stamp = read_stamp(path)
        if stamp is None:
            stale.append(page)
            print(f"  !  {page:<11} NO provenance stamp — add one (see content-provenance.ts)")
            continue
        sc, sv = stamp.get("coreCommit", ""), stamp.get("contractVersion", "")
        if sc in UNVERIFIED or sv in UNVERIFIED:
            stale.append(page)
            print(f"  !  {page:<11} never baselined — {stamp.get('scope', '')}")
        elif (core and sc[:7] != core) or sv != contract:
            stale.append(page)
            print(f"  !  {page:<11} verified against core={sc} contract={sv} (checked {stamp.get('checkedOn')})")
        else:
            print(f"  ok {page:<11} current (checked {stamp.get('checkedOn')})")

    if stale:
        print(
            f"\n{len(stale)} manifest(s) need a re-read: {', '.join(stale)}\n"
            "Re-read the content against the pipeline, then bump that manifest's VERIFIED_AGAINST.\n"
            "Do NOT bump a stamp you did not actually re-read — that launders an unverified claim."
        )
        return 1
    print("\nall content manifests are current.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
