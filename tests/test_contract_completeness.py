"""The contract-completeness gate: every triage signal the pipeline computes reaches the wire, or is
explicitly and reasonably declared absent.

Three invariants, each of which has a demonstrated failure mode behind it:

1. **No dark signal.** Every diagnostic the core record carries resolves to exactly one of: a contract
   field, a PERMANENT not-computed record (no stage produces it), or a PER-RUN not-computed record (an
   opt-in stage exists and this run did not enable it). A signal that resolves to none of the three is
   dark — computed and paid for, invisible to the reviewer — which is what this file exists to catch.

2. **Unjudged is not coherent.** Core's record defaults ``coherent`` to ``True`` and skips groups below
   the judge's member floor, so a boolean on the wire silently reads as a pass. The contract therefore
   carries a CLOSED four-value state whose fourth value is an explicit not-judged, and a judge error or
   timeout lands on that same value.

3. **A generated element is never a catalog element.** A GenCDE is authored by ddharmon. It carries an
   explicit generated marker and no catalog badge, no catalog identifier of its own and no endorsement,
   because the one thing a reviewer must never be able to conclude is "NIH already publishes this".

The core signal SET is derived from ``LeanBRecord`` rather than hard-coded, so adding a field to core
fails this gate until somebody classifies it. That is the point: the alternative is a list that quietly
stops describing the pipeline.
"""

from __future__ import annotations

import dataclasses

import pytest
from ddharmon.harmonization.models import LeanBRecord

from backend.engine import contract

# ── the core side: which LeanBRecord fields are TRIAGE SIGNALS ────────────────────────────────
#
# Everything else on the record is identity ("which group is this"), a decision ("what did assign
# conclude"), or descriptive metadata the split stage produced. A signal is a DIAGNOSTIC: something a
# stage computed about the quality of a decision, which a reviewer triages on.
#
# A field added to core that belongs in NEITHER list fails `test_every_core_signal_resolves`, naming
# itself. Classify it: add the mapping (or a register entry) if it is a signal, or add it here if it is
# not. Do not silence the failure by deleting the assertion.
_NON_SIGNAL_CORE_FIELDS = frozenset(
    {
        # identity / provenance
        "cluster_id",
        "group_id",
        "concept",
        "member_variable_names",
        "cohorts",
        "cross_cohort",
        "n_members",
        # the assign stage's DECISION (not a diagnostic about it)
        "verdict",
        "route",
        "cde_id",
        "cde_external_id",
        "ideal_cde",
        "rationale",
        "decided_by",
        "top1_cos",
        "chosen_cos",
        # downstream artifacts, carried as their own contract shapes
        "transforms",
        "candidates",
        "gencde",
        # the raw LLM payload — deliberately never on the wire
        "raw",
    }
)


def _core_signals() -> set[str]:
    return {f.name for f in dataclasses.fields(LeanBRecord)} - _NON_SIGNAL_CORE_FIELDS


# ── 1. no dark signal ────────────────────────────────────────────────────────────────────────


def test_the_signal_set_is_derived_from_core_and_is_not_empty():
    """A hard-coded signal list stops describing the pipeline the first time core changes."""
    signals = _core_signals()
    assert signals, "no triage signals derived from LeanBRecord — the classification lists have drifted"
    # Spot-check the three RESEARCH.md called free wins: computed today, historically unmapped.
    assert {"matrix_suspect", "coherence_gap", "adopt_demoted"} <= signals


def test_every_core_signal_resolves_to_a_field_or_a_reasoned_absence():
    """The whole gate. A signal that is neither mapped nor registered is DARK — paid for, invisible."""
    register = contract.not_computed_register()
    unresolved = contract.unresolved_signals(_core_signals(), register=register)
    assert unresolved == [], (
        "these core triage signals are neither carried by a contract field nor recorded in the "
        f"not-computed register: {unresolved}. Map them in TRIAGE_SIGNAL_FIELDS or register them with "
        "a reason and an entry kind."
    )


def test_a_new_unmapped_core_signal_fails_the_gate_and_is_named():
    """The gate's own failure mode. Adding a signal to core with no mapping and no register entry must
    fail here rather than ship dark — and the failure must NAME the signal, or nobody can act on it."""
    fake = "brand_new_core_diagnostic"
    unresolved = contract.unresolved_signals({*_core_signals(), fake}, register=contract.not_computed_register())
    assert unresolved == [fake]


def test_a_signal_resolves_to_exactly_one_kind():
    """Three resolutions, mutually exclusive: a live field, a permanent absence, a per-run absence."""
    register = contract.not_computed_register()
    for name in _core_signals():
        how = contract.resolve_signal(name, register=register)
        assert how in ("field", "permanent", "per_run"), f"{name} resolved to {how!r}"


def test_the_ranked_candidates_signal_is_satisfied_by_its_materialised_shape():
    """`ranking` is core's orphan index list; the wire carries it MATERIALISED as UICandidate.rank +
    llmSuggested. Demanding a literal `ranking` field would add a duplicate of data already delivered."""
    assert contract.resolve_signal("ranking", register=contract.not_computed_register()) == "field"
    assert "candidates" in contract.TRIAGE_SIGNAL_FIELDS["ranking"]
    assert "rank" in contract.UICandidate.__annotations__
    assert "llmSuggested" in contract.UICandidate.__annotations__
    assert "ranking" not in contract.UIRecord.__annotations__


