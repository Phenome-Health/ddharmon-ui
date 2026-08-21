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
        p for p in FRONTEND_SRC.rglob("*") if p.is_file() and p.suffix in SOURCE_SUFFIXES and p != TOKEN_DEFINITIONS
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

# `(?<![-\w])` on `free`: "backbone-free mode" and "schema-free" use the suffix to mean
# WITHOUT, not AT NO COST. The roadmap already carries one, and it is a claim about
# capability, not money.
# "it is local" and "it runs on your machine" are cost claims in this product's own idiom —
# the whole staged-review argument is local-work-is-free — and the reader takes them as such.
# The original false claim was literally "Gate 0 and Gate 1's grouping run on your machine",
# which carried none of the money words and so scored zero against a keyword-only detector.
_FREE_CLAIM = re.compile(
    r"\b((?<![-\w])free|costs? nothing|cost nothing|no charge|nothing to pay|at no cost"
    r"|(?:is|are|was|were|runs?|stays?|happens?) local|on your machine|local(?:ly)? too)\b",
    re.I,
)
# A sentence that names where the charge DOES land has reconciled the claim rather than made
# it — "Starting costs nothing — the first charge is Continue at Gate 0" is the corrected copy
# §0.1 asks for. Flagging it would leave a writer no true sentence to write.
_NAMES_THE_CHARGE = re.compile(
    r"\bfirst charge\b|\bis charged\b|\bare charged\b|\bpays for\b|\bpaid\b|\bnot free\b"
    r"|\bcharged on\b|\bcosts? \$|\bthen paid\b",
    re.I,
)
_STAGED_SUBJECT = re.compile(
    r"\b(step 1|step one|first step|this step|this gate|grouping comes first|concept groups?|"
    r"staged (?:flow|review)|gate 0|first gate|gates? 0 and 1|the grouping|"
    r"gate 1(?:\'s)? grouping)\b",
    re.I,
)
# Widening the subject list above made a NEGATION guard mandatory. "this gate is cheap,
# but not free" and "the grouping is charged either way" are the honest statements this
# gate wants copy to converge ON — flagging them would push a writer back toward silence,
# which is the failure mode the module header warns about. Two of these sentences are live
# in the staged-review mockup right now, and both were written as corrections.
_DENIAL = re.compile(r"\b(not|never|isn't|aren't|no longer|rather than)\s*$", re.I)
# "preview" as the RUN MODE, not the word anywhere in a sentence: a page that merely
# mentions a preview must not buy itself an exemption from the claim.
_PREVIEW_SUBJECT = re.compile(r"\bpreview (?:run )?mode\b|\bpreview runs?\b|\bin preview\b|\bpreview:", re.I)

# Empty ON PURPOSE, and the emptiness is load-bearing. The one entry that used to sit here
# (`pages/preview-staged-review.tsx`) was excluded because D-16 planned to retire its ROUTE,
# so rewording a page nobody could reach was pointless. That file is now DELETED and its
# content lives in `frontend/public/preview/staged-review/index.html` — which is a standalone
# static page, outside every `frontend/src` gate. The claim did not get fixed by the move; it
# got hidden by it, and it came back in five places. Standalone pages are walked below, so the
# exclusion is no longer needed and must not be re-added: it is the mechanism that let a known
# false cost claim ship un-gated.
CLAIM_EXCLUSIONS: tuple[str, ...] = ()


