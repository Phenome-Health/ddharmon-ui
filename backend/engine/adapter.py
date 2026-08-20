"""The engine adapter — the ONLY module that imports the ddharmon pipeline.

This is the churn-absorbing layer (the insulation boundary). It does **not** re-implement the
harmonization flow — that was an earlier runner's mistake. ``harmonize_leanb`` already owns the staged
orchestration (cluster → retrieve → generate-ideal → split → per-group assign → route → specs) and
exposes each LLM stage as an *injectable callback*. So this adapter only:

  1. loads + embeds the dictionaries (so it can report load/embed progress), then
  2. calls ``harmonize_leanb(embedded, generate=…, split=…, classify=…, specgen=…)`` passing **our**
     callbacks — each callback just runs its prompts (sync inline, or via the Batch API) and reports
     progress, and
  3. maps the returned ``LeanBRecord``s into the stable ``UIRecord`` contract.

When the pipeline churns, the blast radius is confined here: a record-field rename touches
``_record_to_ui``; a new/removed stage touches one callback wiring line; an engine swap replaces this
file's body. The contract (and the whole frontend) is unaffected.

Run modes:
  * ``batch``   — every LLM stage via the Anthropic Batch API (async, cost-bounded). The deployed default.
  * ``sync``    — every LLM stage inline (needs ``ANTHROPIC_API_KEY``); fast for small runs.
  * ``preview`` — no LLM/key: cluster + retrieve + build the generate prompts, expose their counts. Yields
                  no records (the pipeline needs the LLM to decide anything) — the zero-cost "what would run" path.

The pipeline **requires a CDE backbone** (assignment to the given CDE catalog is the thesis); there is no
``cdeSet=none`` path.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, cast

from backend.engine.contract import (
    CONTRACT_VERSION,
    PHASES_PREVIEW,
    PHASES_RUN,
    AtlasPoint,
    CoherenceState,
    FieldDetail,
    NotComputedEntry,
    PreviewCluster,
    ResponseOptionUI,
    UICandidate,
    UIConceptGroup,
    UICost,
    UIGenCDE,
    UIMember,
    UIRecord,
    UIResult,
    UISummary,
    UITransform,
    UnassignedField,
    coherence_state,
    empty_cost,
    empty_summary,
    not_computed_register,
)

logger = logging.getLogger(__name__)

# (phase, completed, total, cost=None) -> None. Reported between stages and within sync stages. The optional
# 4th arg is the run's realized cost-so-far in USD (only the LLM stages pass it, after pricing their usage);
# the runner folds it into Job.costSoFar for the live "spent so far" counter. Callable[...] so the pre-LLM
# phases can keep calling with 3 args without a type error.
ProgressFn = Callable[..., None]
# list[PromptRecord] -> {id: response}. The execution strategy injected per stage.
StageFn = Callable[[list[Any]], dict[str, Any]]
# () -> "keep" | "discard" | None. A stage consults this on entry: a "keep" stop means the user wants to stop
# but keep results, so a not-yet-started stage returns {} (skipped, no new cost) while the pipeline still
# reaches its end and returns a partial result. ("discard" aborts via progress raising, not here.)
StoppingFn = Callable[[], str | None]

# Same instruction the Batch API appends server-side, so inline (sync) output matches the schema.
_SCHEMA_PREAMBLE = "\n\nRespond with ONLY valid JSON matching this schema (no markdown fences):\n"
_SYNC_MAX_TOKENS = 1024
# Synchronous stages fan their per-prompt LLM calls across a bounded thread pool so a full sync run finishes
# in minutes, not the hours a serial loop would take (each call is a network round-trip). The Anthropic SDK
# client is thread-safe for concurrent requests; the cap keeps us well under per-tier rate limits. Override
# with DDHARMON_SYNC_WORKERS.
_SYNC_MAX_WORKERS = max(1, int(os.environ.get("DDHARMON_SYNC_WORKERS", "8") or "8"))
# How often a batch stage re-checks for a Stop while the Batch API poll blocks (see _batch_stage). Small
# enough that a user's Stop takes effect in seconds, not after the whole batch returns.
_BATCH_POLL_SECS = 3.0


def _noop_progress(phase: str, completed: int = 0, total: int = 0, cost: float | None = None) -> None:
    pass


# ── ddharmon -> contract mapping (the single churn-absorbing surface) ──────────────────────


def _transform_to_ui(t: Any) -> UITransform:
    """Map one ``TransformSpec`` to a ``UITransform`` (kind-specific keys only when populated)."""
    ui: UITransform = {
        "sourceVariable": t.source_variable,
        "targetCdeId": t.target_cde_id,
        "kind": str(t.kind),  # TransformKind is a StrEnum
        "confidence": t.confidence,
        "coverage": t.coverage,
        "needsUnits": t.needs_units,
        "needsData": t.needs_data,
        "needsReview": t.needs_review,
        "rationale": t.rationale,
        "generatedBy": t.generated_by,
    }
    if t.code_map:
        ui["codeMap"] = dict(t.code_map)
    if t.unmapped_source_codes:
        ui["unmappedSourceCodes"] = list(t.unmapped_source_codes)
    if t.factor is not None:
        ui["factor"] = t.factor
    if t.offset is not None:
        ui["offset"] = t.offset
    if t.source_unit:
        ui["sourceUnit"] = t.source_unit
    if t.target_unit:
        ui["targetUnit"] = t.target_unit
    if t.formula:
        ui["formula"] = t.formula
    if t.inputs:
        ui["inputs"] = list(t.inputs)
    if t.method:
        ui["method"] = t.method
    if t.params:
        ui["params"] = dict(t.params)
    return ui


def _candidate_to_ui(c: Any) -> UICandidate:
    return {
        "rank": c.rank,
        "cdeId": c.cde_id,
        "cdeExternalId": c.cde_external_id or "",
        "definition": c.definition,
        "cosine": c.cosine,
        "isChosen": c.is_chosen,
        "llmSuggested": c.llm_suggested,
    }


def _member_ui(member_id: str, index: dict[str, UIMember]) -> UIMember:
    """Resolve a ``cohort:var`` id to a :class:`UIMember` (name + text), falling back to the id parts when
    the field isn't in ``index`` (e.g. a snapshot enriched later, or a test record with no dictionaries)."""
    hit = index.get(member_id)
    if hit is not None:
        return hit
    cohort, _, var = member_id.partition(":")
    name = var or member_id
    return {"id": member_id, "cohort": cohort, "name": name, "text": name}


def build_member_index(embedded: list[Any]) -> dict[str, UIMember]:
    """Build a ``{"cohort:var" -> UIMember}`` lookup from the embedded dictionaries.

    ``text`` is the field's human text (description / question_text / short_label) — the signal that was
    embedded and clustered — so the review UI can show what each concept actually pooled, not opaque ids.
    """
    index: dict[str, UIMember] = {}
    for ed in embedded:
        dd = getattr(ed, "dictionary", None)
        if dd is None:
            continue
        cohort = getattr(dd, "cohort_name", None) or getattr(dd, "name", None) or "?"
        for var, fld in getattr(dd, "fields", {}).items():
            # When a source has no description column, load_dictionary backfills description = variable_name;
            # that echoes the opaque id, so prefer the question/short-label text (what a survey field actually
            # asks) before falling back — otherwise the UI shows codes like "smoking_100cigslifetime".
            desc = getattr(fld, "description", None)
            if desc == var:
                desc = None
            text = desc or getattr(fld, "question_text", None) or getattr(fld, "short_label", None) or var
            key = f"{cohort}:{var}"
            index[key] = {"id": key, "cohort": cohort, "name": var, "text": text}
    return index


def _response_option_ui(o: Any) -> ResponseOptionUI:
    """Map one ``ResponseOption`` (code/label/order) to its UI dict; ``order`` only when the source had one."""
    ui: ResponseOptionUI = {"code": getattr(o, "code", "") or "", "label": getattr(o, "label", "") or ""}
    order = getattr(o, "order", None)
    if order is not None:
        ui["order"] = order
    return ui


def _field_detail(var: str, fld: Any) -> FieldDetail:
    """Map one canonical ``Field`` to a :class:`FieldDetail` (raw attrs; a key only when its value is present).

    ``text`` uses the same derivation as :func:`build_member_index` (description → question_text →
    short_label → variable_name). ``description`` echoing the variable name (a loader backfill) is dropped so
    the UI never shows an opaque id as the field's description — mirroring the ``text`` fallback.
    """
    desc = getattr(fld, "description", None)
    if desc == var:
        desc = None
    qtext = getattr(fld, "question_text", None)
    short = getattr(fld, "short_label", None)
    detail: FieldDetail = {"name": var, "text": desc or qtext or short or var}
    if desc:
        detail["description"] = desc
    if qtext:
        detail["questionText"] = qtext
    enc = getattr(fld, "value_encoding_raw", None)
    if enc:
        detail["valueEncoding"] = enc
    units = getattr(fld, "units", None)
    if units:
        detail["units"] = units
    dtype = getattr(fld, "data_type", None)
    if dtype:
        detail["dataType"] = dtype
    opts = getattr(fld, "response_options", None)
    if opts:
        detail["responseOptions"] = [_response_option_ui(o) for o in opts]
    return detail


