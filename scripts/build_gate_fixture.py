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

THE COHERENCE VERDICTS ARE JOINED IN, NOT INVENTED. The shipped demo result was produced by a run with
no coherence judge injected, so every group in it is genuinely unjudged — which made three of the four
states unreachable and left Gate 1's flag ordering, amber spine and carve proposal with nothing real to
render against. The judge WAS run over that same demo corpus, separately, and its output is on disk at
``harmonization_artifacts_coherence_ab/demo_judge_aireadi_aou_clsa_mesa_ukbb/records_coherence.json`` in
the research repo: 485 groups, joining 485/485 by ``group_id`` with identical concept text. So the verdicts
here are a real judge's real verdicts on the very groups the fixture carries. When that artifact is not
reachable (it is internal and gitignored), every group falls back to ``not_judged`` — which is the older
fixture's behaviour and is still the truth about a run with no judge.

``matrixSuspect`` is likewise COMPUTED rather than written: core's ``_matrix_suspect`` is the $0
deterministic frequent-template detector the pipeline itself stamps, and it is run here over the same
member texts. Absent core, it is false everywhere.

The fixture is deliberately NOT added to ``jobs.json``: it is a route fixture, not a run in anyone's
history, and adding it would change the ``/jobs`` visual baseline for no reason.
"""

from __future__ import annotations

import csv
import json
import sys
import tempfile
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "frontend" / "public" / "static-data"
SOURCE = STATIC / "result-demo-aireadi_aou_clsa_mesa_ukbb.json"
OUT = STATIC / "result-demo-staged-gate1.json"

#: The judge's verdicts on this same demo corpus. INTERNAL and gitignored, hence a sibling-repo path and a
#: graceful absence: a checkout without it still builds a valid (fully unjudged) fixture.
COHERENCE = (
    REPO.parent
    / "ph-arpa-data-harmonization"
    / "harmonization_artifacts_coherence_ab"
    / "demo_judge_aireadi_aou_clsa_mesa_ukbb"
    / "records_coherence.json"
)

#: How many UNJUDGED groups ride along, largest first. Every JUDGED group is carried unconditionally (there
#: are 26 and they are the only source of three of the four coherence states); this caps the tail. The real
#: demo has hundreds, and a full-page baseline of all of them would be an 8000px capture whose only content
#: is repetition — the walk asserts counts, order and identity, not a scroll length.
UNJUDGED_CAP = 24

#: How many single-member groups are carried on purpose. A one-variable group must still render as a row
#: and still be draggable rather than being collapsed away as noise (UI-SPEC §0.1), and the demo's largest
#: groups would never exercise it — 380 of its 535 groups have exactly one member.
SINGLE_MEMBER_CAP = 4

#: Members carried on a collapsed group row — mirrors ``adapter._GROUP_MEMBER_CAP``. ``nMembers`` stays the
#: true count and ``membersTruncated`` says which this list is.
MEMBER_CAP = 25


#: What reaching Gate 1 cost on this fixture. Taken from the source run's realized cost so the number on
#: screen is a real one; the demo is a $0 replay, so a zero here is honest rather than a placeholder.
def _realized(result: dict) -> float:
    return float((result.get("cost") or {}).get("actualUsd") or 0.0)


def _group_from_record(rec: dict, judged: dict | None = None, matrix_suspect: bool = False) -> dict:
    """Project one UIRecord back onto the post-split group it was built from.

    Only fields that exist BEFORE `classify` are carried. `verdict`, `route`, `cde`, `candidates`,
    `transforms` and `gencde` are all products of the assign stage and are dropped: a group that carried
    them would be describing a state the Gate 1 boundary has not reached.

    `judged` is this group's row from the coherence artifact, when one was found. Its verdict, axis,
    distinct values and summary are copied verbatim — this function never derives a verdict and never
    upgrades a blank one to `single`, which is the "unjudged reads as clean" failure the four-state cell
    exists to prevent.
    """
    members = list(rec.get("members") or [])
    judged = judged or {}
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
        # From the JOINED judge artifact when this group was scored, and `not_judged` otherwise. The blank
        # `coherence_verdict` core writes for an unscored group is carried through as `not_judged` rather
        # than upgraded to `single`: the judge's silence is not its approval.
        "coherence": judged.get("coherence_verdict") or rec.get("coherence") or "not_judged",
        "coherenceSummary": judged.get("coherence_summary") or rec.get("coherenceSummary") or "",
        "coherenceAxis": judged.get("coherence_axis") or rec.get("coherenceAxis") or "",
        "coherenceDistinctValues": list(
            judged.get("coherence_distinct_values") or rec.get("coherenceDistinctValues") or []
        ),
        "coherenceOutliers": list(rec.get("coherenceOutliers") or []),
        "incoherent": bool(judged.get("incoherent", rec.get("incoherent"))),
        # The $0 deterministic detector, actually run — see `_matrix_suspects`.
        "matrixSuspect": bool(matrix_suspect),
    }


def _coherence_by_group() -> dict[str, dict]:
    """The judge's rows for this demo corpus, keyed by group id — or ``{}`` when the artifact is absent.

    ABSENCE IS NOT AN ERROR. The artifact is internal and gitignored, so a checkout that does not have the
    research repo beside it still builds a fixture; every group simply stays ``not_judged``, which is a
    true description of a run with no judge rather than a placeholder.
    """
    if not COHERENCE.exists():
        print(f"  ! no coherence artifact at {COHERENCE} — every group will render as not judged")
        return {}
    rows = json.loads(COHERENCE.read_text())
    by_group = {str(r.get("group_id") or ""): r for r in rows if r.get("group_id")}
    scored = sum(1 for r in by_group.values() if r.get("coherence_verdict"))
    print(f"  coherence: {len(by_group)} groups on file, {scored} scored by the judge")
    return by_group


def _matrix_suspects(records: list[dict], field_index: dict) -> dict[str, bool]:
    """Run core's $0 §29.1 template detector over each group's member texts.

    THE SAME FUNCTION THE PIPELINE STAMPS WITH, not a re-implementation — `matrixSuspect` is a claim about
    what core's detector says, so a second detector here could disagree with the product and the fixture
    would be asserting a behaviour the app does not have. It fires from 2 members up, which is exactly the
    range the coherence judge skips, and that complementarity is the whole reason Gate 1 renders it.

    Returns ``{}`` when core is not importable, so the fixture still builds.
    """
    try:
        sys.path.insert(0, str(REPO))
        from ddharmon.harmonization.leanb import _matrix_suspect  # noqa: PLC0415
    except ImportError as exc:
        print(f"  ! no template-suspicion flags: {exc}")
        return {}
    flags: dict[str, bool] = {}
    for rec in records:
        texts = [
            (field_index.get(m) or {}).get("text") or (field_index.get(m) or {}).get("description") or ""
            for m in (rec.get("members") or [])
        ]
        flags[str(rec.get("groupId") or "")] = bool(_matrix_suspect(texts))
    print(f"  template suspicion: {sum(flags.values())} of {len(flags)} groups")
    return flags


def _select(records: list[dict], coherence: dict[str, dict]) -> list[dict]:
    """Which groups the fixture carries, and why each cohort of them is here.

    DETERMINISTIC AND STATED, rather than "the biggest N". Three slices, in order:

      1. **Every group the judge SCORED.** They are the only source of `split`, `qualify` and `single`, so
         dropping any would make a state of the four-state cell unreachable and leave the flag ordering,
         the amber spine and the carve proposal with nothing real to render against.
      2. **The largest UNJUDGED groups**, up to `UNJUDGED_CAP` — the not-judged state at realistic sizes,
         and the rows the $0 template detector covers where the judge does not.
      3. **A few one-member groups.** A single-variable group must still render as a row and still be
         draggable; the demo's largest groups would never exercise that, and 380 of its 535 groups are
         exactly this size.

    Sorted by (-nMembers, clusterId, groupId) inside each slice so a rebuild produces the same file.
    """

    def order(rec: dict) -> tuple:
        return (-len(rec.get("members") or []), str(rec.get("clusterId") or ""), str(rec.get("groupId") or ""))

    def is_judged(rec: dict) -> bool:
        return bool((coherence.get(str(rec.get("groupId") or "")) or {}).get("coherence_verdict"))

    judged = sorted((r for r in records if is_judged(r)), key=order)
    rest = sorted((r for r in records if not is_judged(r)), key=order)
    unjudged = [r for r in rest if len(r.get("members") or []) > 1][:UNJUDGED_CAP]
    singles = [r for r in rest if len(r.get("members") or []) == 1][:SINGLE_MEMBER_CAP]
    print(f"  selected {len(judged)} judged + {len(unjudged)} unjudged + {len(singles)} single-member")
    return judged + unjudged + singles


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
    field_index: dict = result.get("fieldIndex") or {}
    coherence = _coherence_by_group()
    suspects = _matrix_suspects(records, field_index)

    selected = _select(records, coherence)
    groups = [
        _group_from_record(
            rec,
            judged=coherence.get(str(rec.get("groupId") or "")),
            matrix_suspect=suspects.get(str(rec.get("groupId") or ""), False),
        )
        for rec in selected
    ]

    # The UNCAPPED membership per group — the expanded row's source, and the one a regroup writes back
    # against. Emitted for every carried group even where it equals the collapsed sample, so the read path
    # is exercised rather than accidentally satisfied by the capped list.
    group_members = {
        str(rec.get("groupId") or ""): list(rec.get("members") or []) for rec in selected
    }
    # `fieldIndex` restricted to the members actually carried: the raw dictionary rows behind a group, which
    # the expanded row renders as its evidence layer. The full demo index is 1000 entries and most of them
    # belong to groups this fixture does not carry.
    carried_members = {m for members in group_members.values() for m in members}
    carried_index = {k: v for k, v in field_index.items() if k in carried_members}

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
            "fieldIndex": carried_index,
            "unassignedFields": [],
            "cost": result.get("cost"),
            "conceptGroups": groups,
            "conceptGroupMembers": group_members,
            # Gate 0's data source. Measured, not written — see `_preprocessing`.
            "preprocessing": _preprocessing(result),
            "gatePosition": "gate1",
            "resultVersion": 1,
        },
    }
    OUT.write_text(json.dumps(fixture))
    n_reports = len(fixture["result"]["preprocessing"])
    verdicts = Counter(g["coherence"] for g in groups)
    print(
        f"wrote {OUT.relative_to(REPO)} ({len(groups)} concept groups "
        f"({sum(1 for g in groups if g['crossCohort'])} cross-cohort), "
        f"{dict(verdicts)}, {len(carried_index)} field rows, "
        f"{n_reports} preparation reports, realized {cost})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
