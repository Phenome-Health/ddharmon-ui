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
ROLE_MANIFEST = FRONTEND_SRC / "tokens" / "role-manifest.json"
SOURCE_SUFFIXES = {".ts", ".tsx", ".css"}

# Three-, six- and eight-digit hex. The six-digit-only form this replaces was blind to `#fff`,
# which is how a literal white sat in the analytics heatmap through a whole retheme.
HEX_LITERAL = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
# `rgb()` / `rgba()` / `hsl()` written out with NUMBERS is the same bypass in another notation:
# `rgba(17, 54, 130, .3)` is #113682, the PREVIOUS brand's navy, and it survived the 2026 retheme
# in two files precisely because the hex gate could not see it. A `color-mix(... var(--role) ...)`
# is fine — it is derived from a token — so the check is for numeric channels, not for the function.
NUMERIC_COLOUR_FN = re.compile(r"\b(?:rgba?|hsla?)\(\s*[\d.]+[\s,%]")
# CSS named colours that mean a specific paint. `transparent`, `currentColor` and `inherit` are
# relationships rather than colours and are allowed.
NAMED_COLOUR = re.compile(
    r"\b(?:bg|text|border|fill|stroke|ring|from|via|to|decoration|divide|outline|caret|accent|shadow)"
    r"-(?:white|black)\b"
)

# ── Two exemptions, each narrow and each with a reason ────────────────────────────────
#
# `components/ui/chart.tsx` matches recharts' OWN emitted markup with attribute selectors —
# `[&_.recharts-dot[stroke='#fff']]:stroke-transparent`. Those hexes are selectors, not paint:
# they name a colour recharts writes so the rule can override it. Rewriting them would break the
# match. Recorded rather than allowed wholesale: the exemption is per-file and per-pattern.
SELECTOR_HEX_FILES = {"components/ui/chart.tsx"}
SELECTOR_HEX = re.compile(r"\[[^\]]*['\"]#[0-9a-fA-F]{3,8}['\"][^\]]*\]")


def _frontend_sources() -> list[Path]:
    return sorted(
        p
        for p in FRONTEND_SRC.rglob("*")
        if p.is_file() and p.suffix in SOURCE_SUFFIXES and p != TOKEN_DEFINITIONS
    )


def _rel(path: Path) -> str:
    return path.relative_to(FRONTEND_SRC).as_posix()


def test_no_hex_literals() -> None:
    """No spelled-out colour anywhere under frontend/src except index.css.

    Widened from six-digit hex to every notation a colour can hide in: 3/4/6/8-digit hex,
    numeric `rgb()`/`rgba()`/`hsl()`, and the `text-white` / `bg-black` utilities. All three
    forms were live in this tree while the six-digit gate reported success — including two
    values from the PREVIOUS brand, which is the exact failure the gate exists to prevent:
    a retheme that silently does not reach a component.

    Reports file, line and value, because "there is a literal somewhere" is not actionable.
    """
    if not FRONTEND_SRC.exists():  # pragma: no cover - the frontend is always present
        pytest.skip(f"frontend source tree not found at {FRONTEND_SRC}")

    offenders: list[str] = []
    for path in _frontend_sources():
        rel = _rel(path)
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            probe = SELECTOR_HEX.sub("", line) if rel in SELECTOR_HEX_FILES else line
            for literal in HEX_LITERAL.findall(probe):
                offenders.append(f"{rel}:{lineno}: {literal}")
            for literal in NUMERIC_COLOUR_FN.findall(probe):
                offenders.append(f"{rel}:{lineno}: {literal.strip()}… (numeric colour function)")
            for literal in NAMED_COLOUR.findall(probe):
                offenders.append(f"{rel}:{lineno}: {literal} (named colour)")

    assert not offenders, (
        f"{len(offenders)} colour literal(s) live outside the token definitions in "
        f"{TOKEN_DEFINITIONS.relative_to(REPO)} — move each onto a ROLE so a retheme "
        f"reaches it (UI-SPEC §5.6):\n  " + "\n  ".join(offenders)
    )


