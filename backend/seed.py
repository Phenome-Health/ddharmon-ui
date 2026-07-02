"""Seed the in-memory job store with a couple of SAMPLE completed runs (dev/testing only).

Pre-v3 the real pipeline isn't wired for local runs, but we still want to exercise the results,
workbench, visualization, and export UI. This builds synthetic-but-realistic ``UIResult`` snapshots
(clearly labelled "Sample —") and hydrates completed jobs from them. Enabled only when the env var
``DDHARMON_UI_SEED`` is truthy, so production never shows fabricated runs.

The shapes here mirror ``backend.engine.contract`` exactly (that's the whole point — they must render).
"""

from __future__ import annotations

import math
import uuid
from typing import Any

from backend.jobs import JobStore

COHORTS3 = ["AoU", "CLSA", "UKBB"]
COHORTS2 = ["AoU", "CLSA"]


def _cand(rank: int, cid: str, ext: str, defn: str, cos: float, chosen: bool, llm: bool = False) -> dict[str, Any]:
    return {
        "rank": rank,
        "cdeId": cid,
        "cdeExternalId": ext,
        "definition": defn,
        "cosine": round(cos, 3),
        "isChosen": chosen,
        "llmSuggested": llm,
    }


def _t_cat(
    src: str, cde: str, code_map: dict[str, str], unmapped: list[str] | None = None, conf: float = 0.9
) -> dict[str, Any]:
    return {
        "sourceVariable": src, "targetCdeId": cde, "kind": "categorical", "confidence": conf,
        "coverage": round(len(code_map) / (len(code_map) + len(unmapped or [])), 2) if code_map else 0.0,
        "needsUnits": False, "needsData": False, "needsReview": bool(unmapped),
        "rationale": "Mapped source response codes to the CDE's permissible values.",
        "generatedBy": "llm", "codeMap": code_map, "unmappedSourceCodes": unmapped or [],
    }  # fmt: skip


def _t_unit(src: str, cde: str, factor: float, offset: float, su: str, tu: str) -> dict[str, Any]:
    return {
        "sourceVariable": src, "targetCdeId": cde, "kind": "unit", "confidence": 0.95, "coverage": 1.0,
        "needsUnits": False, "needsData": False, "needsReview": False,
        "rationale": f"Linear unit conversion {su} → {tu}.", "generatedBy": "rule",
        "factor": factor, "offset": offset, "sourceUnit": su, "targetUnit": tu,
    }  # fmt: skip


def _t_arith(src: str, cde: str, formula: str, inputs: list[str]) -> dict[str, Any]:
    return {
        "sourceVariable": src, "targetCdeId": cde, "kind": "arithmetic", "confidence": 0.6, "coverage": 1.0,
        "needsUnits": False, "needsData": False, "needsReview": True,
        "rationale": "Derived quantity — verify formula before applying.", "generatedBy": "llm",
        "formula": formula, "inputs": inputs,
    }  # fmt: skip


def _t_ident(src: str, cde: str) -> dict[str, Any]:
    return {
        "sourceVariable": src, "targetCdeId": cde, "kind": "identity", "confidence": 0.98, "coverage": 1.0,
        "needsUnits": False, "needsData": False, "needsReview": False,
        "rationale": "Values already align with the CDE.", "generatedBy": "rule",
    }  # fmt: skip


def _rec(
    n: int,
    concept: str,
    verdict: str,
    cohorts: list[str],
    members: list[str],
    cde: tuple[str, str] | None,
    top1: float,
    chosen: float | None,
    transforms: list[dict[str, Any]] | None = None,
    candidates: list[dict[str, Any]] | None = None,
    coverage_gap: bool = False,
    floored: bool = False,
    rationale: str = "",
    decided_by: str = "llm",
) -> dict[str, Any]:
    gid = f"g{n}"
    route = "assigned" if cde else "gencde_residual"
    return {
        "id": gid,
        "clusterId": f"c{n}",
        "groupId": gid,
        "concept": concept,
        "verdict": verdict,
        "route": route,
        "cde": {"id": cde[0], "externalId": cde[1]} if cde else None,
        "idealCde": concept,
        "cosines": {"top1": top1, "chosen": chosen},
        "coverageGap": coverage_gap,
        "floored": floored,
        "crossCohort": len(cohorts) > 1,
        "nMembers": len(members),
        "cohorts": cohorts,
        "members": members,
        "transforms": transforms or [],
        "candidates": candidates or [],
        "rationale": rationale or (f"Assigned to {cde[0]}." if cde else "No adequate CDE match; proposed as novel."),
        "decidedBy": decided_by,
    }


