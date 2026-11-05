# Live-verify fixture — $0 validation

What this checks: that the fixture in this directory (built by `scripts/build_live_verify_fixture.py`)
clusters the way `manifest.json` says it should, **without a single paid LLM call**. The validator
(`scripts/validate_live_verify_fixture.py`) loads the three files with the manifest's column roles,
loads the `endorsed` CDE catalog the way `backend/app.py` does, embeds locally (BioLORD-2023), and calls
core `harmonize_leanb` with every LLM stage unset — the same call the adapter's preview mode makes, at
the adapter's own auto-scaled `min_cluster_size` (3 for 109 variables). Core returns straight after
clustering, M10 outlier recovery and retrieval. No provider is called and no API key is read.

**Clustering is cohort-only.** Since core's 2026-10-02 default (`harmonize_leanb(cluster_with_catalog=False)`)
the catalog is loaded for RETRIEVAL only and never enters UMAP+HDBSCAN or M10, so the partition below does
not depend on which catalog (`endorsed` / `full`) the run uses; only the retrieved candidates do. The
validator's seed sweep clusters the same way. (The previous version of this file was measured with the
catalog clustered in, which is why its partition, leftovers and path-8 rule differed.)

```bash
python scripts/validate_live_verify_fixture.py --json-out run1.json --seeds 10
python scripts/validate_live_verify_fixture.py --json-out run2.json --compare run1.json
DDHARMON_CACHE=$(mktemp -d) python scripts/validate_live_verify_fixture.py --json-out cold.json --compare run1.json
```

The fixture: **109 variables** (AoU 33, CLSA 41, UKBB 35), every row copied verbatim from the public
dictionaries (All of Us survey codebook, CLSA baseline, UK Biobank Showcase). Against the 540-variable
reference walk (49 clusters, a $0.70 Gate 1 in batch mode), this run forms **14 clusters** (13 from the
main pass + 1 recovered by M10), so it sends 14 generate-ideal prompts rather than 49.

## Result by path

"$0" means the validator shows it. "Paid" means only a paid run can confirm it; the evidence given is
from the 540-variable reference walk (run `6c66731c`), the larger CLSA run (`573cf61f`), and the
cohort-only live-verify run on this fixture (`c9eb8c46`).

