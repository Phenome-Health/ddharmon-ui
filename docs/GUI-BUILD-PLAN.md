# ddharmon-ui — v1.0 GUI build plan

**Status:** Active · **Authored:** 2026-06-30 · **Owner:** Bhargav
**Goal:** Make `ddharmon-ui` the functional + deployed GUI that the coupled `ddharmon 1.0.0` tag waits on.
**Companion:** `../ph-arpa-data-harmonization/.planning/V1.0-ROADMAP.md` (the package-side roadmap).

---

## 1. The governing constraint — insulate the GUI from pipeline churn

> "Underlying changes to the ddharmon flow shouldn't necessitate any major changes to the GUI."

The GUI *depends on* ddharmon — that dependency is real and can't be wished away. What we **can** do is
route the entire dependency through **one narrow, versioned seam**, so that churn in the pipeline
(cohort count, cluster size, retrieval knobs, record-field renames, even an engine swap) is absorbed in a
single mapping function instead of rippling into the backend endpoints and the frontend.

```
ddharmon  (churns:  harmonize_leanb internals, LeanBRecord fields, knobs)
   │   imported in EXACTLY ONE place ↓
   ▼
backend/engine/adapter.py   ── drives harmonize_leanb by INJECTING per-stage callbacks
   │                           (never re-implements the pipeline) and maps
   │                           LeanBRecord ──► UIRecord  (the single churn-absorbing fn)
   ▼
backend/engine/contract.py  ── UIRecord / UITransform / UIResult  (UI-owned, versioned)   ◄── THE BOUNDARY
   │   JSON over HTTP (stable URLs)
   ▼
frontend/src/types.ts       ── mirrors the contract; views render UIRecord
```

### Why the v1 runner failed this test (and what we change)
The current `backend/runner.py` **re-implements** the pipeline inline:
`load → embed → topic_model_dictionaries → prepare_from_clusters → assemble_verdicts`. Every one of those
calls is an internal ddharmon surface; any change to the flow breaks the runner. That is exactly the
coupling we're removing.

`harmonize_leanb(embedded_dicts, *, generate, split, classify, specgen, **knobs)` already **owns** the
staged orchestration (cluster → retrieve → generate-ideal → split → per-group assign → route → specs) and
exposes each LLM stage as an **injectable callback**. The adapter therefore only:
1. loads + embeds the dictionaries (so it can report load/embed progress), then
2. calls `harmonize_leanb(...)` passing **our** `generate/split/classify/specgen` callbacks — each callback
   is just "run these prompts sync, or via the Batch API" + report progress, and
3. maps the returned `LeanBRecord`s into `UIRecord`s.

If ddharmon adds/removes/renames a stage, the change lands in `harmonize_leanb`'s signature; we add/remove
one callback. If `LeanBRecord` gains/loses a field, only `_to_ui_record()` changes. The contract and the
whole frontend stay still.

### What this insulates — and what it honestly can't
| ddharmon change | GUI impact |
|---|---|
| cohort count, `min_cluster_size`, `top_k`, `retrieval_floor`, `model_tag` | **none** — config passthrough (run-options form is schema-driven) |
| `LeanBRecord` field rename / reshape | only `_to_ui_record()` in `adapter.py` |
| new/removed pipeline **stage** | one callback in `adapter.py`; progress phases are reported by the adapter (data-driven), not hard-coded in the UI |
| engine swap (v2 → v3) | swap the adapter body; contract + frontend unchanged |
| a genuinely **new output concept** (new verdict class, row-level data, new artifact) | needs an *additive* contract bump (`contractVersion`) + UI extension — this is the irreducible residue, made explicit by versioning rather than silent |

---

## 2. Decisions (confirmed 2026-06-30)
1. **Engine coupling** — v2 `harmonize_leanb` via the stable adapter above. (Not v1.)
2. **Run mode** — **Batch API is the deployed default** (async, cost-bounded); **sync** inline for quick
   small runs; **preview** (prepare-only, no LLM/key: cluster + retrieve + downloadable prompts) as the
   zero-cost path. Replaces v1's `classifyMode none|sync|batch`.
3. **Design system** — shared **Phenome Health Design System**, mirrored from `biomapper-ui` (dev branch).
   *Already seeded:* `frontend/src/index.css` is byte-identical to biomapper-ui's. Remaining work = match
   its component/layout patterns, not bootstrap a system.
4. **Persistence** — in-memory job store stays for single-user v1 (lost on restart). Batch runs can be
   long; that's acceptable for v1. (SQLite is a 1.x option.)

---

## 3. The contract (v1 of `contractVersion`)
`UIRecord` (mapped from `LeanBRecord`): `id, clusterId, groupId, concept, verdict (adopt|refine|novel|
unclassified), route (assigned|gencde_residual), cde {id, externalId}|null, idealCde,
cosines {top1, chosen}, coverageGap, floored, crossCohort, nMembers, cohorts[], members[],
transforms[UITransform], rationale, decidedBy`.

`UITransform` (subset of `TransformSpec`, kind-tagged): `sourceVariable, targetCdeId, kind, confidence,
coverage, needsUnits, needsData, needsReview, rationale` + kind-specific (`codeMap`/`factor`+`offset`+
units / `formula`+`inputs` / `method`+`params`).

`UIResult`: `contractVersion, mode, phases[], records[], summary {nRecords, counts{verdict→n},
nCrossCohort, nAssigned, nGencdeResidual, nWithTransforms, cohorts[]}, prompts {ideal, split, groupAssign,
specgen}` (counts; populated for preview/transparency).

Human decisions stay **separate** from records (`job.decisions[recordId] = {decision, note}`) so re-running
the engine never clobbers review state.

---

## 4. Phases & sequencing
- **P0 — Backend insulation layer** *(this is the "start")* — `engine/contract.py` + `engine/adapter.py`,
  rewire `runner.py`/`app.py`/`jobs.py` to the contract, rewrite `tests/test_backend.py` (monkeypatch the
  stage callbacks — no model download / API key). `check.sh` green.
- **P1 — Frontend to the contract** — `types.ts` mirrors the contract; three views: **Configure** (upload,
  column-role mapping, run config incl. `runMode`), **Run** (data-driven live progress from reported
  phases), **Review** (records grouped by verdict; concept / CDE / cosines / transforms; approve / refine /
  reject; export EITL TSV / records JSON / decisions CSV).
- **P2 — Design system pass** — apply biomapper-ui component/layout patterns over the shared tokens.
- **P3 — Deploy (user-gated)** — Lightsail + Squarespace; repin `ddharmon` dep to public PyPI; flip
  repo public — the coupled 1.0.0 moment.

P0+P1 reach "functional end-to-end against v2." P2 makes it presentable. P3 is the long pole.