# Block-level tags ARE the sentence boundaries in markup. Without this the whole gate rail
# is one "sentence", so `Gate 4 … free` (true — Gate 4 is a terminal read) gets convicted by
# the `Gate 0` sitting 90 characters away in a different button.
# BLOCK-level only. `span`, `b` and `i` are INLINE: treating them as boundaries chops a
# sentence mid-clause, which severs a claim from the very words that reconcile it —
# "<span>Nothing is charged yet</span> — … The first charge is Continue at Gate 0" became
# three sentences, and the middle one read as a bare false claim.
_BLOCK_END = re.compile(r"</(?:div|p|li|ul|ol|button|h[1-6]|td|th|tr|section)>|<br\s*/?>", re.I)
# CSS lives in `<style>` and carries selectors like `.howto li .free` — a class name, not a
# claim. Prose, however, DOES live inside `<script>` (the how-to steps are JS template
# strings), so scripts are kept.
_STYLE_BLOCK = re.compile(r"<style\b[^>]*>.*?</style>", re.I | re.S)
# Attribute values are identifiers: `class="free"`, `data-gate="4"`. Four of the five false
# positives this gate first produced were `class="free"`.
_ATTR = re.compile(r"""\s[-\w:]+=(?:"[^"]*"|'[^']*')""")


def _visible_prose(text: str) -> str:
    """Markup reduced to the claims a reader can actually see, with sentence boundaries."""
    if "<" not in text:
        return text
    text = _STYLE_BLOCK.sub(" ", text)
    text = _BLOCK_END.sub(". ", text)
    text = _ATTR.sub(" ", text)
    return re.sub(r"<[^>]+>", " ", text)


