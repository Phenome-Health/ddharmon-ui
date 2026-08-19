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

from collections.abc import Iterable
from typing import Any, Literal, NotRequired, TypedDict, cast

# Bump (and handle additively) only when a genuinely new output concept appears — a new verdict class,
# row-level data, a new artifact kind. Field renames/reshapes do NOT bump this; they stay in the adapter.
CONTRACT_VERSION = "5"  # v5: staged-review gates — conceptGroups / gatePosition / resultVersion (08-08),
#                         plus the triage signals, the four-state coherence cell, the two-kind
#                         not-computed register and the preparation report (08-09). Every one of them
#                         additive: `NotRequired` on an existing shape, or a brand-new TypedDict for a
#                         genuinely new output concept. Nothing renamed, nothing reshaped.

RunMode = Literal["batch", "sync", "preview"]
Verdict = Literal["adopt", "refine", "novel", "unclassified"]
Route = Literal["assigned", "gencde_residual"]
#: The coherence judge's state for one concept group — a CLOSED four-value cell, and the load-bearing
#: invariant of the whole triage surface.
#:
#: Three of the four are the judge's own verdicts. The fourth, ``not_judged``, is what makes the cell
#: honest, and it is emphatically NOT a boolean's ``False``: core's record defaults ``coherent`` to
#: ``True`` and ``prepare_coherence`` builds no prompt at all for a group under its member floor, so a
#: group nobody ever asked about arrives from core looking exactly like a group the judge blessed. Put
#: that on the wire as a boolean and every unjudged row reads as a pass — SPEC prohibition #1, T-08-46.
#:
#: A judge error and a judge timeout land here too (see the adapter's resilient-stage wrapper): the
#: runner returns nothing, so no verdict is stamped and the state stays ``not_judged``. "We could not
#: tell" is a different claim from "it is fine", and only one of them is true.
CoherenceState = Literal["single", "qualify", "split", "not_judged"]
COHERENCE_STATES: tuple[str, ...] = ("single", "qualify", "split", "not_judged")
COHERENCE_NOT_JUDGED = "not_judged"
#: Core's three verdict strings — the ONLY inputs that may leave ``not_judged``.
_JUDGE_VERDICTS = frozenset({"single", "qualify", "split"})


def coherence_state(core_verdict: object) -> CoherenceState:
    """Map core's ``coherence_verdict`` onto the closed four-state cell.

    Deliberately a whitelist, not a fallback chain: anything that is not one of the judge's own three
    verdicts — ``""`` (never asked, or no usable response), ``None``, whitespace, a hallucinated word,
    a boolean that leaked in — becomes ``not_judged``. The inverse function (default to the clean state,
    special-case the bad values) has the same shape and the opposite failure mode, and its failure mode
    is a reviewer signing off on a group nothing ever looked at.

    Never reads core's ``coherent`` boolean. That attribute cannot distinguish "judged coherent" from
    "not judged", so consulting it at all would reintroduce the defect this function exists to remove.
    """
    verdict = core_verdict if isinstance(core_verdict, str) else ""
    return cast(CoherenceState, verdict.strip() if verdict.strip() in _JUDGE_VERDICTS else COHERENCE_NOT_JUDGED)


#: The six staged-review screens, in order — a CLOSED literal like the three above it, so a typo cannot
#: name a boundary that does not exist. The set is fixed by UI-SPEC §0.1's gate↔boundary table; the *stop
#: mechanism* per gate lives in the adapter, not here (Setup and Gate 0 need no pipeline call at all,
#: Gate 1 is the shipped ``classify=None`` early return, Gate 2 is core's one named ``stop_after``
#: boundary, Gate 3 has no core boundary, and Gate 4 is a pure read).
GatePosition = Literal["setup", "gate0", "gate1", "gate2", "gate3", "gate4"]


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


