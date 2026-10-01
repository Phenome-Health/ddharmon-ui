"""Fold the reviewer's gate decisions into the export set (08-27 Task 3).

The staged gates PERSIST every decision (``backend/artifact_kinds.py``) but, before this module, nothing
that leaves the tool read them: ``/export`` serialized the raw pipeline records. This is the one place the
decisions are applied to a result for export, so every format — the EITL TSV, the records JSON, the notebook
and the decision log — sees the same effective records and cannot disagree about what the reviewer decided.

Pure functions over two inputs: the run's result payload and the caller's grouped artifacts. No store, no
request, no I/O — so each rule below is asserted directly by ``tests/test_export_staged.py``.

WHAT EACH DECISION DOES TO THE EXPORT (and what it deliberately does not):

* ``gate1_group_scope`` / ``config.gate1_scope`` — out-of-scope groups are ABSENT from every format. The
  frozen list Gate 1's Continue wrote wins when present; without one (a run that passed Gate 1 before 08-27)
  the legacy default-in rule applies, the same rule the paid assign used, so the file matches what was billed.
* ``gate1_rename`` — ``concept`` is the reviewer's name; the generated one rides alongside as
  ``generatedConcept``. A rename is an annotation, never an erasure (08-16c Task 3).
* ``gate1_regroup`` — APPLIED BY THE PIPELINE (08-28 Wave 2). Gate 1's Continue freezes every move into the
  run's regrouping (``config.gate1_overrides``) and core re-groups before the paid assign, so the records — and
  every format built from them — already carry each moved variable in its destination group, with specs built
  for it there. Nothing is re-applied here. The decision log records every move with its origin and says
  whether the pipeline applied it (``applied``), or the run passed Gate 1 before moves were applied
  (``not applied`` — a legacy run, whose records keep the original membership).
* ``gate1_new_group`` — a reviewer-created group (``rev:<uuid>``). The pipeline forms it and assigns, specs and
  exports it as its own record under that id, named as the reviewer named it; the log lists its creation.
* ``gate2_candidate_pick`` — the CDE is the reviewer's pick (``""`` or the group's own generated element
  means "no catalog target"); the model's pick rides alongside as ``modelCde`` + ``modelVerdict``. Any GenCDE
  edit is carried verbatim as ``gencdeEdit``. A spec generated for the model's CDE that the reviewer did not
  then edit is flagged ``targetRepicked`` — its codes were written for a different target (audit Theme B #3).
  When the Gate 2 -> 3 leg already APPLIED the pick (``reviewerPick`` on the record — the adapter re-targeted
  it and regenerated its specs), the record already names the reviewer's target and its specs were built for
  it, so nothing is flagged; the MODEL's pick is read from that stamp (``modelCde`` / ``modelVerdict`` /
  ``modelGencde``), never from the re-targeted record, which says the pick (08-28 1e, F17).
* ``gate2_relation`` — the SKOS predicate the reviewer asserts between the group and ONE target (keyed on that
  edge), plus a free-text ``note``. Every record carries the relation on its EFFECTIVE target (the pick, else
  the model's) as ``relation``, who asserted it as ``relationBy`` (``reviewer`` / ``model`` / ``""`` for nobody),
  the note as ``relationNote``, and the MODEL's relation to its own target as ``modelRelation`` — so an override
  is visible and the model's claim is never erased. The model implies a relation only for its own catalog
  target: an adopt is ``skos:exactMatch`` (the element taken as-is), a refine carries the predicate core stamped
  on its derived element. A target the reviewer picked instead was never judged by the model, and the group's
  own generated element has no relation to assert. A relation set on a target the group no longer takes stays
  in the log, marked not applied, and reaches no record. ``chosen: ""`` is a note with no relation asserted.
* ``gate3_spec_edit`` — ``rejected: true`` marks the recode rejected: excluded from the notebook, marked in
  the TSV and the records JSON, logged. An edited ``mapping`` / ``numberMap`` / ``bins`` rides on the
  transform as ``reviewerEdit`` and is what the notebook applies, in the target's CODES (an edit saved in labels
  before 08-28 is resolved through the target's value table — ``backend/target_codes.py``). Every field is
  optional.
* ``gate3_combine_rule`` — how several variables of one cohort on one target column become that column
  (``backend/combine_rules.py``). Every record with a member in such a group carries the resolved rule as
  ``combineRules`` (the default ``coalesce`` when undecided, said so); the notebook applies it.
* ``gate3_member_exclusion`` — the reviewer removed one source variable from one concept (keyed on the
  (group, variable) pair). The variable is ABSENT from that record in every format: its ``members``,
  ``memberDetails`` and transform specs, its generated element's ``sourceVariables`` (and the cohorts those
  imply), and so from every combine group and every notebook op. ``nMembers`` / ``cohorts`` / ``crossCohort``
  follow the variables that remain, and the record names what was removed as ``removedMembers`` (``[]`` when
  nothing was), so no absence is a silent one. The log lists each removal; one on a group or variable the
  results do not have says it applied nowhere.
* ``gate4_export_selection`` — per-record inclusion. A record whose decision's ``chosen`` is ``exclude``
  (or ``out``) is absent from every format; any other value, and absence, include it. NO SCREEN WRITES THIS
  KIND TODAY (Gate 4's tile selection is component state), so the filter is a no-op until one does.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from backend.artifact_kinds import (
    COMPOSITE_SWAP,
    GATE1_GROUP_SCOPE,
    GATE1_NEW_GROUP,
    GATE1_REGROUP,
    GATE1_RENAME,
    GATE2_CANDIDATE_PICK,
    GATE2_RELATION,
    GATE3_COMBINE_RULE,
    GATE3_MEMBER_EXCLUSION,
    GATE3_SPEC_EDIT,
    GATE4_EXPORT_SELECTION,
    GATE_DECISION_KINDS,
    SKOS_RELATIONS,
    VERDICT,
    derive_staleness,
)
from backend.artifacts import registry
from backend.combine_rules import attach_combine_rules
from backend.target_codes import in_target_codes

#: Where Gate 1's Continue freezes the scope it displayed (``backend/app.py::GATE1_SCOPE_CONFIG_KEY``).
GATE1_SCOPE_CONFIG_KEY = "gate1_scope"
#: Where it freezes the regrouping the pipeline then applies (``backend/app.py::GATE1_OVERRIDES_CONFIG_KEY``).
GATE1_OVERRIDES_CONFIG_KEY = "gate1_overrides"

#: The ``gate4_export_selection`` values that EXCLUDE a record. Anything else includes it.
EXCLUDE_VALUES = frozenset({"exclude", "out"})

#: The transform-edit fields a Gate 3 decision may carry (all optional).
SPEC_EDIT_FIELDS = ("mapping", "numberMap", "bins")

GATE_OF = {
    GATE1_GROUP_SCOPE: "Gate 1",
    GATE1_NEW_GROUP: "Gate 1",
    GATE1_REGROUP: "Gate 1",
    GATE1_RENAME: "Gate 1",
    GATE2_CANDIDATE_PICK: "Gate 2",
    GATE2_RELATION: "Gate 2",
    GATE3_SPEC_EDIT: "Gate 3",
    GATE3_COMBINE_RULE: "Gate 3",
    GATE3_MEMBER_EXCLUSION: "Gate 3",
    GATE4_EXPORT_SELECTION: "Gate 4",
    COMPOSITE_SWAP: "Composite",
}
ACTION_OF = {
    GATE1_GROUP_SCOPE: "Set group scope",
    GATE1_NEW_GROUP: "Created a group",
    GATE1_REGROUP: "Moved a variable",
    GATE1_RENAME: "Renamed a group",
    GATE2_CANDIDATE_PICK: "Picked a target",
    GATE2_RELATION: "Set a relation",
    GATE3_SPEC_EDIT: "Edited a transform spec",
    GATE3_COMBINE_RULE: "Chose how variables combine",
    GATE3_MEMBER_EXCLUSION: "Removed a variable from a concept",
    GATE4_EXPORT_SELECTION: "Chose export inclusion",
    # The only composite write is the DECLARATION (08-27 audit), logged as ONE row per score (08-28 1e, H9).
    COMPOSITE_SWAP: "Declared a score",
}

#: The decision log's columns, in order. ``before``/``after`` are what the decision changed, where the
#: before is knowable from the run (a scope choice has no recorded prior — Gate 1 displays default-out).
DECISION_LOG_COLS = ["gate", "kind", "action", "item", "before", "after", "note", "detail", "stale"]

#: The label a cleared choice (``chosen == ""``) reads as.
NONE_OF_THESE = "none of these"

#: A Gate 3 row that carries neither an edit nor a note: the model's spec is what stands (08-28 1e, F7).
REVERTED_TO_MODEL = "reverted to model spec"

#: What a Gate 2 relation row with no relation asserted (``chosen == ""`` — a note only) reads as.
NO_RELATION = "no relation asserted"

#: A relation's ``targetId`` for the group's OWN element when it has no GenCDE id (a reviewer authored one on a
#: concept core generated nothing for, so the pick's ``chosen`` is ""). Mirrored in ``frontend/src/lib/gate23.ts``.
OWN_TARGET = "own"

#: Why a decision reached no record — the group is not in the results, or the edge is not the group's target.
NOT_APPLIED_ABSENT = "no record for this group in the run's results"
NOT_APPLIED_TARGET = "not this group's current target"
#: Why a Gate 3 removal reached no record: the variable is not one of the group's (mirrored in ``lib/gate4.ts``).
NOT_APPLIED_MEMBER = "not a variable of this group in the run's results"

#: What a removal's ``after`` reads as in the decision log.
REMOVED = "removed"

#: What a per-code diff calls a code that yields no value (absent from the map, or the missing sentinel).
MISSING = "missing"
_MISSING_VALUES = frozenset({"", "__missing__", MISSING})


def _by_key(grouped: dict[str, Any], kind: str) -> dict[str, dict[str, Any]]:
    """kind's decisions as itemKey -> payload. A row under a different shape is skipped, never raised on."""
    out: dict[str, dict[str, Any]] = {}
    for payload in grouped.get(kind) or []:
        try:
            out[registry.get(kind).key_for(payload)] = payload
        except ValueError:
            continue
    return out


