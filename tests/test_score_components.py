"""The component PROPOSAL route (08-16e) — a model reads the score paper so the reviewer confirms a list.

``POST /api/harmonize/jobs/{id}/score/components`` takes the TEXT the free read already produced (never the
file: re-uploading would double the parse or let the two steps disagree about what was read) and returns the
component NAMES core's transcriber finds in it. Nothing is written into the declaration — extraction PROPOSES,
the reviewer disposes — so this route never touches ``composite_swap`` and never matches.

What the web layer owns, and what these tests pin:

  * the three answers are distinct: a list, an honest "nothing found" (an answer, not an error), and a
    FAILURE (the model's reply could not be read) — never the second dressed as the third or vice versa;
  * rule 2 — a stated coding is shown only when core marks it ``statedInSource``; core's ``definition``
    prose is never forwarded (the 2026-09-22 mislabel finding); and every name is checked word-for-word
    against the text it came from, so a name the document does not contain is FLAGGED, not trusted;
  * the input is bounded — over the cap it is refused with the numbers, never silently cut in half;
  * the same text is not charged twice on the same run (sha256 handle, per-user, per-run cache);
  * the refusals: no key, a passed Gate 1 (the panel's frozen record), the shared demo, an unknown run.

A StubClient stands in for the LLM; no network.
"""

from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module

#: A fragment of the kind of text the free read returns for Searle et al. 2008 — a component table as TEXT.
_TEXT = (
    "A standard procedure for creating a frailty index. Table 1: deficit variables.\n"
    "Help Bathing  Yes = 1, No = 0\n"
    "Help Dressing  Yes = 1, No = 0\n"
    "Self Rating of Health  Poor = 1, Fair = 0.75, Good = 0.5, Very Good = 0.25, Excellent = 0\n"
    "Rapid Pace  See Table 2\n"
    "The index comprises 40 deficits."
)

_TRANSCRIBED = {
    "name": "Frailty index (Searle 2008)",
    "citation": "Searle et al. 2008",
    "kind": "deficit_proportion",
    "combinationRule": "deficits present / deficits considered",
    "threshold": "",
    "notes": "",
    "statedNItems": 40,
    "components": [
        {
            "name": "Help Bathing",
            # Core's `definition` is LLM prose it may label source-stated (2026-09-22). Never forwarded.
            "definition": "Needs help with bathing, self-reported",
            "required": False,
            "coding": {"kind": "categorical", "codeMap": {"Yes": "1", "No": "0"}, "statedInSource": True},
        },
        {
            "name": "Self Rating of Health",
            "definition": "",
            "required": False,
            "coding": {
                "kind": "categorical",
                "codeMap": {"Poor": "1", "Fair": "0.75"},
                "statedInSource": True,
            },
        },
        {
            "name": "Rapid Pace",
            "definition": "",
            "required": False,
            # NOT stated in the source: its cutoff lives in Table 2, which the text does not carry. Whatever a
            # model wrote here must not reach the reviewer as the paper's claim.
            "coding": {"kind": "threshold", "cutoff": "< 0.8 m/s", "statedInSource": False},
        },
    ],
}

_ROUTE = "/api/harmonize/jobs/j1/score/components"


class _Stub:
    """Scripted provider: `reply` is what the transcriber returns; `calls` counts provider calls."""

    reply: str = json.dumps(_TRANSCRIBED)
    calls: int = 0
    prompts: list[str] = []


@pytest.fixture
def stub_llm(monkeypatch, tmp_path):
    _Stub.reply = json.dumps(_TRANSCRIBED)
    _Stub.calls = 0
    _Stub.prompts = []

    class StubClient:
        def __init__(self, *a, **k):
            pass

        def complete(self, prompt, *, system=None, max_tokens=512):
            _Stub.calls += 1
            _Stub.prompts.append(prompt)
            return _Stub.reply

    monkeypatch.setattr("ddharmon.llm.anthropic_client.AnthropicClient", StubClient)
    # Per-test durable store, so the cache under test is this test's alone.
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    return _Stub


