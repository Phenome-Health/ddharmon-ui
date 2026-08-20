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
from backend.artifact_kinds import (
    ANALYSIS_IDEAS,
    COMPOSITE,
    COMPOSITE_SWAP,
    GATE1_GROUP_SCOPE,
    GATE1_REGROUP,
    GATE2_CANDIDATE_PICK,
    GATE2_RELATION,
    GATE3_SPEC_EDIT,
    GATE4_EXPORT_SELECTION,
    GATE_DECISION_KINDS,
    VERDICT,
    content_key,
    derive_staleness,
    option_set_key,
)
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


# --- the read paths the review surfaces actually use -----------------------------------------
#
# HISTORY, because it changes what these tests can assert. The workbench and dashboard used to be driven
# by /stream, which made the stream the one read path where a bare to_dict() (in-memory mirrors, NOT
# owner-scoped) still handed out another user's verdicts.
#
# 08-08 (D-03) took the PAYLOAD off the stream entirely: the frame is now live fields plus a
# `resultVersion` token, and the client refetches /result when the token moves. So the leak's foothold is
# gone by construction rather than by scoping — there is no `decisions` key on the frame to leak — and the
# scoping guarantee is asserted where the payload now lives. Both halves are checked below, because
# "the frame is thin" and "the payload is owner-scoped" are different claims and dropping either one is
# how this leak came back the first time.


def _stream_payload(client, job_id: str) -> dict:
    """The last `progress` frame of a completed run's stream (it yields once, then returns)."""
    frames = [
        json.loads(line[len("data: ") :])
        for line in client.get(f"/api/harmonize/stream/{job_id}").text.splitlines()
        if line.startswith("data: ")
    ]
    assert frames, "stream produced no progress frame"
    return frames[-1]


def test_the_stream_frame_carries_no_verdicts_at_all(tmp_path, monkeypatch):
    """D-03: the leak's foothold is removed rather than scoped — the frame has no payload to leak.

    It also cannot regrow one silently: `Job.progress_dict` enumerates its keys positively, so a future
    heavy or user-scoped field has to be added here deliberately.
    """
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        app_module.store.set_decision("j1", "r1", "reject", note="not mine", subject=USER_B)
        frame = _stream_payload(c, "j1")
    for owner_scoped in ("decisions", "result", "analysisIdeas", "composites", "config"):
        assert owner_scoped not in frame, f"{owner_scoped} is back on the 2 Hz frame"
    assert frame["resultVersion"] >= 1, "without a version token the client can never know to refetch"


