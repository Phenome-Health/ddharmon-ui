"""Per-user artifacts attached to a run — the durable home for a user's own work.

A run and the work a *user does on* that run are different things, and conflating them is what produced the
bug this module exists to fix. A run is produced by the pipeline and owned by whoever started it (a demo is
owned by nobody and shared by everybody). Review verdicts, composite specs and analysis ideas belong to a
**(user, run) pair** — user A's verdict on the shared demo is not user B's.

Storing them as columns on the job row could not express that: the demo is a single row, so every user's
annotations landed in one place and were visible to all of them. They are keyed
``(owner_subject, job_id, kind, item_key)`` here instead, which scopes them per user by construction.

The second reason this module exists is extension cost. Adding ``composites`` as a job column took five
coordinated edits — a ``Job`` field, a ``from_db_row`` line, a ``to_dict`` key, an ``_ADDITIVE_COLUMNS``
entry, and a bespoke setter that duplicated the previous one (bug included). Adding a kind here is one
:meth:`ArtifactRegistry.register` call; storage, upsert-by-identity, per-user scoping, the REST surface,
cascade delete on run deletion and the delete-my-data path all follow from it.

Design notes:

- ``owner_subject`` is an opaque principal string, not specifically a Clerk id, so an anonymous
  ``guest:<uuid>`` principal can be added later without a schema change.
- Writes return the stored :class:`Artifact` or raise. They never report success for a write that was
  dropped — a silent no-op returning ``True`` is exactly how the original bug stayed invisible.
- A pinned run (the canonical demo) is immutable: writes raise :class:`ReadOnlyRunError`. Demo edits live in the
  browser for the tab's lifetime; keeping them means cloning the demo into a run of your own.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

_SINGLETON_KEY = ""


class ArtifactError(Exception):
    """Base for artifact-layer failures. All are the caller's problem, not a server fault."""


class UnknownArtifactKindError(ArtifactError):
    """A kind that was never registered — a typo, or a feature whose registration didn't get imported."""


class ReadOnlyRunError(ArtifactError):
    """A write was attempted against a pinned run (the shared canonical demo)."""


