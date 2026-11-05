"""The SOURCE a Gate 1 score declaration records — and where it must never go (phase-8 final review, round 2).

Bhargav: *"if score builder source is pasted text, we should show a record of whatever was entered, same way we
would for a doc."* The panel now writes ``source`` onto every ``composite_swap`` row it writes — the components box
exactly as entered when no document was read, or the read document's handle (never its text) when one was — and
shows the pasted text back as a read-only record (``frontend/src/lib/score-declaration.ts``).

No server code changed for it: ``source`` is an extra payload field the decision layer already stores. What these
tests pin is the two properties that made that safe, so a later change cannot quietly break either:

  * the record PERSISTS — the real artifact route stores the field and serves it back byte for byte, whitespace
    and blank lines included, so the panel's record survives a reload;
  * the pasted text goes NOWHERE NEW — not into the one model call that matches the declared score (the match is
    built from the declared NAMES only), and not into any export file.
"""

from __future__ import annotations

from backend.artifact_kinds import COMPOSITE_SWAP, option_set_key
from tests.test_score_staged import _KEY, _seed, staged  # noqa: F401 — `staged` is a fixture, used by name

#: Never a component name, so finding it anywhere means the source text itself leaked there.
_MARK = "PASTED-SOURCE-MARKER-7f3a"
_PASTED = f"Weight loss\n\n   Weak grip strength\n# {_MARK}: copied from the methods section\n"
_FORMATS = ("score_json", "records_json", "decisions_csv", "eitl_tsv", "notebook_py", "notebook_r")


def _row(name: str, components: list[str], source: dict) -> dict:
    return {
        "scoreName": "Fried",
        "componentName": name,
        "chosen": "",
        "alternatives": components,
        "optionSetKey": option_set_key(components),
        "source": source,
    }


def test_the_pasted_source_is_stored_and_served_back_exactly_as_entered(staged):  # noqa: F811
    client, park, _stub = staged
    job_id = park("gate1")  # Gate 1 is where a declaration is made; past it the write is refused
    components = ["Weight loss", "Weak grip strength"]
    source = {"kind": "paste", "text": _PASTED, "at": 1_790_000_000_000}
    for name in components:
        r = client.put(f"/api/harmonize/jobs/{job_id}/artifacts/{COMPOSITE_SWAP}", json=_row(name, components, source))
        assert r.status_code == 200, r.text

    rows = client.get(f"/api/harmonize/jobs/{job_id}/artifacts").json()["artifacts"][COMPOSITE_SWAP]
    assert sorted(r["componentName"] for r in rows) == sorted(components)
    assert all(r["source"] == source for r in rows), "the record must come back byte for byte, on every row"


def test_the_pasted_source_reaches_no_model_call_and_no_export(staged):  # noqa: F811
    client, park, stub = staged
    job_id = park("gate4")
    components = ["Weight loss", "Weak grip strength"]
    for name in components:
        row = _row(name, components, {"kind": "paste", "text": _PASTED, "at": 1})
        _seed(job_id, COMPOSITE_SWAP, row)

    # The one paid call matches the declared NAMES; the text they were pasted from is not part of the prompt.
    r = client.post(f"/api/harmonize/jobs/{job_id}/composite", json={"declaredScore": "Fried"}, headers=_KEY)
    assert r.status_code == 200, r.text
    assert stub.calls, "the match should have made its one call"
    assert all(_MARK not in system and _MARK not in prompt for system, prompt in stub.calls)
    assert _MARK not in r.text

    for fmt in _FORMATS:
        out = client.get(f"/api/harmonize/jobs/{job_id}/export", params={"format": fmt})
        assert out.status_code == 200, f"{fmt}: {out.text}"
        assert _MARK not in out.text, f"the pasted source leaked into the {fmt} export"
