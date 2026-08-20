"""The artifact kinds this app persists. Importing this module registers them.

Adding a persisted feature = one entry here plus its payload shape. Everything else — storage, upsert by
identity, per-user scoping, the REST surface, cascade delete, delete-my-data — comes from the registry.

Kept separate from :mod:`backend.artifacts` (which is mechanism) so the set of kinds reads as a short,
reviewable list, and so a feature branch adding a kind touches one line here rather than five call sites
across the store.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Iterable
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


# -- gate decisions (08 staged review gates) --------------------------------------------------
#
# Seven gates multiply the surface this table exists to protect, so the design rule above is load-bearing
# here rather than stylistic: each kind keys on the THING DECIDED - the variable moved, the concept group
# picked for, the spec's source variable - never on the gate. Keyed per gate, a gate would hold ONE row
# whose payload is a map, every write would be a read-modify-write of that map, and two browser tabs
# correcting two different variables would lose one another's work. That is the exact bug the verdict kind
# was re-keyed to fix; it is not re-introduced six more times here.
#
# Every decision carries the OPTION SPACE, not just the value chosen: the alternatives that were available
# (identifiers only - the full payloads already live in the run result and must not be duplicated), the
# currently chosen identifier, and a content key over that set. Two requirements need it. R13 must show
# that re-selecting among ALREADY-RETRIEVED candidates costs nothing, which is only checkable if the
# alternatives are addressable from the decision record. And R6's staleness derivation needs a content key
# to compare against - see :func:`derive_staleness`.

#: Gate 1: keep / drop / merge this concept group. Keyed on the group.
GATE1_GROUP_SCOPE = "gate1_group_scope"

#: Gate 1: move one source variable into another group. Keyed on the VARIABLE moved, so two variables
#: moved in two tabs are two independent rows.
GATE1_REGROUP = "gate1_regroup"

#: Gate 2: which retrieved CDE candidate this concept group takes. Keyed on the group.
GATE2_CANDIDATE_PICK = "gate2_candidate_pick"

#: Gate 2: the SKOS/SSSOM relation asserted between a group and one target. Keyed on the (group, target)
#: EDGE - a group legitimately carries relations to several targets.
GATE2_RELATION = "gate2_relation"

#: Gate 3: an edited transform spec. Keyed on the spec's source variable, which is the granularity a
#: transform verdict already uses (one spec per "cohort:var" edge).
GATE3_SPEC_EDIT = "gate3_spec_edit"

#: Gate 4: include / exclude one record from the export. Keyed on the record.
GATE4_EXPORT_SELECTION = "gate4_export_selection"

#: A composite score's component re-pointed at a different concept. Keyed on the (score, component) edge.
COMPOSITE_SWAP = "composite_swap"

#: The seven gate-decision kinds, in gate order. Shared payload shape, shared validation, shared staleness
#: derivation - so a screen plan adding an eighth gets all three by adding one name here.
GATE_DECISION_KINDS = (
    GATE1_GROUP_SCOPE,
    GATE1_REGROUP,
    GATE2_CANDIDATE_PICK,
    GATE2_RELATION,
    GATE3_SPEC_EDIT,
    GATE4_EXPORT_SELECTION,
    COMPOSITE_SWAP,
)

#: How each gate-decision kind derives its item key: the payload fields, in order, that name the thing
#: decided. Held as data rather than as seven near-identical closures so the granularity rule is readable
#: as a table - the one property a reviewer of this file needs to check.
_DECISION_IDENTITY_FIELDS: dict[str, tuple[str, ...]] = {
    GATE1_GROUP_SCOPE: ("groupId",),
    GATE1_REGROUP: ("memberId",),
    GATE2_CANDIDATE_PICK: ("groupId",),
    GATE2_RELATION: ("groupId", "targetId"),
    GATE3_SPEC_EDIT: ("sourceVariable",),
    GATE4_EXPORT_SELECTION: ("recordId",),
    COMPOSITE_SWAP: ("scoreName", "componentName"),
}


def option_set_key(alternatives: Iterable[Any]) -> str:
    """A content key over the identifiers that were AVAILABLE at a gate, independent of their order.

    Order-independent because a retrieval that returns the same candidates in a different order is the same
    option space, and marking every downstream decision stale for a re-ranking nobody acted on is the noise
    that teaches a reviewer to ignore the notice.
    """
    ids = sorted({str(a).strip() for a in alternatives if str(a).strip()})
    return hashlib.sha256("\x1f".join(ids).encode("utf-8")).hexdigest()[:16]


def content_key(payload: dict[str, Any]) -> str:
    """The key a DOWNSTREAM decision persists in order to detect that this decision changed.

    Covers the option set AND the chosen value, because both are corrections a downstream decision must
    notice: a re-retrieval that changes the candidates, and a re-pick among the same candidates. One field
    serving both is deliberate (the plan's assumption-delta decision) - the reasons differ, the comparison
    does not.

    NOT a timestamp: ``upsert_artifact`` moves ``updated_at`` on every write including a no-op re-save, so
    a timestamp rule marks specs stale because the reviewer clicked save twice, and it cannot compare
    against pipeline-generated specs, which carry no timestamp at all. NOT a counter either - a comparison
    cannot double-apply one correction.
    """
    chosen = str(payload.get("chosen") or "")
    material = option_set_key(payload.get("alternatives") or []) + "\x1f" + chosen
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _decision_identity(kind: str) -> Callable[[dict[str, Any]], str]:
    fields = _DECISION_IDENTITY_FIELDS[kind]

    def identity(payload: dict[str, Any]) -> str:
        parts = []
        for field_name in fields:
            value = str(payload.get(field_name) or "").strip()
            if not value:
                raise ValueError(f"a {kind} decision needs a {field_name}")
            parts.append(value)
        return "|".join(parts)

    return identity


def _decision_validate(payload: dict[str, Any]) -> None:
    """Reject a decision whose staleness could never be derived, naming the field that is missing.

    A stored record with no option-set key is worse than a rejected write: it looks like a decision, it is
    served to the next screen, and nothing downstream of it can ever be told it went stale.
    """
    if not str(payload.get("optionSetKey") or "").strip():
        raise ValueError("a gate decision needs an optionSetKey (a content key over the available options)")
    if not isinstance(payload.get("chosen"), str):
        raise ValueError("a gate decision needs a chosen identifier (the empty string means 'none of these')")
    alternatives = payload.get("alternatives")
    if not isinstance(alternatives, list) or any(not isinstance(a, str) for a in alternatives):
        raise ValueError("a gate decision needs alternatives as a list of identifiers (identifiers only)")
    upstream = payload.get("upstream")
    if upstream is not None:
        if not isinstance(upstream, dict):
            raise ValueError("upstream must be an object naming the upstream kind, itemKey and contentKey")
        for field_name in ("kind", "itemKey", "contentKey"):
            if not str(upstream.get(field_name) or "").strip():
                raise ValueError(f"an upstream reference needs a {field_name}")
        if upstream["kind"] not in GATE_DECISION_KINDS:
            raise ValueError(f"upstream.kind {upstream['kind']!r} is not a gate-decision kind")


def derive_staleness(grouped: dict[str, Any]) -> list[dict[str, str]]:
    """Which stored decisions are stale, DERIVED by comparison on read. Never a column, never a flag.

    ``grouped`` is what :meth:`ArtifactStore.get_all` returns. For every decision carrying an ``upstream``
    reference, the upstream's CURRENT content key is compared against the one this decision recorded when
    it was made; a difference is staleness.

    Three properties fall out of it being a comparison rather than a write:

    - **Idempotent under a no-op re-save.** An identical payload has an identical content key.
    - **Never double-applied.** Reading twice reports the same one correction; there is nothing to
      increment.
    - **No row to write onto is not a problem.** A written flag needs a downstream row to write it to, and
      the whole point is that the downstream decision may not exist yet - and writing across rows is the
      read-modify-write this table exists to eliminate.

    An upstream row that is ABSENT is not reported: the reviewer may simply have cleared it, and absence is
    not evidence of change.
    """
    current: dict[tuple[str, str], str] = {}
    for kind in GATE_DECISION_KINDS:
        for payload in grouped.get(kind) or []:
            try:
                item_key = registry.get(kind).key_for(payload)
            except ValueError:  # a row written under a different shape - skip, never raise on a read
                continue
            current[(kind, item_key)] = content_key(payload)

    stale: list[dict[str, str]] = []
    for kind in GATE_DECISION_KINDS:
        for payload in grouped.get(kind) or []:
            upstream = payload.get("upstream")
            if not isinstance(upstream, dict):
                continue
            seen = str(upstream.get("contentKey") or "")
            now = current.get((str(upstream.get("kind")), str(upstream.get("itemKey"))))
            if now is None or now == seen:
                continue
            try:
                item_key = registry.get(kind).key_for(payload)
            except ValueError:
                continue
            stale.append(
                {
                    "kind": kind,
                    "itemKey": item_key,
                    "upstreamKind": str(upstream.get("kind")),
                    "upstreamItemKey": str(upstream.get("itemKey")),
                    "reason": "the upstream decision changed after this one was made",
                }
            )
    return stale


# One registration per kind, spelled out rather than looped: the point of this module is that the set of
# persisted kinds is greppable, and a loop hides seven of them behind one call site.
registry.register(
    ArtifactKind(
        name=GATE1_GROUP_SCOPE,
        identity=_decision_identity(GATE1_GROUP_SCOPE),
        validate=_decision_validate,
    )
)
registry.register(
    ArtifactKind(
        name=GATE1_REGROUP,
        identity=_decision_identity(GATE1_REGROUP),
        validate=_decision_validate,
    )
)
registry.register(
    ArtifactKind(
        name=GATE2_CANDIDATE_PICK,
        identity=_decision_identity(GATE2_CANDIDATE_PICK),
        validate=_decision_validate,
    )
)
registry.register(
    ArtifactKind(
        name=GATE2_RELATION,
        identity=_decision_identity(GATE2_RELATION),
        validate=_decision_validate,
    )
)
registry.register(
    ArtifactKind(
        name=GATE3_SPEC_EDIT,
        identity=_decision_identity(GATE3_SPEC_EDIT),
        validate=_decision_validate,
    )
)
registry.register(
    ArtifactKind(
        name=GATE4_EXPORT_SELECTION,
        identity=_decision_identity(GATE4_EXPORT_SELECTION),
        validate=_decision_validate,
    )
)
registry.register(
    ArtifactKind(
        name=COMPOSITE_SWAP,
        identity=_decision_identity(COMPOSITE_SWAP),
        validate=_decision_validate,
    )
)