def is_staged(gate_position: str | None, grouped: dict[str, Any]) -> bool:
    """Whether a run exports under the staged schema. A legacy one-shot run exports exactly as before."""
    return bool(gate_position) or any(grouped.get(k) for k in GATE_DECISION_KINDS)


def in_scope(config: dict[str, Any], grouped: dict[str, Any]) -> Any:
    """``groupId -> bool``: the Gate-1 scope the export honours (frozen list first, else legacy default-in)."""
    frozen = (config or {}).get(GATE1_SCOPE_CONFIG_KEY)
    if isinstance(frozen, list):
        keep = {str(g) for g in frozen}
        return lambda gid: gid in keep
    out = {gid for gid, d in _by_key(grouped, GATE1_GROUP_SCOPE).items() if d.get("chosen") == "out"}
    return lambda gid: gid not in out


def _stamp(record: dict[str, Any]) -> dict[str, Any] | None:
    """The record's ``reviewerPick`` — present only when the Gate 2 -> 3 leg APPLIED a pick to it."""
    stamp = record.get("reviewerPick")
    return stamp if isinstance(stamp, dict) else None


def _catalog_target(record: dict[str, Any]) -> str:
    """The catalog id the record ITSELF names (its chosen candidate, else its ``cde``) — "" for none."""
    chosen = next((c for c in record.get("candidates") or [] if c.get("isChosen")), None)
    if chosen and chosen.get("cdeId"):
        return str(chosen["cdeId"])
    return str((record.get("cde") or {}).get("id") or "")


