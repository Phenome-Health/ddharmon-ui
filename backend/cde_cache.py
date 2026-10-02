"""Is the CDE catalog already in the shared embedding cache? — asked by the warm step and by ``/api/health``.

Every run embeds the CDE catalog next to the cohort dictionaries (``run_pipeline`` -> ``embed_for_run`` -> core's
``embed_dictionary``), and core keeps a content-addressed SQLite cache of every vector it makes: key = model +
sha of the composed text + vector type, at ``$DDHARMON_CACHE/embeddings.db`` (else ``~/.ddharmon``). The catalog
is never preprocessed, so its composed text is the same for every run on a server and ONE warm cache serves every
user. Nothing filled it, so the first full-catalog run on a fresh server embedded 22,743 rows on the VM's CPU
while a person waited. ``scripts/warm_cde_cache.py`` fills it ahead of time; this module is what it and the
health probe share.

Two ways to ask, on purpose:

* :func:`count_cached` — HOW MANY rows are cached. Each row's keys come from core's own composer functions (the
  ones ``embed_dictionary`` hashes with) and are looked up without writing, embedding or loading the model. Cheap
  enough for the health probe, which runs it off the request path (:class:`WarmthMonitor`).
* :func:`confirm_warm` — WOULD A RUN EMBED ANYTHING? It runs the run's own ``embed_for_run`` with a provider that
  refuses to embed, so core itself decides and the answer cannot drift from a run's. ``count_cached`` mirrors
  core's hashing, and a mirror can go stale when core changes, so the warm and ``--check`` never trust a
  "fully cached" count until this confirms it. A stale mirror then costs a re-embed, never a cold first run.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from ddharmon.embedding.provider import EmbeddingProvider
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

#: One catalog row's cache keys: (semantic key, value key — ``None`` when the row has no value text to embed).
RowKeys = tuple[str, str | None]

# Hashes per lookup: under SQLite's historical 999-variable ceiling (the query adds model + vector type), and a
# few MB of vectors per batch rather than the whole catalog's ~70 MB at once.
_LOOKUP_CHUNK = 900


def cache_db_path() -> Path:
    """The cache file a run's ``embed_dictionary`` opens: ``$DDHARMON_CACHE/embeddings.db``, else ``~/.ddharmon``."""
    try:
        from ddharmon.embedding.service import _default_cache_dir  # the resolver embed_dictionary itself calls
    except ImportError:  # a core that predates the helper resolved it the same way, inline
        root = os.environ.get("DDHARMON_CACHE")
        return (Path(root) if root else Path.home() / ".ddharmon") / "embeddings.db"
    return Path(_default_cache_dir()) / "embeddings.db"


def row_keys(dd: Any) -> list[RowKeys]:
    """The cache keys a run's ``embed_dictionary`` reads for each row of ``dd``, in field order.

    The same calls core's ``_embed_with_cache`` makes with its default composer: the semantic key over
    ``SEMANTIC_INCLUDE``, and a value key only for a row whose value text is non-empty.
    """
    from ddharmon.embedding.composer import compose_value_content_hash, compose_value_text, composed_content_hash
    from ddharmon.embedding.service import SEMANTIC_INCLUDE

    return [
        (
            composed_content_hash(f, dd, include=SEMANTIC_INCLUDE),
            compose_value_content_hash(f) if compose_value_text(f) else None,
        )
        for f in dd.fields.values()
    ]


def count_cached(keys: list[RowKeys], model_name: str, db_path: Path | None = None) -> tuple[int, int | None]:
    """``(rows whose every vector is cached, width of the cached vectors)`` — read-only.

    A missing cache file is reported as nothing cached WITHOUT creating it. The width is ``None`` when no vector
    is cached; it is what :func:`confirm_warm` needs to stand in for the provider without loading the model.
    """
    from ddharmon.embedding.cache import EmbeddingCache

    db = db_path or cache_db_path()
    if not db.exists():
        return 0, None
    # The width argument is only consulted when a vector is WRITTEN, and this never writes.
    cache = EmbeddingCache(db, 0)
    width: int | None = None
    found: dict[str, set[str]] = {}
    try:
        for vector_type, wanted in (
            ("semantic", sorted({s for s, _ in keys})),
            ("value", sorted({v for _, v in keys if v})),
        ):
            hits: set[str] = set()
            for i in range(0, len(wanted), _LOOKUP_CHUNK):
                got = cache.get_many(model_name, wanted[i : i + _LOOKUP_CHUNK], vector_type=vector_type)
                hits.update(got)
                if width is None and got:
                    width = len(next(iter(got.values())))
            found[vector_type] = hits
    finally:
        cache.close()
    cached = sum(1 for s, v in keys if s in found["semantic"] and (v is None or v in found["value"]))
    return cached, width


class ColdCacheError(RuntimeError):
    """Raised by :class:`RefusingProvider` when a run's embed path asks it for vectors the cache does not hold."""

    def __init__(self, texts: int) -> None:
        super().__init__(f"{texts} text(s) are not in the embedding cache")
        self.texts = texts


class RefusingProvider(EmbeddingProvider):
    """Stands in for the run's provider under the same model name, and refuses to embed anything."""

    def __init__(self, model_name: str, dimension: int) -> None:
        self._model_name = model_name
        self._dimension = dimension

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed(self, texts: list[str]) -> NDArray[np.float32]:
        raise ColdCacheError(len(texts))


