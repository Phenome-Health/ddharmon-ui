"""The dual-key identity of an ACCEPTED GenCDE - the artifact a later run reuses as an anchor.

The short-term answer to "where do accumulated GenCDEs live" is REUSE: run cohorts A-B-C, then run D-E-F
carrying the accepted elements forward as anchors. The long-term answer is CONVERGENCE on the NIH catalog,
with any cross-user collection a staging area with a promotion path rather than a competing registry. That
decision is what these tests pin, and each of the four parts below is load-bearing:

- **Two keys, and the PRIVATE one is primary.** ``id`` is ``DDHARMON:u<user>/<ulid>`` and is what every gate
  decision and the personal catalog reference. ``digest`` is a content hash over a canonical concept form.
  A digest ENCODES THE CONCEPT, so using it as the primary key would leak what a user harmonized onto any
  shared surface - putting a privacy decision inside the primary key of a table built to be private.
- **The digest names its algorithm version.** Content-addressing looks like it forces the canonicalization
  question now; it does not, if the algorithm is versioned. ``published`` gates every cross-user comparison
  and publishing is opt-in, so a better canonical form ships as an additive v2 recompute over PUBLISHED
  rows only - never as a migration over every user's accumulated catalog.
- **``tinyId`` stays EMPTY.** ``src/ddharmon/export/cde_json.py`` refuses to mint one ("NIH assigns on
  acceptance; an invented id would collide with a real one"), and KRAKEN keys NIH CDEs as ``CDE:<tinyId>``
  1:1 - so a synthesized tinyId corrupts that downstream mapping, not merely NIH's namespace.
- **The catalog is gated on a recorded HUMAN verdict, never on "it was generated".** A GenCDE that was wrong
  in run 1 becomes an ANCHOR in run 2, where the error stops surfacing as a reviewable novel and starts
  being reinforced as a match. Requiring a verdict is what keeps "which elements may be reused" answerable
  from stored state.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module
from backend.artifact_kinds import (
    ACCEPTED_GENCDE,
    DIGEST_ALGO,
    accept_gencde,
    concept_digest,
    personal_catalog,
)
from backend.artifacts import ArtifactStore
from backend.db import JobDB

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


def _concept(**over):
    return {
        "title": "Grip strength, dominant hand",
        "dataType": "Number",
        "units": "kg",
        "permissibleValues": [],
        **over,
    }


def _accepted(record_id="r1", *, owner=USER_A, verdict="accept", **over):
    return accept_gencde(
        {"recordId": record_id, "verdict": verdict, "concept": _concept(**over)},
        owner_subject=owner,
    )


# --- the two keys ------------------------------------------------------------------------------


def test_an_accepted_gencde_carries_a_private_user_scoped_identifier():
    """The primary key is private by construction: a gate decision referencing it reveals nothing about
    the concept, which is the whole reason the digest is NOT the identifier."""
    payload = _accepted()
    assert payload["id"].startswith("DDHARMON:u")
    user_part, _, ulid = payload["id"].removeprefix("DDHARMON:").partition("/")
    assert len(ulid) == 26, "a ULID is 26 Crockford base32 characters"
    assert USER_A not in payload["id"], "the owner principal is hashed, never carried verbatim"
    assert user_part == _accepted("r2")["id"].removeprefix("DDHARMON:").split("/")[0]


def test_two_users_accepting_the_same_concept_get_different_identifiers_but_the_same_digest():
    """The digest is what a future promotion path compares on; the identifier is what stays private."""
    a, b = _accepted(owner=USER_A), _accepted(owner=USER_B)
    assert a["id"] != b["id"]
    assert a["digest"] == b["digest"]


def test_the_digest_names_its_algorithm_version():
    """So a better canonical form is an additive v2 over published rows, not a migration over every user's
    accumulated catalog."""
    assert _accepted()["digestAlgo"] == DIGEST_ALGO == "v1"


def test_the_digest_is_over_the_concept_not_over_its_prose():
    """v1 is measurand term + data type + canonicalized unit + sorted permissible-value codes. Editing the
    title's wording alone must not mint a different concept; changing the unit must."""
    base = concept_digest(_concept())
    assert concept_digest(_concept(definition="a longer explanation")) == base
    assert concept_digest(_concept(units="lb")) != base
    assert concept_digest(_concept(dataType="Text")) != base


