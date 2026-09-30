# Live-verify fixture — $0 validation

What this checks: that the fixture in this directory (built by `scripts/build_live_verify_fixture.py`)
clusters the way `manifest.json` says it should, **without a single paid LLM call**. The validator
(`scripts/validate_live_verify_fixture.py`) loads the three files with the manifest's column roles,
loads the `endorsed` CDE catalog the way `backend/app.py` does, embeds locally (BioLORD-2023), and calls
core `harmonize_leanb` with every LLM stage unset — the same call the adapter's preview mode makes, at
the adapter's own auto-scaled `min_cluster_size` (3 for 109 variables). Core returns straight after
clustering, M10 outlier recovery and retrieval. No provider is called and no API key is read.

```bash
python scripts/validate_live_verify_fixture.py --json-out run1.json
python scripts/validate_live_verify_fixture.py --json-out run2.json --seeds 10 --compare run1.json
DDHARMON_CACHE=$(mktemp -d) python scripts/validate_live_verify_fixture.py --json-out cold.json --compare run1.json
```

The fixture: **109 variables** (AoU 33, CLSA 41, UKBB 35), every row copied verbatim from the public
dictionaries (All of Us survey codebook, CLSA baseline, UK Biobank Showcase). Against the 540-variable
reference walk (49 clusters, a $0.70 Gate 1 in batch mode), this run forms **13 clusters**, so it sends
13 generate-ideal prompts rather than 49.

## Result by path

"$0" means the validator shows it. "Paid" means only a paid run can confirm it; the evidence given is
from the 540-variable reference walk (run `6c66731c`) and the larger CLSA run (`573cf61f`).

| # | Path | Status | Evidence |
|---|---|---|---|
| 1 | Heterogeneous cluster the split partitions | $0: all 8 self-rated-health items share one cluster (K3), 10/10 seeds. Split itself: paid. | The walk's matching cluster (general + mental health on one Excellent..Poor scale) split into 4 groups: general -> adopt, mental -> refine. K1 (22 members: hearing + eye + age at diagnosis) is a second, obviously mixed cluster. |
| 2 | adopt / refine / novel | Paid (retrieval shown at $0). | General health retrieves Self-Reported Health at cos 0.75-0.96 (walk: **adopt**). Asthma / COPD retrieve Health Conditions - Disease Disorders at 0.34-0.61 (walk: **refine**). Migraine, hearing and allergies had no fitting CDE (walk: **novel** -> GenCDE). |
| 3 | Units / arithmetic transform | $0 for the deterministic part; the GenCDE's unit is paid. | The endorsed catalog has no height or weight CDE and an empty `uom` column. So K2 (height + weight) only retrieves unrelated CDEs (best: Self-Reported Health, 0.28 for the cluster). The nearest relevant one, Vital Signs Measurement, is about 0.15, and any adopt/refine onto it would be floored to novel by the 0.30 retrieval floor. So K2 is expected to go novel with a numeric GenCDE. The unit canonicalizer then turns CLSA `SPR_INPUT_HEIGHT_COM` (declared `m`) into cm with a factor of 100 (deterministic). `HWT_DHT_M_TRM` / `HWT_DWT_K_TRM` declare no unit, so they become needs-units residuals for the paid arithmetic (N2) prompt. `UKBB:Age diabetes diagnosed` (years) retrieves the unitless Age / Age Units CDEs. |
| 4 | Wide->long repeating measure | $0: the 5 medication slots share one cluster (K10), 10/10 seeds. The positional detector fires (`... medication #`, occurrences 1..5). | The wide->long pre-pass needs an adopt/refine record. In `573cf61f` this exact question (40 slots) went **refine -> Concomitant Medication Name** (cos 0.43). Here it is the cluster's top candidate at 0.45. |
| 5 | Missing-data codes | $0: the codes are in the rows. Recoding them is paid. | UKBB `120016` / `120007` carry -121 / -818; `120105` carries -818 plus -521..-524; `2050` / `2443` carry -1 / -3. In the walk the migraine GenCDE recode mapped UKBB -121 -> 9 (after a reviewer edit). |
| 6 | Many-to-one inside one cohort | $0: all **11** CLSA tracking/comprehensive twin pairs share a cluster, 10/10 seeds. Same target: paid. | In the walk each twin pair landed in ONE group with ONE target: GEN_HLTH_TRM + _COM -> Self-Reported Health (adopt); CCT_MGRN_TRM + CCC_MGRN_COM -> one migraine GenCDE, both recoded `{1:1, 2:0}`. |
| 7 | Repeated variable name | $0: UKBB fields 21002 and 23098 are both named `Weight`. 35 rows -> 35 variables. | **Behaviour change:** current core no longer drops the second row (last-wins). It keeps it as `Weight__2` (see below). |
| 8 | Ungrouped leftovers | $0 on this machine: 7 leftovers, identical run to run. **Fragile** elsewhere (see below). | The walk's own leftovers were childhood-experience items and fractured bones. Both kinds are here, and `Felt loved as a child` + fractured bones are leftovers again. |
| 9 | CDE with "(e.g., ...)" labels | $0: every path-9 diabetes item and condition checklist retrieves **Health Conditions - Disease Disorders** in its top 2, at cos 0.45-0.55. Its permissible values include "Autoimmune condition (e.g., ...)". | In the walk, asthma and COPD were **refined onto** this CDE, and diabetes was re-picked to it; its "(e.g., ...)" labels were cut in Gate 2 / Gate 3. |
| 10 | Eye items spread over groups | $0: the path's eye items land in 2 clusters (K1, K6), 10/10 seeds have >= 2 clusters, and two AoU glaucoma follow-ups are leftovers. | CLSA / AoU "ever told" and "still seeing a doctor" items sit in K6. UKBB age-at-diagnosis / which-eye / glasses, the CLSA eyesight rating and AoU "difficulty seeing" sit in K1. |
| 11 | Score components (Williams frailty index) | $0: 12 UKBB components present. On this partition 9 are in clusters and 3 are leftovers. | Components: falls, hearing, chest pain, diabetes, eye problems, overall health, long-standing illness, tiredness, loneliness, nervous feelings, sleeplessness, fractures. Leftovers this run: chest pain, long-standing illness, fractures. |

