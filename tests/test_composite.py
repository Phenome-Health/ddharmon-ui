"""Composite / derived-variable endpoints — the web layer's delegation to core.

Covers what the WEB layer owns: source resolution (paste / URL / PDF-extract), ownership + the no-concepts
409, persistence and the same-score upsert, the free re-derive path (`definition` + `overrides` → no LLM
call), and honest 400s for a document that defines no score. The builder's own behaviour (grounding,
feasibility, the derivation recipe) is core's and is tested there — this must not re-test it.

A StubClient stands in for the LLM; no network and no embedding model.
"""

from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module
from backend.artifact_kinds import COMPOSITE
from backend.jobs import LOCAL_PRINCIPAL

_FRIED = {
    "name": "Fried frailty phenotype",
    "citation": "Fried et al. 2001",
    "kind": "criteria_count",
    "combinationRule": "count criteria; >=3 of 5 is frail",
    "threshold": "frail if >=3 of 5",
    "statedNItems": 5,
    "components": [
        {
            "name": "Weak grip strength",
            "definition": "low grip strength by dynamometry",
            "required": True,
            "coding": {"kind": "threshold", "cutoff": "lowest 20%", "statedInSource": True},
        },
        {
            "name": "Weight loss",
            "definition": "unintentional weight loss in the past year",
            "required": True,
            "coding": {"kind": "threshold", "cutoff": ">=10 lbs", "statedInSource": True},
        },
    ],
}

_RECORDS = [
    {
        "id": "c1#g0",
        "groupId": "c1#g0",
        "clusterId": "c1",
        "concept": "Hand grip strength maximum isometric force in kilograms",
        "verdict": "adopt",
        "cde": {"id": "GripStrengthMax"},
        "cohorts": ["UKBB"],
        "members": ["UKBB:grip"],
        "nMembers": 1,
    },
    {
        "id": "c2#g0",
        "groupId": "c2#g0",
        "clusterId": "c2",
        "concept": "Unintentional body weight loss in the past year",
        "verdict": "adopt",
        "cde": {"id": "WeightLossUnintent"},
        "cohorts": ["UKBB", "AoU"],
        "members": ["UKBB:wl", "AoU:wl"],
        "nMembers": 2,
    },
]


@pytest.fixture
def stub_llm(monkeypatch):
    """An LLM that transcribes Fried, then matches both components. Records call count."""
    calls = {"n": 0}

    class StubClient:
        def __init__(self, *a, **k):
            pass

        def complete(self, prompt, *, system=None, max_tokens=512):
            calls["n"] += 1
            if "TRANSCRIBER" in (system or ""):
                return json.dumps(_FRIED)
            return json.dumps(
                {
                    "matches": [
                        {"component": "Weak grip strength", "conceptId": "c1#g0", "confidence": 0.9, "rationale": "r"},
                        {"component": "Weight loss", "conceptId": "c2#g0", "confidence": 0.8, "rationale": "r"},
                    ]
                }
            )

    monkeypatch.setattr("ddharmon.llm.anthropic_client.AnthropicClient", StubClient)
    return calls


def _completed_job(client_app, job_id: str = "j1", *, records=None, owner: str | None = None) -> None:
    client_app.store.create(job_id, "A run", {}, owner_subject=owner)
    client_app.store.update(job_id, status="complete", result={"records": _RECORDS if records is None else records})


def _hdr(token: str | None = None) -> dict:
    h = {"x-anthropic-key": "sk-test"}
    if token:
        h["authorization"] = f"Bearer {token}"
    return h


# --- derive -----------------------------------------------------------------------------------


def test_derive_from_pasted_text_returns_the_core_payload(stub_llm):
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post(
            "/api/harmonize/jobs/j1/composite",
            json={"sourceText": "Fried phenotype: five criteria, frail at three or more."},
            headers=_hdr(),
        )
    assert r.status_code == 200, r.text
    spec = r.json()
    assert spec["definition"]["name"] == "Fried frailty phenotype"
    assert spec["definition"]["kind"] == "criteria_count"
    assert spec["feasibility"]["verdict"] == "full"
    # Grip strength is UKBB-only, so only UKBB can compute the phenotype.
    assert spec["feasibility"]["computableCohorts"] == ["UKBB"]
    assert spec["callsMade"] == 2 and spec["nConceptsIndexed"] == 2
    assert spec["sourceKind"] == "paste"
    assert [s["kind"] for s in spec["derivation"]][-2:] == ["combine", "threshold"]


def test_derive_persists_and_upserts_by_score_name(stub_llm, tmp_path, monkeypatch):
    """A re-derive REPLACES that score rather than appending — one verdict per score, always current.

    The identity now comes from the `composite` artifact kind rather than a hand-rolled list rebuild, but
    the guarantee is the same one the panel depends on.
    """
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        c.post("/api/harmonize/jobs/j1/composite", json={"sourceText": "Fried text"}, headers=_hdr())
        c.post("/api/harmonize/jobs/j1/composite", json={"sourceText": "Fried text again"}, headers=_hdr())
        stored = c.get("/api/harmonize/result/j1").json()["composites"]
    assert len(stored) == 1
    assert stored[0]["definition"]["name"] == "Fried frailty phenotype"
    assert stored[0]["definition"]["kind"] == "criteria_count"


