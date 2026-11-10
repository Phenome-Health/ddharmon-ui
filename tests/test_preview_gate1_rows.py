"""A Preview run's Gate 1 rows are its clusters, labelled by keywords (08-31).

Before: a Preview run (no model, $0) reached Gate 1 with NO rows — Gate 1 reads ``conceptGroups``, which only the
paid naming/splitting stages produce — so every variable sat in "In no group" under "The clustering never placed
these" (run 7fafc83f: 409 listed; the clustering had made 42 clusters and left 8 over), and Concept Spotlight's free
search had no membership to search. Bhargav's use case is exactly that run: Gate 1 as a $0 redundancy checker.

The rows come from the frozen clustering (the substrate), not ``previewClusters``: that list caps members at 25 and
core skips a cluster that retrieved no CDE candidate, which would put clustered variables back in "no group".
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from ddharmon.harmonization.substrate import ClusteringSubstrate, cluster_content_id
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.engine.adapter import _preview_concept_groups, run_pipeline
from backend.gate1_membership import gate1_membership
from tests.test_backend import _StructuredStubProvider

_TEXT = {
    "A:glu1": "Fasting blood glucose",
    "A:glu2": "Blood glucose after a meal",
    "A:glu3": "Glucose tolerance test result",
    "A:hear1": "Hearing impairment",
    "A:hear2": "Uses a hearing aid",
    "A:hear3": "Difficulty hearing speech",
    "B:hear4": "Self-reported hearing loss",
    "A:odd": "Number of pets",
}


def _field_index(keys=None) -> dict:
    return {k: {"text": _TEXT[k]} for k in (keys or _TEXT)}


def _keys(ids: list[str]) -> list[tuple[str, str]]:
    return [tuple(i.split(":", 1)) for i in ids]  # type: ignore[misc]


def _result(clusters: list[list[str]], outlier: list[str] = (), contexts: list[dict] = ()) -> SimpleNamespace:
    substrate = ClusteringSubstrate(
        min_cluster_size=3,
        clusters=[_keys(c) for c in clusters],
        outlier=_keys(list(outlier)),
        clustered_with_catalog=False,
    )
    return SimpleNamespace(substrate=substrate, ideal_prompts=[SimpleNamespace(context=c) for c in contexts])


_GLU = ["A:glu1", "A:glu2", "A:glu3"]
_HEAR = ["A:hear1", "A:hear2", "A:hear3", "B:hear4"]


def test_one_row_per_cluster_named_by_its_content():
    groups, members = _preview_concept_groups(_result([_GLU, _HEAR], ["A:odd"]), _field_index(), "NIH_CDE")
    assert [g["groupId"] for g in groups] == [cluster_content_id(_keys(_HEAR)), cluster_content_id(_keys(_GLU))]
    assert all(g["clusterId"] == g["groupId"] for g in groups)
    assert members == {cluster_content_id(_keys(_HEAR)): _HEAR, cluster_content_id(_keys(_GLU)): _GLU}


def test_a_row_says_what_a_preview_did_and_nothing_it_did_not():
    (hear, glu), _ = _preview_concept_groups(_result([_GLU, _HEAR]), _field_index(), "NIH_CDE")
    assert "hearing" in hear["concept"] and "glucose" in glu["concept"]
    for g in (hear, glu):
        assert g["conceptSource"] == "keywords"
        assert g["conceptIsGenerated"] is False  # no model wrote it
        assert g["coherence"] == "not_judged" and g["coherenceSummary"] == "" and not g["incoherent"]
        assert g["idealCde"] == ""  # no generated ideal on a run that generated nothing
    assert hear["cohorts"] == ["A", "B"] and hear["crossCohort"] is True
    assert glu["cohorts"] == ["A"] and glu["crossCohort"] is False


def test_a_cluster_that_retrieved_no_candidate_is_still_a_row():
    ctx = {"cluster_id": cluster_content_id(_keys(_GLU)), "top1_cos": 0.71}
    groups, _ = _preview_concept_groups(_result([_GLU, _HEAR], contexts=[ctx]), _field_index(), "NIH_CDE")
    by_id = {g["groupId"]: g for g in groups}
    assert by_id[cluster_content_id(_keys(_GLU))]["top1Cos"] == pytest.approx(0.71)
    assert by_id[cluster_content_id(_keys(_HEAR))]["top1Cos"] is None  # no prompt: a row all the same


def test_catalog_rows_never_become_members():
    # A legacy substrate clustered WITH the catalog: its CDE rows are not variables, and a CDE-only cluster is
    # nothing to harmonize (the same rule core applies before any prompt).
    clusters = [_GLU + ["NIH_CDE:GlucoseCDE"], ["NIH_CDE:x", "NIH_CDE:y", "NIH_CDE:z"]]
    groups, members = _preview_concept_groups(_result(clusters), _field_index(_GLU), "NIH_CDE")
    assert len(groups) == 1
    assert groups[0]["groupId"] == cluster_content_id(_keys(_GLU))
    assert list(members.values()) == [_GLU]


def test_the_row_carries_a_sample_and_the_membership_is_whole():
    big = [f"A:v{i:02d}" for i in range(30)]
    fidx = {k: {"text": f"Grip strength trial {i}"} for i, k in enumerate(big)}
    (group,), members = _preview_concept_groups(_result([big]), fidx, "NIH_CDE")
    assert group["nMembers"] == 30
    assert group["memberVariableNames"] == big[:25] and group["membersTruncated"] is True
    assert members[group["groupId"]] == big


def test_no_substrate_no_rows():
    assert _preview_concept_groups(SimpleNamespace(substrate=None, ideal_prompts=[]), {}, "NIH_CDE") == ([], {})


def test_a_real_preview_run_partitions_every_variable(tmp_path):
    """End to end on the REAL clustering path (no model): rows + leftovers = every variable, exactly once."""
    pytest.importorskip("bertopic")
    cohort = tmp_path / "cohort.csv"
    cohort.write_text("var,desc\n" + "\n".join(f"v{i},Health measure about topic {i}" for i in range(40)) + "\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text(
        "designation\tdefinition\n" + "\n".join(f"CDE{i}\tCommon data element {i}" for i in range(60)) + "\n"
    )
    specs = [{"path": str(cohort), "cohort_name": "A", "column_roles": {"variable_name": "var", "description": "desc"}}]
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {"variable_name": "designation", "description": "definition"},
    }
    # stop_at_gate as the app starts every run (ENTRY_GATE): it freezes the substrate a Preview's rows come from.
    config = {"run_mode": "preview", "cde_cohort": "NIH_CDE", "work_dir": str(tmp_path), "stop_at_gate": "gate1"}
    result = run_pipeline(specs, cde_spec, config, provider=_StructuredStubProvider())

    groups, members = result["conceptGroups"], result["conceptGroupMembers"]
    assert groups, "a Preview run's Gate 1 has no rows"
    assert all(g["conceptSource"] == "keywords" and g["concept"] for g in groups)
    placed = [m for ms in members.values() for m in ms]
    assert len(placed) == len(set(placed)), "a variable sits in two rows"
    from ddharmon.harmonization.substrate import load_substrate

    outliers = {f"{d}:{v}" for d, v in load_substrate(tmp_path / "substrate.joblib").outlier}
    assert set(placed) | outliers == set(result["fieldIndex"]) and not set(placed) & outliers
    assert gate1_membership(dict(result), None) == members  # what Spotlight searches = what the rows hold
    assert result["previewClusters"], "the results page's cluster cards still have their source"
    assert result.get("gatePosition") is None  # a Preview completes; it does not park


# ── the reviewer's edits on a Preview run ─────────────────────────────────────────────────────────────


def _preview_job(monkeypatch, tmp_path, job_id: str) -> dict:
    monkeypatch.setattr(app_module, "_DB_PATH", tmp_path / "jobs.db")
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(app_module.store, "work_root", tmp_path / "work")
    groups, members = _preview_concept_groups(_result([_GLU, _HEAR], ["A:odd"]), _field_index(), "NIH_CDE")
    result = {
        "mode": "preview",
        "records": [],
        "conceptGroups": groups,
        "conceptGroupMembers": members,
        "fieldIndex": _field_index(),
    }
    app_module.store.create(job_id, "Preview", {"work_dir": str(tmp_path / "work" / job_id), "run_mode": "preview"})
    app_module.store.update(job_id, status="complete", phase="complete", result=result)
    return result


def test_a_move_on_a_preview_run_is_kept_and_applied(monkeypatch, tmp_path):
    from tests.test_gate1_new_group import _move

    result = _preview_job(monkeypatch, tmp_path, "pv")
    glu, hear = cluster_content_id(_keys(_GLU)), cluster_content_id(_keys(_HEAR))
    with TestClient(app_module.app) as c:
        r = c.put("/api/harmonize/jobs/pv/artifacts/gate1_regroup", json=_move("A:odd", "__unassigned__", glu))
        assert r.status_code == 200, r.text
        r = c.put("/api/harmonize/jobs/pv/artifacts/gate1_regroup", json=_move("A:hear3", hear, glu))
        assert r.status_code == 200, r.text
        overrides = app_module._gate1_overrides(app_module.store.get("pv"), None, result)  # inside: the DB is open
    assert overrides is not None and overrides["moves"] == {"A:hear3": glu, "A:odd": glu}
    membership = gate1_membership(result, overrides)
    assert set(membership[glu]) == set(_GLU) | {"A:hear3", "A:odd"}
    assert "A:hear3" not in membership[hear]
