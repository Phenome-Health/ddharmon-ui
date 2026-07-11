"""The engine adapter — the ONLY module that imports the ddharmon pipeline.

This is the churn-absorbing layer (the insulation boundary). It does **not** re-implement the
harmonization flow — that was an earlier runner's mistake. ``harmonize_leanb`` already owns the staged
orchestration (cluster → retrieve → generate-ideal → split → per-group assign → route → specs) and
exposes each LLM stage as an *injectable callback*. So this adapter only:

  1. loads + embeds the dictionaries (so it can report load/embed progress), then
  2. calls ``harmonize_leanb(embedded, generate=…, split=…, classify=…, specgen=…)`` passing **our**
     callbacks — each callback just runs its prompts (sync inline, or via the Batch API) and reports
     progress, and
  3. maps the returned ``LeanBRecord``s into the stable ``UIRecord`` contract.

When the pipeline churns, the blast radius is confined here: a record-field rename touches
``_record_to_ui``; a new/removed stage touches one callback wiring line; an engine swap replaces this
file's body. The contract (and the whole frontend) is unaffected.

Run modes:
  * ``batch``   — every LLM stage via the Anthropic Batch API (async, cost-bounded). The deployed default.
  * ``sync``    — every LLM stage inline (needs ``ANTHROPIC_API_KEY``); fast for small runs.
  * ``preview`` — no LLM/key: cluster + retrieve + build the generate prompts, expose their counts. Yields
                  no records (the pipeline needs the LLM to decide anything) — the zero-cost "what would run" path.

The pipeline **requires a CDE backbone** (assignment to the given CDE catalog is the thesis); there is no
``cdeSet=none`` path.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from backend.engine.contract import (
    CONTRACT_VERSION,
    PHASES_PREVIEW,
    PHASES_RUN,
    AtlasPoint,
    FieldDetail,
    ResponseOptionUI,
    UICandidate,
    UIMember,
    UIRecord,
    UIResult,
    UISummary,
    UITransform,
    UnassignedField,
    empty_summary,
)

logger = logging.getLogger(__name__)

# (phase, completed, total) -> None. Reported between stages and within sync stages.
ProgressFn = Callable[[str, int, int], None]
# list[PromptRecord] -> {id: response}. The execution strategy injected per stage.
StageFn = Callable[[list[Any]], dict[str, Any]]

# Same instruction the Batch API appends server-side, so inline (sync) output matches the schema.
_SCHEMA_PREAMBLE = "\n\nRespond with ONLY valid JSON matching this schema (no markdown fences):\n"
_SYNC_MAX_TOKENS = 1024


def _noop_progress(phase: str, completed: int = 0, total: int = 0) -> None:
    pass


# ── ddharmon -> contract mapping (the single churn-absorbing surface) ──────────────────────


def _transform_to_ui(t: Any) -> UITransform:
    """Map one ``TransformSpec`` to a ``UITransform`` (kind-specific keys only when populated)."""
    ui: UITransform = {
        "sourceVariable": t.source_variable,
        "targetCdeId": t.target_cde_id,
        "kind": str(t.kind),  # TransformKind is a StrEnum
        "confidence": t.confidence,
        "coverage": t.coverage,
        "needsUnits": t.needs_units,
        "needsData": t.needs_data,
        "needsReview": t.needs_review,
        "rationale": t.rationale,
        "generatedBy": t.generated_by,
    }
    if t.code_map:
        ui["codeMap"] = dict(t.code_map)
    if t.unmapped_source_codes:
        ui["unmappedSourceCodes"] = list(t.unmapped_source_codes)
    if t.factor is not None:
        ui["factor"] = t.factor
    if t.offset is not None:
        ui["offset"] = t.offset
    if t.source_unit:
        ui["sourceUnit"] = t.source_unit
    if t.target_unit:
        ui["targetUnit"] = t.target_unit
    if t.formula:
        ui["formula"] = t.formula
    if t.inputs:
        ui["inputs"] = list(t.inputs)
    if t.method:
        ui["method"] = t.method
    if t.params:
        ui["params"] = dict(t.params)
    return ui


def _candidate_to_ui(c: Any) -> UICandidate:
    return {
        "rank": c.rank,
        "cdeId": c.cde_id,
        "cdeExternalId": c.cde_external_id or "",
        "definition": c.definition,
        "cosine": c.cosine,
        "isChosen": c.is_chosen,
        "llmSuggested": c.llm_suggested,
    }


def _member_ui(member_id: str, index: dict[str, UIMember]) -> UIMember:
    """Resolve a ``cohort:var`` id to a :class:`UIMember` (name + text), falling back to the id parts when
    the field isn't in ``index`` (e.g. a snapshot enriched later, or a test record with no dictionaries)."""
    hit = index.get(member_id)
    if hit is not None:
        return hit
    cohort, _, var = member_id.partition(":")
    name = var or member_id
    return {"id": member_id, "cohort": cohort, "name": name, "text": name}