class UIGenCDE(TypedDict, total=False):
    """A proposed Common Data Element for one concept group (mapped from ``GenCDE``) — its harmonization
    target. Distinct from ``UIRecord.idealCde`` (the free-text coverage anchor): this is the
    spec-conformant proposal — name, definition, data type, permissible values, units — reconciled from
    the group's pooled cross-cohort member evidence. ``valueCoverage``/``needsReview`` are verification
    flags (never a gate).

    **Two provenances.** A ``novel`` group's element is synthesized FROM SCRATCH; a ``refine`` group's is
    DERIVED FROM the matched CDE — the parent plus a typed, minimal delta. ``parentCdeId`` is the test for
    which: present = derived. The UI must not present a derived element as a from-scratch proposal, since
    the whole point of the refine verdict is that an existing standard element nearly fits and needs a
    stated, reviewable change — a reviewer who cannot see the parent cannot judge the change.
    """

    # always present
    #: TRUE, always, on every element of this shape. A generated element is authored by ddharmon and this
    #: is the wire's explicit statement of that (T-08-47). It is a positive marker rather than "the
    #: absence of a catalog id" because an absence is not a claim: a consumer that forgot to check would
    #: render a synthesized element in the same chrome as a published NIH one, and the reviewer would
    #: have no way to tell. Deliberately NOT paired with any catalog identity of its own — no tinyId, no
    #: endorsement, no registry status — see ``tests/test_contract_completeness.py::test_gencde_labelled``.
    #: The one external identifier this shape may carry is ``parentCdeExternalId``, namespaced so it can
    #: only ever be read as the PARENT's.
    isGenerated: bool
    gencdeId: str
    preferredName: str
    title: str
    definition: str
    questionText: str
    dataType: str  # numeric | categorical | binary | date | text
    permissibleValues: list[ResponseOptionUI]  # reconciled categorical domain
    aliases: list[str]
    sourceVariables: list[str]  # the pooled member edges ("cohort:var")
    sourceCohorts: list[str]
    relatedCdes: list[str]  # near-miss candidate names the assign stage saw
    valueCoverage: (
        float | None
    )  # fraction of observed answer-concepts the domain represents; None = N/A (numeric GenCDE)
    uncoveredLabels: list[str]
    confidence: float
    needsReview: bool
    rationale: str
    generatedBy: str  # llm | rule
    # numeric concepts only
    units: str
    minimum: float
    maximum: float
    # ── derivation: present ONLY when this element refines an existing CDE (refine route) ──
    parentCdeId: str  # the matched CDE's designation — the element this one refines
    parentCdeExternalId: str  # the parent's NIH tinyId, for link-out to the repository entry
    relation: str  # SSSOM/SKOS predicate vs the parent: skos:narrowMatch | broadMatch | closeMatch | relatedMatch
    refinementAxis: str  # value_domain | qualifier | representation | structural | scope
    qualifierAdded: str  # the qualifier the parent lacked ("right carotid bulb")
    addedPermissibleValues: list[ResponseOptionUI]  # values this element adds to the parent's domain
    deprecatedValues: list[str]  # parent codes the concept does not use
    changedFields: list[str]  # parent fields the delta CONTRADICTS (the minimality evidence)
    completedFields: list[str]  # parent fields that were EMPTY and this element supplies (not a change)
    deltaSize: float  # fraction of what the parent DID assert that this element changes
    overRefined: bool  # the delta rewrites rather than refines -> this should probably have been a novel