## Reproducibility

- **Same machine, same embedding cache: identical.** Run 1 and run 2 both gave partition `ff2e2543be10f322`.
  The local server reads the same default cache (`~/.ddharmon`, or `$DDHARMON_CACHE`), so the driver's run
  sees this partition.
- **Cold embedding cache: different.** Re-embedding from scratch gave `20e786b6bb41319b`: 15 clusters, and
  only 4 of the 13 reference clusters come back exactly the same. The cause is float-level differences
  between vectors embedded in different batches, which is enough to move UMAP. Every check except the
  leftover *identities* still passed. That run had 1 leftover (`Felt hated by family member as a child`).
- **UMAP-seed sweep (seeds 0..9)** stands in for another machine. Paths 1, 4, 6, 7 and 10 held in 10/10
  seeds. "At least one leftover" held in 7/10. The leftover *set* never matched the reference.

**What the driver should assert for path 8:** at least one ungrouped leftover exists, not which ones.
Leftovers are the one fragile path at this size. With 193 catalog rows sharing the clustering, the main
HDBSCAN pass leaves 25-45 outliers. M10 then re-clusters those outliers (min size 8), and it absorbs
whatever is left unless a point stays noise a second time. Isolated one-off items don't work (they're
pulled into the nearest cluster). Items that sit *between* two clusters do (an "age first told" item
between the age items and its condition; childhood experiences; chest pain with no other cardiac item).
Adding six systolic-blood-pressure readings (a second repeating measure) dropped the leftover rate to
2/10, so they were left out.

## Behaviour notes the driver should know

- **A repeated name is disambiguated now, not dropped.** Core's CSV parser keeps the first `Weight` and
  renames the second to `Weight__2`, keeping the source name on `short_label`. The old last-wins silent drop
  no longer happens. The hazard this pair still tests is two *distinct* fields (21002 assessment centre,
  23098 impedance) shown under one display name. The manifest's `memberId` for the second is
  `UKBB:Weight__2`.
