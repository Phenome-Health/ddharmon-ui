"""The shared demo ships a DECLARED SCORE: its declaration, Gate 1's free hints and Gate 4's match.

The score builder's whole flow — declare on Gate 1 (free), suggest groups on Gate 1 (free, embedding only), match on
Gate 4 (one paid call) — could never be seen on the guest demo: extraction and matching are paid and refused there,
the hints were never fetched for a pinned run, and the demo's per-user work resolves to nothing, so a composite on it
was blanked on every read. The score is now built ONCE, offline, against a clone of the demo's run
(``scripts/build_demo_score.py``), shipped in a sidecar keyed by snapshot filename (``backend/demos/score.json``),
seeded with the demo and served on its payload. It is shipped CONTENT, like the analysis ideas, not anyone's work:
a real run keeps today's per-user behaviour exactly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import demos as demos_module
from backend.artifact_kinds import COMPOSITE, COMPOSITE_SWAP, option_set_key, registry
from backend.demos import list_demos, load_snapshot, staged_snapshot
from backend.jobs import Job

SCORE = "Frailty index (Williams et al. 2019, 49 items)"
COMPONENTS = ["Glaucoma", "Hearing difficulty"]
DECLARATION = [
    {
        "scoreName": SCORE,
        "componentName": name,
        "source": {"kind": "paste", "text": "\n".join(COMPONENTS), "at": 0},
        "chosen": "",
        "alternatives": COMPONENTS,
        "optionSetKey": option_set_key(COMPONENTS),
    }
    for name in COMPONENTS
]
SUGGESTIONS = {
    "scored": True,
    "scoreKind": "dense_cosine",
    "threshold": 0.62,
    "reason": "",
    "billedUsd": 0.0,
    "scores": [
        {
            "scoreName": SCORE,
            "components": [
                {"component": "Glaucoma", "groups": [{"groupId": "c1#g0", "score": 0.81, "bestMember": "A:glc"}]},
                {"component": "Hearing difficulty", "groups": []},
            ],
            "nVariablesIndexed": 2,
        }
    ],
}
SPEC = {
    "definition": {"name": SCORE, "kind": "custom", "components": [{"name": n} for n in COMPONENTS]},
    "matches": [
        {"component": "Glaucoma", "conceptId": "c1#g0", "concept": "Glaucoma diagnosis", "cohorts": ["A"]},
        {"component": "Hearing difficulty", "conceptId": None, "concept": "", "cohorts": []},
    ],
    "feasibility": {"verdict": "partial", "matched": ["Glaucoma"], "missing": ["Hearing difficulty"]},
    "sourceKind": "declaration",
    "billedUsd": 0.15,
}
SCORE_SIDECAR = {"declaration": DECLARATION, "suggestions": SUGGESTIONS, "composite": SPEC}

RESULT = {
    "mode": "batch",
    "records": [
        {"id": "c1#g0", "groupId": "c1#g0", "concept": "Glaucoma diagnosis", "members": ["A:glc"], "cohorts": ["A"]},
        {"id": "c2#g0", "groupId": "c2#g0", "concept": "Hearing aid use", "members": ["B:ha"], "cohorts": ["B"]},
    ],
    "conceptGroups": [{"groupId": "c1#g0"}, {"groupId": "c2#g0"}],
    "conceptGroupMembers": {"c1#g0": ["A:glc"], "c2#g0": ["B:ha"]},
    "fieldIndex": {"A:glc": {"name": "glc"}, "B:ha": {"name": "ha"}},
}


def _staged() -> dict:
    return staged_snapshot(
        ids=["cohorta", "cohortb"],
        display_name="Demo",
        config={"review_mode": "auto", "gate1_scope": ["c1#g0", "c2#g0"]},
        checkpoints=dict.fromkeys(("gate1", "gate2", "gate3", "gate4"), RESULT),
    )


@pytest.fixture
def demo(tmp_path, monkeypatch):
    """A staged demo with a score sidecar beside it, seeded at boot into a fresh app."""
    demo_dir = tmp_path / "demos"
    demo_dir.mkdir()
    (demo_dir / "cohorta_cohortb.json").write_text(json.dumps(_staged()))
    manifest = {
        "datasets": [{"id": "cohorta", "label": "A", "nFields": 1}, {"id": "cohortb", "label": "B", "nFields": 1}],
        "combos": [{"datasets": ["cohorta", "cohortb"], "snapshot": "cohorta_cohortb.json", "label": "A + B"}],
    }
    (demo_dir / "manifest.json").write_text(json.dumps(manifest))
    (demo_dir / "score.json").write_text(json.dumps({"cohorta_cohortb.json": SCORE_SIDECAR}))
    monkeypatch.setattr(demos_module, "_DIR", demo_dir)
    monkeypatch.setattr(demos_module, "_MANIFEST", demo_dir / "manifest.json")
    monkeypatch.setattr(demos_module, "_IDEAS", demo_dir / "analysis_ideas.json")
    monkeypatch.setattr(demos_module, "_SCORE", demo_dir / "score.json")
    app_module.store._jobs.clear()
    boot = tmp_path / "boot"
    boot.mkdir()
    monkeypatch.setattr(app_module, "_DB_PATH", boot / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", boot / "work")
    monkeypatch.setattr(app_module.store, "work_root", boot / "work")
    with TestClient(app_module.app) as client:
        yield client, demos_module.demo_job_id(["cohorta", "cohortb"])


def test_seeding_a_staged_demo_attaches_its_shipped_score(demo):
    _client, demo_id = demo
    job = app_module.store.get(demo_id)
    assert job is not None and job.gate_position == "gate4"
    assert job.composites == [SPEC]
    assert job.demo_score == {"declaration": DECLARATION, "suggestions": SUGGESTIONS}


def test_the_demo_payload_carries_the_declaration_hints_and_match_for_a_guest(demo, monkeypatch):
    """A guest (sign-in gate ON, no token) reads all three off the one result read every gate already makes."""
    client, demo_id = demo
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.test")
    r = client.get(f"/api/harmonize/result/{demo_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["composites"] == [SPEC]
    assert body["demoScore"] == {"declaration": DECLARATION, "suggestions": SUGGESTIONS}


def test_the_demos_shipped_score_stays_out_of_the_runs_list(demo):
    """The list is a summary: the declaration and hints are a gate screen's read, not a row's."""
    client, demo_id = demo
    row = next(j for j in client.get("/api/harmonize/jobs").json() if j["jobId"] == demo_id)
    assert "demoScore" not in row


def test_a_finished_demo_snapshot_takes_its_shipped_score_too():
    from backend.jobs import JobStore

    store = JobStore(work_root=None, db=None)
    snap = {"displayName": "Old", "result": {"records": RESULT["records"], "mode": "batch"}}
    demos_module.seed_snapshot(store, "demo-old", snap, score=SCORE_SIDECAR)
    job = store.get("demo-old")
    assert job.composites == [SPEC] and job.demo_score["declaration"] == DECLARATION


def test_a_pinned_run_keeps_its_shipped_composites_and_a_real_run_is_unchanged():
    """The demo's per-user work resolves to ``{}``, which blanked its composites on every read. Shipped content is
    kept; an OWNED run still reads only its caller's own composites, and carries no demo key at all."""
    shipped = Job(job_id="demo-x", display_name="Demo", config={"demo": True}, composites=[SPEC])
    shipped.demo_score = {"declaration": DECLARATION, "suggestions": SUGGESTIONS}
    pinned = shipped.to_dict({})
    assert pinned["composites"] == [SPEC]
    assert pinned["demoScore"]["declaration"] == DECLARATION

    real = Job(job_id="r1", display_name="Mine", config={"run_mode": "batch"}, composites=[SPEC])
    real.demo_score = {"declaration": DECLARATION, "suggestions": SUGGESTIONS}  # never set on a real run; ignored
    assert real.to_dict({})["composites"] is None
    assert "demoScore" not in real.to_dict({})
    assert real.to_dict({COMPOSITE: [SPEC]})["composites"] == [SPEC]
    assert "demoScore" not in Job(job_id="r2", display_name="x", config={"run_mode": "batch"}).to_dict(None)


