"""Per-user artifacts — the invariants that make a user's work durable, private, and honestly reported.

These are the five properties from `.planning/USER-DATA-PERSISTENCE-PLAN.md` §10. None of them had coverage
before: the bug that motivated the layer (a composite silently discarded on a demo run, and every user's
annotations sharing one object) survived precisely because no test restarted the store or used two subjects.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module
from backend.artifact_kinds import ANALYSIS_IDEAS, COMPOSITE, VERDICT
from backend.artifacts import ArtifactKind, ArtifactRegistry, ArtifactStore, ReadOnlyRunError, UnknownArtifactKindError
from backend.db import JobDB, _verdicts_from_legacy, _verdicts_to_legacy
from backend.jobs import LOCAL_PRINCIPAL, JobStore

USER_A = "user_aaa"
USER_B = "user_bbb"


@pytest.fixture
def db(tmp_path):
    database = JobDB(tmp_path / "jobs.db")
    yield database
    database.close()


@pytest.fixture
def artifacts(db):
    return ArtifactStore(db)


def _verdict(record_id="r1", axis="match", decision="approve", **extra):
    return {"recordId": record_id, "axis": axis, "decision": decision, "note": "", **extra}


# --- INV-2: one user never sees another's work ------------------------------------------------


def test_two_users_annotating_the_same_run_stay_separate(artifacts):
    """The bug this table exists for: the shared demo gave every user one another's verdicts."""
    artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict(decision="approve"))
    artifacts.put(owner=USER_B, job_id="run-1", kind=VERDICT, payload=_verdict(decision="reject"))

    a = artifacts.get_all(owner=USER_A, job_id="run-1")[VERDICT]
    b = artifacts.get_all(owner=USER_B, job_id="run-1")[VERDICT]
    assert [v["decision"] for v in a] == ["approve"]
    assert [v["decision"] for v in b] == ["reject"]


def test_artifacts_are_scoped_by_run_as_well_as_owner(artifacts):
    artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict())
    assert artifacts.get_all(owner=USER_A, job_id="run-2") == {}


# --- upsert-by-identity: the semantics both features used to hand-roll -------------------------


def test_re_voting_a_record_replaces_rather_than_accumulates(artifacts):
    artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict(decision="approve"))
    artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict(decision="reject"))
    stored = artifacts.get_all(owner=USER_A, job_id="run-1")[VERDICT]
    assert [v["decision"] for v in stored] == ["reject"]


def test_the_three_verdict_axes_are_independent_rows(artifacts):
    """Previously one nested blob per record, so two tabs voting different axes could lose a write."""
    for axis, extra in (("match", {}), ("transform", {"sourceVariable": "UKBB:age"}), ("gencde", {})):
        artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict(axis=axis, **extra))
    stored = artifacts.get_all(owner=USER_A, job_id="run-1")[VERDICT]
    assert sorted(v["axis"] for v in stored) == ["gencde", "match", "transform"]


def test_re_deriving_a_score_replaces_it_but_a_second_score_is_kept(artifacts):
    fried = {"definition": {"name": "Fried frailty phenotype"}, "verdict": "full"}
    artifacts.put(owner=USER_A, job_id="run-1", kind=COMPOSITE, payload=fried)
    artifacts.put(owner=USER_A, job_id="run-1", kind=COMPOSITE, payload={**fried, "verdict": "partial"})
    artifacts.put(owner=USER_A, job_id="run-1", kind=COMPOSITE, payload={"definition": {"name": "FI-Lab"}})

    stored = artifacts.get_all(owner=USER_A, job_id="run-1")[COMPOSITE]
    assert sorted(c["definition"]["name"] for c in stored) == ["FI-Lab", "Fried frailty phenotype"]
    fried_now = next(c for c in stored if c["definition"]["name"] == "Fried frailty phenotype")
    assert fried_now["verdict"] == "partial"  # replaced, not duplicated


def test_a_singleton_kind_holds_one_payload_per_user_and_run(artifacts):
    artifacts.put(owner=USER_A, job_id="run-1", kind=ANALYSIS_IDEAS, payload={"ideas": [{"title": "one"}]})
    artifacts.put(owner=USER_A, job_id="run-1", kind=ANALYSIS_IDEAS, payload={"ideas": [{"title": "two"}]})
    stored = artifacts.get_all(owner=USER_A, job_id="run-1")[ANALYSIS_IDEAS]
    assert stored == {"ideas": [{"title": "two"}]}  # a dict, not a list


# --- INV-1 / INV-4: the demo is immutable, and a dropped write is never a success --------------


