"""The artifact kinds this app persists. Importing this module registers them.

Adding a persisted feature = one entry here plus its payload shape. Everything else — storage, upsert by
identity, per-user scoping, the REST surface, cascade delete, delete-my-data — comes from the registry.

Kept separate from :mod:`backend.artifacts` (which is mechanism) so the set of kinds reads as a short,
reviewable list, and so a feature branch adding a kind touches one line here rather than five call sites
across the store.
"""

from __future__ import annotations

import hashlib
import os
import time
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


# -- accepted GenCDEs: the dual-key identity of a reusable element -----------------------------
#
# An accepted generated element is the artifact a LATER run reuses as an anchor (run A-B-C, then run D-E-F
# carrying the accepted elements forward). It therefore needs an identity that survives the hop, and the
# shape of that identity is a recorded decision, not an implementation detail:
#
#   id           DDHARMON:u<user>/<ulid>   PRIVATE. Gate decisions and the personal catalog reference THIS.
#   digest       sha256 over a canonical concept form, computed at acceptance, NEVER served before publish
#   digestAlgo   "v1", so a better canonical form is an additive v2, not a migration
#   tinyId       "" always - the refusal in core's export/cde_json.py, preserved
#   refines      CDE:<tinyId> | DDHARMON:... - the provenance edge, which survives the reuse hop
#   published    false until the user opts in; nothing compares digests across users while it is false
#
# Why the digest is NOT the primary key, given that content-addressing is the obvious choice for a reusable
# element: a digest ENCODES THE CONCEPT. Using it as the identifier would mean every gate decision, and every
# shared surface that ever carries a reference, leaks what the user harmonized - putting a privacy decision
# inside the primary key of the very table this layer exists to keep private. The digest's job is to answer
# "are two users' elements the same concept" for a LATER promotion path, and that question is only asked
# about published rows.
#
# Why the algorithm version is load-bearing: content-addressing looks like it forces the canonicalization
# question now. It does not, because `published` gates all cross-user comparison and publishing is opt-in, so
# a v2 recompute only ever has to touch published rows. v1 is therefore allowed to be an honest first
# attempt - measurand term, data type, canonicalized unit, sorted permissible-value codes - and to be
# revised on evidence rather than perfected up front.

#: A human verdict on one generated element, keyed on the record whose element was judged.
ACCEPTED_GENCDE = "accepted_gencde"

#: The canonical-form version this build computes digests under. An additive v2 recomputes PUBLISHED rows
#: only; unpublished rows keep their v1 digest, which nothing outside the owner has ever seen.
DIGEST_ALGO = "v1"

#: The namespaces a provenance edge may point into: an existing NIH element, or another accepted element of
#: our own (the reuse hop). Anything else would assert a mapping into a vocabulary we did not resolve.
_REFINES_PREFIXES = ("CDE:", "DDHARMON:")

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _ulid() -> str:
    """A 26-character Crockford base32 ULID: 48 bits of millisecond timestamp, 80 bits of randomness.

    Hand-rolled rather than added as a dependency: this is fifteen lines, and a package install is a supply
    chain decision (T-08-67 - no installs in this plan).
    """
    value = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")
    return "".join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))


def _user_segment(owner_subject: str) -> str:
    """The ``u<...>`` segment of a private identifier: a stable, non-reversible digest of the principal.

    The principal itself is never carried. An identifier can end up on a shared surface (a published row, a
    support ticket, an export), and an identity provider's subject is a user handle - so the segment is
    stable enough to group one user's elements and tells a reader nothing about who they are.
    """
    return "u" + hashlib.sha256(f"ddharmon-owner:{owner_subject}".encode()).hexdigest()[:12]


def canonical_concept_form(concept: dict[str, Any]) -> str:
    """The v1 canonical form a digest is taken over.

    Measurand term (the title, case- and whitespace-normalized), data type, canonicalized unit, and the
    SORTED permissible-value codes. Deliberately excludes prose - definition, question wording, rationale -
    because two reviewers describing the same measurement differently have the same concept, and a digest
    that moved on an editorial change would report a new element every time someone fixed a typo.
    """
    title = " ".join(str(concept.get("title") or "").lower().split())
    data_type = " ".join(str(concept.get("dataType") or "").lower().split())
    units = " ".join(str(concept.get("units") or "").lower().split())
    codes = sorted(
        {
            str((option or {}).get("code") or "").strip()
            for option in (concept.get("permissibleValues") or [])
            if isinstance(option, dict)
        }
        - {""}
    )
    return "\x1f".join([title, data_type, units, ",".join(codes)])


