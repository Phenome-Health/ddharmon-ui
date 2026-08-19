"""Drift checks: the UI's published content vs what the pipeline actually does.

The UI is a touchpoint for the pipeline, and several surfaces restate pipeline facts in hand-authored
form — the Methods page's stage manifest, the frontend's mirror of `PHASES_RUN`, the shipped demo.
Nothing kept them honest, and the drift was cumulative rather than per-change: `gencde` went
undocumented from the M12 work and was still undocumented on prod months later, and `refine` repeated
it. A deploy-time question can't catch that class of bug, because by then the drift is already old and
nobody is thinking about it. A test can.

Scope note: these assert facts that are DERIVABLE in-repo. Prose grounded in external truth
(benchmark numbers, design rationale) can't be asserted here — that's what the `verifiedAgainst`
provenance stamps and the deploy skill's content gate are for.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
MANIFEST = REPO / "frontend" / "src" / "data" / "pipeline-stages.ts"
DEMO_DIR = REPO / "backend" / "demos"


def _manifest_src() -> str:
    if not MANIFEST.exists():  # pragma: no cover - the frontend is always present in this repo
        pytest.skip(f"stage manifest not found at {MANIFEST}")
    return MANIFEST.read_text()


def _ts_phases_const(src: str) -> list[str]:
    """The frontend's own mirror of PHASES_RUN (`export const PHASES_RUN = [...] as const`)."""
    m = re.search(r"export const PHASES_RUN\s*=\s*\[(.*?)\]\s*as const", src, re.S)
    assert m, "could not find the PHASES_RUN const in the stage manifest"
    return re.findall(r'"([a-z_]+)"', m.group(1))


def _documented_phases(src: str) -> list[str]:
    """Each stage entry's `phase:` field, in manifest order (`null` entries have no progress bar)."""
    return re.findall(r'phase:\s*"([a-z_]+)"', src)


def test_frontend_phase_const_matches_the_backend() -> None:
    """The frontend duplicates PHASES_RUN; the copy must not drift from the contract."""
    from backend.engine.contract import PHASES_RUN

    assert _ts_phases_const(_manifest_src()) == list(PHASES_RUN), (
        "frontend/src/data/pipeline-stages.ts PHASES_RUN has drifted from "
        "backend/engine/contract.py PHASES_RUN — update the frontend copy"
    )


def test_every_pipeline_phase_is_documented_on_the_methods_page() -> None:
    """A new/renamed backend phase with no Methods-page entry must fail loudly.

    This is the check the manifest's own header asked for. Without it a shipped stage is invisible to
    every reader of the Methods page while the app cheerfully reports its progress bar.
    """
    from backend.engine.contract import PHASES_RUN

    documented = _documented_phases(_manifest_src())
    missing = [p for p in PHASES_RUN if p not in documented]
    assert not missing, (
        f"pipeline phase(s) {missing} run but are undocumented on the Methods page — "
        f"add a stage entry to frontend/src/data/pipeline-stages.ts"
    )


def test_no_documented_stage_claims_a_phase_that_does_not_exist() -> None:
    """The converse: a removed/renamed phase must not linger as a documented stage."""
    from backend.engine.contract import PHASES_RUN

    phantom = [p for p in _documented_phases(_manifest_src()) if p not in PHASES_RUN]
    assert not phantom, (
        f"the Methods page documents phase(s) {phantom} that the pipeline no longer reports — "
        f"remove or re-point those stage entries"
    )


def test_documented_stage_order_follows_the_pipeline() -> None:
    """Stages that map to a real phase must appear in the order the pipeline runs them.

    The Methods page renders a stage-flow spine from this array, so a mis-ordered entry draws a
    pipeline that does not exist — e.g. refine authoring runs AFTER spec generation, not before.
    """
    from backend.engine.contract import PHASES_RUN

    documented = _documented_phases(_manifest_src())
    order = {p: i for i, p in enumerate(PHASES_RUN)}
    ranks = [order[p] for p in documented if p in order]
    assert ranks == sorted(
        ranks
    ), f"documented stage order {documented} does not follow pipeline order {list(PHASES_RUN)}"