def build_field_index(embedded: list[Any], cde_cohort: str) -> dict[str, FieldDetail]:
    """Build a ``{"cohort:var" -> FieldDetail}`` map over EVERY embedded NON-CDE (source) field.

    Same field set the atlas iterates (the CDE cohort is the assignment backbone, not a source field, so it's
    excluded), but UNCAPPED — this is a lookup, not plotted points. Each entry carries the field's read-in
    attributes so the UI can show full per-field detail (and browse fields that never landed in a concept).
    """
    index: dict[str, FieldDetail] = {}
    for ed in embedded:
        dd = getattr(ed, "dictionary", None)
        if dd is None:
            continue
        cohort = getattr(dd, "cohort_name", None) or getattr(dd, "name", None) or "?"
        if cohort == cde_cohort:
            continue
        for var, fld in getattr(dd, "fields", {}).items():
            index[f"{cohort}:{var}"] = _field_detail(var, fld)
    return index


def _unassigned_fields(
    field_index: dict[str, FieldDetail], records: list[UIRecord], atlas: list[AtlasPoint]
) -> list[UnassignedField]:
    """Source fields present in the field index but in NO record's members (unclustered / dropped outliers).

    ``x``/``y`` are attached only when the field is in the (downsampled) atlas sample; this list is uncapped.
    """
    assigned: set[str] = set()
    for r in records:
        assigned.update(r["members"])
    coords = {f"{p['cohort']}:{p['variable']}": (p["x"], p["y"]) for p in atlas}
    out: list[UnassignedField] = []
    for key, detail in field_index.items():
        if key in assigned:
            continue
        cohort, _, variable = key.partition(":")
        uf: UnassignedField = {"cohort": cohort, "variable": variable, "text": detail.get("text", "")}
        xy = coords.get(key)
        if xy is not None:
            uf["x"] = xy[0]
            uf["y"] = xy[1]
        out.append(uf)
    return out


def _gencde_to_ui(g: Any) -> UIGenCDE | None:
    """Map a proposed ``GenCDE`` to a ``UIGenCDE``; ``None`` when the record has none.

    Covers BOTH provenances. A ``novel`` group's element is synthesized from scratch; a ``refine``
    group's is derived from the matched CDE, and then the derivation block below is populated. Reading
    the shared fields only would silently present a refinement as a from-scratch proposal — the parent it
    refines, the relation, and the delta are exactly what a reviewer needs to judge it.

    Derivation fields are read with ``getattr`` defaults so this adapter still works against a pinned
    core that predates them (the contract is versioned, the core ref is not always in lockstep).
    """
    if g is None:
        return None
    ui: UIGenCDE = {
        "gencdeId": g.gencde_id,
        "preferredName": g.preferred_name,
        "title": g.title,
        "definition": g.definition,
        "questionText": g.question_text,
        "dataType": g.data_type,
        "permissibleValues": [{"code": o.code, "label": o.label} for o in g.permissible_values],
        "aliases": list(g.aliases),
        "sourceVariables": list(g.source_variables),
        "sourceCohorts": list(g.source_cohorts),
        "relatedCdes": list(g.related_cdes),
        "valueCoverage": g.value_coverage,
        "uncoveredLabels": list(g.uncovered_labels),
        "confidence": g.confidence,
        "needsReview": g.needs_review,
        "rationale": g.rationale,
        "generatedBy": g.generated_by,
    }
    if g.units:
        ui["units"] = g.units
    if g.minimum_value is not None:
        ui["minimum"] = g.minimum_value
    if g.maximum_value is not None:
        ui["maximum"] = g.maximum_value
    # Derived element (refine route): carry the parent + relation + delta so the UI can render it as a
    # refinement of a real standard rather than a new proposal. Absent for a from-scratch novel.
    parent = getattr(g, "parent_cde_id", None)
    if parent:
        ui["parentCdeId"] = parent
        ui["parentCdeExternalId"] = getattr(g, "parent_cde_external_id", None) or ""
        ui["relation"] = getattr(g, "relation", "") or ""
        ui["refinementAxis"] = getattr(g, "refinement_axis", "") or ""
        ui["qualifierAdded"] = getattr(g, "qualifier_added", "") or ""
        ui["addedPermissibleValues"] = [
            {"code": o.code, "label": o.label} for o in getattr(g, "added_permissible_values", []) or []
        ]
        ui["deprecatedValues"] = list(getattr(g, "deprecated_values", []) or [])
        ui["changedFields"] = list(getattr(g, "changed_fields", []) or [])
        ui["completedFields"] = list(getattr(g, "completed_fields", []) or [])
        ui["deltaSize"] = float(getattr(g, "delta_size", 0.0) or 0.0)
        ui["overRefined"] = bool(getattr(g, "over_refined", False))
    return ui


def _record_to_ui(r: Any, member_index: dict[str, UIMember], *, concept_gate: bool = False) -> UIRecord:
    """Map one ``LeanBRecord`` to a ``UIRecord``. The single function that knows the record's field names.

    ``concept_gate`` says whether the opt-in M7 stage RAN on this run. When it did not, the
    ``conceptMismatch`` key is omitted entirely rather than emitted as ``False``: a false-valued flag on a
    check nobody performed is the "empty reads as a clean pass" failure, and the not-computed register
    carries the honest statement instead.
    """
    ui: UIRecord = {
        "id": r.group_id or r.cluster_id,
        "clusterId": r.cluster_id,
        "groupId": r.group_id,
        "concept": r.concept,
        "verdict": r.verdict or "unclassified",
        "route": r.route,
        "cde": {"id": r.cde_id, "externalId": r.cde_external_id or ""} if r.cde_id else None,
        "idealCde": r.ideal_cde,
        "gencde": _gencde_to_ui(r.gencde),
        "cosines": {"top1": r.top1_cos, "chosen": r.chosen_cos},
        "coverageGap": r.coverage_gap,
        "floored": r.floored,
        "crossCohort": r.cross_cohort,
        "nMembers": r.n_members,
        "cohorts": list(r.cohorts),
        "members": list(r.member_variable_names),
        "memberDetails": [_member_ui(m, member_index) for m in r.member_variable_names],
        "transforms": [_transform_to_ui(t) for t in r.transforms],
        "candidates": [_candidate_to_ui(c) for c in r.candidates],
        "rationale": r.rationale,
        "decidedBy": r.decided_by,
        # ── the triage signals (v5) ──
        # Every one of these was computed by a stage that ran, and none of them reached the wire before
        # v5. `getattr` throughout: prod pins core to a PyPI version and dev to a git ref, so a record
        # from an older core must yield the field's zero value rather than an AttributeError mid-run.
        #
        # The coherence cell is DERIVED from the verdict, never from core's `coherent` boolean — that
        # boolean defaults True and cannot express "not judged", so reading it is the defect (T-08-46).
        "coherence": _coherence_cell(r),
        "coherenceSummary": str(getattr(r, "coherence_summary", "") or ""),
        "coherenceAxis": str(getattr(r, "coherence_axis", "") or ""),
        "coherenceDistinctValues": list(getattr(r, "coherence_distinct_values", []) or []),
        "coherenceOutliers": list(getattr(r, "coherence_outliers", []) or []),
        "coherenceKind": str(getattr(r, "coherence_kind", "") or ""),
        "incoherent": bool(getattr(r, "incoherent", False)),
        # The three RESEARCH.md called free wins: computed on every run today, mapped nowhere until now.
        "matrixSuspect": bool(getattr(r, "matrix_suspect", False)),
        "coherenceGap": bool(getattr(r, "coherence_gap", False)),
        "adoptDemoted": bool(getattr(r, "adopt_demoted", False)),
    }
    if concept_gate:
        ui["conceptMismatch"] = bool(getattr(r, "concept_mismatch", False))
    readjudicated_from = str(getattr(r, "readjudicated_from", "") or "")
    if readjudicated_from:
        # Only ever set on a re-adjudication CHILD. Absent means this row is an original grouping, which
        # the register states positively rather than leaving to inference.
        ui["readjudicatedFrom"] = readjudicated_from
    return ui


def _summarize(records: list[UIRecord]) -> UISummary:
    if not records:
        return empty_summary()
    counts: dict[str, int] = {}
    cohorts: set[str] = set()
    for r in records:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
        cohorts.update(r["cohorts"])
    return {
        "nRecords": len(records),
        "counts": counts,
        "nCrossCohort": sum(1 for r in records if r["crossCohort"]),
        "nAssigned": sum(1 for r in records if r["route"] == "assigned"),
        "nGencdeResidual": sum(1 for r in records if r["route"] == "gencde_residual"),
        "nWithTransforms": sum(1 for r in records if r["transforms"]),
        "cohorts": sorted(cohorts),
    }


_PREVIEW_MEMBER_CAP = 25  # members surfaced per preview cluster (nMembers keeps the true size)