def _gencde_id(g: Any) -> str:
    return str(g.get("gencdeId") or "") if isinstance(g, dict) else ""


def _current_target(record: dict[str, Any]) -> str:
    """What the record targets NOW: its catalog CDE, else its own generated element, else ""."""
    return _catalog_target(record) or _gencde_id(record.get("gencde"))


def model_target(record: dict[str, Any]) -> str:
    """The id the MODEL chose — a catalog CDE, else its generated element, else "".

    A record the Gate 2 -> 3 leg re-targeted names the REVIEWER's pick on its candidates / ``cde`` / ``gencde``;
    the model's survives only on the ``reviewerPick`` stamp (F17).
    """
    stamp = _stamp(record)
    if stamp is not None:
        return str(stamp.get("modelTarget") or "")
    return _current_target(record)


def model_cde(record: dict[str, Any]) -> dict[str, str] | None:
    """The model's catalog CdeRef (``None`` when it picked no catalog CDE) — a copy, safe to put on the export.

    A stamp written before 08-28 carries only ``modelTarget``: the CdeRef is recovered from the candidate list,
    and a model target that is not a candidate (its generated element) reads as no catalog CDE.
    """
    stamp = _stamp(record)
    if stamp is None:
        return copy.deepcopy(record.get("cde"))
    if "modelCde" in stamp:
        return copy.deepcopy(stamp["modelCde"])
    target = str(stamp.get("modelTarget") or "")
    cand = next((c for c in record.get("candidates") or [] if target and c.get("cdeId") == target), None)
    return {"id": target, "externalId": str(cand.get("cdeExternalId") or "")} if cand else None


