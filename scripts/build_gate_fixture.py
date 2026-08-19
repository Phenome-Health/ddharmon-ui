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

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "frontend" / "public" / "static-data"
SOURCE = STATIC / "result-demo-aireadi_aou_clsa_mesa_ukbb.json"
OUT = STATIC / "result-demo-staged-gate1.json"

#: How many groups the fixture carries. The real demo has hundreds; a full-page screenshot baseline of all
#: of them would be an 8000px capture whose only content is repetition, and the walk asserts a count and an
#: identity, not a scroll length.
GROUP_CAP = 12

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
    return {
        "groupId": rec.get("groupId") or rec.get("id") or "",
        "clusterId": rec.get("clusterId") or "",
        "concept": rec.get("concept") or "",
        "idealCde": rec.get("idealCde") or "",
        "nMembers": int(rec.get("nMembers") or len(rec.get("members") or [])),
        "cohorts": list(rec.get("cohorts") or []),
        "crossCohort": bool(rec.get("crossCohort")),
        "top1Cos": (rec.get("cosines") or {}).get("top1"),
        "memberVariableNames": list(rec.get("members") or []),
    }


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
            "gatePosition": "gate1",
            "resultVersion": 1,
        },
    }
    OUT.write_text(json.dumps(fixture))
    print(f"wrote {OUT.relative_to(REPO)} ({len(groups)} concept groups, realized {cost})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