def build_member_index(embedded: list[Any]) -> dict[str, UIMember]:
    """Build a ``{"cohort:var" -> UIMember}`` lookup from the embedded dictionaries.

    ``text`` is the field's human text (description / question_text / short_label) — the signal that was
    embedded and clustered — so the review UI can show what each concept actually pooled, not opaque ids.
    """
    index: dict[str, UIMember] = {}
    for ed in embedded:
        dd = getattr(ed, "dictionary", None)
        if dd is None:
            continue
        cohort = getattr(dd, "cohort_name", None) or getattr(dd, "name", None) or "?"
        for var, fld in getattr(dd, "fields", {}).items():
            # When a source has no description column, load_dictionary backfills description = variable_name;
            # that echoes the opaque id, so prefer the question/short-label text (what a survey field actually
            # asks) before falling back — otherwise the UI shows codes like "smoking_100cigslifetime".
            desc = getattr(fld, "description", None)
            if desc == var:
                desc = None
            text = desc or getattr(fld, "question_text", None) or getattr(fld, "short_label", None) or var
            key = f"{cohort}:{var}"
            index[key] = {"id": key, "cohort": cohort, "name": var, "text": text}
    return index


def _response_option_ui(o: Any) -> ResponseOptionUI:
    """Map one ``ResponseOption`` (code/label/order) to its UI dict; ``order`` only when the source had one."""
    ui: ResponseOptionUI = {"code": getattr(o, "code", "") or "", "label": getattr(o, "label", "") or ""}
    order = getattr(o, "order", None)
    if order is not None:
        ui["order"] = order
    return ui


def _field_detail(var: str, fld: Any) -> FieldDetail:
    """Map one canonical ``Field`` to a :class:`FieldDetail` (raw attrs; a key only when its value is present).

    ``text`` uses the same derivation as :func:`build_member_index` (description → question_text →
    short_label → variable_name). ``description`` echoing the variable name (a loader backfill) is dropped so
    the UI never shows an opaque id as the field's description — mirroring the ``text`` fallback.
    """
    desc = getattr(fld, "description", None)
    if desc == var:
        desc = None
    qtext = getattr(fld, "question_text", None)
    short = getattr(fld, "short_label", None)
    detail: FieldDetail = {"name": var, "text": desc or qtext or short or var}
    if desc:
        detail["description"] = desc
    if qtext:
        detail["questionText"] = qtext
    enc = getattr(fld, "value_encoding_raw", None)
    if enc:
        detail["valueEncoding"] = enc
    units = getattr(fld, "units", None)
    if units:
        detail["units"] = units
    dtype = getattr(fld, "data_type", None)
    if dtype:
        detail["dataType"] = dtype
    opts = getattr(fld, "response_options", None)
    if opts:
        detail["responseOptions"] = [_response_option_ui(o) for o in opts]
    return detail


