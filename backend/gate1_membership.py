"""Gate 1's effective group membership — pure functions on a run's result and the reviewer's regrouping.

Shared by the API (the score-suggestions route, the division guard) and the runner (which warms Gate 1's free
search when a run parks there), so neither has to import the other. ``backend.app`` keeps its old private names.
"""

from __future__ import annotations

from typing import Any


def effective_members(result: dict[str, Any], overrides: dict[str, Any] | None, group_id: str) -> list[str]:
    """A Gate-1 group's members as the reviewer currently sees it: the split's, minus moves out, plus moves in.

    The same rule the Gate 1 screen draws (``effectiveMembers`` in ``frontend/src/lib/ledger.ts``) and core
    applies (``resolve_group_membership``) — used here to refuse, before any spend, a division of a group the
    reviewer has already emptied down to one variable, and (via :func:`gate1_membership`) as the closed world of
    Gate 1's free score suggestions. Core's own resolution is what the re-split uses.
    """
    uncapped = (result.get("conceptGroupMembers") or {}).get(group_id)
    if uncapped is None:  # a payload with no uncapped list for this group: the recorded sample, as the screen does
        group = next((g for g in result.get("conceptGroups") or [] if g.get("groupId") == group_id), {})
        uncapped = group.get("memberVariableNames") or []
    original = [str(m) for m in uncapped]
    moves = (overrides or {}).get("moves") or {}
    kept = [m for m in original if moves.get(m, group_id) == group_id]
    return kept + sorted(m for m, dest in moves.items() if dest == group_id and m not in original)


def gate1_membership(result: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, list[str]]:
    """EVERY Gate-1 group's members as the reviewer currently sees them — :func:`effective_members`, for all.

    The split's groups (``conceptGroups``, then any ``conceptGroupMembers`` key the rows do not list), then the
    reviewer's New groups in ``overrides`` order; ``overrides`` is the API's sanitised regrouping (``_gate1_overrides``),
    so a move to a destination that cannot be honoured never moves anything here either. Every Gate 1 move is
    APPLIED (08-28): a variable dragged into a New group is that group's, and a clustering leftover the reviewer
    placed into a group counts for it.
    """
    ids = [str(g["groupId"]) for g in result.get("conceptGroups") or [] if g.get("groupId")]
    ids += [str(g) for g in (result.get("conceptGroupMembers") or {}) if str(g) not in ids]
    ids += [str(g["groupId"]) for g in (overrides or {}).get("newGroups") or [] if g.get("groupId")]
    return {gid: effective_members(result, overrides, gid) for gid in dict.fromkeys(ids)}