def _gate1_job(job_id: str = "j1", *, config: dict | None = None, gate: str | None = "gate1") -> None:
    """A run PARKED at Gate 1 — concept groups, no assigned records. Extraction must not need records."""
    app_module.store.create(job_id, "A run", config or {}, owner_subject=None)
    app_module.store.update(job_id, status="awaiting_review", gate_position=gate)


def _body(text: str = _TEXT, **extra) -> dict:
    return {
        "text": text,
        "sha256": sha256(text.encode("utf-8", "replace")).hexdigest(),
        "provenance": "searle.pdf",
        **extra,
    }


_KEY = {"x-anthropic-key": "sk-test"}


# --- the three answers -----------------------------------------------------------------------------


def test_returns_the_component_names_the_document_states(stub_llm):
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json=_body(), headers=_KEY)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["found"] is True
    # The SOURCE'S wording, in the source's order — not a normalisation of it.
    assert [p["name"] for p in out["components"]] == ["Help Bathing", "Self Rating of Health", "Rapid Pace"]
    assert out["statedNItems"] == 40
    assert out["scoreName"] == "Frailty index (Searle 2008)"
    assert out["cached"] is False
    assert out["sha256"] == _body()["sha256"] and out["nChars"] == len(_TEXT)
    assert stub_llm.calls == 1
    # One call over exactly the text the reviewer read — nothing re-fetched, nothing re-parsed, nothing cut.
    assert _TEXT in stub_llm.prompts[0]


def test_extraction_needs_no_assigned_records(stub_llm):
    """A Gate 1 run has groups but no records; the derive route 409s on that, this one must not."""
    with TestClient(app_module.app) as c:
        _gate1_job()
        assert not (app_module.store.get("j1").result or {}).get("records")
        assert c.post(_ROUTE, json=_body(), headers=_KEY).status_code == 200


def test_a_document_that_names_no_components_is_an_answer_not_an_error(stub_llm):
    stub_llm.reply = json.dumps({"name": "", "components": [], "statedNItems": None})
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json=_body("A correction notice. The authors regret an error in Figure 2."), headers=_KEY)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["found"] is False
    assert out["components"] == []
    assert out["reason"]  # says so, in words


def test_an_unreadable_model_reply_is_a_failure_distinct_from_nothing_found(stub_llm):
    """ "The model returned garbage" must never read as "the paper has no components" — or vice versa."""
    stub_llm.reply = "I'm sorry, I can't help with that."
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json=_body(), headers=_KEY)
        assert r.status_code == 502, r.text
        assert "could not be read" in r.json()["detail"]
        # A failure is not cached: pressing again must actually retry.
        stub_llm.reply = json.dumps(_TRANSCRIBED)
        again = c.post(_ROUTE, json=_body(), headers=_KEY)
    assert again.status_code == 200 and again.json()["cached"] is False


# --- rule 2: never invent what the source did not state ------------------------------------------


def test_coding_is_forwarded_only_when_the_source_states_it(stub_llm):
    with TestClient(app_module.app) as c:
        _gate1_job()
        comps = c.post(_ROUTE, json=_body(), headers=_KEY).json()["components"]
    by = {p["name"]: p for p in comps}
    assert by["Help Bathing"]["coding"]["codeMap"] == {"Yes": "1", "No": "0"}
    # The unstated cutoff a model wrote is NOT passed on as the paper's claim.
    assert by["Rapid Pace"]["coding"] is None
    assert "0.8" not in json.dumps(by["Rapid Pace"])


def test_core_definition_prose_and_required_flag_are_never_forwarded(stub_llm):
    """Core may synthesise `definition` and still mark it statedInSource (todo 2026-09-22); the proposal is
    names + stated coding ONLY. `required` is an LLM per-item guess, not a source fact — not forwarded."""
    with TestClient(app_module.app) as c:
        _gate1_job()
        comps = c.post(_ROUTE, json=_body(), headers=_KEY).json()["components"]
    for p in comps:
        assert set(p) == {"name", "verbatim", "coding"}
    assert "self-reported" not in json.dumps(comps).lower()