def model_verdict(record: dict[str, Any]) -> str:
    """The model's verdict ("" when a pre-08-28 stamp did not record it)."""
    stamp = _stamp(record)
    if stamp is None:
        return str(record.get("verdict") or "")
    return str(stamp.get("modelVerdict") or "")


def own_ids(record: dict[str, Any]) -> set[str]:
    """Every id that names the group's OWN generated element: "", :data:`OWN_TARGET`, its GenCDE id now, the
    model's (from the stamp), and the stamped target when the applied pick was the group's own element."""
    stamp = _stamp(record) or {}
    ids = {"", OWN_TARGET, _gencde_id(record.get("gencde")), _gencde_id(stamp.get("modelGencde"))}
    if stamp.get("kind") == "gencde":
        ids.add(str(stamp.get("target") or ""))
    return ids


def same_target(record: dict[str, Any], a: str, b: str) -> bool:
    """Whether two target ids name one target — the group's own element counts as one, however it is named."""
    own = own_ids(record)
    return a == b or (a in own and b in own)


def effective_target(record: dict[str, Any], pick: dict[str, Any] | None) -> str:
    """The id the group targets as the reviewer left it: the pick (resolved by its tinyId), else the record's own."""
    if pick is None or not isinstance(pick.get("chosen"), str):
        return _current_target(record)
    ref = _catalog_ref(record, pick["chosen"], str(pick.get("externalId") or "").strip())
    return ref["id"] if ref else pick["chosen"]


def model_relation(record: dict[str, Any], target_id: str) -> str:
    """The SKOS relation the PIPELINE implies between the group and ``target_id`` — "" when it implies none.

    Only the model's own CATALOG target carries one: an adopt is ``skos:exactMatch`` (the element taken as-is), a
    refine the predicate core stamped on its derived element (``GenCDE.relation``, vs the parent it refines). Read
    from the stamp once the Gate 2 -> 3 leg re-targeted the record (F17). Mirrored by ``modelRelation`` in
    ``frontend/src/lib/gate4.ts``.
    """
    model = model_target(record)
    if not model or model in own_ids(record) or target_id != model:
        return ""
    if model_verdict(record) == "adopt":
        return SKOS_RELATIONS[0]
    stamp = _stamp(record)
    gencde = stamp.get("modelGencde") if stamp is not None else record.get("gencde")
    stamped = str((gencde or {}).get("relation") or "") if isinstance(gencde, dict) else ""
    return stamped if stamped in SKOS_RELATIONS else ""


def relation_on(record: dict[str, Any], relations: list[dict[str, Any]], target_id: str) -> dict[str, Any] | None:
    """The reviewer's relation decision on the (group, ``target_id``) edge, if one was written."""
    return next((d for d in relations if same_target(record, str(d.get("targetId") or ""), target_id)), None)


def _catalog_ref(record: dict[str, Any], cde_id: str, external_id: str = "") -> dict[str, str] | None:
    """The CdeRef for a picked id: a catalog candidate, or None for "no catalog target".

    ``external_id`` is the pick's catalog id (tinyId, 08-28 F13). Catalog NAMES repeat (two endorsed "Age"s), so
    when the pick carries its tinyId that — not the name — says which element the reviewer chose.
    """
    gencde = record.get("gencde") or {}
    if not cde_id or cde_id == gencde.get("gencdeId"):
        return None
    model = record.get("cde") or {}
    cands = record.get("candidates") or []
    if external_id:
        if model.get("id") and model.get("externalId") == external_id:
            return {"id": str(model["id"]), "externalId": external_id}
        hit = next((c for c in cands if c.get("cdeExternalId") == external_id), None)
        return {"id": str((hit or {}).get("cdeId") or cde_id), "externalId": external_id}
    if model.get("id") == cde_id:
        return {"id": cde_id, "externalId": str(model.get("externalId") or "")}
    cand = next((c for c in cands if c.get("cdeId") == cde_id), None)
    return {"id": cde_id, "externalId": str((cand or {}).get("cdeExternalId") or "")}


def spec_edit(decision: dict[str, Any] | None) -> dict[str, Any]:
    """The reviewer's edit fields on one Gate 3 decision (note + any of mapping/numberMap/bins)."""
    if not decision:
        return {}
    out: dict[str, Any] = {k: decision[k] for k in SPEC_EDIT_FIELDS if decision.get(k)}
    if isinstance(decision.get("note"), str) and decision["note"].strip():
        out["note"] = decision["note"]
    return out