class UIRecord(TypedDict):
    """One harmonization decision per concept-GROUP (mapped from ``LeanBRecord``)."""

    id: str  # groupId or clusterId — stable key for review/decisions
    clusterId: str
    groupId: str
    concept: str  # the group's concept label
    verdict: str  # adopt | refine | novel | unclassified
    route: str  # assigned | gencde_residual
    cde: CdeRef | None  # chosen CDE for adopt/refine; null for novel
    idealCde: str  # the independently-generated coverage anchor (free text)
    gencde: UIGenCDE | None  # novel route -> synthesized spec-conformant CDE proposal; null otherwise
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
    # ── v5 additive: the TRIAGE SIGNALS (all `NotRequired`, following the `previewClusters` template) ──
    #
    # Twelve of these returned zero occurrences on every shipped artifact before this version, for two
    # different reasons: three were computed and simply never mapped, and the rest belonged to stages the
    # product never injected. Both halves are closed here (see the adapter). They are `NotRequired` so a
    # hand-built record (a fixture, a canned test payload) stays valid — but the adapter emits every one
    # of them on every record, so an absent key means "this payload predates v5", never "clean".
    #
    #: The closed four-state coherence cell. NEVER a boolean — see :data:`CoherenceState`.
    coherence: NotRequired[CoherenceState]
    coherenceSummary: NotRequired[str]  # the judge's one-sentence theme of the group's core
    coherenceAxis: NotRequired[str]  # qualify/split: the slot that varied ("condition", "body site")
    coherenceDistinctValues: NotRequired[list[str]]  # the distinct fillers the judge found on that axis
    coherenceOutliers: NotRequired[list[str]]  # periphery members judged off-theme ("cohort:var")
    coherenceKind: NotRequired[str]  # R2 discriminator: "" | values_of_one_property | distinct_kinds
    incoherent: NotRequired[bool]  # the HARD flag -> needs_review. FLAG, never a gate: nothing auto-splits
    matrixSuspect: NotRequired[bool]  # the $0 deterministic frequent-template/rare-slot pre-filter
    #: M3: the group's coded edges are mostly unmappable, so the match is over-broad. NOT `coverageGap`,
    #: which is the unrelated novel-below-tau retrieval diagnostic one letter away from it.
    coherenceGap: NotRequired[bool]
    adoptDemoted: NotRequired[bool]  # M5's adopt_floor demoted a weak-support adopt -> refine
    #: M7's concept-match gate: right values, wrong concept. OPT-IN (``concept_gate``) and off by default,
    #: so on a normal run this key is absent and the not-computed register says so, PER-RUN.
    conceptMismatch: NotRequired[bool]
    #: This record is a re-adjudication child; the value is the parent group id it was carved out of.
    #: Only ever populated by a caller-invoked re-adjudication — nothing in the pipeline re-splits on its
    #: own, so on a normal run this is absent and the register records it PER-RUN.
    readjudicatedFrom: NotRequired[str]


#: Core ``LeanBRecord`` signal attribute -> where the wire carries it. The completeness gate
#: (``tests/test_contract_completeness.py``) resolves every core signal through this map or through the
#: not-computed register, and fails naming any signal that resolves through neither.
#:
#: ``ranking`` is the interesting entry: core carries it as an orphan list of candidate INDICES, and the
#: wire already delivers it MATERIALISED as ``UICandidate.rank`` + ``llmSuggested``. Adding a literal
#: ``ranking`` field would duplicate data already on the wire in a worse shape, so the map records where
#: it actually lives instead of demanding a same-named field.
TRIAGE_SIGNAL_FIELDS: dict[str, str] = {
    "coverage_gap": "UIRecord.coverageGap",
    "floored": "UIRecord.floored",
    "adopt_demoted": "UIRecord.adoptDemoted",
    "coherence_gap": "UIRecord.coherenceGap",
    "matrix_suspect": "UIRecord.matrixSuspect",
    # Both of core's coherence-state attributes fold into ONE wire cell, on purpose: `coherent` alone
    # cannot express "not judged", so the contract derives the state from the verdict and drops the
    # boolean rather than shipping two fields that can disagree.
    "coherent": "UIRecord.coherence (folded into the four-state cell; the boolean is never read)",
    "coherence_verdict": "UIRecord.coherence",
    "coherence_summary": "UIRecord.coherenceSummary",
    "coherence_axis": "UIRecord.coherenceAxis",
    "coherence_distinct_values": "UIRecord.coherenceDistinctValues",
    "coherence_outliers": "UIRecord.coherenceOutliers",
    "coherence_kind": "UIRecord.coherenceKind",
    "incoherent": "UIRecord.incoherent",
    "ranking": "UIRecord.candidates[].rank + .llmSuggested (materialised, not duplicated)",
    "concept_mismatch": "UIRecord.conceptMismatch",
    "readjudicated_from": "UIRecord.readjudicatedFrom",
}