def test_writing_to_a_pinned_run_raises_and_names_the_recovery(artifacts):
    with pytest.raises(ReadOnlyRunError, match="clone it"):
        artifacts.put(owner=USER_A, job_id="demo-1", kind=VERDICT, payload=_verdict(), pinned=True)
    assert artifacts.get_all(owner=USER_A, job_id="demo-1") == {}


def test_an_unowned_write_is_refused(artifacts):
    """Without an identity there is nobody to attribute the work to — better to say so than to guess."""
    with pytest.raises(ValueError, match="sign in"):
        artifacts.put(owner="", job_id="run-1", kind=VERDICT, payload=_verdict())


def test_an_unknown_kind_is_refused_on_write_and_delete(artifacts):
    with pytest.raises(UnknownArtifactKindError, match="known:"):
        artifacts.put(owner=USER_A, job_id="run-1", kind="not_a_kind", payload={})
    with pytest.raises(UnknownArtifactKindError):
        artifacts.delete(owner=USER_A, job_id="run-1", kind="not_a_kind", item_key="x")


def test_a_malformed_payload_is_refused_rather_than_stored(artifacts):
    with pytest.raises(ValueError, match="needs a recordId"):
        artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict(record_id=""))
    with pytest.raises(ValueError, match="sourceVariable"):
        artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict(axis="transform"))
    with pytest.raises(ValueError, match="unknown verdict axis"):
        artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict(axis="nonsense"))


def test_put_returns_what_was_stored(artifacts):
    """A write returns the row rather than a bool — the original bug returned True for a dropped write."""
    stored = artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict())
    assert stored.owner_subject == USER_A and stored.kind == VERDICT
    assert stored.item_key == "r1|match|"
    assert stored.payload["decision"] == "approve"


# --- deletion -------------------------------------------------------------------------------


def test_delete_removes_one_artifact_and_reports_whether_it_existed(artifacts):
    artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict())
    assert artifacts.delete(owner=USER_A, job_id="run-1", kind=VERDICT, item_key="r1|match|") is True
    assert artifacts.delete(owner=USER_A, job_id="run-1", kind=VERDICT, item_key="r1|match|") is False
    assert artifacts.get_all(owner=USER_A, job_id="run-1") == {}


def test_deleting_a_run_takes_every_users_artifacts_for_it(artifacts):
    """Otherwise they are orphans that a recycled job id would resurrect against the wrong run."""
    artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict())
    artifacts.put(owner=USER_B, job_id="run-1", kind=VERDICT, payload=_verdict())
    artifacts.put(owner=USER_A, job_id="run-2", kind=VERDICT, payload=_verdict())

    assert artifacts.delete_for_run("run-1") == 2
    assert artifacts.get_all(owner=USER_A, job_id="run-1") == {}
    assert artifacts.get_all(owner=USER_B, job_id="run-1") == {}
    assert artifacts.get_all(owner=USER_A, job_id="run-2")[VERDICT]  # untouched


def test_delete_for_owner_is_a_delete_my_data_path(artifacts):
    artifacts.put(owner=USER_A, job_id="run-1", kind=VERDICT, payload=_verdict())
    artifacts.put(owner=USER_A, job_id="run-2", kind=COMPOSITE, payload={"definition": {"name": "FI"}})
    artifacts.put(owner=USER_B, job_id="run-1", kind=VERDICT, payload=_verdict())

    assert artifacts.delete_for_owner(USER_A) == 2
    assert artifacts.get_all(owner=USER_A, job_id="run-1") == {}
    assert artifacts.get_all(owner=USER_B, job_id="run-1")[VERDICT]


# --- INV-3: survives a restart ----------------------------------------------------------------


def test_artifacts_survive_a_restart(tmp_path):
    """THE gap that produced this design: no existing test ever restarted the store.

    A composite derived against a demo was lost on every deploy, and nothing caught it.
    """
    path = tmp_path / "jobs.db"
    first = JobDB(path)
    ArtifactStore(first).put(owner=USER_A, job_id="run-1", kind=COMPOSITE, payload={"definition": {"name": "Fried"}})
    first.close()

    second = JobDB(path)  # a new process, as after a systemctl restart
    try:
        stored = ArtifactStore(second).get_all(owner=USER_A, job_id="run-1")[COMPOSITE]
        assert [c["definition"]["name"] for c in stored] == ["Fried"]
    finally:
        second.close()


# --- registry -------------------------------------------------------------------------------