# ── The staged flow is not free until the reviewer chooses ────────────────────────────
#
# UI-SPEC §0.4 / §7.2. `ddharmon-ui` is a public repo and its roadmap routes are
# unauthenticated, so a cost claim the product no longer honours misleads a visitor about
# money. Under §0.1 the first charge is Gate 0's Continue — it pays for concept
# generation, splitting and the coherence judge — so "step 1 is free, you choose what to
# spend on" is false FOR THE STAGED FLOW.
#
# The same sentence shape is still TRUE about **preview run mode**, which calls no model
# at all. A test that banned the word "free" would force those true statements into
# silence, which is its own dishonesty — so the assertion discriminates on the SUBJECT of
# the claim, not on a keyword. Note that it cannot discriminate on "no model is called":
# the false claim uses exactly that reasoning, applied to a stage of the staged flow.

_FREE_CLAIM = re.compile(
    r"\b(free|costs? nothing|cost nothing|no charge|nothing to pay|at no cost)\b", re.I
)
_STAGED_SUBJECT = re.compile(
    r"\b(step 1|step one|first step|this step|grouping comes first|concept groups?|"
    r"staged (?:flow|review)|gate 0|first gate)\b",
    re.I,
)
# "preview" as the RUN MODE, not the word anywhere in a sentence: a page that merely
# mentions a preview must not buy itself an exemption from the claim.
_PREVIEW_SUBJECT = re.compile(
    r"\bpreview (?:run )?mode\b|\bpreview runs?\b|\bin preview\b|\bpreview:", re.I
)

# `pages/preview-staged-review.tsx` carries the false claim and is NOT edited here: D-16
# retires its ROUTE with a redirect (plan 08-17), which removes the claim from the product
# rather than rewording a page nobody can reach. Excluded by path, with the file's
# existence asserted so a rename cannot silently widen the exclusion.
CLAIM_EXCLUSIONS = ("pages/preview-staged-review.tsx",)


def _staged_flow_free_claims(text: str) -> list[str]:
    """Sentences claiming the STAGED FLOW costs nothing. Preview-run-mode sentences pass."""
    flat = " ".join(text.split())
    hits = []
    for sentence in re.split(r"(?<=[.!?])\s+", flat):
        if _PREVIEW_SUBJECT.search(sentence):
            continue
        free = _FREE_CLAIM.search(sentence)
        if free and _STAGED_SUBJECT.search(sentence):
            # Report a window around the claim, not the whole sentence: source files carry
            # few full stops, so a "sentence" can be half a component and unreadable.
            lo, hi = max(0, free.start() - 90), min(len(sentence), free.end() + 90)
            excerpt = sentence[lo:hi].strip()
            hits.append(("…" if lo else "") + excerpt + ("…" if hi < len(sentence) else ""))
    return hits


def test_the_staged_flow_spend_claim_detector_distinguishes_the_two_claims() -> None:
    """The discriminator is the claim's subject, not the word "free".

    Fixtures, not the tree: the tree is expected to be clean, so a walk alone would pass
    vacuously and could not show the assertion tells the two claims apart.
    """
    false_about_the_staged_flow = [
        "step 1 is free, you choose what to spend on",
        "Runs on your machine. No model is called, so this step is free and you can adjust it.",
        "Grouping comes first, costs nothing, and is adjustable.",
        "Reviewing your concept groups is free until you decide what to buy.",
    ]
    true_about_preview_run_mode = [
        "Preview runs no LLM — free.",
        "No LLM — clustering + retrieval only, to inspect groupings before spending credits.",
        "Preview run mode calls no model at all, so this step is free.",
        "Local · free",
    ]
    for claim in false_about_the_staged_flow:
        assert _staged_flow_free_claims(claim), f"should be flagged but was not: {claim!r}"
    for claim in true_about_preview_run_mode:
        assert not _staged_flow_free_claims(claim), f"should NOT be flagged: {claim!r}"