def _staged_flow_free_claims(text: str) -> list[str]:
    """Sentences claiming the STAGED FLOW costs nothing. Preview-run-mode sentences pass."""
    flat = " ".join(_visible_prose(text).split())
    hits = []
    for sentence in re.split(r"(?<=[.!?])\s+", flat):
        if _PREVIEW_SUBJECT.search(sentence):
            continue
        free = _FREE_CLAIM.search(sentence)
        if free and _DENIAL.search(sentence[: free.start()]):
            continue  # "…is not free" DENIES the claim; it does not make it
        if free and _NAMES_THE_CHARGE.search(sentence):
            continue  # the sentence says where the money goes; it is reconciled, not false
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
    # The widened subject vocabulary: these are the shapes the staged-review mockup
    # actually shipped, and the pre-widening detector saw none of them.
    false_about_the_staged_flow += [
        "This gate is free and repeatable — the cheapest place to catch a mistake.",
        "Starting costs nothing — gates 0 and 1 are local.",
        "Gate 0 and gate 1's grouping are free either way.",
        "The grouping costs nothing, so scope it however you like.",
    ]
    true_about_preview_run_mode = [
        "Preview runs no LLM — free.",
        "No LLM — clustering + retrieval only, to inspect groupings before spending credits.",
        "Preview run mode calls no model at all, so this step is free.",
        "Local · free",
        # Denials. Widening the subject list would flag these without the guard, which
        # would penalise the corrected copy and push a writer back toward saying nothing.
        "That is what produces the flags below, so this gate is not free.",
        "The grouping is never free — it pays for ideal, split and the judge.",
        "Gate 0 is local either way; the grouping is charged, rather than free.",
        # A sentence that names where the charge lands. This is the copy §0.1 asks for.
        "Starting costs nothing — the first charge is Continue at Gate 0.",
        "Nothing is charged yet. The first charge is Continue at Gate 0, which pays for the grouping.",
        # "free" as a WITHOUT-suffix, not a price. Live in the roadmap today.
        "Backbone-free mode — harmonize with no pre-existing catalog, one element per concept.",
        # Inline tags must NOT split a sentence: this is one claim reconciled by its own
        # second half, and an inline-tag boundary convicted it.
        (
            '<li>Press <b>Start run</b>. <span class="free">Nothing is charged yet</span> — Gate 0\'s '
            "preparation runs on your machine. The first charge is <b>Continue</b> at Gate 0, which "
            "pays for the grouping.</li>"
        ),
        # A local claim that names the charge is reconciled copy, not a false claim.
        "Gate 0 is local either way; the grouping is charged either way, batch at about half.",
        "Embedding and clustering are local — naming and splitting the groups are paid.",
        # Markup noise: a CSS class name and a selector are not claims.
        '<div class="free"><span>Gate 0 · local</span><span>$0.00</span></div>',
        "<style>.howto li .free { color:var(--ok); } .gate.is-off { opacity:.5 }</style>",
        # Block-level tags are sentence boundaries: Gate 4 IS free (a terminal read), and the
        # `Gate 0` in a different button must not convict it.
        (
            "<button><div>Gate 0</div><div>Load &amp; prepare</div><div>local</div></button>"
            "<button><div>Gate 4</div><div>Export</div><div>free</div></button>"
        ),
    ]
    # Proves the markup handling did not simply BLIND the gate — the same false claim,
    # wrapped in the same markup, must still be convicted.
    false_about_the_staged_flow += [
        '<div class="fhelp">Starting costs nothing — gates 0 and 1 are local.</div>',
        '<li>Press <b>Start run</b>. <span class="free">This gate is free and repeatable</span></li>',
        # The claim form that scored ZERO against the keyword-only detector — no "free",
        # no "costs nothing", and false all the same. This is the fixture that matters.
        "Press Start run. Gate 0 and Gate 1's grouping run on your machine.",
        "Still nothing spent. Gate 1's grouping is local too.",
        "This is where spending begins; concept groups before it were local.",
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
    # Standalone static pages are the same public surface reached by the same roadmap link.
    # Scoping this walk to `frontend/src` is exactly how the claim went un-gated.
    for path in _standalone_pages():
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
    "--surface-",
    "--on-",
    "--rule-",
    "--link-",
    "--accent",
    "--status-",
    "--series-",
    "--focus-ring-",
    "--elevation-",
    # The brand lockup's own namespace. `--mark-*` are tier-2 roles like every other entry here —
    # they resolve from `--brand-mark-*` primitives and carry `graphical`-level manifest rows — and
    # they exist so the Phenome Health mark is painted from ITS OWN palette rather than from
    # semantic UI roles. Before 08-12b the mark read `--accent-2-on-chrome`, so a rebrand that
    # dropped the brand's second hue would have silently restyled the organisation's logo (T-08-65).
    "--mark-",
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


def test_no_default_palette_utilities() -> None:
    """Tailwind's own palette bypasses the token layer entirely.

    `bg-amber-50` is not wired to any brand primitive, so it would survive a rebrand untouched.
    The rendered rebrand drill cannot catch these: every one of them is on a conditional state
    (composite feasibility badges, an upload error banner) that the static demo never reaches.
    That is why this gate exists as a STATIC one — it is the only gate that could see the 24 that
    shipped, and it went from 24 to 0 when they were mapped onto the status registers, which is
    what they were standing in for all along: emerald = computable, amber = needs review, red =
    infeasible.
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
    assert not offenders, f"{len(offenders)} raw token read(s) are not tier-2 roles:\n  " + "\n  ".join(offenders)


def test_no_palette_slot_utilities_outside_the_token_layer() -> None:
    """A palette slot is not a role, and a component that reaches for one cannot be rethemed as a pair.

    Kept as a SEPARATE assertion from `test_no_hex_literals` rather than folded into it: the hex
    gate passed while this one was red, and marking one combined test `xfail` would have silently
    stopped enforcing the literal ban — a loosening dressed up as a merge. They stay separate now
    that both are green, for the same reason: they ban different things.

    Went from 1,198 hits across 47 files to 0. The `xfail(strict=True)` marker is what forced this
    line to be written rather than forgotten: an unexpected pass fails a strict xfail, so the gate
    could not be left muted once the work landed.
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


# ── Standalone static pages get the SAME token discipline as the SPA ──────────────────
#
# `frontend/public/**/*.html` is served verbatim, outside the SPA, with no build step and
# no Tailwind — so every colour/type gate above, all of which are scoped to `frontend/src`,
# is blind to it. That blindness is not hypothetical: the staged-review mockup arrived
# carrying a known-false cost claim in five places, one straight drift from the brand's
# amber, and twelve colour literals in component rules — through a retheme whose whole
# point was that a colour cannot be spelled out outside the token layer.
#
# A standalone page cannot reference the SPA's utilities, so the rule is not "use the
# tokens" — it is the rule `index.css` itself lives by: **a colour may be spelled out ONLY
# where the tokens are declared.** A page that declares its own `:root` block then earns
# the same property the SPA has — a rebrand is a token edit, not a hunt.

FRONTEND_PUBLIC = REPO / "frontend" / "public"

# A token block is a rule whose selector is EXACTLY `:root` or `:root[...]`. A DESCENDANT
# selector that merely starts with `:root` — `:root[data-theme="deep"] .chip { … }` — is a
# component rule wearing a token block's prefix, and two literals hid behind precisely that.
_TOKEN_BLOCK = re.compile(r"(?m)^\s*:root(?:\[[^\]]+\])?\s*\{[^}]*\}", re.S)
# The DEFAULT theme only: bare `:root` plus the theme the page actually loads with.
_DEFAULT_THEME_BLOCK = re.compile(r'(?m)^\s*:root(?:\[data-theme="brand"\])?\s*\{([^}]*)\}', re.S)
_DECL = re.compile(r"(--[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})")

# An entry here must name a real, still-present divergence with its reason. TWO assertions
# below keep the register honest in both directions: one drops an entry whose value has left
# the page, the other drops an entry the brand has since ADOPTED. Neither can be satisfied by
# leaving a stale line in place, which is what stops this dict widening into blanket cover.
#
# THE ADOPTION ASSERTION DID ITS JOB. This dict was populated on 2026-08-20 with eleven entries,
# because phenomehealth.org republished its identity that morning and the mockup was re-measured
# against the live site while `index.css` still held the July sample. Five of those were labelled
# TEMPORARY and the second assertion below was written specifically to kill them when 08-12b
# re-pointed `--brand-*`. 08-12b re-pointed `--brand-*`, the assertion fired, and they are gone:
# #FFFFFF, #EBEFFF, #D5E0F6, #000000 and #4B4F6B are `--brand-white` / `--brand-pale` /
# `--brand-mist` / `--brand-black` / `--brand-slate` in the SPA now, so the mockup and the product
# no longer diverge on them and nothing is exempt that need not be. The mark's teal (#3AC2CB) and
# crimson (#E11E53) also left, for a different reason: the SPA now declares them as `--brand-mark-*`
# primitives, so they are brand values rather than divergences.
#
# What remains is genuinely still divergent, in two groups.
PROPOSED_COLOURS: dict[str, str] = {
    # ── The DARK THEME the product does not have ───────────────────────────────────────────
    # The brand publishes no status palette and no dark mode, so these are derived, not sampled,
    # and they have no `--brand-*` counterpart because the SPA ships ONE theme (08-05 removed the
    # second one). They stay listed rather than being hidden inside the dark block, because the
    # page declares them among its tier-1 primitives where the default-theme walk can see them.
    # They become adoptable the day the product grows a dark theme, and not before.
    "#3FCFA5": "dark-theme `ok`. #0E7C63 is unreadable on the navy ground.",
    "#F0C070": "dark-theme `warn` — the coherence flag, the load-bearing signal on Gate 1.",
    "#FF6E92": "dark-theme destructive. #E21C52 does not clear AA on the navy ground.",
    # ── PERMANENT: lockup blades the SPA's glyph does not draw ──────────────────────────────
    # The full horizontal lockup on the mockup has more blades than the SPA's three-arc glyph.
    # These two paint blades the product never renders, so they will never have a `--brand-*`
    # counterpart — and that is the point rather than an omission. A brand mark painted from
    # semantic UI roles gets silently restyled by an unrelated accent decision, which was the live
    # defect in `components/phenome-mark.tsx` (it drew the Phenome Health logo from
    # `--accent-2-on-chrome`). 08-12b fixed that by giving the mark `--brand-mark-*` primitives of
    # its own; the two blades below are the part of the lockup that stayed on the page.
    "#253B7E": "the lockup's mid-navy blade. PERMANENT — logo-scoped, not drawn by the SPA's glyph.",
    "#222572": (
        "the lockup's third blade. PERMANENT — logo-scoped. It used to satisfy the brand check by "
        "accident, because it was also `--brand-indigo`, the July identity's ink; that primitive is "
        "gone (the brand's ink is #000000 now) so it is recorded explicitly for what it is."
    ),
}

# Values that are logo-scoped by design and must NOT be reported as brand drift even after the
# SPA adopts the new identity. Kept separate from the reason strings so the adoption assertion
# can tell "still pending" from "never applicable".
PERMANENT_PROPOSED: frozenset[str] = frozenset({"#253B7E", "#222572"})


def _decomment(src: str) -> str:
    """Blank out CSS and HTML comments, preserving line numbers.

    The staged-review page documents its sampled palette as prose in a comment. That is a
    reference, not paint — flagging it would teach the next author to delete the note.
    """
    src = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    return re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)


