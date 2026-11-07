"""The model list the New Run picker offers, and the ONE default the server runs on.

Core is gaining a registry (``ddharmon.llm.models``: ``DEFAULT_MODEL``, ``MODELS``, ``model_info``). When this
backend's core has it, the picker and the server default follow core, so a model bump is a core release plus a
repin with no UI edit. When it does not (core 1.1.0 on prod, 1.4.0.dev0 on dev), the UI's own fallback list is
served instead. Both paths are pinned here by putting a fake registry into ``sys.modules`` — or a ``None``,
which makes the import fail — so the result never depends on which core this venv happens to have.
"""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.engine import llm
from backend.engine.models import FALLBACK_DEFAULT_MODEL, default_model, model_catalog

_REGISTRY = "ddharmon.llm.models"
_KEYS = {"id", "label", "provider", "validated", "selectable", "inputPerMtok", "outputPerMtok", "tokenRatio"}


@dataclass(frozen=True)
class _FakeModelInfo:
    id: str
    label: str
    provider: str
    validated: bool


def _fake_registry(default: str, models: tuple[_FakeModelInfo, ...]) -> types.ModuleType:
    """A stand-in for core's ``ddharmon.llm.models`` with exactly the shape core ships."""
    mod = types.ModuleType(_REGISTRY)
    by_id = {m.id: m for m in models}
    mod.DEFAULT_MODEL = default  # type: ignore[attr-defined]
    mod.ModelInfo = _FakeModelInfo  # type: ignore[attr-defined]
    mod.MODELS = models  # type: ignore[attr-defined]
    mod.model_info = by_id.get  # type: ignore[attr-defined]
    return mod


@pytest.fixture
def no_registry(monkeypatch):
    """Core without the registry — today's prod (1.1.0) and dev (1.4.0.dev0)."""
    monkeypatch.setitem(sys.modules, _REGISTRY, None)


@pytest.fixture
def core_registry(monkeypatch):
    """Core WITH the registry, naming a model the UI has never heard of as the validated default."""
    reg = _fake_registry(
        "claude-next-5",
        (
            _FakeModelInfo("claude-next-5", "Claude Next 5", "anthropic", True),
            _FakeModelInfo("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", False),
            _FakeModelInfo("gpt-4o", "GPT-4o", "openai", False),
        ),
    )
    monkeypatch.setitem(sys.modules, _REGISTRY, reg)
    return reg


def _assert_default_is_validated_member(catalog: dict[str, Any]) -> None:
    by_id = {m["id"]: m for m in catalog["models"]}
    assert catalog["default"] in by_id, "the default must be one of the models the picker offers"
    assert by_id[catalog["default"]]["validated"] is True, "the default must be a validated model"
    for m in catalog["models"]:
        assert set(m) == _KEYS
        assert isinstance(m["validated"], bool) and isinstance(m["selectable"], bool)
    assert by_id[catalog["default"]]["selectable"] is True, "the default must be selectable"


def test_without_the_core_registry_the_ui_fallback_list_is_served(no_registry):
    cat = model_catalog()
    assert cat["source"] == "fallback"
    assert cat["default"] == FALLBACK_DEFAULT_MODEL == "claude-sonnet-4-6"
    _assert_default_is_validated_member(cat)
    # Only the default is validated in the fallback; the rest are offered but greyed out.
    assert [m["id"] for m in cat["models"] if m["validated"]] == ["claude-sonnet-4-6"]
    assert len(cat["models"]) > 1


def test_with_the_core_registry_the_list_and_default_follow_core(core_registry):
    cat = model_catalog()
    assert cat["source"] == "core"
    assert cat["default"] == "claude-next-5"
    _assert_default_is_validated_member(cat)
    # Core's order and flags are carried through untouched — no UI-side opinion about which model is tested.
    assert [(m["id"], m["label"], m["provider"], m["validated"]) for m in cat["models"]] == [
        ("claude-next-5", "Claude Next 5", "anthropic", True),
        ("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", False),
        ("gpt-4o", "GPT-4o", "openai", False),
    ]


def test_a_registry_missing_a_name_falls_back(monkeypatch):
    """An older registry without ``MODELS`` (AttributeError) degrades to the fallback rather than 500ing."""
    mod = types.ModuleType(_REGISTRY)
    mod.DEFAULT_MODEL = "claude-next-5"  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, _REGISTRY, mod)
    cat = model_catalog()
    assert cat["source"] == "fallback"
    assert cat["default"] == FALLBACK_DEFAULT_MODEL


def test_a_registry_whose_default_is_not_a_validated_member_falls_back(monkeypatch):
    """The picker relies on the default being offered and selectable; a registry breaking that is not trusted."""
    reg = _fake_registry("claude-next-5", (_FakeModelInfo("gpt-4o", "GPT-4o", "openai", True),))
    monkeypatch.setitem(sys.modules, _REGISTRY, reg)
    assert model_catalog()["source"] == "fallback"


