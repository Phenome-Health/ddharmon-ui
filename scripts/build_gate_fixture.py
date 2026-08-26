#!/usr/bin/env python3
"""Derive the staged-review gate fixture from the shipped demo result.

    python scripts/build_gate_fixture.py

Writes ``frontend/public/static-data/result-demo-staged-gate1.json`` — a run PAUSED at the Gate 1
boundary, which is what the gate walk in ``frontend/tests/e2e/gates.spec.ts`` renders against.

WHY DERIVED RATHER THAN HAND-WRITTEN. Reaching Gate 1 on a real run costs concept generation, splitting
and the coherence judge (UI-SPEC §0.1), and no test in this phase may incur that. So the fixture has to
come from somewhere already paid for: the bundled demo result, whose records already carry every field a
post-split concept group has (``groupId``, ``clusterId``, ``concept``, ``nMembers``, ``cohorts``,
``members``). A concept group IS the pre-assign projection of a record — so this script *removes* the
fields the assign stage added rather than inventing any.

Hand-writing it instead would put invented concept names and cohort lists in a committed file with nothing
tying them to a real run, and the first person to change the group shape would have no way to tell whether
the fixture was still describing reality.

The fixture is deliberately NOT added to ``jobs.json``: it is a route fixture, not a run in anyone's
history, and adding it would change the ``/jobs`` visual baseline for no reason.
"""

from __future__ import annotations

import csv
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "frontend" / "public" / "static-data"
SOURCE = STATIC / "result-demo-aireadi_aou_clsa_mesa_ukbb.json"
OUT = STATIC / "result-demo-staged-gate1.json"

#: How many groups the fixture carries. The real demo has hundreds; a full-page screenshot baseline of all
#: of them would be an 8000px capture whose only content is repetition, and the walk asserts a count and an
#: identity, not a scroll length.
GROUP_CAP = 12

#: Members carried on a collapsed group row — mirrors ``adapter._GROUP_MEMBER_CAP``. ``nMembers`` stays the
#: true count and ``membersTruncated`` says which this list is.
MEMBER_CAP = 25


#: What reaching Gate 1 cost on this fixture. Taken from the source run's realized cost so the number on
#: screen is a real one; the demo is a $0 replay, so a zero here is honest rather than a placeholder.
def _realized(result: dict) -> float:
    return float((result.get("cost") or {}).get("actualUsd") or 0.0)


def _group_from_record(rec: dict) -> dict:
    """Project one UIRecord back onto the post-split group it was built from.

    Only fields that exist BEFORE `classify` are carried. `verdict`, `route`, `cde`, `candidates`,
    `transforms` and `gencde` are all products of the assign stage and are dropped: a group that carried
    them would be describing a state the Gate 1 boundary has not reached.
    """
    members = list(rec.get("members") or [])
    return {
        "groupId": rec.get("groupId") or rec.get("id") or "",
        "clusterId": rec.get("clusterId") or "",
        "concept": rec.get("concept") or "",
        "conceptIsGenerated": True,
        "idealCde": rec.get("idealCde") or "",
        "nMembers": int(rec.get("nMembers") or len(members)),
        "cohorts": list(rec.get("cohorts") or []),
        "crossCohort": bool(rec.get("crossCohort")),
        "top1Cos": (rec.get("cosines") or {}).get("top1"),
        "memberVariableNames": members[:MEMBER_CAP],
        "membersTruncated": len(members) > MEMBER_CAP,
        # The source demo ran with NO coherence judge injected (that is what 08-09 fixes), so every group
        # here is genuinely UNJUDGED. Stamping `single` to make the fixture look complete would be the
        # exact "unjudged reads as clean" failure the four-state cell exists to prevent — the fixture says
        # not_judged because that is the truth about the run it was derived from.
        "coherence": rec.get("coherence") or "not_judged",
        "coherenceSummary": rec.get("coherenceSummary") or "",
        "coherenceAxis": rec.get("coherenceAxis") or "",
        "coherenceDistinctValues": list(rec.get("coherenceDistinctValues") or []),
        "coherenceOutliers": list(rec.get("coherenceOutliers") or []),
        "incoherent": bool(rec.get("incoherent")),
        "matrixSuspect": bool(rec.get("matrixSuspect")),
    }


#: Column roles for the per-cohort CSV reconstructed from the demo's ``fieldIndex``. Named here so the
#: reconstruction and the load agree in one place.
_RECONSTRUCTED_COLUMNS = ("variable_name", "description", "question_text", "value_encoding", "data_type")


