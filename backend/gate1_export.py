"""Gate 1's free export: every group's variables as the reviewer left them, plus the variables in no group (08-31).

Bhargav's use case for a Preview run is a $0 redundancy check of one dictionary — find the variables that say the same
thing — and its answer has to leave the screen. This builds that file: one row per (group, variable) AFTER the live
Gate 1 decisions, then the variables in no group. Pure functions on a run's result and the reviewer's decisions; the
route (``GET /jobs/{id}/gate1.csv`` in ``backend.app``) reads them and streams the CSV.

THE DECISIONS ARE APPLIED HERE, NOT READ OFF A FROZEN COPY. A paid run freezes its Gate 1 regrouping at Continue, but a
Preview has no Continue — it ends at Gate 1 — so the export applies what the reviewer has done so far: moves and New
groups through the API's sanitised overrides (``_gate1_overrides`` → :func:`backend.gate1_membership.gate1_membership`,
the same membership Concept Spotlight searches), renames and scope from the stored decisions.

WHAT EACH COLUMN SAYS, and only that:

* ``group_label`` / ``label_source`` — the label Gate 1 shows, and where it came from: ``yours`` (a rename, or a New
  group's name), ``keywords`` (a Preview row's c-TF-IDF label), ``generated`` (a name ddharmon generated), ``judge``
  (the coherence judge's summary standing in for a missing name) or ``placeholder`` (no name at all — e.g. a split's
  leftover). The same precedence as the screen's ``groupLabel``.
* ``in_scope`` — ``yes`` / ``no`` on a paid run: the scope Gate 1 SENT once Continue froze it, else the reviewer's own
  ticks (a New group is in until unticked; an unticked group is out, Gate 1's default). BLANK where scope does not
  apply: every row of a Preview, which sends nothing on, and the variables in no group. Concept Spotlight's suggested
  ticks are made in the browser and are not decisions, so before Continue a group ticked only by a suggestion reads
  ``no`` here.
* ``description`` / ``question_text`` / ``value_encoding`` — the variable's own fields from ``fieldIndex``, verbatim. A
  source that carried its coded answers as a list rather than an inline string gets them joined in the same
  ``code=label|…`` form.
"""

from __future__ import annotations

import re
from typing import Any

from backend.artifact_kinds import GATE1_GROUP_SCOPE, GATE1_RENAME, REVIEWER_GROUP_PREFIX

GATE1_EXPORT_HEADER = [
    "group_id",
    "group_label",
    "label_source",
    "in_scope",
    "cohort",
    "variable",
    "description",
    "question_text",
    "value_encoding",
]

#: The label every variable in no group is listed under — the screen's own words for that place.
NO_GROUP_LABEL = "In no group"

#: Where the Gate 1 scope Continue sent is frozen on a run's config (``backend.app.GATE1_SCOPE_CONFIG_KEY``).
_FROZEN_SCOPE_KEY = "gate1_scope"

_SPLIT_INDEX = re.compile(r"#g(\d+)$")


def is_preview(result: dict[str, Any], config: dict[str, Any] | None) -> bool:
    """A Preview run — called no model, sends nothing on — under either the result's or the config's spelling."""
    mode = (config or {}).get("run_mode") or (config or {}).get("runMode")
    return result.get("mode") == "preview" or mode == "preview"


def _leftover_label(n_members: int) -> str:
    """A split leftover's placeholder — ``leftoverLabel`` in ``frontend/src/types.ts``, word for word."""
    return f"Not named by the split — {n_members} {'variable' if n_members == 1 else 'variables'} the model left over"