def _standalone_pages() -> list[Path]:
    if not FRONTEND_PUBLIC.exists():  # pragma: no cover
        return []
    return sorted(FRONTEND_PUBLIC.rglob("*.html"))


def _token_block_lines(src: str) -> set[int]:
    lines: set[int] = set()
    for m in _TOKEN_BLOCK.finditer(src):
        lines.update(range(src[: m.start()].count("\n"), src[: m.end()].count("\n") + 1))
    return lines


def test_a_standalone_page_exists_to_gate() -> None:
    """Guard against the walk passing vacuously.

    Every assertion below iterates a glob. If `frontend/public` ever stops holding an HTML
    page — renamed directory, moved mockup — the two gates would go green by finding nothing,
    which is the failure this module already met once in another form ("0 of 23 baselines
    changed" verified file identity, not that the suite passed).
    """
    assert _standalone_pages(), (
        f"no standalone HTML page found under {FRONTEND_PUBLIC.relative_to(REPO)} — if the "
        f"mockups genuinely moved, re-point FRONTEND_PUBLIC rather than leaving a glob that "
        f"cannot fail"
    )


@pytest.mark.parametrize("page", _standalone_pages(), ids=lambda p: p.name)
def test_standalone_pages_keep_colour_literals_in_their_token_block(page: Path) -> None:
    """A colour spelled out in a component rule is a rebrand that silently does not happen."""
    src = page.read_text()
    allowed = _token_block_lines(src)
    offenders = [
        f"{page.relative_to(REPO)}:{i + 1}: {literal}"
        for i, line in enumerate(_decomment(src).splitlines())
        if i not in allowed
        for literal in (HEX_LITERAL.findall(line) + NUMERIC_COLOUR_FN.findall(line))
    ]
    assert not offenders, (
        f"{len(offenders)} colour literal(s) sit in component rules on a standalone page "
        f"instead of its `:root` token block, so a rebrand cannot reach them — re-point each "
        f"onto a token the page already declares:\n  " + "\n  ".join(offenders)
    )