def test_a_name_the_document_does_not_contain_is_flagged_not_trusted(stub_llm):
    """The adversarial case in miniature: a table that did not survive extraction, and a model that filled
    the gap. The invented name is KEPT (the reviewer disposes) but marked as not in the text."""
    invented = dict(_TRANSCRIBED)
    invented["components"] = [
        {"name": "Help  bathing", "coding": {}},  # case + whitespace differ: still the document's wording
        {"name": "Grip strength", "coding": {}},  # nowhere in the text
    ]
    stub_llm.reply = json.dumps(invented)
    with TestClient(app_module.app) as c:
        _gate1_job()
        comps = c.post(_ROUTE, json=_body(), headers=_KEY).json()["components"]
    assert [(p["name"], p["verbatim"]) for p in comps] == [("Help  bathing", True), ("Grip strength", False)]


def test_the_verbatim_check_tolerates_spacing_and_punctuation_but_not_different_words(stub_llm):
    """Live verify 3 F6: the PDF read "Severe anxiety/ panic attacks", the model wrote "Severe anxiety / panic
    attacks", and the name started UNTICKED as if the paper did not contain it. Spacing and punctuation are
    layout, not wording; a different WORD is still a different name and still flagged."""
    text = "Table 2. Deficits.\nSevere anxiety/ panic attacks  Yes = 1\nSelf-rated health: poor\nParkinson's disease\n"
    named = dict(_TRANSCRIBED)
    named["components"] = [
        {"name": "Severe anxiety / panic attacks", "coding": {}},  # spacing around "/" differs
        {"name": "Self rated health", "coding": {}},  # hyphen dropped
        {"name": "Parkinsons disease", "coding": {}},  # apostrophe dropped
        {"name": "Severe anxiety or panic attacks", "coding": {}},  # a different word: NOT verbatim
        {"name": "Mild anxiety / panic attacks", "coding": {}},  # a different word: NOT verbatim
    ]
    stub_llm.reply = json.dumps(named)
    with TestClient(app_module.app) as c:
        _gate1_job()
        comps = c.post(_ROUTE, json=_body(text), headers=_KEY).json()["components"]
    assert [(p["name"], p["verbatim"]) for p in comps] == [
        ("Severe anxiety / panic attacks", True),
        ("Self rated health", True),
        ("Parkinsons disease", True),
        ("Severe anxiety or panic attacks", False),
        ("Mild anxiety / panic attacks", False),
    ]


# --- bounded input ---------------------------------------------------------------------------------


def test_text_over_the_cap_is_refused_with_the_numbers_never_truncated(stub_llm):
    from backend.composite import MAX_COMPONENT_EXTRACT_CHARS

    big = "Help Bathing. " * (MAX_COMPONENT_EXTRACT_CHARS // 10)
    assert len(big) > MAX_COMPONENT_EXTRACT_CHARS
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json=_body(big), headers=_KEY)
    assert r.status_code == 413, r.text
    detail = r.json()["detail"]
    assert f"{len(big):,}" in detail and f"{MAX_COMPONENT_EXTRACT_CHARS:,}" in detail
    assert stub_llm.calls == 0  # refused BEFORE anything is spent


def test_empty_text_is_a_400(stub_llm):
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json=_body("   \n "), headers=_KEY)
    assert r.status_code == 400
    assert stub_llm.calls == 0


def test_a_handle_that_does_not_match_the_text_is_refused(stub_llm):
    """The sha256 names "the thing you just looked at"; text that is not that thing is not extracted."""
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json={**_body(), "text": _TEXT + " tampered"}, headers=_KEY)
    assert r.status_code == 400
    assert stub_llm.calls == 0


