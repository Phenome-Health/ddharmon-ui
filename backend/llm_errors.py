"""Turn an LLM provider failure into an HTTP error the user can act on.

Every BYOK endpoint calls a provider we do not control, and the interesting failures are *expected*
conditions, not bugs: a mistyped key (401), a model the key cannot reach (404), a rate limit (429), an
overload (529). Uncaught, FastAPI renders all of them as a bare ``500 Internal Server Error`` — which reads
as "ddharmon crashed" when the truth is usually "your key was rejected". The frontend already prefers the
server's ``detail`` (``api.ts``), so surfacing a real message here is the whole fix.

Deliberately duck-typed rather than importing the SDKs: Anthropic, OpenAI and LiteLLM all raise exceptions
carrying a ``status_code``, and an Anthropic-only deployment must not import litellm to classify an error.
Anything unrecognized is left alone to become a genuine 500 — this maps expected provider conditions, it does
not blanket-swallow bugs.

BYOK safety: provider text is echoed, so it is redacted for anything key-shaped and length-capped first.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import HTTPException

_SDK_MODULES = frozenset({"anthropic", "openai", "litellm"})
_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}")
_MAX_DETAIL = 400


def _redact(message: str) -> str:
    """Strip anything key-shaped and cap the length before echoing provider text back to the client."""
    text = _KEY_RE.sub("sk-***", " ".join(str(message or "").split()))
    return text[:_MAX_DETAIL].rstrip() + "…" if len(text) > _MAX_DETAIL else text


def _status_of(exc: BaseException) -> int | None:
    """The HTTP status an SDK exception carries, directly or on its ``response``."""
    for candidate in (getattr(exc, "status_code", None), getattr(getattr(exc, "response", None), "status_code", None)):
        if isinstance(candidate, int):
            return candidate
    return None


def is_provider_error(exc: BaseException) -> bool:
    """Whether ``exc`` came from an LLM SDK (by defining module), not from our own code."""
    return type(exc).__module__.split(".", 1)[0].lower() in _SDK_MODULES


def as_http_error(exc: BaseException, *, model: str | None = None) -> HTTPException | None:
    """The HTTPException ``exc`` should surface as, or ``None`` if it is not a provider failure.

    Returning ``None`` is the important half of the contract: an unrecognized exception keeps its 500, so a
    real bug in our code is never disguised as a provider problem.
    """
    if not is_provider_error(exc):
        return None
    status = _status_of(exc)
    named_model = f" {model!r}" if model else ""
    detail = _redact(getattr(exc, "message", None) or str(exc))

    if status in (401, 403):
        return HTTPException(
            status_code=status,
            detail=(
                f"The model provider rejected the API key ({status}). Check the key you supplied — "
                "it is used for this request only and is never stored."
            ),
        )
    if status == 404:
        return HTTPException(
            status_code=400,
            detail=f"The model{named_model} is not available to this API key (404). Choose a different model.",
        )
    if status == 429:
        return HTTPException(
            status_code=429,
            detail="The model provider is rate-limiting this key (429). Wait a moment and retry.",
        )
    if status in (503, 529):
        return HTTPException(
            status_code=503,
            detail=f"The model provider is overloaded ({status}). Retry in a moment — nothing was billed.",
        )
    if status == 400:
        # Usually genuinely actionable ("max_tokens too large", "prompt too long"), so pass it through.
        return HTTPException(status_code=400, detail=f"The model provider rejected the request: {detail}")
    if status is not None and status >= 500:
        return HTTPException(status_code=502, detail=f"The model provider returned a server error ({status}). Retry.")
    if status is None:
        # No status at all = never reached the provider: connection refused, DNS, TLS, or a client timeout.
        return HTTPException(status_code=504, detail=f"Could not reach the model provider: {detail}")
    return HTTPException(status_code=502, detail=f"The model provider failed ({status}): {detail}")


@contextmanager
def llm_call(*, model: str | None = None) -> Iterator[None]:
    """Wrap a provider call so its failures surface as readable HTTP errors.

    Usage::

        with llm_call(model=job.config.get("model_tag")):
            out = generate_analysis_ideas(records, client.complete)
    """
    try:
        yield
    except Exception as exc:
        http = as_http_error(exc, model=model)
        if http is not None:
            raise http from exc
        raise