@pytest.mark.parametrize("page", _standalone_pages(), ids=lambda p: p.name)
def test_standalone_page_default_theme_matches_the_brand(page: Path) -> None:
    """A standalone page samples the brand independently, so it drifts independently.

    This is the assertion that actually earns its keep. The page's own token block is only
    worth having if its values ARE the brand's — otherwise a rebrand updates `index.css`,
    every gate stays green, and the mockup keeps painting last year's colours on a public
    route. It caught one real drift on arrival: the page's warn amber was `#A85B00` where
    `--brand-amber` is `#8F4E00`.

    Scoped to the DEFAULT theme. The page also carries a second `deep` theme, which the SPA
    deleted in 08-05 — asserting brand parity for a theme the product no longer has would be
    asserting against nothing. That mismatch is a design question, logged in WINDOWS.md.
    """
    brand = {
        v.upper() for v in re.findall(r"--brand-[a-z0-9-]+\s*:\s*(#[0-9a-fA-F]{3,8})", TOKEN_DEFINITIONS.read_text())
    }
    src = page.read_text()
    declared = {
        name: val for block in _DEFAULT_THEME_BLOCK.finditer(src) for name, val in _DECL.findall(block.group(1))
    }
    if not declared:
        pytest.skip(f"{page.name} declares no default-theme colour tokens")

    for value, reason in PROPOSED_COLOURS.items():
        assert value.upper() in {v.upper() for v in declared.values()}, (
            f"PROPOSED_COLOURS records {value} with a reason, but no default-theme token on "
            f"{page.name} declares it any more — drop the entry rather than leaving it to "
            f"cover the next divergence. Recorded reason: {reason}"
        )

    # The other direction: an entry the brand has since ADOPTED is no longer a divergence, and
    # leaving it is how this register rots into blanket cover. Without this, the eleven entries
    # added for the 2026-08-20 rebrand would sit here forever once 08-12b re-points `--brand-*`,
    # silently exempting those values from every future drift check. The logo-scoped values are
    # excluded because they are never meant to become brand primitives.
    adopted = sorted(
        v for v in PROPOSED_COLOURS if v.upper() in brand and v.upper() not in {p.upper() for p in PERMANENT_PROPOSED}
    )
    assert not adopted, (
        f"{len(adopted)} PROPOSED_COLOURS "
        f"{'entry now matches' if len(adopted) == 1 else 'entries now match'} a `--brand-*` "
        f"primitive in {TOKEN_DEFINITIONS.name}, so the divergence they recorded is over — "
        f"delete them. An exemption that outlives its reason exempts the next drift too:\n  "
        + "\n  ".join(f"{v} — {PROPOSED_COLOURS[v]}" for v in adopted)
    )

    proposed = {v.upper() for v in PROPOSED_COLOURS}
    offenders = [
        f"{name}: {val}"
        for name, val in sorted(declared.items())
        if val.upper() not in brand and val.upper() not in proposed
    ]
    assert not offenders, (
        f"{len(offenders)} default-theme token(s) on {page.name} hold a value that no "
        f"`--brand-*` primitive in {TOKEN_DEFINITIONS.name} holds, so a rebrand would leave "
        f"this public page painting the old identity. Re-point each onto the brand's value, "
        f"or record it in PROPOSED_COLOURS with a reason:\n  " + "\n  ".join(offenders)
    )