# --- the SHIPPED sidecar ------------------------------------------------------------------------------------------

_SIDECAR = Path(demos_module.__file__).resolve().parent / "demos" / "score.json"


def test_the_shipped_demo_score_cites_only_the_shipped_snapshots_groups_and_concepts():
    """The sidecar is keyed by snapshot FILENAME, so a demo rebuilt under the same name would silently keep the old
    run's score — hints naming groups the new run lacks, a match naming concepts it never formed. After a demo
    rebuild, REGENERATE it: ``python scripts/build_demo_score.py --rig <url> --run <id>`` against a rig serving the
    rebuilt run."""
    regenerate = "regenerate backend/demos/score.json with scripts/build_demo_score.py after a demo rebuild"
    by_snapshot = json.loads(_SIDECAR.read_text())
    shipped = 0
    for combo in list_demos()["combos"]:
        score = by_snapshot.get(combo["snapshot"])
        if not combo.get("available") or not score:
            continue
        shipped += 1
        snap = load_snapshot(combo["datasets"]) or {}
        result = snap.get("result", snap)
        groups = {str(g["groupId"]) for g in result.get("conceptGroups") or []}
        fields = set(result.get("fieldIndex") or {})
        records = {str(r["id"]): (r.get("concept") or "").strip() for r in result.get("records") or []}
        name = score["declaration"][0]["scoreName"]

        # The declaration: valid composite_swap rows (a clone would carry them), one score, as the panel writes it.
        spec_kind = registry.get(COMPOSITE_SWAP)
        for row in score["declaration"]:
            spec_kind.check(row)
            assert row["scoreName"] == name and row["chosen"] == ""
        declared = [r["componentName"] for r in score["declaration"]]

        # The hints: every group they name is one of the run's groups, every best member one of its variables.
        hint_groups = [
            (c["component"], g["groupId"], g.get("bestMember"))
            for s in score["suggestions"]["scores"]
            for c in s["components"]
            for g in c["groups"]
        ]
        assert hint_groups, f"{combo['snapshot']}: the shipped hints reach no group — {regenerate}"
        stale = [h for h in hint_groups if h[1] not in groups or (h[2] and h[2] not in fields)]
        assert not stale, f"{combo['snapshot']}: hints cite groups/variables its run lacks: {stale[:3]} — {regenerate}"
        assert {c for c, _g, _m in hint_groups} <= set(declared)

        # The match: named as declared (Gate 4 pairs them by name), and every concept it binds is the run's own.
        spec = score["composite"]
        assert spec["definition"]["name"] == name, "Gate 4 pairs a declaration with its match by the score's name"
        assert [c["name"] for c in spec["definition"]["components"]] == declared
        bound = [m for m in spec["matches"] if m.get("conceptId")]
        assert bound, f"{combo['snapshot']}: the shipped match binds no component — {regenerate}"
        wrong = [
            m["conceptId"]
            for m in bound
            if m["conceptId"] not in records and m["conceptId"] not in groups and m["conceptId"] not in fields
        ]
        assert not wrong, f"{combo['snapshot']}: the match binds concepts its run lacks: {wrong[:3]} — {regenerate}"
        named = [m for m in bound if m["conceptId"] in records and m.get("concept")]
        drift = [m["conceptId"] for m in named if m["concept"].strip() != records[m["conceptId"]]]
        assert (
            not drift
        ), f"{combo['snapshot']}: matched concept names differ from the run's: {drift[:3]} — {regenerate}"
    assert shipped, "the shipped five-cohort demo must carry its declared score"