#: Why a signal carries no value. TWO KINDS, because two different claims are being made and a reviewer
#: acts differently on each:
#:
#: * ``permanent`` — no stage in the product path produces this at all. Nothing to enable; the product
#:   does not have the capability.
#: * ``per_run`` — the stage exists and is wired, but it is opt-in and THIS run did not enable it. The
#:   reviewer can act: turn the option on and re-run.
#:
#: Collapsing them costs in both directions. Calling an opt-in permanent understates the product; calling
#: a permanent gap per-run sends someone hunting for a switch that does not exist (T-08-55).
NotComputedKind = Literal["permanent", "per_run"]


class NotComputedEntry(TypedDict):
    """One signal that carries no value on this run, with the reason and the kind of absence.

    An entry is the difference between "we know this is absent, and why" and "we forgot". A field left
    empty makes the same shape as a real zero; an entry cannot be mistaken for a value.
    """

    signal: str  # the core signal name, so it joins to TRIAGE_SIGNAL_FIELDS
    kind: NotComputedKind
    reason: str  # non-empty, always — an absence with no reason is indistinguishable from an oversight


def not_computed_register(
    *,
    concept_gate: bool = False,
    readjudicated: bool = False,
    permanent: bool = True,
) -> list[NotComputedEntry]:
    """The signals that carry no value on THIS run, each with its reason and kind.

    Args:
        concept_gate: whether the opt-in M7 concept-match gate ran. When it did, ``concept_mismatch``
            is a real value on the wire and must NOT also be declared absent.
        readjudicated: whether a caller-invoked re-adjudication produced children on this run.
        permanent: include the permanent entries (the product-level gaps). Off only so a test can prove
            an EMPTY register is a legal value of the shape.

    Nothing anywhere asserts this list is non-empty. Every signal being mapped is the goal, not a
    regression, and an assertion that the register has entries would fail on the day the work finishes.
    """
    out: list[NotComputedEntry] = []
    if permanent:
        out.append(
            {
                "signal": "preprocessing_rule_provenance",
                "kind": "permanent",
                "reason": (
                    "No stage stamps WHICH rule changed a given variable. The preparation report is "
                    "per-rule counts plus a per-variable before/after diff; the join between them is "
                    "inferred, not recorded. Per-field rule provenance is deferred by SPEC, so this is a "
                    "product-level gap rather than a switch someone can turn on."
                ),
            }
        )
    if not concept_gate:
        out.append(
            {
                "signal": "concept_mismatch",
                "kind": "per_run",
                "reason": (
                    "The M7 concept-match gate is an opt-in LLM stage and this run did not enable it, so "
                    "no run paid for it. It IS wired: set the run's concept_gate option and the signal "
                    "arrives as a real value. Absent here means not asked, not 'no mismatch found'."
                ),
            }
        )
    if not readjudicated:
        out.append(
            {
                "signal": "readjudicated_from",
                "kind": "per_run",
                "reason": (
                    "Re-adjudication is caller-invoked with an explicit list of group ids and nothing on "
                    "this run invoked it, so no record is a re-split child. The pipeline never re-splits "
                    "an over-merged group on its own — the coherence flag is a suggestion for a human."
                ),
            }
        )
    return out


def resolve_signal(name: str, *, register: list[NotComputedEntry]) -> str:
    """How one core signal reaches (or does not reach) the wire on a given run.

    Returns exactly one of ``"field"`` / ``"permanent"`` / ``"per_run"`` / ``"unresolved"``. A register
    entry WINS over a field mapping: a mapped field that carries no value on this run is an absence, and
    reporting it as a live field is precisely the "empty reads as clean" failure the register exists for.
    """
    for entry in register:
        if entry["signal"] == name:
            return entry["kind"]
    return "field" if name in TRIAGE_SIGNAL_FIELDS else "unresolved"


def unresolved_signals(names: Iterable[str], *, register: list[NotComputedEntry]) -> list[str]:
    """The DARK signals: computed by the pipeline, on the wire nowhere, declared absent nowhere."""
    return sorted(n for n in names if resolve_signal(n, register=register) == "unresolved")


class PromptCounts(TypedDict):
    ideal: int
    split: int
    groupAssign: int
    gencde: int
    specgen: int


class UISummary(TypedDict):
    nRecords: int
    counts: dict[str, int]  # verdict -> count
    nCrossCohort: int
    nAssigned: int
    nGencdeResidual: int
    nWithTransforms: int
    cohorts: list[str]


