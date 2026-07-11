"""Shared test fixtures.

Keep the whole suite hermetic w.r.t. the Clerk SSO gate: auth is DISABLED by default regardless of the
developer's shell env or a local ``.env`` (which the app does not auto-load — only uvicorn ``--env-file``
does, for the dev server). Tests that exercise the gate opt in by setting ``CLERK_ISSUER`` themselves
(see test_auth.py's fixtures), which run after this autouse clear.
"""

from __future__ import annotations

import contextlib
import os
import tempfile

import pytest

# Keep the durable store hermetic: point the work dir + SQLite path at a throwaway temp dir BEFORE the app
# is imported (it reads these at import time), so any test that runs the app lifespan never touches the real
# ``.ddharmon_ui`` / ``jobs.db``. Set at module import — conftest loads before the test modules that import
# the app. Individual tests may further monkeypatch ``app._DB_PATH`` for per-test isolation.
_TEST_ROOT = tempfile.mkdtemp(prefix="ddharmon-ui-test-")
os.environ["DDHARMON_UI_WORK"] = _TEST_ROOT
os.environ["DDHARMON_UI_DB"] = os.path.join(_TEST_ROOT, "jobs.db")


@pytest.fixture(autouse=True)
def _clear_clerk_env(monkeypatch):
    for var in ("CLERK_ISSUER", "CLERK_JWKS_URL", "DDHARMON_ALLOWED_EMAIL_DOMAINS", "CLERK_EMAIL_CLAIM"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture(autouse=True)
def _reset_store():
    """Reset the shared JobStore singleton after each test so persistence/ownership tests can't leak state
    into the next test (bare-``TestClient`` tests never run the lifespan, so their ``store.db`` stays None)."""
    yield
    from backend.jobs import store

    store._jobs.clear()
    if store.db is not None:
        with contextlib.suppress(Exception):  # best-effort teardown
            store.db.close()
        store.db = None