CONTENT_MANIFESTS = ["pipeline-stages.ts", "benchmarks.ts", "design-choices.ts", "roadmap.ts"]


@pytest.mark.parametrize("manifest", CONTENT_MANIFESTS)
def test_every_content_manifest_carries_a_provenance_stamp(manifest: str) -> None:
    """A page's hand-authored content must declare when it was last checked against the pipeline.

    Presence only — FRESHNESS is deliberately not asserted here. The stamp records a core commit, and
    the core installed locally differs from the one on a deploy target, so a freshness assertion would
    fail for environmental reasons and get muted. Freshness is reported by
    `scripts/check_content_provenance.py`, which the deploy skill runs against the target's core.
    """
    path = REPO / "frontend" / "src" / "data" / manifest
    if not path.exists():  # pragma: no cover
        pytest.skip(f"{manifest} not present")
    assert "VERIFIED_AGAINST" in path.read_text(), (
        f"{manifest} backs a public content page but declares no VERIFIED_AGAINST stamp — "
        f"add one (see frontend/src/data/content-provenance.ts)"
    )


@pytest.mark.parametrize("snapshot", sorted(DEMO_DIR.glob("*.json")) if DEMO_DIR.exists() else [])
def test_shipped_demo_reflects_the_current_phase_list(snapshot: Path) -> None:
    """A shipped demo built before a pipeline change advertises a stale phase list.

    That is the cheap, mechanical half of the demo-freshness rule — it catches a snapshot whose SHAPE
    predates the pipeline. It cannot tell you the snapshot's CONTENT is stale (records that never saw
    the new stage), which is why the deploy skill still gates on a human green-light.
    """
    from backend.engine.contract import PHASES_RUN

    payload = json.loads(snapshot.read_text())
    result = payload.get("result")
    if not isinstance(result, dict) or "phases" not in result:
        pytest.skip(f"{snapshot.name} carries no phase list")
    assert result["phases"] == list(PHASES_RUN), (
        f"{snapshot.name} was built against phases {result['phases']} but the pipeline now reports "
        f"{list(PHASES_RUN)} — rebuild the demo (see the deploy skill, §C2)"
    )


# ── The token layer is the only place a colour is allowed to be spelled out ──────────
#
# UI-SPEC §5.6 (R10). A colour literal in a component is a retheme that silently does not
# happen: `index.css` is re-pointed, the component keeps painting last year's brand, and
# nothing fails. The acceptance criterion is "no colour literals outside the token
# definitions", and a criterion nobody can run is a criterion that rots — so it is a test.

FRONTEND_SRC = REPO / "frontend" / "src"
TOKEN_DEFINITIONS = FRONTEND_SRC / "index.css"
SOURCE_SUFFIXES = {".ts", ".tsx", ".css"}
HEX_LITERAL = re.compile(r"#[0-9a-fA-F]{6}\b")


def _frontend_sources() -> list[Path]:
    return sorted(
        p
        for p in FRONTEND_SRC.rglob("*")
        if p.is_file() and p.suffix in SOURCE_SUFFIXES and p != TOKEN_DEFINITIONS
    )


def test_no_hex_literals() -> None:
    """A six-digit colour literal anywhere under frontend/src except index.css is a defect.

    Reports file, line and value, because "there is a literal somewhere" is not actionable.
    """
    if not FRONTEND_SRC.exists():  # pragma: no cover - the frontend is always present
        pytest.skip(f"frontend source tree not found at {FRONTEND_SRC}")

    offenders: list[str] = []
    for path in _frontend_sources():
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            for literal in HEX_LITERAL.findall(line):
                offenders.append(f"{path.relative_to(REPO)}:{lineno}: {literal}")

    assert not offenders, (
        f"{len(offenders)} colour literal(s) live outside the token definitions in "
        f"{TOKEN_DEFINITIONS.relative_to(REPO)} — move each onto a token so a retheme "
        f"reaches it (UI-SPEC §5.6):\n  " + "\n  ".join(offenders)
    )
