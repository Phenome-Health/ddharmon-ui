"""The stable, UI-owned harmonization record contract — *the* insulation boundary.

The frontend renders these shapes; nothing else. ddharmon's ``LeanBRecord`` / ``TransformSpec`` map
*into* this contract in :mod:`backend.engine.adapter` (the one place that imports the pipeline). When the
pipeline churns — record fields rename, knobs change, a stage is added — the change is absorbed in the
adapter's mapping functions, and this contract (hence the whole frontend) stays still. A genuinely new
*output concept* is the irreducible residue: it bumps ``CONTRACT_VERSION`` and is handled additively, so
the break is explicit rather than silent.

These are ``TypedDict``s, not dataclasses: they ARE the JSON the API emits (no serialization hop) and
pyright still checks the shape.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

# Bump (and handle additively) only when a genuinely new output concept appears — a new verdict class,
# row-level data, a new artifact kind. Field renames/reshapes do NOT bump this; they stay in the adapter.
CONTRACT_VERSION = "1"

RunMode = Literal["batch", "sync", "preview"]
Verdict = Literal["adopt", "refine", "novel", "unclassified"]
Route = Literal["assigned", "gencde_residual"]


class CdeRef(TypedDict):
    id: str  # CDE designation (variable name)
    externalId: str  # external/catalog id (tinyId / standard code), may be ""


class UICandidate(TypedDict):
    """One ranked CDE candidate the assign stage evaluated (drives the candidate-review workbench)."""

    rank: int  # 1-based, best-first
    cdeId: str
    cdeExternalId: str  # "" when absent
    definition: str
    cosine: float
    isChosen: bool
    llmSuggested: bool


class AtlasPoint(TypedDict):
    """One field projected to 2D (PCA of its embedding) for the cohort-colored embedding atlas."""

    cohort: str
    variable: str
    x: float
    y: float


class UIMember(TypedDict):
    """One source field that a concept-group pooled — surfaced so a reviewer can see WHICH variables
    (and their text) drove the assignment, not just an opaque ``cohort:var`` id.

    ``text`` is the field's human-readable content (description / question / label) — the signal that was
    embedded and clustered. ``name`` is the raw variable name (may be a synthetic row id when the source
    dictionary had no usable identifier column). Both are best-effort: ``text`` falls back to ``name``.
    """

    id: str  # "cohort:var" — matches an entry in the record's ``members`` list
    cohort: str
    name: str  # variable name (may be a synthetic row id)
    text: str  # description / question_text / short_label — the embedded signal


class ResponseOptionUI(TypedDict, total=False):
    """One coded response option (code→label) for a field. ``order`` is present only when the source
    carried an ordinal position. ``code`` and ``label`` are always populated at runtime."""

    code: str
    label: str
    order: int


class FieldDetail(TypedDict, total=False):
    """The full read-in detail for one source (non-CDE) field — the value in :attr:`UIResult.fieldIndex`,
    keyed ``"cohort:var"``.

    Covers EVERY embedded source field (uncapped, unlike the downsampled atlas), so the UI can show the
    complete per-field detail on demand (and browse fields that never landed in a concept). ``name`` (the
    variable name) and ``text`` (the embedded signal — same derivation as :class:`UIMember`) are always
    present; the raw read-in attributes appear only when the source provided a non-empty value. ``description``
    is omitted when it merely echoes the variable name (a loader backfill), matching the ``text`` fallback.
    """

    # always present
    name: str  # variable name (may be a synthetic row id)
    text: str  # description / question_text / short_label — the embedded signal
    # raw read-in attributes (present only when the source value is non-empty)
    description: str
    questionText: str
    valueEncoding: str  # inline code=label string, e.g. "1=Yes|2=No" (Field.value_encoding_raw)
    units: str
    dataType: str
    responseOptions: list[ResponseOptionUI]  # parsed code/label pairs (Field.response_options)


class UnassignedField(TypedDict, total=False):
    """A source field that landed in NO concept record — unclustered / dropped outlier. Computed as the full
    (non-CDE) field set MINUS the union of every record's member ``"cohort:var"`` keys. ``x``/``y`` are present
    only when the field is in the atlas sample (the atlas is downsampled; this list is not)."""

    # always present
    cohort: str
    variable: str
    text: str  # the embedded signal (same derivation as FieldDetail.text)
    # present only when the field is in the atlas sample
    x: float
    y: float


class Cosines(TypedDict):
    top1: float | None  # nearest-candidate dense cosine (retrieval signal)
    chosen: float | None  # dense cosine of the CHOSEN candidate (the match's geometric support)


class UITransform(TypedDict, total=False):
    """One source-field → target-CDE value recipe (mapped from ``TransformSpec``); kind-tagged.

    ``kind`` ∈ identity | categorical | unit | arithmetic | data_dependent | none. The required keys are
    always present; the kind-specific keys (codeMap, factor/offset/units, formula/inputs, method/params)
    appear only for the relevant kind.
    """

    # always present
    sourceVariable: str  # "cohort:var" — the Sankey edge this recode is for
    targetCdeId: str
    kind: str
    confidence: float
    coverage: float  # fraction of source codes mapped (verification signal)
    needsUnits: bool
    needsData: bool
    needsReview: bool
    rationale: str
    generatedBy: str  # llm | rule
    # categorical (C1)
    codeMap: dict[str, str]
    unmappedSourceCodes: list[str]
    # unit / N1 (C2):  target = source * factor + offset
    factor: float
    offset: float
    sourceUnit: str
    targetUnit: str
    # arithmetic / N2 (C2)
    formula: str
    inputs: list[str]
    # data-dependent / N3 (C3)
    method: str
    params: dict[str, Any]


class UIRecord(TypedDict):
    """One harmonization decision per concept-GROUP (mapped from ``LeanBRecord``)."""

    id: str  # groupId or clusterId — stable key for review/decisions
    clusterId: str
    groupId: str
    concept: str  # the group's concept label
    verdict: str  # adopt | refine | novel | unclassified
    route: str  # assigned | gencde_residual
    cde: CdeRef | None  # chosen CDE for adopt/refine; null for novel
    idealCde: str  # the independently-generated coverage anchor
    cosines: Cosines
    coverageGap: bool  # diagnostic: novel & top1 below tau (never a gate)
    floored: bool  # retrieval floor downgraded an adopt/refine -> novel
    crossCohort: bool
    nMembers: int
    cohorts: list[str]
    members: list[str]  # member variable names ("cohort:var")
    memberDetails: list[UIMember]  # the source fields (name + text) this concept pooled — for review
    transforms: list[UITransform]
    candidates: list[UICandidate]  # ranked CDE candidates the assign stage saw (best-first)
    rationale: str
    decidedBy: str  # llm | deterministic


class PromptCounts(TypedDict):
    ideal: int
    split: int
    groupAssign: int
    specgen: int


class UISummary(TypedDict):
    nRecords: int
    counts: dict[str, int]  # verdict -> count
    nCrossCohort: int
    nAssigned: int
    nGencdeResidual: int
    nWithTransforms: int
    cohorts: list[str]


class UIResult(TypedDict):
    contractVersion: str
    mode: str  # the RunMode this run used
    phases: list[str]  # the phase sequence this run reports — UI renders progress from THIS, not a hard-coded list
    records: list[UIRecord]
    summary: UISummary
    prompts: PromptCounts  # prompt counts per stage (transparency; the only signal in preview mode)
    atlas: list[AtlasPoint]  # 2D-projected fields for the cohort-colored embedding atlas
    # Full per-field detail for EVERY embedded source (non-CDE) field, keyed "cohort:var" (uncapped — a
    # lookup, not plotted points). Lets the UI show complete field detail on demand without a re-fetch.
    fieldIndex: dict[str, FieldDetail]
    # Source fields that landed in no concept record (unclustered / dropped outliers) — lets the UI browse
    # the "everything else" the run didn't harmonize. Uncapped; x/y only when the field is in the atlas.
    unassignedFields: list[UnassignedField]


# Phase sequences the UI consumes to render progress (data-driven — see §1 "new/removed stage" row).
PHASES_RUN = ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "specs"]
PHASES_PREVIEW = ["loading", "embedding", "clustering", "prepared"]


def empty_summary() -> UISummary:
    return {
        "nRecords": 0,
        "counts": {},
        "nCrossCohort": 0,
        "nAssigned": 0,
        "nGencdeResidual": 0,
        "nWithTransforms": 0,
        "cohorts": [],
    }