def build_field_index(embedded: list[Any], cde_cohort: str) -> dict[str, FieldDetail]:
    """Build a ``{"cohort:var" -> FieldDetail}`` map over EVERY embedded NON-CDE (source) field.

    Same field set the atlas iterates (the CDE cohort is the assignment backbone, not a source field, so it's
    excluded), but UNCAPPED — this is a lookup, not plotted points. Each entry carries the field's read-in
    attributes so the UI can show full per-field detail (and browse fields that never landed in a concept).
    """
    index: dict[str, FieldDetail] = {}
    for ed in embedded:
        dd = getattr(ed, "dictionary", None)
        if dd is None:
            continue
        cohort = getattr(dd, "cohort_name", None) or getattr(dd, "name", None) or "?"
        if cohort == cde_cohort:
            continue
        for var, fld in getattr(dd, "fields", {}).items():
            index[f"{cohort}:{var}"] = _field_detail(var, fld)
    return index


def _unassigned_fields(
    field_index: dict[str, FieldDetail], records: list[UIRecord], atlas: list[AtlasPoint]
) -> list[UnassignedField]:
    """Source fields present in the field index but in NO record's members (unclustered / dropped outliers).

    ``x``/``y`` are attached only when the field is in the (downsampled) atlas sample; this list is uncapped.
    """
    assigned: set[str] = set()
    for r in records:
        assigned.update(r["members"])
    coords = {f"{p['cohort']}:{p['variable']}": (p["x"], p["y"]) for p in atlas}
    out: list[UnassignedField] = []
    for key, detail in field_index.items():
        if key in assigned:
            continue
        cohort, _, variable = key.partition(":")
        uf: UnassignedField = {"cohort": cohort, "variable": variable, "text": detail.get("text", "")}
        xy = coords.get(key)
        if xy is not None:
            uf["x"] = xy[0]
            uf["y"] = xy[1]
        out.append(uf)
    return out


def _record_to_ui(r: Any, member_index: dict[str, UIMember]) -> UIRecord:
    """Map one ``LeanBRecord`` to a ``UIRecord``. The single function that knows the record's field names."""
    return {
        "id": r.group_id or r.cluster_id,
        "clusterId": r.cluster_id,
        "groupId": r.group_id,
        "concept": r.concept,
        "verdict": r.verdict or "unclassified",
        "route": r.route,
        "cde": {"id": r.cde_id, "externalId": r.cde_external_id or ""} if r.cde_id else None,
        "idealCde": r.ideal_cde,
        "cosines": {"top1": r.top1_cos, "chosen": r.chosen_cos},
        "coverageGap": r.coverage_gap,
        "floored": r.floored,
        "crossCohort": r.cross_cohort,
        "nMembers": r.n_members,
        "cohorts": list(r.cohorts),
        "members": list(r.member_variable_names),
        "memberDetails": [_member_ui(m, member_index) for m in r.member_variable_names],
        "transforms": [_transform_to_ui(t) for t in r.transforms],
        "candidates": [_candidate_to_ui(c) for c in r.candidates],
        "rationale": r.rationale,
        "decidedBy": r.decided_by,
    }


def _summarize(records: list[UIRecord]) -> UISummary:
    if not records:
        return empty_summary()
    counts: dict[str, int] = {}
    cohorts: set[str] = set()
    for r in records:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
        cohorts.update(r["cohorts"])
    return {
        "nRecords": len(records),
        "counts": counts,
        "nCrossCohort": sum(1 for r in records if r["crossCohort"]),
        "nAssigned": sum(1 for r in records if r["route"] == "assigned"),
        "nGencdeResidual": sum(1 for r in records if r["route"] == "gencde_residual"),
        "nWithTransforms": sum(1 for r in records if r["transforms"]),
        "cohorts": sorted(cohorts),
    }


