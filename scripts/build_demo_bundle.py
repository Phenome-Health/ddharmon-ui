#!/usr/bin/env python3
"""Bundle the curated demo cohorts + build scripts into a downloadable zip for the Demo page.

Produces ``frontend/public/demo-cohorts.zip`` (served at ``/demo-cohorts.zip`` in dev and bundled into the
static Netlify build) so a user can grab the exact demo inputs + the scripts and reproduce a run locally.

The zip contains:
    {aou,clsa,ukbb,mesa,aireadi}.csv  — the curated 200-field demo dictionaries (backend/demos/data)
    build_demo_data.py                — how those subsets were curated from the full public example data
    build_demos.py                    — runs the ddharmon pipeline over them to produce a harmonization run
    README.md                         — per-cohort provenance (public source → build script) + how to run it

Re-run after the curated CSVs change:  python scripts/build_demo_bundle.py
"""

from __future__ import annotations

import csv
import json
import re
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA_DIR = REPO / "backend" / "demos" / "data"
SCRIPTS = REPO / "scripts"
OUT = REPO / "frontend" / "public" / "demo-cohorts.zip"
# App-bundled manifest of canonical column assignments — the New Run flow reads it to prefill the mapping
# when a demo-zip CSV is dropped in (recognized by header signature), reproducing the showcased run.
MANIFEST_OUT = REPO / "frontend" / "src" / "data" / "demo-column-assignments.json"

sys.path.insert(0, str(SCRIPTS))
from build_demos import COHORT_ROLES  # noqa: E402  — single source of truth for the canonical demo role map

# The five CSVs the demo zip ships (cohort id -> filename in backend/demos/data).
DEMO_CSVS = {"aou": "aou.csv", "clsa": "clsa.csv", "ukbb": "ukbb.csv", "mesa": "mesa.csv", "aireadi": "aireadi.csv"}

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

These are the exact inputs behind the ddharmon demo run: **200-field curated subsets of five public
biomedical cohorts** — All of Us, CLSA, UK Biobank, MESA, and AI-READI — chosen to overlap on common
health & demographic domains (sex, age, smoking, blood pressure, …) so a cross-cohort harmonization has
real matches to find.

## Contents
- `aou.csv`, `clsa.csv`, `ukbb.csv`, `mesa.csv`, `aireadi.csv` — the curated demo dictionaries
- `build_demo_data.py` — how these 200-field subsets were curated from the full public example data
- `build_demos.py`      — runs the ddharmon pipeline over them to produce a harmonization run

## Provenance — where each cohort's dictionary comes from
These are **metadata only** (field names, questions, value codings — data *dictionaries*, never
participant-level data), drawn from each project's openly published, no-login catalog. Each ingested CSV
is reproducible from its public source via a script in the **ddharmon** repo's `scripts/` folder:

| Cohort | Public source (data dictionary) | Build script (ddharmon repo) |
|--------|----------------------------------|------------------------------|
| **All of Us** | All of Us Survey Data Codebooks — https://www.researchallofus.org/data-tools/survey-explorer/ | `scripts/build_all_of_us_csv.py` |
| **CLSA** | CLSA Data Dictionaries — https://www.clsa-elcv.ca/resource-types/data-dictionaries/ | `scripts/build_clsa_csv.py` |
| **UK Biobank** | UKB Showcase Schema — https://biobank.ndph.ox.ac.uk/showcase/schema.cgi | `scripts/build_ukbb_csv.py` |
| **MESA** | dbGaP phs000209 public variable summaries — https://www.ncbi.nlm.nih.gov/projects/gap/cgi-bin/study.cgi?study_id=phs000209 | `scripts/build_dbgap_csv.py` |
| **AI-READI** | AI-READI/DataElementMaps (MIT) — https://github.com/AI-READI/DataElementMaps | `scripts/build_aireadi_csv.py` |
| **NIH CDEs** (the target backbone) | NIH CDE Repository — https://cde.nlm.nih.gov/ | `scripts/flatten_cde_repo.py` |