def test_permissible_value_codes_are_order_independent_but_their_set_matters():
    one = concept_digest(_concept(permissibleValues=[{"code": "1"}, {"code": "0"}]))
    two = concept_digest(_concept(permissibleValues=[{"code": "0"}, {"code": "1"}]))
    three = concept_digest(_concept(permissibleValues=[{"code": "0"}]))
    assert one == two and one != three


# --- the digest is never exposed before publish ------------------------------------------------


def test_digest_is_never_exposed_before_publish(artifacts):
    """The named invariant. A digest encodes the concept, so exposing one before the user opts in publishes
    what they harmonized. Asserted over the SERIALIZED read, not over one field, because the leak that
    matters is any surface that carries it."""
    payload = _accepted()
    digest = payload["digest"]
    assert payload["published"] is False
    artifacts.put(owner=USER_A, job_id="run-1", kind=ACCEPTED_GENCDE, payload=payload)

    served = artifacts.get_all(owner=USER_A, job_id="run-1")
    assert digest not in json.dumps(served)
    assert "digest" not in served[ACCEPTED_GENCDE][0]
    assert served[ACCEPTED_GENCDE][0]["digestAlgo"] == DIGEST_ALGO, "the algorithm version is not a secret"

    # Opting in publishes it - and only then.
    artifacts.put(owner=USER_A, job_id="run-1", kind=ACCEPTED_GENCDE, payload={**payload, "published": True})
    assert digest in json.dumps(artifacts.get_all(owner=USER_A, job_id="run-1"))


def test_the_stored_row_still_holds_the_digest_it_just_is_not_served(artifacts):
    """Redaction is on the READ path: the digest is computed at acceptance and kept, so a later publish
    needs no recompute and no v2 migration over unpublished rows."""
    payload = _accepted()
    artifacts.put(owner=USER_A, job_id="run-1", kind=ACCEPTED_GENCDE, payload=payload)
    private = artifacts.get_all(owner=USER_A, job_id="run-1", include_private=True)
    assert private[ACCEPTED_GENCDE][0]["digest"] == payload["digest"]


def test_the_api_read_path_carries_no_digest_before_publish(tmp_path, monkeypatch):
    """Through the wire, since a client is the surface that would leak it."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        app_module.store.create("j1", "A run", {}, owner_subject=None)
        app_module.store.update("j1", status="complete", result={"records": [{"id": "r1"}]})
        put = c.put(
            "/api/harmonize/jobs/j1/artifacts/accepted_gencde",
            json={"recordId": "r1", "verdict": "accept", "concept": _concept()},
        )
        assert put.status_code == 200, put.text
        body = c.get("/api/harmonize/jobs/j1/artifacts").text
    assert "digest" not in json.loads(body)["artifacts"][ACCEPTED_GENCDE][0]
    assert "DDHARMON:u" in body, "the private identifier IS served - it is what a gate decision references"


def test_the_server_mints_the_identity_and_a_client_cannot_supply_one(tmp_path, monkeypatch):
    """A client-supplied digest is not a digest, and a client-supplied id is not an identity."""
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    with TestClient(app_module.app) as c:
        app_module.store.create("j1", "A run", {}, owner_subject=None)
        app_module.store.update("j1", status="complete", result={"records": [{"id": "r1"}]})
        c.put(
            "/api/harmonize/jobs/j1/artifacts/accepted_gencde",
            json={
                "recordId": "r1",
                "verdict": "accept",
                "concept": _concept(),
                "id": "DDHARMON:uattacker/forged",
                "digest": "deadbeef",
                "published": True,
            },
        )
        stored = app_module.store.artifacts.get_all(owner="local", job_id="j1", include_private=True)[ACCEPTED_GENCDE][
            0
        ]
    assert stored["id"] != "DDHARMON:uattacker/forged"
    assert stored["digest"] == concept_digest(_concept())
    assert stored["published"] is False, "publishing is an explicit later opt-in, not a field on acceptance"


# --- tinyId stays empty -------------------------------------------------------------------------


def test_tiny_id_is_empty_on_every_accepted_element():
    """core's export refuses to mint one, and KRAKEN keys NIH CDEs as CDE:<tinyId> 1:1 - a synthesized
    tinyId corrupts that mapping downstream, not just NIH's namespace."""
    assert _accepted()["tinyId"] == ""


