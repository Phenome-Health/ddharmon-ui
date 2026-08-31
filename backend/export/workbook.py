"""One workbook, one sheet per dictionary — the whole upload set as the reviewer will cluster it.

WHY A WORKBOOK AND NOT N CSVs. The per-dictionary CSV answers *"what will this file give the model?"*, and
that is the question while a reviewer is still mapping one file. The workbook answers the question they
have once every file is mapped: *"what does the whole run look like?"* — which is a comparison across
dictionaries, and a comparison across five downloads in a Downloads folder is not one. Both ship; neither
replaces the other.

IT IS THE SAME COMPUTATION, N TIMES. Every cell comes from :func:`build_embedding_export`, the function the
CSV endpoint calls. Two implementations of "what string gets embedded" is exactly the duplication that
produces two different answers, and a reviewer holding both files would have no way to tell which one was
lying.

THE TWO EXCEL FACTS THAT BITE, both handled here rather than discovered in production:

  * **A sheet name is capped at 31 characters** and may not contain ``[ ] : * ? / \\``. Truncating naively
    makes two long cohort names collapse onto one sheet — silently, because openpyxl is happy to be handed
    a duplicate title and simply renames it. A lost sheet in a file that claims one per dictionary is worse
    than a failure.
  * **A cell is capped at 32,767 characters.** An embedding string can exceed it (a description column
    holding a whole protocol paragraph is not rare). openpyxl does not truncate — it writes the value and
    Excel refuses the file — so a cut is made HERE, and it is marked. The one thing this export exists to
    show is the exact text; a silent cut would make it show a different text just as confidently.
"""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

from backend.engine.adapter import build_embedding_export

#: Excel's hard cap on the characters in one cell. Not a style choice — the file simply will not open.
CELL_CHAR_LIMIT = 32_767

#: Excel's hard cap on a worksheet title.
SHEET_NAME_LIMIT = 31

#: Characters Excel forbids in a worksheet title.
_FORBIDDEN_IN_SHEET_NAME = re.compile(r"[\[\]:*?/\\]")

#: Control characters openpyxl refuses to write. Real dictionary exports carry them (a stray \x07 from a
#: terminal paste, \x0b from a Word round-trip), and losing every sheet to one byte in one cell is a far
#: worse answer than that cell arriving cleaned.
_ILLEGAL_IN_CELL = re.compile(r"[\000-\010\013\014\016-\037]")


def sheet_names_for(names: list[str]) -> list[str]:
    """Excel-legal, unique worksheet titles, one per input, in order.

    UNIQUENESS IS THE POINT, not legality. Legality alone is one ``re.sub``; the failure this function
    exists for is two long cohort names that differ only in their tail — ``cohort_with_a_very_long_name_alpha``
    and ``…_beta`` both truncate to the same 31 characters. openpyxl would accept both titles and quietly
    disambiguate one of them, so the reviewer gets a workbook with a sheet whose name does not match any
    dictionary they uploaded.

    The suffix is applied by SHORTENING the base rather than by appending past the cap, because appending
    past 31 characters is the same bug one step later.
    """
    out: list[str] = []
    taken: set[str] = set()
    for i, raw in enumerate(names):
        base = _FORBIDDEN_IN_SHEET_NAME.sub("_", str(raw or "")).strip()
        # A blank title is illegal and an unnamed dictionary is still a dictionary, so it is numbered
        # rather than refused.
        base = base or f"dictionary {i + 1}"
        candidate = base[:SHEET_NAME_LIMIT]
        n = 2
        while candidate.casefold() in taken:
            # Excel compares titles case-insensitively, so `taken` does too — otherwise `Alpha` and `alpha`
            # would both be accepted here and collide inside the file.
            suffix = f"~{n}"
            candidate = base[: SHEET_NAME_LIMIT - len(suffix)] + suffix
            n += 1
        taken.add(candidate.casefold())
        out.append(candidate)
    return out


def fit_cell(value: str) -> str:
    """One cell's text, made writable: control characters removed, and any over-long value cut and LABELLED.

    The label carries the number of characters lost. "Truncated" alone tells a reviewer the string is not
    the real one; the count tells them how far off it is, which is the difference between "ignore the tail"
    and "this variable's text is mostly gone".
    """
    text = _ILLEGAL_IN_CELL.sub("", str(value or ""))
    if len(text) <= CELL_CHAR_LIMIT:
        return text
    # The marker is measured against the FULL text, so the number is what was actually lost — including
    # the characters the marker itself displaces.
    for keep in range(CELL_CHAR_LIMIT, 0, -1):
        marker = f" …[truncated, {len(text) - keep} characters omitted]"
        if keep + len(marker) <= CELL_CHAR_LIMIT:
            return text[:keep] + marker
    return text[:CELL_CHAR_LIMIT]


def build_embedding_workbook(specs: list[dict[str, Any]]) -> bytes:
    """The ``.xlsx`` bytes for a whole upload set — one sheet per dictionary, in the order given.

    ``specs`` are the mapped uploads: ``{path, filename, cohort_name, column_roles}``, the shape
    ``_mapped_uploads`` produces, so the endpoint does no translation of its own.

    A dictionary that cannot be loaded raises rather than producing a workbook with a missing sheet: a
    workbook whose sheet count silently disagrees with the number of dictionaries uploaded is the failure
    mode a reviewer is least likely to notice.
    """
    from openpyxl import Workbook

    titles = sheet_names_for([str(s.get("cohort_name") or Path(str(s.get("filename", ""))).stem) for s in specs])
    # WRITE-ONLY, because a real upload set is large: CLSA alone is 6,018 rows, and the in-memory cell
    # model would hold every one of them as an object for the whole build.
    wb = Workbook(write_only=True)
    for spec, title in zip(specs, titles, strict=True):
        export = build_embedding_export(
            spec["path"], cohort_name=str(spec["cohort_name"]), column_roles=dict(spec["column_roles"])
        )
        ws = wb.create_sheet(title=title)
        ws.append([fit_cell(c) for c in export.header])
        for row in export.rows:
            ws.append([fit_cell(c) for c in row])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