def removed_members(grouped: dict[str, Any]) -> dict[str, list[str]]:
    """``groupId -> [memberId, ...]`` the reviewer removed at Gate 3, in the order the rows were written."""
    out: dict[str, list[str]] = {}
    for d in _by_key(grouped, GATE3_MEMBER_EXCLUSION).values():
        members = out.setdefault(str(d.get("groupId") or ""), [])
        member = str(d.get("memberId") or "")
        if member not in members:
            members.append(member)
    return out


def _cohort(member: Any) -> str:
    return str(member).partition(":")[0]


def _drop_members(r: dict[str, Any], removed: list[str]) -> None:
    """Take the removed variables out of one (already copied) record, everywhere it names them.

    ``removedMembers`` lists only the variables the record actually had — a removal of something it never held
    changed nothing here (the log says so). The counts and cohorts are re-derived from what remains, because a
    record still claiming three variables over two cohorts after one left is a file contradicting itself.
    """
    gone = [m for m in removed if m in (r.get("members") or [])]
    r["removedMembers"] = gone
    if not gone:
        return
    out = set(gone)
    r["members"] = [m for m in r.get("members") or [] if m not in out]
    r["memberDetails"] = [d for d in r.get("memberDetails") or [] if str((d or {}).get("id") or "") not in out]
    r["transforms"] = [t for t in r.get("transforms") or [] if str(t.get("sourceVariable") or "") not in out]
    r["nMembers"] = len(r["members"])
    left = {_cohort(m) for m in r["members"]}
    r["cohorts"] = [c for c in r.get("cohorts") or [] if c in left]
    r["crossCohort"] = len(r["cohorts"]) > 1
    gencde = r.get("gencde")
    if isinstance(gencde, dict) and isinstance(gencde.get("sourceVariables"), list):
        gencde["sourceVariables"] = [v for v in gencde["sourceVariables"] if v not in out]
        if isinstance(gencde.get("sourceCohorts"), list):
            sources = {_cohort(v) for v in gencde["sourceVariables"]}
            gencde["sourceCohorts"] = [c for c in gencde["sourceCohorts"] if c in sources]


def effective_records(result: dict[str, Any], config: dict[str, Any], grouped: dict[str, Any]) -> list[dict[str, Any]]:
    """The records as the REVIEWER left them: scoped, selected, renamed, re-targeted and recode-edited.

    Returns deep copies — the checkpoint payload is never mutated. On a run with no gate decisions every
    record comes back with its pipeline values and the additive keys set to their "untouched" values.
    """
    keep = in_scope(config, grouped)
    selection = _by_key(grouped, GATE4_EXPORT_SELECTION)
    renames = _by_key(grouped, GATE1_RENAME)
    picks = _by_key(grouped, GATE2_CANDIDATE_PICK)
    specs = _by_key(grouped, GATE3_SPEC_EDIT)
    removals = removed_members(grouped)
    relations: dict[str, list[dict[str, Any]]] = {}
    for d in _by_key(grouped, GATE2_RELATION).values():
        relations.setdefault(str(d.get("groupId") or ""), []).append(d)

    out: list[dict[str, Any]] = []
    for raw in result.get("records") or []:
        gid = str(raw.get("groupId") or raw.get("id") or "")
        if not keep(gid):
            continue
        if str((selection.get(str(raw.get("id") or "")) or {}).get("chosen") or "") in EXCLUDE_VALUES:
            continue
        r = copy.deepcopy(raw)
        # FIRST, so nothing below — a re-pick's re-targeting, a recode edit, the combine groups — sees a removed
        # variable as one of the concept's (review round 2).
        _drop_members(r, removals.get(gid, []))

        rename = renames.get(gid)
        r["generatedConcept"] = raw.get("concept", "")
        if rename and str(rename.get("chosen") or "").strip():
            r["concept"] = str(rename["chosen"]).strip()

        # The model's pick, from the stamp when the leg already applied a re-pick (the record then says the pick).
        stamp = _stamp(raw)
        r["modelCde"] = model_cde(raw)
        r["modelVerdict"] = model_verdict(raw)
        r["targetPickedBy"] = "reviewer" if stamp is not None else "model"
        if stamp is not None:
            r["modelGencde"] = copy.deepcopy(stamp.get("modelGencde"))
        # A pick the leg did NOT apply (a Gate 2-parked export, or one made after it) is applied here, against
        # what the record targets now.
        current = _current_target(raw)
        pick = picks.get(gid)
        repicked = False
        if pick is not None and isinstance(pick.get("chosen"), str):
            chosen = pick["chosen"]
            ref = _catalog_ref(raw, chosen, str(pick.get("externalId") or "").strip())
            chosen = ref["id"] if ref else chosen  # resolved by the pick's tinyId when it has one (08-28 F13)
            own = {"", _gencde_id(raw.get("gencde"))}
            same = chosen == current or (chosen in own and current in own)
            if not same:
                r["cde"] = ref
                r["targetPickedBy"] = "reviewer"
                repicked = True
            if isinstance(pick.get("gencdeEdit"), dict):
                r["gencdeEdit"] = pick["gencdeEdit"]
        new_target = (r.get("cde") or {}).get("id") or ""

        # The relation on the target the group now takes: the reviewer's when asserted, else the model's (3f).
        target = effective_target(raw, pick)
        rel = relation_on(raw, relations.get(gid, []), target)
        asserted = str((rel or {}).get("chosen") or "")
        implied = model_relation(raw, target)
        r["relation"] = asserted or implied
        r["relationBy"] = "reviewer" if asserted else ("model" if implied else "")
        r["modelRelation"] = model_relation(raw, model_target(raw))
        r["relationNote"] = str((rel or {}).get("note") or "")

        for t in r.get("transforms") or []:
            decision = specs.get(str(t.get("sourceVariable") or ""))
            edit = spec_edit(decision)
            if decision and decision.get("rejected"):
                t["rejected"] = True
            if edit:
                t["reviewerEdit"] = edit
            if repicked:
                t["modelTargetCdeId"] = t.get("targetCdeId", "")
                t["targetCdeId"] = new_target
                # Codes written for the model's target are only trustworthy on the new one if a reviewer
                # re-mapped them after the re-pick.
                if not any(k in edit for k in SPEC_EDIT_FIELDS):
                    t["targetRepicked"] = True
            if edit:
                # One code space per column (08-28 1c, F18): an edit saved in labels is applied in codes.
                t["reviewerEdit"] = in_target_codes(edit, r, t)
        out.append(r)
    # Same-cohort variables on one target column: the rule each export carries and the notebook runs (1d).
    attach_combine_rules(out, grouped)
    return out