def test_no_public_surface_claims_the_staged_flow_is_free() -> None:
    """The staged flow's first charge is Gate 0's Continue, and the copy must say so."""
    if not FRONTEND_SRC.exists():  # pragma: no cover
        pytest.skip(f"frontend source tree not found at {FRONTEND_SRC}")
    for excluded in CLAIM_EXCLUSIONS:
        assert (FRONTEND_SRC / excluded).exists(), (
            f"the claim exclusion {excluded} names a file that no longer exists — "
            f"drop the exclusion rather than leaving it to cover something else"
        )

    offenders: list[str] = []
    for path in _frontend_sources():
        rel = path.relative_to(FRONTEND_SRC).as_posix()
        if rel in CLAIM_EXCLUSIONS:
            continue
        for claim in _staged_flow_free_claims(path.read_text()):
            offenders.append(f"{path.relative_to(REPO)}: {claim}")

    assert not offenders, (
        "an unauthenticated surface claims the staged flow costs nothing until the "
        "reviewer chooses. The first charge is Gate 0's Continue (concept generation, "
        "splitting, the coherence judge); the reviewer scopes before the BULK of the "
        "spend, not before all of it (UI-SPEC §0.4, §7.2):\n  " + "\n  ".join(offenders)
    )


# ── Tier 3: components reference ROLES, never a primitive and never a palette slot ────
#
# The token layer is three tiers (see the headers in `index.css`):
#
#   tier 1  --brand-*        named for the VALUE. Replaced wholesale on a rebrand.
#   tier 2  --surface-* / --on-* / --status-* / --rule-* / --link-* / --series-*
#                            named for the ROLE, and every surface carries its foreground
#                            as a BOUND PAIR so the two cannot drift.
#   tier 3  the utilities    what components are allowed to reference.
#
# A palette SLOT (`bg-neutral-50`, `text-ph-ink`, `text-neutral-400`) is not a role. It names a
# step on a ramp, which says nothing about which surface the text sits on — so it cannot be
# remapped as a pair, and a surface change cannot be expressed as a token edit. That is the
# mechanism behind the defect this whole plan exists to remove: the content field inherited the
# CHROME's cream foreground and bare copy rendered cream-on-cream, and no gate could see it
# because "text-neutral-400" is not a statement about a background.

PALETTE_SLOT = re.compile(
    r"\b(?:bg|text|border|divide|ring|from|via|to|fill|stroke|placeholder|caret|accent|outline"
    r"|decoration|shadow)-(?:neutral|ph)-[a-zA-Z0-9]+(?:/\d+)?\b"
)

# Tailwind's OWN default palette. Worse than a slot: it is not wired to the token layer at all, so
# it would survive a rebrand untouched. The rebrand drill cannot see these because the states that
# render them (composite feasibility badges, an error banner) never appear in the static demo.
DEFAULT_PALETTE = re.compile(
    r"\b(?:bg|text|border|divide|ring|from|via|to|fill|stroke|placeholder|caret|accent|outline"
    r"|decoration|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo"
    r"|violet|purple|fuchsia|pink|rose|slate|gray|zinc|stone)-\d{2,3}(?:/\d+)?\b"
)

# Raw `var(--token)` reads. Components may read a tier-2 ROLE by name (charts and SVG attributes
# have to, because a colour consumed in JS cannot come from a utility) but never a tier-1
# primitive and never a name that no longer exists.
VAR_READ = re.compile(r"var\(\s*(--[a-zA-Z0-9-]+)")
ROLE_PREFIXES = (
    "--surface-", "--on-", "--rule-", "--link-", "--accent", "--status-", "--series-",
    "--focus-ring-", "--elevation-",
)
# Names that are NOT ours: Radix and shadcn set these on the element themselves.
FOREIGN_VAR_PREFIXES = ("--radix-", "--sidebar-", "--skeleton-", "--spacing-", "--radius", "--tw-")


