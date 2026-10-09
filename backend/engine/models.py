"""The model list the New Run picker offers, and the ONE default model the server runs on.

Core owns the answer when it can: ``ddharmon.llm.models`` (``DEFAULT_MODEL``, ``MODELS``) names the models and
says which ones ddharmon's prompts and benchmarks were validated against. Read from there, a model bump is a
core release plus a repin — no UI edit. A core without that module (1.1.0 on prod, 1.4.0.dev0 on dev) gets the
UI's own fallback list below, in which only the long-standing default is validated.

The picker (``GET /api/harmonize/models``), the static fixture (``scripts/build_static_fixtures.py``) and the LLM
client builder (``engine/llm.py``) all read :func:`model_catalog`, so there is one list and one default.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable, Iterable
from typing import Any

#: The default when core has no registry. The only fallback entry marked validated.
FALLBACK_DEFAULT_MODEL = "claude-sonnet-4-6"

#: The UI's own list, served only when core has no registry. Kept small and provider-diverse so the picker is
#: visibly multi-provider; the unvalidated entries are offered greyed out, never selectable.
FALLBACK_MODELS: tuple[dict[str, Any], ...] = (
    {"id": FALLBACK_DEFAULT_MODEL, "label": "Claude Sonnet 4.6", "provider": "anthropic", "validated": True},
    {"id": "claude-opus-4-8", "label": "Claude Opus 4.8", "provider": "anthropic", "validated": False},
    {"id": "gpt-4o", "label": "GPT-4o", "provider": "openai", "validated": False},
    {"id": "gemini/gemini-1.5-pro", "label": "Gemini 1.5 Pro", "provider": "gemini", "validated": False},
)


def _fallback() -> dict[str, Any]:
    return {"models": [dict(m) for m in FALLBACK_MODELS], "default": FALLBACK_DEFAULT_MODEL, "source": "fallback"}


def _from_core() -> dict[str, Any] | None:
    """Core's registry as the picker's shape, or ``None`` when this core has none (or one that breaks the
    contract the picker relies on: the default must be offered and validated)."""
    try:
        registry = importlib.import_module("ddharmon.llm.models")
        default = str(registry.DEFAULT_MODEL)
        models = [
            {"id": str(m.id), "label": str(m.label), "provider": str(m.provider), "validated": bool(m.validated)}
            for m in registry.MODELS
        ]
    except (ImportError, AttributeError):
        return None
    if not any(m["id"] == default and m["validated"] for m in models):
        return None
    return {"models": models, "default": default, "source": "core"}


def model_catalog() -> dict[str, Any]:
    """``{"models": [{"id", "label", "provider", "validated"}], "default": id, "source": "core" | "fallback"}``.

    Read on every call (it is a dict built from an already-imported module), so it can never disagree with the
    core the server is running.
    """
    return _from_core() or _fallback()


def default_model() -> str:
    """The model an LLM call runs on when the run named none — the picker's default."""
    return str(model_catalog()["default"])


def _bare(model_id: str) -> str:
    """A proxy spells Anthropic models ``anthropic/<id>``; the catalog spells them ``<id>``."""
    m = model_id.lower()
    return m.split("/", 1)[1] if m.startswith("anthropic/") else m


def proxy_catalog(ids: Iterable[str], provider_for: Callable[[str], str]) -> dict[str, Any]:
    """A LiteLLM proxy's model ids in the picker's shape. The proxy says only what it can route; whether a model is
    validated, and its label, come from :func:`model_catalog`. The default is the proxy's spelling of the catalog
    default, else its first validated model, else its first model."""
    catalog = model_catalog()
    known = {_bare(m["id"]): m for m in catalog["models"]}
    models: list[dict[str, Any]] = []
    for mid in ids:
        info = known.get(_bare(mid))
        models.append(
            {
                "id": mid,
                "label": info["label"] if info else mid,
                "provider": provider_for(mid),
                "validated": bool(info and info["validated"]),
            }
        )
    wanted = _bare(catalog["default"])
    default = next((m for m in models if _bare(m["id"]) == wanted), None)
    default = default or next((m for m in models if m["validated"]), models[0] if models else None)
    return {"models": models, "default": default["id"] if default else catalog["default"], "source": "proxy"}