def test_every_standalone_route_is_one_of_the_pages_gated_here() -> None:
    """The exemption and the replacement gate must name the SAME set of pages.

    `routes.ts` marks a route `standalone: true` to exempt it from the three rendered
    token-architecture suites (typography, surface-pairing, the rebrand drill), on the
    stated grounds that the two assertions above cover it instead. That trade is only
    honest if the page really is walked here. Nothing otherwise connects the two files, so
    a standalone route pointing at a path this module never sees would buy an exemption
    from three gates and gain none — the precise shape of the hole this whole section
    exists to close, one level up.
    """
    routes_ts = REPO / "frontend" / "tests" / "e2e" / "routes.ts"
    if not routes_ts.exists():  # pragma: no cover
        pytest.skip(f"route registry not found at {routes_ts}")

    declared = re.findall(r'\{[^{}]*\bpath:\s*"([^"]+)"[^{}]*\bstandalone:\s*true[^{}]*\}', routes_ts.read_text())
    assert declared, (
        f"{routes_ts.relative_to(REPO)} declares no `standalone: true` route, but this module "
        f"gates standalone pages and TOKEN_LAYER_ROUTES exempts them — if the category is gone, "
        f"remove the exemption too rather than leaving an unused escape hatch"
    )

    # A route path maps to the file the static build serves for it: a trailing slash is a
    # directory index.
    gated = {p.relative_to(FRONTEND_PUBLIC).as_posix() for p in _standalone_pages()}
    missing = []
    for route in declared:
        rel = route.lstrip("/")
        candidate = f"{rel}index.html" if route.endswith("/") else rel
        if candidate not in gated:
            missing.append(f"{route} -> expected frontend/public/{candidate}")
    assert not missing, (
        f"route(s) marked `standalone: true` in {routes_ts.relative_to(REPO)} are exempt from the "
        f"typography, surface-pairing and rebrand-drill suites, but no page under "
        f"{FRONTEND_PUBLIC.relative_to(REPO)} backs them — so they are exempt from those three and "
        f"gated by nothing here either:\n  " + "\n  ".join(missing)
    )