def test_the_result_endpoint_carries_the_callers_own_verdicts(tmp_path, monkeypatch):
    """Hydration's precondition, moved: what the workbench refetches has to contain the saved work."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        c.post(
            "/api/harmonize/jobs/j1/verdict",
            json={"recordId": "r1", "decision": "approve", "axis": "match", "note": "keep me"},
        )
        app_module.store._jobs.clear()  # evicted, as after a restart — the mirror is gone, the rows are not
        decisions = c.get("/api/harmonize/result/j1").json()["decisions"]
    assert decisions["r1"]["decision"] == "approve"
    assert decisions["r1"]["note"] == "keep me"


def test_the_result_endpoint_does_not_hand_one_user_anothers_verdicts(tmp_path, monkeypatch):
    """The leak's last foothold, re-asserted on the path that now carries the payload.

    `_apply_decision` still updates the shared in-memory mirror, so an UNSCOPED read of a shared run would
    serve USER_B's verdict to whoever asked next — on the demo, that is everyone. /result is artifact-scoped
    and must stay so; moving the payload here would otherwise have moved the leak here with it.
    """
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        app_module.store.set_decision("j1", "r1", "reject", note="not mine", subject=USER_B)
        assert app_module.store.get("j1").decisions["r1"]["decision"] == "reject"  # mirror is polluted
        decisions = c.get("/api/harmonize/result/j1").json()["decisions"]  # read as the local principal
    assert decisions == {}, "the result endpoint leaked another user's verdict"


# --- gate decisions: identity, the option space, and derived staleness (08-11) -----------------
#
# Seven gates multiply the surface the artifact table was built to fix, so the granularity rule is
# load-bearing here rather than stylistic: a decision keys on the THING DECIDED, never on the gate, or two
# tabs interleave a read-modify-write of one gate blob and lose one another's work.


def _pick(group_id="g1", chosen="CDE:1", alternatives=("CDE:1", "CDE:2"), **extra):
    return {
        "groupId": group_id,
        "chosen": chosen,
        "alternatives": list(alternatives),
        "optionSetKey": option_set_key(alternatives),
        **extra,
    }


def test_a_regroup_keys_on_the_variable_moved_not_on_the_gate(artifacts):
    """Two variables moved in two tabs must be two INDEPENDENT rows. Keyed per gate they would be one
    blob, and the second tab's write would drop the first tab's move."""
    for var in ("UKBB:age", "AoU:age_at_visit"):
        artifacts.put(
            owner=USER_A,
            job_id="run-1",
            kind=GATE1_REGROUP,
            payload={
                "memberId": var,
                "chosen": "g2",
                "alternatives": ["g1", "g2"],
                "optionSetKey": option_set_key(["g1", "g2"]),
            },
        )
    stored = artifacts.get_all(owner=USER_A, job_id="run-1")[GATE1_REGROUP]
    assert sorted(d["memberId"] for d in stored) == ["AoU:age_at_visit", "UKBB:age"]


def test_a_candidate_pick_carries_its_option_space(artifacts):
    """R13 is only checkable if the alternatives are addressable from the decision record itself."""
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=_pick())
    stored = artifacts.get_all(owner=USER_A, job_id="run-1")[GATE2_CANDIDATE_PICK][0]
    assert stored["chosen"] == "CDE:1"
    assert stored["alternatives"] == ["CDE:1", "CDE:2"]
    assert stored["optionSetKey"] == option_set_key(["CDE:2", "CDE:1"])  # order-independent


def test_a_decision_payload_with_no_option_set_key_is_refused_and_the_field_is_named(artifacts):
    """A record whose staleness can never be derived is worse than a rejected write."""
    bad = {"groupId": "g1", "chosen": "CDE:1", "alternatives": ["CDE:1"]}
    with pytest.raises(ValueError, match="optionSetKey"):
        artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=bad)
    assert artifacts.get_all(owner=USER_A, job_id="run-1") == {}


def _write_pair(artifacts, *, chosen="CDE:1", alternatives=("CDE:1", "CDE:2")):
    """An upstream Gate 2 pick plus a Gate 3 spec edit that records the upstream content key it saw."""
    upstream = _pick(chosen=chosen, alternatives=alternatives)
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=upstream)
    downstream = {
        "sourceVariable": "UKBB:age",
        "chosen": "spec-a",
        "alternatives": ["spec-a", "spec-b"],
        "optionSetKey": option_set_key(["spec-a", "spec-b"]),
        "upstream": {
            "kind": GATE2_CANDIDATE_PICK,
            "itemKey": "g1",
            "contentKey": content_key(upstream),
        },
    }
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE3_SPEC_EDIT, payload=downstream)


def test_a_downstream_decision_reads_stale_when_its_upstream_changed(artifacts):
    _write_pair(artifacts)
    assert derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1")) == []
    # The reviewer corrects the upstream pick: same option set, different chosen candidate.
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=_pick(chosen="CDE:2"))
    stale = derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1"))
    assert [(s["kind"], s["itemKey"]) for s in stale] == [(GATE3_SPEC_EDIT, "UKBB:age")]


def test_a_downstream_decision_reads_stale_when_the_option_set_itself_changed(artifacts):
    """The other half of "one field serves both": the alternatives moved, not just the choice."""
    _write_pair(artifacts)
    artifacts.put(
        owner=USER_A,
        job_id="run-1",
        kind=GATE2_CANDIDATE_PICK,
        payload=_pick(chosen="CDE:1", alternatives=("CDE:1", "CDE:2", "CDE:3")),
    )
    stale = derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1"))
    assert [s["itemKey"] for s in stale] == ["UKBB:age"]


def test_a_no_op_re_save_of_an_identical_upstream_marks_nothing_stale(artifacts):
    """A timestamp rule would fail here: `upsert_artifact` moves `updated_at` on EVERY write, including a
    re-save of the same candidate, so specs would go stale because the reviewer clicked save twice."""
    _write_pair(artifacts)
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=_pick())
    assert derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1")) == []


def test_a_correction_is_reported_once_however_often_it_is_read(artifacts):
    """A content key is a comparison, not a counter — two reads cannot double-apply one correction."""
    _write_pair(artifacts)
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=_pick(chosen="CDE:2"))
    grouped = artifacts.get_all(owner=USER_A, job_id="run-1")
    first, second = derive_staleness(grouped), derive_staleness(grouped)
    assert len(first) == 1 and first == second


def test_a_run_with_no_downstream_decisions_derives_no_staleness(artifacts):
    """R13's cheap case: a finished run with nothing downstream re-decides with no regeneration step."""
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=_pick())
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, payload=_pick(chosen="CDE:2"))
    assert derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1")) == []


