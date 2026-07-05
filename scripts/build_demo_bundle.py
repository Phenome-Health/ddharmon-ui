#!/usr/bin/env python3
"""Bundle the curated demo cohorts + build scripts into a downloadable zip for the Demo page.

Produces ``frontend/public/demo-cohorts.zip`` (served at ``/demo-cohorts.zip`` in dev and bundled into the
static Netlify build) so a user can grab the exact demo inputs + the scripts and reproduce a run locally.

The zip contains:
    aou.csv, clsa.csv, ukbb.csv   — the curated ~200-field demo dictionaries (backend/demos/data)
    build_demo_data.py            — how those subsets were curated from the full public example data
    build_demos.py                — runs the ddharmon pipeline over them to produce a harmonization run
    README.md                     — how to run it + pointers to the source repos

Re-run after the curated CSVs change:  python scripts/build_demo_bundle.py
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA_DIR = REPO / "backend" / "demos" / "data"
SCRIPTS = REPO / "scripts"
OUT = REPO / "frontend" / "public" / "demo-cohorts.zip"

# This zip is user-facing, so nothing in it may reveal a developer's local machine or the internal repo.
# The bundle build HARD-FAILS if any bundled file (or the README) matches one of these — a leak like an
# absolute home path or the internal repo name is a privacy issue, not a warning.
_LEAK_PATTERNS = [
    r"/Users/",  # macOS home
    r"\\Users\\",  # Windows home
    r"/home/[A-Za-z0-9._-]+/",  # Linux home
    r"Path\.home\(\)",  # resolves to a personal path at runtime — don't ship it in a script
    r"ai-coding",  # a developer's workspace convention (leak-scan-ignore)
    r"ph-arpa-data-harmonization",  # internal dev repo name; public repo is "ddharmon" (leak-scan-ignore)
    r"Insync",  # a developer's cloud-sync dir (leak-scan-ignore)
    re.escape(str(Path.home())),  # the literal current home directory
]


def _scan_for_leaks(named_texts: dict[str, str]) -> list[str]:
    """Return ``"name:line: content"`` for every line matching a leak pattern (empty list = clean)."""
    pats = [re.compile(p) for p in _LEAK_PATTERNS]
    hits: list[str] = []
    for name, text in named_texts.items():
        for i, line in enumerate(text.splitlines(), 1):
            if any(p.search(line) for p in pats):
                hits.append(f"{name}:{i}: {line.strip()[:100]}")
    return hits

README = """\
# ddharmon — curated demo cohorts

These are the exact inputs behind the ddharmon demo run: ~200-field curated subsets of three public
biomedical cohorts — **All of Us**, **CLSA**, and **UK Biobank** — chosen to overlap on common health &
demographic domains (sex, age, smoking, blood pressure, …) so a cross-cohort harmonization has real
matches to find.

## Contents
- `aou.csv`, `clsa.csv`, `ukbb.csv` — the curated demo dictionaries (REDCap / codebook style)
- `build_demo_data.py` — how these subsets were curated from the full public example data
- `build_demos.py`     — runs the ddharmon pipeline over them to produce a harmonization run

## Run it yourself
1. Install the tool: `pip install ddharmon`  → https://github.com/Phenome-Health/ddharmon
2. Get a CDE catalog: the full NIH CDE table ships in the ddharmon repo under `data/examples/`
   (`all_cdes_flat.tsv`); point `DDHARMON_CDE_DIR` at that folder.
3. Run (needs an Anthropic API key for the LLM stages):
   ```
   ANTHROPIC_API_KEY=sk-... DDHARMON_CDE_DIR=/path/to/ddharmon/data/examples \\
     python build_demos.py --mode batch --datasets aou clsa ukbb
   ```
   Use `--mode preview` for a free (no-LLM) clustering-only dry run.

## Full data + provenance
The full (unsubsetted) cohort example CSVs and the scripts that build them from each cohort's public
source live in the **ddharmon** repo under `data/examples/` (see `data/examples/README.md` for the
source-URL → script → CSV provenance table):
  https://github.com/Phenome-Health/ddharmon

This GUI and the demo build scripts live in the **ddharmon-ui** repo:
  https://github.com/Phenome-Health/ddharmon-ui
"""


def main() -> None:
    members = [
        DATA_DIR / "aou.csv",
        DATA_DIR / "clsa.csv",
        DATA_DIR / "ukbb.csv",
        SCRIPTS / "build_demo_data.py",
        SCRIPTS / "build_demos.py",
    ]
    missing = [str(p.relative_to(REPO)) for p in members if not p.exists()]
    if missing:
        raise SystemExit(f"missing bundle inputs: {missing}")

    # Privacy gate: refuse to ship if any bundled content reveals a local machine or the internal repo.
    named_texts = {"README.md": README}
    for p in members:
        named_texts[p.name] = p.read_text(errors="replace")
    leaks = _scan_for_leaks(named_texts)
    if leaks:
        raise SystemExit("refusing to build — user-facing bundle would leak local/internal paths:\n  " + "\n  ".join(leaks))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("ddharmon-demo-cohorts/README.md", README)
        for p in members:
            z.write(p, f"ddharmon-demo-cohorts/{p.name}")

    kb = OUT.stat().st_size // 1024
    print(f"Wrote {OUT.relative_to(REPO)}  ({len(members) + 1} files, {kb} KB) — privacy gate passed")


if __name__ == "__main__":
    main()
