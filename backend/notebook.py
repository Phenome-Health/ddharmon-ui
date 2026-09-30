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


# --- the reviewer's Gate 3 edits (08-27) -----------------------------------------------------
#
# A staged run's transforms may carry ``reviewerEdit`` (the recode the reviewer corrected at Gate 3) and
# ``targetRepicked`` (the reviewer re-picked the target at Gate 2 after this recode was generated for the
# model's). Both are set only by ``backend/export_decisions.py``; a legacy run's transforms carry neither,
# so its notebook is unchanged. A REJECTED recode never reaches here — ``build_notebook`` leaves it out.

#: The standing buckets of the Gate 3 value-map editor (``SpecMappingEditor.tsx``): not a target value.
_MISSING_BUCKET = "__missing__"
_DROP_BUCKET = "__drop__"


def _edit_of(t: dict[str, Any] | None) -> dict[str, Any]:
    edit = (t or {}).get("reviewerEdit")
    return edit if isinstance(edit, dict) else {}


def _split_mapping(mapping: dict[str, Any]) -> tuple[dict[str, str], list[str], list[str]]:
    """A reviewer's value map -> (code -> target value, codes set missing, codes dropped)."""
    real: dict[str, str] = {}
    missing: list[str] = []
    dropped: list[str] = []
    for code, target in mapping.items():
        if target == _MISSING_BUCKET:
            missing.append(str(code))
        elif target == _DROP_BUCKET:
            dropped.append(str(code))
        elif target:
            real[str(code)] = str(target)
    return real, missing, dropped


def _number_codes(number_map: dict[str, Any]) -> dict[str, float | None]:
    """A reviewer's code -> number table: ``number`` carries its value; ``missing``/``drop`` become missing."""
    out: dict[str, float | None] = {}
    for code, entry in number_map.items():
        entry = entry if isinstance(entry, dict) else {}
        value = entry.get("value")
        out[str(code)] = _num(value, 0.0) if entry.get("action") == "number" and value is not None else None
    return out


def _bin_rules(bins: list[Any]) -> list[tuple[str, float | None, float | None]]:
    rules: list[tuple[str, float | None, float | None]] = []
    for b in bins:
        if not isinstance(b, dict) or not str(b.get("band") or ""):
            continue
        lo, hi = b.get("min"), b.get("max")
        if lo is None and hi is None:
            continue  # an unbounded band would swallow every value; the reviewer never bounded it
        rules.append((str(b["band"]), None if lo is None else _num(lo, 0.0), None if hi is None else _num(hi, 0.0)))
    return rules


def _edited_lines_py(op: _Op, edit: dict[str, Any]) -> list[str] | None:
    tgt, var = _pylit(op.target), _pylit(op.var)
    head = f"# {op.concept}  ·  {op.verdict}"
    if isinstance(edit.get("mapping"), dict):
        real, missing, dropped = _split_mapping(edit["mapping"])
        lines = [f"{head} (categorical recode — REVIEWER-EDITED at Gate 3)"]
        if missing:
            lines.append(f"# set missing by the reviewer → NaN: {', '.join(missing)}")
        if dropped:
            lines.append(
                f"# dropped by the reviewer → NaN (filter these rows if a drop means exclude): {', '.join(dropped)}"
            )
        return [*lines, f"_map = {real!r}", f"h[{tgt}] = raw[{var}].astype(str).map(_map)", ""]
    if isinstance(edit.get("numberMap"), dict):
        codes = _number_codes(edit["numberMap"])
        return [
            f"{head} (code → number — REVIEWER-EDITED at Gate 3; None = missing)",
            f"_codes = {codes!r}",
            f"_s = raw[{var}].astype(str)",
            f"h[{tgt}] = pd.to_numeric(raw[{var}].where(~_s.isin(list(_codes))), errors='coerce')"
            ".fillna(_s.map(_codes))",
            "",
        ]
    if isinstance(edit.get("bins"), list):
        rules = _bin_rules(edit["bins"])
        return [
            f"{head} (binning — REVIEWER-EDITED at Gate 3; bounds inclusive, first matching band wins)",
            f"_bins = {rules!r}",
            f"_x = pd.to_numeric(raw[{var}], errors='coerce')",
            "_out = pd.Series(pd.NA, index=_x.index, dtype='object')",
            "for _band, _lo, _hi in _bins:",
            "    _m = _x.notna() & _out.isna()",
            "    if _lo is not None:",
            "        _m &= _x >= _lo",
            "    if _hi is not None:",
            "        _m &= _x <= _hi",
            "    _out[_m] = _band",
            f"h[{tgt}] = _out",
            "",
        ]
    return None