def test_a_supplied_tiny_id_is_refused_rather_than_stored(artifacts):
    with pytest.raises(ValueError, match="tinyId"):
        artifacts.put(
            owner=USER_A,
            job_id="run-1",
            kind=ACCEPTED_GENCDE,
            payload={**_accepted(), "tinyId": "1234567"},
        )
    assert artifacts.get_all(owner=USER_A, job_id="run-1") == {}


def test_an_inbound_tiny_id_is_discarded_by_acceptance_not_carried_through():
    """The acceptance path is the only minting path, and it does not pass a supplied tinyId along - so the
    validation refusal above is a second line of defence rather than the only one."""
    minted = accept_gencde(
        {"recordId": "r1", "verdict": "accept", "concept": _concept(), "tinyId": "1234567"},
        owner_subject=USER_A,
    )
    assert minted["tinyId"] == ""


# --- the catalog is gated on a human verdict ----------------------------------------------------


def test_only_an_accepted_element_enters_the_personal_catalog(artifacts):
    """A GenCDE that was wrong in run 1 becomes an ANCHOR in run 2, where the error stops surfacing as a
    reviewable novel and starts being reinforced as a match. "It was generated" is not a verdict."""
    artifacts.put(owner=USER_A, job_id="run-1", kind=ACCEPTED_GENCDE, payload=_accepted("r1"))
    artifacts.put(owner=USER_A, job_id="run-1", kind=ACCEPTED_GENCDE, payload=_accepted("r2", verdict="reject"))
    catalog = personal_catalog(artifacts.get_all(owner=USER_A, job_id="run-1"))
    assert [e["recordId"] for e in catalog] == ["r1"]


def test_a_verdict_that_is_not_a_recorded_human_decision_is_refused(artifacts):
    with pytest.raises(ValueError, match="verdict"):
        artifacts.put(
            owner=USER_A,
            job_id="run-1",
            kind=ACCEPTED_GENCDE,
            payload={**_accepted(), "verdict": "generated"},
        )


def test_re_accepting_the_same_record_replaces_rather_than_accumulates(artifacts):
    """Identity is the record whose element was accepted, so a corrected acceptance is one row, not two
    competing anchors for the same concept."""
    artifacts.put(owner=USER_A, job_id="run-1", kind=ACCEPTED_GENCDE, payload=_accepted("r1"))
    artifacts.put(owner=USER_A, job_id="run-1", kind=ACCEPTED_GENCDE, payload=_accepted("r1", units="lb"))
    stored = artifacts.get_all(owner=USER_A, job_id="run-1")[ACCEPTED_GENCDE]
    assert len(stored) == 1 and stored[0]["concept"]["units"] == "lb"


# --- provenance survives the reuse hop ----------------------------------------------------------


def test_a_reused_element_keeps_its_provenance_edge(artifacts):
    """The refines predicate and the parent reference are what make run N+1's anchor traceable to run N's
    output - the edge is the difference between reuse and an untraceable second registry."""
    payload = _accepted()
    payload["refines"] = "CDE:2183472"
    payload["referenceDocuments"] = ["run-1/r1"]
    artifacts.put(owner=USER_A, job_id="run-2", kind=ACCEPTED_GENCDE, payload=payload)
    stored = artifacts.get_all(owner=USER_A, job_id="run-2")[ACCEPTED_GENCDE][0]
    assert stored["refines"] == "CDE:2183472"
    assert stored["referenceDocuments"] == ["run-1/r1"]


def test_a_refines_edge_pointing_at_a_private_identifier_is_accepted(artifacts):
    """Run N+1 refining run N's own generated element - the reuse hop the short-term answer describes."""
    parent = _accepted("r1")
    child = {**_accepted("r2"), "refines": parent["id"]}
    artifacts.put(owner=USER_A, job_id="run-2", kind=ACCEPTED_GENCDE, payload=child)
    assert artifacts.get_all(owner=USER_A, job_id="run-2")[ACCEPTED_GENCDE][0]["refines"] == parent["id"]


def test_a_refines_edge_into_an_unknown_namespace_is_refused(artifacts):
    with pytest.raises(ValueError, match="refines"):
        artifacts.put(
            owner=USER_A,
            job_id="run-2",
            kind=ACCEPTED_GENCDE,
            payload={**_accepted(), "refines": "LOINC:1234-5"},
        )