def _declared_root_tokens() -> set[str]:
    """Every custom property `index.css` declares in `:root` (tiers 1 and 2)."""
    src = TOKEN_DEFINITIONS.read_text()
    return set(re.findall(r"^\s*(--[a-zA-Z0-9-]+)\s*:", src, re.M))


def _role_manifest() -> dict:
    return json.loads(ROLE_MANIFEST.read_text())


def test_the_role_manifest_matches_the_declared_role_layer() -> None:
    """Every role the manifest names must exist in index.css, and vice versa for surfaces.

    This is the gate that makes "a new surface cannot ship without its contrast pair" true rather
    than aspirational: the manifest is the contrast suite's input, so a surface with no manifest
    row is a surface with no contrast assertion.
    """
    declared = _declared_root_tokens()
    m = _role_manifest()
    named: set[str] = set()
    for s in m["surfaces"]:
        named.add(s["role"])
        named.update(f["role"] for f in s["foregrounds"])
        named.update(r["role"] for r in s["rules"])
    named.update(m["graphicalMarks"]["roles"])
    named.add(m["graphicalMarks"]["surface"])
    for f in m["focus"]:
        named.add(f["ring"])
        named.add(f["surface"])
    for p in m["prohibited"]:
        named.add(p["fg"])
        named.add(p["bg"])

    phantom = sorted(named - declared)
    assert not phantom, (
        f"the role manifest names {phantom} but {TOKEN_DEFINITIONS.name} does not declare them — "
        f"the contrast suite would measure an unresolved role"
    )

    # The converse, restricted to SURFACES: a surface with no manifest row has no asserted
    # foreground, which is exactly the gap that let the field/copy pairing ship broken.
    surfaces = {t for t in declared if t.startswith("--surface-")}
    unregistered = sorted(surfaces - named)
    assert not unregistered, (
        f"{unregistered} are declared as surfaces but carry no row in "
        f"{ROLE_MANIFEST.relative_to(REPO)}. A surface without a manifest row has no contrast "
        f"assertion for its foreground — add the pair (and its required level) rather than "
        f"shipping an unmeasured surface"
    )


def test_every_manifest_utility_is_safelisted() -> None:
    """Each manifest role's utility must be safelisted, or it may generate nothing.

    Tailwind v4 emits a utility only where it finds the class in a source file. A role whose call
    sites have not been migrated yet would therefore generate NOTHING — indistinguishable from the
    `--font-size-*` class of namespace mistake, where six keys produced no utilities at all while a
    grep gate reported success. Safelisting makes each one provable in the built stylesheet.
    """
    safelisted = set(re.findall(r'@source inline\("([^"]+)"\)', TOKEN_DEFINITIONS.read_text()))
    classes = {c for group in safelisted for c in group.split()}
    m = _role_manifest()
    wanted: set[str] = set()
    for s in m["surfaces"]:
        wanted.add(s["utility"])
        wanted.update(f["utility"] for f in s["foregrounds"])
        wanted.update(r["utility"] for r in s["rules"])
    missing = sorted(wanted - classes)
    assert not missing, (
        f"{missing} are named in the role manifest but not safelisted in "
        f"{TOKEN_DEFINITIONS.name} — add them to an `@source inline(...)` line"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "EXPECTED TO FAIL until 08-07 Part 2 migrates pages/composite.tsx. Every hit is on a "
        "conditional state (feasibility badges, an upload error banner) that the static demo never "
        "renders, so the rebrand drill cannot see them — this is the only gate that can. "
        "`strict=True`: when Part 2 lands, the unexpected pass fails the suite and forces the "
        "marker off."
    ),
)
def test_no_default_palette_utilities() -> None:
    """Tailwind's own palette bypasses the token layer entirely.

    `bg-amber-50` is not wired to any brand primitive, so it would survive a rebrand untouched.
    The rendered rebrand drill cannot catch these: every one of them is on a conditional state
    (composite feasibility badges, an upload error banner) that the static demo never reaches.
    """
    offenders: list[str] = []
    for path in _frontend_sources():
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            for hit in DEFAULT_PALETTE.findall(line):
                offenders.append(f"{_rel(path)}:{lineno}: {hit}")
    assert not offenders, (
        f"{len(offenders)} Tailwind default-palette utility/utilities bypass the token layer "
        f"completely — map each onto a status role (--status-ok / --status-warn / --status-danger "
        f"and their washes):\n  " + "\n  ".join(offenders)
    )