def test_every_register_entry_carries_a_kind_and_a_non_empty_reason():
    """An absence with no reason is indistinguishable from an oversight, which is the whole point of
    having a register instead of an empty field."""
    register = contract.not_computed_register()
    assert register, "the register is empty — expected the opt-in signals to be recorded"
    for entry in register:
        assert entry["kind"] in ("permanent", "per_run"), entry
        assert entry["reason"].strip(), f"{entry['signal']} is registered with no reason"
        assert entry["signal"].strip()


def test_the_two_register_kinds_are_distinguishable_and_both_are_used():
    """A per-run absence and a permanent absence make DIFFERENT claims: 'turn the option on' versus
    'the product cannot do this'. Collapsing them either understates the product or misleads about it."""
    register = contract.not_computed_register()
    kinds = {e["kind"] for e in register}
    assert kinds == {"permanent", "per_run"}, f"expected both entry kinds to be in use, got {kinds}"


def test_the_opt_in_signals_are_registered_as_per_run_not_permanent():
    """STGD-16: both stages ARE wired and default OFF. Recording them as permanent would say the product
    cannot do this, which is now false."""
    register = contract.not_computed_register()
    by_signal = {e["signal"]: e for e in register}
    for signal in ("concept_mismatch", "readjudicated_from"):
        assert signal in by_signal, f"{signal} is not in the default register"
        assert by_signal[signal]["kind"] == "per_run", f"{signal} must be a PER-RUN absence, not permanent"
        assert by_signal[signal]["reason"].strip()


def test_enabling_the_opt_in_removes_its_register_entry():
    """With the gate on, the signal is a real value on the wire — it must not ALSO be declared absent."""
    on = {e["signal"] for e in contract.not_computed_register(concept_gate=True)}
    assert "concept_mismatch" not in on
    assert (
        contract.resolve_signal("concept_mismatch", register=contract.not_computed_register(concept_gate=True))
        == "field"
    )
    # and re-adjudication drops out of the register once a run actually re-adjudicated
    after = {e["signal"] for e in contract.not_computed_register(readjudicated=True)}
    assert "readjudicated_from" not in after


def test_the_register_is_not_asserted_non_empty_in_the_shape_itself():
    """Every signal being mapped is a GOOD outcome, not a regression — so nothing may require an entry.
    An empty register must be a legal value of the shape."""
    assert contract.not_computed_register(concept_gate=True, readjudicated=True, permanent=False) == []


# ── 2. unjudged is not coherent ──────────────────────────────────────────────────────────────


def test_unjudged_is_not_coherent():
    """T-08-46 / SPEC prohibition #1. Core defaults `coherent=True` and skips groups under the judge's
    member floor, so ANY boolean on the wire reads an unjudged group as a pass. The four-state cell is
    the fix: `not_judged` is a value, not an absence, and nothing maps an unjudged group to `single`."""
    assert contract.COHERENCE_STATES == ("single", "qualify", "split", "not_judged")
    assert contract.COHERENCE_NOT_JUDGED == "not_judged"
    # a group the judge was never asked about (core leaves the verdict "")
    assert contract.coherence_state("") == "not_judged"
    assert contract.coherence_state(None) == "not_judged"
    # a judge error or timeout: the adapter stamps nothing, so the verdict is still ""
    assert contract.coherence_state("   ") == "not_judged"
    # an unparseable / unexpected verdict is NOT quietly promoted to the clean state
    assert contract.coherence_state("coherent") == "not_judged"
    assert contract.coherence_state("yes") == "not_judged"
    # only the judge's own three verdicts pass through
    assert contract.coherence_state("single") == "single"
    assert contract.coherence_state("qualify") == "qualify"
    assert contract.coherence_state("split") == "split"
    # nothing maps to a pass except an actual `single` verdict
    assert {v for v in ("", None, "coherent", "true", "1") if contract.coherence_state(v) == "single"} == set()


def test_the_coherence_cell_is_not_a_boolean():
    """The failure this replaces: `coherent: bool`, which core defaults to True."""
    ann = str(contract.UIRecord.__annotations__["coherence"])
    assert "bool" not in ann, f"the coherence cell must not be a boolean: {ann}"
    assert "CoherenceState" in ann or "not_judged" in ann


def test_a_concept_group_cannot_omit_its_coherence_cell():
    """On the GROUP shape — Gate 1's row — the cell is REQUIRED, not optional. An omitted cell is an
    absence, and an absence is exactly what a consumer reads as clean."""
    assert "coherence" in contract.UIConceptGroup.__annotations__
    assert "NotRequired" not in str(contract.UIConceptGroup.__annotations__["coherence"])
    assert set(contract.UIConceptGroup.__required_keys__) >= {"coherence", "nMembers", "groupId", "clusterId"}