| # | Path | Status | Evidence |
|---|---|---|---|
| 1 | Heterogeneous cluster the split partitions | $0: all 8 self-rated-health items share one cluster (K6), 10/10 seeds. Split itself: paid. | The walk's matching cluster (general + mental health on one Excellent..Poor scale) split into 4 groups: general -> adopt, mental -> refine. K1 (13 members: hearing items + the CLSA eyesight rating + fractures, long-standing illness, physical abuse) is a second, obviously mixed cluster. |
| 2 | adopt / refine / novel | Paid (retrieval shown at $0). | General health retrieves Self-Reported Health at cos 0.75-0.96 (walk: **adopt**). Asthma / COPD retrieve Health Conditions - Disease Disorders at 0.34-0.61 (walk: **refine**). Migraine, hearing and allergies had no fitting CDE (walk: **novel** -> GenCDE). |
| 3 | Units / arithmetic transform | $0 for the deterministic part; the GenCDE's unit is paid. | The endorsed catalog has no height or weight CDE and an empty `uom` column. So K4 (height + weight) only retrieves unrelated CDEs (best: Self-Reported Health, 0.28 for the cluster). The nearest relevant one, Vital Signs Measurement, is about 0.15, and any adopt/refine onto it would be floored to novel by the 0.30 retrieval floor. So K4 is expected to go novel with a numeric GenCDE. The unit canonicalizer then turns CLSA `SPR_INPUT_HEIGHT_COM` (declared `m`) into cm with a factor of 100 (deterministic). `HWT_DHT_M_TRM` / `HWT_DWT_K_TRM` declare no unit, so they become needs-units residuals for the paid arithmetic (N2) prompt. `UKBB:Age diabetes diagnosed` (years, in K8) retrieves the unitless Age / Age Units CDEs. |
| 4 | Wide->long repeating measure | $0: the 5 medication slots share one cluster (K12), 10/10 seeds. The positional detector fires (`... medication #`, occurrences 1..5). | The wide->long pre-pass needs an adopt/refine record. In `573cf61f` this exact question (40 slots) went **refine -> Concomitant Medication Name** (cos 0.43). Here it is the cluster's top candidate at 0.45. |
| 5 | Missing-data codes | $0: the codes are in the rows. Recoding them is paid. | UKBB `120016` / `120007` carry -121 / -818; `120105` carries -818 plus -521..-524; `2050` / `2443` carry -1 / -3. In the walk the migraine GenCDE recode mapped UKBB -121 -> 9 (after a reviewer edit). |
| 6 | Many-to-one inside one cohort | $0: all **11** CLSA tracking/comprehensive twin pairs share a cluster, 10/10 seeds. Same target: paid. | In the walk each twin pair landed in ONE group with ONE target: GEN_HLTH_TRM + _COM -> Self-Reported Health (adopt); CCT_MGRN_TRM + CCC_MGRN_COM -> one migraine GenCDE, both recoded `{1:1, 2:0}`. |
| 7 | Repeated variable name | $0: UKBB fields 21002 and 23098 are both named `Weight`. 35 rows -> 35 variables. | **Behaviour change:** current core no longer drops the second row (last-wins). It keeps it as `Weight__2` (see below). |
| 8 | Outliers recovered by M10 as one group | $0: the main pass leaves 10 outliers; M10 returns all 10 as ONE cluster (K2), 0 leftovers, 10/10 seeds. How the split divides it: paid. | `c9eb8c46` (13 outliers on that machine's partition, recovered as one cluster): the split made 6 groups from it — falls across two cohorts (CLSA `FAL_NMBR_NB_COM` + UKBB `Falls in the last year`), a childhood-experience trio, three singletons, and one group of 5 unrelated yes/no symptom items (chest pain, fractures, hearing in noise, long-standing illness, nervous feelings) held together only by their answer format. |
| 9 | CDE with "(e.g., ...)" labels | $0: every path-9 diabetes item and condition checklist retrieves **Health Conditions - Disease Disorders** in its top 2, at cos 0.45-0.55. Its permissible values include "Autoimmune condition (e.g., ...)". | In the walk, asthma and COPD were **refined onto** this CDE, and diabetes was re-picked to it; its "(e.g., ...)" labels were cut in Gate 2 / Gate 3. |
| 10 | Eye items spread over groups | $0: the path's eye items land in 4 clusters (K1, K2, K5, K8), 10/10 seeds have >= 2 clusters. | CLSA / AoU "ever told" and "still seeing a doctor" items sit in K5. UKBB age-at-diagnosis / which-eye / glasses / eye problems sit in K8. The CLSA eyesight rating is in K1 with the hearing items; AoU "difficulty seeing" is in the M10 group (K2). |
| 11 | Score components (Williams frailty index) | $0: 12 UKBB components present, all 12 in clusters (no leftovers). | Components: falls, hearing, chest pain, diabetes, eye problems, overall health, long-standing illness, tiredness, loneliness, nervous feelings, sleeplessness, fractures. They spread over K1 (hearing, long-standing illness, fractures), K2 (falls, chest pain, nervous feelings — the M10 group), K6 (overall health), K8 (diabetes, eye problems) and K14 (tiredness, loneliness, sleeplessness). |

## Reproducibility

- **Same machine, same embedding cache: identical.** Run 1 and run 2 both gave partition `72dd9757118b138c`.
  The local server reads the same default cache (`~/.ddharmon`, or `$DDHARMON_CACHE`), so the driver's run
  sees this partition.
- **Cold embedding cache: not re-measured since the cohort-only switch.** With the catalog clustered in,
  re-embedding from scratch moved the partition (15 clusters; only 4 of 13 reference clusters identical),
  because float-level differences between vectors embedded in different batches are enough to move UMAP.
  Expect the same kind of drift here. The live-verify run `c9eb8c46` is an example: its main pass left 13
  outliers, not 10, and M10 still returned them as one group.
- **UMAP-seed sweep (seeds 0..9)** stands in for another machine. Every check held in 10/10 seeds, and no
  seed left an ungrouped leftover.

**What the checks assert for path 8:** the main pass leaves at least one outlier, and M10 returns all of them
as ONE group with no leftover — not which variables. This is core's rule, not a property of these rows:
`recluster_residual` cannot re-cluster a residual of <= 15 rows (too few for its UMAP neighbourhood and an
8-member cluster), so it keeps the residual together as one group. That is deliberate: M10 is a
recall-favoring pass that FEEDS the split stage, on the reasoning that an over-merged group can be split
later but a concept scattered into leftovers is not recovered. At this fixture's size the main pass leaves
about 10 outliers, so an ungrouped leftover cannot occur; it needs a residual above 15, which the 140-row cap
does not allow. If the second check starts failing, the residual has grown past 15 and the fixture no longer
exercises this rule. The live driver asserts nothing about path 8.

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

## Reference run (generated by the validator; run 1, with the seed sweep)

- CDE catalog `endorsed`; 109 source variables; `min_cluster_size` 3 (the adapter's auto-scale)
- 14 clusters, 0 ungrouped leftovers; partition fingerprint `72dd9757118b138c`

| Cluster | Size | Cohorts | Members | Top retrieved CDEs (cosine) |
|---|---|---|---|---|
| K1 | 13 | AoU, CLSA, UKBB | AoU:disability_deaf, AoU:hearingvision_hearinglosscurrently, AoU:hearingvision_hearingvisionconditions, AoU:hearingvision_howoldwereyouhearingloss, AoU:hearingvision_rxmedsforhearingloss, CLSA:HRG_AID_TRM, CLSA:HRG_HRG_TRM, CLSA:HRG_NOIS_TRM, CLSA:VIS_SGHT_TRM, UKBB:Fractured/broken bones in last 5 years, UKBB:Hearing difficulty/problems, UKBB:Long-standing illness, disability or infirmity, UKBB:Physically abused by family as a child | Disabilities (0.519); Health Conditions - Disease Disorders (0.395); Health Conditions - Disease Disorders - Specify Other (0.337) |
| K2 | 10 | AoU, CLSA, UKBB | AoU:disability_blind, AoU:hearingvision_howoldwereyouglaucoma, CLSA:ROS_PAIN_COM, UKBB:Age asthma diagnosed, UKBB:Chest pain or discomfort, UKBB:Falls in the last year, UKBB:Felt hated by family member as a child, UKBB:Felt loved as a child, UKBB:Hearing difficulty/problems with background noise, UKBB:Nervous feelings | Disabilities (0.431); Economic Stability – Social Needs (0.336); Age (0.293) |
| K3 | 10 | AoU, CLSA, UKBB | AoU:overallhealth_emotionalproblem7days, CLSA:DEP_BOTR_COM, CLSA:DEP_BOTR_TRM, CLSA:DEP_FLDP_COM, CLSA:DEP_FLDP_TRM, CLSA:DEP_LONLY_TRM, CLSA:FAL_NMBR_NB_COM, CLSA:FAL_NMBR_NB_TRM, UKBB:Feeling down, depressed, or hopeless over the last two weeks, UKBB:Frequency of depressed mood in last 2 weeks | Usual Place of Care (0.258); Shared Living Space Number of Individuals (0.213); Economic Stability – Social Needs (0.255) |
| K4 | 10 | CLSA, UKBB | CLSA:HGT_HEIGHT_M_COM, CLSA:HWT_DHT_M_TRM, CLSA:HWT_DWT_K_TRM, CLSA:SPR_INPUT_HEIGHT_COM, CLSA:SPR_INPUT_WEIGHT_COM, CLSA:WGT_WEIGHT_KG_COM, UKBB:Height, UKBB:Standing height, UKBB:Weight, UKBB:Weight__2 | Self-Reported Health (0.284); Health Disparity Outcomes (Project Level) (0.17); Sex at Birth (0.243) |
| K5 | 9 | AoU, CLSA | AoU:hearingvision_cataractscurrently, AoU:hearingvision_glaucomacurrently, AoU:hearingvision_maculardegenerationcurrently, AoU:hearingvision_rxmedsforcataracts, AoU:hearingvision_rxmedsforglaucoma, CLSA:CCC_MACDEG_COM, CLSA:CCT_CATAR_TRM, CLSA:CCT_GLAUC_TRM, CLSA:CCT_MACDEG_TRM | Health Conditions - Disease Disorders (0.375); Health Conditions - Disease Disorders - Specify Other (0.345); Health Insurance (0.183) |
| K6 | 9 | AoU, CLSA, UKBB | AoU:overallhealth_averagefatigue7days, AoU:overallhealth_generalhealth, AoU:overallhealth_generalmentalhealth, AoU:overallhealth_generalphysicalhealth, CLSA:GEN_HLTH_COM, CLSA:GEN_HLTH_TRM, CLSA:GEN_MNTL_COM, CLSA:GEN_MNTL_TRM, UKBB:Overall health rating | Self-Reported Health (0.89); English Proficiency (0.386); Health Conditions - Disease Disorders - Specify Other (0.347) |
| K7 | 9 | AoU, CLSA, UKBB | AoU:respiratory_asthmacurrently, AoU:respiratory_respiratoryconditions, AoU:respiratory_rxmedsforasthma, CLSA:CCC_ASTHM_COM, CLSA:CCC_COPD_COM, CLSA:CCT_ASTHM_TRM, CLSA:CCT_COPD_TRM, UKBB:Doctor diagnosed COPD (chronic obstructive pulmonary disease), UKBB:Doctor diagnosed asthma | Health Conditions - Disease Disorders (0.529); Health Conditions - Disease Disorders - Specify Other (0.409); Health Conditions - Medication or Other Treatments (0.282) |
| K8 | 9 | UKBB | UKBB:Age cataract diagnosed, UKBB:Age diabetes diagnosed, UKBB:Age glaucoma diagnosed, UKBB:Age macular degeneration diagnosed, UKBB:Diabetes diagnosed by doctor, UKBB:Eye problems/disorders, UKBB:Wears glasses or contact lenses, UKBB:Which eye(s) affected by glaucoma, UKBB:Which eye(s) are affected by cataract | Health Conditions - Disease Disorders (0.373); Health Conditions - Disease Disorders - Specify Other (0.332); Age (0.281) |
| K9 | 7 | AoU, CLSA, UKBB | AoU:endocrine_endocrineconditions, AoU:endocrine_howoldwereyoutype2diabetes, AoU:endocrine_rxmedsfortype2diabetes, AoU:endocrine_type2diabetescurrently, CLSA:CCT_DIAB_TRM, CLSA:DIA_DIAB_COM, UKBB:Ever had diabetes (Type I or Type II) | Health Conditions - Disease Disorders (0.53); Health Conditions - Disease Disorders - Specify Other (0.394); Usual Place of Care (0.185) |
| K10 | 6 | AoU, CLSA, UKBB | AoU:nervoussystem_howoldwereyoumigraine, AoU:nervoussystem_migrainecurrently, AoU:nervoussystem_rxmedsformigraine, CLSA:CCC_MGRN_COM, CLSA:CCT_MGRN_TRM, UKBB:Ever had migraine | Health Conditions - Disease Disorders - Specify Other (0.258); Health Conditions - Disease Disorders (0.353); Usual Place of Care (0.181) |
| K11 | 5 | AoU, CLSA, UKBB | AoU:other_allergiescurrently, AoU:other_rxmedsforallergies, CLSA:CCC_ALLRG_COM, CLSA:CCT_ALLRG_TRM, UKBB:Doctor diagnosed hayfever or allergic rhinitis | Health Conditions - Disease Disorders - Specify Other (0.404); Health Conditions - Disease Disorders (0.392); Usual Place of Care (0.289) |
| K12 | 5 | CLSA | CLSA:MEDI_ID_NAME_SP2_1_COM, CLSA:MEDI_ID_NAME_SP2_2_COM, CLSA:MEDI_ID_NAME_SP2_3_COM, CLSA:MEDI_ID_NAME_SP2_4_COM, CLSA:MEDI_ID_NAME_SP2_5_COM | Concomitant Medication Name (0.453); Health Conditions - Medication or Other Treatments   - Specify Other (0.337); Health Conditions - Medication or Other Treatments (0.337) |
| K13 | 4 | AoU | AoU:digestive_howoldwereyouceliacdisease, AoU:infectiousdiseases_howoldwereyouchickenpox, AoU:other_howoldwereyouallergies, AoU:respiratory_howoldwereyouasthma | Self-Reported COVID-19 Diagnosis Date (0.438); Age (0.462); COVID-19 Complication Onset Date (0.261) |
| K14 | 3 | UKBB | UKBB:Frequency of tiredness / lethargy in last 2 weeks, UKBB:Loneliness, isolation, UKBB:Sleeplessness / insomnia | Disabilities (0.369); Health Conditions - Disease Disorders - Specify Other (0.276); Employment Status__2 (0.264) |

Ungrouped leftovers: none

Main-pass outliers (M10's input, 10): AoU:disability_blind, AoU:hearingvision_howoldwereyouglaucoma, CLSA:ROS_PAIN_COM, UKBB:Age asthma diagnosed, UKBB:Chest pain or discomfort, UKBB:Falls in the last year, UKBB:Felt hated by family member as a child, UKBB:Felt loved as a child, UKBB:Hearing difficulty/problems with background noise, UKBB:Nervous feelings

M10 recovered 1 group(s) of sizes [10]; the prefix re-run reproduced the pipeline's partition.

| Check | Result | Detail |
|---|---|---|
| 1 split candidate: all in ONE cluster | PASS | ['K6'] |
| 4 repeating measure: together + detected | PASS | ['K12']; detector: {'signature': 'drug or natural product name original input medication #', 'occurrences': 5, 'range': [1, 5]} |
| 6 twin pairs: each pair in one cluster | PASS | 11/11 pairs |
| 7 repeated name: every UKBB row survives | PASS | rows 35 -> variables 35 |
| 8 outlier recovery: the main pass leaves >= 1 outlier | PASS | 10 outliers |
| 8 outlier recovery: M10 recovers them as ONE group, no leftover | PASS | 1 recovered group(s) of sizes [10]; 0 leftover(s) |
| 10 eye items: >= 2 clusters | PASS | ['K1', 'K2', 'K5', 'K8'] |

UMAP-seed sweep (seeds 0..9): leftovers per seed [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

| Check | Pass rate |
|---|---|
| 1 split candidate: all in ONE cluster | 10/10 |
| 4 repeating measure: together + detected | 10/10 |
| 6 twin pairs: each pair in one cluster | 10/10 |
| 7 repeated name: every UKBB row survives | 10/10 |
| 8 outlier recovery: the main pass leaves >= 1 outlier | 10/10 |
| 8 outlier recovery: M10 recovers them as ONE group, no leftover | 10/10 |
| 10 eye items: >= 2 clusters | 10/10 |

Most frequent leftovers: 

| Path | Variable | Cluster | Top retrieved CDEs (cosine; e.g. = has "(e.g.," labels) | Unit |
|---|---|---|---|---|
| heterogeneous_split | AoU:overallhealth_generalhealth | K6 |  |  |
| heterogeneous_split | AoU:overallhealth_generalphysicalhealth | K6 |  |  |
| heterogeneous_split | AoU:overallhealth_generalmentalhealth | K6 |  |  |
| heterogeneous_split | CLSA:GEN_HLTH_TRM | K6 |  |  |
| heterogeneous_split | CLSA:GEN_HLTH_COM | K6 |  |  |
| heterogeneous_split | CLSA:GEN_MNTL_TRM | K6 |  |  |
| heterogeneous_split | CLSA:GEN_MNTL_COM | K6 |  |  |
| heterogeneous_split | UKBB:Overall health rating | K6 |  |  |
| verdict_mix | AoU:overallhealth_generalhealth | K6 | Self-Reported Health (0.856); English Proficiency (0.346); Health Conditions - Disease Disorders - Specify Other (0.393) |  |
| verdict_mix | CLSA:GEN_HLTH_TRM | K6 | Self-Reported Health (0.959); English Proficiency (0.377); Health Conditions - Disease Disorders - Specify Other (0.334) |  |
| verdict_mix | CLSA:GEN_HLTH_COM | K6 | Self-Reported Health (0.959); English Proficiency (0.377); Health Conditions - Disease Disorders - Specify Other (0.334) |  |
| verdict_mix | UKBB:Overall health rating | K6 | Self-Reported Health (0.745); English Proficiency (0.345); Household Member Size (0.312) |  |
| verdict_mix | CLSA:CCT_ASTHM_TRM | K7 | Health Conditions - Disease Disorders (0.343, e.g.); Health Conditions - Disease Disorders - Specify Other (0.26); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.228) |  |
| verdict_mix | CLSA:CCC_ASTHM_COM | K7 | Health Conditions - Disease Disorders (0.343, e.g.); Health Conditions - Disease Disorders - Specify Other (0.26); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.228) |  |
| verdict_mix | UKBB:Doctor diagnosed asthma | K7 | Health Conditions - Disease Disorders - Specify Other (0.392); Health Conditions - Disease Disorders (0.507, e.g.); Economic Stability – Social Needs (0.271) |  |
| verdict_mix | CLSA:CCT_COPD_TRM | K7 | Health Conditions - Disease Disorders (0.52, e.g.); Health Conditions - Disease Disorders - Specify Other (0.385); Health Conditions - Medication or Other Treatments (0.257, e.g.) |  |
| verdict_mix | CLSA:CCC_COPD_COM | K7 | Health Conditions - Disease Disorders (0.52, e.g.); Health Conditions - Disease Disorders - Specify Other (0.385); Health Conditions - Medication or Other Treatments (0.257, e.g.) |  |
| verdict_mix | UKBB:Doctor diagnosed COPD (chronic obstructive pulmonary disease) | K7 | Health Conditions - Disease Disorders (0.611, e.g.); Health Conditions - Disease Disorders - Specify Other (0.513); Health Conditions - Medication or Other Treatments (0.308, e.g.) |  |
| verdict_mix | CLSA:CCT_MGRN_TRM | K10 | Health Conditions - Disease Disorders (0.369, e.g.); Health Conditions - Disease Disorders - Specify Other (0.264); Usual Place of Care (0.16) |  |
| verdict_mix | CLSA:CCC_MGRN_COM | K10 | Health Conditions - Disease Disorders (0.369, e.g.); Health Conditions - Disease Disorders - Specify Other (0.264); Usual Place of Care (0.16) |  |
| verdict_mix | UKBB:Ever had migraine | K10 | Health Conditions - Disease Disorders - Specify Other (0.254); Health Conditions - Disease Disorders (0.343, e.g.); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.114) |  |
| verdict_mix | CLSA:HRG_NOIS_TRM | K1 | Disabilities (0.262); Health Disparity Outcomes (Project Level) (0.195); Shared Living Space Person Ability to Isolate Indicator (0.18) |  |
| verdict_mix | UKBB:Hearing difficulty/problems | K1 | Disabilities (0.444); Sex at Birth (0.326); Economic Stability – Social Needs (0.219) |  |
| verdict_mix | UKBB:Hearing difficulty/problems with background noise | K2 | Disabilities (0.32); Household Member Size (0.288); Shared Living Space Person Ability to Isolate Indicator (0.212) |  |
| units_arithmetic | CLSA:SPR_INPUT_HEIGHT_COM | K4 | Sex at Birth (0.192); Self-Reported Health (0.197); Health Disparity Outcomes (Project Level) (0.147) | `m` -> cm x100 |
| units_arithmetic | CLSA:HWT_DHT_M_TRM | K4 | Self-Reported Health (0.345); Health Disparity Outcomes (Project Level) (0.221); Household Member Size (0.296) | `-` (no deterministic conversion) |
| units_arithmetic | CLSA:HGT_HEIGHT_M_COM | K4 | Health Disparity Outcomes (Project Level) (0.159); NIMHD Minority Health and Health Disparities Research Framework - Levels of Influence (Project Level) (0.108); Shared Living Space Number of Individuals (0.119) | `cm` -> cm x1 |
| units_arithmetic | UKBB:Standing height | K4 | Vital Signs Measurement (0.155); Physical Exam Date (0.201); Vital Signs Type (0.129) | `cm` -> cm x1 |
| units_arithmetic | UKBB:Height | K4 | Date of Chest Examination (0.149); New Renal Replacement Therapy (0.144); Vital Signs Type (0.145) | `cm` -> cm x1 |
| units_arithmetic | UKBB:Weight | K4 | Health Disparity Outcomes (Project Level) (0.176); Vital Signs Measurement (0.149); Physical Exam Findings/Sign Type (0.231) | `Kg` -> kg x1 |
| units_arithmetic | CLSA:SPR_INPUT_WEIGHT_COM | K4 | Sex at Birth (0.21); Highest level of oxygen support received on study day (0.221); Self-Reported Health (0.162) | `kg` -> kg x1 |
| units_arithmetic | CLSA:HWT_DWT_K_TRM | K4 | Self-Reported Health (0.245); Vital Signs Type (0.166); Household Member Size (0.277) | `-` (no deterministic conversion) |
| units_arithmetic | UKBB:Age diabetes diagnosed | K8 | Age Units__2 (0.408); Household Member Size (0.275); Health Conditions - Disease Disorders - Specify Other (0.214) | `years` -> year x1 |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_1_COM | K12 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_2_COM | K12 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_3_COM | K12 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_4_COM | K12 |  |  |
| wide_to_long | CLSA:MEDI_ID_NAME_SP2_5_COM | K12 |  |  |
| missing_data_codes | UKBB:Ever had migraine | K10 |  |  |
| missing_data_codes | UKBB:Ever had diabetes (Type I or Type II) | K9 |  |  |
| missing_data_codes | UKBB:Feeling down, depressed, or hopeless over the last two weeks | K3 |  |  |
| missing_data_codes | UKBB:Frequency of depressed mood in last 2 weeks | K3 |  |  |
| missing_data_codes | UKBB:Diabetes diagnosed by doctor | K8 |  |  |
| many_to_one_same_cohort | CLSA:GEN_HLTH_TRM | K6 |  |  |
| many_to_one_same_cohort | CLSA:GEN_HLTH_COM | K6 |  |  |
| many_to_one_same_cohort | CLSA:CCT_MGRN_TRM | K10 |  |  |
| many_to_one_same_cohort | CLSA:CCC_MGRN_COM | K10 |  |  |
| many_to_one_same_cohort | CLSA:DEP_BOTR_TRM | K3 |  |  |
| many_to_one_same_cohort | CLSA:DEP_BOTR_COM | K3 |  |  |
| many_to_one_same_cohort | CLSA:CCT_ASTHM_TRM | K7 |  |  |
| many_to_one_same_cohort | CLSA:CCC_ASTHM_COM | K7 |  |  |
| many_to_one_same_cohort | CLSA:CCT_DIAB_TRM | K9 |  |  |
| many_to_one_same_cohort | CLSA:DIA_DIAB_COM | K9 |  |  |
| many_to_one_same_cohort | CLSA:GEN_MNTL_TRM | K6 |  |  |
| many_to_one_same_cohort | CLSA:GEN_MNTL_COM | K6 |  |  |
| many_to_one_same_cohort | CLSA:CCT_COPD_TRM | K7 |  |  |
| many_to_one_same_cohort | CLSA:CCC_COPD_COM | K7 |  |  |
| many_to_one_same_cohort | CLSA:CCT_ALLRG_TRM | K11 |  |  |
| many_to_one_same_cohort | CLSA:CCC_ALLRG_COM | K11 |  |  |
| many_to_one_same_cohort | CLSA:DEP_FLDP_TRM | K3 |  |  |
| many_to_one_same_cohort | CLSA:DEP_FLDP_COM | K3 |  |  |
| many_to_one_same_cohort | CLSA:FAL_NMBR_NB_TRM | K3 |  |  |
| many_to_one_same_cohort | CLSA:FAL_NMBR_NB_COM | K3 |  |  |
| many_to_one_same_cohort | CLSA:CCT_MACDEG_TRM | K5 |  |  |
| many_to_one_same_cohort | CLSA:CCC_MACDEG_COM | K5 |  |  |
| duplicate_variable_name | UKBB:Weight | K4 |  |  |
| duplicate_variable_name | UKBB:Weight__2 | K4 |  |  |
| ungrouped_leftovers | AoU:hearingvision_howoldwereyouglaucoma | K2 |  |  |
| ungrouped_leftovers | AoU:hearingvision_rxmedsforglaucoma | K5 |  |  |
| ungrouped_leftovers | CLSA:ROS_PAIN_COM | K2 |  |  |
| ungrouped_leftovers | UKBB:Chest pain or discomfort | K2 |  |  |
| ungrouped_leftovers | UKBB:Felt loved as a child | K2 |  |  |
| ungrouped_leftovers | UKBB:Fractured/broken bones in last 5 years | K1 |  |  |
| ungrouped_leftovers | UKBB:Long-standing illness, disability or infirmity | K1 |  |  |
| eg_permissible_values | CLSA:CCT_DIAB_TRM | K9 | Health Conditions - Disease Disorders (0.532, e.g.); Health Conditions - Disease Disorders - Specify Other (0.361); Self-Reported Health (0.245) |  |
| eg_permissible_values | CLSA:DIA_DIAB_COM | K9 | Health Conditions - Disease Disorders (0.532, e.g.); Health Conditions - Disease Disorders - Specify Other (0.361); Self-Reported Health (0.245) |  |
| eg_permissible_values | UKBB:Diabetes diagnosed by doctor | K8 | Health Conditions - Disease Disorders - Specify Other (0.315); Health Conditions - Disease Disorders (0.445, e.g.); Usual Place of Care (0.239) |  |
| eg_permissible_values | UKBB:Ever had diabetes (Type I or Type II) | K9 | Health Conditions - Disease Disorders (0.446, e.g.); Health Conditions - Disease Disorders - Specify Other (0.301); Self-Reported COVID-19 Diagnosis Occurrence Indicator (0.152) |  |
| eg_permissible_values | AoU:endocrine_endocrineconditions | K9 | Health Conditions - Disease Disorders - Specify Other (0.513); Health Conditions - Disease Disorders (0.509, e.g.); Usual Place of Care (0.275) |  |
| eg_permissible_values | AoU:respiratory_respiratoryconditions | K7 | Health Conditions - Disease Disorders - Specify Other (0.398); Health Conditions - Disease Disorders (0.545, e.g.); Economic Stability – Social Needs (0.306) |  |
| eye_conditions_spread | CLSA:CCT_GLAUC_TRM | K5 |  |  |
| eye_conditions_spread | CLSA:CCT_CATAR_TRM | K5 |  |  |
| eye_conditions_spread | CLSA:CCT_MACDEG_TRM | K5 |  |  |
| eye_conditions_spread | CLSA:VIS_SGHT_TRM | K1 |  |  |
| eye_conditions_spread | UKBB:Eye problems/disorders | K8 |  |  |
| eye_conditions_spread | UKBB:Age glaucoma diagnosed | K8 |  |  |
| eye_conditions_spread | UKBB:Age cataract diagnosed | K8 |  |  |
| eye_conditions_spread | UKBB:Which eye(s) affected by glaucoma | K8 |  |  |
| eye_conditions_spread | UKBB:Wears glasses or contact lenses | K8 |  |  |
| eye_conditions_spread | AoU:hearingvision_glaucomacurrently | K5 |  |  |
| eye_conditions_spread | AoU:hearingvision_rxmedsforcataracts | K5 |  |  |
| eye_conditions_spread | AoU:disability_blind | K2 |  |  |
| score_components | UKBB:Falls in the last year | K2 |  |  |
| score_components | UKBB:Hearing difficulty/problems | K1 |  |  |
| score_components | UKBB:Chest pain or discomfort | K2 |  |  |
| score_components | UKBB:Diabetes diagnosed by doctor | K8 |  |  |
| score_components | UKBB:Eye problems/disorders | K8 |  |  |
| score_components | UKBB:Overall health rating | K6 |  |  |
| score_components | UKBB:Long-standing illness, disability or infirmity | K1 |  |  |
| score_components | UKBB:Frequency of tiredness / lethargy in last 2 weeks | K14 |  |  |
| score_components | UKBB:Loneliness, isolation | K14 |  |  |
| score_components | UKBB:Nervous feelings | K2 |  |  |
| score_components | UKBB:Sleeplessness / insomnia | K14 |  |  |
| score_components | UKBB:Fractured/broken bones in last 5 years | K1 |  |  |
