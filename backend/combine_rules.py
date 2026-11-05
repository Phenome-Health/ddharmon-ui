"""Several variables of ONE cohort landing on ONE target column (08-28 item 1d, F1; decision Q4).

The notebook used to key its ops by cohort only, so each same-cohort variable on a target overwrote the one
before it. A (cohort, target) pair with two or more variables is a COMBINE GROUP, and the reviewer chooses how
it becomes one column with a ``gate3_combine_rule`` decision keyed on that pair:

* ``coalesce`` — first non-blank value in member order, plus a ``TARGET__source`` column naming the variable
  each value came from, and a runtime count / warning of the rows where more than one carried a value. This is
  the DEFAULT: what an undecided group gets, stated as ``decidedBy: "default"``.
* ``separate`` — one ``TARGET__<var>`` column per variable, no ``TARGET`` column.
* a member id — that variable alone writes ``TARGET``; the rest are named as unused.

The groups are computed over the EFFECTIVE records (``export_decisions.effective_records``), with the same
edge rule the notebook applies: a rejected recode writes nothing, and a member with no target is a novel, not
a column. So the rule every export carries is the rule the notebook ran.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from backend.artifact_kinds import COMBINE_COALESCE, COMBINE_SEPARATE, GATE3_COMBINE_RULE
from backend.artifacts import registry

#: The resolved rule's third value, beside the two names: one member is the only writer.
COMBINE_SOURCE = "source"


def edges(records: list[dict[str, Any]]) -> Iterator[tuple[dict[str, Any], str, dict[str, Any] | None, str]]:
    """``(record, member, transform, target)`` for every member edge that writes a column, in record/member order.

    Mirrors ``build_notebook``'s own walk: a rejected recode and a member with no target write nothing.
    """
    for r in records:
        tmap = {t.get("sourceVariable"): t for t in r.get("transforms") or []}
        for member in r.get("members") or []:
            t = tmap.get(member)
            if (t or {}).get("rejected"):
                continue
            target = str((t or {}).get("targetCdeId") or (r.get("cde") or {}).get("id") or "")
            if target:
                yield r, str(member), t, target


def cohort_of(member: str) -> str:
    return str(member).partition(":")[0]


def combine_groups(records: list[dict[str, Any]]) -> dict[tuple[str, str], list[str]]:
    """``(cohort, target) -> members`` for every pair two or more variables write, in first-seen order."""
    by_pair: dict[tuple[str, str], list[str]] = {}
    for _, member, _, target in edges(records):
        members = by_pair.setdefault((cohort_of(member), target), [])
        if member not in members:
            members.append(member)
    return {pair: members for pair, members in by_pair.items() if len(members) >= 2}


def resolve_rule(decision: dict[str, Any] | None, members: list[str]) -> dict[str, Any]:
    """The rule a combine group runs under: the reviewer's, else the default (``coalesce``)."""
    chosen = str((decision or {}).get("chosen") or "")
    if chosen == COMBINE_SEPARATE:
        return {"rule": COMBINE_SEPARATE, "source": "", "decidedBy": "reviewer"}
    if chosen == COMBINE_COALESCE:
        return {"rule": COMBINE_COALESCE, "source": "", "decidedBy": "reviewer"}
    if chosen and chosen in members:
        return {"rule": COMBINE_SOURCE, "source": chosen, "decidedBy": "reviewer"}
    rule: dict[str, Any] = {"rule": COMBINE_COALESCE, "source": "", "decidedBy": "default"}
    if chosen:
        # The named source no longer writes this column (rejected, or re-targeted): it cannot be the writer.
        rule["note"] = f"the chosen source {chosen} no longer writes this column, so the default coalesce applies"
    return rule


def resolved_rules(records: list[dict[str, Any]], grouped: dict[str, Any]) -> list[dict[str, Any]]:
    """One entry per combine group: ``{cohort, targetId, members, rule, source, decidedBy[, note]}``."""
    decisions: dict[str, dict[str, Any]] = {}
    for payload in grouped.get(GATE3_COMBINE_RULE) or []:
        try:
            decisions[registry.get(GATE3_COMBINE_RULE).key_for(payload)] = payload
        except ValueError:
            continue
    out: list[dict[str, Any]] = []
    for (cohort, target), members in combine_groups(records).items():
        decision = decisions.get(f"{cohort}|{target}")
        out.append({"cohort": cohort, "targetId": target, "members": members, **resolve_rule(decision, members)})
    return out


def attach_combine_rules(records: list[dict[str, Any]], grouped: dict[str, Any]) -> list[dict[str, Any]]:
    """Stamp ``combineRules`` on every record with a member in a combine group (``[]`` on the rest)."""
    rules = resolved_rules(records, grouped)
    for r in records:
        mine = set(r.get("members") or [])
        r["combineRules"] = [rule for rule in rules if mine & set(rule["members"])]
    return rules


def rules_by_pair(records: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    """The rules the records carry, keyed on (cohort, target) — what the notebook reads."""
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for r in records:
        for rule in r.get("combineRules") or []:
            out.setdefault((str(rule.get("cohort") or ""), str(rule.get("targetId") or "")), rule)
    return out