class UIStageCost(TypedDict):
    """Realized cost + token totals for one pipeline stage (from ddharmon.llm.cost.CostLedger)."""

    usd: float
    inputTokens: int
    outputTokens: int
    calls: int


class UICostTokens(TypedDict):
    input: int
    output: int


class UICost(TypedDict):
    """Realized run cost — REAL spend, not an estimate. Token usage captured per LLM call (sync + Batch) and
    priced against LiteLLM's model→price map (Batch billed at 50%). For a BYOK run this is the user's own
    provider bill. ``actualUsd`` is the run total; ``perStage`` attributes it to each stage. A preview run (no
    LLM) is all zeros. See :class:`~ddharmon.llm.cost.CostLedger`.
    """

    actualUsd: float
    tokens: UICostTokens
    perStage: dict[str, UIStageCost]


class PreviewMember(TypedDict):
    """One source field in a preview cluster (a capped sample of the cluster's members)."""

    cohort: str
    variable: str
    text: str  # description / question_text / label — the embedded signal


class PreviewCandidate(TypedDict):
    """One retrieved CDE candidate for a preview cluster — a RETRIEVAL hit (BM25⊕dense RRF), NOT an
    assignment. The preview skips the LLM assign stage, so these are ranked candidates only."""

    rank: int  # 1-based, by retrieval cosine
    cdeId: str
    cdeExternalId: str  # "" when absent
    definition: str
    cosine: float


class PreviewCluster(TypedDict):
    """A preview-mode cluster: the deterministic front half (embed → cluster → retrieve) with NO LLM. Members
    is a capped sample (``nMembers`` is the true size); candidates are the top-k retrieved CDEs. A full run's
    LLM stages (split / assign / verdict) can substantially restructure these — surfaced with a disclaimer."""

    clusterId: str
    nMembers: int
    cohorts: list[str]
    crossCohort: bool
    top1Cos: float | None
    members: list[PreviewMember]  # capped sample of the cluster's source fields
    candidates: list[PreviewCandidate]  # top-k retrieved CDE candidates (not assignments)


class UIConceptGroup(TypedDict):
    """One POST-SPLIT concept group — the row Gate 1 renders (UI-SPEC §0.1).

    This exists between ``split`` and ``classify``: the cluster has already been divided into distinct
    concepts, and nothing has assigned any of them a target yet. So it deliberately carries **no verdict,
    no route and no CDE** — mirroring core's ``ConceptGroup``, whose omission of those three fields is what
    makes the shape honest rather than a half-filled record.

    ``concept`` is the **generated** name ``generate(ideal)`` produced. It is generated by ddharmon, so it
    is marked as generated wherever it is shown: no catalog badge, no external identifier link, no
    endorsement. It is also **not a GenCDE** — a GenCDE is minted later, at the ``gencde`` stage, and only
    for ``novel`` records. Three nouns, three different things (UI-SPEC §8).

    NOT to be confused with :class:`PreviewCluster`, which is **preview run mode's** shape — a $0 run that
    calls no model at all — and is no longer Gate 1's row source. A group names its own parent cluster in
    ``clusterId``, which is where Gate 1 gets provenance from.
    """

    groupId: str
    clusterId: str  # the parent cluster this group was split out of — provenance, not identity
    concept: str  # the GENERATED concept name; marked as generated on screen
    #: TRUE, always. The positive statement that ``concept`` was authored by ddharmon rather than read off
    #: a catalog — the same reasoning as :attr:`UIGenCDE.isGenerated`, and the reason this shape carries no
    #: catalog badge, no external identifier and no endorsement field of any kind.
    conceptIsGenerated: bool
    idealCde: str  # the generated coverage anchor's description (free text)
    nMembers: int  # the TRUE member count, even when memberVariableNames is a capped sample
    cohorts: list[str]
    crossCohort: bool
    top1Cos: float | None
    #: The COLLAPSED row's member sample — capped, because a Gate 1 table renders hundreds of rows and a
    #: row does not need every member to be read. ``nMembers`` above is the true count regardless, and
    #: ``membersTruncated`` says whether this list is the whole membership or a sample.
    memberVariableNames: list[str]  # "cohort:var" ids — a capped SAMPLE when membersTruncated is true
    #: Whether ``memberVariableNames`` is a sample rather than the full membership. The expanded row reads
    #: the uncapped list from :attr:`UIResult.conceptGroupMembers`; a regroup verb (drag a variable from
    #: one group to another) is unimplementable against a partial sample, because the members it cannot
    #: see would be silently dropped from whatever it writes back.
    membersTruncated: bool
    #: The judge's four-state cell for THIS group — REQUIRED, not optional. Gate 1 renders before assign,
    #: so this row is the only place the verdict can be shown, and an omitted key is an absence, which is
    #: exactly what a consumer reads as clean.
    coherence: CoherenceState
    coherenceSummary: str  # the judge's theme sentence for the group core ("" when not judged)
    coherenceAxis: str  # qualify/split: the slot that varied ("" when not judged / single)
    coherenceDistinctValues: list[str]
    coherenceOutliers: list[str]  # periphery members judged off-theme ("cohort:var")
    incoherent: bool  # the HARD flag. A FLAG: this group is never auto-split, only surfaced for a human
    matrixSuspect: bool  # the $0 deterministic pre-filter, stamped whether or not the LLM judge ran