def _rnum(x: float | None) -> str:
    return "NA" if x is None else repr(float(x))


def _edited_lines_r(op: _Op, edit: dict[str, Any]) -> list[str] | None:
    tgt, var = _pylit(op.target), _pylit(op.var)
    head = f"# {op.concept}  ·  {op.verdict}"
    if isinstance(edit.get("mapping"), dict):
        real, missing, dropped = _split_mapping(edit["mapping"])
        pairs = ", ".join(f"{_pylit(k)}={_pylit(v)}" for k, v in real.items())
        lines = [f"{head} (categorical recode — REVIEWER-EDITED at Gate 3)"]
        if missing:
            lines.append(f"# set missing by the reviewer → NA: {', '.join(missing)}")
        if dropped:
            lines.append(
                f"# dropped by the reviewer → NA (filter these rows if a drop means exclude): {', '.join(dropped)}"
            )
        return [*lines, f".map <- c({pairs})", f"h[[{tgt}]] <- unname(.map[as.character(raw[[{var}]])])", ""]
    if isinstance(edit.get("numberMap"), dict):
        codes = _number_codes(edit["numberMap"])
        pairs = ", ".join(f"{_pylit(k)}={_rnum(v)}" for k, v in codes.items())
        return [
            f"{head} (code → number — REVIEWER-EDITED at Gate 3; NA = missing)",
            f".codes <- c({pairs})",
            f".s <- as.character(raw[[{var}]])",
            f"h[[{tgt}]] <- ifelse(.s %in% names(.codes), unname(.codes[.s]), suppressWarnings(as.numeric(.s)))",
            "",
        ]
    if isinstance(edit.get("bins"), list):
        lines = [
            f"{head} (binning — REVIEWER-EDITED at Gate 3; bounds inclusive, first matching band wins)",
            f".x <- suppressWarnings(as.numeric(as.character(raw[[{var}]])))",
            ".out <- rep(NA_character_, length(.x))",
        ]
        for band, lo, hi in _bin_rules(edit["bins"]):
            cond = ["!is.na(.x)", "is.na(.out)"]
            if lo is not None:
                cond.append(f".x >= {_rnum(lo)}")
            if hi is not None:
                cond.append(f".x <= {_rnum(hi)}")
            lines.append(f".out[{' & '.join(cond)}] <- {_pylit(band)}")
        return [*lines, f"h[[{tgt}]] <- .out", ""]
    return None


def _repicked_stub(op: _Op, model_lines: list[str]) -> list[str]:
    """A recode generated for the MODEL's target after the reviewer re-picked it: shown, not applied."""
    t = op.transform or {}
    return [
        f"# {op.concept}  ·  {op.verdict} — REVIEW REQUIRED: target re-picked at Gate 2",
        f"# This recode was generated for {t.get('modelTargetCdeId') or 'the model’s target'}; the reviewer "
        f"chose {op.target}. Its codes may not fit — re-map it at Gate 3, then re-export.",
        *[f"# {ln}" for ln in model_lines if ln],
        "",
    ]


def _op_lines(op: _Op, lang: Lang) -> list[str]:
    model = _op_lines_r if lang == "r" else _op_lines_py
    edited = (_edited_lines_r if lang == "r" else _edited_lines_py)(op, _edit_of(op.transform))
    if edited is not None:
        return edited
    if (op.transform or {}).get("targetRepicked"):
        return _repicked_stub(op, model(op))
    return model(op)


# --- per-op code lines (language-specific) ---------------------------------------------------


def _unproduced(t: dict[str, Any] | None) -> str:
    """Why this spec could not be produced, or ``""`` when it can be applied (08-28 1c, F16).

    * kind ``none`` — the model produced an EMPTY code map (nothing could be mapped). Copying the raw column
      would put the source's codes into the target's value domain with no recode at all.
    * a ``unit`` spec with no conversion factor — the units could not be reconciled (core's ``needs_units``
      residual). Applying ``* 1.0 + 0.0`` would pass a number in the wrong units off as converted.
    """
    kind = (t or {}).get("kind")
    if kind == "none":
        return "no mapping could be produced for this variable's values"
    if kind == "unit" and not isinstance((t or {}).get("factor"), (int, float)):
        su, tu = (t or {}).get("sourceUnit") or "?", (t or {}).get("targetUnit") or "?"
        return f"no unit conversion could be authored ({su} → {tu})"
    return ""