class CountingProvider(EmbeddingProvider):
    """Wraps a real provider and counts the texts it is asked to embed (the warm's "vectors embedded")."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.texts = 0

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    @property
    def dimension(self) -> int:
        return self._inner.dimension

    def embed(self, texts: list[str]) -> NDArray[np.float32]:
        self.texts += len(texts)
        return self._inner.embed(texts)


def confirm_warm(dd: Any, model_name: str, dimension: int) -> bool:
    """Whether a run's embed of ``dd`` would be all cache hits — decided by the run's own embed path.

    ``dimension`` is the width of the vectors already cached (from :func:`count_cached`). Nothing is written: core
    writes only the vectors a provider returned, and this provider returns none.
    """
    from backend.engine import adapter

    try:
        adapter.embed_for_run(dd, RefusingProvider(model_name, dimension))
    except ColdCacheError:
        return False
    return True


# ── the health probe's view: computed off the request path, cached in memory ─────────────────


def _stat(path: Path) -> tuple[int, int] | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size


class WarmthMonitor:
    """Per-catalog cache warmth for ``/api/health``: never computed on the request path, never per request.

    :meth:`snapshot` costs a few ``stat`` calls. It returns the last check's result (``None`` per catalog until
    the first one finishes) and, when a catalog file or the cache file changed since that check, starts ONE
    background re-check — at most one in flight, at most one per ``min_interval`` seconds. So the probe follows a
    warm run while the service is up (the case a check computed once at startup would get wrong), and a catalog's
    rows are re-read only when its file changes.

    The figures are :func:`count_cached` counts; the authoritative gate is ``warm_cde_cache.py --check``.
    """

    def __init__(
        self,
        files: Callable[[], Mapping[str, Path]],
        load: Callable[[Path], Any],
        *,
        model_name: Callable[[], str] | None = None,
        min_interval: float = 15.0,
    ) -> None:
        self._files = files
        self._load = load
        self._model_name = model_name or _default_model_name
        self._min_interval = min_interval
        self._lock = threading.Lock()
        self._idle = threading.Event()
        self._idle.set()
        self._result: dict[str, Any] | None = None
        self._checked_for: tuple[Any, ...] | None = None
        self._last_start: float | None = None
        self._keys: dict[str, tuple[tuple[int, int], list[RowKeys]]] = {}  # path -> (file stat, its row keys)
        self.checks = 0  # completed checks (tests assert a check never trips another by touching the cache)

    def snapshot(self) -> dict[str, Any]:
        files = {name: Path(p) for name, p in self._files().items()}
        fingerprint = self._fingerprint(files)
        with self._lock:
            due = self._last_start is None or time.monotonic() - self._last_start >= self._min_interval
            if fingerprint != self._checked_for and self._idle.is_set() and due:
                self._idle.clear()
                self._last_start = time.monotonic()
                try:
                    threading.Thread(
                        target=self._check, args=(files, fingerprint), name="cde-cache-warmth", daemon=True
                    ).start()
                except RuntimeError:  # could not start a thread: report what we have, try again next time
                    self._idle.set()
            result = self._result
        catalogs: dict[str, Any] = dict.fromkeys(files)
        if result is not None:
            catalogs.update({n: dict(v) for n, v in result["catalogs"].items() if n in catalogs})
        return {"checkedAt": result["checkedAt"] if result else None, "catalogs": catalogs}

    def wait(self, timeout: float | None = None) -> bool:
        """Block until no check is in flight (tests and scripts; the request path never calls this)."""
        return self._idle.wait(timeout)

    @staticmethod
    def _fingerprint(files: Mapping[str, Path]) -> tuple[Any, ...]:
        db = cache_db_path()
        return (
            str(db),
            _stat(db),
            _stat(db.with_name(db.name + "-wal")),  # a WAL-mode cache changes here before the main file
            tuple((name, str(path), _stat(path)) for name, path in files.items()),
        )

    def _check(self, files: Mapping[str, Path], fingerprint: tuple[Any, ...]) -> None:
        try:
            model = self._model_name()
            db = cache_db_path()
            catalogs = {name: self._catalog(path, model, db) for name, path in files.items()}
            with self._lock:
                self._result = {"checkedAt": datetime.now(UTC).isoformat(timespec="seconds"), "catalogs": catalogs}
                self._checked_for = fingerprint
                self.checks += 1
        except Exception:
            logger.exception("CDE cache warmth check failed")
            with self._lock:  # not retried until something changes, so a persistent failure cannot spin
                self._checked_for = fingerprint
        finally:
            self._idle.set()

    def _catalog(self, path: Path, model: str, db: Path) -> dict[str, Any]:
        st = _stat(path)
        if st is None:
            return {"rows": None, "cached": None, "warm": False, "error": f"{path.name} is missing"}
        try:
            seen = self._keys.get(str(path))
            if seen is None or seen[0] != st:
                seen = (st, row_keys(self._load(path)))
                self._keys[str(path)] = seen
            keys = seen[1]
            cached, _ = count_cached(keys, model, db)
        except Exception as exc:  # one unreadable catalog must not hide the other's figures
            logger.warning("CDE cache warmth check of %s failed: %s", path, exc)
            return {"rows": None, "cached": None, "warm": None, "error": f"{type(exc).__name__}: {exc}"[:200]}
        return {"rows": len(keys), "cached": cached, "warm": bool(keys) and cached == len(keys)}


def _default_model_name() -> str:
    from backend.engine import adapter

    return adapter.default_embedding_model_name()
