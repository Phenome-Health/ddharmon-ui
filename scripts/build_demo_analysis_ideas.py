"""Pre-generate "analysis ideas" for each demo and write them to a small sidecar file.

The demo runs are guest-facing (no API key), so their "Analysis ideas" panel can't call the LLM live.
This bakes the ideas ONCE, offline, using the SAME generator the live feature uses
(``backend.analysis_ideas.generate_analysis_ideas``) over each demo's harmonized records, and writes them
to ``backend/demos/analysis_ideas.json`` keyed by snapshot filename. ``backend.demos.seed_demos`` then
surfaces them on the seeded demo job, so a guest sees real, grounded ideas with no LLM call.

The multi-MB snapshots are left untouched — only the tiny sidecar is written.

Usage:
    ANTHROPIC_API_KEY=sk-ant-... python scripts/build_demo_analysis_ideas.py [--force]

Idempotent: skips a demo that already has ideas in the sidecar unless ``--force``. One metadata-only LLM
call per demo (a few cents total).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

from backend.analysis_ideas import generate_analysis_ideas  # noqa: E402
from backend.demos import _DIR, _IDEAS, list_demos, load_snapshot  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="regenerate even if the sidecar already has ideas")
    ap.add_argument("--model", default="claude-sonnet-4-6", help="Anthropic model to generate with")
    args = ap.parse_args()

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print("ERROR: set ANTHROPIC_API_KEY (one metadata-only call per demo).", file=sys.stderr)
        return 1

    from ddharmon.llm.anthropic_client import AnthropicClient

    client = AnthropicClient(model_name=args.model, api_key=key)

    combos = [c for c in list_demos()["combos"] if c.get("available")]
    if not combos:
        print("No available demo combos (no snapshots present).", file=sys.stderr)
        return 1

    sidecar: dict[str, list] = {}
    if _IDEAS.exists():
        sidecar = json.loads(_IDEAS.read_text())

    for combo in combos:
        snapshot = combo["snapshot"]
        if sidecar.get(snapshot) and not args.force:
            print(f"skip {snapshot} — sidecar already has {len(sidecar[snapshot])} ideas (use --force)")
            continue
        snap = load_snapshot(combo["datasets"])
        result = (snap or {}).get("result", snap) or {}
        records = result.get("records", [])
        out = generate_analysis_ideas(records, client.complete)
        sidecar[snapshot] = out["ideas"]
        print(f"{snapshot}: {len(out['ideas'])} ideas from {out['nConcepts']} cross-cohort concepts")

    _IDEAS.write_text(json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {_IDEAS.relative_to(_DIR.parent.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