def test_the_first_gate_and_the_last_gate_behave_like_any_other(artifacts):
    """A correction at an edge is not a special case: the first gate has no upstream to compare against,
    and the last gate is compared exactly like the middle one."""
    scope = {
        "groupId": "g1",
        "chosen": "keep",
        "alternatives": ["keep", "drop"],
        "optionSetKey": option_set_key(["keep", "drop"]),
    }
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE1_GROUP_SCOPE, payload=scope)
    export = {
        "recordId": "r1",
        "chosen": "include",
        "alternatives": ["include", "exclude"],
        "optionSetKey": option_set_key(["include", "exclude"]),
        "upstream": {"kind": GATE1_GROUP_SCOPE, "itemKey": "g1", "contentKey": content_key(scope)},
    }
    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE4_EXPORT_SELECTION, payload=export)
    assert derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1")) == []

    artifacts.put(owner=USER_A, job_id="run-1", kind=GATE1_GROUP_SCOPE, payload={**scope, "chosen": "drop"})
    stale = derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1"))
    assert [(s["kind"], s["itemKey"]) for s in stale] == [(GATE4_EXPORT_SELECTION, "r1")]


def test_a_missing_upstream_row_is_not_reported_as_stale(artifacts):
    """Absence is not evidence of change: the upstream decision may simply have been cleared, and claiming
    staleness we cannot see would train the reviewer to ignore the notice."""
    _write_pair(artifacts)
    artifacts.delete(owner=USER_A, job_id="run-1", kind=GATE2_CANDIDATE_PICK, item_key="g1")
    assert derive_staleness(artifacts.get_all(owner=USER_A, job_id="run-1")) == []


def test_every_gate_decision_kind_is_registered_with_an_identity(artifacts):
    """Seven gates, seven kinds, no singleton among them: a singleton IS the per-gate blob."""
    from backend.artifacts import registry as global_registry

    assert len(GATE_DECISION_KINDS) == 7
    for name in GATE_DECISION_KINDS:
        assert not global_registry.get(name).singleton, f"{name} must key on the thing decided"


def test_the_relation_and_swap_kinds_key_on_the_edge_they_decide(artifacts):
    """A relation is per (group, target) and a component swap is per (score, component) — keyed per gate,
    a second relation on the same group would silently replace the first."""
    for target in ("CDE:9", "CDE:10"):
        artifacts.put(
            owner=USER_A,
            job_id="run-1",
            kind=GATE2_RELATION,
            payload={
                "groupId": "g1",
                "targetId": target,
                "chosen": "narrower",
                "alternatives": ["exact", "narrower", "broader"],
                "optionSetKey": option_set_key(["exact", "narrower", "broader"]),
            },
        )
    artifacts.put(
        owner=USER_A,
        job_id="run-1",
        kind=COMPOSITE_SWAP,
        payload={
            "scoreName": "Fried",
            "componentName": "grip strength",
            "chosen": "c-7",
            "alternatives": ["c-7", "c-8"],
            "optionSetKey": option_set_key(["c-7", "c-8"]),
        },
    )
    grouped = artifacts.get_all(owner=USER_A, job_id="run-1")
    assert len(grouped[GATE2_RELATION]) == 2
    assert len(grouped[COMPOSITE_SWAP]) == 1