def _atlas(cohorts: list[str], per: int = 14) -> list[dict[str, Any]]:
    """Deterministic 2D scatter per cohort (no RNG — stable across restarts)."""
    pts: list[dict[str, Any]] = []
    for ci, cohort in enumerate(cohorts):
        cx, cy = math.cos(ci * 2.1) * 3, math.sin(ci * 2.1) * 3
        for i in range(per):
            a = i * 0.7 + ci
            pts.append({
                "cohort": cohort, "variable": f"{cohort}:v{i}",
                "x": round(cx + math.cos(a) * (1 + (i % 5) * 0.25), 3),
                "y": round(cy + math.sin(a * 1.3) * (1 + (i % 4) * 0.3), 3),
            })  # fmt: skip
    return pts


def _summary(records: list[dict[str, Any]], cohorts: list[str]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for r in records:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    return {
        "nRecords": len(records),
        "counts": counts,
        "nCrossCohort": sum(1 for r in records if r["crossCohort"]),
        "nAssigned": sum(1 for r in records if r["route"] == "assigned"),
        "nGencdeResidual": sum(1 for r in records if r["route"] == "gencde_residual"),
        "nWithTransforms": sum(1 for r in records if r["transforms"]),
        "cohorts": cohorts,
    }


def _result(records: list[dict[str, Any]], cohorts: list[str], mode: str) -> dict[str, Any]:
    return {
        "contractVersion": "1",
        "mode": mode,
        "phases": ["loading", "embedding", "clustering", "generating", "splitting", "assigning", "specs"],
        "records": records,
        "summary": _summary(records, cohorts),
        "prompts": {
            "ideal": len(records),
            "split": max(1, len(records) // 3),
            "groupAssign": len(records),
            "specgen": sum(len(r["transforms"]) for r in records),
        },
        "atlas": _atlas(cohorts),
    }


def _run_three() -> dict[str, Any]:
    recs = [
        _rec(
            1,
            "Biological sex",
            "adopt",
            COHORTS3,
            ["AoU:SEX", "CLSA:SEX_ASK_TRM", "UKBB:31"],
            ("Sex Assigned At Birth", "C46109"),
            0.94,
            0.94,
            transforms=[
                _t_cat("AoU:SEX", "Sex Assigned At Birth", {"1": "Male", "2": "Female"}),
                _t_cat("CLSA:SEX_ASK_TRM", "Sex Assigned At Birth", {"M": "Male", "F": "Female"}),
                _t_ident("UKBB:31", "Sex Assigned At Birth"),
            ],
            candidates=[
                _cand(1, "Sex Assigned At Birth", "C46109", "The sex of an individual at birth.", 0.94, True),
                _cand(2, "Gender Identity", "C17357", "A person's self-identified gender.", 0.71, False, True),
                _cand(3, "Biological Sex", "C45908", "Biological classification.", 0.68, False),
            ],
        ),
        _rec(
            2,
            "Age at enrollment",
            "adopt",
            COHORTS3,
            ["AoU:AGE", "CLSA:AGE_NMBR_TRM", "UKBB:21003"],
            ("Age At Enrollment (years)", "C25150"),
            0.9,
            0.9,
            transforms=[
                _t_ident("AoU:AGE", "Age At Enrollment (years)"),
                _t_ident("CLSA:AGE_NMBR_TRM", "Age At Enrollment (years)"),
            ],
            candidates=[
                _cand(1, "Age At Enrollment (years)", "C25150", "Participant age at enrollment.", 0.9, True),
                _cand(2, "Age At Diagnosis", "C156420", "Age when a condition was diagnosed.", 0.66, False),
            ],
        ),
        _rec(
            3,
            "Current smoking status",
            "refine",
            COHORTS3,
            ["AoU:smoking_100", "CLSA:SMK_CURR_TRM", "UKBB:20116"],
            ("Cigarette Smoking Status", "C67147"),
            0.81,
            0.79,
            transforms=[
                _t_cat("AoU:smoking_100", "Cigarette Smoking Status", {"1": "Current", "0": "Never"}, unmapped=["9"]),
                _t_cat(
                    "UKBB:20116",
                    "Cigarette Smoking Status",
                    {"0": "Never", "1": "Former", "2": "Current"},
                    unmapped=["-3"],
                ),
            ],
            candidates=[
                _cand(1, "Cigarette Smoking Status", "C67147", "Current cigarette smoking status.", 0.81, True),
                _cand(2, "Tobacco Use History", "C19796", "History of tobacco use.", 0.74, False, True),
                _cand(3, "Pack Years Smoked", "C73993", "Cumulative smoking exposure.", 0.6, False),
            ],
            rationale="Refine: source codes recode onto the CDE's Never/Former/Current values.",
        ),
        _rec(
            4,
            "Systolic blood pressure",
            "refine",
            COHORTS3,
            ["AoU:sbp", "CLSA:BP_SYS_TRM", "UKBB:4080"],
            ("Systolic Blood Pressure (mmHg)", "C25298"),
            0.86,
            0.85,
            transforms=[
                _t_ident("AoU:sbp", "Systolic Blood Pressure (mmHg)"),
                _t_unit("CLSA:BP_SYS_TRM", "Systolic Blood Pressure (mmHg)", 7.50062, 0.0, "kPa", "mmHg"),
            ],
            candidates=[
                _cand(1, "Systolic Blood Pressure (mmHg)", "C25298", "Systolic arterial pressure.", 0.86, True),
                _cand(2, "Diastolic Blood Pressure (mmHg)", "C25299", "Diastolic arterial pressure.", 0.7, False),
            ],
        ),
        _rec(
            5,
            "Body mass index",
            "refine",
            ["CLSA", "UKBB"],
            ["CLSA:BMI_TRM", "UKBB:21001"],
            ("Body Mass Index (kg/m2)", "C16358"),
            0.83,
            0.82,
            transforms=[
                _t_ident("UKBB:21001", "Body Mass Index (kg/m2)"),
                _t_arith(
                    "CLSA:BMI_TRM", "Body Mass Index (kg/m2)", "weight_kg / (height_m ** 2)", ["weight_kg", "height_m"]
                ),
            ],
            candidates=[
                _cand(1, "Body Mass Index (kg/m2)", "C16358", "Weight relative to height.", 0.83, True),
                _cand(2, "Body Weight (kg)", "C81328", "Measured body weight.", 0.64, False),
            ],
        ),
        _rec(
            6,
            "Highest level of education",
            "refine",
            COHORTS3,
            ["AoU:education", "CLSA:ED_HIGH_TRM", "UKBB:6138"],
            ("Educational Attainment", "C17953"),
            0.77,
            0.74,
            floored=False,
            transforms=[
                _t_cat(
                    "AoU:education",
                    "Educational Attainment",
                    {"1": "Less than high school", "2": "High school", "3": "College+"},
                    unmapped=["7", "9"],
                )
            ],
            candidates=[
                _cand(1, "Educational Attainment", "C17953", "Highest education completed.", 0.77, True),
                _cand(2, "Employment Status", "C25150b", "Current employment.", 0.55, False),
            ],
            rationale="Refine: cohort education levels recode onto the CDE's tiers; 2 codes unmapped.",
        ),
        _rec(
            7,
            "Household income",
            "adopt",
            ["AoU", "UKBB"],
            ["AoU:income", "UKBB:738"],
            ("Annual Household Income", "C156420b"),
            0.8,
            0.8,
            transforms=[_t_cat("AoU:income", "Annual Household Income", {"1": "<25k", "2": "25-50k", "3": ">50k"})],
            candidates=[_cand(1, "Annual Household Income", "C156420b", "Total household income.", 0.8, True)],
        ),
        _rec(
            8,
            "Depression severity (PHQ-9 total)",
            "novel",
            ["AoU"],
            ["AoU:phq9_total"],
            None,
            0.58,
            None,
            coverage_gap=True,
            candidates=[
                _cand(1, "Patient Health Questionnaire Score", "C177637", "PHQ summary score.", 0.58, False),
                _cand(2, "Depression Screen", "C0000d", "Depression screening result.", 0.55, False, True),
            ],
            rationale="No CDE covers a PHQ-9 total at this granularity (top-1 0.58 < τ) — proposed as a novel GenCDE.",
        ),
        _rec(
            9,
            "Sleep duration (hours/night)",
            "adopt",
            ["CLSA", "UKBB"],
            ["CLSA:SLE_DUR_TRM", "UKBB:1160"],
            ("Sleep Duration (hours)", "C0009s"),
            0.82,
            0.82,
            transforms=[_t_unit("CLSA:SLE_DUR_TRM", "Sleep Duration (hours)", 0.0166667, 0.0, "minutes", "hours")],
            candidates=[_cand(1, "Sleep Duration (hours)", "C0009s", "Typical nightly sleep duration.", 0.82, True)],
        ),
        _rec(
            10,
            "Alcohol intake frequency",
            "refine",
            COHORTS3,
            ["AoU:alcohol_freq", "CLSA:ALC_FREQ_TRM", "UKBB:1558"],
            ("Alcohol Drinking Frequency", "C0001a"),
            0.78,
            0.76,
            transforms=[
                _t_cat(
                    "AoU:alcohol_freq",
                    "Alcohol Drinking Frequency",
                    {"1": "Never", "2": "Monthly", "3": "Weekly", "4": "Daily"},
                    unmapped=["0"],
                )
            ],
            candidates=[
                _cand(1, "Alcohol Drinking Frequency", "C0001a", "How often alcohol is consumed.", 0.78, True),
                _cand(2, "Alcohol Use Disorder", "C0002a", "Clinical alcohol use disorder.", 0.61, False),
            ],
        ),
        _rec(
            11,
            "Race / ethnicity",
            "refine",
            COHORTS3,
            ["AoU:race", "CLSA:ETH_GRP_TRM", "UKBB:21000"],
            ("Race Category", "C17049"),
            0.73,
            0.71,
            floored=True,
            transforms=[
                _t_cat(
                    "AoU:race",
                    "Race Category",
                    {"1": "White", "2": "Black", "3": "Asian", "4": "Other"},
                    unmapped=["7", "9"],
                )
            ],
            candidates=[
                _cand(1, "Race Category", "C17049", "Self-reported race.", 0.73, True),
                _cand(2, "Ethnic Group", "C16564", "Self-reported ethnicity.", 0.72, False, True),
            ],
            rationale="Refine (floored): retrieval floor pulled this back from adopt — reviewer should confirm race vs ethnicity.",
        ),
        _rec(
            12,
            "Physical activity (MET-min/week)",
            "novel",
            ["UKBB"],
            ["UKBB:22040"],
            None,
            0.54,
            None,
            coverage_gap=True,
            candidates=[_cand(1, "Physical Activity Level", "C0003p", "General activity level.", 0.54, False)],
            rationale="No CDE captures summed MET-minutes/week — proposed as novel.",
        ),
        _rec(
            13,
            "Marital status",
            "adopt",
            COHORTS3,
            ["AoU:marital", "CLSA:MAR_STAT_TRM", "UKBB:6141"],
            ("Marital Status", "C25188"),
            0.84,
            0.84,
            transforms=[
                _t_cat(
                    "AoU:marital", "Marital Status", {"1": "Married", "2": "Divorced", "3": "Single", "4": "Widowed"}
                )
            ],
            candidates=[_cand(1, "Marital Status", "C25188", "Legal marital status.", 0.84, True)],
        ),
        _rec(
            14,
            "Waist circumference (cm)",
            "adopt",
            ["CLSA", "UKBB"],
            ["CLSA:WST_CIR_TRM", "UKBB:48"],
            ("Waist Circumference (cm)", "C100947"),
            0.8,
            0.8,
            transforms=[
                _t_ident("CLSA:WST_CIR_TRM", "Waist Circumference (cm)"),
                _t_ident("UKBB:48", "Waist Circumference (cm)"),
            ],
            candidates=[_cand(1, "Waist Circumference (cm)", "C100947", "Abdominal circumference.", 0.8, True)],
        ),
        _rec(
            15,
            "General self-rated health",
            "adopt",
            COHORTS3,
            ["AoU:general_health", "CLSA:GEN_HLTH_TRM", "UKBB:2178"],
            ("General Health Rating", "C0004g"),
            0.86,
            0.86,
            transforms=[
                _t_cat(
                    "AoU:general_health",
                    "General Health Rating",
                    {"1": "Excellent", "2": "Good", "3": "Fair", "4": "Poor"},
                )
            ],
            candidates=[_cand(1, "General Health Rating", "C0004g", "Self-rated overall health.", 0.86, True)],
        ),
    ]
    return _result(recs, COHORTS3, "batch")


def _run_two() -> dict[str, Any]:
    recs = [
        _rec(
            1,
            "Biological sex",
            "adopt",
            COHORTS2,
            ["AoU:SEX", "CLSA:SEX_ASK_TRM"],
            ("Sex Assigned At Birth", "C46109"),
            0.93,
            0.93,
            transforms=[
                _t_cat("AoU:SEX", "Sex Assigned At Birth", {"1": "Male", "2": "Female"}),
                _t_cat("CLSA:SEX_ASK_TRM", "Sex Assigned At Birth", {"M": "Male", "F": "Female"}),
            ],
            candidates=[_cand(1, "Sex Assigned At Birth", "C46109", "The sex of an individual at birth.", 0.93, True)],
        ),
        _rec(
            2,
            "Age at enrollment",
            "adopt",
            COHORTS2,
            ["AoU:AGE", "CLSA:AGE_NMBR_TRM"],
            ("Age At Enrollment (years)", "C25150"),
            0.89,
            0.89,
            transforms=[_t_ident("AoU:AGE", "Age At Enrollment (years)")],
            candidates=[_cand(1, "Age At Enrollment (years)", "C25150", "Participant age at enrollment.", 0.89, True)],
        ),
        _rec(
            3,
            "Diastolic blood pressure",
            "refine",
            COHORTS2,
            ["AoU:dbp", "CLSA:BP_DIA_TRM"],
            ("Diastolic Blood Pressure (mmHg)", "C25299"),
            0.84,
            0.82,
            transforms=[_t_unit("CLSA:BP_DIA_TRM", "Diastolic Blood Pressure (mmHg)", 7.50062, 0.0, "kPa", "mmHg")],
            candidates=[
                _cand(1, "Diastolic Blood Pressure (mmHg)", "C25299", "Diastolic arterial pressure.", 0.84, True)
            ],
        ),
        _rec(
            4,
            "Diabetes diagnosis",
            "refine",
            COHORTS2,
            ["AoU:diabetes", "CLSA:DIA_DX_TRM"],
            ("Diabetes Mellitus Indicator", "C2985"),
            0.79,
            0.77,
            transforms=[_t_cat("AoU:diabetes", "Diabetes Mellitus Indicator", {"1": "Yes", "0": "No"}, unmapped=["9"])],
            candidates=[
                _cand(1, "Diabetes Mellitus Indicator", "C2985", "Diabetes diagnosis flag.", 0.79, True),
                _cand(2, "Type 2 Diabetes", "C26747", "Type 2 diabetes mellitus.", 0.7, False),
            ],
        ),
        _rec(
            5,
            "Anxiety symptom severity (GAD-7)",
            "novel",
            ["AoU"],
            ["AoU:gad7_total"],
            None,
            0.56,
            None,
            coverage_gap=True,
            candidates=[_cand(1, "Anxiety Screen Score", "C0005a", "Anxiety screening score.", 0.56, False)],
            rationale="No CDE covers a GAD-7 total — proposed as novel.",
        ),
        _rec(
            6,
            "Height (cm)",
            "adopt",
            COHORTS2,
            ["AoU:height", "CLSA:HGT_CM_TRM"],
            ("Standing Height (cm)", "C25347"),
            0.88,
            0.88,
            transforms=[
                _t_ident("AoU:height", "Standing Height (cm)"),
                _t_ident("CLSA:HGT_CM_TRM", "Standing Height (cm)"),
            ],
            candidates=[_cand(1, "Standing Height (cm)", "C25347", "Measured standing height.", 0.88, True)],
        ),
    ]
    return _result(recs, COHORTS2, "sync")


def seed_jobs(store: JobStore) -> list[str]:
    """Insert sample completed jobs into ``store``. Returns the created job ids."""
    seeds = [
        ("Sample — AoU + CLSA + UKBB (cross-cohort)", _run_three()),
        ("Sample — AoU + CLSA (sync)", _run_two()),
    ]
    ids: list[str] = []
    for display, result in seeds:
        job_id = "sample-" + uuid.uuid4().hex[:8]
        store.create(job_id, display, {"sample": True, "mode": result["mode"], "cdeSet": "full"})
        store.update(job_id, status="complete", phase="complete", result=result)
        ids.append(job_id)
    return ids