def _preview_clusters(leanb_result: Any, cap: int = _PREVIEW_MEMBER_CAP) -> list[PreviewCluster]:
    """Extract the preview's clusters + retrieved CDE candidates from the generate-ideal prompts — each
    ``ideal_prompts`` PromptRecord carries its cluster's members + top-k retrieval candidates in ``context``
    (see ``prepare_leanb``). NO LLM ran, so these candidates are RETRIEVAL hits, not assignments. Members are
    capped to ``cap`` per cluster (``nMembers`` is the true size); biggest clusters first (most likely to be
    restructured by a full run's split stage → most worth eyeballing)."""
    out: list[PreviewCluster] = []
    for pr in getattr(leanb_result, "ideal_prompts", []):
        ctx = pr.context or {}
        members = ctx.get("members", [])
        cands = ctx.get("candidates", [])
        top1 = ctx.get("top1_cos")
        cluster: PreviewCluster = {
            "clusterId": ctx.get("cluster_id", ""),
            "nMembers": int(ctx.get("n_members", len(members))),
            "cohorts": list(ctx.get("cohorts", [])),
            "crossCohort": bool(ctx.get("cross_cohort", False)),
            "top1Cos": float(top1) if top1 is not None else None,
            "members": [
                {
                    "cohort": m.get("dictionary_name", ""),
                    "variable": m.get("variable_name", ""),
                    "text": m.get("text", ""),
                }
                for m in members[:cap]
            ],
            "candidates": [
                {
                    "rank": i + 1,
                    "cdeId": c.get("designation", ""),
                    "cdeExternalId": c.get("external_id", "") or "",
                    "definition": c.get("text", ""),
                    "cosine": round(float(c.get("cos", 0.0)), 4),
                }
                for i, c in enumerate(cands)
            ],
        }
        out.append(cluster)
    # Size first (the biggest clusters are the ones a full run is most likely to restructure, so they are
    # the ones worth eyeballing), then cluster id. The id term is what makes the order STABLE: a pure
    # descending size sort leaves equal-sized clusters in whatever order the prompts came back in, and a
    # list that reorders itself between two looks at the same frozen substrate is indistinguishable from
    # the run having changed underneath the reviewer.
    out.sort(key=lambda pc: (-pc["nMembers"], pc["clusterId"]))
    return out


#: Members carried on a COLLAPSED Gate 1 group row. The true count travels beside it (``nMembers``) and
#: the uncapped membership travels in ``UIResult.conceptGroupMembers``, so nothing has to guess.
_GROUP_MEMBER_CAP = 25


def _coherence_cell(obj: Any) -> CoherenceState:
    """The four-state coherence cell for one group or record.

    Derived from core's ``coherence_verdict`` ONLY. Core's ``coherent`` boolean is deliberately not read:
    it defaults to ``True`` and the judge skips groups under its member floor, so a group nobody asked
    about is indistinguishable from a group the judge blessed — and the boolean is the attribute that
    makes them indistinguishable. Everything that is not one of the judge's three verdicts (never asked,
    no usable response, a runner that raised) becomes ``not_judged``.
    """
    return coherence_state(getattr(obj, "coherence_verdict", ""))


def _concept_groups_to_ui(leanb_result: Any, cap: int = _GROUP_MEMBER_CAP) -> list[UIConceptGroup]:
    """Map core's post-split ``ConceptGroup``s onto the contract — the rows Gate 1 renders (UI-SPEC §0.1).

    Read off ``LeanBResult.concept_groups``, which 08-04 added and which the ``classify=None`` early
    return carries. ``getattr`` with a default rather than an attribute access: the dev channel swaps core
    versions, and a core pinned before that change must yield an empty list here, not an AttributeError
    that unwinds a run whose paid stages have already completed.

    Deterministic order: ``(-nMembers, clusterId, groupId)``. The size term is what a reviewer wants
    first; the two id terms are what make it STABLE, because a pure size sort leaves equal-sized groups in
    whatever order the prompts happened to come back in, and "the list reordered itself between two looks
    at the same paused run" is indistinguishable from the run having changed.

    Members are capped to ``cap`` for the collapsed row; ``nMembers`` stays the TRUE count and
    ``membersTruncated`` says which it is. Nothing assign produced is copied: no verdict, no route, no
    CDE, no candidates. This is the shape BEFORE any of those exist, and filling them with defaults is how
    "not computed" starts reading as "computed and empty".
    """
    out: list[UIConceptGroup] = []
    for g in getattr(leanb_result, "concept_groups", []) or []:
        top1 = getattr(g, "top1_cos", None)
        members = list(getattr(g, "member_variable_names", []) or [])
        n_members = int(getattr(g, "n_members", 0) or 0) or len(members)
        out.append(
            {
                "groupId": getattr(g, "group_id", "") or "",
                "clusterId": getattr(g, "cluster_id", "") or "",
                "concept": getattr(g, "concept", "") or "",
                # A ConceptGroup's name is what generate(ideal) authored. Stated positively on every row.
                "conceptIsGenerated": True,
                "idealCde": getattr(g, "ideal_cde", "") or "",
                "nMembers": n_members,
                "cohorts": list(getattr(g, "cohorts", []) or []),
                "crossCohort": bool(getattr(g, "cross_cohort", False)),
                "top1Cos": float(top1) if top1 is not None else None,
                "memberVariableNames": members[:cap],
                "membersTruncated": len(members) > cap,
                # The judge's verdicts, stamped pre-assign by 08-04's verdict pass. A group the judge was
                # never asked about lands on `not_judged` — never on the clean state.
                "coherence": _coherence_cell(g),
                "coherenceSummary": str(getattr(g, "coherence_summary", "") or ""),
                "coherenceAxis": str(getattr(g, "coherence_axis", "") or ""),
                "coherenceDistinctValues": list(getattr(g, "coherence_distinct_values", []) or []),
                "coherenceOutliers": list(getattr(g, "coherence_outliers", []) or []),
                "incoherent": bool(getattr(g, "incoherent", False)),
                "matrixSuspect": bool(getattr(g, "matrix_suspect", False)),
            }
        )
    out.sort(key=lambda g: (-g["nMembers"], g["clusterId"], g["groupId"]))
    return out


def _concept_group_members(leanb_result: Any) -> dict[str, list[str]]:
    """The UNCAPPED membership per group id — what an expanded Gate 1 row reads.

    A sibling lookup rather than a second endpoint, and for a concrete reason: a paused run's state is
    persisted as this contract, not as core objects, so an expansion path that needed a ``LeanBResult``
    would be unimplementable the moment the reviewer closed the browser. ``fieldIndex`` is uncapped in
    this contract for the same reason.
    """
    out: dict[str, list[str]] = {}
    for g in getattr(leanb_result, "concept_groups", []) or []:
        gid = (getattr(g, "group_id", "") or "") or (getattr(g, "cluster_id", "") or "")
        if gid:
            out[gid] = list(getattr(g, "member_variable_names", []) or [])
    return out


def expand_concept_group(result: UIResult, group_id: str) -> list[str]:
    """The expanded row's members for one group — the FULL membership, never the collapsed sample.

    A regroup verb (drag a variable out of one group into another) writes back the membership it was
    shown. Given a 25-of-40 sample it would silently drop 15 members, so the expanded read is a backend
    shape requirement rather than a UI nicety.
    """
    full = (result.get("conceptGroupMembers") or {}).get(group_id)
    if full is not None:
        return list(full)
    for g in result.get("conceptGroups") or []:
        if g["groupId"] == group_id:
            # No uncapped map (a pre-v5 payload): return what there is, and only when it IS everything.
            return [] if g["membersTruncated"] else list(g["memberVariableNames"])
    return []


def _not_computed(*, concept_gate: bool, readjudicated: bool) -> list[NotComputedEntry]:
    """This run's not-computed register — see :func:`backend.engine.contract.not_computed_register`."""
    return not_computed_register(concept_gate=concept_gate, readjudicated=readjudicated)


def build_ui_result(
    leanb_result: Any,
    *,
    mode: str,
    phases: list[str],
    atlas: list[AtlasPoint] | None = None,
    member_index: dict[str, UIMember] | None = None,
    field_index: dict[str, FieldDetail] | None = None,
    cost: UICost | None = None,
    preview_clusters: list[PreviewCluster] | None = None,
    gate_position: str | None = None,
    result_version: int | None = None,
    concept_gate: bool = False,
) -> UIResult:
    """Map a ``LeanBResult`` to the stable ``UIResult`` contract.

    ``member_index`` (from :func:`build_member_index`) enriches each record's ``memberDetails`` with the
    source field text; when omitted, member details fall back to the ``cohort:var`` id parts.

    ``field_index`` (from :func:`build_field_index`) is the uncapped per-field detail map surfaced as
    ``fieldIndex``; it also drives ``unassignedFields`` (its keys MINUS the union of record member keys). When
    omitted, both are empty (e.g. canned-record tests with no dictionaries).
    """
    idx = member_index or {}
    fidx = field_index or {}
    atlas_pts = atlas or []
    records = [_record_to_ui(r, idx, concept_gate=concept_gate) for r in leanb_result.records]
    groups = _concept_groups_to_ui(leanb_result)
    # Derived, not declared: a run has re-adjudication provenance iff some row actually carries it. Asking
    # the caller to tell us would let the register disagree with the payload it describes.
    readjudicated = any(r.get("readjudicatedFrom") for r in records)
    result: UIResult = {
        "contractVersion": CONTRACT_VERSION,
        "mode": mode,
        "phases": phases,
        "records": records,
        "summary": _summarize(records),
        "prompts": {
            "ideal": len(leanb_result.ideal_prompts),
            "split": len(leanb_result.split_prompts),
            "groupAssign": len(leanb_result.group_assign_prompts),
            "gencde": len(leanb_result.gencde_prompts),
            "specgen": len(leanb_result.specgen_prompts),
        },
        "atlas": atlas_pts,
        "fieldIndex": fidx,
        "unassignedFields": _unassigned_fields(fidx, records, atlas_pts),
        "cost": cost if cost is not None else empty_cost(),
        "previewClusters": preview_clusters or [],
        # v5 additive. Read off the LeanBResult unconditionally rather than only on a staged run: a
        # one-shot run passed THROUGH the Gate 1 boundary, so its groups are a real artifact of it and
        # withholding them would make the same run answer differently depending on how it was launched.
        "conceptGroups": groups,
        # The uncapped membership behind the collapsed rows above (the expanded row's source).
        "conceptGroupMembers": _concept_group_members(leanb_result),
        # Signals with no value on THIS run, each with a reason and an entry kind. Computed per result
        # rather than hard-coded, so an enabled opt-in drops out of it instead of contradicting the wire.
        "notComputed": _not_computed(concept_gate=concept_gate, readjudicated=readjudicated),
    }
    if gate_position is not None:
        result["gatePosition"] = cast(Any, gate_position)
    if result_version is not None:
        result["resultVersion"] = result_version
    return result


