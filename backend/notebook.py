"""Render a harmonization run's transform specs as a runnable Jupyter notebook (Python or R).

Built entirely from the stable ``UIResult`` contract (``result["records"][*].transforms`` +
``members`` + ``cde``) — like the CSV/TSV export, this is one more artifact insulated from pipeline
churn. The emitted notebook is a *scaffold*: the analyst points each cohort at their raw data file,
runs the cells, and gets CDE-named harmonized columns. Value recodes / unit conversions are filled
in; arithmetic and data-dependent transforms are emitted as clearly-marked review stubs (they can't
be trusted to auto-apply).

No third-party deps — we assemble the nbformat v4 dict by hand and hand it to ``json``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

Lang = str  # "py" | "r"


@dataclass
class _Op:
    """One source-field → target-CDE harmonization step for a single cohort."""

    var: str  # source column in the cohort's raw file
    target: str  # target CDE column name
    concept: str
    verdict: str
    transform: dict[str, Any] | None  # UITransform, or None → identity copy


def _pylit(s: str) -> str:
    """A safe Python/R string literal (JSON double-quoting is valid in both)."""
    return json.dumps(str(s))


def _ident(name: str) -> str:
    """Sanitize a cohort name into a variable-name-safe suffix (raw_<id> / h_<id>)."""
    out = "".join(c if c.isalnum() else "_" for c in name).strip("_")
    if not out:
        out = "cohort"
    if out[0].isdigit():
        out = "c_" + out
    return out


def _num(x: Any, default: float) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


# --- per-op code lines (language-specific) ---------------------------------------------------


def _op_lines_py(op: _Op) -> list[str]:
    t = op.transform
    tgt, var = _pylit(op.target), _pylit(op.var)
    head = f"# {op.concept}  ·  {op.verdict}"
    kind = (t or {}).get("kind", "identity")
    if t is None or kind in ("identity", "none"):
        return [f"{head} (copy)", f"h[{tgt}] = raw[{var}]", ""]
    if kind == "categorical":
        code_map = {str(k): str(v) for k, v in (t.get("codeMap") or {}).items()}
        unmapped = t.get("unmappedSourceCodes") or []
        note = f"  # {len(unmapped)} source code(s) unmapped → NaN" if unmapped else ""
        return [
            f"{head} (categorical recode){note}",
            f"_map = {code_map!r}",
            f"h[{tgt}] = raw[{var}].astype(str).map(_map)",
            "",
        ]
    if kind == "unit":
        factor, offset = _num(t.get("factor"), 1.0), _num(t.get("offset"), 0.0)
        su, tu = t.get("sourceUnit") or "?", t.get("targetUnit") or "?"
        return [f"{head} (unit: {su} → {tu})", f"h[{tgt}] = raw[{var}] * {factor} + {offset}", ""]
    if kind == "arithmetic":
        formula, inputs = t.get("formula") or "", t.get("inputs") or []
        return [
            f"{head} (arithmetic — REVIEW REQUIRED)",
            f"# formula: {formula}",
            f"# inputs:  {', '.join(inputs)}",
            f"# h[{tgt}] = ...  # TODO: implement the formula above over raw[...] columns",
            "",
        ]
    if kind == "data_dependent":
        return [
            f"{head} (data-dependent — needs participant data at apply-time)",
            f"# method: {t.get('method') or '?'}",
            f"# h[{tgt}] = ...  # TODO: derive from the data distribution",
            "",
        ]
    return [f"{head} (copy)", f"h[{tgt}] = raw[{var}]", ""]


def _op_lines_r(op: _Op) -> list[str]:
    t = op.transform
    tgt, var = _pylit(op.target), _pylit(op.var)
    head = f"# {op.concept}  ·  {op.verdict}"
    kind = (t or {}).get("kind", "identity")
    if t is None or kind in ("identity", "none"):
        return [f"{head} (copy)", f"h[[{tgt}]] <- raw[[{var}]]", ""]
    if kind == "categorical":
        code_map = {str(k): str(v) for k, v in (t.get("codeMap") or {}).items()}
        pairs = ", ".join(f"{_pylit(k)}={_pylit(v)}" for k, v in code_map.items())
        unmapped = t.get("unmappedSourceCodes") or []
        note = f"  # {len(unmapped)} source code(s) unmapped → NA" if unmapped else ""
        return [
            f"{head} (categorical recode){note}",
            f".map <- c({pairs})",
            f"h[[{tgt}]] <- unname(.map[as.character(raw[[{var}]])])",
            "",
        ]
    if kind == "unit":
        factor, offset = _num(t.get("factor"), 1.0), _num(t.get("offset"), 0.0)
        su, tu = t.get("sourceUnit") or "?", t.get("targetUnit") or "?"
        return [f"{head} (unit: {su} → {tu})", f"h[[{tgt}]] <- raw[[{var}]] * {factor} + {offset}", ""]
    if kind == "arithmetic":
        formula, inputs = t.get("formula") or "", t.get("inputs") or []
        return [
            f"{head} (arithmetic — REVIEW REQUIRED)",
            f"# formula: {formula}",
            f"# inputs:  {', '.join(inputs)}",
            f"# h[[{tgt}]] <- ...  # TODO: implement the formula above over raw[[...]] columns",
            "",
        ]
    if kind == "data_dependent":
        return [
            f"{head} (data-dependent — needs participant data at apply-time)",
            f"# method: {t.get('method') or '?'}",
            f"# h[[{tgt}]] <- ...  # TODO: derive from the data distribution",
            "",
        ]
    return [f"{head} (copy)", f"h[[{tgt}]] <- raw[[{var}]]", ""]


# --- notebook assembly -----------------------------------------------------------------------


def _md(*lines: str) -> dict[str, Any]:
    return {"cell_type": "markdown", "metadata": {}, "source": _src(lines)}


def _code(*lines: str) -> dict[str, Any]:
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": _src(lines)}


def _src(lines: tuple[str, ...] | list[str]) -> list[str]:
    """nbformat 'multiline string': list of lines, each with a trailing newline except the last."""
    joined = "\n".join(lines)
    return [ln + "\n" for ln in joined.split("\n")[:-1]] + [joined.split("\n")[-1]] if joined else []


_KERNELS = {
    "py": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "file_extension": ".py"},
    },
    "r": {
        "kernelspec": {"display_name": "R", "language": "R", "name": "ir"},
        "language_info": {"name": "R", "file_extension": ".r"},
    },
}


def build_notebook(result: dict[str, Any], lang: Lang, display_name: str = "") -> dict[str, Any]:
    """Assemble an nbformat v4 notebook dict for a run's transform specs. ``lang`` ∈ {"py","r"}."""
    lang = "r" if str(lang).lower() in ("r", "notebook_r") else "py"
    records = result.get("records", [])
    summary = result.get("summary", {})

    # Group harmonization ops by cohort (source side of each transform / member).
    ops: dict[str, list[_Op]] = {}
    novel: list[str] = []
    for r in records:
        cde = r.get("cde")
        tmap = {t.get("sourceVariable"): t for t in r.get("transforms", [])}
        for member in r.get("members", []):
            cohort, _, var = str(member).partition(":")
            t = tmap.get(member)
            target = (t or {}).get("targetCdeId") or (cde or {}).get("id") or ""
            if not target:
                novel.append(f"{r.get('concept', '?')}  ({member})")
                continue
            ops.setdefault(cohort, []).append(
                _Op(
                    var=var or member,
                    target=target,
                    concept=r.get("concept", "") or r.get("id", ""),
                    verdict=r.get("verdict", ""),
                    transform=t,
                )
            )

    op_lines = _op_lines_r if lang == "r" else _op_lines_py
    read = "read.csv" if lang == "r" else "pd.read_csv"
    title = display_name or "ddharmon run"

    cells: list[dict[str, Any]] = [
        _md(
            f"# Harmonization transforms — {title}",
            "",
            "_Generated by **ddharmon**._ This notebook applies the transform specs from your run to "
            "produce CDE-named harmonized columns.",
            "",
            f"- Records: **{summary.get('nRecords', len(records))}**  ·  "
            f"assigned to a CDE: **{summary.get('nAssigned', 0)}**  ·  "
            f"with transforms: **{summary.get('nWithTransforms', 0)}**",
            f"- Cohorts: {', '.join(summary.get('cohorts', [])) or '—'}",
            "",
            "**How to use:** in step 1, point each `raw_*` frame at your cohort's raw data file. "
            "Run step 2 to build one harmonized frame per cohort. Value recodes and unit conversions are "
            "filled in; **arithmetic** and **data-dependent** transforms are left as review stubs (they "
            "can't be trusted to auto-apply).",
        ),
        _md("## 1. Load your raw data", "", "Replace each path with your cohort's data file (participant-level rows)."),
    ]

    if not ops:
        cells.append(_md("_This run produced no CDE assignments with transforms to apply._"))
        return {"cells": cells, "metadata": _KERNELS[lang], "nbformat": 4, "nbformat_minor": 5}

    # Step 1 — load raw frames.
    load: list[str] = ["import pandas as pd", ""] if lang == "py" else []
    for cohort in ops:
        cid = _ident(cohort)
        load.append(f"raw_{cid} = {read}({_pylit(cohort + '.csv')})  # TODO: point to your {cohort} file")
    cells.append(_code(*load))

    # Step 2 — apply transforms, one code cell per cohort.
    cells.append(_md("## 2. Apply transform specs", "", "One harmonized frame (`h_*`) per cohort, keyed by CDE."))
    for cohort, cohort_ops in ops.items():
        cid = _ident(cohort)
        lines: list[str] = [f"# ===== {cohort} ====="]
        if lang == "py":
            lines.append(f"h_{cid} = pd.DataFrame(index=raw_{cid}.index)")
        else:
            lines.append(f"h_{cid} <- data.frame(row.names = rownames(raw_{cid}))")
        lines.append("")
        for op in cohort_ops:
            for ln in op_lines(op):
                # rebind the generic `h`/`raw` in the per-op snippet to this cohort's frames
                lines.append(ln.replace("h[", f"h_{cid}[").replace("raw[", f"raw_{cid}["))
        cells.append(_code(*lines))

    # Step 3 — combine/export.
    frames = ", ".join(f"h_{_ident(c)}" for c in ops)
    if lang == "py":
        cells.append(_md("## 3. Combine & export", "", "Concatenate the harmonized frames and write the result."))
        cells.append(
            _code(
                f"harmonized = pd.concat([{frames}], keys={list(ops)!r}, names=['cohort'])",
                "harmonized.to_csv('harmonized.csv')",
                "harmonized.head()",
            )
        )
    else:
        cells.append(_md("## 3. Combine & export", "", "Bind the harmonized frames and write the result."))
        bind = ", ".join(f"{cohort}=h_{_ident(cohort)}" for cohort in ops)
        cells.append(
            _code(
                f"harmonized <- dplyr::bind_rows({bind}, .id = 'cohort')",
                "write.csv(harmonized, 'harmonized.csv', row.names = FALSE)",
                "head(harmonized)",
            )
        )

    if novel:
        cells.append(
            _md(
                "## Novel concepts (no target CDE)",
                "",
                "These had no adequate CDE match — define a GenCDE before harmonizing:",
                "",
                *[f"- {n}" for n in novel[:200]],
            )
        )

    return {"cells": cells, "metadata": _KERNELS[lang], "nbformat": 4, "nbformat_minor": 5}