def test_the_cap_matches_the_frontend_constant():
    """The panel refuses over the cap BEFORE the press; the two numbers must be one number."""
    from backend.composite import MAX_COMPONENT_EXTRACT_CHARS

    src = (Path(__file__).resolve().parents[1] / "frontend/src/lib/score-proposal.ts").read_text()
    m = re.search(r"export const MAX_COMPONENT_EXTRACT_CHARS = ([\d_]+);", src)
    assert m, "frontend/src/lib/score-proposal.ts must export MAX_COMPONENT_EXTRACT_CHARS"
    assert int(m.group(1).replace("_", "")) == MAX_COMPONENT_EXTRACT_CHARS


# --- not charged twice -------------------------------------------------------------------------------


def test_the_same_text_is_not_charged_twice(stub_llm):
    with TestClient(app_module.app) as c:
        _gate1_job()
        first = c.post(_ROUTE, json=_body(), headers=_KEY).json()
        second = c.post(_ROUTE, json=_body(), headers=_KEY).json()
    assert stub_llm.calls == 1
    assert second["cached"] is True
    assert second["components"] == first["components"]


def test_nothing_found_is_cached_too(stub_llm):
    """ "Nothing found" cost a call; asking again for the same text must not buy the same answer twice."""
    stub_llm.reply = json.dumps({"components": []})
    with TestClient(app_module.app) as c:
        _gate1_job()
        c.post(_ROUTE, json=_body(), headers=_KEY)
        again = c.post(_ROUTE, json=_body(), headers=_KEY).json()
    assert stub_llm.calls == 1 and again["cached"] is True and again["found"] is False


def test_different_text_is_a_new_extraction(stub_llm):
    with TestClient(app_module.app) as c:
        _gate1_job()
        c.post(_ROUTE, json=_body(), headers=_KEY)
        c.post(_ROUTE, json=_body(_TEXT + "\nHelp Walking  Yes = 1"), headers=_KEY)
    assert stub_llm.calls == 2


# --- refusals ----------------------------------------------------------------------------------------


def test_no_key_is_refused_before_anything_is_spent(stub_llm, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json=_body())
    assert r.status_code == 400, r.text
    assert "API key" in r.json()["detail"]
    assert r.json()["code"] == "key_required", "the refusal is not machine-readable"
    assert stub_llm.calls == 0


def test_a_passed_gate1_refuses_the_extraction(stub_llm):
    """The panel is a record once Gate 1 is passed (08-27 audit B4); its paid action refuses like its writes."""
    with TestClient(app_module.app) as c:
        _gate1_job(gate="gate2")
        r = c.post(_ROUTE, json=_body(), headers=_KEY)
    assert r.status_code == 409, r.text
    assert "Gate 1" in r.json()["detail"]
    assert stub_llm.calls == 0


def test_the_shared_demo_refuses_before_spending(stub_llm):
    with TestClient(app_module.app) as c:
        _gate1_job(config={"demo": True})
        r = c.post(_ROUTE, json=_body(), headers=_KEY)
    assert r.status_code == 403, r.text
    assert "clone" in r.json()["detail"].lower()
    assert stub_llm.calls == 0


def test_unknown_run_is_a_404(stub_llm):
    with TestClient(app_module.app) as c:
        r = c.post("/api/harmonize/jobs/nope/score/components", json=_body(), headers=_KEY)
    assert r.status_code == 404
    assert stub_llm.calls == 0


def test_a_provider_rejection_surfaces_as_the_providers_condition(stub_llm, monkeypatch):
    class RejectedError(Exception):
        status_code = 401

    RejectedError.__module__ = "anthropic._exceptions"

    class RejectingClient:
        def __init__(self, *a, **k):
            pass

        def complete(self, *a, **k):
            raise RejectedError("invalid x-api-key")

    monkeypatch.setattr("ddharmon.llm.anthropic_client.AnthropicClient", RejectingClient)
    with TestClient(app_module.app) as c:
        _gate1_job()
        r = c.post(_ROUTE, json=_body(), headers=_KEY)
    assert r.status_code == 401
    assert "rejected the API key" in r.json()["detail"]
    assert r.json()["code"] == "key_rejected", "a rejected key must be told apart from a missing one"