def concept_digest(concept: dict[str, Any], algo: str = DIGEST_ALGO) -> str:
    """The content digest of one concept under a named algorithm version."""
    if algo != DIGEST_ALGO:
        raise ValueError(f"unknown digest algorithm {algo!r} (this build computes {DIGEST_ALGO})")
    return hashlib.sha256(f"{algo}\x1f{canonical_concept_form(concept)}".encode()).hexdigest()


def accept_gencde(payload: dict[str, Any], *, owner_subject: str) -> dict[str, Any]:
    """Build the stored form of an acceptance verdict: the SERVER mints both keys.

    A client-supplied digest is not a digest and a client-supplied identifier is not an identity, so both
    are computed here and any inbound value for them is discarded. ``published`` is likewise forced false:
    publishing is a separate, explicit, later opt-in, and accepting an element must not be a way to publish
    one by including a field.
    """
    concept = payload.get("concept")
    if not isinstance(concept, dict) or not str(concept.get("title") or "").strip():
        raise ValueError("an accepted GenCDE needs a concept carrying at least a title")
    stored = {
        key: value for key, value in payload.items() if key not in ("id", "digest", "digestAlgo", "tinyId", "published")
    }
    stored["id"] = f"DDHARMON:{_user_segment(owner_subject)}/{_ulid()}"
    stored["digest"] = concept_digest(concept)
    stored["digestAlgo"] = DIGEST_ALGO
    stored["tinyId"] = ""  # NIH assigns on acceptance; an invented id would collide with a real one
    stored["published"] = False
    return stored


def _gencde_identity(payload: dict[str, Any]) -> str:
    record_id = str(payload.get("recordId") or "").strip()
    if not record_id:
        raise ValueError("an accepted GenCDE needs a recordId (the record whose element was judged)")
    return record_id


def _gencde_validate(payload: dict[str, Any]) -> None:
    if str(payload.get("verdict") or "") not in ("accept", "reject"):
        raise ValueError("an accepted GenCDE needs a recorded human verdict: accept|reject")
    if str(payload.get("tinyId") or ""):
        raise ValueError(
            "tinyId must stay empty: NIH assigns it on acceptance, an invented one would collide with a "
            "real element, and KRAKEN keys NIH CDEs as CDE:<tinyId> 1:1"
        )
    if not str(payload.get("id") or "").startswith("DDHARMON:u"):
        raise ValueError("an accepted GenCDE needs a server-minted DDHARMON:u<user>/<ulid> identifier")
    refines = str(payload.get("refines") or "")
    if refines and not refines.startswith(_REFINES_PREFIXES):
        raise ValueError(
            f"refines must point at {' or '.join(_REFINES_PREFIXES)} - {refines!r} asserts a mapping into a "
            "vocabulary this element was never resolved against"
        )


def redact_unpublished(grouped: dict[str, Any]) -> dict[str, Any]:
    """Strip the digest from every accepted element the user has not opted to publish.

    Applied at the store's single read path rather than at each caller, because "remember to redact at every
    new read site" is the shape of rule this codebase has already been burned by. The algorithm version is
    NOT stripped: it says how the concept would be hashed, not what the concept is.
    """
    entries = grouped.get(ACCEPTED_GENCDE)
    if not entries:
        return grouped
    return {
        **grouped,
        ACCEPTED_GENCDE: [
            entry if entry.get("published") else {k: v for k, v in entry.items() if k != "digest"} for entry in entries
        ],
    }


def personal_catalog(grouped: dict[str, Any]) -> list[dict[str, Any]]:
    """The elements this user may reuse as anchors in a later run - accepted ones only.

    Gated on the recorded verdict rather than on existence, because a generated element that was WRONG in
    run 1 becomes an anchor in run 2, where the mistake stops surfacing as a reviewable novel and starts
    being reinforced as a match. "It was generated" is not a decision anyone made.
    """
    return [entry for entry in (grouped.get(ACCEPTED_GENCDE) or []) if entry.get("verdict") == "accept"]


registry.register(
    ArtifactKind(
        name=ACCEPTED_GENCDE,
        identity=_gencde_identity,
        validate=_gencde_validate,
    )
)