# --- the gate-decision layer: two tables and two keys that must agree ACROSS languages -----------------
# The client computes an item key and a content key itself: the item key decides which row a write
# REPLACES, and the content key is what the server compares to derive staleness. If either drifts, nothing
# errors — a write silently creates a second row for one decision, or every downstream decision reports
# stale forever. Neither failure is visible from either side alone, which is why the agreement is pinned
# here rather than trusted to two matching comments.

GATE_DECISIONS_TS = REPO / "frontend" / "src" / "lib" / "gate-decisions.ts"


def _ts_identity_table() -> dict[str, list[str]]:
    """`DECISION_IDENTITY_FIELDS` as the frontend declares it."""
    src = GATE_DECISIONS_TS.read_text()
    m = re.search(r"DECISION_IDENTITY_FIELDS:[^=]*=\s*\{(.*?)\n\};", src, re.S)
    assert m, "could not find DECISION_IDENTITY_FIELDS in the frontend's gate-decision module"
    return {
        kind: re.findall(r'"([A-Za-z]+)"', fields) for kind, fields in re.findall(r"(\w+):\s*\[([^\]]*)\]", m.group(1))
    }


def test_the_gate_decision_identity_table_matches_the_frontend() -> None:
    """Both sides key a decision on the SAME fields, in the same order."""
    from backend.artifact_kinds import _DECISION_IDENTITY_FIELDS

    if not GATE_DECISIONS_TS.exists():  # pragma: no cover
        pytest.skip(f"frontend gate-decision module not found at {GATE_DECISIONS_TS}")
    backend_table = {kind: list(fields) for kind, fields in _DECISION_IDENTITY_FIELDS.items()}
    assert _ts_identity_table() == backend_table, (
        "the frontend's DECISION_IDENTITY_FIELDS and the backend's _DECISION_IDENTITY_FIELDS disagree — "
        "a client computing a different item key writes a SECOND row for one decision instead of "
        "replacing it, and two tabs then lose each other's work with no error anywhere"
    )


def test_the_gate_decision_content_keys_are_pinned_on_both_sides() -> None:
    """The two literals the frontend spec asserts are the values these functions actually produce.

    The frontend hand-writes sha256 (the platform's digest is async, and staleness must be synchronous to
    stay derived rather than stored), so "the same algorithm" is a claim, not a guarantee. These two
    literals are asserted in `frontend/tests/e2e/gate-decisions.spec.ts` against the TypeScript
    implementation and here against the Python one, so a change to either canonicalization fails on the
    other side.
    """
    from backend.artifact_kinds import content_key, option_set_key

    assert option_set_key(["CDE:2", "CDE:1"]) == "a9727a7585616812"
    assert content_key({"chosen": "CDE:1", "alternatives": ["CDE:1", "CDE:2"]}) == "c5bb88b56d7e6094"
    spec = (REPO / "frontend" / "tests" / "e2e" / "gate-decisions.spec.ts").read_text()
    for literal in ("a9727a7585616812", "c5bb88b56d7e6094"):
        assert literal in spec, (
            f"{literal} is no longer pinned in the frontend spec — the cross-language check is only a "
            f"check while BOTH sides assert the same literal"
        )
