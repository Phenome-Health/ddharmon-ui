"""One code space per harmonized column (08-28 item 1c, F18).

A transform's ``codeMap`` maps source codes onto the TARGET's CODES — core's spec-gen prompt says so, and it
drops any target value that is not one of the target's codes. A reviewer's Gate 3 edit must land in the same
space, or one column ends up holding ``"1"``/``"0"`` from the model's recodes beside ``"Yes"``/``"No"`` from
the reviewer's. The Gate 3 editor now saves codes; this module resolves an edit saved BEFORE that fix (which
holds labels) through the target's permissible-value table, so every export applies it in codes.

Only a GENERATED target carries a code table on the record (``record.gencde.permissibleValues``). A catalog
CDE's value is its label (the catalog lists values, not code/label pairs), so there is nothing to translate
and its edits are left exactly as saved. A value the table does not know is never rewritten.
"""

from __future__ import annotations

import copy
from typing import Any

#: The Gate 3 editor's standing buckets — conventions, not target values (``SpecMappingEditor.tsx``).
MISSING_BUCKET = "__missing__"
DROP_BUCKET = "__drop__"


def target_code_table(record: dict[str, Any], transform: dict[str, Any] | None) -> dict[str, str]:
    """``value -> target code`` for the target this transform writes, or ``{}`` when it has no code table.

    Keyed on every code (to itself) and on every label, case-folded — a code wins over a label that happens to
    spell another value's code.
    """
    gencde = record.get("gencde") or {}
    target = str((transform or {}).get("targetCdeId") or "")
    if not gencde or not target or target != str(gencde.get("gencdeId") or ""):
        return {}
    table: dict[str, str] = {}
    pvs = [pv for pv in gencde.get("permissibleValues") or [] if isinstance(pv, dict) and str(pv.get("code") or "")]
    for pv in pvs:
        label = str(pv.get("label") or "").strip()
        if label:
            table.setdefault(label.casefold(), str(pv["code"]))
    for pv in pvs:
        code = str(pv["code"])
        table[code] = code
        table[code.casefold()] = code
    return table


def _resolve(value: Any, table: dict[str, str]) -> Any:
    if not isinstance(value, str) or value in (MISSING_BUCKET, DROP_BUCKET, ""):
        return value
    return table.get(value) or table.get(value.strip().casefold()) or value


def in_target_codes(edit: dict[str, Any], record: dict[str, Any], transform: dict[str, Any] | None) -> dict[str, Any]:
    """The reviewer's edit with every target value (a ``mapping`` value, a ``bins`` band) in the target's codes."""
    table = target_code_table(record, transform)
    if not table:
        return edit
    out = copy.deepcopy(edit)
    if isinstance(out.get("mapping"), dict):
        out["mapping"] = {code: _resolve(v, table) for code, v in out["mapping"].items()}
    if isinstance(out.get("bins"), list):
        for b in out["bins"]:
            if isinstance(b, dict) and "band" in b:
                b["band"] = _resolve(b["band"], table)
    return out
