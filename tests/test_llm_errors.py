"""Provider failures surface as readable HTTP errors, not as an opaque 500.

The SDK exceptions are faked rather than imported: the classifier is deliberately duck-typed (an
Anthropic-only deployment must not import litellm to classify an error), so the tests exercise it the same
way — by defining module and ``status_code``.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from backend.llm_errors import as_http_error, is_provider_error, llm_call


def _sdk_error(status: int | None, message: str = "boom", module: str = "anthropic") -> Exception:
    """An exception shaped like an SDK's: a `status_code`, a `message`, and the SDK's defining module."""
    exc = type("FakeSDKError", (Exception,), {"__module__": module})(message)
    exc.message = message  # type: ignore[attr-defined]
    if status is not None:
        exc.status_code = status  # type: ignore[attr-defined]
    return exc


def test_only_sdk_exceptions_are_classified():
    """The important half of the contract: our own bugs keep their 500 rather than being disguised."""
    assert is_provider_error(_sdk_error(401))
    assert not is_provider_error(ValueError("a bug in our code"))
    assert as_http_error(ValueError("a bug in our code")) is None
    assert as_http_error(KeyError("records")) is None


@pytest.mark.parametrize("status", [401, 403])
def test_rejected_key_says_so_and_reassures_about_storage(status):
    """The most likely first-run failure: a mistyped BYOK key. It must not read as our crash."""
    http = as_http_error(_sdk_error(status))
    assert http is not None and http.status_code == status
    assert "rejected the API key" in http.detail
    assert "never stored" in http.detail


def test_missing_model_names_the_model_and_is_a_400():
    http = as_http_error(_sdk_error(404), model="claude-sonnet-4-20250514")
    assert http is not None and http.status_code == 400
    assert "claude-sonnet-4-20250514" in http.detail
    assert "Choose a different model" in http.detail


@pytest.mark.parametrize(
    ("status", "expected_status", "expected_text"),
    [
        (429, 429, "rate-limiting"),
        (529, 503, "overloaded"),  # Anthropic's overload code
        (503, 503, "overloaded"),
        (500, 502, "server error"),
        (400, 400, "rejected the request"),
        (418, 502, "failed"),
    ],
)
def test_status_mapping(status, expected_status, expected_text):
    http = as_http_error(_sdk_error(status))
    assert http is not None and http.status_code == expected_status
    assert expected_text in http.detail


def test_no_status_means_never_reached_the_provider():
    """Connection refused / DNS / TLS / client timeout — a 504, not a 500."""
    http = as_http_error(_sdk_error(None, "Connection error."))
    assert http is not None and http.status_code == 504
    assert "Could not reach the model provider" in http.detail


def test_provider_text_is_redacted_and_capped():
    """BYOK safety: provider text is echoed, so anything key-shaped must not survive into the response."""
    http = as_http_error(_sdk_error(400, "invalid key sk-ant-api03-SECRETSECRETSECRET in request"))
    assert http is not None
    assert "sk-ant-api03-SECRETSECRETSECRET" not in http.detail
    assert "sk-***" in http.detail

    long = as_http_error(_sdk_error(400, "x" * 900))
    assert long is not None and len(long.detail) < 500


def test_llm_call_reraises_our_own_exceptions_untouched():
    with pytest.raises(ValueError, match="a bug in our code"), llm_call():
        raise ValueError("a bug in our code")


def test_llm_call_converts_provider_failures():
    with pytest.raises(HTTPException) as exc, llm_call(model="claude-sonnet-4-6"):
        raise _sdk_error(401)
    assert exc.value.status_code == 401


@pytest.mark.parametrize("module", ["anthropic", "openai", "litellm"])
def test_every_supported_sdk_is_recognized(module):
    assert is_provider_error(_sdk_error(429, module=module))