def group_label(group: dict[str, Any], renamed_to: str = "") -> tuple[str, str]:
    """``(label, source)`` for a pipeline group — the screen's ``groupLabel`` precedence, in the export's words."""
    renamed = renamed_to.strip()
    if renamed:
        return renamed, "yours"
    concept = str(group.get("concept") or "").strip()
    if concept and group.get("conceptSource") == "keywords":
        return concept, "keywords"
    if concept:
        return concept, "generated"
    index = _SPLIT_INDEX.search(str(group.get("groupId") or ""))
    if index and int(index.group(1)) >= 1:
        return _leftover_label(int(group.get("nMembers") or 0)), "placeholder"
    ideal = str(group.get("idealCde") or "").strip()
    if ideal:
        return ideal, "generated"
    summary = str(group.get("coherenceSummary") or "").strip()
    if group.get("coherence") != "not_judged" and summary:
        return summary, "judge"
    return "Unnamed group", "placeholder"


def _value_encoding(detail: dict[str, Any]) -> str:
    inline = str(detail.get("valueEncoding") or "").strip()
    if inline:
        return inline
    options = [o for o in detail.get("responseOptions") or [] if isinstance(o, dict)]
    return "|".join(f"{o.get('code', '')}={o.get('label', '')}" for o in options)


def _variable_cells(member: str, field_index: dict[str, Any]) -> list[str]:
    """``cohort, variable, description, question_text, value_encoding`` for one ``cohort:var`` id."""
    cohort, _, raw = member.partition(":")
    detail = field_index.get(member) or {}
    return [
        cohort if raw else "",
        str(detail.get("name") or raw or member),
        str(detail.get("description") or ""),
        str(detail.get("questionText") or ""),
        _value_encoding(detail),
    ]


def _decisions_by_group(grouped: dict[str, Any], kind: str) -> dict[str, dict[str, Any]]:
    return {str(d.get("groupId")): d for d in grouped.get(kind) or [] if isinstance(d, dict) and d.get("groupId")}


def gate1_export_rows(
    result: dict[str, Any],
    membership: dict[str, list[str]],
    new_groups: list[dict[str, Any]],
    grouped: dict[str, Any],
    config: dict[str, Any] | None,
) -> list[list[str]]:
    """The export's rows, header excluded: the reviewer's New groups first (as Gate 1 lists them), then the run's
    groups in the run's order, then every variable in no group under :data:`NO_GROUP_LABEL`.

    ``membership`` is Gate 1's effective grouping (``gate1_membership`` over the sanitised overrides) and
    ``new_groups`` the overrides' ``newGroups``. A group left with no variable has no row: there is nothing in it to
    export.
    """
    field_index: dict[str, Any] = result.get("fieldIndex") or {}
    preview = is_preview(result, config)
    renames = _decisions_by_group(grouped, GATE1_RENAME)
    ticks = _decisions_by_group(grouped, GATE1_GROUP_SCOPE)
    frozen = (config or {}).get(_FROZEN_SCOPE_KEY)
    sent = {str(g) for g in frozen} if isinstance(frozen, list) else None

    def in_scope(group_id: str) -> str:
        if preview:
            return ""
        if sent is not None:
            return "yes" if group_id in sent else "no"
        chosen = (ticks.get(group_id) or {}).get("chosen")
        if chosen in ("in", "out"):
            return "yes" if chosen == "in" else "no"
        return "yes" if group_id.startswith(REVIEWER_GROUP_PREFIX) else "no"

    labelled: list[tuple[str, str, str]] = []  # (groupId, label, source), in export order
    for g in new_groups:
        gid = str(g.get("groupId") or "")
        if gid:
            labelled.append((gid, str(g.get("name") or "").strip() or "Unnamed group", "yours"))
    for g in result.get("conceptGroups") or []:
        gid = str(g.get("groupId") or "")
        if gid:
            labelled.append((gid, *group_label(g, str((renames.get(gid) or {}).get("chosen") or ""))))

    rows: list[list[str]] = []
    placed: set[str] = set()
    for gid, label, source in labelled:
        for member in membership.get(gid) or []:
            if member in placed:  # never twice: the membership is a partition, and the file must stay one
                continue
            placed.add(member)
            rows.append([gid, label, source, in_scope(gid), *_variable_cells(member, field_index)])
    for member in field_index:
        if member not in placed:
            rows.append(["", NO_GROUP_LABEL, "", "", *_variable_cells(member, field_index)])
    return rows
