"""Tests for the optional Clerk SSO gate (backend/auth.py + the app's auth middleware).

The JWT-verification seam (``auth._decode_claims``) is monkeypatched, so these exercise the
enable/disable switch, bearer/query token extraction, and the (opt-in) email-domain lock WITHOUT
pyjwt or a network round-trip. The deploy installs ``pyjwt[crypto]``; verifying a real Clerk token
is Clerk's + pyjwt's job, not ours.

Two modes:
  * OPEN (``clerk_open``): Clerk configured, no domain allowlist -> any authenticated user passes.
  * LOCKED (``clerk_locked``): Clerk configured + DDHARMON_ALLOWED_EMAIL_DOMAINS -> domain-restricted.

The default (no Clerk env at all) is "auth disabled" — which is why every other backend test keeps
working unchanged: the gate is a pass-through until CLERK_* is set.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import auth

client = TestClient(app_module.app)


def _fake_decode(token: str) -> dict:
    """Test tokens ARE the email (or the ``expired`` sentinel), so cases read as ``Bearer a@b.com``."""
    if token == "expired":
        raise auth.AuthError(401, "Invalid or expired session token")
    return {"email": token, "sub": "user_123"}


@pytest.fixture
def clerk_open(monkeypatch):
    """Gate on, no domain allowlist -> any authenticated user is allowed (the external-users default)."""
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.delenv("DDHARMON_ALLOWED_EMAIL_DOMAINS", raising=False)
    monkeypatch.setattr(auth, "_decode_claims", _fake_decode)


@pytest.fixture
def clerk_locked(monkeypatch):
    """Gate on + domain allowlist -> sign-in restricted to the PH domains (an internal deployment)."""
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setenv("DDHARMON_ALLOWED_EMAIL_DOMAINS", "phenomehealth.org,phenome.health")
    monkeypatch.setattr(auth, "_decode_claims", _fake_decode)


def test_auth_disabled_is_passthrough():
    # Default env has no Clerk config -> the gate is inert and protected routes need no token.
    assert not auth.auth_enabled()
    resp = client.post("/api/harmonize/detect", json={"columns": ["Column Name", "Description"]})
    assert resp.status_code == 200


def test_health_never_gated(clerk_open):
    # /api/health is outside the gated /api/harmonize/ prefix even with the gate on (liveness probe).
    assert client.get("/api/health").status_code == 200


def test_missing_token_is_401(clerk_open):
    resp = client.post("/api/harmonize/detect", json={"columns": ["Column Name"]})
    assert resp.status_code == 401


def test_expired_token_is_401(clerk_open):
    resp = client.post(
        "/api/harmonize/detect",
        json={"columns": ["Column Name"]},
        headers={"Authorization": "Bearer expired"},
    )
    assert resp.status_code == 401


def test_open_mode_any_authenticated_user_passes(clerk_open):
    # No domain lock -> an external Google account is fine as long as the token verifies.
    resp = client.post(
        "/api/harmonize/detect",
        json={"columns": ["Column Name", "Description"]},
        headers={"Authorization": "Bearer collaborator@gmail.com"},
    )
    assert resp.status_code == 200


def test_options_preflight_not_gated(clerk_open):
    # CORS preflight (OPTIONS) has no Authorization header and must not be 401'd by the gate.
    resp = client.options(
        "/api/harmonize/detect",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
    )
    assert resp.status_code != 401


def test_locked_wrong_domain_is_403(clerk_locked):
    resp = client.post(
        "/api/harmonize/detect",
        json={"columns": ["Column Name"]},
        headers={"Authorization": "Bearer eve@gmail.com"},
    )
    assert resp.status_code == 403


def test_locked_allowed_domain_passes(clerk_locked):
    resp = client.post(
        "/api/harmonize/detect",
        json={"columns": ["Column Name", "Description"]},
        headers={"Authorization": "Bearer alice@phenomehealth.org"},
    )
    assert resp.status_code == 200


def test_sse_query_token_fallback_locked(clerk_locked):
    # EventSource can't set headers -> the stream endpoint takes ?token=. A wrong-domain token is
    # rejected (403) by the middleware before the route runs (so we never reach the 404-for-missing-job).
    resp = client.get("/api/harmonize/stream/does-not-exist?token=eve@gmail.com")
    assert resp.status_code == 403


def test_authenticate_unit_open_and_locked(clerk_open, monkeypatch):
    # open: any verified user
    assert auth.authenticate("Bearer anyone@example.com").email == "anyone@example.com"
    with pytest.raises(auth.AuthError):
        auth.authenticate(None)  # no token
    # locked: domain enforced
    monkeypatch.setenv("DDHARMON_ALLOWED_EMAIL_DOMAINS", "phenome.health")
    assert auth.authenticate("Bearer bob@phenome.health").email == "bob@phenome.health"
    with pytest.raises(auth.AuthError):
        auth.authenticate("Bearer mallory@evil.test")


# ── guest "try the demo" path: demo endpoints public, everything else gated ──


def test_demo_endpoints_public_when_gated(clerk_open):
    # The guest demo path needs these reachable WITHOUT a token.
    assert client.get("/api/harmonize/demos").status_code == 200
    # Start is public too; an unknown combo is 404 — the point is it is NOT 401.
    assert client.post("/api/harmonize/demo", json={"datasets": ["nope"]}).status_code != 401


def test_demo_job_result_public_but_real_run_gated(clerk_open):
    store = app_module.store
    store.create("demo-guest-test", "Demo", {"demo": True})
    store.create("real-guest-test", "Real run", {})
    try:
        # A demo-scoped job's result/stream is public (guest can view the demo)...
        assert client.get("/api/harmonize/result/demo-guest-test").status_code == 200
        # ...but a real run's result is gated, and so is the runs list (guests can't see others' data).
        assert client.get("/api/harmonize/result/real-guest-test").status_code == 401
        assert client.get("/api/harmonize/jobs").status_code == 401
    finally:
        store.delete("demo-guest-test")
        store.delete("real-guest-test")
