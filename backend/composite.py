"""Composite / derived-variable builder — the web layer's THIN delegation to core.

The whole capability lives in ``ddharmon.harmonization.composite``: transcribe a published score from a real
document, match each of its components onto the concepts THIS run harmonized, judge feasibility per cohort,
and emit the derivation recipe. This module deliberately adds no reasoning of its own — it resolves a source
document, calls core, and hands back core's own camelCase payload (``spec_to_dict``).

Contrast ``backend/analysis_ideas.py``, which is a verbatim copy of the core module: that duplication is
tracked debt (the "recover analysis-ideas / delegate to core" refactor). Do not grow a second instance of it
here — if something is missing, add it to core.

Metadata-only, unchanged: the spec is a RECIPE over data-dictionary metadata. Nothing here reads
participant data, and a cutoff the source does not state is never invented.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ddharmon.harmonization.composite import derive_composite, records_from_payload, spec_to_dict
from ddharmon.harmonization.score_sources import ScoreSource, fetch_source, from_text, from_url

# Cache the encoder across requests: hybrid retrieval is opt-in per call, and cold-loading BioLORD (768d)
# per request would dominate the response time. The provider (the 440MB model) is a process-wide singleton;
# the SQLite embedding cache is opened PER CALL in the calling thread — uvicorn serves derives on threadpool
# threads and sqlite3 connections are thread-affine — persisting vectors to disk across derives regardless.
_provider: Any | None = None


def _get_provider() -> Any:
    """The process-wide BioLORD provider (model loaded once, on first opt-in)."""
    global _provider
    if _provider is None:
        from ddharmon.embedding.provider import SentenceTransformerProvider

        _provider = SentenceTransformerProvider()
    return _provider


def _cache_db_path() -> Any:
    """The shared embedding-cache DB — the same root embed_dictionary() uses ($DDHARMON_CACHE, else ~/.ddharmon)."""
    import os
    from pathlib import Path

    root = os.environ.get("DDHARMON_CACHE")
    return (Path(root) if root else Path.home() / ".ddharmon") / "embeddings.db"


def _embedder() -> Any:
    """A cache-backed hybrid-retrieval embedder: embed the corpus once, hit the cache on every derive after.

    A bare ``provider.embed`` re-encodes the whole retrieval corpus (~10.7k concepts + variables, ~27s) on
    EVERY derive because nothing persists the vectors between calls. This wraps the provider with
    :class:`~ddharmon.embedding.cache.EmbeddingCache` (the same ``~/.ddharmon/embeddings.db`` the run's
    ``embed_dictionary`` writes), keyed on ``sha256(text)[:16]`` — the exact string embedded — under the
    provider's model_name and the ``'semantic'`` vector type. Self-consistent: the first derive is cold and
    every derive after it, over the same corpus, is a pure cache hit.

    It does NOT warm the FIRST derive from the run's per-variable rows: those were hashed over
    ``compose_embedding_text`` (variable_name + category + parent context), while retrieval scores against
    ``ConceptEntry.retrieval_text`` (concept + CDE name + ideal slice) — different text, different hash. The
    win is removing the per-derive re-embed, not a warm first derive.
    """

    def embed(texts: list[str]) -> Any:
        import hashlib

        import numpy as np

        from ddharmon.embedding.cache import EmbeddingCache

        provider = _get_provider()
        hashes = [hashlib.sha256(t.encode()).hexdigest()[:16] for t in texts]
        wanted = list(dict.fromkeys(hashes))  # unique, order-preserving

        cache = EmbeddingCache(_cache_db_path(), provider.dimension)
        try:
            vecs = cache.get_many(provider.model_name, wanted, vector_type="semantic")
            missing = [h for h in wanted if h not in vecs]
            if missing:
                by_hash = dict(zip(hashes, texts))  # a hash maps back to its (identical) text
                fresh = provider.embed([by_hash[h] for h in missing])
                cache.put_many(provider.model_name, list(zip(missing, fresh)), vector_type="semantic")
                for h, v in zip(missing, fresh):
                    vecs[h] = v
        finally:
            cache.close()

        return np.asarray([vecs[h] for h in hashes], dtype=np.float32)

    return embed


def resolve_source(
    *,
    text: str | None = None,
    ref: str | None = None,
    upload: bytes | None = None,
    filename: str = "",
) -> ScoreSource:
    """Turn whichever input the client supplied into a :class:`ScoreSource`.

    Exactly one of ``text`` / ``ref`` / ``upload`` is expected; precedence is upload → ref → text so an
    explicit upload always wins. ``ref`` may be a URL, a bare DOI, or a GitHub repo — core bounds that fetch
    (http(s) only, redirect hops re-validated against non-public address space, byte cap, timeout).

    An upload is routed by core's ``fetch_source`` on the bytes' MAGIC NUMBER, not on the filename: a PDF
    goes to the PDF reader and a Word supplement (``.docx``) to the docx reader, which is what the caller
    usually wants when a score's item table lives in the supplement rather than the article.
    """
    if upload:
        return fetch_source(upload, provenance=filename or "uploaded document")
    if ref and ref.strip():
        return from_url(ref.strip())
    if text and text.strip():
        return from_text(text)
    raise ValueError("provide the score's definition as pasted text, a URL/DOI/repo, or a PDF / Word (.docx) upload")


# --- the feasibility verdict the USER is shown ---------------------------------------------------

#: Core's vocabulary, plus the fourth value the product needs. See :func:`presentation_verdict`.
_CORE_VERDICTS = frozenset({"full", "partial", "infeasible"})


def presentation_verdict(feasibility: Mapping[str, Any]) -> str:
    """The verdict to SHOW: ``full`` | ``partial`` | ``infeasible`` | ``indeterminate``.

    A standing prohibition: **never emit a negative verdict when only positive-or-indeterminate is
    determinable.** "This score cannot be built from this run" and "we could not tell" are different
    claims, and only one of them is ever true when there was nothing to check.

    Core reaches ``infeasible`` two structurally different ways. With required components that were looked
    for and not found, it is a real finding. With ``n_required == 0`` — a definition whose item table did
    not survive text extraction, which core's own ``_match_prompt`` docstring records as having produced "a
    clean 0/N -> infeasible with nothing raised" — it is a negative claim assembled from no evidence.

    Two normalizations, both one-directional:

      * ``infeasible`` with nothing required -> ``indeterminate``
      * an unrecognized or missing verdict -> ``indeterminate``, never the negative. A ``?? "infeasible"``
        style fallback is the same defect in the other language, and the frontend had exactly that.

    Kept at the web layer deliberately. Core is a released dependency (``ddharmon>=1.1.0``), so a fix there
    could not reach this deploy; and this IS where the claim to the user is made. Core's own value is
    preserved by the caller as ``coreVerdict``, so the normalization is inspectable rather than a silent
    rewrite of somebody else's judgement.
    """
    verdict = str(feasibility.get("verdict") or "")
    if verdict not in _CORE_VERDICTS:
        return "indeterminate"
    if verdict == "infeasible" and not int(feasibility.get("nRequired") or 0):
        return "indeterminate"
    return verdict


def derive(
    records: list[dict[str, Any]],
    source: ScoreSource | Any,
    complete: Any,
    *,
    overrides: dict[str, str | None] | None = None,
    hybrid: bool = False,
    top_k: int = 8,
    field_index: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Derive one composite spec for ``records`` (the run's UIResult records) and return it JSON-ready.

    ``source`` is a :class:`ScoreSource` (first derivation — core transcribes it) or an already-transcribed
    core ``ScoreDefinition`` (the re-derive path, which skips the extraction call).
    ``complete`` is a ``build_llm_client(...).complete``. ``hybrid=True`` adds dense retrieval to BM25 at the
    cost of loading the encoder once. Returns ``spec_to_dict()`` plus the two cost/telemetry fields the panel
    shows, so the client can see what a derivation actually spent.
    """
    result = derive_composite(
        source,
        records_from_payload(records),
        complete,
        embed=_embedder() if hybrid else None,
        top_k=top_k,
        overrides=overrides or None,
        field_index=field_index or None,
    )
    payload = spec_to_dict(result.spec)
    # The verdict the user is shown, which is not always the verdict core computed. See
    # `presentation_verdict` — core's own value is kept as `coreVerdict` so nothing is hidden.
    feasibility = payload.get("feasibility")
    if isinstance(feasibility, dict):
        feasibility["coreVerdict"] = feasibility.get("verdict")
        feasibility["verdict"] = presentation_verdict(feasibility)
    payload["nConceptsIndexed"] = result.n_concepts_indexed
    payload["callsMade"] = result.calls_made
    # NOT getattr(source, "kind"): a ScoreDefinition also has a `.kind` (the CompositeKind), which would
    # mislabel a re-derive as e.g. "criteria_count" instead of naming where the definition came from.
    payload["sourceKind"] = source.kind if isinstance(source, ScoreSource) else "definition"
    return payload