@pytest.mark.parametrize("path", ["no_registry", "core_registry"])
def test_the_llm_client_default_is_the_catalog_default(path, request):
    """ONE default on the server: an un-tagged LLM call runs on exactly the model the picker defaults to."""
    request.getfixturevalue(path)
    expected = model_catalog()["default"]
    assert default_model() == expected
    assert llm.build_llm_client(None, "k").model_name == expected
    assert not hasattr(llm, "DEFAULT_CLAUDE_MODEL"), "a second hardcoded default would drift from the catalog"


def test_models_endpoint_serves_the_catalog_and_keeps_the_old_fields(no_registry, monkeypatch):
    """`/api/harmonize/models` keeps `models[].id/provider/label` + `source` (Setup reads them) and adds
    `models[].validated` + `default`."""
    monkeypatch.setattr(app_module, "LITELLM_PROXY_URL", "")
    body = TestClient(app_module.app).get("/api/harmonize/models").json()
    assert body == model_catalog()
    assert body["source"] == "fallback"
    _assert_default_is_validated_member(body)


def test_models_endpoint_follows_the_core_registry(core_registry, monkeypatch):
    monkeypatch.setattr(app_module, "LITELLM_PROXY_URL", "")
    body = TestClient(app_module.app).get("/api/harmonize/models").json()
    assert body["default"] == "claude-next-5"
    assert body["source"] == "core"


class _ProxyResponse:
    def __init__(self, ids: list[str]) -> None:
        self._ids = ids

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return {"data": [{"id": i} for i in self._ids]}


def test_proxy_models_are_marked_validated_from_the_catalog(no_registry, monkeypatch):
    """A proxy lists ids only; whether one is validated (and its label) comes from the same catalog, matched
    through the proxy's `anthropic/` prefix, and the default is the proxy's spelling of the catalog default."""
    import httpx

    monkeypatch.setattr(app_module, "LITELLM_PROXY_URL", "http://proxy.invalid")
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _ProxyResponse(["gpt-4o", "anthropic/claude-sonnet-4-6"]))
    body = TestClient(app_module.app).get("/api/harmonize/models").json()
    assert body["source"] == "proxy"
    by_id = {m["id"]: m for m in body["models"]}
    assert by_id["anthropic/claude-sonnet-4-6"] == {
        "id": "anthropic/claude-sonnet-4-6",
        "label": "Claude Sonnet 4.6",
        "provider": "anthropic",
        "validated": True,
        "selectable": True,
        "inputPerMtok": 3.0,
        "outputPerMtok": 15.0,
        "tokenRatio": 1.0,
    }
    assert by_id["gpt-4o"]["selectable"] is False
    assert by_id["gpt-4o"]["validated"] is False
    assert body["default"] == "anthropic/claude-sonnet-4-6"
    _assert_default_is_validated_member(body)


# ── round 11 (2026-10-14): newer models selectable ahead of their benchmark — only on a core that can call them ──


@dataclass(frozen=True)
class _RulesModelInfo:
    """Core's registry entry once it carries request rules and prices (ddharmon feature/models-5x)."""

    id: str
    label: str
    provider: str
    validated: bool
    selectable: bool = False
    input_per_mtok: float | None = None
    output_per_mtok: float | None = None
    token_ratio: float = 1.0


def test_a_core_with_request_rules_offers_its_selectable_models_with_prices(monkeypatch):
    reg = _fake_registry(
        "claude-sonnet-4-6",
        (
            _RulesModelInfo("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", True, True, 3.0, 15.0, 1.0),
            _RulesModelInfo("claude-haiku-5-5", "Claude Haiku 5.5", "anthropic", False, True, 0.10, 0.50, 1.3),
            _RulesModelInfo("claude-opus-5-5", "Claude Opus 5.5", "anthropic", False, False, 4.0, 20.0, 1.3),
        ),
    )
    monkeypatch.setitem(sys.modules, _REGISTRY, reg)
    by_id = {m["id"]: m for m in model_catalog()["models"]}
    assert by_id["claude-haiku-5-5"] == {
        "id": "claude-haiku-5-5",
        "label": "Claude Haiku 5.5",
        "provider": "anthropic",
        "validated": False,
        "selectable": True,
        "inputPerMtok": 0.10,
        "outputPerMtok": 0.50,
        "tokenRatio": 1.3,
    }
    assert by_id["claude-opus-5-5"]["selectable"] is False


def test_a_core_registry_without_request_rules_offers_only_validated_models(core_registry):
    # A registry from before the request rules (core 1.3.1) cannot call a newer model correctly: selectable = validated.
    cat = model_catalog()
    assert [m["id"] for m in cat["models"] if m["selectable"]] == ["claude-next-5"]
    assert all(m["tokenRatio"] == 1.0 and m["inputPerMtok"] is None for m in cat["models"])


def test_the_fallback_offers_only_the_default_and_lists_no_retired_model(no_registry):
    # The fallback is served when core has NO registry — a core that sends temperature and a forced tool call to every
    # model, which Sonnet 5.5 and Haiku 5.5 reject. So nothing newer is selectable here.
    cat = model_catalog()
    assert [m["id"] for m in cat["models"] if m["selectable"]] == ["claude-sonnet-4-6"]
    ids = {m["id"] for m in cat["models"]}
    assert not ids & {"gemini/gemini-1.5-pro", "claude-opus-4-8"}, "a retired or superseded model is still listed"