def test_a_second_distinct_score_is_kept_alongside_the_first(stub_llm, tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        c.post("/api/harmonize/jobs/j1/composite", json={"sourceText": "Fried text"}, headers=_hdr())
        # A different score, written through the same store the endpoint uses.
        app_module.store.artifacts.put(
            owner=LOCAL_PRINCIPAL,
            job_id="j1",
            kind=COMPOSITE,
            payload={"definition": dict(_FRIED, name="FI-Lab")},
        )
        names = {s["definition"]["name"] for s in c.get("/api/harmonize/result/j1").json()["composites"]}
    assert names == {"Fried frailty phenotype", "FI-Lab"}


def test_a_derived_composite_survives_a_restart(stub_llm, tmp_path, monkeypatch):
    """The bug that started this: a composite vanished on every service restart.

    Derive, drop the in-memory store the way a restart does, and read it back.
    """
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        assert (
            c.post("/api/harmonize/jobs/j1/composite", json={"sourceText": "Fried"}, headers=_hdr()).status_code == 200
        )
        app_module.store._jobs.clear()  # evicted / restarted -> the run is DB-hydrated from here on
        stored = c.get("/api/harmonize/result/j1").json()["composites"]
    assert [s["definition"]["name"] for s in stored] == ["Fried frailty phenotype"]


def test_deriving_on_the_shared_demo_is_refused_rather_than_silently_dropped(stub_llm, tmp_path, monkeypatch):
    """It used to return 200 and discard the spec — the reviewer paid for a derivation that vanished."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job(app_module, "demo-1")
        app_module.store.get("demo-1").config["demo"] = True
        r = c.post("/api/harmonize/jobs/demo-1/composite", json={"sourceText": "Fried"}, headers=_hdr())
    assert r.status_code == 403 and "clone" in r.json()["detail"].lower()


def test_rederive_from_a_definition_with_all_components_pinned_costs_no_llm_call(stub_llm):
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        first = c.post("/api/harmonize/jobs/j1/composite", json={"sourceText": "Fried"}, headers=_hdr()).json()
        assert stub_llm["n"] == 2
        again = c.post(
            "/api/harmonize/jobs/j1/composite",
            json={
                "definition": first["definition"],
                "overrides": {"Weak grip strength": "c1#g0", "Weight loss": None},
            },
            headers=_hdr(),
        )
    assert again.status_code == 200, again.text
    spec = again.json()
    assert stub_llm["n"] == 2  # no extraction, no judge pass — the reviewer edit loop is free
    assert spec["callsMade"] == 0 and spec["sourceKind"] == "definition"
    assert spec["feasibility"]["verdict"] == "partial"
    assert spec["feasibility"]["missing"] == ["Weight loss"]


def test_rederive_tolerates_an_unknown_kind_instead_of_500ing(stub_llm):
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        bad = dict(_FRIED, kind="not-a-kind")
        bad["components"] = [dict(_FRIED["components"][0], coding={"kind": "nonsense", "statedInSource": True})]
        r = c.post(
            "/api/harmonize/jobs/j1/composite",
            json={"definition": bad, "overrides": {"Weak grip strength": "c1#g0"}},
            headers=_hdr(),
        )
    assert r.status_code == 200, r.text
    assert r.json()["definition"]["kind"] == "custom"  # fell back rather than erroring


def test_rederive_without_components_is_a_400():
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post("/api/harmonize/jobs/j1/composite", json={"definition": {"name": "x"}}, headers=_hdr())
    assert r.status_code == 400 and "definition" in r.json()["detail"]


# --- source resolution + honest failures -------------------------------------------------------


def test_no_source_at_all_is_a_400_not_a_500():
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post("/api/harmonize/jobs/j1/composite", json={}, headers=_hdr())
    assert r.status_code == 400
    assert "pasted text" in r.json()["detail"]


def test_a_document_that_defines_no_score_is_a_400_carrying_the_reason(monkeypatch):
    """Core raises ValueError when no components can be read — that is a client-facing 400, not a crash."""

    class StubClient:
        def __init__(self, *a, **k):
            pass

        def complete(self, prompt, *, system=None, max_tokens=512):
            return json.dumps({"name": "nothing here"})  # no components

    monkeypatch.setattr("ddharmon.llm.anthropic_client.AnthropicClient", StubClient)
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post("/api/harmonize/jobs/j1/composite", json={"sourceText": "a journal landing page"}, headers=_hdr())
    assert r.status_code == 400
    assert "no score components" in r.json()["detail"]


def test_source_ref_is_fetched_through_core(monkeypatch, stub_llm):
    """A URL/DOI/repo goes through core's bounded fetch — the web layer must not roll its own."""
    seen: list[str] = []

    def fake_from_url(ref, **kw):
        from ddharmon.harmonization.score_sources import ScoreSource

        seen.append(ref)
        return ScoreSource(text="Fried phenotype definition", kind="url", provenance=ref)

    monkeypatch.setattr("backend.composite.from_url", fake_from_url)
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post(
            "/api/harmonize/jobs/j1/composite",
            json={"sourceRef": "10.1007/s11357-017-9993-7"},
            headers=_hdr(),
        )
    assert r.status_code == 200, r.text
    assert seen == ["10.1007/s11357-017-9993-7"]
    assert r.json()["definition"]["provenance"] == "10.1007/s11357-017-9993-7"


def test_pdf_extract_returns_text_for_review_and_spends_nothing(monkeypatch):
    """Extraction is its own $0 route so a bad PDF (a publisher interstitial, a table that didn't survive)
    is discovered BEFORE a derivation is paid for."""
    monkeypatch.setattr("ddharmon.harmonization.score_sources.pdf_to_text", lambda data: "FI-Lab: 32 deficits")
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post(
            "/api/harmonize/jobs/j1/composite/extract",
            files={"file": ("fi-lab.pdf", b"%PDF-1.4 ...", "application/pdf")},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == "FI-Lab: 32 deficits"
    assert body["provenance"] == "fi-lab.pdf" and body["nChars"] == len(body["text"])
    assert len(body["sha256"]) == 64


def test_pdf_extract_rejects_a_non_pdf_body_with_a_clear_message():
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post(
            "/api/harmonize/jobs/j1/composite/extract",
            files={"file": ("access.pdf", b"<html>Access check</html>", "application/pdf")},
        )
    assert r.status_code == 400 and "not a PDF" in r.json()["detail"]


def test_word_supplement_extract_reads_the_item_table():
    """A score's item table usually lives in the supplement, and supplements are routinely .docx.

    Uses a REAL .docx (not a stub) because the thing worth testing is that table cells survive at all —
    python-docx's paragraph iteration drops them, which would silently lose the item list.
    """
    docx = pytest.importorskip("docx")
    buffer = io.BytesIO()
    document = docx.Document()
    document.add_paragraph("Supplementary Table 1. Frailty index items.")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Deficit"
    table.cell(0, 1).text = "Cut-point"
    table.cell(1, 0).text = "Hemoglobin"
    table.cell(1, 1).text = "<130 g/L"
    document.save(buffer)

    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post(
            "/api/harmonize/jobs/j1/composite/extract",
            files={
                "file": (
                    "supplement.docx",
                    buffer.getvalue(),
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "Supplementary Table 1" in body["text"]
    assert "Hemoglobin | <130 g/L" in body["text"]  # the table survived, structure and all
    assert body["provenance"] == "supplement.docx"


def test_upload_is_routed_by_magic_number_not_by_filename(monkeypatch):
    """Uploads arrive with whatever name the browser had; the bytes decide which reader runs."""
    monkeypatch.setattr("ddharmon.harmonization.score_sources.pdf_to_text", lambda data: "FI-Lab: 32 deficits")
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post(
            "/api/harmonize/jobs/j1/composite/extract",
            files={"file": ("mislabeled.docx", b"%PDF-1.4 ...", "application/octet-stream")},
        )
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "FI-Lab: 32 deficits"  # read as the PDF it actually is


def test_legacy_doc_upload_says_to_re_save_it():
    """A binary .doc is a different format, not a broken .docx — the message has to say so."""
    with TestClient(app_module.app) as c:
        _completed_job(app_module)
        r = c.post(
            "/api/harmonize/jobs/j1/composite/extract",
            files={"file": ("supplement.doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 old word", "application/msword")},
        )
    assert r.status_code == 400 and "legacy binary .doc" in r.json()["detail"]


# --- gating -----------------------------------------------------------------------------------


def test_unknown_job_and_a_run_with_no_concepts(stub_llm):
    with TestClient(app_module.app) as c:
        assert c.post("/api/harmonize/jobs/nope/composite", json={"sourceText": "x"}, headers=_hdr()).status_code == 404
        _completed_job(app_module, "empty", records=[])
        r = c.post("/api/harmonize/jobs/empty/composite", json={"sourceText": "x"}, headers=_hdr())
    assert r.status_code == 409 and "no harmonized concepts" in r.json()["detail"]


def _decode_by_token(token: str) -> dict:
    """Test tokens 'A'/'B' map to distinct Clerk subjects (mirrors test_backend's helper)."""
    from backend import auth

    subs = {"A": "user_A", "B": "user_B"}
    if token not in subs:
        raise auth.AuthError(401, "bad token")
    return {"sub": subs[token], "email": f"{subs[token]}@example.org"}


def test_another_users_run_is_not_derivable(monkeypatch, tmp_path, stub_llm):
    """Ownership is enforced by the same _visible_to guard the other job routes use."""
    from backend import auth

    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.setattr(auth, "_decode_claims", _decode_by_token)

    with TestClient(app_module.app) as c:
        _completed_job(app_module, "owned", owner="user_A")
        assert (
            c.post("/api/harmonize/jobs/owned/composite", json={"sourceText": "x"}, headers=_hdr("B")).status_code
            == 404
        )
        assert (
            c.post("/api/harmonize/jobs/owned/composite", json={"sourceText": "x"}, headers=_hdr("A")).status_code
            == 200
        )