def active_transforms(record: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for t in record.get("transforms") or [] if not t.get("rejected")]


def rejected_sources(record: dict[str, Any]) -> list[str]:
    return [str(t.get("sourceVariable") or "") for t in record.get("transforms") or [] if t.get("rejected")]


def transform_edits(record: dict[str, Any]) -> dict[str, Any]:
    return {
        str(t.get("sourceVariable")): t["reviewerEdit"] for t in record.get("transforms") or [] if t.get("reviewerEdit")
    }


def _j(value: Any) -> str:
    """Compact, key-sorted, unescaped JSON — byte-identical to ``stableJson`` in ``frontend/src/lib/gate4.ts``,
    so the Gate 4 preview of the log matches the download."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _spec_summary(t: dict[str, Any] | None) -> str:
    """A one-line account of the model's spec — the ``before`` of a Gate 3 edit."""
    if not t:
        return ""
    kind = str(t.get("kind") or "")
    if kind == "categorical" and t.get("codeMap"):
        return f"categorical {_j(t['codeMap'])}"
    if kind == "unit":
        return f"unit {t.get('sourceUnit') or '?'} -> {t.get('targetUnit') or '?'}"
    if kind == "arithmetic":
        return f"arithmetic {t.get('formula', '')}"
    return kind


def _chosen_label(value: Any) -> str:
    s = str(value if value is not None else "")
    return s if s else NONE_OF_THESE


def _pick_label(record: dict[str, Any], d: dict[str, Any]) -> str:
    """What a Gate 2 pick targets, in the log's words: a catalog id, the group's own generated element (marked
    ``(edited)`` when the pick carries an anchor edit), or "none of these".

    ``""`` — or the generated element's own id — means the group's OWN element (the adapter's reading), so a
    GenCDE edit reads ``GEN:x -> GEN:x (edited)`` rather than "none of these -> none of these" (F17).
    """
    chosen = str(d.get("chosen") or "")
    stamp = _stamp(record) or {}
    own_now = _gencde_id(record.get("gencde"))
    own_model = _gencde_id(stamp.get("modelGencde"))
    own_ids = {"", own_now, own_model}
    if stamp.get("kind") == "gencde":
        own_ids.add(str(stamp.get("target") or ""))
    if chosen not in own_ids:
        return chosen
    own = own_now or own_model
    edited = isinstance(d.get("gencdeEdit"), dict)
    if own:
        return f"{own} (edited)" if edited else own
    return "your own CDE (edited)" if edited else NONE_OF_THESE


