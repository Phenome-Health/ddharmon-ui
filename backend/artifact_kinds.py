"""The artifact kinds this app persists. Importing this module registers them.

Adding a persisted feature = one entry here plus its payload shape. Everything else — storage, upsert by
identity, per-user scoping, the REST surface, cascade delete, delete-my-data — comes from the registry.

Kept separate from :mod:`backend.artifacts` (which is mechanism) so the set of kinds reads as a short,
reviewable list, and so a feature branch adding a kind touches one line here rather than five call sites
across the store.
"""

from __future__ import annotations

from typing import Any

from backend.artifacts import ArtifactKind, registry

#: A human verdict on one axis of one record.
#:
#: The identity is (record, axis, source variable) rather than just the record, so the match / transform /
#: gencde verdicts on a record are INDEPENDENT rows. The previous nested-dict shape made every write a
#: read-modify-write of the whole record's verdict blob, which two browser tabs can interleave and lose.
#: ``sourceVariable`` participates because the transform axis carries one verdict per "cohort:var" edge.
VERDICT = "verdict"

#: One derived composite / derived-variable spec, identified by the score's name so that re-deriving the
#: same score REPLACES its entry (a run legitimately carries several different scores).
#: NOTE: the writer for this kind lives on the composite-panel branch; the declaration is here so the two
#: merge without touching the store.
COMPOSITE = "composite"

#: The run's LLM-suggested downstream analyses — one per (user, run), hence a singleton.
ANALYSIS_IDEAS = "analysis_ideas"


def _verdict_identity(payload: dict[str, Any]) -> str:
    record_id = str(payload.get("recordId") or "").strip()
    axis = str(payload.get("axis") or "match").strip()
    source_variable = str(payload.get("sourceVariable") or "").strip()
    if not record_id:
        raise ValueError("a verdict needs a recordId")
    return f"{record_id}|{axis}|{source_variable}"


def _verdict_validate(payload: dict[str, Any]) -> None:
    axis = str(payload.get("axis") or "match")
    if axis not in ("match", "transform", "gencde"):
        raise ValueError(f"unknown verdict axis {axis!r}")
    if axis == "transform" and not str(payload.get("sourceVariable") or "").strip():
        raise ValueError("a transform-axis verdict needs a sourceVariable")
    if str(payload.get("decision") or "") not in ("approve", "refine", "reject"):
        # "clear" never reaches storage — it deletes the row instead.
        raise ValueError("a stored verdict must be approve|refine|reject")


def _composite_identity(payload: dict[str, Any]) -> str:
    definition = payload.get("definition")
    name = (definition or {}).get("name") if isinstance(definition, dict) else None
    return str(name or "").strip().lower()


registry.register(
    ArtifactKind(
        name=VERDICT,
        identity=_verdict_identity,
        validate=_verdict_validate,
    )
)

registry.register(
    ArtifactKind(
        name=COMPOSITE,
        identity=_composite_identity,
    )
)

registry.register(ArtifactKind(name=ANALYSIS_IDEAS))  # singleton: no identity function