Full source→script→CSV provenance table (with the exact reproduce commands):
https://github.com/Phenome-Health/ddharmon/blob/main/data/examples/README.md

`build_demo_data.py` (included here) then curates each full cohort dictionary down to a 200-field subset,
taking fields that hit shared health/demographic domains first (so the cohorts overlap) and filling the
rest to reach 200 — see its docstring for the exact rule.

## Run it yourself
1. Install the tool: `pip install ddharmon`  → https://github.com/Phenome-Health/ddharmon
2. Get a CDE catalog: the full NIH CDE table ships in the ddharmon repo under `data/examples/`
   (`all_cdes_flat.tsv`); point `DDHARMON_CDE_DIR` at that folder.
3. Run (needs an Anthropic API key for the LLM stages):
   ```
   ANTHROPIC_API_KEY=sk-... DDHARMON_CDE_DIR=/path/to/ddharmon/data/examples \\
     python build_demos.py --mode batch --datasets aou clsa ukbb mesa aireadi
   ```
   Use `--mode preview` for a free (no-LLM) clustering-only dry run.

## Column roles used
The demo maps only the **core** columns a user would map, split two ways — question/semantic
(`variable_name`, `question_text`, `description`) and response/value (`value_encoding`, `units`,
`data_type`). Organizational/external-id columns (category, field_id, and any pre-existing standard/CDE
code) are deliberately left unmapped — the last so the demo never sees the gold answer. The exact
per-cohort role map is in `build_demos.py` (`COHORT_ROLES`).

This GUI and the demo build scripts live in the **ddharmon-ui** repo:
  https://github.com/Phenome-Health/ddharmon-ui
"""


def _header_signature(headers: list[str]) -> str:
    """Order-independent key from a CSV's column names. MUST match the frontend's headerSignature()
    (lib/column-prefill.ts): trim + lowercase each column, drop empties, sort, join with '|'."""
    return "|".join(sorted(h.strip().lower() for h in headers if h.strip()))


def _read_header(path: Path) -> list[str]:
    with open(path, newline="") as fh:
        return next(csv.reader(fh), [])


def write_manifest() -> None:
    """Emit the canonical demo column-assignment manifest the New Run flow uses to prefill the mapping.

    Keyed by header signature so a dropped demo CSV is recognized regardless of filename. Sourced from
    build_demos.COHORT_ROLES so it can never drift from the mapping that produced the showcased run.
    """
    entries = []
    for cohort, filename in DEMO_CSVS.items():
        roles = COHORT_ROLES.get(cohort)
        if roles is None:  # cohort absent from the role map (e.g. an extra demo not in the shipped set) — skip
            continue
        headers = _read_header(DATA_DIR / filename)
        missing = [c for c in roles.values() if c not in headers]
        if missing:
            raise SystemExit(f"{cohort}: canonical role columns not in {filename} header: {missing}")
        entries.append(
            {"cohort": cohort, "filename": filename, "signature": _header_signature(headers), "roles": dict(roles)}
        )
    MANIFEST_OUT.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_OUT.write_text(json.dumps({"version": 1, "entries": entries}, indent=2) + "\n")
    print(f"Wrote {MANIFEST_OUT.relative_to(REPO)}  ({len(entries)} demo cohorts)")


def main() -> None:
    members = [
        DATA_DIR / "aou.csv",
        DATA_DIR / "clsa.csv",
        DATA_DIR / "ukbb.csv",
        DATA_DIR / "mesa.csv",
        DATA_DIR / "aireadi.csv",
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
        raise SystemExit(
            "refusing to build — user-facing bundle would leak local/internal paths:\n  " + "\n  ".join(leaks)
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("ddharmon-demo-cohorts/README.md", README)
        for p in members:
            z.write(p, f"ddharmon-demo-cohorts/{p.name}")

    kb = OUT.stat().st_size // 1024
    print(f"Wrote {OUT.relative_to(REPO)}  ({len(members) + 1} files, {kb} KB) — privacy gate passed")

    # Emit the app-bundled column-assignment manifest (prefill for the New Run flow) alongside the zip.
    write_manifest()


if __name__ == "__main__":
    main()