def test_registering_a_kind_is_the_whole_cost_of_a_new_persisted_feature(db):
    """The extensibility claim, exercised: a new feature adds one registration and nothing else."""
    local = ArtifactRegistry()
    local.register(ArtifactKind("bookmark", identity=lambda p: p["recordId"]))
    store_ = ArtifactStore(db, local)

    store_.put(owner=USER_A, job_id="run-1", kind="bookmark", payload={"recordId": "r9", "note": "check"})
    assert store_.get_all(owner=USER_A, job_id="run-1")["bookmark"] == [{"recordId": "r9", "note": "check"}]


def test_a_kind_cannot_be_registered_twice():
    local = ArtifactRegistry()
    local.register(ArtifactKind("dup"))
    with pytest.raises(ValueError, match="already registered"):
        local.register(ArtifactKind("dup"))


def test_an_unknown_stored_kind_is_skipped_not_fatal(db):
    """A row written by a newer version of the app must not break an older reader."""
    db.upsert_artifact(
        artifact_id="x1",
        owner_subject=USER_A,
        job_id="run-1",
        kind="from_the_future",
        item_key="k",
        payload={"a": 1},
        schema_version=1,
    )
    assert ArtifactStore(db).get_all(owner=USER_A, job_id="run-1") == {}


def test_a_payload_written_under_an_older_version_is_migrated_forward(db):
    def rename_body_to_text(payload, _stored_version):
        migrated = dict(payload)
        migrated["text"] = migrated.pop("body", "")
        return migrated

    local = ArtifactRegistry()
    local.register(ArtifactKind("note", version=2, identity=lambda p: p["id"], migrate=rename_body_to_text))
    db.upsert_artifact(
        artifact_id="n1",
        owner_subject=USER_A,
        job_id="run-1",
        kind="note",
        item_key="a",
        payload={"id": "a", "body": "old shape"},
        schema_version=1,
    )
    got = ArtifactStore(db, local).get_all(owner=USER_A, job_id="run-1")["note"]
    assert got == [{"id": "a", "text": "old shape"}]


# --- legacy shape round-trip (the wire contract the frontend still reads) ----------------------


def test_legacy_verdict_blob_round_trips_through_the_artifact_shape():
    legacy = {
        "decision": "approve",
        "note": "m",
        "transforms": {"UKBB:age": {"decision": "reject", "note": "t"}},
        "gencde": {"decision": "refine", "note": "g", "edited": {"preferredName": "Age"}},
    }
    payloads = _verdicts_from_legacy("c1#g0", legacy)
    assert len(payloads) == 3
    assert _verdicts_to_legacy(payloads)["c1#g0"] == legacy


def test_a_legacy_blob_with_only_transforms_yields_no_match_verdict():
    payloads = _verdicts_from_legacy("c1#g0", {"transforms": {"UKBB:age": {"decision": "approve"}}})
    assert [p["axis"] for p in payloads] == ["transform"]
    assert "decision" not in _verdicts_to_legacy(payloads)["c1#g0"]


# --- migration ------------------------------------------------------------------------------


def test_backfill_moves_owned_verdicts_and_ideas_but_drops_ownerless_ones(tmp_path):
    """Ownerless (demo) columns hold the cross-user mixture the shared-run bug produced — there is no single
    user they can honestly be attributed to, so they are dropped rather than migrated."""
    path = tmp_path / "jobs.db"
    db_ = JobDB(path)
    store_ = JobStore(db=db_)
    owned = store_.create("run-1", "Mine", {}, owner_subject=USER_A)
    owned.decisions = {"c1#g0": {"decision": "approve", "note": "m"}}
    owned.analysis_ideas = [{"title": "an idea"}]
    db_.upsert(owned)

    shared = store_.create("demo-1", "Demo", {"demo": True})
    shared.decisions = {"c1#g0": {"decision": "reject", "note": "someone else's"}}
    db_.upsert(shared)  # bypass _persist's pinned guard to simulate a pre-fix DB

    assert db_.backfill_artifacts() == 2  # one verdict + one ideas payload, both from the owned run
    artifacts_ = ArtifactStore(db_)
    assert artifacts_.get_all(owner=USER_A, job_id="run-1")[VERDICT][0]["decision"] == "approve"
    assert artifacts_.get_all(owner=USER_A, job_id="run-1")[ANALYSIS_IDEAS] == {"ideas": [{"title": "an idea"}]}
    assert artifacts_.get_all(owner=USER_A, job_id="demo-1") == {}
    db_.close()


def test_backfill_is_idempotent(tmp_path):
    path = tmp_path / "jobs.db"
    db_ = JobDB(path)
    store_ = JobStore(db=db_)
    job = store_.create("run-1", "Mine", {}, owner_subject=USER_A)
    job.decisions = {"c1#g0": {"decision": "approve", "note": ""}}
    db_.upsert(job)

    db_.backfill_artifacts()
    db_.backfill_artifacts()
    assert len(ArtifactStore(db_).get_all(owner=USER_A, job_id="run-1")[VERDICT]) == 1
    db_.close()