#: What became of one preprocessing rule on one dictionary. FOUR values, because there are four
#: distinguishable claims and three of them are routinely collapsed into "0":
#:
#: * ``changed``  — the rule ran and changed ``nChanged`` variables
#: * ``no_change`` — the rule RAN and changed nothing (the corpus did not need it)
#: * ``not_run``  — the rule was not applied at all (its switch was off, or it had nothing configured)
#: * ``failed``   — preprocessing raised, so this rule's outcome is unknown, not zero
#:
#: ``no_change`` and ``not_run`` rendering identically is how a preparation report starts lying: "we
#: looked and there was nothing to fix" and "we never looked" are opposite statements about the data.
RuleOutcome = Literal["changed", "no_change", "not_run", "failed"]
RULE_OUTCOMES: tuple[str, ...] = ("changed", "no_change", "not_run", "failed")


class UIPreprocessRule(TypedDict):
    """One preprocessing rule's outcome on one dictionary (Gate 0's row)."""

    rule: str  # stable rule id, e.g. "common_prefix_stripping"
    label: str  # the rule in plain words, for the screen
    outcome: RuleOutcome
    nChanged: int  # variables this rule changed; 0 for every outcome except `changed`
    #: The denominator, and it is a ROW count: the number of variables (dictionary rows) the rule was
    #: applied to. Never a count of metadata attributes — a "field" is an attribute, a "variable" is a row.
    nVariables: int
    detail: str  # plain DATA (the prefix stripped, the placeholder replaced). Never renderable markup
    error: str  # populated only when outcome == "failed"


class UIPreprocessDiff(TypedDict):
    """One variable's before/after, for the variables preprocessing actually changed.

    Deliberately carries NO rule name. The pipeline does not stamp which rule changed a given variable
    (per-field provenance is SPEC-deferred and sits in the not-computed register as a PERMANENT gap), so a
    ``rule`` key here would assert provenance the product does not have.

    Every string is plain data. Uploaded dictionary text is echoed back to the browser here (T-08-48), and
    React escapes text children by construction — the only way mojibake becomes executable is an explicit
    raw-HTML injection, which is prohibited on this surface and asserted absent by grep.
    """

    variableName: str
    rawVariableName: str
    rawDescription: str
    cleanedDescription: str
    nameChanged: bool
    descChanged: bool
    embedNameSuppressed: bool  # the variable name was dropped from the embedding text (it echoed the description)


