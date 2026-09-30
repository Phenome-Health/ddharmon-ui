"""The column-role requirement for an uploaded dictionary — core's, transcribed, not re-imagined.

ONE RULE, THREE READERS. ``/batch``, the pre-Start embedding exports, and (through the mirror in
``frontend/src/lib/dictionary.ts``) Setup's blocker, the mapping table's flag and the New Run form all ask the
same question: "can this mapping produce a single variable?" The rule used to live in five hand-written copies,
and every one of them said ``question_text`` alone was enough. It is not, and a cohort mapped that way loaded
zero variables and was dropped mid-run while the others billed.

WHAT CORE ACTUALLY REQUIRES (``ddharmon.ingestion.load_dictionary`` + ``GenericCSVParser.load``), measured by
``tests/test_role_requirement.py`` over every combination rather than read off the source:

1. ``load_dictionary`` raises unless one of ``variable_name`` / ``description`` / ``question_text`` is mapped.
2. The parser keeps a row only if it can give the row a DESCRIPTION: ``description`` -> ``short_label`` -> the
   row's name, where the name is ``variable_name`` -> ``field_id`` -> a synthetic ``_ROW_nnnnn`` that the chain
   explicitly refuses. ``question_text`` is not in that chain, so a row with only question text is skipped.

Both must hold, so the rule is two any-of groups. ``question_text`` satisfies the first and never the second:
it is sufficient only alongside a name (``variable_name`` / ``field_id``) or ``short_label``.

THE RULE IS A PREDICTION; ``zero_variable_error`` CHECKS THE OUTCOME. A mapping can meet the rule and still load
nothing — the mapped description column is empty on every row — so the door also runs core's own loader (local,
free: no model, no network) and refuses a file that yields zero variables. That check cannot drift from core,
because it is core.
"""

from __future__ import annotations

import logging
from pathlib import Path

#: Every group must have at least one role mapped. Mirrored verbatim as ``REQUIRED_ROLE_GROUPS`` in
#: ``frontend/src/lib/dictionary.ts``; ``tests/test_role_requirement.py`` pins the two to one list and pins this
#: one to core's real loader.
REQUIRED_ROLE_GROUPS: tuple[tuple[str, ...], ...] = (
    # load_dictionary's own guard: some text or name to embed.
    ("variable_name", "description", "question_text"),
    # the parser's description chain: something to describe each row with (question_text is NOT in it).
    ("variable_name", "description", "short_label", "field_id"),
)


def _mapped(roles: dict[str, str]) -> set[str]:
    return {role for role, column in roles.items() if column}


def unmet_role_group(roles: dict[str, str]) -> tuple[str, ...] | None:
    """The first requirement group with no role mapped, or ``None`` when the mapping meets core's rule."""
    mapped = _mapped(roles)
    for group in REQUIRED_ROLE_GROUPS:
        if not mapped.intersection(group):
            return group
    return None


def _one_of(roles: tuple[str, ...]) -> str:
    return ", ".join(roles[:-1]) + f" or {roles[-1]}" if len(roles) > 1 else roles[0]


def role_requirement_error(filename: str, roles: dict[str, str]) -> str | None:
    """A reviewer-facing refusal naming the file and the missing role(s), or ``None`` when the mapping is enough."""
    group = unmet_role_group(roles)
    if group is None:
        return None
    if group == REQUIRED_ROLE_GROUPS[0]:
        return (
            f"{filename!r} has no column mapped to {_one_of(group)} — map at least one, so the pipeline has text "
            "to match against common data elements."
        )
    return (
        f"{filename!r} maps question_text but nothing the loader can describe a row with, so it would load no "
        f"variables: every row needs {_one_of(group)}, and a row with only question text is skipped. Map "
        "description (or a variable name) as well."
    )


def zero_variable_error(filename: str, path: Path, cohort_name: str, roles: dict[str, str]) -> str | None:
    """Run core's loader on the upload and refuse a file that yields no variables, naming what came up empty.

    ``None`` when the file loads at least one variable. Also turns core's own ``ValueError`` (a mapped column that
    is not in the file, say) into a stated refusal instead of a failure mid-run. Hierarchy detection is skipped:
    it only ever adds parents of rows that already loaded, so it cannot turn zero variables into some.
    """
    from ddharmon.ingestion import load_dictionary

    mapped = {role: column for role, column in roles.items() if column}
    # The loader's "No description= column" warning is expected here and says nothing new: this is a probe.
    ingestion_log = logging.getLogger("ddharmon.ingestion")
    previous = ingestion_log.level
    ingestion_log.setLevel(logging.ERROR)
    try:
        dd = load_dictionary(path, cohort_name=cohort_name, detect_hierarchy=False, **mapped)
    except ValueError as exc:
        return f"{filename!r} could not be loaded with this mapping: {exc}"
    finally:
        ingestion_log.setLevel(previous)
    if dd.field_count > 0:
        return None
    named = tuple(f"{role} ({mapped[role]!r})" for role in REQUIRED_ROLE_GROUPS[1] if role in mapped)
    return (
        f"{filename!r} loads no variables with this mapping: no row has text in its "
        f"{_one_of(named) if named else 'mapped'} column, so the loader has nothing to describe any row with and "
        f"skips them all. Map a column that has text in it to {_one_of(REQUIRED_ROLE_GROUPS[1])}."
    )