def build_ui_result(
    leanb_result: Any,
    *,
    mode: str,
    phases: list[str],
    atlas: list[AtlasPoint] | None = None,
    member_index: dict[str, UIMember] | None = None,
    field_index: dict[str, FieldDetail] | None = None,
) -> UIResult:
    """Map a ``LeanBResult`` to the stable ``UIResult`` contract.

    ``member_index`` (from :func:`build_member_index`) enriches each record's ``memberDetails`` with the
    source field text; when omitted, member details fall back to the ``cohort:var`` id parts.

    ``field_index`` (from :func:`build_field_index`) is the uncapped per-field detail map surfaced as
    ``fieldIndex``; it also drives ``unassignedFields`` (its keys MINUS the union of record member keys). When
    omitted, both are empty (e.g. canned-record tests with no dictionaries).
    """
    idx = member_index or {}
    fidx = field_index or {}
    atlas_pts = atlas or []
    records = [_record_to_ui(r, idx) for r in leanb_result.records]
    return {
        "contractVersion": CONTRACT_VERSION,
        "mode": mode,
        "phases": phases,
        "records": records,
        "summary": _summarize(records),
        "prompts": {
            "ideal": len(leanb_result.ideal_prompts),
            "split": len(leanb_result.split_prompts),
            "groupAssign": len(leanb_result.group_assign_prompts),
            "specgen": len(leanb_result.specgen_prompts),
        },
        "atlas": atlas_pts,
        "fieldIndex": fidx,
        "unassignedFields": _unassigned_fields(fidx, records, atlas_pts),
    }


def _atlas_points(embedded: list[Any], cde_cohort: str, cap: int = 2500) -> list[AtlasPoint]:
    """Project every (non-CDE) field's embedding to 2D via PCA (SVD) for the cohort-colored atlas.

    Deterministic (no random init). Downsamples evenly to ``cap`` points so the scatter stays responsive.
    Returns [] when there are too few fields to project.
    """
    import numpy as np

    vecs: list[Any] = []
    meta: list[tuple[str, str]] = []
    for ed in embedded:
        dd = getattr(ed, "dictionary", None)
        name = getattr(dd, "cohort_name", None) or getattr(dd, "name", None) or "?"
        if name == cde_cohort:
            continue
        names = list(ed.get_variable_names())
        if not names:  # an empty dictionary would make get_all_vectors() np.stack([]) and raise
            continue
        mat = np.asarray(ed.get_all_vectors(), dtype=np.float32)
        for v, row in zip(names, mat, strict=False):
            vecs.append(row)
            meta.append((name, v))
    if len(vecs) < 3:
        return []
    matrix = np.asarray(vecs, dtype=np.float32)
    if len(matrix) > cap:
        idx = np.linspace(0, len(matrix) - 1, cap).astype(int)
        matrix = matrix[idx]
        meta = [meta[i] for i in idx]
    centered = matrix - matrix.mean(axis=0)
    _u, _s, vt = np.linalg.svd(centered, full_matrices=False)
    coords = centered @ vt[:2].T
    return [
        {
            "cohort": meta[i][0],
            "variable": meta[i][1],
            "x": round(float(coords[i, 0]), 4),
            "y": round(float(coords[i, 1]), 4),
        }
        for i in range(len(meta))
    ]


# ── stage execution strategies (sync inline / Batch API) ──────────────────────────────────


def _sync_stage(phase: str, progress: ProgressFn, client: Any) -> StageFn:
    """A stage callback that runs each prompt inline via the Anthropic client, reporting per-item progress."""

    def stage(prompts: list[Any]) -> dict[str, Any]:
        if not prompts:
            return {}
        n = len(prompts)
        progress(phase, 0, n)
        out: dict[str, Any] = {}
        for i, rec in enumerate(prompts):
            system = rec.system_prompt + _SCHEMA_PREAMBLE + rec.schema
            out[rec.id] = client.complete(rec.user_prompt, system=system, max_tokens=_SYNC_MAX_TOKENS)
            progress(phase, i + 1, n)
        return out

    return stage