# --- through the API --------------------------------------------------------------------------


def _completed_job(job_id="j1", *, config=None, owner=None):
    app_module.store.create(job_id, "A run", config or {}, owner_subject=owner)
    app_module.store.update(job_id, status="complete", result={"records": [{"id": "r1", "concept": "Grip"}]})


def test_verdicts_on_a_demo_are_refused_with_a_403_that_says_what_to_do(tmp_path, monkeypatch):
    """INV-1 through the API: the canonical demo is read-only for everyone."""
    monkeypatch.setenv("DDHARMON_UI_DB", str(tmp_path / "jobs.db"))
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True})
        r = c.post(
            "/api/harmonize/jobs/demo-1/verdict",
            json={"recordId": "r1", "decision": "approve", "axis": "match"},
        )
    assert r.status_code == 403
    assert "clone" in r.json()["detail"].lower()


def test_the_generic_artifact_routes_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        put = c.put(
            "/api/harmonize/jobs/j1/artifacts/composite",
            json={"definition": {"name": "Fried"}, "verdict": "full"},
        )
        assert put.status_code == 200, put.text
        assert put.json()["itemKey"] == "fried"

        got = c.get("/api/harmonize/jobs/j1/artifacts").json()
        assert got["artifacts"][COMPOSITE][0]["definition"]["name"] == "Fried"
        assert COMPOSITE in got["kinds"]

        assert c.delete(f"/api/harmonize/jobs/j1/artifacts/composite/{put.json()['itemKey']}").status_code == 204
        assert c.get("/api/harmonize/jobs/j1/artifacts").json()["artifacts"] == {}