_NUMERIC_CODE = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")


def _code_order(code: str) -> tuple[int, float, str]:
    """Numeric codes first, by value (``-818, -121, 0, 1, 10``), then the rest by text. Mirrored in gate4.ts."""
    return (0, float(code), code) if _NUMERIC_CODE.fullmatch(code) else (1, 0.0, code)


def _code_value(v: Any) -> str:
    if v is None:
        return MISSING
    s = v if isinstance(v, str) else _j(v)
    return MISSING if s in _MISSING_VALUES else s


def code_diff(model_map: dict[str, Any], reviewer_map: dict[str, Any]) -> str:
    """Per-code diff of a reviewer's value map against the model's, in TARGET codes (Q3): ``-121: 9 → missing``.

    Replace semantics: the reviewer's map is the WHOLE mapping, so a code it does not place yields no value
    ("missing"), exactly as the notebook's ``.map`` does. Only codes whose output changes are listed.
    """
    changes = []
    for code in sorted({str(k) for k in model_map} | {str(k) for k in reviewer_map}, key=_code_order):
        before, after = _code_value(model_map.get(code)), _code_value(reviewer_map.get(code))
        if before != after:
            changes.append(f"{code}: {before} → {after}")
    return "; ".join(changes) if changes else "no code changed"


def _edit_detail(spec: dict[str, Any] | None, edit: dict[str, Any]) -> str:
    """A Gate 3 edit's ``detail``: the value map as a per-code diff, any other edit shape as JSON."""
    parts: list[str] = []
    if "mapping" in edit:
        model_map = (spec or {}).get("codeMap")
        if isinstance(edit["mapping"], dict):
            parts.append(code_diff(model_map if isinstance(model_map, dict) else {}, edit["mapping"]))
        else:
            parts.append(_j({"mapping": edit["mapping"]}))
    for k in ("numberMap", "bins"):
        if k in edit:
            parts.append(_j({k: edit[k]}))
    return " | ".join(parts)


def _score_rows(grouped: dict[str, Any], stale: set[tuple[str, str]]) -> list[list[str]]:
    """ONE row per declared score (H9): the declaration writes a ``composite_swap`` per component, and 48 rows
    reading "-> none of these" looked like 48 rejections burying the real decisions."""
    scores: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for item, d in _by_key(grouped, COMPOSITE_SWAP).items():
        scores.setdefault(str(d.get("scoreName") or ""), []).append((item, d))
    rows: list[list[str]] = []
    for score, comps in scores.items():
        names = [str(d.get("componentName") or "") for _, d in comps]
        matched = {str(d.get("componentName") or ""): str(d.get("chosen")) for _, d in comps if d.get("chosen")}
        n = len(names)
        after = f"{n} component{'' if n == 1 else 's'}" + (f", {len(matched)} matched" if matched else "")
        body: dict[str, Any] = {"components": names}
        if matched:
            body["matched"] = matched
        is_stale = any((COMPOSITE_SWAP, item) in stale for item, _ in comps)
        rows.append(
            [GATE_OF[COMPOSITE_SWAP], COMPOSITE_SWAP, ACTION_OF[COMPOSITE_SWAP], score, "", after, "", _j(body),
             "true" if is_stale else "false"]
        )  # fmt: skip
    return rows