def test_components_read_only_role_tokens() -> None:
    """A `var()` read must name a tier-2 ROLE, never a tier-1 primitive and never a dead name.

    Charts and SVG attributes have to read a colour by name — a value consumed in JS cannot come
    from a utility — so this is the one sanctioned way a component touches the token layer, and it
    is worth policing. It also catches the failure that is otherwise invisible: `var(--sf-700)`
    resolves to NOTHING, and because an invalid `var()` falls back to the INHERITED value the
    element keeps rendering something plausible. Four such reads survived a whole retheme.

    `components/ui/` is excluded: it is vendored shadcn, it reads shadcn's own semantic names, and
    its one raw read (`hsl(var(--sidebar-border))` in a sidebar component this app never mounts) is
    upstream dead code. Logged in WINDOWS.md rather than rewritten in a vendored file.
    """
    declared = _declared_root_tokens()
    offenders: list[str] = []
    for path in _frontend_sources():
        rel = _rel(path)
        if rel.startswith("components/ui/"):
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            for name in VAR_READ.findall(line):
                if name.startswith(FOREIGN_VAR_PREFIXES):
                    continue
                if name not in declared:
                    offenders.append(f"{rel}:{lineno}: var({name}) — NOT DECLARED, resolves to nothing")
                elif not name.startswith(ROLE_PREFIXES):
                    offenders.append(f"{rel}:{lineno}: var({name}) — a tier-1 primitive, not a role")
    assert not offenders, (
        f"{len(offenders)} raw token read(s) are not tier-2 roles:\n  " + "\n  ".join(offenders)
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "EXPECTED TO FAIL until 08-07 Part 2 migrates the 22 page files onto role utilities. The "
        "list this assertion prints IS that work-list. `strict=True` on purpose: when Part 2 lands, "
        "the unexpected pass fails the suite and forces this marker off, so the gate cannot be "
        "left permanently muted."
    ),
)
def test_no_palette_slot_utilities_outside_the_token_layer() -> None:
    """A palette slot is not a role, and a component that reaches for one cannot be rethemed as a pair.

    Kept as a SEPARATE assertion from `test_no_hex_literals` rather than folded into it: the hex
    gate passes today, and marking one combined test `xfail` would silently stop enforcing the
    literal ban — a loosening dressed up as a merge.
    """
    offenders: list[str] = []
    for path in _frontend_sources():
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            for hit in PALETTE_SLOT.findall(line):
                offenders.append(f"{_rel(path)}:{lineno}: {hit}")
    by_file: dict[str, int] = {}
    for o in offenders:
        by_file[o.split(":")[0]] = by_file.get(o.split(":")[0], 0) + 1
    ranked = "\n  ".join(f"{n:4d}  {f}" for f, n in sorted(by_file.items(), key=lambda kv: -kv[1]))
    assert not offenders, (
        f"{len(offenders)} palette-slot utility/utilities across {len(by_file)} file(s) name a step "
        f"on a ramp instead of a surface role, so they cannot be remapped as a (surface, "
        f"foreground) pair. This is 08-07 Part 2's migration work, ranked by file:\n  " + ranked
    )