def _preprocessing(result: dict) -> list[dict]:
    """A REAL, MEASURED preparation report per cohort — Gate 0's data source.

    WHY IT IS COMPUTED RATHER THAN WRITTEN. Gate 0 (08-14) renders ``result.preprocessing``, and the demo
    this fixture derives from predates preprocessing entirely (it is the run 08-09 invalidated), so the
    source carries no report at all. Hand-writing one would put invented per-rule counts and invented
    before/after examples in a committed file with nothing tying them to a real dictionary — the exact
    defect the module docstring above rejects for concept groups.

    So the report is MEASURED instead: the demo's ``fieldIndex`` carries every embedded source field's real
    variable name, description, question text and value encoding, which is enough to reconstruct each
    cohort's dictionary and run core's own ``preprocess_dictionary`` over it through the adapter's
    ``preprocess_for_run``. Every number the screen shows is therefore something the rules actually did to
    real cohort text. It costs $0 and calls no model — preprocessing is local work, which is the whole
    reason Gate 0's own column reads "local".

    WHAT IT IS A REPORT ABOUT, precisely: the demo run's own corpus, which is a per-cohort sample rather
    than each cohort's full published dictionary. That is the corpus every other figure in this fixture
    describes, so the counts are consistent with the rest of the file; they are NOT a claim about the full
    cohort.

    Returns ``[]`` when core is not importable, so building the fixture never hard-fails on an environment
    that cannot preprocess — the screen's own "not run" state then tells the truth about the file.
    """
    field_index: dict = result.get("fieldIndex") or {}
    if not field_index:
        return []
    try:
        sys.path.insert(0, str(REPO))
        from ddharmon.ingestion import load_dictionary  # noqa: PLC0415

        from backend.engine.adapter import preprocess_for_run  # noqa: PLC0415
    except ImportError as exc:
        print(f"  ! no preparation report: {exc}")
        return []

    by_cohort: dict[str, list[tuple[str, dict]]] = {}
    for key, detail in field_index.items():
        cohort, _, variable = str(key).partition(":")
        by_cohort.setdefault(cohort, []).append((variable or str(key), detail))

    reports: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        for cohort, rows in sorted(by_cohort.items()):
            path = Path(tmp) / f"{cohort}.csv"
            with open(path, "w", newline="", encoding="utf-8") as fh:
                writer = csv.writer(fh)
                writer.writerow(_RECONSTRUCTED_COLUMNS)
                for variable, detail in rows:
                    writer.writerow(
                        [
                            variable,
                            detail.get("text") or "",
                            detail.get("questionText") or "",
                            detail.get("valueEncoding") or "",
                            detail.get("dataType") or "",
                        ]
                    )
            dd = load_dictionary(
                path,
                cohort_name=cohort,
                variable_name="variable_name",
                description="description",
                question_text="question_text",
                value_encoding="value_encoding",
                data_type="data_type",
            )
            report = preprocess_for_run(dd, source_path=path)
            reports.append(dict(report))
            fired = sum(1 for r in report["rules"] if r["outcome"] == "changed")
            print(f"  {cohort}: {report['nVariables']} variables, {fired} rules fired")
    return reports


def main() -> int:
    source = json.loads(SOURCE.read_text())
    result = source["result"]
    records = result.get("records") or []
    groups = [_group_from_record(r) for r in records]
    groups.sort(key=lambda g: (-g["nMembers"], g["clusterId"], g["groupId"]))
    groups = groups[:GROUP_CAP]
    cost = _realized(result)

    fixture = {
        "jobId": "demo-staged-gate1",
        "displayName": "Demo · paused at Gate 1",
        "status": "awaiting_review",
        "phase": "awaiting_review",
        "completed": 0,
        "total": 0,
        "errorMessage": None,
        "config": {**(source.get("config") or {}), "demo": True},
        "decisions": {},
        "createdAt": source.get("createdAt", 0),
        "updatedAt": source.get("updatedAt", 0),
        "gatePosition": "gate1",
        "resultVersion": 1,
        "costSoFar": cost,
        "result": {
            "contractVersion": "5",
            "mode": result.get("mode", "batch"),
            "phases": result.get("phases", []),
            # A run paused BEFORE `classify` has produced no records. Emitting the demo's records here
            # would show a finished run wearing a Gate 1 label.
            "records": [],
            "summary": {
                "nRecords": 0,
                "counts": {},
                "nCrossCohort": 0,
                "nAssigned": 0,
                "nGencdeResidual": 0,
                "nWithTransforms": 0,
                "cohorts": (result.get("summary") or {}).get("cohorts", []),
            },
            "prompts": result.get("prompts", {}),
            "atlas": [],
            "fieldIndex": {},
            "unassignedFields": [],
            "cost": result.get("cost"),
            "conceptGroups": groups,
            # Gate 0's data source. Measured, not written — see `_preprocessing`.
            "preprocessing": _preprocessing(result),
            "gatePosition": "gate1",
            "resultVersion": 1,
        },
    }
    OUT.write_text(json.dumps(fixture))
    n_reports = len(fixture["result"]["preprocessing"])
    print(
        f"wrote {OUT.relative_to(REPO)} ({len(groups)} concept groups, "
        f"{n_reports} preparation reports, realized {cost})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
