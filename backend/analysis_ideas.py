"""Post-run "analysis ideas" — suggest (never run) downstream analyses the harmonization unlocks.

ddharmon shows WHAT is harmonizable; this makes visible what that harmonization *enables*. A single LLM
pass reads the run's harmonized concepts + which cohorts contribute to each, and proposes concrete,
grounded cross-cohort analyses (association tests, replication/meta-analysis, pooled prevalence, …).

HARD SCOPE (inherited from the metadata-only invariant): ddharmon ingests data dictionaries only, never
participant-level data. This feature therefore **proposes** analyses — it does not run them. The only
signal it has is which cohorts share a concept. Output is explicitly "hypotheses to explore", not results,
and every idea is grounded in concepts ACTUALLY present in this run (hallucinated concepts are dropped).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

_MAX_CONCEPTS = 40  # bound the prompt to the most-connected concepts
_DEFAULT_MAX_IDEAS = 8

# The LLM call: mirrors ddharmon.llm.anthropic_client.AnthropicClient.complete.
CompleteFn = Callable[..., str]


def build_concept_digest(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The enabling signal: concepts present in ≥2 cohorts (a cross-cohort overlap is what makes a pooled
    analysis newly possible). One entry per such concept: ``{concept, cohorts, verdict, cde, nMembers}``,
    sorted by cohort breadth then size, capped to keep the prompt bounded."""
    digest: list[dict[str, Any]] = []
    for r in records:
        cohorts = sorted({c for c in (r.get("cohorts") or []) if c})
        if len(cohorts) < 2:
            continue
        cde = r.get("cde")
        digest.append(
            {
                "concept": (r.get("concept") or "").strip() or "(unlabeled concept)",
                "cohorts": cohorts,
                "verdict": r.get("verdict", ""),
                "cde": cde.get("id") if isinstance(cde, dict) else None,
                "nMembers": int(r.get("nMembers", len(r.get("members") or []))),
            }
        )
    digest.sort(key=lambda d: (len(d["cohorts"]), d["nMembers"]), reverse=True)
    return digest[:_MAX_CONCEPTS]


def _build_prompt(digest: list[dict[str, Any]], max_ideas: int) -> tuple[str, str]:
    concept_lines = "\n".join(
        f"- {d['concept']} — cohorts: {', '.join(d['cohorts'])}" + (f"; CDE {d['cde']}" if d["cde"] else "")
        for d in digest
    )
    allowed = [d["concept"] for d in digest]
    system = (
        "You are a biomedical research methodologist. You are given CONCEPTS that have been harmonized "
        "across multiple cohorts; each lists which cohorts contain it. Propose concrete, scientifically "
        "plausible DOWNSTREAM ANALYSES that are newly possible now that these concepts align across cohorts "
        "— e.g. cross-cohort association tests, replication / meta-analysis, pooled prevalence, subgroup or "
        "mediation analyses.\n\n"
        "STRICT RULES:\n"
        "- Ground every idea ONLY in the concepts listed by the user. NEVER invent a variable or concept.\n"
        "- Every idea must use concepts present in ≥2 cohorts — that cross-cohort overlap is the whole point.\n"
        "- These are HYPOTHESES TO EXPLORE, not findings. Never claim a result or causal effect; name a method.\n"
        "- You have ONLY metadata (which cohorts share a concept). You have NO participant-level data.\n\n"
        "Respond with ONLY valid JSON (no markdown fences) matching this schema:\n"
        '{"ideas": [{"title": string, "hypothesis": string, "concepts": [string], "cohorts": [string], '
        '"method": string, "whyNewlyPossible": string, "category": string}]}'
    )
    user = (
        f"Harmonized cross-cohort concepts (concept — cohorts[; CDE]):\n{concept_lines}\n\n"
        f"Propose up to {max_ideas} analysis ideas, most impactful first. Each idea's `concepts` MUST be a "
        f"subset of exactly these labels (copy them verbatim): {allowed}"
    )
    return system, user


def _parse_ideas(raw: str, allowed: set[str]) -> list[dict[str, Any]]:
    """Tolerantly parse the model's JSON and keep only ideas grounded in the run's own concepts.

    Strips markdown fences, accepts either ``{"ideas": [...]}`` or a bare list, intersects each idea's
    ``concepts`` with ``allowed`` (dropping hallucinated ones), and drops any idea left with none grounded.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if text.count("```") >= 2 else text.strip("`")
        text = text.removeprefix("json").strip()
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    items = data.get("ideas") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []

    out: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        grounded = [c for c in (it.get("concepts") or []) if c in allowed]
        if not grounded:
            continue  # every concept was hallucinated → drop the idea
        out.append(
            {
                "title": str(it.get("title", "")).strip(),
                "hypothesis": str(it.get("hypothesis", "")).strip(),
                "concepts": grounded,
                "cohorts": [str(c) for c in (it.get("cohorts") or [])],
                "method": str(it.get("method", "")).strip(),
                "whyNewlyPossible": str(it.get("whyNewlyPossible", "")).strip(),
                "category": str(it.get("category", "")).strip(),
            }
        )
    return out


def generate_analysis_ideas(
    records: list[dict[str, Any]], complete: CompleteFn, *, max_ideas: int = _DEFAULT_MAX_IDEAS
) -> dict[str, Any]:
    """Generate grounded analysis ideas from a run's records via one LLM call.

    ``complete`` is ``AnthropicClient.complete`` (``complete(prompt, *, system, max_tokens) -> str``).
    Returns ``{"ideas": [...], "nConcepts": int}``; ``ideas`` is empty when the run has no cross-cohort
    concept (nothing a pooled analysis could newly enable).
    """
    digest = build_concept_digest(records)
    if not digest:
        return {"ideas": [], "nConcepts": 0}
    system, user = _build_prompt(digest, max_ideas)
    raw = complete(user, system=system, max_tokens=2000)
    ideas = _parse_ideas(raw, allowed={d["concept"] for d in digest})
    return {"ideas": ideas[:max_ideas], "nConcepts": len(digest)}