@dataclass(frozen=True)
class Artifact:
    """One stored artifact: the payload plus the identity it was stored under."""

    artifact_id: str
    owner_subject: str
    job_id: str
    kind: str
    item_key: str
    payload: dict[str, Any]
    schema_version: int
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class ArtifactKind:
    """The contract for one kind of user artifact.

    ``identity`` derives the ``item_key`` from a payload, which is what makes a write an upsert: re-deriving
    the same composite, or re-voting the same record, REPLACES rather than accumulates. Leave it ``None`` for
    a singleton (one row per user per run, e.g. a run's analysis ideas).

    ``version`` + ``migrate`` let a payload shape change later without a table migration: each row records
    the version it was written under and is migrated forward on read.
    """

    name: str
    version: int = 1
    identity: Callable[[dict[str, Any]], str] | None = None
    validate: Callable[[dict[str, Any]], None] | None = None
    migrate: Callable[[dict[str, Any], int], dict[str, Any]] | None = None

    @property
    def singleton(self) -> bool:
        return self.identity is None

    def key_for(self, payload: dict[str, Any]) -> str:
        """The ``item_key`` this payload is stored under. Raises ValueError if identity can't be derived."""
        if self.identity is None:
            return _SINGLETON_KEY
        try:
            key = self.identity(payload)
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError(f"cannot derive an identity for a {self.name} artifact: {exc}") from exc
        key = str(key or "").strip()
        if not key:
            raise ValueError(f"a {self.name} artifact needs a non-empty identity")
        return key

    def check(self, payload: dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            raise ValueError(f"a {self.name} artifact payload must be an object, got {type(payload).__name__}")
        if self.validate is not None:
            self.validate(payload)

    def read(self, payload: dict[str, Any], stored_version: int) -> dict[str, Any]:
        """Forward-migrate a payload written under an older version of this kind."""
        if stored_version < self.version and self.migrate is not None:
            return self.migrate(payload, stored_version)
        return payload


@dataclass
class ArtifactRegistry:
    """The set of known artifact kinds. Registering one is the whole cost of adding a persisted feature."""

    _kinds: dict[str, ArtifactKind] = field(default_factory=dict)

    def register(self, kind: ArtifactKind) -> ArtifactKind:
        if kind.name in self._kinds:
            raise ValueError(f"artifact kind {kind.name!r} is already registered")
        self._kinds[kind.name] = kind
        return kind

    def get(self, name: str) -> ArtifactKind:
        try:
            return self._kinds[name]
        except KeyError:
            known = ", ".join(sorted(self._kinds)) or "none"
            raise UnknownArtifactKindError(f"unknown artifact kind {name!r} (known: {known})") from None

    def names(self) -> list[str]:
        return sorted(self._kinds)

    def __contains__(self, name: object) -> bool:
        return name in self._kinds


#: The process-wide registry. Kinds are declared in :mod:`backend.artifact_kinds`.
registry = ArtifactRegistry()


class ArtifactStore:
    """CRUD for user artifacts over a :class:`~backend.db.JobDB` connection.

    Every method is scoped by ``owner`` — there is deliberately no "read all artifacts for this run"
    accessor, because that is the query whose absence keeps one user's work out of another's view. The
    future share feature will add an explicit, permission-checked variant rather than removing the scoping.
    """

    def __init__(self, db: Any, registry_: ArtifactRegistry | None = None) -> None:
        self._db = db
        self._registry = registry_ or registry

    def put(
        self,
        *,
        owner: str,
        job_id: str,
        kind: str,
        payload: dict[str, Any],
        pinned: bool = False,
    ) -> Artifact:
        """Insert or replace one artifact, keyed by its kind's identity. Returns what was stored.

        Raises :class:`ReadOnlyRunError` when ``pinned`` (the shared demo), :class:`UnknownArtifactKindError` for an
        unregistered kind, and ``ValueError`` for a payload that fails validation or has no identity. It
        never returns a value for a write that did not happen.
        """
        spec = self._registry.get(kind)
        if pinned:
            raise ReadOnlyRunError(f"{job_id} is the shared demo and cannot be modified — clone it to keep your work")
        if not owner:
            raise ValueError("artifacts need an owner; sign in to save your work")
        spec.check(payload)
        item_key = spec.key_for(payload)
        return self._db.upsert_artifact(
            artifact_id=uuid.uuid4().hex,
            owner_subject=owner,
            job_id=job_id,
            kind=kind,
            item_key=item_key,
            payload=payload,
            schema_version=spec.version,
        )

    def get_all(self, *, owner: str | None, job_id: str) -> dict[str, Any]:
        """Every artifact this owner holds for this run, grouped by kind, in one query.

        Singleton kinds map to their payload (or absent); keyed kinds map to a list. Unknown kinds found in
        the table are skipped rather than raising — a row written by a newer version of the app must not
        break an older reader.
        """
        grouped: dict[str, Any] = {}
        if not owner:
            return grouped
        for row in self._db.list_artifacts(owner_subject=owner, job_id=job_id):
            if row.kind not in self._registry:
                continue
            spec = self._registry.get(row.kind)
            payload = spec.read(row.payload, row.schema_version)
            if spec.singleton:
                grouped[row.kind] = payload
            else:
                grouped.setdefault(row.kind, []).append(payload)
        return grouped

    def delete(self, *, owner: str, job_id: str, kind: str, item_key: str = _SINGLETON_KEY) -> bool:
        self._registry.get(kind)  # reject unknown kinds even on delete, so typos surface
        return self._db.delete_artifact(owner_subject=owner, job_id=job_id, kind=kind, item_key=item_key)

    def delete_for_run(self, job_id: str) -> int:
        """Cascade when a run is deleted — every user's artifacts for it go too."""
        return self._db.delete_artifacts(job_id=job_id)

    def delete_for_owner(self, owner: str) -> int:
        """Every artifact belonging to one principal — the 'delete my data' path."""
        return self._db.delete_artifacts(owner_subject=owner)


def dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))
