"""Build the LLM client for a chosen model tag — one place that maps the run's picked model to a client.

Used by the "analysis ideas" paths (during-run generation + the on-demand endpoint) so they use the SAME
model the run was configured with, instead of whatever the SDK client defaults to. Anthropic (or no explicit
model, which resolves to :func:`backend.engine.models.default_model` — the picker's default; the client's own
hardcoded default is a stale snapshot) → the anthropic SDK client pinned to that Claude model; any other provider
→ ddharmon's unified LiteLLMClient (Phase 7), with a guarded import so Anthropic-only deployments keep working.
"""

from __future__ import annotations

import os
from typing import Any

from backend.engine.models import default_model


def is_anthropic_model(model_tag: str | None) -> bool:
    """Whether a model tag routes to Anthropic (empty = the historical Anthropic default)."""
    mt = str(model_tag).lower() if model_tag else ""
    return not mt or mt.startswith(("claude", "anthropic/"))


def build_llm_client(model_tag: str | None, api_key: str | None) -> Any:
    """Construct the client for ``model_tag``. Anthropic → AnthropicClient pinned to the model; any other
    provider → LiteLLMClient (api_base from ``LITELLM_PROXY_URL``). Raises a clear error if a non-Anthropic
    model is picked but the unified client isn't available in this backend's ddharmon build. No tag → the
    picker's default (the server's ONE default; the AnthropicClient's own dated default 404s on our account, so a
    model is always passed explicitly)."""
    model_tag = model_tag or default_model()
    if is_anthropic_model(model_tag):
        from ddharmon.llm.anthropic_client import AnthropicClient

        model = str(model_tag)
        if model.lower().startswith("anthropic/"):
            model = model.split("/", 1)[1]  # the anthropic SDK wants the bare model id, not a proxy prefix
        return AnthropicClient(model_name=model, api_key=api_key)

    try:
        from ddharmon.llm.litellm_client import LiteLLMClient
    except ImportError as e:
        raise RuntimeError(
            f"Model {model_tag!r} needs the unified LiteLLM client, but this backend's ddharmon package "
            "lacks it. Update the ddharmon dependency (Phase 7 / >=0.7) and set LITELLM_PROXY_URL."
        ) from e
    return LiteLLMClient(
        model_name=str(model_tag), api_key=api_key, api_base=(os.environ.get("LITELLM_PROXY_URL") or None)
    )
