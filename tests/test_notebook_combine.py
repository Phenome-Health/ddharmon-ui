"""08-28 item 1d — several variables of ONE cohort landing on ONE target column (F1, pre-existing).

The notebook keyed its ops by cohort only, so each same-cohort variable on a target overwrote the one before it
(live run 573cf61f: 17 of 29 target columns written more than once, max 14; the reviewer's edited recode
overwritten by a later copy; the one-shot demo 397 of 696). Q4 (decided 2026-09-30): the reviewer chooses per
(cohort, target), recorded as a ``gate3_combine_rule`` decision —

  * ``coalesce`` (the default, also when nothing was chosen): first non-blank value in member order, plus a
    ``TARGET__source`` column naming which variable each value came from, and a runtime count / warning of
    the rows where more than one variable carried a value;
  * ``separate``: one ``TARGET__<var>`` column per variable, no ``TARGET`` column;
  * one named source (``chosen`` = that member): only it writes ``TARGET``; the rest are named as unused.

Every column is assigned exactly once. The rule rides on every export (the notebook applies it; the records
JSON and TSV carry it; the decision log lists it through its generic kind loop).
"""

from __future__ import annotations

import csv
import io
import json
import re
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.artifact_kinds import (
    _DECISION_IDENTITY_FIELDS,
    DECISION_GATE,
    GATE3_COMBINE_RULE,
    GATE_DECISION_KINDS,
    option_set_key,
)
from backend.artifacts import registry
from backend.checkpoint import write_checkpoint
from backend.export_decisions import effective_records
from backend.notebook import build_notebook


def _t(source: str, target: str, kind: str = "identity", **kw) -> dict:
    return {
        "sourceVariable": source,
        "targetCdeId": target,
        "kind": kind,
        "confidence": 0.9,
        "coverage": 1.0,
        "needsUnits": False,
        "needsData": False,
        "needsReview": False,
        "rationale": "",
        "generatedBy": "rule",
        **kw,
    }


def _rec(group: str, members: list[str], transforms: list[dict], target: str = "T") -> dict:
    return {
        "id": group,
        "clusterId": group.split("#")[0],
        "groupId": group,
        "concept": f"concept {group}",
        "verdict": "adopt",
        "route": "assigned",
        "cde": {"id": target, "externalId": ""},
        "gencde": None,
        "idealCde": "",
        "cosines": {"top1": 0.8, "chosen": 0.8},
        "coverageGap": False,
        "floored": False,
        "crossCohort": True,
        "nMembers": len(members),
        "cohorts": sorted({m.split(":")[0] for m in members}),
        "members": members,
        "memberDetails": [],
        "transforms": transforms,
        "candidates": [],
        "rationale": "",
        "decidedBy": "llm",
    }


def _records() -> list[dict]:
    """CLSA carries THREE variables onto T (two in one group, one in another); AoU carries one."""
    return [
        _rec("c1#g0", ["CLSA:a", "CLSA:b", "AoU:x"], [_t("CLSA:a", "T"), _t("CLSA:b", "T"), _t("AoU:x", "T")]),
        _rec("c2#g0", ["CLSA:c"], [_t("CLSA:c", "T", "categorical", codeMap={"y": "3"})]),
    ]


def _rule(chosen: str, cohort: str = "CLSA", target: str = "T", members=("CLSA:a", "CLSA:b", "CLSA:c")) -> dict:
    alternatives = ["coalesce", "separate", *members]
    return {"cohort": cohort, "targetId": target, "chosen": chosen, "alternatives": alternatives,
            "optionSetKey": option_set_key(alternatives)}  # fmt: skip


def _grouped(*rules: dict) -> dict:
    return {GATE3_COMBINE_RULE: list(rules)} if rules else {}


def _cohort_cell(nb: dict, cohort: str) -> str:
    for cell in nb["cells"]:
        src = "".join(cell["source"])
        if cell["cell_type"] == "code" and src.startswith(f"# ===== {cohort} ====="):
            return src
    raise AssertionError(f"no cell for {cohort}")


def _assigned(cell: str) -> dict[str, int]:
    """Column -> how many times the cell assigns it (the live driver's I9 reading, ``scripts/live_verify.py``)."""
    out: dict[str, int] = {}
    for ln in cell.splitlines():
        m = re.match(r"^h_\w+\[(['\"])(.+?)\1\]\s*=", ln) or re.match(r"^h_\w+\[\[(['\"])(.+?)\1\]\]\s*<-", ln)
        if m:
            out[m.group(2)] = out.get(m.group(2), 0) + 1
    return out


