#!/usr/bin/env python3
"""Warm the shared embedding cache with the CDE catalogs, so no user's first run embeds them on the CPU.

Every run embeds the CDE catalog next to the cohort dictionaries, through core's content-addressed embedding cache.
The catalog is never preprocessed, so one warm cache serves every run on the server — and without this step the
first full-catalog run (22,743 rows) embeds them all while a person waits.

    python scripts/warm_cde_cache.py                     # both catalogs (endorsed + full)
    python scripts/warm_cde_cache.py --cde-set full
    python scripts/warm_cde_cache.py --check             # report only: exit 1 unless every row is cached

Run it as the service's user with the service's ``DDHARMON_CACHE`` (unset = ``~/.ddharmon``) and
``DDHARMON_CDE_DIR`` (unset = ``data/cde``) — otherwise it warms a cache the service never reads. ``/api/health``
(``cdeCache``) shows the same figures from the service's side, so a mismatch there means the two disagree on
the cache.

It embeds EXACTLY as a run does, by calling the run's own code: the catalog spec (``backend.app.cde_spec_for``),
the loader (``adapter.load_spec``), the default provider (``adapter.default_embedding_provider``) and the embed
call (``adapter.embed_for_run`` -> core's ``embed_dictionary``, which resolves the same cache a run does).
Idempotent: on a warm cache it embeds nothing and never loads the model. A row counted as cached is confirmed
through that same embed path before it is trusted (``backend.cde_cache.confirm_warm``).

Exit codes: 0 = every requested catalog is warm; 1 = ``--check`` found rows a run would embed, or a warm did not
end warm; 2 = a requested catalog file is missing or loaded no rows. Makes no LLM call and no network request
(beyond the model download a first-ever embed on a fresh machine needs, as a run would).
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from backend import app as app_module  # noqa: E402
from backend import cde_cache  # noqa: E402
from backend.engine import adapter  # noqa: E402

CDE_SETS = ("endorsed", "full")


def _parse(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Warm the shared embedding cache with the CDE catalogs, so no run embeds them on the CPU."
    )
    ap.add_argument(
        "--cde-set", choices=[*CDE_SETS, "both"], default="both", help="which catalog(s) to warm (default: both)"
    )
    ap.add_argument(
        "--check", action="store_true", help="report cached vs total rows only; never embeds; exit 1 if not warm"
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None, *, provider: Any | None = None) -> int:
    """Warm (or ``--check``) the requested catalogs. ``provider`` is injected by tests; a run's default otherwise."""
    args = _parse(argv)
    names = list(CDE_SETS) if args.cde_set == "both" else [args.cde_set]
    files = {name: Path(app_module.CDE_FILES[name]) for name in names}

    missing = [name for name, path in files.items() if not path.exists()]
    for name in missing:
        path = files[name]
        print(
            f"error: CDE catalog {name!r} is missing: {path} does not exist. "
            f"Set DDHARMON_CDE_DIR to the directory that holds {path.name}.",
            file=sys.stderr,
        )
    if missing:
        return 2

    model_name = provider.model_name if provider is not None else adapter.default_embedding_model_name()
    db = cde_cache.cache_db_path()
    print(f"embedding cache: {db}")
    print(f"model:           {model_name}")

    real: list[Any] = [provider] if provider is not None else []

    def run_provider() -> Any:
        """The run's provider, built (the model loaded) only when a row actually needs embedding."""
        if not real:
            print("loading the embedding model ...", flush=True)
            real.append(adapter.default_embedding_provider())
        return real[0]

    def is_warm(dd: Any, keys: list[cde_cache.RowKeys]) -> tuple[int, bool]:
        cached, width = cde_cache.count_cached(keys, model_name, db)
        warm = cached == len(keys) and width is not None and cde_cache.confirm_warm(dd, model_name, width)
        return cached, warm

    status = 0
    for name, path in files.items():
        t0 = time.perf_counter()
        dd = adapter.load_spec(app_module.cde_spec_for(path))
        keys = cde_cache.row_keys(dd)
        rows = len(keys)
        if rows == 0:
            print(f"error: CDE catalog {name!r} ({path}) loaded no rows", file=sys.stderr)
            status = max(status, 2)
            continue
        before, warm = is_warm(dd, keys)

        if args.check:
            if warm:
                verdict = "warm"
            elif before == rows:
                verdict = "COLD (the cached count disagrees with a run's embed path: run the warm)"
                status = max(status, 1)
            else:
                verdict = f"COLD (a run would embed {rows - before:,} of its rows)"
                status = max(status, 1)
            print(f"  {name:<9} {before:>7,} / {rows:,} rows cached · {verdict} · {time.perf_counter() - t0:.1f}s")
            continue

        vectors = 0
        if not warm:
            print(f"  {name:<9} embedding the {rows - before:,} uncached of {rows:,} rows ...", flush=True)
            counting = cde_cache.CountingProvider(run_provider())
            adapter.embed_for_run(dd, counting)
            vectors = counting.texts
            after, warm = is_warm(dd, keys)
            if not warm:
                print(
                    f"error: {name!r} is still not warm after embedding ({after:,} / {rows:,} rows cached)",
                    file=sys.stderr,
                )
                status = max(status, 1)
        newly = rows - before if warm else 0
        print(
            f"  {name:<9} {rows:>7,} rows · {before:>7,} already cached · {newly:>7,} newly cached "
            f"({vectors:,} vectors embedded) · {time.perf_counter() - t0:.1f}s"
        )

    if args.check:
        print("all warm" if status == 0 else "NOT warm — run: python scripts/warm_cde_cache.py")
    return status


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    # The loader's per-name disambiguation notice runs to hundreds of names on the full catalog, and a run logs
    # it anyway; it says nothing about the cache.
    logging.getLogger("ddharmon.ingestion").setLevel(logging.ERROR)
    sys.exit(main())