def _batch_stage(phase: str, progress: ProgressFn, work_dir: Path, tag: str, api_key: str | None = None) -> StageFn:
    """A stage callback that runs all prompts through the Anthropic Batch API (blocking poll).

    Uses ``resume_and_wait`` (cache-aware): an existing ``responses_<tag>.jsonl`` is reused as-is and only
    missing ids are (re)submitted — so a re-run over a frozen work_dir is a byte-identical, $0 replay, and an
    interrupted batch resumes instead of re-paying. ``api_key`` (optional) is the per-request BYOK key.
    """

    def stage(prompts: list[Any]) -> dict[str, Any]:
        if not prompts:
            return {}
        from ddharmon.harmonization import write_prompts_jsonl
        from ddharmon.llm.batch import resume_and_wait

        n = len(prompts)
        progress(phase, 0, n)
        work_dir.mkdir(parents=True, exist_ok=True)
        prompts_path = work_dir / f"prompts_{tag}.jsonl"
        responses_path = work_dir / f"responses_{tag}.jsonl"
        write_prompts_jsonl(prompts, prompts_path)
        resume_and_wait(prompts_path, responses_path, api_key=api_key)
        out: dict[str, Any] = {}
        with open(responses_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    rec = json.loads(line)
                    out[rec["id"]] = rec["response"]
        progress(phase, n, n)
        return out

    return stage


# ── entry point ────────────────────────────────────────────────────────────────────────────


def _auto_min_cluster_size(n_fields: int) -> int:
    """A sensible HDBSCAN ``min_cluster_size`` scaled to corpus size.

    Users no longer set this — clustering is a coarse scaffold that the split-aware stages (split → per-group
    assign → merge) re-partition, so it only needs to be *reasonable*: small uploads get a low floor so
    concepts still form (a big mcs on a tiny set would make everything an outlier), large cohorts cap at the
    long-standing default of 15. Explicit ``min_cluster_size`` in the run config always wins over this.
    """
    return max(3, min(15, round(n_fields / 150)))


def _save_substrate_if_new(substrate_path: Path | None, result: Any) -> None:
    """Persist the freshly-built clustering partition for reproducible replay.

    Only writes when a path was requested AND the file doesn't exist yet — a reload run leaves the frozen
    file untouched. ``result.substrate`` is the ``ClusteringSubstrate`` ``harmonize_leanb`` builds.
    """
    if substrate_path and not substrate_path.exists() and getattr(result, "substrate", None) is not None:
        from ddharmon.harmonization.substrate import save_substrate

        substrate_path.parent.mkdir(parents=True, exist_ok=True)
        save_substrate(result.substrate, substrate_path)


def run_pipeline(
    dict_specs: list[dict[str, Any]],
    cde_spec: dict[str, Any] | None,
    config: dict[str, Any],
    *,
    progress: ProgressFn | None = None,
    provider: Any | None = None,
    stage_overrides: dict[str, StageFn] | None = None,
    api_key: str | None = None,
    substrate_path: str | Path | None = None,
) -> UIResult:
    """Run the pipeline end-to-end and return a contract :class:`UIResult`. Safe to run in a thread.

    Args:
        dict_specs: ``[{path, cohort_name, column_roles}]`` for the uploaded cohort dictionaries.
        cde_spec:   ``{path, cohort_name, column_roles}`` for the CDE catalog (REQUIRED for sync/batch).
        config:     ``{run_mode, cde_cohort, work_dir, min_cluster_size?, top_k?, retrieval_floor?,
                    model_tag?, gen_transform_specs?}``. Unset knobs fall back to ``harmonize_leanb`` defaults.
        progress:   ``(phase, completed, total)`` callback (wired to the JobStore by the runner).
        provider:   embedding provider (defaults to ``SentenceTransformerProvider``; injected in tests).
        stage_overrides: ``{generate, split, classify, specgen}`` stage callbacks (injected in tests to
                    avoid any LLM/network); when given, the run_mode strategy is bypassed.
        api_key:    optional per-request BYOK Anthropic key, passed straight to the core client
                    constructors (sync ``AnthropicClient`` / batch ``resume_and_wait``). ``None`` keeps the
                    default ``ANTHROPIC_API_KEY`` env behavior. In-memory only — never persisted or logged.
        substrate_path: optional path to a frozen clustering substrate for reproducibility. When the file
                    exists it is reloaded (UMAP skipped, the exact partition reproduced); after a fresh run the
                    built partition is saved there. Combined with the cache-aware batch stages, a re-run over
                    the same ``work_dir`` + ``substrate_path`` is byte-identical. Unused by normal per-job runs.
    """
    from ddharmon.embedding.service import embed_dictionary
    from ddharmon.harmonization import harmonize_leanb
    from ddharmon.ingestion import load_dictionary

    progress = progress or _noop_progress
    overrides = stage_overrides or {}
    mode: str = config.get("run_mode", "batch")
    cde_cohort: str = config.get("cde_cohort", "NIH_CDE")
    work_dir = Path(config.get("work_dir", "."))

    # --- load ---
    progress("loading", 0, 0)
    specs = list(dict_specs) + ([cde_spec] if cde_spec else [])
    dictionaries = [load_dictionary(s["path"], cohort_name=s["cohort_name"], **s["column_roles"]) for s in specs]

    # --- embed ---
    total = len(dictionaries)
    progress("embedding", 0, total)
    if provider is None:
        from ddharmon.embedding.provider import SentenceTransformerProvider

        provider = SentenceTransformerProvider()
    embedded = []
    for i, dd in enumerate(dictionaries):
        embedded.append(embed_dictionary(dd, provider=provider))
        progress("embedding", i + 1, total)

    # Guard: an uploaded file with only a header row (or columns that didn't map to a variable/description/
    # question) embeds to ZERO fields. Downstream `get_all_vectors()`/`collect_inputs()` would then `np.stack([])`
    # -> "need at least one array to stack". Drop such empty dictionaries, and if nothing usable remains, fail
    # with a clear, actionable message instead of a cryptic numpy error.
    def _n_fields(ed: Any) -> int:
        return len(list(ed.get_variable_names()))

    empty = [ed for ed in embedded if _n_fields(ed) == 0]
    if empty:
        dropped = sorted(
            getattr(ed.dictionary, "cohort_name", None) or getattr(ed.dictionary, "name", "?") for ed in empty
        )
        logger.warning("dropping %d dictionary(ies) with no usable fields: %s", len(empty), ", ".join(dropped))
        embedded = [ed for ed in embedded if _n_fields(ed) > 0]
    if not any(_n_fields(ed) > 0 for ed in embedded if getattr(ed.dictionary, "cohort_name", None) != cde_cohort):
        raise ValueError(
            "No usable fields found in the uploaded dictionaries. Check that each file has at least one data "
            "row and that its columns are mapped to a variable name and/or a description/question."
        )

    # 2D projection of the field space for the embedding atlas (cheap, deterministic; no core dependency).
    atlas = _atlas_points(embedded, cde_cohort)

    # {"cohort:var" -> UIMember} so each concept's records carry the source fields (name + text) they pooled.
    member_index = build_member_index(embedded)

    # {"cohort:var" -> FieldDetail} over every source field (uncapped) — full per-field detail for the UI and
    # the basis for unassignedFields (source fields that land in no concept). CDE cohort excluded (backbone).
    field_index = build_field_index(embedded, cde_cohort)

    # --- knobs: passthrough only (absent -> harmonize_leanb's own defaults). New knobs need no GUI change. ---
    kwargs: dict[str, Any] = {"cde_cohort": cde_cohort}
    for key in ("min_cluster_size", "top_k", "retrieval_floor", "model_tag"):
        if config.get(key) is not None:
            kwargs[key] = config[key]

    # min_cluster_size is no longer a user knob — auto-scale a coarse scaffold from the (non-CDE) corpus size
    # when the config didn't pin one. The split-aware stages re-derive concepts, so this only needs to be
    # reasonable; an explicit value (advanced/API callers, or the demo build) still wins.
    if "min_cluster_size" not in kwargs:
        n_fields = sum(len(dd.fields) for dd in dictionaries if getattr(dd, "cohort_name", None) != cde_cohort)
        kwargs["min_cluster_size"] = _auto_min_cluster_size(n_fields)

    # --- reproducibility: reload a frozen clustering substrate if one exists (skip UMAP, reproduce the exact
    #     partition). After a fresh run the built partition is saved (see _save_substrate_if_new). ---
    substrate_path = Path(substrate_path) if substrate_path else None
    if substrate_path and substrate_path.exists():
        from ddharmon.harmonization.substrate import load_substrate

        kwargs["substrate"] = load_substrate(substrate_path)

    # --- preview: no LLM. generate=None makes harmonize_leanb stop after building the generate prompts. ---
    if mode == "preview" and not overrides:
        progress("clustering", 0, 0)
        result = harmonize_leanb(embedded, **kwargs)
        _save_substrate_if_new(substrate_path, result)
        progress("prepared", 0, 0)
        return build_ui_result(
            result,
            mode=mode,
            phases=PHASES_PREVIEW,
            atlas=atlas,
            member_index=member_index,
            field_index=field_index,
        )

    # --- pick the per-stage execution strategy (the only place mode branches into behavior) ---
    if overrides:
        stages: dict[str, StageFn] = overrides
    elif mode == "sync":
        # Client selection keys off the chosen model tag. Anthropic (or no explicit model — the historical
        # default) uses AnthropicClient, unchanged. Any other provider routes through the unified LiteLLM
        # client added in ddharmon Phase 7; the import is guarded so Anthropic-only deployments on an older
        # ddharmon keep working and a non-Anthropic pick fails fast with an actionable message.
        model_tag = kwargs.get("model_tag")
        mt = str(model_tag).lower() if model_tag else ""
        if not mt or mt.startswith(("claude", "anthropic/")):
            from ddharmon.llm.anthropic_client import AnthropicClient

            client = AnthropicClient(api_key=api_key)
        else:
            try:
                from ddharmon.llm.litellm_client import LiteLLMClient
            except ImportError as e:
                raise RuntimeError(
                    f"Model {model_tag!r} needs the unified LiteLLM client, but this backend's ddharmon package "
                    "lacks it. Update the ddharmon dependency (Phase 7 / >=0.7) and set LITELLM_PROXY_URL."
                ) from e
            client = LiteLLMClient(
                model=str(model_tag), api_key=api_key, api_base=(os.environ.get("LITELLM_PROXY_URL") or None)
            )
        stages = {
            "generate": _sync_stage("generating", progress, client),
            "split": _sync_stage("splitting", progress, client),
            "classify": _sync_stage("assigning", progress, client),
            "specgen": _sync_stage("specs", progress, client),
        }
    else:  # batch (default)
        stages = {
            "generate": _batch_stage("generating", progress, work_dir, "generate", api_key=api_key),
            "split": _batch_stage("splitting", progress, work_dir, "split", api_key=api_key),
            "classify": _batch_stage("assigning", progress, work_dir, "assign", api_key=api_key),
            "specgen": _batch_stage("specs", progress, work_dir, "specgen", api_key=api_key),
        }

    gen_specs = config.get("gen_transform_specs", True)
    progress("clustering", 0, 0)  # clustering + retrieval happen inside harmonize_leanb before the first callback
    result = harmonize_leanb(
        embedded,
        generate=stages.get("generate"),
        split=stages.get("split"),
        classify=stages.get("classify"),
        specgen=stages.get("specgen") if gen_specs else None,
        **kwargs,
    )
    _save_substrate_if_new(substrate_path, result)
    return build_ui_result(
        result, mode=mode, phases=PHASES_RUN, atlas=atlas, member_index=member_index, field_index=field_index
    )