def decision_log_rows(result: dict[str, Any], config: dict[str, Any], grouped: dict[str, Any]) -> list[list[str]]:
    """One row per gate decision (plus the frozen scope and any workbench verdicts), in gate order.

    Mirrored by ``frontend/src/lib/gate4.ts::decisionLogCsvRows`` so the Gate 4 preview shows the rows the
    download carries.
    """
    records = result.get("records") or []
    by_group = {str(r.get("groupId") or r.get("id") or ""): r for r in records}
    spec_by_source = {str(t.get("sourceVariable") or ""): t for r in records for t in r.get("transforms") or []}
    groups = {str(g.get("groupId") or ""): g for g in result.get("conceptGroups") or []}
    stale = {(s["kind"], s["itemKey"]) for s in derive_staleness(grouped)}
    picks = _by_key(grouped, GATE2_CANDIDATE_PICK)
    regrouping = (config or {}).get(GATE1_OVERRIDES_CONFIG_KEY)
    applied_moves = set((regrouping or {}).get("moves") or {}) if isinstance(regrouping, dict) else set()
    passed_gate1 = isinstance((config or {}).get(GATE1_SCOPE_CONFIG_KEY), list) or isinstance(regrouping, dict)

    rows: list[list[str]] = []
    frozen = (config or {}).get(GATE1_SCOPE_CONFIG_KEY)
    if isinstance(frozen, list):
        rows.append(
            ["Gate 1", "gate1_scope_frozen", "Continued with this scope", "", "", f"{len(frozen)} groups in scope", "",
             _j(frozen), "false"]
        )  # fmt: skip

    for kind in GATE_DECISION_KINDS:
        if kind == COMPOSITE_SWAP:
            rows.extend(_score_rows(grouped, stale))
            continue
        for item, d in _by_key(grouped, kind).items():
            before, after, detail = "", _chosen_label(d.get("chosen")), ""
            note = str(d.get("note") or "")
            if kind == GATE1_RENAME:
                gid = str(d.get("groupId") or item)
                before = str(
                    d.get("generatedName")
                    or (by_group.get(gid) or {}).get("concept")
                    or (groups.get(gid) or {}).get("concept")
                    or ""
                )
            elif kind == GATE1_REGROUP:
                before = str(d.get("fromGroupId") or "")
                # Past Gate 1 the regrouping is frozen: a move in it was applied by the pipeline; one outside it was
                # not (the run passed Gate 1 before moves were applied). At Gate 1 nothing is claimed either way.
                if passed_gate1:
                    detail = "applied" if item in applied_moves else "not applied"
            elif kind == GATE2_CANDIDATE_PICK:
                extra: dict[str, Any] = {}
                if isinstance(d.get("gencdeEdit"), dict):
                    extra["gencdeEdit"] = d["gencdeEdit"]
                rec = by_group.get(item)
                if rec is None:
                    # F7: a pick on a group the results do not have took effect nowhere, and says so.
                    extra["notApplied"] = NOT_APPLIED_ABSENT
                else:
                    # F17: the MODEL's pick (from the stamp once the leg re-targeted the record) -> the reviewer's.
                    before = _chosen_label(model_target(rec))
                    after = _pick_label(rec, d)
                detail = _j(extra) if extra else ""
            elif kind == GATE2_RELATION:
                # 3f: the model's relation for this edge ("" where it implied none) -> the reviewer's; "" is a note.
                gid, target = str(d.get("groupId") or ""), str(d.get("targetId") or "")
                after = str(d.get("chosen") or "") or NO_RELATION
                rec = by_group.get(gid)
                if rec is None:
                    detail = _j({"notApplied": NOT_APPLIED_ABSENT})
                else:
                    before = model_relation(rec, target)
                    if not same_target(rec, target, effective_target(rec, picks.get(gid))):
                        detail = _j({"notApplied": NOT_APPLIED_TARGET})
            elif kind == GATE3_SPEC_EDIT:
                spec = spec_by_source.get(item)
                before = _spec_summary(spec)
                edit = {k: d[k] for k in SPEC_EDIT_FIELDS if d.get(k)}
                # F7: "annotated" only with a note; a row with neither an edit nor a note is the model's spec.
                if d.get("rejected"):
                    after = "rejected"
                elif edit:
                    after = "edited"
                else:
                    after = "annotated" if note.strip() else REVERTED_TO_MODEL
                if edit:
                    detail = _edit_detail(spec, edit)
            elif kind == GATE3_MEMBER_EXCLUSION:
                # The concept the variable was removed from -> "removed"; one that reached no record says so.
                gid, member = str(d.get("groupId") or ""), str(d.get("memberId") or "")
                before, after = gid, REMOVED
                rec = by_group.get(gid)
                if rec is None:
                    detail = _j({"notApplied": NOT_APPLIED_ABSENT})
                elif member not in (rec.get("members") or []):
                    detail = _j({"notApplied": NOT_APPLIED_MEMBER})
            rows.append(
                [GATE_OF.get(kind, ""), kind, ACTION_OF.get(kind, kind), item, before, after, note, detail,
                 "true" if (kind, item) in stale else "false"]
            )  # fmt: skip

    for v in grouped.get(VERDICT) or []:
        item = "|".join(
            s
            for s in (str(v.get("recordId") or ""), str(v.get("axis") or "match"), str(v.get("sourceVariable") or ""))
            if s
        )
        rows.append(["Workbench", "verdict", "Recorded a verdict", item, "", str(v.get("decision") or ""),
                     str(v.get("note") or ""), "", "false"])  # fmt: skip
    return rows
