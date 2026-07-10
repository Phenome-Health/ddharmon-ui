"""Clerk SSO gate for the ddharmon-ui backend.

Optional by construction: the gate is active only when Clerk is configured in the environment
(``CLERK_ISSUER`` or ``CLERK_JWKS_URL``). With no Clerk env set — local dev, the static demo —
:func:`authenticate` returns an anonymous principal and the API is wide open, so those paths work
with zero setup and production turns the gate on purely via env.

When enabled, the gate requires a valid Clerk session JWT. It is **open to any authenticated user by
default** (the tool is meant for external collaborators too); an internal-only deployment opts into an
email-domain lock by setting ``DDHARMON_ALLOWED_EMAIL_DOMAINS``.

Mirrors biomapper-ui's Google-OAuth sign-in, but verifies the Clerk session JWT *directly in FastAPI*
(no Express tier). ``pyjwt`` is imported lazily inside :func:`_decode_claims` so this module loads even
where it isn't installed: tests monkeypatch that seam, and the deploy installs ``pyjwt[crypto]``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


class AuthError(Exception):
    """A request failed authentication (401) or domain authorization (403).

    Carries the HTTP ``status_code``/``detail`` so the app middleware can turn it into a JSON response.
    """

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass
class Principal:
    """The authenticated caller. ``anonymous`` is True only when the gate is disabled (no Clerk env)."""

    email: str | None = None
    subject: str | None = None
    anonymous: bool = False


def _issuer() -> str | None:
    return os.environ.get("CLERK_ISSUER") or None


def _jwks_url() -> str | None:
    """Where to fetch Clerk's signing keys — the explicit URL if given, else derived from the issuer."""
    url = os.environ.get("CLERK_JWKS_URL")
    if url:
        return url
    iss = _issuer()
    return f"{iss.rstrip('/')}/.well-known/jwks.json" if iss else None


def auth_enabled() -> bool:
    """The gate is active iff a JWKS source is configured (directly or via the issuer)."""
    return _jwks_url() is not None


def domain_restriction() -> set[str] | None:
    """The email-domain allowlist, or ``None`` when any authenticated user is allowed.

    Unset or ``*`` -> open (any signed-in user; the default, for external collaborators). A comma list
    (e.g. ``phenomehealth.org,phenome.health,phenomics.ai``) -> restrict sign-in to those domains.
    """
    raw = os.environ.get("DDHARMON_ALLOWED_EMAIL_DOMAINS", "").strip()
    if not raw or raw == "*":
        return None
    return {d.strip().lower().lstrip("@") for d in raw.split(",") if d.strip()}


def _decode_claims(token: str) -> dict[str, Any]:
    """Verify a Clerk RS256 session JWT against the JWKS and return its validated claims.

    Isolated as a seam: tests monkeypatch this to exercise the domain/principal logic without ``pyjwt``
    or a network round-trip. Raises :class:`AuthError` (401) on any verification failure.
    """
    jwks_url = _jwks_url()
    if not jwks_url:  # pragma: no cover - callers gate on auth_enabled() first
        raise AuthError(500, "Auth misconfigured: no JWKS URL")
    try:
        import jwt
        from jwt import PyJWKClient
    except ImportError as exc:  # pragma: no cover - the deploy installs pyjwt[crypto]
        raise AuthError(500, "Auth misconfigured: pyjwt is not installed") from exc
    try:
        signing_key = PyJWKClient(jwks_url).get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=_issuer(),
            options={"require": ["exp"], "verify_aud": False},
        )
    except Exception as exc:  # noqa: BLE001 - any JWKS/decode failure is an auth failure
        raise AuthError(401, "Invalid or expired session token") from exc


def _email_from_claims(claims: dict[str, Any]) -> str | None:
    """Pull the caller's email from the JWT. Configure a Clerk session-token claim named ``email``
    (``{"email": "{{user.primary_email_address}}"}``); the fallbacks cover a couple of other shapes."""
    primary = os.environ.get("CLERK_EMAIL_CLAIM", "email")
    for key in (primary, "email_address", "primary_email_address"):
        value = claims.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _domain_allowed(email: str | None, domains: set[str]) -> bool:
    return bool(email and "@" in email and email.rsplit("@", 1)[1].lower() in domains)


def authenticate(auth_header: str | None, token_qs: str | None = None) -> Principal:
    """Authenticate a request. Returns an anonymous :class:`Principal` when the gate is disabled.

    ``auth_header`` is the raw ``Authorization`` header; ``token_qs`` is the ``?token=`` query fallback
    used by the SSE endpoint (``EventSource`` can't set headers). Requires a valid Clerk JWT; enforces the
    email-domain allowlist only when one is configured (see :func:`domain_restriction`). Raises
    :class:`AuthError` on 401/403.
    """
    if not auth_enabled():
        return Principal(anonymous=True)
    raw: str | None = None
    if auth_header and auth_header.lower().startswith("bearer "):
        raw = auth_header.split(" ", 1)[1].strip()
    elif token_qs:
        raw = token_qs.strip()
    if not raw:
        raise AuthError(401, "Missing authentication token")
    claims = _decode_claims(raw)
    email = _email_from_claims(claims)
    domains = domain_restriction()
    if domains is not None and not _domain_allowed(email, domains):
        raise AuthError(403, "Access is restricted to authorized email domains")
    return Principal(email=email, subject=claims.get("sub"))