def test_an_unknown_kind_over_the_api_is_a_400(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        r = c.put("/api/harmonize/jobs/j1/artifacts/nope", json={})
    assert r.status_code == 400 and "unknown artifact kind" in r.json()["detail"]


def test_a_verdict_survives_eviction_from_memory(tmp_path, monkeypatch):
    """The user-visible half of INV-3: come back later and your review is still there."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        assert (
            c.post(
                "/api/harmonize/jobs/j1/verdict",
                json={"recordId": "r1", "decision": "approve", "axis": "match", "note": "keep me"},
            ).status_code
            == 200
        )
        app_module.store._jobs.clear()  # evicted / restarted; the run is now DB-hydrated
        decisions = c.get("/api/harmonize/result/j1").json()["decisions"]
    assert decisions["r1"]["decision"] == "approve"
    assert decisions["r1"]["note"] == "keep me"


def test_the_local_principal_is_used_when_the_auth_gate_is_off(tmp_path, monkeypatch):
    """Dev/tests have no identity provider, so all work belongs to one principal — reads and writes must
    agree on that key, which is exactly what broke first."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        c.post("/api/harmonize/jobs/j1/verdict", json={"recordId": "r1", "decision": "approve"})
        stored = app_module.store.artifacts.get_all(owner=LOCAL_PRINCIPAL, job_id="j1")
    assert stored[VERDICT][0]["decision"] == "approve"


def test_deleting_a_run_over_the_api_cascades_to_its_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        c.post("/api/harmonize/jobs/j1/verdict", json={"recordId": "r1", "decision": "approve"})
        artifacts_ = app_module.store.artifacts
        assert artifacts_.get_all(owner=LOCAL_PRINCIPAL, job_id="j1")[VERDICT]
        assert c.delete("/api/harmonize/jobs/j1").status_code == 204
        assert artifacts_.get_all(owner=LOCAL_PRINCIPAL, job_id="j1") == {}


# --- INV-5: cloning ---------------------------------------------------------------------------


def test_cloning_a_demo_yields_an_owned_unpinned_independent_run(tmp_path, monkeypatch):
    """The answer to "how do I keep this?". The copy must NOT inherit demo/pinned, or it would be immutable
    and TTL-exempt — another shared demo, the opposite of the point."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True, "cde_set": "full"})
        r = c.post("/api/harmonize/jobs/demo-1/clone", json={})
        assert r.status_code == 200, r.text
        new_id = r.json()["jobId"]

        clone = app_module.store.get(new_id)
        assert clone.config.get("demo") is None and clone.config.get("clonedFrom") == "demo-1"
        assert clone.config.get("cde_set") == "full"  # non-pinning config is carried
        assert clone.display_name.endswith("(my copy)")

        # the copy is writable, and the demo still is not
        assert (
            c.post(f"/api/harmonize/jobs/{new_id}/verdict", json={"recordId": "r1", "decision": "approve"}).status_code
            == 200
        )
        assert (
            c.post("/api/harmonize/jobs/demo-1/verdict", json={"recordId": "r1", "decision": "approve"}).status_code
            == 403
        )


def test_editing_a_clone_does_not_mutate_the_canonical_demo(tmp_path, monkeypatch):
    """A shallow copy would leave the clone sharing the demo's record list — editing one would edit both."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True})
        new_id = c.post("/api/harmonize/jobs/demo-1/clone", json={}).json()["jobId"]
        app_module.store.get(new_id).result["records"][0]["concept"] = "EDITED"
    assert app_module.store.get("demo-1").result["records"][0]["concept"] == "Grip"


def test_clone_with_my_changes_carries_sandbox_artifacts_and_record_patches(tmp_path, monkeypatch):
    """ "Clone with my changes" needs no guest session or identity merge — the client already holds them."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True})
        r = c.post(
            "/api/harmonize/jobs/demo-1/clone",
            json={
                "displayName": "My frailty review",
                "artifacts": [
                    {"kind": VERDICT, "payload": {"recordId": "r1", "axis": "match", "decision": "approve"}},
                    {"kind": COMPOSITE, "payload": {"definition": {"name": "Fried"}}},
                ],
                "recordPatches": [{"id": "r1", "concept": "Grip strength (corrected)"}],
            },
        )
        assert r.status_code == 200, r.text
        new_id = r.json()["jobId"]
        snapshot = c.get(f"/api/harmonize/result/{new_id}").json()
        # Read the store INSIDE the client block — the lifespan closes the DB on exit.
        stored = app_module.store.artifacts.get_all(owner=LOCAL_PRINCIPAL, job_id=new_id)

    assert snapshot["displayName"] == "My frailty review"
    assert snapshot["decisions"]["r1"]["decision"] == "approve"
    assert snapshot["result"]["records"][0]["concept"] == "Grip strength (corrected)"
    assert [c_["definition"]["name"] for c_ in stored[COMPOSITE]] == ["Fried"]


def test_clone_rejects_a_malformed_artifact_entry(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True})
        r = c.post("/api/harmonize/jobs/demo-1/clone", json={"artifacts": [{"kind": VERDICT}]})
    assert r.status_code == 400


def test_cloning_an_unfinished_run_is_a_409(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        app_module.store.create("j2", "Running", {})
        r = c.post("/api/harmonize/jobs/j2/clone", json={})
    assert r.status_code == 409


# --- the SSE stream: the payload the review surfaces actually read ----------------------------
#
# The workbench and dashboard are driven by /stream, not /result. That made the stream the one read path
# where a bare to_dict() (in-memory mirrors, NOT owner-scoped) still handed out another user's verdicts —
# and the one that had to be scoped before the frontend could safely hydrate from `decisions` at all.


def _stream_payload(client, job_id: str) -> dict:
    """The last `progress` frame of a completed run's stream (it yields once, then returns)."""
    frames = [
        json.loads(line[len("data: ") :])
        for line in client.get(f"/api/harmonize/stream/{job_id}").text.splitlines()
        if line.startswith("data: ")
    ]
    assert frames, "stream produced no progress frame"
    return frames[-1]


def test_the_stream_carries_the_callers_own_verdicts(tmp_path, monkeypatch):
    """Hydration's precondition: what the workbench reads on mount has to contain the saved work."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        c.post(
            "/api/harmonize/jobs/j1/verdict",
            json={"recordId": "r1", "decision": "approve", "axis": "match", "note": "keep me"},
        )
        app_module.store._jobs.clear()  # evicted, as after a restart — the mirror is gone, the rows are not
        decisions = _stream_payload(c, "j1")["decisions"]
    assert decisions["r1"]["decision"] == "approve"
    assert decisions["r1"]["note"] == "keep me"


def test_the_stream_does_not_hand_one_user_anothers_verdicts(tmp_path, monkeypatch):
    """The leak's last foothold. `_apply_decision` also updates the shared in-memory mirror, so an unscoped
    stream frame served USER_B's verdict to whoever asked next — on the demo, that is everyone."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        # B annotates the run: their artifact row is written AND the shared mirror is mutated.
        app_module.store.set_decision("j1", "r1", "reject", note="not mine", subject=USER_B)
        assert app_module.store.get("j1").decisions["r1"]["decision"] == "reject"  # mirror is polluted
        decisions = _stream_payload(c, "j1")["decisions"]  # read as the local principal, i.e. not B
    assert decisions == {}, "the stream leaked another user's verdict"