def _run_py(nb: dict, frames: dict[str, dict], tmp_path, monkeypatch, capsys=None) -> dict:
    pd = pytest.importorskip("pandas")
    monkeypatch.chdir(tmp_path)
    for cohort, cols in frames.items():
        pd.DataFrame(cols).to_csv(f"{cohort}.csv", index=False)
    ns: dict = {}
    for cell in nb["cells"]:
        src = "".join(cell["source"])
        if cell["cell_type"] == "code" and "harmonized" not in src:
            exec(src, ns)  # noqa: S102 — the point is to run the generated code
    return ns


RAW = {
    "CLSA": {"a": [1, None, None, 5], "b": [None, 2, None, 6], "c": [None, None, "y", None]},
    "AoU": {"x": [7, 8, 9, 10]},
}


def _vals(series) -> list:
    import pandas as pd

    return [None if pd.isna(v) else (int(v) if isinstance(v, float) and v.is_integer() else v) for v in series]


# --- the kind -------------------------------------------------------------------------------------------


def test_the_combine_rule_is_a_registered_gate3_decision_keyed_on_cohort_and_target():
    assert GATE3_COMBINE_RULE == "gate3_combine_rule"
    assert GATE3_COMBINE_RULE in GATE_DECISION_KINDS
    assert DECISION_GATE[GATE3_COMBINE_RULE] == "gate3"
    assert _DECISION_IDENTITY_FIELDS[GATE3_COMBINE_RULE] == ("cohort", "targetId")
    kind = registry.get(GATE3_COMBINE_RULE)
    assert kind.key_for(_rule("separate")) == "CLSA|T"
    kind.validate(_rule("coalesce"))
    kind.validate(_rule("CLSA:b"))
    kind.validate(_rule(""))  # "none of these" = the default rule
    with pytest.raises(ValueError, match="combine"):
        kind.validate(_rule("CLSA:zzz"))  # a source that was never one of the options


# --- the notebook ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("lang", ["py", "r"])
def test_every_target_column_is_assigned_once_per_cohort(lang):
    nb = build_notebook({"records": effective_records({"records": _records()}, {}, {})}, lang)
    clsa = _assigned(_cohort_cell(nb, "CLSA"))
    assert clsa == {"T": 1, "T__source": 1}, clsa
    assert _assigned(_cohort_cell(nb, "AoU")) == {"T": 1}, "a lone variable is written straight to its column"


def test_the_default_coalesces_first_non_blank_with_provenance_and_an_overlap_warning(tmp_path, monkeypatch, capsys):
    nb = build_notebook({"records": effective_records({"records": _records()}, {}, {})}, "py")
    ns = _run_py(nb, RAW, tmp_path, monkeypatch)
    h = ns["h_CLSA"]
    assert _vals(h["T"]) == [1, 2, "3", 5]
    assert _vals(h["T__source"]) == ["a", "b", "c", "a"]
    out = capsys.readouterr().out
    assert "WARNING" in out and "1 row" in out and "CLSA" in out, out
    assert _vals(ns["h_AoU"]["T"]) == [7, 8, 9, 10]


def test_keep_separate_writes_one_column_per_variable(tmp_path, monkeypatch):
    recs = effective_records({"records": _records()}, {}, _grouped(_rule("separate")))
    nb = build_notebook({"records": recs}, "py")
    assert _assigned(_cohort_cell(nb, "CLSA")) == {"T__a": 1, "T__b": 1, "T__c": 1}
    h = _run_py(nb, RAW, tmp_path, monkeypatch)["h_CLSA"]
    assert _vals(h["T__a"]) == [1, None, None, 5] and _vals(h["T__c"]) == [None, None, "3", None]


def test_one_named_source_is_the_only_writer(tmp_path, monkeypatch):
    recs = effective_records({"records": _records()}, {}, _grouped(_rule("CLSA:b")))
    nb = build_notebook({"records": recs}, "py")
    cell = _cohort_cell(nb, "CLSA")
    assert _assigned(cell) == {"T": 1}
    assert "not used" in cell and "a" in cell
    assert _vals(_run_py(nb, RAW, tmp_path, monkeypatch)["h_CLSA"]["T"]) == [None, 2, None, 6]


def test_a_source_that_left_the_group_falls_back_to_coalesce_and_says_so():
    """The chosen source was rejected at Gate 3 after the rule was set: the rule cannot name a writer that
    produces nothing, so the default applies — stated in the cell, never a silently empty column."""
    grouped = {
        **_grouped(_rule("CLSA:a")),
        "gate3_spec_edit": [{"sourceVariable": "CLSA:a", "chosen": "", "rejected": True, "alternatives": [],
                             "optionSetKey": "k"}],
    }  # fmt: skip
    nb = build_notebook({"records": effective_records({"records": _records()}, {}, grouped)}, "py")
    cell = _cohort_cell(nb, "CLSA")
    assert _assigned(cell) == {"T": 1, "T__source": 1}
    assert "CLSA:a" in cell and "coalesce" in cell.lower()


