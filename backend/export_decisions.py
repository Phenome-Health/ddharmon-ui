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
* ``gate1_regroup`` — LOGGED ONLY. The paid pipeline never consumed a move (audit Theme A), so the specs and
  targets in the file were built for the ORIGINAL membership; moving the member in the export would attach it
  to a group whose recodes were never generated for it. The decision log records every move with its origin.
* ``gate2_candidate_pick`` — the CDE is the reviewer's pick (``""`` or the group's own generated element
  means "no catalog target"); the model's pick rides alongside as ``modelCde``. Any GenCDE edit is carried
  verbatim as ``gencdeEdit``. A spec generated for the model's CDE that the reviewer did not then edit is
  flagged ``targetRepicked`` — its codes were written for a different target (audit Theme B #3).
* ``gate3_spec_edit`` — ``rejected: true`` marks the recode rejected: excluded from the notebook, marked in
  the TSV and the records JSON, logged. An edited ``mapping`` / ``numberMap`` / ``bins`` rides on the
  transform as ``reviewerEdit`` and is what the notebook applies. Every field is optional.
* ``gate4_export_selection`` — per-record inclusion. A record whose decision's ``chosen`` is ``exclude``
  (or ``out``) is absent from every format; any other value, and absence, include it. NO SCREEN WRITES THIS
  KIND TODAY (Gate 4's tile selection is component state), so the filter is a no-op until one does.
"""

from __future__ import annotations

import copy
import json
from typing import Any

from backend.artifact_kinds import (
    GATE1_GROUP_SCOPE,
    GATE1_REGROUP,
    GATE1_RENAME,
    GATE2_CANDIDATE_PICK,
    GATE2_RELATION,
    GATE3_SPEC_EDIT,
    GATE4_EXPORT_SELECTION,
    GATE_DECISION_KINDS,
    VERDICT,
    derive_staleness,
)
from backend.artifacts import registry

#: Where Gate 1's Continue freezes the scope it displayed (``backend/app.py::GATE1_SCOPE_CONFIG_KEY``).
GATE1_SCOPE_CONFIG_KEY = "gate1_scope"

#: The ``gate4_export_selection`` values that EXCLUDE a record. Anything else includes it.
EXCLUDE_VALUES = frozenset({"exclude", "out"})

#: The transform-edit fields a Gate 3 decision may carry (all optional).
SPEC_EDIT_FIELDS = ("mapping", "numberMap", "bins")

GATE_OF = {
    GATE1_GROUP_SCOPE: "Gate 1",
    GATE1_REGROUP: "Gate 1",
    GATE1_RENAME: "Gate 1",
    GATE2_CANDIDATE_PICK: "Gate 2",
    GATE2_RELATION: "Gate 2",
    GATE3_SPEC_EDIT: "Gate 3",
    GATE4_EXPORT_SELECTION: "Gate 4",
    "composite_swap": "Composite",
}
ACTION_OF = {
    GATE1_GROUP_SCOPE: "Set group scope",
    GATE1_REGROUP: "Moved a variable",
    GATE1_RENAME: "Renamed a group",
    GATE2_CANDIDATE_PICK: "Picked a target",
    GATE2_RELATION: "Set a relation",
    GATE3_SPEC_EDIT: "Edited a transform spec",
    GATE4_EXPORT_SELECTION: "Chose export inclusion",
    "composite_swap": "Swapped a component",
}

#: The decision log's columns, in order. ``before``/``after`` are what the decision changed, where the
#: before is knowable from the run (a scope choice has no recorded prior — Gate 1 displays default-out).
DECISION_LOG_COLS = ["gate", "kind", "action", "item", "before", "after", "note", "detail", "stale"]

#: The label a cleared choice (``chosen == ""``) reads as.
NONE_OF_THESE = "none of these"


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


def model_pick(record: dict[str, Any]) -> str:
    """The id the MODEL chose for a record — what Gate 2 shows selected before any re-pick."""
    chosen = next((c for c in record.get("candidates") or [] if c.get("isChosen")), None)
    if chosen and chosen.get("cdeId"):
        return str(chosen["cdeId"])
    return str((record.get("cde") or {}).get("id") or "")


def _catalog_ref(record: dict[str, Any], cde_id: str) -> dict[str, str] | None:
    """The CdeRef for a picked id: a catalog candidate, or None for "no catalog target"."""
    gencde = record.get("gencde") or {}
    if not cde_id or cde_id == gencde.get("gencdeId"):
        return None
    model = record.get("cde") or {}
    if model.get("id") == cde_id:
        return {"id": cde_id, "externalId": str(model.get("externalId") or "")}
    cand = next((c for c in record.get("candidates") or [] if c.get("cdeId") == cde_id), None)
    return {"id": cde_id, "externalId": str((cand or {}).get("cdeExternalId") or "")}


def spec_edit(decision: dict[str, Any] | None) -> dict[str, Any]:
    """The reviewer's edit fields on one Gate 3 decision (note + any of mapping/numberMap/bins)."""
    if not decision:
        return {}
    out: dict[str, Any] = {k: decision[k] for k in SPEC_EDIT_FIELDS if decision.get(k)}
    if isinstance(decision.get("note"), str) and decision["note"].strip():
        out["note"] = decision["note"]
    return out


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

    out: list[dict[str, Any]] = []
    for raw in result.get("records") or []:
        gid = str(raw.get("groupId") or raw.get("id") or "")
        if not keep(gid):
            continue
        if str((selection.get(str(raw.get("id") or "")) or {}).get("chosen") or "") in EXCLUDE_VALUES:
            continue
        r = copy.deepcopy(raw)

        rename = renames.get(gid)
        r["generatedConcept"] = raw.get("concept", "")
        if rename and str(rename.get("chosen") or "").strip():
            r["concept"] = str(rename["chosen"]).strip()

        model_id = model_pick(raw)
        r["modelCde"] = copy.deepcopy(raw.get("cde"))
        r["targetPickedBy"] = "model"
        pick = picks.get(gid)
        repicked = False
        if pick is not None and isinstance(pick.get("chosen"), str):
            chosen = pick["chosen"]
            own = {"", str((raw.get("gencde") or {}).get("gencdeId") or "")}
            same = chosen == model_id or (chosen in own and model_id in own)
            if not same:
                r["cde"] = _catalog_ref(raw, chosen)
                r["targetPickedBy"] = "reviewer"
                repicked = True
            if isinstance(pick.get("gencdeEdit"), dict):
                r["gencdeEdit"] = pick["gencdeEdit"]
        new_target = (r.get("cde") or {}).get("id") or ""

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
        out.append(r)
    return out


def active_transforms(record: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for t in record.get("transforms") or [] if not t.get("rejected")]


def rejected_sources(record: dict[str, Any]) -> list[str]:
    return [str(t.get("sourceVariable") or "") for t in record.get("transforms") or [] if t.get("rejected")]


def transform_edits(record: dict[str, Any]) -> dict[str, Any]:
    return {
        str(t.get("sourceVariable")): t["reviewerEdit"] for t in record.get("transforms") or [] if t.get("reviewerEdit")
    }


def _spec_summary(t: dict[str, Any] | None) -> str:
    """A one-line account of the model's spec — the ``before`` of a Gate 3 edit."""
    if not t:
        return ""
    kind = str(t.get("kind") or "")
    if kind == "categorical" and t.get("codeMap"):
        return f"categorical {json.dumps(t['codeMap'], sort_keys=True)}"
    if kind == "unit":
        return f"unit x{t.get('factor', 1)} +{t.get('offset', 0)} ({t.get('sourceUnit', '?')} -> {t.get('targetUnit', '?')})"
    if kind == "arithmetic":
        return f"arithmetic {t.get('formula', '')}"
    return kind


def _chosen_label(value: Any) -> str:
    s = str(value if value is not None else "")
    return s if s else NONE_OF_THESE


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

    rows: list[list[str]] = []
    frozen = (config or {}).get(GATE1_SCOPE_CONFIG_KEY)
    if isinstance(frozen, list):
        rows.append(
            ["Gate 1", "gate1_scope_frozen", "Continued with this scope", "", "", f"{len(frozen)} groups in scope", "",
             json.dumps(frozen), "false"]
        )  # fmt: skip

    for kind in GATE_DECISION_KINDS:
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
            elif kind == GATE2_CANDIDATE_PICK:
                before = _chosen_label(model_pick(by_group.get(item) or {})) if item in by_group else ""
                if isinstance(d.get("gencdeEdit"), dict):
                    detail = json.dumps({"gencdeEdit": d["gencdeEdit"]}, sort_keys=True)
            elif kind == GATE3_SPEC_EDIT:
                before = _spec_summary(spec_by_source.get(item))
                edit = {k: d[k] for k in SPEC_EDIT_FIELDS if d.get(k)}
                after = "rejected" if d.get("rejected") else ("edited" if edit else "annotated")
                if edit:
                    detail = json.dumps(edit, sort_keys=True)
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
