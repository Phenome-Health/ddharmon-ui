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


def _entry(
    id: str,
    label: str,
    provider: str,
    validated: bool,
    *,
    selectable: bool | None = None,
    input_per_mtok: float | None = None,
    output_per_mtok: float | None = None,
    token_ratio: float = 1.0,
) -> dict[str, Any]:
    """One picker entry. ``selectable`` defaults to ``validated``: a model is offered only when the core the server
    runs knows how to call it (round 11 — Sonnet 5.5 and Haiku 5.5 reject what an older core sends)."""
    return {
        "id": id,
        "label": label,
        "provider": provider,
        "validated": validated,
        "selectable": validated if selectable is None else selectable,
        "inputPerMtok": input_per_mtok,
        "outputPerMtok": output_per_mtok,
        "tokenRatio": token_ratio,
    }


#: The UI's own list, served only when core has NO registry — a core that sends `temperature` and a forced tool call
#: to every model, which Claude Sonnet 5.5 and Claude Haiku 5.5 reject. So only the default is selectable here; the
#: newer models are listed (greyed out) and become selectable with a core whose registry carries their request rules.
FALLBACK_MODELS: tuple[dict[str, Any], ...] = (
    _entry(FALLBACK_DEFAULT_MODEL, "Claude Sonnet 4.6", "anthropic", True, input_per_mtok=3.0, output_per_mtok=15.0),
    _entry(
        "claude-sonnet-5-5",
        "Claude Sonnet 5.5",
        "anthropic",
        False,
        input_per_mtok=2.0,
        output_per_mtok=10.0,
        token_ratio=1.3,
    ),
    _entry(
        "claude-haiku-5-5",
        "Claude Haiku 5.5",
        "anthropic",
        False,
        input_per_mtok=0.10,
        output_per_mtok=0.50,
        token_ratio=1.3,
    ),
    _entry("gpt-4o", "GPT-4o", "openai", False, input_per_mtok=2.5, output_per_mtok=10.0),
)


def _fallback() -> dict[str, Any]:
    return {"models": [dict(m) for m in FALLBACK_MODELS], "default": FALLBACK_DEFAULT_MODEL, "source": "fallback"}


def _from_core() -> dict[str, Any] | None:
    """Core's registry as the picker's shape, or ``None`` when this core has none (or one that breaks the
    contract the picker relies on: the default must be offered and validated)."""
    try:
        registry = importlib.import_module("ddharmon.llm.models")
        default = str(registry.DEFAULT_MODEL)
        # A registry from before the request rules (core 1.3.1) has no `selectable`/prices: `_entry` then offers only
        # its validated models, which is all that core can call correctly.
        models = [
            _entry(
                str(m.id),
                str(m.label),
                str(m.provider),
                bool(m.validated),
                selectable=bool(m.selectable) if hasattr(m, "selectable") else None,
                input_per_mtok=getattr(m, "input_per_mtok", None),
                output_per_mtok=getattr(m, "output_per_mtok", None),
                token_ratio=float(getattr(m, "token_ratio", 1.0)),
            )
            for m in registry.MODELS
        ]
    except (ImportError, AttributeError):
        return None
    if not any(m["id"] == default and m["validated"] and m["selectable"] for m in models):
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
                **(info or _entry(mid, mid, "", False)),
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