def _atlas_points(embedded: list[Any], cde_cohort: str, cap: int = 2500) -> list[AtlasPoint]:
    """Project every (non-CDE) field's embedding to 2D via PCA (SVD) for the cohort-colored atlas.

    Deterministic (no random init). Downsamples evenly to ``cap`` points so the scatter stays responsive.
    Returns [] when there are too few fields to project.
    """
    import numpy as np

    vecs: list[Any] = []
    meta: list[tuple[str, str]] = []
    for ed in embedded:
        dd = getattr(ed, "dictionary", None)
        name = getattr(dd, "cohort_name", None) or getattr(dd, "name", None) or "?"
        if name == cde_cohort:
            continue
        names = list(ed.get_variable_names())
        if not names:  # an empty dictionary would make get_all_vectors() np.stack([]) and raise
            continue
        mat = np.asarray(ed.get_all_vectors(), dtype=np.float32)
        for v, row in zip(names, mat, strict=False):
            vecs.append(row)
            meta.append((name, v))
    if len(vecs) < 3:
        return []
    matrix = np.asarray(vecs, dtype=np.float32)
    if len(matrix) > cap:
        idx = np.linspace(0, len(matrix) - 1, cap).astype(int)
        matrix = matrix[idx]
        meta = [meta[i] for i in idx]
    centered = matrix - matrix.mean(axis=0)
    _u, _s, vt = np.linalg.svd(centered, full_matrices=False)
    coords = centered @ vt[:2].T
    return [
        {
            "cohort": meta[i][0],
            "variable": meta[i][1],
            "x": round(float(coords[i, 0]), 4),
            "y": round(float(coords[i, 1]), 4),
        }
        for i in range(len(meta))
    ]


# ── stage execution strategies (sync inline / Batch API) ──────────────────────────────────


def _sync_stage(
    phase: str,
    progress: ProgressFn,
    client: Any,
    ledger: Any,
    stopping: StoppingFn | None = None,
    ledger_key: str | None = None,
) -> StageFn:
    """A stage callback that runs its prompts inline via the LLM client — concurrently, across a bounded
    thread pool — reporting per-item progress. After the stage finishes it drains the client's realized token
    usage into ``ledger`` (sync = full price) and reports the run's cost-so-far for the live counter.

    Concurrency makes a full sync run finish in minutes rather than the hours a serial per-prompt loop would
    take. A "discard" stop surfaces as ``progress`` raising mid-loop; we then cancel the not-yet-started calls
    so we stop paying immediately (in-flight calls can't be un-sent, mirroring the Batch stage's semantics).
    """

    def stage(prompts: list[Any]) -> dict[str, Any]:
        if not prompts:
            return {}
        if stopping and stopping() == "keep":  # keep-stop before this stage started -> skip it (no new cost)
            return {}
        from concurrent.futures import ThreadPoolExecutor, as_completed

        n = len(prompts)
        progress(phase, 0, n)

        def _run_one(rec: Any) -> tuple[str, Any]:
            system = rec.system_prompt + _SCHEMA_PREAMBLE + rec.schema
            return rec.id, client.complete(rec.user_prompt, system=system, max_tokens=_SYNC_MAX_TOKENS)

        out: dict[str, Any] = {}
        done = 0
        with ThreadPoolExecutor(max_workers=min(_SYNC_MAX_WORKERS, n)) as ex:
            futures = [ex.submit(_run_one, rec) for rec in prompts]
            try:
                for fut in as_completed(futures):
                    rid, resp = fut.result()
                    out[rid] = resp
                    done += 1
                    progress(phase, done, n)  # raises on a "discard" stop -> abort the stage promptly
            except BaseException:
                for f in futures:  # cancel not-yet-started calls so a discard-stop stops paying immediately
                    f.cancel()
                raise
        # Attribute this stage's realized spend (sync = full price) + surface the running total for the live UI.
        # Cost is keyed on `ledger_key` (defaulting to the phase) so an advisory stage that REPORTS under an
        # existing progress phase still gets its own line in the cost breakdown — see _JUDGE_STAGES.
        ledger.add(ledger_key or phase, client.drain_usage(), batch=False)
        progress(phase, n, n, ledger.total_usd)
        return out

    return stage