def test_r_runs_the_default_coalesce(tmp_path):
    rscript = shutil.which("Rscript")
    if not rscript:
        pytest.skip("Rscript not installed")
    pd = pytest.importorskip("pandas")
    nb = build_notebook({"records": effective_records({"records": _records()}, {}, {})}, "r")
    for cohort, cols in RAW.items():
        pd.DataFrame(cols).to_csv(tmp_path / f"{cohort}.csv", index=False, na_rep="NA")
    cells = ["".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code"]
    body = "\n".join(c for c in cells if "harmonized" not in c)
    script = body + '\nwrite.csv(h_CLSA, "out.csv", row.names = FALSE)\n'
    run = subprocess.run([rscript, "-e", script], cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    rows = list(csv.DictReader(io.StringIO((tmp_path / "out.csv").read_text())))
    assert [r["T"] for r in rows] == ["1", "2", "3", "5"]
    assert [r["T__source"] for r in rows] == ["a", "b", "c", "a"]
    assert "1 row" in run.stderr, run.stderr  # the overlap warning


def test_a_value_spelling_h_or_raw_bracket_survives_the_per_cohort_rebinding(tmp_path, monkeypatch):
    """The per-op snippet used to be rebound with ``ln.replace("h[", …)``, which also rewrote any "h[" / "raw["
    inside a code-map VALUE or a concept name."""
    rec = _rec("c3#g0", ["A:q"], [_t("A:q", "T", "categorical", codeMap={"1": "raw[1]", "2": "h[2]"})])
    rec["concept"] = "Weight h[kg]"
    nb = build_notebook({"records": [rec]}, "py")
    assert "Weight h[kg]" in _cohort_cell(nb, "A")
    h = _run_py(nb, {"A": {"q": ["1", "2"]}}, tmp_path, monkeypatch)["h_A"]
    assert list(h["T"]) == ["raw[1]", "h[2]"]


# --- every export carries it ----------------------------------------------------------------------------


@pytest.fixture
def parked(monkeypatch, tmp_path):
    """A run parked at Gate 4 over :func:`_records`, with its checkpoint written (the staged export path)."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: None)  # noqa: ARG005
    with TestClient(app_module.app) as client:
        wd = tmp_path / "work" / "cr"
        app_module.store.create("cr", "Combine run", {"work_dir": str(wd)}, owner_subject=None)
        result = {"records": _records(), "conceptGroups": [], "summary": {"cohorts": ["AoU", "CLSA"]}}
        write_checkpoint(wd, job_id="cr", gate="gate4", result=result, responses={}, realized_cost=0.0)
        app_module.store.checkpoint("cr", gate="gate4", checkpoint_ref="cr/checkpoint_gate4.json", realized_cost=0.0)
        yield client, "cr"


def _put(job_id: str, kind: str, payload: dict) -> None:
    from backend.jobs import principal_of

    job = app_module.store.get(job_id)
    app_module.store.artifacts.put(owner=principal_of(None, job), job_id=job_id, kind=kind, payload=payload,
                                   pinned=False)  # fmt: skip


def test_every_export_carries_the_rule(parked):
    client, job_id = parked
    _put(job_id, GATE3_COMBINE_RULE, _rule("separate"))

    def get(fmt: str):
        r = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": fmt})
        assert r.status_code == 200, r.text
        return r

    recs = {r["groupId"]: r for r in get("records_json").json()}
    rule = next(x for x in recs["c1#g0"]["combineRules"] if x["cohort"] == "CLSA")
    assert rule == {"cohort": "CLSA", "targetId": "T", "members": ["CLSA:a", "CLSA:b", "CLSA:c"],
                    "rule": "separate", "source": "", "decidedBy": "reviewer"}  # fmt: skip
    assert recs["c2#g0"]["combineRules"] == [rule], "every record with a member in the group carries it"
    tsv = {r["recordId"]: r for r in csv.DictReader(io.StringIO(get("eitl_tsv").text), delimiter="\t")}
    assert json.loads(tsv["c1#g0"]["combineRules"])[0]["rule"] == "separate"
    nb = get("notebook_py").json()
    assert _assigned(_cohort_cell(nb, "CLSA")) == {"T__a": 1, "T__b": 1, "T__c": 1}
    log = list(csv.DictReader(io.StringIO(get("decisions_csv").text)))
    assert any(r["kind"] == GATE3_COMBINE_RULE and r["item"] == "CLSA|T" and r["gate"] == "Gate 3" for r in log)


def test_an_undecided_group_exports_the_default_rule_as_the_default(parked):
    client, job_id = parked
    _put(job_id, "gate1_rename", {"groupId": "c2#g0", "chosen": "x", "alternatives": ["x"], "optionSetKey": "k"})
    recs = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": "records_json"}).json()
    rule = next(r for r in recs if r["groupId"] == "c1#g0")["combineRules"][0]
    assert rule["rule"] == "coalesce" and rule["decidedBy"] == "default"
