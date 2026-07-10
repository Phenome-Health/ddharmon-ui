"""Shared test fixtures.

Keep the whole suite hermetic w.r.t. the Clerk SSO gate: auth is DISABLED by default regardless of the
developer's shell env or a local ``.env`` (which the app does not auto-load — only uvicorn ``--env-file``
does, for the dev server). Tests that exercise the gate opt in by setting ``CLERK_ISSUER`` themselves
(see test_auth.py's fixtures), which run after this autouse clear.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _clear_clerk_env(monkeypatch):
    for var in ("CLERK_ISSUER", "CLERK_JWKS_URL", "DDHARMON_ALLOWED_EMAIL_DOMAINS", "CLERK_EMAIL_CLAIM"):
        monkeypatch.delenv(var, raising=False)