def specgen_stage_fn(client: Any) -> StageFn:
    """A minimal, progress-free synchronous stage callback for one-off recode regeneration.

    Runs each ``PromptRecord`` through ``client.complete`` exactly like :func:`_sync_stage` (same schema
    preamble + token cap) but without the per-item progress reporting — used by the targeted GenCDE
    spec-regen endpoint, which runs a handful of prompts inline rather than a whole staged run.
    """

    def stage(prompts: list[Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for rec in prompts:
            system = rec.system_prompt + _SCHEMA_PREAMBLE + rec.schema
            out[rec.id] = client.complete(rec.user_prompt, system=system, max_tokens=_SYNC_MAX_TOKENS)
        return out

    return stage


def _batch_stage(
    phase: str,
    progress: ProgressFn,
    work_dir: Path,
    tag: str,
    ledger: Any,
    api_key: str | None = None,
    stopping: StoppingFn | None = None,
    ledger_key: str | None = None,
) -> StageFn:
    """A stage callback that runs all prompts through the Anthropic Batch API (blocking poll).

    Uses ``resume_and_wait`` (cache-aware): an existing ``responses_<tag>.jsonl`` is reused as-is and only
    missing ids are (re)submitted — so a re-run over a frozen work_dir is a byte-identical, $0 replay, and an
    interrupted batch resumes instead of re-paying. ``api_key`` (optional) is the per-request BYOK key.

    Cancellation: ``resume_and_wait`` blocks polling the Batch API until the batch ends, so a naive call would
    make a user's Stop wait out the whole batch. Instead we run it on a daemon thread and call ``progress`` on
    a short interval — ``progress`` raises (the runner's cancellation signal) when Stop was pressed, aborting
    within ``_BATCH_POLL_SECS`` instead of minutes. The abandoned thread finishes its poll and exits on its
    own; the already-submitted batch still completes server-side (it can't be un-submitted), but we stop
    consuming it and NO downstream stage is submitted after the Stop — which is where the cost is.
    """

    def stage(prompts: list[Any]) -> dict[str, Any]:
        if not prompts:
            return {}
        if stopping and stopping() == "keep":  # keep-stop before this stage started -> skip it (never submit)
            return {}
        from ddharmon.harmonization import write_prompts_jsonl
        from ddharmon.llm.batch import resume_and_wait

        n = len(prompts)
        progress(phase, 0, n)
        work_dir.mkdir(parents=True, exist_ok=True)
        prompts_path = work_dir / f"prompts_{tag}.jsonl"
        responses_path = work_dir / f"responses_{tag}.jsonl"
        write_prompts_jsonl(prompts, prompts_path)
        # Run the blocking Batch API wait off-thread so we can honor a mid-poll Stop (see docstring).
        holder: dict[str, BaseException] = {}

        def _wait() -> None:
            try:
                resume_and_wait(prompts_path, responses_path, api_key=api_key)
            except BaseException as exc:  # noqa: BLE001 — captured and re-raised on the calling thread
                holder["exc"] = exc

        worker = threading.Thread(target=_wait, name=f"ddharmon-batch-{tag}", daemon=True)
        worker.start()
        while worker.is_alive():
            worker.join(timeout=_BATCH_POLL_SECS)
            progress(phase, 0, n)  # heartbeat + cancellation checkpoint (raises on Stop -> abort the poll)
        if "exc" in holder:
            raise holder["exc"]
        from ddharmon.llm.cost import TokenUsage

        out: dict[str, Any] = {}
        usages: list[Any] = []
        with open(responses_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                out[rec["id"]] = rec["response"]
                # Realized usage the retrieve preserved (older cached response files predate it -> just skip;
                # that stage prices to $0, which is honest for a cache replay that re-paid nothing).
                u = rec.get("usage")
                if u:
                    usages.append(
                        TokenUsage(
                            model=rec.get("model"),
                            input_tokens=int(u.get("input_tokens", 0) or 0),
                            output_tokens=int(u.get("output_tokens", 0) or 0),
                        )
                    )
        # Keyed on `ledger_key` (default: the phase) — see _sync_stage.
        ledger.add(ledger_key or phase, usages, batch=True)  # Batch bills at 50% (applied in price_usage).
        progress(phase, n, n, ledger.total_usd)
        return out

    return stage


# ── entry point ────────────────────────────────────────────────────────────────────────────


def _auto_min_cluster_size(n_fields: int) -> int:
    """A sensible HDBSCAN ``min_cluster_size`` scaled to corpus size.

    Users no longer set this — clustering is a coarse scaffold that the split-aware stages (split → per-group
    assign → merge) re-partition, so it only needs to be *reasonable*: small uploads get a low floor so
    concepts still form (a big mcs on a tiny set would make everything an outlier), large cohorts cap at the
    long-standing default of 15. Explicit ``min_cluster_size`` in the run config always wins over this.
    """
    return max(3, min(15, round(n_fields / 150)))


def _save_substrate_if_new(substrate_path: Path | None, result: Any) -> None:
    """Persist the freshly-built clustering partition for reproducible replay.

    Only writes when a path was requested AND the file doesn't exist yet — a reload run leaves the frozen
    file untouched. ``result.substrate`` is the ``ClusteringSubstrate`` ``harmonize_leanb`` builds.
    """
    if substrate_path and not substrate_path.exists() and getattr(result, "substrate", None) is not None:
        from ddharmon.harmonization.substrate import save_substrate

        substrate_path.parent.mkdir(parents=True, exist_ok=True)
        save_substrate(result.substrate, substrate_path)


# ── staged review: the resumable boundary, and how a resumed leg avoids paying twice ─────────
#
# The gate a run stops at is expressed in core's OWN vocabulary; this adapter invents no new stop
# mechanism (UI-SPEC §0.1's boundary table is authoritative):
#
#   gate1  — withhold the ``classify`` callable. That is the ALREADY-SHIPPED early return, and after
#            08-04's reorder it fires after ``generate(ideal)``, ``split`` and the judge, which is exactly
#            where Gate 1 sits. 08-04's one new named boundary is for Gate 1 → Gate 2, not for entering
#            Gate 1, and using it here would stop the run a whole paid stage too late.
#   gate2  — ``stop_after="gencde"``, the one named boundary 08-04 shipped.
#
# Gates 0, 3 and 4 need no core boundary at all (Gate 0 is adapter-side and free; Gate 3 is the finished
# pipeline held by the UI backend; Gate 4 is a pure read), so they are not stop targets here.
_GATE_STOP_MECHANISM = {"gate1": "withhold_classify", "gate2": "stop_after_gencde"}


#: The three ADVISORY stages: they FLAG, they never decide. Two consequences follow, and both are
#: deliberate.
#:
#: 1. They are wrapped in :func:`_resilient_stage`, so a runner that raises or times out costs the run its
#:    flag and nothing else. The alternative — let it propagate — throws away `generate` and `split`
#:    output the caller already PAID for, because an advisory second opinion was unavailable. A judge
#:    failure then arrives on the wire as ``not_judged``, which is the honest reading of "we could not
#:    tell" and is structurally distinct from "it is fine" (T-08-46).
#: 2. They report progress under an EXISTING phase and carry their own COST key. Adding a phase to
#:    ``PHASES_RUN`` would invalidate the shipped demo artifact (``test_content_drift`` asserts the demo's
#:    phase list equals the contract's) and the Methods-page stage manifest — a paid re-run, to rename a
#:    progress label. The cost breakdown is a free-form map, so spend attribution loses nothing.
#:
#: Decision stages are NOT in here on purpose: swallowing a `classify` failure would silently produce a
#: run with no assignments and call it a success.
_JUDGE_STAGES: dict[str, dict[str, str]] = {
    # stage kwarg -> {progress phase it reports under, batch cache tag, cost-ledger key}
    "coherence": {"phase": "splitting", "tag": "coherence", "cost": "judging"},
    "distinct_kinds": {"phase": "specs", "tag": "kinds", "cost": "kinds"},
    "concept_gate": {"phase": "specs", "tag": "concept_gate", "cost": "concept_gate"},
}


def _resilient_stage(name: str, fn: StageFn) -> StageFn:
    """Wrap an ADVISORY stage so a failure degrades the flag instead of unwinding the run.

    Returns ``{}`` on any exception, which leaves core's verdict fields untouched — so the group stays
    explicitly unjudged rather than defaulting to the clean state.

    A cancellation is re-raised: the runner signals a "discard" Stop by making ``progress`` raise from
    inside the stage, and swallowing that would keep the run spending after the user asked it to stop.
    Matched on the exception's TYPE NAME rather than by importing it, because ``backend.runner`` imports
    this module and the dependency only runs one way.
    """

    def stage(prompts: list[Any]) -> dict[str, Any]:
        try:
            return fn(prompts) or {}
        except Exception as exc:  # noqa: BLE001 - an advisory stage must not be able to fail a paid run
            if type(exc).__name__ == "RunCancelledError":
                raise
            logger.warning("advisory stage %s failed (%s: %s) — leaving it NOT JUDGED", name, type(exc).__name__, exc)
            return {}

    return stage


#: Recorded against a prompt id the stage was ASKED about but returned nothing for. JSON-serialisable
#: because it lands in the checkpoint file.
#:
#: Recording *asked* rather than *answered* is the load-bearing choice. A stage that a leg invoked and
#: which came back empty (a malformed LLM response, core's single-group split fallback) was still PAID
#: FOR. Keying replay on answers alone would re-issue exactly those calls on every resume — the runs that
#: already cost money and produced nothing — which is the most expensive possible reading of
#: "no re-charge for work already done".
_NO_ANSWER = {"__no_answer__": True}


def _recording_stage(name: str, fn: StageFn, sink: dict[str, dict[str, Any]]) -> StageFn:
    """Wrap a stage so what it was asked, and what it answered, is captured for the checkpoint."""

    def stage(prompts: list[Any]) -> dict[str, Any]:
        out = fn(prompts) or {}
        answers = {str(k): v for k, v in out.items()}
        recorded = sink.setdefault(name, {})
        for p in prompts:
            pid = str(p.id)
            recorded[pid] = answers.get(pid, _NO_ANSWER)
        return out

    return stage


def _replaying_stage(
    name: str,
    fn: StageFn,
    replay: dict[str, dict[str, Any]],
    sink: dict[str, dict[str, Any]],
) -> StageFn:
    """Answer a stage's prompts from the checkpoint where possible, and call ``fn`` only for the rest.

    This is what makes *"resume issues no new paid call for work already done"* a property of the code
    rather than of a cache. The batch stages already replay ``responses_<tag>.jsonl`` for free, but that
    guarantee (a) is invisible to a test, (b) does not hold for ``sync`` mode, and (c) evaporates if the
    work dir is ever relocated. Replaying from the checkpoint holds in all three cases, and composes with
    the batch cache rather than replacing it.

    A prompt id absent from the checkpoint is genuinely NEW work — a group the previous leg never asked
    about — and is passed through to the real stage. Partial replay is the normal case, not an error.

    An id recorded as :data:`_NO_ANSWER` counts as ASKED and is not re-issued; it is simply omitted from
    the returned mapping, which reproduces exactly what the first leg's stage handed core.
    """
    cached = replay.get(name) or {}

    def stage(prompts: list[Any]) -> dict[str, Any]:
        answers = {
            str(p.id): cached[str(p.id)] for p in prompts if str(p.id) in cached and cached[str(p.id)] != _NO_ANSWER
        }
        replayed = sum(1 for p in prompts if str(p.id) in cached)
        missing = [p for p in prompts if str(p.id) not in cached]
        if missing:
            logger.info("stage %s: replaying %d, running %d", name, replayed, len(missing))
            answers.update({str(k): v for k, v in (fn(missing) or {}).items()})
        else:
            logger.info("stage %s: fully replayed from the checkpoint (%d prompts, $0)", name, replayed)
        recorded = sink.setdefault(name, {})
        for p in prompts:
            pid = str(p.id)
            recorded[pid] = answers.get(pid, cached.get(pid, _NO_ANSWER))
        return answers

    return stage


def run_pipeline(
    dict_specs: list[dict[str, Any]],
    cde_spec: dict[str, Any] | None,
    config: dict[str, Any],
    *,
    progress: ProgressFn | None = None,
    provider: Any | None = None,
    stage_overrides: dict[str, StageFn] | None = None,
    api_key: str | None = None,
    stopping: StoppingFn | None = None,
    substrate_path: str | Path | None = None,
    stage_responses: dict[str, dict[str, Any]] | None = None,
    replay_responses: dict[str, dict[str, Any]] | None = None,
) -> UIResult:
    """Run the pipeline end-to-end and return a contract :class:`UIResult`. Safe to run in a thread.

    Args:
        dict_specs: ``[{path, cohort_name, column_roles}]`` for the uploaded cohort dictionaries.
        cde_spec:   ``{path, cohort_name, column_roles}`` for the CDE catalog (REQUIRED for sync/batch).
        config:     ``{run_mode, cde_cohort, work_dir, min_cluster_size?, top_k?, retrieval_floor?,
                    model_tag?, gen_transform_specs?}``. Unset knobs fall back to ``harmonize_leanb`` defaults.
        progress:   ``(phase, completed, total)`` callback (wired to the JobStore by the runner).
        provider:   embedding provider (defaults to ``SentenceTransformerProvider``; injected in tests).
        stage_overrides: ``{generate, split, classify, specgen}`` stage callbacks (injected in tests to
                    avoid any LLM/network); when given, the run_mode strategy is bypassed.
        api_key:    optional per-request BYOK Anthropic key, passed straight to the core client
                    constructors (sync ``AnthropicClient`` / batch ``resume_and_wait``). ``None`` keeps the
                    default ``ANTHROPIC_API_KEY`` env behavior. In-memory only — never persisted or logged.
        substrate_path: optional path to a frozen clustering substrate for reproducibility. When the file
                    exists it is reloaded (UMAP skipped, the exact partition reproduced); after a fresh run the
                    built partition is saved there. Combined with the cache-aware batch stages, a re-run over
                    the same ``work_dir`` + ``substrate_path`` is byte-identical. A STAGED run
                    (``config["stop_at_gate"]``) defaults it to ``<work_dir>/substrate.joblib`` — the next
                    leg must reproduce the exact partition its Gate 1 decisions were made against, or the
                    reviewer's scoping is applied to a different set of groups than the one they saw.
        stage_responses: an OUT parameter — a dict this call fills with ``{stage: {prompt_id: response}}``
                    for every stage it ran, so the caller can persist it in the checkpoint. Passed in rather
                    than returned because the return value is the frozen ``UIResult`` contract, which must
                    not grow a raw-LLM-response field.
        replay_responses: the same structure read back OUT of a checkpoint. Any prompt id present here is
                    answered from it and never sent to a provider — the "no re-charge on resume" mechanism.

    A staged run (``config["stop_at_gate"]`` set to ``"gate1"`` or ``"gate2"``) returns a PARTIAL result
    carrying ``gatePosition`` plus whatever the stages before that boundary produced.
    """
    from ddharmon.embedding.service import embed_dictionary
    from ddharmon.harmonization import harmonize_leanb
    from ddharmon.ingestion import load_dictionary
    from ddharmon.llm.cost import CostLedger

    progress = progress or _noop_progress
    overrides = stage_overrides or {}
    mode: str = config.get("run_mode", "batch")
    cde_cohort: str = config.get("cde_cohort", "NIH_CDE")
    work_dir = Path(config.get("work_dir", "."))
    # --- staged review: which gate boundary (if any) this leg stops at ---
    stop_at_gate: str | None = config.get("stop_at_gate")
    if stop_at_gate is not None and stop_at_gate not in _GATE_STOP_MECHANISM:
        # Validated BEFORE any work, and by raising rather than ignoring. A silently-dropped typo would
        # run the whole paid pipeline past the boundary the caller asked for — the same failure core's
        # own `stop_after` validation exists to prevent (T-08-20).
        raise ValueError(
            f"stop_at_gate={stop_at_gate!r} is not a resumable boundary; "
            f"expected one of {sorted(_GATE_STOP_MECHANISM)}"
        )
    recorded: dict[str, dict[str, Any]] = stage_responses if stage_responses is not None else {}
    replay: dict[str, dict[str, Any]] = replay_responses or {}
    # Realized-cost accumulator: each LLM stage folds its captured token usage in (sync = full price, batch =
    # 50%), so build_ui_result can emit real spend (UIResult.cost) and the stages can stream a live total.
    ledger = CostLedger()

    # --- load ---
    progress("loading", 0, 0)
    specs = list(dict_specs) + ([cde_spec] if cde_spec else [])
    dictionaries = [load_dictionary(s["path"], cohort_name=s["cohort_name"], **s["column_roles"]) for s in specs]

    # --- embed ---
    total = len(dictionaries)
    progress("embedding", 0, total)
    if provider is None:
        from ddharmon.embedding.provider import SentenceTransformerProvider

        provider = SentenceTransformerProvider()
    embedded = []
    for i, dd in enumerate(dictionaries):
        embedded.append(embed_dictionary(dd, provider=provider))
        progress("embedding", i + 1, total)

    # Guard: an uploaded file with only a header row (or columns that didn't map to a variable/description/
    # question) embeds to ZERO fields. Downstream `get_all_vectors()`/`collect_inputs()` would then `np.stack([])`
    # -> "need at least one array to stack". Drop such empty dictionaries, and if nothing usable remains, fail
    # with a clear, actionable message instead of a cryptic numpy error.
    def _n_fields(ed: Any) -> int:
        return len(list(ed.get_variable_names()))

    empty = [ed for ed in embedded if _n_fields(ed) == 0]
    if empty:
        dropped = sorted(
            getattr(ed.dictionary, "cohort_name", None) or getattr(ed.dictionary, "name", "?") for ed in empty
        )
        logger.warning("dropping %d dictionary(ies) with no usable fields: %s", len(empty), ", ".join(dropped))
        embedded = [ed for ed in embedded if _n_fields(ed) > 0]
    if not any(_n_fields(ed) > 0 for ed in embedded if getattr(ed.dictionary, "cohort_name", None) != cde_cohort):
        raise ValueError(
            "No usable fields found in the uploaded dictionaries. Check that each file has at least one data "
            "row and that its columns are mapped to a variable name and/or a description/question."
        )

    # 2D projection of the field space for the embedding atlas (cheap, deterministic; no core dependency).
    atlas = _atlas_points(embedded, cde_cohort)

    # {"cohort:var" -> UIMember} so each concept's records carry the source fields (name + text) they pooled.
    member_index = build_member_index(embedded)

    # {"cohort:var" -> FieldDetail} over every source field (uncapped) — full per-field detail for the UI and
    # the basis for unassignedFields (source fields that land in no concept). CDE cohort excluded (backbone).
    field_index = build_field_index(embedded, cde_cohort)

    # --- knobs: passthrough only (absent -> harmonize_leanb's own defaults). New knobs need no GUI change. ---
    kwargs: dict[str, Any] = {"cde_cohort": cde_cohort}
    for key in ("min_cluster_size", "top_k", "retrieval_floor", "model_tag"):
        if config.get(key) is not None:
            kwargs[key] = config[key]

    # min_cluster_size is no longer a user knob — auto-scale a coarse scaffold from the (non-CDE) corpus size
    # when the config didn't pin one. The split-aware stages re-derive concepts, so this only needs to be
    # reasonable; an explicit value (advanced/API callers, or the demo build) still wins.
    if "min_cluster_size" not in kwargs:
        n_fields = sum(len(dd.fields) for dd in dictionaries if getattr(dd, "cohort_name", None) != cde_cohort)
        kwargs["min_cluster_size"] = _auto_min_cluster_size(n_fields)

    # --- reproducibility: reload a frozen clustering substrate if one exists (skip UMAP, reproduce the exact
    #     partition). After a fresh run the built partition is saved (see _save_substrate_if_new). ---
    substrate_path = Path(substrate_path) if substrate_path else None
    if substrate_path is None and (stop_at_gate is not None or replay):
        # A staged run is resumed later, and the resume leg MUST see the same partition: the reviewer's
        # Gate 1 scoping is expressed as group ids, and UMAP+HDBSCAN is not bit-reproducible, so a
        # re-clustered second leg would apply their decisions to a different set of groups. Freezing it is
        # local and costs a file. Legacy one-shot runs are unchanged (no path -> no freeze).
        substrate_path = work_dir / "substrate.joblib"
    if substrate_path and substrate_path.exists():
        from ddharmon.harmonization.substrate import load_substrate

        kwargs["substrate"] = load_substrate(substrate_path)

    # --- preview: no LLM. generate=None makes harmonize_leanb stop after building the generate prompts. ---
    if mode == "preview" and not overrides:
        progress("clustering", 0, 0)
        result = harmonize_leanb(embedded, **kwargs)
        _save_substrate_if_new(substrate_path, result)
        progress("prepared", 0, 0)
        return build_ui_result(
            result,
            mode=mode,
            phases=PHASES_PREVIEW,
            atlas=atlas,
            member_index=member_index,
            field_index=field_index,
            cost=cast(UICost, ledger.to_dict()),
            preview_clusters=_preview_clusters(result),
        )

    # --- which ADVISORY stages this run wants, decided BEFORE any stage is constructed ---
    # "Off" has to mean nothing is built, not "built and then not passed". A constructed batch stage is
    # only a closure, but the guarantee T-08-54 needs is that a declined stage has no path to a provider
    # at all — and the cheapest way to guarantee that is for the callable not to exist (see also the
    # cost-transparency screen: a stage nobody asked for must not be able to appear in the breakdown).
    run_coherence = bool(config.get("coherence", True))  # the judge: ON by default — Gate 1 renders it
    want_concept_gate = bool(config.get("concept_gate", False))  # M7: OPT-IN, so a run pays only if it asks
    judge_specs = {
        name: w for name, w in _JUDGE_STAGES.items() if (want_concept_gate if name == "concept_gate" else run_coherence)
    }

    # --- pick the per-stage execution strategy (the only place mode branches into behavior) ---
    if overrides:
        stages: dict[str, StageFn] = overrides
    elif mode == "sync":
        # Client selection keys off the chosen model tag via the shared builder: Anthropic is pinned to the
        # PICKED Claude model (the SDK client's own default is a stale snapshot that 404s and ignored the
        # picker); any other provider routes through the unified LiteLLM client (Phase 7). Batch mode needs
        # no client here — its per-prompt model_tag (threaded into harmonize_leanb) drives the Batch API.
        from backend.engine.llm import build_llm_client

        client = build_llm_client(kwargs.get("model_tag"), api_key)
        stages = {
            "generate": _sync_stage("generating", progress, client, ledger, stopping),
            "split": _sync_stage("splitting", progress, client, ledger, stopping),
            "classify": _sync_stage("assigning", progress, client, ledger, stopping),
            "gencde": _sync_stage("gencde", progress, client, ledger, stopping),
            "specgen": _sync_stage("specs", progress, client, ledger, stopping),
            "refine": _sync_stage("refine", progress, client, ledger, stopping),
            # The judge and its R2 second read. One line each, same shape as every stage above (see
            # _JUDGE_STAGES for why they borrow an existing progress phase and carry their own cost key).
            **{
                name: _sync_stage(w["phase"], progress, client, ledger, stopping, ledger_key=w["cost"])
                for name, w in judge_specs.items()
            },
        }
    else:  # batch (default)
        stages = {
            "generate": _batch_stage(
                "generating", progress, work_dir, "generate", ledger, api_key=api_key, stopping=stopping
            ),
            "split": _batch_stage("splitting", progress, work_dir, "split", ledger, api_key=api_key, stopping=stopping),
            "classify": _batch_stage(
                "assigning", progress, work_dir, "assign", ledger, api_key=api_key, stopping=stopping
            ),
            "gencde": _batch_stage("gencde", progress, work_dir, "gencde", ledger, api_key=api_key, stopping=stopping),
            "specgen": _batch_stage("specs", progress, work_dir, "specgen", ledger, api_key=api_key, stopping=stopping),
            "refine": _batch_stage("refine", progress, work_dir, "refine", ledger, api_key=api_key, stopping=stopping),
            **{
                name: _batch_stage(
                    w["phase"],
                    progress,
                    work_dir,
                    w["tag"],
                    ledger,
                    api_key=api_key,
                    stopping=stopping,
                    ledger_key=w["cost"],
                )
                for name, w in judge_specs.items()
            },
        }

    # --- wrap every stage so its answers are captured, and replayed when the checkpoint has them ---
    # Applied to whichever strategy was chosen above (overrides included, so the guarantee is testable).
    # An advisory stage is made failure-tolerant BEFORE it is made recordable, so what the checkpoint
    # captures is what core actually received (``{}`` on a failure), not an exception that never got there.
    stages = {name: (_resilient_stage(name, fn) if name in _JUDGE_STAGES else fn) for name, fn in stages.items()}
    stages = {
        name: (_replaying_stage(name, fn, replay, recorded) if name in replay else _recording_stage(name, fn, recorded))
        for name, fn in stages.items()
    }

    gen_specs = config.get("gen_transform_specs", True)
    # GenCDE synthesis for novel concepts — ON by default (a value-add verifying pass like transform specs);
    # gate off with gen_gencde=false. Runs after merge, before specgen; batch stage caches to
    # responses_gencde.jsonl (its own content-addressed tag, so it re-runs $0 with the other stages cached).
    gen_gencde = config.get("gen_gencde", True)
    # GenCDE transform specs (M12): generate C1 member->GenCDE recodes for novel records so the tail carries
    # transform specs like the adopt/refine path. Needs the gencde stage (a target) AND the specgen stage (the
    # recode LLM). Guarded on the core signature so a core pinned before M12 simply skips the flag rather than
    # erroring on an unexpected kwarg — the dev channel swaps core versions, so the adapter must not assume it.
    gen_gencde_specs = config.get("gen_gencde_specs", True) and gen_gencde and gen_specs
    if gen_gencde_specs and "gencde_specgen" in inspect.signature(harmonize_leanb).parameters:
        kwargs["gencde_specgen"] = True
    # Refinement authoring — ON by default for the same reason gencde is: without it the `refine` bucket names a
    # CDE but produces nothing to harmonize ONTO, so those concepts have no target and the Refined CDE panel has
    # nothing to show. Gate off with refine_cdes=false. Core defaults this OFF (it costs an LLM call per
    # refine-bucket group that no deterministic rule could settle), so enabling it is the UI's choice, not core's.
    # Signature-guarded like gencde_specgen: the dev channel swaps core versions, and a core pinned before the
    # refine port must skip the flag rather than error on an unexpected kwarg.
    refine_cdes = config.get("refine_cdes", True) and "refine_cdes" in inspect.signature(harmonize_leanb).parameters
    if refine_cdes:
        kwargs["refine_cdes"] = True
    # ── the coherence judge, IN THE PRODUCT (STGD-02's adapter half) ──
    # Until this landed, `harmonize_leanb` here was passed neither `coherence=` nor `distinct_kinds=`, so
    # the judge never executed and every shipped artifact carried an incoherent count of zero — while the
    # core half had shipped in 08-04. Gate 1 renders coherence, so this is the phase's load-bearing wire.
    #
    # R2 (`distinct_kinds`) is nested inside the judge on purpose: core only runs the discriminator when a
    # `coherence` runner is set, and the calibrated flag rule is R2 = split OR (qualify AND distinct_kinds).
    # ON by default (gate off with coherence=false), because a Gate 1 with no coherence column is the
    # screen this phase exists to replace.
    #
    # The opt-in M7 concept gate is the mirror image: OFF unless the run asks (STGD-16). Off means NO
    # runner is constructed, so nothing is charged for a stage the caller declined (T-08-54).
    core_params = inspect.signature(harmonize_leanb).parameters
    judge_kwargs: dict[str, Any] = {}
    if run_coherence and stages.get("coherence") is not None and "coherence" in core_params:
        judge_kwargs["coherence"] = stages["coherence"]
        if stages.get("distinct_kinds") is not None and "distinct_kinds" in core_params:
            judge_kwargs["distinct_kinds"] = stages["distinct_kinds"]
    concept_gate_on = want_concept_gate
    if concept_gate_on and stages.get("concept_gate") is not None and "concept_gate" in core_params:
        judge_kwargs["concept_gate"] = stages["concept_gate"]
    else:
        # An older pinned core, or a declined opt-in: either way the signal has no value this run, and
        # the not-computed register says which — never a silent False.
        concept_gate_on = False
    # --- the staged boundary, expressed in CORE's vocabulary (see _GATE_STOP_MECHANISM) ---
    classify_stage = stages.get("classify")
    if stop_at_gate == "gate1":
        # Withhold `classify`: the shipped early return, which after 08-04's reorder fires once
        # generate(ideal), split and the judge have run. This is where Gate 1 sits.
        classify_stage = None
    elif stop_at_gate == "gate2":
        if "stop_after" not in inspect.signature(harmonize_leanb).parameters:
            # NOT signature-guarded into a silent skip, unlike gencde_specgen / refine_cdes below. Those
            # are optional enhancements a run can do without; a BOUNDARY is not. Degrading here would run
            # the whole pipeline — and charge for it — past the point the reviewer asked to stop at.
            raise ValueError(
                "the pinned ddharmon core has no `stop_after` parameter, so the Gate 2 boundary cannot be "
                "honoured; upgrade core rather than running past the boundary"
            )
        kwargs["stop_after"] = "gencde"

    progress("clustering", 0, 0)  # clustering + retrieval happen inside harmonize_leanb before the first callback
    result = harmonize_leanb(
        embedded,
        generate=stages.get("generate"),
        split=stages.get("split"),
        classify=classify_stage,
        gencde=stages.get("gencde") if gen_gencde else None,
        specgen=stages.get("specgen") if gen_specs else None,
        **({"refine": stages.get("refine")} if refine_cdes else {}),
        **judge_kwargs,
        **kwargs,
    )
    _save_substrate_if_new(substrate_path, result)
    return build_ui_result(
        result,
        mode=mode,
        phases=PHASES_RUN,
        atlas=atlas,
        member_index=member_index,
        field_index=field_index,
        cost=cast(UICost, ledger.to_dict()),
        gate_position=stop_at_gate,
        concept_gate=concept_gate_on,
    )


# ── re-adjudication: caller-invoked, explicit group ids, NEVER automatic ─────────────────────
#
# The coherence flag is a SUGGESTION. Core's own docstring is the contract — "The pipeline never
# re-splits automatically ... this pass runs only when a caller invokes it" — and the product simply
# never called it, which is why `readjudicated_from` was a dead field.
#
# The dangerous default is one keystroke away and lives in core: `readjudicate(group_ids=None)` selects
# EVERY record carrying `incoherent` and re-splits all of them. That is a paid, unreviewed re-partition
# of the reviewer's data triggered by a flag rather than by a decision, which is exactly the prohibited
# auto-resolution of an over-merge (T-08-53). So this entry point never forwards `None`: an empty or
# absent id list is REFUSED before any stage runs.


def _core_readjudicate() -> Callable[..., Any]:
    """Fetch core's ``readjudicate``. A seam, so a test can stand in for it without an LLM anywhere."""
    from ddharmon.harmonization import readjudicate

    return readjudicate


def _collect_inputs(embedded: list[Any]) -> tuple[list[str], Any, list[Any]]:
    """``(docs, embeddings, field_refs)`` for the run's embedded dictionaries.

    ``readjudicate`` needs the frozen embedding matrix and the field-reference list that
    ``harmonize_leanb`` builds internally, and ``LeanBResult`` does not carry either. Re-deriving them is
    free (a stack of vectors already in memory) and deterministic — no model call, no re-embedding.
    """
    from ddharmon.clustering.topic_engine import collect_inputs

    docs, embeddings, field_refs, _cohorts = collect_inputs(embedded)
    return docs, embeddings, field_refs


def readjudicate_groups(
    leanb_result: Any,
    embedded: list[Any],
    *,
    group_ids: Sequence[str] | None,
    split: StageFn,
    classify: StageFn,
    cde_cohort: str = "NIH_CDE",
    member_index: dict[str, UIMember] | None = None,
    concept_gate: bool = False,
    **knobs: Any,
) -> list[UIRecord]:
    """Re-split and re-assign EXACTLY the groups a human named, and return the updated record set.

    ``group_ids`` is required and must be non-empty. Nothing here scans the ``incoherent`` flag to build
    that list — a re-split without a named human decision is the prohibited behaviour, and defaulting to
    "every flagged group" would spend money on a re-partition nobody asked for.

    The flow itself is core's: this calls ``readjudicate()``, which reuses ``prepare_readjudicate`` →
    ``prepare_group_assign`` → ``assemble_leanb``. The adapter supplies the two stage callables and maps
    the result. It does not re-implement a single step of the pipeline.

    Degrades on an older pinned core: if this core has no ``readjudicate``, the caller's records come back
    unchanged and nothing raises — and because no child then carries the provenance signal, the
    not-computed register keeps reporting it as a per-run absence rather than claiming a re-adjudication
    happened.
    """
    if not group_ids:
        raise ValueError(
            "readjudicate_groups requires an explicit non-empty group_ids list. Re-adjudication is a human "
            "decision: the coherence flag is a suggestion, and re-splitting every flagged group because it "
            "was flagged is an auto-resolution of an over-merge, which is prohibited."
        )
    idx = member_index or {}
    try:
        core_readjudicate = _core_readjudicate()
    except (ImportError, AttributeError) as exc:
        logger.warning("this core has no readjudicate (%s) — returning the records unchanged", exc)
        return [_record_to_ui(r, idx, concept_gate=concept_gate) for r in leanb_result.records]
    _docs, embeddings, field_refs = _collect_inputs(embedded)
    updated = core_readjudicate(
        leanb_result,
        embedded,
        embeddings,
        field_refs,
        split=split,
        classify=classify,
        group_ids=list(group_ids),
        cde_cohort=cde_cohort,
        **knobs,
    )
    return [_record_to_ui(r, idx, concept_gate=concept_gate) for r in updated.records]


# ── targeted GenCDE recode regeneration (refine → regen, Part 3) ─────────────────────────────
#
# When a reviewer refines a novel record's GenCDE and changes its value domain, the member->GenCDE recodes
# (produced by the M12 gencde_specgen pass) go stale. This regenerates JUST those recodes for the one edited
# record, off the SAME core seams the run uses (``prepare_gencde_specgen`` + ``assemble_gencde_specgen``) — no
# re-embedding, no substrate: the source value sets come from a cheap reload of the run's retained source
# dictionaries (``load_dictionary``, no embedding), which is all ``build_field_lookup`` needs.


def _reload_source_dicts(dict_specs: list[dict[str, Any]]) -> list[Any]:
    """Reload the run's source dictionaries (NO embedding) as ``{dictionary: DataDictionary}`` shims.

    ``prepare_gencde_specgen`` only reaches ``ed.dictionary`` (cohort_name / name / fields) via
    ``build_field_lookup`` to read each member's source value set — it never touches embeddings — so a plain
    ``load_dictionary`` reload wrapped in a namespace is sufficient and avoids loading the embedding model.
    """
    from types import SimpleNamespace

    from ddharmon.ingestion import load_dictionary

    out: list[Any] = []
    for s in dict_specs:
        dd = load_dictionary(s["path"], cohort_name=s["cohort_name"], **s.get("column_roles", {}))
        out.append(SimpleNamespace(dictionary=dd))
    return out


def _core_gencde_from_ui(g: Any) -> Any:
    """Build a core ``GenCDE`` from a (possibly reviewer-edited) ``UIGenCDE`` dict — the regen target."""
    from ddharmon.harmonization.models import GenCDE
    from ddharmon.models.data_dictionary import ResponseOption

    pv: list[Any] = []
    for o in g.get("permissibleValues") or []:
        kw: dict[str, Any] = {"code": str(o.get("code", "")), "label": str(o.get("label", ""))}
        if o.get("order") is not None:
            kw["order"] = o["order"]
        pv.append(ResponseOption(**kw))
    return GenCDE(
        gencde_id=g["gencdeId"],
        preferred_name=g.get("preferredName", ""),
        title=g.get("title", ""),
        definition=g.get("definition", ""),
        question_text=g.get("questionText", ""),
        data_type=g.get("dataType", ""),
        permissible_values=pv,
        units=g.get("units"),
        minimum_value=g.get("minimum"),
        maximum_value=g.get("maximum"),
        source_variables=list(g.get("sourceVariables") or []),
        source_cohorts=list(g.get("sourceCohorts") or []),
    )


def _rebuild_regen_record(rec_ui: UIRecord) -> Any:
    """Reconstruct the minimal ``LeanBRecord`` the regen seams need from a stored ``UIRecord`` dict.

    Only the fields ``prepare_gencde_specgen`` / ``assemble_gencde_specgen`` read are rebuilt: the record key
    (group/cluster id), members, cohorts, the edited GenCDE, and a WIDE_TO_LONG guard transform when the
    stored record has one (so ``prepare`` still short-circuits — a wide->long record is one structural spec,
    not per-column recodes). The stale categorical member->GenCDE recodes are deliberately NOT carried: the
    assemble pass appends the fresh ones, and the caller re-merges the non-stale UI transforms around them.
    """
    from ddharmon.harmonization.models import LeanBRecord, TransformKind, TransformSpec

    g = rec_ui.get("gencde")
    gencde = _core_gencde_from_ui(g) if g else None
    gencde_id = g.get("gencdeId", "") if g else ""
    guard = [
        TransformSpec(
            source_variable=t.get("sourceVariable", ""),
            target_cde_id=t.get("targetCdeId", ""),
            kind=TransformKind.WIDE_TO_LONG,
        )
        for t in rec_ui.get("transforms", [])
        if t.get("targetCdeId") == gencde_id and t.get("kind") == "wide_to_long"
    ]
    return LeanBRecord(
        cluster_id=rec_ui.get("clusterId") or rec_ui.get("id") or "",
        group_id=rec_ui.get("groupId") or "",
        verdict=rec_ui.get("verdict") or "novel",
        route=rec_ui.get("route") or "gencde_residual",
        concept=rec_ui.get("concept", ""),
        member_variable_names=list(rec_ui.get("members") or []),
        cohorts=list(rec_ui.get("cohorts") or []),
        n_members=rec_ui.get("nMembers", 0),
        gencde=gencde,
        transforms=guard,
    )


def regenerate_gencde_specs(
    rec_ui: UIRecord,
    dict_specs: list[dict[str, Any]],
    *,
    model_tag: str | None,
    stage_fn: StageFn,
) -> UIRecord:
    """Regenerate the member->GenCDE recodes for ONE edited novel record and return the updated ``UIRecord``.

    ``rec_ui`` carries the (already reviewer-edited) GenCDE — its ``permissibleValues`` / units / bounds are
    the fresh target. Runs the SAME core seams a full run uses, on a single-record list: build recode prompts
    from the members' source value sets vs the edited domain (``prepare_gencde_specgen``), run them via the
    injected ``stage_fn`` (the caller supplies a BYOK client), and attach the fresh specs
    (``assemble_gencde_specgen``). Arithmetic/derived recodes inherit the core's review policy — nothing is
    auto-approved here. The stale categorical member->GenCDE recodes are replaced; any non-GenCDE-target
    transforms on the record are preserved untouched.
    """
    from ddharmon.harmonization import assemble_gencde_specgen, prepare_gencde_specgen
    from ddharmon.harmonization.models import TransformKind

    embedded = _reload_source_dicts(dict_specs)
    member_index = build_member_index(embedded)
    rec = _rebuild_regen_record(rec_ui)

    kwargs = {"model_tag": model_tag} if model_tag else {}
    g = rec_ui.get("gencde") or {}
    if g.get("permissibleValues"):
        # CATEGORICAL GenCDE: LLM member-code -> GenCDE-code recodes (C1), same as a full run.
        prompts = prepare_gencde_specgen([rec], embedded, **kwargs)
        assemble_gencde_specgen(prompts, stage_fn(prompts), [rec])
    else:
        # NUMERIC GenCDE: deterministic unit specs (N1) + LLM arithmetic residual upgrade (N2), mirroring
        # harmonize_leanb's gencde stage. Guarded import so a core build predating N1/N2 returns a clean 409
        # (RuntimeError) instead of dropping the record's numeric recodes with nothing to replace them.
        try:
            from ddharmon.harmonization import (
                assemble_gencde_arith_specgen,
                generate_gencde_unit_specs,
                prepare_gencde_arith_specgen,
            )
        except ImportError as exc:
            raise RuntimeError(
                "this core build cannot regenerate numeric GenCDE recodes (needs the N1/N2 spec-gen seams)"
            ) from exc
        generate_gencde_unit_specs([rec], embedded)  # N1 (deterministic) — leaves needs_units residuals
        prompts = prepare_gencde_arith_specgen([rec], embedded, **kwargs)  # N2 residual -> arith prompts
        assemble_gencde_arith_specgen(prompts, stage_fn(prompts), [rec])

    # Fresh recodes = everything assemble appended (the record started with only the wide->long guard).
    fresh_ui = [_transform_to_ui(t) for t in rec.transforms if t.kind != TransformKind.WIDE_TO_LONG]
    # Preserve the record's non-stale UI transforms (any non-GenCDE-target spec, plus a wide->long guard),
    # dropping the stale member->GenCDE recodes we just regenerated.
    gencde_id = g.get("gencdeId", "")
    preserved = [
        t
        for t in rec_ui.get("transforms", [])
        if not (t.get("targetCdeId") == gencde_id and t.get("kind") != "wide_to_long")
    ]
    updated: UIRecord = {**rec_ui}
    updated["transforms"] = preserved + fresh_ui
    updated["memberDetails"] = [_member_ui(m, member_index) for m in updated.get("members", [])]
    return updated