def test_the_artifacts_read_derives_staleness_on_the_wire(tmp_path, monkeypatch):
    """The screen plans read this: a correction at gate N has to be VISIBLE at gate N+1 after a reload,
    which is the half the shipped workbench got wrong (its flag lived in component state)."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("j1")
        upstream = _pick()
        assert c.put("/api/harmonize/jobs/j1/artifacts/gate2_candidate_pick", json=upstream).status_code == 200
        downstream = {
            "sourceVariable": "UKBB:age",
            "chosen": "spec-a",
            "alternatives": ["spec-a"],
            "optionSetKey": option_set_key(["spec-a"]),
            "upstream": {
                "kind": GATE2_CANDIDATE_PICK,
                "itemKey": "g1",
                "contentKey": content_key(upstream),
            },
        }
        assert c.put("/api/harmonize/jobs/j1/artifacts/gate3_spec_edit", json=downstream).status_code == 200
        assert c.get("/api/harmonize/jobs/j1/artifacts").json()["stale"] == []

        # The reviewer goes back to Gate 2 and picks differently.
        c.put("/api/harmonize/jobs/j1/artifacts/gate2_candidate_pick", json=_pick(chosen="CDE:2"))
        stale = c.get("/api/harmonize/jobs/j1/artifacts").json()["stale"]
    assert [(s["kind"], s["itemKey"]) for s in stale] == [(GATE3_SPEC_EDIT, "UKBB:age")]


# --- the guest walk, and what a pinned run refuses (08-11) ------------------------------------


def _clerk_on(monkeypatch):
    from backend import auth

    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.example.dev")
    monkeypatch.delenv("DDHARMON_ALLOWED_EMAIL_DOMAINS", raising=False)
    monkeypatch.setattr(auth, "_decode_claims", lambda token: {"email": token, "sub": token})


#: Every path a guest must reach to walk the six gates on the demo. Enumerated in the TEST as well as
#: beside the prefix list, because a path added to one and not the other is the failure this pins.
_GUEST_GATE_READS = (
    "/api/harmonize/result/{id}",
    "/api/harmonize/checkpoint/{id}",
    "/api/harmonize/jobs/{id}/artifacts",
    "/api/harmonize/jobs/{id}/export",
)


def test_a_guest_walks_every_gate_read_path_on_the_demo(tmp_path, monkeypatch):
    """R9: a guest walks every gate on the demo without an account. A path a gate screen needs that is not
    demo-scoped breaks the walk AT that gate, which is why the set is asserted rather than sampled."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True})
        _clerk_on(monkeypatch)  # after the run exists: a guest sends no token
        for template in _GUEST_GATE_READS:
            r = c.get(template.format(id="demo-1"))
            assert r.status_code == 200, f"{template} broke the guest walk: {r.status_code} {r.text[:120]}"


def test_a_guest_reaching_a_real_run_by_the_same_path_is_still_gated(tmp_path, monkeypatch):
    """The prefixes are scoped by the store's own demo flag, so widening them for the demo must not expose
    one real run through a shared route."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("real-1", owner="someone")
        _clerk_on(monkeypatch)
        for template in _GUEST_GATE_READS:
            r = c.get(template.format(id="real-1"))
            assert r.status_code == 401, f"{template} exposed a real run to a guest ({r.status_code})"


def test_a_guest_cannot_write_a_gate_decision_even_on_the_demo(tmp_path, monkeypatch):
    """The read widening is READ-only: the write half of the same sub-resource stays gated, and the pinned
    check refuses it a second time behind that."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True})
        _clerk_on(monkeypatch)
        r = c.put(
            "/api/harmonize/jobs/demo-1/artifacts/gate1_group_scope",
            json={
                "groupId": "g1",
                "chosen": "keep",
                "alternatives": ["keep", "drop"],
                "optionSetKey": option_set_key(["keep", "drop"]),
            },
        )
    assert r.status_code == 401


def test_pinned_run_rejects_writes(tmp_path, monkeypatch):
    """T-08-60. Every user sees the one canonical demo row, so a write onto it would put one person's gate
    decisions in front of everybody else. Rejected server-side, and nothing reaches the store."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("demo-1", config={"demo": True})
        decision = {
            "groupId": "g1",
            "chosen": "keep",
            "alternatives": ["keep", "drop"],
            "optionSetKey": option_set_key(["keep", "drop"]),
        }
        for kind in GATE_DECISION_KINDS:
            payload = {**decision, "memberId": "UKBB:age", "targetId": "CDE:9", "sourceVariable": "UKBB:age",
                       "recordId": "r1", "scoreName": "Fried", "componentName": "grip"}
            r = c.put(f"/api/harmonize/jobs/demo-1/artifacts/{kind}", json=payload)
            assert r.status_code == 403, f"{kind} was writable on the shared demo"
            assert "clone" in r.json()["detail"].lower()
        assert app_module.store.artifacts.get_all(owner=LOCAL_PRINCIPAL, job_id="demo-1") == {}


def test_a_foreign_non_demo_run_is_404_not_403(tmp_path, monkeypatch):
    """T-08-62: 403 would confirm the run exists. Asserted on the artifact route because that is the one
    every gate decision rides through."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        _completed_job("theirs", owner="somebody_else")
        _clerk_on(monkeypatch)
        r = c.put(
            "/api/harmonize/jobs/theirs/artifacts/gate1_group_scope",
            json={
                "groupId": "g1",
                "chosen": "keep",
                "alternatives": ["keep"],
                "optionSetKey": option_set_key(["keep"]),
            },
            headers={"Authorization": "Bearer me@example.com"},
        )
    assert r.status_code == 404