def _unknown_kind_stub(op: _Op, dest: str, src: str, assign: str = "=") -> list[str]:
    """A kind this notebook has no recipe for (e.g. a wide→long reshape): named and left for review, never a
    copy — copying the raw column would claim the values already fit the target."""
    kind = (op.transform or {}).get("kind") or "?"
    return [
        f"# {op.concept}  ·  {op.verdict} — REVIEW REQUIRED: a {kind} transform is not applied automatically",
        f"# {dest} {assign} ...  # TODO: apply the {kind} transform to {src}",
        "",
    ]


def _unproduced_stub(op: _Op, dest: str, src: str, assign: str = "=") -> list[str] | None:
    """A commented REVIEW REQUIRED stub for a spec that could not be produced — never a copy."""
    why = _unproduced(op.transform)
    if not why:
        return None
    rationale = str((op.transform or {}).get("rationale") or "").strip()
    return [
        f"# {op.concept}  ·  {op.verdict} — REVIEW REQUIRED: {why}",
        *([f"# pipeline: {rationale}"] if rationale else []),
        "# Nothing is applied here. Map this variable at Gate 3 and re-export, or write the recode by hand:",
        f"# {dest} {assign} ...  # TODO: recode {src} onto {op.target}",
        "",
    ]


def _op_lines_py(op: _Op) -> list[str]:
    t = op.transform
    tgt, var = _pylit(op.target), _pylit(op.var)
    head = f"# {op.concept}  ·  {op.verdict}"
    kind = (t or {}).get("kind", "identity")
    if t is None or kind == "identity":
        return [f"{head} (copy)", f"h[{tgt}] = raw[{var}]", ""]
    stub = _unproduced_stub(op, f"h[{tgt}]", f"raw[{var}]")
    if stub is not None:
        return stub
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
    return _unknown_kind_stub(op, f"h[{tgt}]", f"raw[{var}]")


def _op_lines_r(op: _Op) -> list[str]:
    t = op.transform
    tgt, var = _pylit(op.target), _pylit(op.var)
    head = f"# {op.concept}  ·  {op.verdict}"
    kind = (t or {}).get("kind", "identity")
    if t is None or kind == "identity":
        return [f"{head} (copy)", f"h[[{tgt}]] <- raw[[{var}]]", ""]
    stub = _unproduced_stub(op, f"h[[{tgt}]]", f"raw[[{var}]]", assign="<-")
    if stub is not None:
        return stub
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
    return _unknown_kind_stub(op, f"h[[{tgt}]]", f"raw[[{var}]]", assign="<-")


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
    rejected: list[str] = []
    for r in records:
        cde = r.get("cde")
        tmap = {t.get("sourceVariable"): t for t in r.get("transforms", [])}
        for member in r.get("members", []):
            cohort, _, var = str(member).partition(":")
            t = tmap.get(member)
            if (t or {}).get("rejected"):
                # Rejected at Gate 3: excluded from the notebook, as the Reject dialog promises — not even
                # copied, since copying the raw codes onto the CDE column would apply the rejected mapping's
                # opposite (no recode at all) without anyone having chosen it.
                rejected.append(f"{r.get('concept', '?')}  ({member})")
                continue
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
        cells.extend(_rejected_cells(rejected))
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
            for ln in _op_lines(op, lang):
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

    cells.extend(_rejected_cells(rejected))
    return {"cells": cells, "metadata": _KERNELS[lang], "nbformat": 4, "nbformat_minor": 5}


def _rejected_cells(rejected: list[str]) -> list[dict[str, Any]]:
    """The recodes the reviewer rejected at Gate 3 — named, so their absence above is not a silent one."""
    if not rejected:
        return []
    return [
        _md(
            "## Rejected recodes (excluded)",
            "",
            "The reviewer rejected these recodes at Gate 3, so this notebook does not produce them:",
            "",
            *[f"- {n}" for n in rejected[:200]],
        )
    ]