def test_the_judge_signals_have_somewhere_to_land():
    for key in (
        "coherence",
        "coherenceSummary",
        "coherenceAxis",
        "coherenceDistinctValues",
        "coherenceOutliers",
        "coherenceKind",
        "incoherent",
        "matrixSuspect",
        "coherenceGap",
        "adoptDemoted",
    ):
        assert key in contract.UIRecord.__annotations__, f"UIRecord carries no {key}"


def test_coherence_gap_and_coverage_gap_are_different_fields():
    """Two unrelated diagnostics one letter apart: M3's unmappable-values gate versus the novel-below-tau
    retrieval diagnostic. Folding them would make each unreadable."""
    assert "coherenceGap" in contract.UIRecord.__annotations__
    assert "coverageGap" in contract.UIRecord.__annotations__
    assert contract.TRIAGE_SIGNAL_FIELDS["coherence_gap"] != contract.TRIAGE_SIGNAL_FIELDS["coverage_gap"]


# ── 3. a generated element is never a catalog element ────────────────────────────────────────

#: Field names that would let a generated element be read as a published catalog entry.
_CATALOG_CLAIM_KEYS = frozenset(
    {
        "cdeId",
        "cdeExternalId",
        "externalId",
        "tinyId",
        "catalogBadge",
        "isCatalog",
        "endorsed",
        "endorsement",
        "steward",
        "registryStatus",
    }
)


def test_gencde_labelled():
    """T-08-47. A generated element carries an explicit generated marker and NO catalog identity."""
    keys = set(contract.UIGenCDE.__annotations__)
    assert "isGenerated" in keys, "a generated element must say so on the wire, not by inference"
    offending = sorted(keys & _CATALOG_CLAIM_KEYS)
    assert offending == [], f"UIGenCDE carries catalog-identity fields: {offending}"
    # The ONLY external identifier a generated element may carry belongs to the PARENT it refines, and it
    # is namespaced so it can never be read as this element's own.
    for key in keys:
        if "ExternalId" in key or "externalId" in key:
            assert key.startswith("parent"), f"{key} is an unnamespaced external id on a generated element"


def test_the_generated_concept_name_is_marked_generated_on_the_group_row():
    """Gate 1's row label is what `generate(ideal)` produced, not a catalog name (UI-SPEC §0.1/§8)."""
    keys = set(contract.UIConceptGroup.__annotations__)
    assert "conceptIsGenerated" in keys
    assert sorted(keys & _CATALOG_CLAIM_KEYS) == []


def test_the_three_nouns_stay_distinct_in_the_contract():
    """CDE (exists) / GenCDE (generated) / concept group (pre-assign). The retired third abbreviation for
    a generated element is never used."""
    src = contract.__file__
    with open(src) as fh:
        text = fh.read()
    assert "CDV" not in text, "the retired 'CDV' abbreviation is never used — it is CDE or GenCDE"


# ── the preparation report (Gate 0's shape; the behaviour is Task 3's) ───────────────────────


def test_a_rule_that_changed_nothing_is_distinguishable_from_one_that_did_not_run():
    """Three claims, three values, plus a fourth for a rule that threw. Collapsing 'ran, changed nothing'
    into 'did not run' is how a preparation report starts lying about what it did."""
    assert contract.RULE_OUTCOMES == ("changed", "no_change", "not_run", "failed")
    assert len(set(contract.RULE_OUTCOMES)) == 4


def test_the_preparation_report_counts_rows_not_metadata_attributes():
    """A variable is a dictionary ROW; a field is a metadata ATTRIBUTE. The denominators are row counts."""
    keys = set(contract.UIPreprocessReport.__annotations__)
    assert {"nVariables", "nUniqueVariableNames", "nNothingToEmbed", "rules", "diff"} <= keys
    assert "nVariables" in contract.UIPreprocessRule.__annotations__, "each rule carries its own denominator"


def test_the_preparation_report_does_not_imply_per_variable_rule_provenance():
    """SPEC defers per-field rule provenance. A shape with a rule name on a diff row would imply the
    pipeline stamps which rule fired, which it does not."""
    assert "rule" not in contract.UIPreprocessDiff.__annotations__
    assert "rules" not in contract.UIPreprocessDiff.__annotations__
    entry = {e["signal"]: e for e in contract.not_computed_register()}
    assert entry["preprocessing_rule_provenance"]["kind"] == "permanent"


def test_a_before_after_example_is_carried_as_data():
    """T-08-48: uploaded text echoed back. The payload carries plain strings and nothing anywhere names a
    renderable-HTML channel."""
    for key, ann in contract.UIPreprocessDiff.__annotations__.items():
        assert "html" not in key.lower(), f"{key} names an HTML channel on an echoed-text shape"
        assert "html" not in str(ann).lower()


@pytest.mark.parametrize("shape", ["UIPreprocessReport", "UIPreprocessRule", "UIPreprocessDiff"])
def test_the_preparation_shapes_are_on_the_result(shape):
    assert hasattr(contract, shape)
    assert "preprocessing" in contract.UIResult.__annotations__


def test_the_contract_version_is_five():
    assert contract.CONTRACT_VERSION == "5"