- **The CDE catalog gets the same treatment.** Its repeated designations become `Age__2`,
  `Age Units__2`, `Employment Status__2`, and they surface that way as candidate ids (see the
  `Age Units__2` hit for `UKBB:Age diabetes diagnosed`).
- **Candidate order is hybrid rank, not cosine.** Candidates are ordered by dense + BM25 rank fusion, and
  the cosine printed is the dense score, so a lower cosine can rank first.

## Reference run (generated by the validator; run 2, with the seed sweep)

- CDE catalog `endorsed`; 109 source variables; `min_cluster_size` 3 (the adapter's auto-scale)
- 13 clusters, 7 ungrouped leftovers; partition fingerprint `ff2e2543be10f322`

| Cluster | Size | Cohorts | Members | Top retrieved CDEs (cosine) |
|---|---|---|---|---|
| K1 | 22 | AoU, CLSA, UKBB | AoU:disability_blind, AoU:disability_deaf, AoU:hearingvision_hearinglosscurrently, AoU:hearingvision_hearingvisionconditions, AoU:hearingvision_howoldwereyouhearingloss, AoU:hearingvision_rxmedsforhearingloss, CLSA:HRG_AID_TRM, CLSA:HRG_HRG_TRM, CLSA:HRG_NOIS_TRM, CLSA:VIS_SGHT_TRM, UKBB:Age asthma diagnosed, UKBB:Age cataract diagnosed, UKBB:Age diabetes diagnosed, UKBB:Age glaucoma diagnosed, UKBB:Age macular degeneration diagnosed, UKBB:Diabetes diagnosed by doctor, UKBB:Eye problems/disorders, UKBB:Hearing difficulty/problems, UKBB:Hearing difficulty/problems with background noise, UKBB:Wears glasses or contact lenses, UKBB:Which eye(s) affected by glaucoma, UKBB:Which eye(s) are affected by cataract | Disabilities (0.502); Health Conditions - Disease Disorders - Specify Other (0.367); Health Conditions - Disease Disorders (0.427) |
| K2 | 10 | CLSA, UKBB | CLSA:HGT_HEIGHT_M_COM, CLSA:HWT_DHT_M_TRM, CLSA:HWT_DWT_K_TRM, CLSA:SPR_INPUT_HEIGHT_COM, CLSA:SPR_INPUT_WEIGHT_COM, CLSA:WGT_WEIGHT_KG_COM, UKBB:Height, UKBB:Standing height, UKBB:Weight, UKBB:Weight__2 | Self-Reported Health (0.284); Health Disparity Outcomes (Project Level) (0.17); Sex at Birth (0.243) |
| K3 | 9 | AoU, CLSA, UKBB | AoU:overallhealth_averagefatigue7days, AoU:overallhealth_generalhealth, AoU:overallhealth_generalmentalhealth, AoU:overallhealth_generalphysicalhealth, CLSA:GEN_HLTH_COM, CLSA:GEN_HLTH_TRM, CLSA:GEN_MNTL_COM, CLSA:GEN_MNTL_TRM, UKBB:Overall health rating | Self-Reported Health (0.89); English Proficiency (0.386); Health Conditions - Disease Disorders - Specify Other (0.347) |
| K4 | 9 | AoU, CLSA, UKBB | AoU:overallhealth_emotionalproblem7days, CLSA:DEP_BOTR_COM, CLSA:DEP_BOTR_TRM, CLSA:DEP_FLDP_COM, CLSA:DEP_FLDP_TRM, CLSA:DEP_LONLY_TRM, CLSA:FAL_NMBR_NB_COM, CLSA:FAL_NMBR_NB_TRM, UKBB:Feeling down, depressed, or hopeless over the last two weeks | Usual Place of Care (0.24); Shared Living Space Number of Individuals (0.197); Economic Stability – Social Needs (0.225) |
| K5 | 9 | AoU, CLSA, UKBB | AoU:respiratory_asthmacurrently, AoU:respiratory_respiratoryconditions, AoU:respiratory_rxmedsforasthma, CLSA:CCC_ASTHM_COM, CLSA:CCC_COPD_COM, CLSA:CCT_ASTHM_TRM, CLSA:CCT_COPD_TRM, UKBB:Doctor diagnosed COPD (chronic obstructive pulmonary disease), UKBB:Doctor diagnosed asthma | Health Conditions - Disease Disorders (0.529); Health Conditions - Disease Disorders - Specify Other (0.409); Health Conditions - Medication or Other Treatments (0.282) |
| K6 | 8 | AoU, CLSA | AoU:hearingvision_cataractscurrently, AoU:hearingvision_glaucomacurrently, AoU:hearingvision_maculardegenerationcurrently, AoU:hearingvision_rxmedsforcataracts, CLSA:CCC_MACDEG_COM, CLSA:CCT_CATAR_TRM, CLSA:CCT_GLAUC_TRM, CLSA:CCT_MACDEG_TRM | Health Conditions - Disease Disorders (0.373); Health Conditions - Disease Disorders - Specify Other (0.352); Usual Place of Care (0.18) |
| K7 | 7 | AoU, CLSA, UKBB | AoU:endocrine_endocrineconditions, AoU:endocrine_howoldwereyoutype2diabetes, AoU:endocrine_rxmedsfortype2diabetes, AoU:endocrine_type2diabetescurrently, CLSA:CCT_DIAB_TRM, CLSA:DIA_DIAB_COM, UKBB:Ever had diabetes (Type I or Type II) | Health Conditions - Disease Disorders (0.53); Health Conditions - Disease Disorders - Specify Other (0.394); Usual Place of Care (0.185) |
| K8 | 6 | AoU, CLSA, UKBB | AoU:nervoussystem_howoldwereyoumigraine, AoU:nervoussystem_migrainecurrently, AoU:nervoussystem_rxmedsformigraine, CLSA:CCC_MGRN_COM, CLSA:CCT_MGRN_TRM, UKBB:Ever had migraine | Health Conditions - Disease Disorders - Specify Other (0.258); Health Conditions - Disease Disorders (0.353); Usual Place of Care (0.181) |
| K9 | 5 | AoU, CLSA, UKBB | AoU:other_allergiescurrently, AoU:other_rxmedsforallergies, CLSA:CCC_ALLRG_COM, CLSA:CCT_ALLRG_TRM, UKBB:Doctor diagnosed hayfever or allergic rhinitis | Health Conditions - Disease Disorders - Specify Other (0.404); Health Conditions - Disease Disorders (0.392); Usual Place of Care (0.289) |
| K10 | 5 | CLSA | CLSA:MEDI_ID_NAME_SP2_1_COM, CLSA:MEDI_ID_NAME_SP2_2_COM, CLSA:MEDI_ID_NAME_SP2_3_COM, CLSA:MEDI_ID_NAME_SP2_4_COM, CLSA:MEDI_ID_NAME_SP2_5_COM | Concomitant Medication Name (0.453); Health Conditions - Medication or Other Treatments   - Specify Other (0.337); Health Conditions - Medication or Other Treatments (0.337) |
| K11 | 5 | UKBB | UKBB:Frequency of depressed mood in last 2 weeks, UKBB:Frequency of tiredness / lethargy in last 2 weeks, UKBB:Loneliness, isolation, UKBB:Nervous feelings, UKBB:Sleeplessness / insomnia | Disabilities (0.379); Employment Status (0.339); Employment Status__2 (0.254) |
| K12 | 4 | AoU | AoU:digestive_howoldwereyouceliacdisease, AoU:infectiousdiseases_howoldwereyouchickenpox, AoU:other_howoldwereyouallergies, AoU:respiratory_howoldwereyouasthma | Self-Reported COVID-19 Diagnosis Date (0.438); Age (0.462); COVID-19 Complication Onset Date (0.261) |
| K13 | 3 | UKBB | UKBB:Falls in the last year, UKBB:Felt hated by family member as a child, UKBB:Physically abused by family as a child | Shared Living Space Person Ability to Isolate Indicator (0.379); Economic Stability – Social Needs (0.217); Disabilities (0.245) |

Ungrouped leftovers: AoU:hearingvision_howoldwereyouglaucoma, AoU:hearingvision_rxmedsforglaucoma, CLSA:ROS_PAIN_COM, UKBB:Chest pain or discomfort, UKBB:Felt loved as a child, UKBB:Fractured/broken bones in last 5 years, UKBB:Long-standing illness, disability or infirmity

| Check | Result | Detail |
|---|---|---|
| 1 split candidate: all in ONE cluster | PASS | ['K3'] |
| 4 repeating measure: together + detected | PASS | ['K10']; detector: {'signature': 'drug or natural product name original input medication #', 'occurrences': 5, 'range': [1, 5]} |
| 6 twin pairs: each pair in one cluster | PASS | 11/11 pairs |
| 7 repeated name: every UKBB row survives | PASS | rows 35 -> variables 35 |
| 8 leftovers: at least one | PASS | 7 ungrouped |
| 8 leftovers: the manifest's reference set | PASS | 7/7 are leftovers |
| 10 eye items: >= 2 clusters | PASS | ['K1', 'K6'] |

UMAP-seed sweep (seeds 0..9): leftovers per seed [0, 1, 2, 1, 1, 1, 7, 0, 1, 0]

| Check | Pass rate |
|---|---|
| 1 split candidate: all in ONE cluster | 10/10 |
| 4 repeating measure: together + detected | 10/10 |
| 6 twin pairs: each pair in one cluster | 10/10 |
| 7 repeated name: every UKBB row survives | 10/10 |
| 8 leftovers: at least one | 7/10 |
| 8 leftovers: the manifest's reference set | 0/10 |
| 10 eye items: >= 2 clusters | 10/10 |

Most frequent leftovers: UKBB:Felt loved as a child (3), UKBB:Felt hated by family member as a child (2), CLSA:ROS_PAIN_COM (2), UKBB:Hearing difficulty/problems (1), AoU:infectiousdiseases_howoldwereyouchickenpox (1), AoU:disability_blind (1), AoU:hearingvision_howoldwereyouglaucoma (1), UKBB:Chest pain or discomfort (1)

| Path | Variable | Cluster | Top retrieved CDEs (cosine; e.g. = has "(e.g.," labels) | Unit |
|---|---|---|---|---|
| heterogeneous_split | AoU:overallhealth_generalhealth | K3 |  |  |
| heterogeneous_split | AoU:overallhealth_generalphysicalhealth | K3 |  |  |
| heterogeneous_split | AoU:overallhealth_generalmentalhealth | K3 |  |  |
| heterogeneous_split | CLSA:GEN_HLTH_TRM | K3 |  |  |
| heterogeneous_split | CLSA:GEN_HLTH_COM | K3 |  |  |
| heterogeneous_split | CLSA:GEN_MNTL_TRM | K3 |  |  |
| heterogeneous_split | CLSA:GEN_MNTL_COM | K3 |  |  |
| heterogeneous_split | UKBB:Overall health rating | K3 |  |  |
| verdict_mix | AoU:overallhealth_generalhealth | K3 | Self-Reported Health (0.856); English Proficiency (0.346); Health Conditions - Disease Disorders - Specify Other (0.393) |  |
| verdict_mix | CLSA:GEN_HLTH_TRM | K3 | Self-Reported Health (0.959); English Proficiency (0.377); Health Conditions - Disease Disorders - Specify Other (0.334) |  |
| verdict_mix | CLSA:GEN_HLTH_COM | K3 | Self-Reported Health (0.959); English Proficiency (0.377); Health Conditions - Disease Disorders - Specify Other (0.334) |  |
| verdict_mix | UKBB:Overall health rating | K3 | Self-Reported Health (0.745); English Proficiency (0.345); Household Member Size (0.312) |  |
| verdict_mix | CLSA:CCT_ASTHM_TRM | K5 | Health Conditions - Disease Disorders (0.343, e.g.); Health Conditions - Disease Disorders - Specify Other (0.26); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.228) |  |
| verdict_mix | CLSA:CCC_ASTHM_COM | K5 | Health Conditions - Disease Disorders (0.343, e.g.); Health Conditions - Disease Disorders - Specify Other (0.26); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.228) |  |
| verdict_mix | UKBB:Doctor diagnosed asthma | K5 | Health Conditions - Disease Disorders - Specify Other (0.392); Health Conditions - Disease Disorders (0.507, e.g.); Economic Stability – Social Needs (0.271) |  |
| verdict_mix | CLSA:CCT_COPD_TRM | K5 | Health Conditions - Disease Disorders (0.52, e.g.); Health Conditions - Disease Disorders - Specify Other (0.385); Health Conditions - Medication or Other Treatments (0.257, e.g.) |  |
| verdict_mix | CLSA:CCC_COPD_COM | K5 | Health Conditions - Disease Disorders (0.52, e.g.); Health Conditions - Disease Disorders - Specify Other (0.385); Health Conditions - Medication or Other Treatments (0.257, e.g.) |  |
| verdict_mix | UKBB:Doctor diagnosed COPD (chronic obstructive pulmonary disease) | K5 | Health Conditions - Disease Disorders (0.611, e.g.); Health Conditions - Disease Disorders - Specify Other (0.513); Health Conditions - Medication or Other Treatments (0.308, e.g.) |  |
| verdict_mix | CLSA:CCT_MGRN_TRM | K8 | Health Conditions - Disease Disorders (0.369, e.g.); Health Conditions - Disease Disorders - Specify Other (0.264); Usual Place of Care (0.16) |  |
| verdict_mix | CLSA:CCC_MGRN_COM | K8 | Health Conditions - Disease Disorders (0.369, e.g.); Health Conditions - Disease Disorders - Specify Other (0.264); Usual Place of Care (0.16) |  |
| verdict_mix | UKBB:Ever had migraine | K8 | Health Conditions - Disease Disorders - Specify Other (0.254); Health Conditions - Disease Disorders (0.343, e.g.); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.114) |  |
| verdict_mix | CLSA:HRG_NOIS_TRM | K1 | Disabilities (0.262); Health Disparity Outcomes (Project Level) (0.195); Shared Living Space Person Ability to Isolate Indicator (0.18) |  |
| verdict_mix | UKBB:Hearing difficulty/problems | K1 | Disabilities (0.444); Sex at Birth (0.326); Economic Stability – Social Needs (0.219) |  |
| verdict_mix | UKBB:Hearing difficulty/problems with background noise | K1 | Disabilities (0.32); Household Member Size (0.288); Shared Living Space Person Ability to Isolate Indicator (0.212) |  |
| units_arithmetic | CLSA:SPR_INPUT_HEIGHT_COM | K2 | Sex at Birth (0.192); Self-Reported Health (0.197); Health Disparity Outcomes (Project Level) (0.147) | `m` -> cm x100 |
| units_arithmetic | CLSA:HWT_DHT_M_TRM | K2 | Self-Reported Health (0.345); Health Disparity Outcomes (Project Level) (0.221); Household Member Size (0.296) | `-` (no deterministic conversion) |
| units_arithmetic | CLSA:HGT_HEIGHT_M_COM | K2 | Health Disparity Outcomes (Project Level) (0.159); NIMHD Minority Health and Health Disparities Research Framework - Levels of Influence (Project Level) (0.108); Shared Living Space Number of Individuals (0.119) | `cm` -> cm x1 |
| units_arithmetic | UKBB:Standing height | K2 | Vital Signs Measurement (0.155); Physical Exam Date (0.201); Vital Signs Type (0.129) | `cm` -> cm x1 |
| units_arithmetic | UKBB:Height | K2 | Date of Chest Examination (0.149); New Renal Replacement Therapy (0.144); Vital Signs Type (0.145) | `cm` -> cm x1 |
| units_arithmetic | UKBB:Weight | K2 | Health Disparity Outcomes (Project Level) (0.176); Vital Signs Measurement (0.149); Physical Exam Findings/Sign Type (0.231) | `Kg` -> kg x1 |
| units_arithmetic | CLSA:SPR_INPUT_WEIGHT_COM | K2 | Sex at Birth (0.21); Highest level of oxygen support received on study day (0.221); Self-Reported Health (0.162) | `kg` -> kg x1 |
| units_arithmetic | CLSA:HWT_DWT_K_TRM | K2 | Self-Reported Health (0.245); Vital Signs Type (0.166); Household Member Size (0.277) | `-` (no deterministic conversion) |
| units_arithmetic | UKBB:Age diabetes diagnosed | K1 | Age Units__2 (0.408); Household Member Size (0.275); Health Conditions - Disease Disorders - Specify Other (0.214) | `years` -> year x1 |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_1_COM | K10 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_2_COM | K10 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_3_COM | K10 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_4_COM | K10 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_5_COM | K10 |  |  |
| missing_data_codes | UKBB:Ever had migraine | K8 |  |  |
| missing_data_codes | UKBB:Ever had diabetes (Type I or Type II) | K7 |  |  |
| missing_data_codes | UKBB:Feeling down, depressed, or hopeless over the last two weeks | K4 |  |  |
| missing_data_codes | UKBB:Frequency of depressed mood in last 2 weeks | K11 |  |  |
| missing_data_codes | UKBB:Diabetes diagnosed by doctor | K1 |  |  |
| many_to_one_same_cohort | CLSA:GEN_HLTH_TRM | K3 |  |  |
| many_to_one_same_cohort | CLSA:GEN_HLTH_COM | K3 |  |  |
| many_to_one_same_cohort | CLSA:CCT_MGRN_TRM | K8 |  |  |
| many_to_one_same_cohort | CLSA:CCC_MGRN_COM | K8 |  |  |
| many_to_one_same_cohort | CLSA:DEP_BOTR_TRM | K4 |  |  |
| many_to_one_same_cohort | CLSA:DEP_BOTR_COM | K4 |  |  |
| many_to_one_same_cohort | CLSA:CCT_ASTHM_TRM | K5 |  |  |
| many_to_one_same_cohort | CLSA:CCC_ASTHM_COM | K5 |  |  |
| many_to_one_same_cohort | CLSA:CCT_DIAB_TRM | K7 |  |  |
| many_to_one_same_cohort | CLSA:DIA_DIAB_COM | K7 |  |  |
| many_to_one_same_cohort | CLSA:GEN_MNTL_TRM | K3 |  |  |
| many_to_one_same_cohort | CLSA:GEN_MNTL_COM | K3 |  |  |
| many_to_one_same_cohort | CLSA:CCT_COPD_TRM | K5 |  |  |
| many_to_one_same_cohort | CLSA:CCC_COPD_COM | K5 |  |  |
| many_to_one_same_cohort | CLSA:CCT_ALLRG_TRM | K9 |  |  |
| many_to_one_same_cohort | CLSA:CCC_ALLRG_COM | K9 |  |  |
| many_to_one_same_cohort | CLSA:DEP_FLDP_TRM | K4 |  |  |
| many_to_one_same_cohort | CLSA:DEP_FLDP_COM | K4 |  |  |
| many_to_one_same_cohort | CLSA:FAL_NMBR_NB_TRM | K4 |  |  |
| many_to_one_same_cohort | CLSA:FAL_NMBR_NB_COM | K4 |  |  |
| many_to_one_same_cohort | CLSA:CCT_MACDEG_TRM | K6 |  |  |
| many_to_one_same_cohort | CLSA:CCC_MACDEG_COM | K6 |  |  |
| duplicate_variable_name | UKBB:Weight | K2 |  |  |
| duplicate_variable_name | UKBB:Weight__2 | K2 |  |  |
| ungrouped_leftovers | AoU:hearingvision_howoldwereyouglaucoma | leftover |  |  |
| ungrouped_leftovers | AoU:hearingvision_rxmedsforglaucoma | leftover |  |  |
| ungrouped_leftovers | CLSA:ROS_PAIN_COM | leftover |  |  |
| ungrouped_leftovers | UKBB:Chest pain or discomfort | leftover |  |  |
| ungrouped_leftovers | UKBB:Felt loved as a child | leftover |  |  |
| ungrouped_leftovers | UKBB:Fractured/broken bones in last 5 years | leftover |  |  |
| ungrouped_leftovers | UKBB:Long-standing illness, disability or infirmity | leftover |  |  |
| eg_permissible_values | CLSA:CCT_DIAB_TRM | K7 | Health Conditions - Disease Disorders (0.532, e.g.); Health Conditions - Disease Disorders - Specify Other (0.361); Self-Reported Health (0.245) |  |
| eg_permissible_values | CLSA:DIA_DIAB_COM | K7 | Health Conditions - Disease Disorders (0.532, e.g.); Health Conditions - Disease Disorders - Specify Other (0.361); Self-Reported Health (0.245) |  |
| eg_permissible_values | UKBB:Diabetes diagnosed by doctor | K1 | Health Conditions - Disease Disorders - Specify Other (0.315); Health Conditions - Disease Disorders (0.445, e.g.); Usual Place of Care (0.239) |  |
| eg_permissible_values | UKBB:Ever had diabetes (Type I or Type II) | K7 | Health Conditions - Disease Disorders (0.446, e.g.); Health Conditions - Disease Disorders - Specify Other (0.301); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.152) |  |
| eg_permissible_values | AoU:endocrine_endocrineconditions | K7 | Health Conditions - Disease Disorders - Specify Other (0.513); Health Conditions - Disease Disorders (0.509, e.g.); Usual Place of Care (0.275) |  |
| eg_permissible_values | AoU:respiratory_respiratoryconditions | K5 | Health Conditions - Disease Disorders - Specify Other (0.398); Health Conditions - Disease Disorders (0.545, e.g.); Economic Stability – Social Needs (0.306) |  |
| eye_conditions_spread | CLSA:CCT_GLAUC_TRM | K6 |  |  |
| eye_conditions_spread | CLSA:CCT_CATAR_TRM | K6 |  |  |
| eye_conditions_spread | CLSA:CCT_MACDEG_TRM | K6 |  |  |
| eye_conditions_spread | CLSA:VIS_SGHT_TRM | K1 |  |  |
| eye_conditions_spread | UKBB:Eye problems/disorders | K1 |  |  |
| eye_conditions_spread | UKBB:Age glaucoma diagnosed | K1 |  |  |
| eye_conditions_spread | UKBB:Age cataract diagnosed | K1 |  |  |
| eye_conditions_spread | UKBB:Which eye(s) affected by glaucoma | K1 |  |  |
| eye_conditions_spread | UKBB:Wears glasses or contact lenses | K1 |  |  |
| eye_conditions_spread | AoU:hearingvision_glaucomacurrently | K6 |  |  |
| eye_conditions_spread | AoU:hearingvision_rxmedsforcataracts | K6 |  |  |
| eye_conditions_spread | AoU:disability_blind | K1 |  |  |
| score_components | UKBB:Falls in the last year | K13 |  |  |
| score_components | UKBB:Hearing difficulty/problems | K1 |  |  |
| score_components | UKBB:Chest pain or discomfort | leftover |  |  |
| score_components | UKBB:Diabetes diagnosed by doctor | K1 |  |  |
| score_components | UKBB:Eye problems/disorders | K1 |  |  |
| score_components | UKBB:Overall health rating | K3 |  |  |
| score_components | UKBB:Long-standing illness, disability or infirmity | leftover |  |  |
| score_components | UKBB:Frequency of tiredness / lethargy in last 2 weeks | K11 |  |  |
| score_components | UKBB:Loneliness, isolation | K11 |  |  |
| score_components | UKBB:Nervous feelings | K11 |  |  |
| score_components | UKBB:Sleeplessness / insomnia | K11 |  |  |
| score_components | UKBB:Fractured/broken bones in last 5 years | leftover |  |  |
