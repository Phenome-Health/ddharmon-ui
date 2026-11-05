#!/usr/bin/env python3
"""Build the deterministic ~110-variable fixture the staged-review live-verify driver runs on.

    python scripts/build_live_verify_fixture.py --examples-dir <core checkout>/data/examples

Writes ``tests/live/fixture/{aou.csv,clsa.csv,ukbb.csv,manifest.json}`` (hard cap: 140 rows, so a
synchronous paid run stays well under $1). Check how it clusters at $0 with
``scripts/validate_live_verify_fixture.py``; the reference result is ``tests/live/fixture/VALIDATION.md``.

WHAT IT IS FOR. The live-verify loop runs a FRESH small paid run on every iteration and asserts
invariants at every gate (Setup -> Gate 1 -> Gate 2 -> Gate 3 -> Gate 4). A run is only a useful test if
it reliably reaches every code path the gates have, so this fixture is SELECTED for coverage: a
heterogeneous cluster the split stage partitions, adopt / refine / novel verdicts, a units conversion, a
wide->long repeating measure, missing-data codes, many-to-one pairs inside one cohort, a repeated variable
name, ungrouped leftovers, a catalog CDE whose permissible values carry "(e.g., ...)" labels, eye
conditions spread over several groups, and the components of a published score. ``manifest.json`` names
which variables stand for which path (``paths``) so the driver never has to rediscover them.

SELECTED, NEVER REWRITTEN. Every output row is a source row copied verbatim (every column, exact text), in
source-file order, under the source's own header. Selection is an explicit allow-list keyed on each
source's UNIQUE row key — not a random sample — because the public dictionaries repeat their display
names (AoU re-uses an ``Item Concept`` across survey versions, CLSA re-uses a ``name`` across its two
baseline tables, UKBB re-uses ``field_name`` across fields). Keying on the display name would pull in
duplicates silently; this script instead asserts that the output carries exactly ONE repeated
``variable_name``: the pair the fixture includes on purpose (path 7).

SOURCES. The three public dictionaries (All of Us survey codebook, CLSA baseline data dictionary, UK
Biobank Showcase schema) as shipped in the ddharmon core's ``data/examples/`` — pass that directory with
``--examples-dir`` (or ``DDHARMON_EXAMPLES_DIR``), or point at each file with ``--aou`` / ``--clsa`` /
``--ukbb`` (or ``DDHARMON_FIXTURE_{AOU,CLSA,UKBB}``). A smaller upload cut from the same files works too,
as long as it still contains every allow-listed row. The manifest records each source's SHA-256, so a
changed source is visible in the diff.

IDEMPOTENT. Same sources in -> byte-identical files out (no timestamps, no absolute paths, stable order).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "tests" / "live" / "fixture"

# The UKBB Showcase ``description`` column holds whole HTML paragraphs; lift the csv module's 128 KiB cap.
csv.field_size_limit(10_000_000)

# ─── cohorts: source file, unique row key, and the column roles the driver sends ──────────────────────
#
# ``columnRoles`` are exactly the roles the live walk used for these uploads (role -> source header). The
# driver sends them verbatim as the Setup ``columnRoles``; changing one changes what gets embedded.
COHORTS: dict[str, dict] = {
    "aou": {
        "file": "aou.csv",
        "cohortName": "AoU",
        "sourceFile": "all_of_us_surveys.csv",
        "envVar": "DDHARMON_FIXTURE_AOU",
        "key": ("Survey", "Item Concept"),  # Item Concept alone repeats across survey versions
        "columnRoles": {
            "variable_name": "Item Concept",
            "question_text": "Field Label",
            "value_encoding": "Choices, Calculations, OR Slider Labels",
            "data_type": "Field Type",
        },
    },
    "clsa": {
        "file": "clsa.csv",
        "cohortName": "CLSA",
        "sourceFile": "clsa_baseline.csv",
        "envVar": "DDHARMON_FIXTURE_CLSA",
        "key": ("table", "name"),  # name alone repeats across the Tracking / Comprehensive tables
        "columnRoles": {
            "variable_name": "name",
            "short_label": "label:en",
            "question_text": "question:en",
            "description": "comment:en",
            "value_encoding": "value_encoding",
            "units": "unit",
            "data_type": "valueType",
        },
    },
    "ukbb": {
        "file": "ukbb.csv",
        "cohortName": "UKBB",
        "sourceFile": "ukbb_showcase.csv",
        "envVar": "DDHARMON_FIXTURE_UKBB",
        "key": ("field_id",),  # field_name repeats (e.g. two distinct fields are both called "Weight")
        "columnRoles": {
            "variable_name": "field_name",
            "description": "description",
            "value_encoding": "value_encoding",
            "units": "units",
            "data_type": "data_type",
        },
    },
}

PMH = "Personal Medical History"
TRM = "Tracking_Baseline_v4-1"  # CLSA tracking cohort (telephone interview)
COM = "Comprehensive_Baseline_v7-2"  # CLSA comprehensive cohort (in-person) — same question, different row

# ─── the allow-list, grouped by the cluster each row is meant to land in ──────────────────────────────
#
# Each entry is the source's unique key. Comments say what the row is for; the path numbers refer to the
# ``PATHS`` table below (and the manifest). Order here is documentation only — output keeps source order.
ALLOW: dict[str, list[tuple[str, ...]]] = {
    "aou": [
        # Migraine — AoU asks the follow-ups (still seeing a doctor / age first told / treated) that CLSA and
        # UKBB do not; together with their "ever told" items this is one condition, several questions (1).
        (PMH, "nervoussystem_migrainecurrently"),
        (PMH, "nervoussystem_howoldwereyoumigraine"),
        (PMH, "nervoussystem_rxmedsformigraine"),
        # Asthma follow-ups + the respiratory checklist (a multi-select of named conditions -> 9).
        (PMH, "respiratory_respiratoryconditions"),
        (PMH, "respiratory_asthmacurrently"),
        (PMH, "respiratory_howoldwereyouasthma"),
        (PMH, "respiratory_rxmedsforasthma"),
        # Type 2 diabetes follow-ups + the endocrine checklist (9).
        (PMH, "endocrine_endocrineconditions"),
        (PMH, "endocrine_type2diabetescurrently"),
        (PMH, "endocrine_howoldwereyoutype2diabetes"),
        (PMH, "endocrine_rxmedsfortype2diabetes"),
        # Eye conditions (10): the hearing/vision checklist, then glaucoma / cataract / macular degeneration
        # follow-ups — the same conditions CLSA and UKBB ask about with different question shapes.
        (PMH, "hearingvision_hearingvisionconditions"),
        (PMH, "hearingvision_glaucomacurrently"),
        (PMH, "hearingvision_howoldwereyouglaucoma"),
        (PMH, "hearingvision_rxmedsforglaucoma"),
        (PMH, "hearingvision_cataractscurrently"),
        (PMH, "hearingvision_rxmedsforcataracts"),
        (PMH, "hearingvision_maculardegenerationcurrently"),
        # Hearing loss follow-ups + the disability screeners (deaf / blind — blind is another eye item, 10).
        (PMH, "hearingvision_hearinglosscurrently"),
        (PMH, "hearingvision_howoldwereyouhearingloss"),
        (PMH, "hearingvision_rxmedsforhearingloss"),
        ("Basics", "disability_deaf"),
        ("Basics", "disability_blind"),
        # Allergies follow-ups (novel in the reference walk).
        (PMH, "other_allergiescurrently"),
        (PMH, "other_howoldwereyouallergies"),
        (PMH, "other_rxmedsforallergies"),
        # Self-rated health (general / physical / mental): same 5-point scale, distinct concepts (1, 2).
        ("Overall Health", "overallhealth_generalhealth"),
        ("Overall Health", "overallhealth_generalphysicalhealth"),
        ("Overall Health", "overallhealth_generalmentalhealth"),
        ("Overall Health", "overallhealth_emotionalproblem7days"),
        ("Overall Health", "overallhealth_averagefatigue7days"),
        # Leftover candidates (8): "age first told" for conditions nothing else in the fixture mentions — the
        # reference walk's own leftovers. They sit BETWEEN the age items and the condition topics, which is
        # what makes a point HDBSCAN noise (an isolated item is instead pulled into its nearest cluster).
        (PMH, "digestive_howoldwereyouceliacdisease"),
        (PMH, "infectiousdiseases_howoldwereyouchickenpox"),
    ],
    "clsa": [
        # Self-rated health, COM/TRM twins (6) + eyesight/hearing ratings on the same scale (10).
        (TRM, "GEN_HLTH_TRM"),
        (COM, "GEN_HLTH_COM"),
        (TRM, "GEN_MNTL_TRM"),
        (COM, "GEN_MNTL_COM"),
        (TRM, "VIS_SGHT_TRM"),
        (TRM, "HRG_HRG_TRM"),
        # Hearing difficulty / aids (novel in the reference walk).
        (TRM, "HRG_NOIS_TRM"),
        (TRM, "HRG_AID_TRM"),
        # "Has a doctor ever told you that you have X?" — tracking + comprehensive twins (6).
        (TRM, "CCT_DIAB_TRM"),
        (COM, "DIA_DIAB_COM"),
        (TRM, "CCT_MGRN_TRM"),
        (COM, "CCC_MGRN_COM"),
        (TRM, "CCT_ASTHM_TRM"),
        (COM, "CCC_ASTHM_COM"),
        (TRM, "CCT_COPD_TRM"),
        (COM, "CCC_COPD_COM"),
        (TRM, "CCT_ALLRG_TRM"),
        (COM, "CCC_ALLRG_COM"),
        (TRM, "CCT_GLAUC_TRM"),
        (TRM, "CCT_CATAR_TRM"),
        (TRM, "CCT_MACDEG_TRM"),
        (COM, "CCC_MACDEG_COM"),
        # CES-D 10 items, twins (6).
        (TRM, "DEP_BOTR_TRM"),
        (COM, "DEP_BOTR_COM"),
        (TRM, "DEP_FLDP_TRM"),
        (COM, "DEP_FLDP_COM"),
        (TRM, "DEP_LONLY_TRM"),
        # Falls (score component 11), twins (6).
        (TRM, "FAL_NMBR_NB_TRM"),
        (COM, "FAL_NMBR_NB_COM"),
        # Chest pain (score component 11).
        (COM, "ROS_PAIN_COM"),
        # Height (3): metres declared "m", metres with no unit, and an "Average height in m" declared "cm".
        (COM, "SPR_INPUT_HEIGHT_COM"),
        (TRM, "HWT_DHT_M_TRM"),
        (COM, "HGT_HEIGHT_M_COM"),
        # Weight (3): kg declared two ways, and self-reported kg with no unit.
        (COM, "WGT_WEIGHT_KG_COM"),
        (COM, "SPR_INPUT_WEIGHT_COM"),
        (TRM, "HWT_DWT_K_TRM"),
        # Wide->long repeating measure (4): the same medication-name question in numbered slots 1..5.
        (COM, "MEDI_ID_NAME_SP2_1_COM"),
        (COM, "MEDI_ID_NAME_SP2_2_COM"),
        (COM, "MEDI_ID_NAME_SP2_3_COM"),
        (COM, "MEDI_ID_NAME_SP2_4_COM"),
        (COM, "MEDI_ID_NAME_SP2_5_COM"),
    ],
    "ukbb": [
        ("2178",),  # Overall health rating — self-rated health (2 adopt) + frailty-index component (11)
        ("2443",),  # Diabetes diagnosed by doctor (9, 11)
        ("120007",),  # Ever had diabetes (Type I or Type II) — carries -121 / -818 (5, 9)
        ("2976",),  # Age diabetes diagnosed — years (3)
        ("120016",),  # Ever had migraine — -121 / -818 (5); novel in the reference walk (2)
        ("22127",),  # Doctor diagnosed asthma (refine in the reference walk)
        ("22130",),  # Doctor diagnosed COPD (refine in the reference walk)
        ("22126",),  # Doctor diagnosed hayfever or allergic rhinitis (novel in the reference walk)
        ("3786",),  # Age asthma diagnosed — years
        ("6148",),  # Eye problems/disorders — glaucoma / cataract / macular degeneration checklist (10, 11)
        ("4689",),  # Age glaucoma diagnosed (10)
        ("4700",),  # Age cataract diagnosed (10)
        ("5923",),  # Age macular degeneration diagnosed (10)
        ("6119",),  # Which eye(s) affected by glaucoma (10)
        ("5441",),  # Which eye(s) are affected by cataract (10)
        ("2207",),  # Wears glasses or contact lenses (10)
        ("2247",),  # Hearing difficulty/problems (11)
        ("2257",),  # Hearing difficulty/problems with background noise
        ("2050",),  # Frequency of depressed mood in last 2 weeks — -1 / -3 (5)
        ("120105",),  # Feeling down, depressed, or hopeless over the last two weeks — -818 (5)
        ("2080",),  # Frequency of tiredness / lethargy in last 2 weeks (11)
        ("2020",),  # Loneliness, isolation (11)
        ("1970",),  # Nervous feelings (11)
        ("1200",),  # Sleeplessness / insomnia (11)
        ("2296",),  # Falls in the last year (11)
        ("2335",),  # Chest pain or discomfort (11)
        ("2188",),  # Long-standing illness, disability or infirmity (11)
        ("50",),  # Standing height — cm (3)
        ("12144",),  # Height — cm (3)
        ("21002",),  # Weight — Kg (3); FIRST of the two fields named "Weight" (7)
        ("23098",),  # Weight — Kg, impedance; SECOND field named "Weight" -> the repeated name (7)
        ("2463",),  # Fractured/broken bones in last 5 years — frailty component, a leftover in the walk (8, 11)
        # Leftover candidates (8): the walk's childhood-experience leftovers; each carries -818 (5).
        ("20487",),  # Felt hated by family member as a child
        ("20488",),  # Physically abused by family as a child
        ("20489",),  # Felt loved as a child
    ],
}

# ─── path -> the variables that stand for it (cohort key, source key, one-line reason) ─────────────────
#
# Written as source keys so they are checked against the allow-list; the manifest resolves each to its
# ``variable`` (the value the driver sees) and ``memberId`` (``<cohortName>:<variable>`` after core's
# repeated-name disambiguation — the id the pipeline's groups and records use).
PATHS: dict[str, dict] = {
    "heterogeneous_split": {
        "intent": "1. One cluster the split stage partitions into >= 2 concept groups.",
        "variables": [
            ("aou", ("Overall Health", "overallhealth_generalhealth"), "self-rated GENERAL health"),
            ("aou", ("Overall Health", "overallhealth_generalphysicalhealth"), "self-rated PHYSICAL health"),
            ("aou", ("Overall Health", "overallhealth_generalmentalhealth"), "self-rated MENTAL health"),
            ("clsa", (TRM, "GEN_HLTH_TRM"), "self-rated general health (tracking)"),
            ("clsa", (COM, "GEN_HLTH_COM"), "self-rated general health (comprehensive)"),
            ("clsa", (TRM, "GEN_MNTL_TRM"), "self-rated mental health (tracking)"),
            ("clsa", (COM, "GEN_MNTL_COM"), "self-rated mental health (comprehensive)"),
            ("ukbb", ("2178",), "overall health rating"),
        ],
    },
    "verdict_mix": {
        "intent": "2. Groups expected to end adopt, refine and novel (novel -> a GenCDE).",
        "variables": [
            ("aou", ("Overall Health", "overallhealth_generalhealth"), "adopt: Self-Reported Health (walk: adopt)"),
            ("clsa", (TRM, "GEN_HLTH_TRM"), "adopt: Self-Reported Health (walk: adopt)"),
            ("clsa", (COM, "GEN_HLTH_COM"), "adopt: Self-Reported Health (walk: adopt)"),
            ("ukbb", ("2178",), "adopt: Self-Reported Health (walk: adopt)"),
            ("clsa", (TRM, "CCT_ASTHM_TRM"), "refine: Health Conditions - Disease Disorders (walk: refine)"),
            ("clsa", (COM, "CCC_ASTHM_COM"), "refine: Health Conditions - Disease Disorders (walk: refine)"),
            ("ukbb", ("22127",), "refine: Health Conditions - Disease Disorders (walk: refine)"),
            ("clsa", (TRM, "CCT_COPD_TRM"), "refine: Health Conditions - Disease Disorders (walk: refine)"),
            ("clsa", (COM, "CCC_COPD_COM"), "refine: Health Conditions - Disease Disorders (walk: refine)"),
            ("ukbb", ("22130",), "refine: Health Conditions - Disease Disorders (walk: refine)"),
            ("clsa", (TRM, "CCT_MGRN_TRM"), "novel -> GenCDE: ever-told migraine (walk: novel)"),
            ("clsa", (COM, "CCC_MGRN_COM"), "novel -> GenCDE: ever-told migraine (walk: novel)"),
            ("ukbb", ("120016",), "novel -> GenCDE: ever-told migraine (walk: novel)"),
            ("clsa", (TRM, "HRG_NOIS_TRM"), "novel -> GenCDE: hearing difficulty (walk: novel)"),
            ("ukbb", ("2247",), "novel -> GenCDE: hearing difficulty (walk: novel)"),
            ("ukbb", ("2257",), "novel -> GenCDE: hearing difficulty in noise (walk: novel)"),
        ],
    },
    "units_arithmetic": {
        "intent": "3. Numeric variables whose declared units differ (unit / arithmetic transform specs).",
        "variables": [
            ("clsa", (COM, "SPR_INPUT_HEIGHT_COM"), "height declared in m -> a cm target is a x100 unit spec"),
            ("clsa", (TRM, "HWT_DHT_M_TRM"), "height in metres with NO declared unit -> needs-units / arithmetic"),
            ("clsa", (COM, "HGT_HEIGHT_M_COM"), "'Average height in m' but declared cm — a unit/label conflict"),
            ("ukbb", ("50",), "standing height, cm"),
            ("ukbb", ("12144",), "height, cm"),
            ("ukbb", ("21002",), "weight, Kg"),
            ("clsa", (COM, "SPR_INPUT_WEIGHT_COM"), "weight, kg (lower-case spelling)"),
            ("clsa", (TRM, "HWT_DWT_K_TRM"), "self-reported weight in kg with NO declared unit"),
            ("ukbb", ("2976",), "age at diagnosis in years vs the unitless catalog Age CDE"),
        ],
    },
    "wide_to_long": {
        "intent": "4. A repeating measure in numbered columns (positional enumeration -> one wide->long spec).",
        "variables": [
            ("clsa", (COM, f"MEDI_ID_NAME_SP2_{k}_COM"), f"medication name, slot {k} of 5") for k in range(1, 6)
        ],
    },
    "missing_data_codes": {
        "intent": "5. Categorical variables carrying missing-data codes (UKBB -121 / -818 / -1 / -3).",
        "variables": [
            ("ukbb", ("120016",), "-121 Do not know / -818 Prefer not to answer (the walk's edited GenCDE recode)"),
            ("ukbb", ("120007",), "-121 / -818 on a yes/no diabetes item"),
            ("ukbb", ("120105",), "-818 plus negative ordinal codes (-521..-524)"),
            ("ukbb", ("2050",), "-1 Do not know / -3 Prefer not to answer"),
            ("ukbb", ("2443",), "-1 / -3 on a yes/no diabetes item"),
        ],
    },
    "many_to_one_same_cohort": {
        "intent": "6. Two+ CLSA variables (tracking TRM + comprehensive COM twin) that share one target.",
        "variables": [
            ("clsa", (TRM, "GEN_HLTH_TRM"), "self-rated general health", {"pair": "GEN_HLTH"}),
            ("clsa", (COM, "GEN_HLTH_COM"), "self-rated general health", {"pair": "GEN_HLTH"}),
            ("clsa", (TRM, "CCT_MGRN_TRM"), "ever-told migraine", {"pair": "MGRN"}),
            ("clsa", (COM, "CCC_MGRN_COM"), "ever-told migraine", {"pair": "MGRN"}),
            ("clsa", (TRM, "DEP_BOTR_TRM"), "CES-D: bothered by things", {"pair": "DEP_BOTR"}),
            ("clsa", (COM, "DEP_BOTR_COM"), "CES-D: bothered by things", {"pair": "DEP_BOTR"}),
            ("clsa", (TRM, "CCT_ASTHM_TRM"), "ever-told asthma", {"pair": "ASTHM"}),
            ("clsa", (COM, "CCC_ASTHM_COM"), "ever-told asthma", {"pair": "ASTHM"}),
            ("clsa", (TRM, "CCT_DIAB_TRM"), "ever-told diabetes", {"pair": "DIAB"}),
            ("clsa", (COM, "DIA_DIAB_COM"), "ever-told diabetes", {"pair": "DIAB"}),
            ("clsa", (TRM, "GEN_MNTL_TRM"), "self-rated mental health", {"pair": "GEN_MNTL"}),
            ("clsa", (COM, "GEN_MNTL_COM"), "self-rated mental health", {"pair": "GEN_MNTL"}),
            ("clsa", (TRM, "CCT_COPD_TRM"), "ever-told COPD / emphysema / chronic bronchitis", {"pair": "COPD"}),
            ("clsa", (COM, "CCC_COPD_COM"), "ever-told COPD / emphysema / chronic bronchitis", {"pair": "COPD"}),
            ("clsa", (TRM, "CCT_ALLRG_TRM"), "ever-told allergies", {"pair": "ALLRG"}),
            ("clsa", (COM, "CCC_ALLRG_COM"), "ever-told allergies", {"pair": "ALLRG"}),
            ("clsa", (TRM, "DEP_FLDP_TRM"), "CES-D: felt depressed", {"pair": "DEP_FLDP"}),
            ("clsa", (COM, "DEP_FLDP_COM"), "CES-D: felt depressed", {"pair": "DEP_FLDP"}),
            ("clsa", (TRM, "FAL_NMBR_NB_TRM"), "number of falls, past 12 months", {"pair": "FAL_NMBR_NB"}),
            ("clsa", (COM, "FAL_NMBR_NB_COM"), "number of falls, past 12 months", {"pair": "FAL_NMBR_NB"}),
            ("clsa", (TRM, "CCT_MACDEG_TRM"), "ever-told macular degeneration", {"pair": "MACDEG"}),
            ("clsa", (COM, "CCC_MACDEG_COM"), "ever-told macular degeneration", {"pair": "MACDEG"}),
        ],
    },
    "duplicate_variable_name": {
        "intent": "7. One repeated variable_name in one file (two distinct UKBB fields both called 'Weight').",
        "variables": [
            ("ukbb", ("21002",), "first 'Weight' (field 21002) keeps the name"),
            ("ukbb", ("23098",), "second 'Weight' (field 23098) — core now keeps it as 'Weight__2'"),
        ],
    },
    "ungrouped_leftovers": {
        "intent": (
            "8. Variables the main HDBSCAN pass leaves as outliers, recovered by M10 as ONE group the split stage "
            "then divides."
        ),
        "note": (
            "Since core clusters cohort-only (2026-10-02), the main pass leaves ~10 outliers here, and M10 groups "
            "any residual of <= 15 rows WHOLE rather than re-clustering it (core recluster_residual, by design: a "
            "recall-favoring feed for the split stage). So at this size nothing stays an ungrouped leftover; a "
            "leftover needs a residual > 15. Assert that the main pass leaves at least one outlier and M10 returns "
            "them as one group, not which ones. 'variables' and 'candidates' are the rows chosen (under the earlier "
            "catalog-in clustering) to sit between clusters — see tests/live/fixture/VALIDATION.md."
        ),
        "variables": [
            (
                "aou",
                (PMH, "hearingvision_howoldwereyouglaucoma"),
                "age first told of glaucoma: between age + eye items",
            ),
            ("aou", (PMH, "hearingvision_rxmedsforglaucoma"), "treated for glaucoma: between follow-ups + eye items"),
            ("clsa", (COM, "ROS_PAIN_COM"), "chest pain — no other cardiac item in the fixture"),
            ("ukbb", ("2335",), "chest pain — no other cardiac item in the fixture"),
            ("ukbb", ("20489",), "felt loved as a child — a leftover in the reference walk"),
            ("ukbb", ("2463",), "fractured bones — a leftover in the reference walk"),
            ("ukbb", ("2188",), "long-standing illness: between the frailty and condition items"),
        ],
        "candidates": [
            ("aou", (PMH, "digestive_howoldwereyouceliacdisease"), "walk leftover (age first told, absent condition)"),
            (
                "aou",
                (PMH, "infectiousdiseases_howoldwereyouchickenpox"),
                "walk leftover (age first told, absent condition)",
            ),
            ("ukbb", ("20487",), "walk leftover (childhood experience)"),
            ("ukbb", ("20488",), "walk leftover (childhood experience)"),
            ("ukbb", ("20489",), "walk leftover (childhood experience)"),
        ],
    },
    "eg_permissible_values": {
        "intent": "9. Retrieves a catalog CDE whose permissible values carry '(e.g., ...)' labels.",
        "variables": [
            ("clsa", (TRM, "CCT_DIAB_TRM"), "walk re-picked Health Conditions - Disease Disorders for diabetes"),
            ("clsa", (COM, "DIA_DIAB_COM"), "as above"),
            ("ukbb", ("2443",), "as above"),
            ("ukbb", ("120007",), "diabetes type I/II, same target family"),
            ("aou", (PMH, "endocrine_endocrineconditions"), "a condition checklist — the CDE is itself a checklist"),
            ("aou", (PMH, "respiratory_respiratoryconditions"), "a condition checklist"),
        ],
    },
    "eye_conditions_spread": {
        "intent": "10. Eye-condition items spread over >= 2 clusters (the reviewer's 'New group' drag test).",
        "variables": [
            ("clsa", (TRM, "CCT_GLAUC_TRM"), "ever-told glaucoma"),
            ("clsa", (TRM, "CCT_CATAR_TRM"), "ever-told cataracts"),
            ("clsa", (TRM, "CCT_MACDEG_TRM"), "ever-told macular degeneration"),
            ("clsa", (TRM, "VIS_SGHT_TRM"), "eyesight rating (Excellent..Poor scale)"),
            ("ukbb", ("6148",), "eye problems checklist"),
            ("ukbb", ("4689",), "age glaucoma diagnosed"),
            ("ukbb", ("4700",), "age cataract diagnosed"),
            ("ukbb", ("6119",), "which eye has glaucoma"),
            ("ukbb", ("2207",), "wears glasses"),
            ("aou", (PMH, "hearingvision_glaucomacurrently"), "still seeing a doctor for glaucoma"),
            ("aou", (PMH, "hearingvision_rxmedsforcataracts"), "treated for cataracts"),
            ("aou", ("Basics", "disability_blind"), "serious difficulty seeing"),
        ],
    },
    "score_components": {
        "intent": "11. Williams frailty index (UK Biobank) components, for the score-matching path.",
        "variables": [
            ("ukbb", ("2296",), "falls in the last year"),
            ("ukbb", ("2247",), "hearing difficulty"),
            ("ukbb", ("2335",), "chest pain or discomfort"),
            ("ukbb", ("2443",), "diabetes diagnosed by doctor"),
            ("ukbb", ("6148",), "eye problems (glaucoma / cataracts)"),
            ("ukbb", ("2178",), "overall health rating"),
            ("ukbb", ("2188",), "long-standing illness, disability or infirmity"),
            ("ukbb", ("2080",), "tiredness / lethargy"),
            ("ukbb", ("2020",), "loneliness"),
            ("ukbb", ("1970",), "nervous feelings"),
            ("ukbb", ("1200",), "sleeplessness / insomnia"),
            ("ukbb", ("2463",), "fractured / broken bones in last 5 years"),
        ],
    },
}

# ─── building ───────────────────────────────────────────────────────────────────────────────────────


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_sources(args: argparse.Namespace) -> dict[str, Path]:
    base = args.examples_dir or os.environ.get("DDHARMON_EXAMPLES_DIR")
    out: dict[str, Path] = {}
    for cid, spec in COHORTS.items():
        explicit = getattr(args, cid) or os.environ.get(spec["envVar"])
        if explicit:
            out[cid] = Path(explicit)
        elif base:
            out[cid] = Path(base) / spec["sourceFile"]
        else:
            sys.exit(
                f"no source for {cid}: pass --examples-dir (or set DDHARMON_EXAMPLES_DIR) pointing at a ddharmon "
                f"core checkout's data/examples/, or --{cid} / {spec['envVar']} at {spec['sourceFile']}"
            )
        if not out[cid].is_file():
            sys.exit(f"{cid} source not found: {out[cid]}")
    return out


def _select(cid: str, src: Path) -> tuple[list[str], list[list[str]], dict[tuple[str, ...], int]]:
    """Read ``src`` and return (header, selected rows in source order, key -> output row index)."""
    spec = COHORTS[cid]
    with src.open(newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        rows = list(reader)
    missing_cols = [c for c in (*spec["key"], *spec["columnRoles"].values()) if c not in header]
    if missing_cols:
        sys.exit(f"{cid}: source header lacks {missing_cols} ({src.name})")
    key_idx = [header.index(c) for c in spec["key"]]
    wanted = set(ALLOW[cid])
    if len(wanted) != len(ALLOW[cid]):
        sys.exit(f"{cid}: the allow-list names a row twice")
    hits: dict[tuple[str, ...], list[int]] = {}
    for i, row in enumerate(rows):
        k = tuple(row[j] for j in key_idx)
        if k in wanted:
            hits.setdefault(k, []).append(i)
    absent = [k for k in ALLOW[cid] if k not in hits]
    if absent:
        sys.exit(f"{cid}: allow-listed rows not found in {src.name}: {absent}")
    ambiguous = {k: v for k, v in hits.items() if len(v) > 1}
    if ambiguous:
        sys.exit(f"{cid}: allow-list keys match more than one source row: {sorted(ambiguous)}")
    order = sorted(v[0] for v in hits.values())
    selected = [rows[i] for i in order]
    at = {k: order.index(v[0]) for k, v in hits.items()}
    return header, selected, at


def _member_ids(cohort_name: str, names: list[str]) -> list[str]:
    """Mirror core's repeated-name disambiguation: the first keeps the name, later ones get ``__2``, ``__3``."""
    used: set[str] = set()
    out: list[str] = []
    for name in names:
        ident = name
        if name in used:
            n = 2
            while f"{name}__{n}" in used:
                n += 1
            ident = f"{name}__{n}"
        used.add(ident)
        out.append(f"{cohort_name}:{ident}")
    return out


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def build(sources: dict[str, Path], out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict = {
        "purpose": "Deterministic staged-review live-verify fixture; see scripts/build_live_verify_fixture.py.",
        "cdeSet": "endorsed",
        "cohorts": [],
        "paths": {},
    }
    lookup: dict[tuple[str, tuple[str, ...]], dict] = {}
    repeated: list[str] = []
    for cid, spec in COHORTS.items():
        header, rows, at = _select(cid, sources[cid])
        _write_csv(out_dir / spec["file"], header, rows)
        vcol = header.index(spec["columnRoles"]["variable_name"])
        names = [r[vcol] for r in rows]
        ids = _member_ids(spec["cohortName"], names)
        seen: dict[str, int] = {}
        for n in names:
            seen[n] = seen.get(n, 0) + 1
        repeated += [f"{spec['cohortName']}:{n}" for n, c in seen.items() if c > 1]
        for k, i in at.items():
            lookup[(cid, k)] = {"cohort": spec["cohortName"], "variable": names[i], "memberId": ids[i]}
        manifest["cohorts"].append(
            {
                "file": spec["file"],
                "cohortName": spec["cohortName"],
                "columnRoles": spec["columnRoles"],
                "rows": len(rows),
                "source": {"file": sources[cid].name, "sha256": _sha256(sources[cid])},
            }
        )
    if repeated != ["UKBB:Weight"]:
        sys.exit(f"expected exactly one repeated variable name (UKBB:Weight), got {repeated}")
    total = sum(c["rows"] for c in manifest["cohorts"])
    if total > 140:
        sys.exit(f"fixture has {total} rows; the cap is 140 (a synchronous paid run must stay well under $1)")
    manifest["totalRows"] = total

    def resolve(name: str, items: list[tuple]) -> list[dict]:
        entries = []
        for cid, key, reason, *extra in items:
            if (cid, key) not in lookup:
                sys.exit(f"path {name!r} names {cid}:{key}, which is not in the allow-list")
            entry = {**lookup[(cid, key)], "sourceKey": "/".join(key), "reason": reason}
            for more in extra:
                entry.update(more)
            entries.append(entry)
        return entries

    for name, spec in PATHS.items():
        out: dict = {"intent": spec["intent"]}
        if "note" in spec:
            out["note"] = spec["note"]
        out["variables"] = resolve(name, spec["variables"])
        if "candidates" in spec:
            out["candidates"] = resolve(name, spec["candidates"])
        manifest["paths"][name] = out
    text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    (out_dir / "manifest.json").write_text(text, encoding="utf-8")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--examples-dir", help="directory holding the three public source dictionaries")
    for cid, spec in COHORTS.items():
        ap.add_argument(f"--{cid}", help=f"path to {spec['sourceFile']} (overrides --examples-dir)")
    ap.add_argument("--out-dir", default=str(OUT_DIR), help="output directory (default: tests/live/fixture)")
    args = ap.parse_args()
    manifest = build(_resolve_sources(args), Path(args.out_dir))
    for c in manifest["cohorts"]:
        print(f"{c['cohortName']:>5}: {c['rows']} rows -> {c['file']}")
    print(f"total: {manifest['totalRows']} rows; {len(manifest['paths'])} paths")


if __name__ == "__main__":
    main()