class UIPreprocessReport(TypedDict):
    """What preprocessing did to ONE dictionary — Gate 0's payload.

    Counts are over dictionary ROWS. ``nVariables`` is the row count the rules were applied to, and every
    rule's ``nVariables`` equals it, so the arithmetic closes against a number the reviewer can see on
    their own file.
    """

    cohort: str
    nVariables: int  # rows the dictionary loaded with — the denominator for every rule
    #: Unique variable names after preprocessing. LOWER than ``nVariables`` means names collided and
    #: ``load_dictionary``'s dict keying dropped variables SILENTLY, last-wins — a known and expensive
    #: debugging cost in this project. Surfaced rather than swallowed.
    nUniqueVariableNames: int
    nDuplicateVariableNames: int  # nVariables - nUniqueVariableNames, precomputed for the screen
    #: Variables whose embedding text came out EMPTY (no question, no description, and the variable name
    #: suppressed or absent). They embed nothing and cluster nowhere — a silent loss unless it is counted.
    nNothingToEmbed: int
    namesChanged: int
    descriptionsChanged: int
    ran: bool  # False when preprocessing did not run for this dictionary at all
    failed: bool  # True when preprocessing raised; every rule is then reported `failed`, not zero
    error: str  # the failure message when `failed`, else ""
    rules: list[UIPreprocessRule]
    diff: list[UIPreprocessDiff]  # per-variable before/after — a capped sample of the changed variables
    nChangedVariables: int  # the TRUE number of changed variables, even when `diff` is capped
    diffTruncated: bool


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
    # Realized run cost — real spend (captured tokens × LiteLLM price map, Batch at 50%), not an estimate.
    # Preview (no LLM) is all zeros. Additive v3 field; the live "spent so far" counter is Job.costSoFar.
    cost: UICost
    # PREVIEW ONLY (additive v4): the clusters + retrieved CDE candidates from the deterministic front half,
    # so a preview shows something to look at (viz + candidate matches) instead of a bare status string.
    # Absent/empty on a full run (its records carry the finalized assignments). NotRequired — additive-optional.
    previewClusters: NotRequired[list[PreviewCluster]]
    # STAGED REVIEW (additive v5). The post-split concept groups Gate 1 renders. Present on a run that
    # paused at (or passed through) the Gate 1 boundary; absent on a preview run, which never gets there.
    # NotRequired — additive-optional, following the previewClusters template.
    conceptGroups: NotRequired[list[UIConceptGroup]]
    # The UNCAPPED membership per group id — the expanded row's source, and the only shape a regroup verb
    # can be implemented against (a drag over a 25-of-40 sample would silently discard the 15 it never
    # saw). A sibling lookup rather than a second request, for the same reason `fieldIndex` is one: a
    # paused run's state is persisted as THIS contract, so anything an expansion needs has to be in it.
    conceptGroupMembers: NotRequired[dict[str, list[str]]]
    # Signals that carry no value on this run, each with a reason and an entry kind (permanent vs per-run).
    # An explicit reasoned absence, so "we know, and here is why" cannot be confused with "we forgot" —
    # and so an opt-in nobody enabled does not read as a capability the product lacks.
    notComputed: NotRequired[list[NotComputedEntry]]
    # What preprocessing did to each source dictionary, between loading and embedding. One entry per
    # dictionary. Absent when preprocessing did not run at all (an older payload, or a run that gated it
    # off) — which is a different statement from an entry with `ran: false`.
    preprocessing: NotRequired[list[UIPreprocessReport]]
    # The screen this result is the state OF, when the run paused at a gate rather than finishing. Absent
    # on a normal one-shot run. A closed literal, so it can only name a screen that exists.
    gatePosition: NotRequired[GatePosition]
    # Mirrors ``Job.resultVersion`` — the token the 2 Hz progress frame carries. Stamped here so a client
    # that refetched BECAUSE the token moved can confirm it got the version it asked for, rather than a
    # racing older payload. Bumped only on a payload change, never on a progress tick (D-03).
    resultVersion: NotRequired[int]


# Phase sequences the UI consumes to render progress (data-driven — see §1 "new/removed stage" row).
# "refine" runs LAST — core authors derived CDEs after specgen, so its progress lands after "specs".
PHASES_RUN = [
    "loading",
    "embedding",
    "clustering",
    "generating",
    "splitting",
    "assigning",
    "gencde",
    "specs",
    "refine",
]
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


def empty_cost() -> UICost:
    """A zero-cost block — for preview runs and result builds with no cost ledger (e.g. canned-record tests)."""
    return {"actualUsd": 0.0, "tokens": {"input": 0, "output": 0}, "perStage": {}}
