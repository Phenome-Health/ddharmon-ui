"""The column-role requirement Setup and ``/batch`` enforce IS core's, and a cohort that loads nothing is refused.

The defect this file exists for (08-28 triage, "a question_text-only mapping silently drops a cohort"): Setup and
``start_batch`` both accepted ``question_text`` alone as a sufficient mapping, core's loader skipped every such row
(its description chain is description -> short_label -> variable_name and refuses the synthetic ``_ROW_`` name),
and the adapter then DROPPED the empty cohort with a log line — so the run billed without it.

Three layers, each pinned here:

1. The rule (``backend.role_requirement``) is checked against core's REAL loader over every combination of the
   text-bearing roles — not against a reading of core's source, which is how the old rule went wrong.
2. The rule's frontend mirror (``frontend/src/lib/dictionary.ts``) is the same data, so the screen and the door
   cannot drift apart again.
3. The door refuses the OUTCOME, not just the prediction: a mapping that satisfies the rule but loads zero
   variables (every mapped text cell empty) is refused at start, naming the file — and a run that reaches the
   adapter with an empty cohort anyway fails instead of continuing without it.
"""

from __future__ import annotations

import inspect
import itertools
import json
import re
from pathlib import Path

import numpy as np
import pytest
from ddharmon.embedding.provider import EmbeddingProvider
from ddharmon.ingestion import load_dictionary
from fastapi.testclient import TestClient

from backend import app as app_module

client = TestClient(app_module.app)

_REPO = Path(__file__).resolve().parents[1]

#: The roles that can carry a row's name or text in core's loader. Every other role is value/organizational
#: metadata; the matrix below also proves adding ALL of those changes no outcome.
_TEXT_ROLES = ("variable_name", "description", "question_text", "short_label", "field_id")


class _StubProvider(EmbeddingProvider):
    """Constant embeddings — no model download; nothing here depends on the geometry."""

    @property
    def model_name(self) -> str:
        return "stub-roles"

    @property
    def dimension(self) -> int:
        return 8

    def embed(self, texts: list[str]) -> np.ndarray:
        return np.ones((len(texts), 8), dtype=np.float32)


def _core_role_kwargs() -> list[str]:
    """Every column-role keyword ``load_dictionary`` takes, read from its signature rather than listed."""
    params = inspect.signature(load_dictionary).parameters
    non_roles = {"path", "cohort_name", "embed_variable_name", "detect_hierarchy", "hierarchy_delimiter"}
    return [p for p in params if p not in non_roles]


def _full_csv(path: Path, roles: list[str], rows: int = 3) -> Path:
    """A dictionary with one column per role, every cell filled — so only the MAPPING decides the outcome."""
    header = ",".join(f"col_{r}" for r in roles)
    body = "\n".join(",".join(f"{r}_{i}" for r in roles) for i in range(rows))
    path.write_text(f"{header}\n{body}\n")
    return path


def _core_loads(path: Path, roles: dict[str, str]) -> bool:
    try:
        return load_dictionary(path, cohort_name="X", detect_hierarchy=False, **roles).field_count > 0
    except ValueError:
        return False


# --- 1. the rule is core's ------------------------------------------------------------------------------


def test_every_role_the_rule_names_is_a_real_core_role():
    """A renamed core kwarg would otherwise leave the rule naming a role nothing can satisfy."""
    from backend.role_requirement import REQUIRED_ROLE_GROUPS

    core_roles = set(_core_role_kwargs())
    for group in REQUIRED_ROLE_GROUPS:
        assert set(group) <= core_roles, f"{group} names a role core's load_dictionary does not take"


def test_the_rule_predicts_exactly_what_core_loads(tmp_path):
    """Every subset of the text roles, alone and with every other role also mapped: the rule says "meets" iff
    core's own loader produces at least one variable. This is the test that would have caught question_text."""
    from backend.role_requirement import unmet_role_group

    other = [r for r in _core_role_kwargs() if r not in _TEXT_ROLES]
    path = _full_csv(tmp_path / "d.csv", [*_TEXT_ROLES, *other])
    disagreements = []
    for n in range(len(_TEXT_ROLES) + 1):
        for combo in itertools.combinations(_TEXT_ROLES, n):
            for extras in ((), tuple(other)):
                roles = {r: f"col_{r}" for r in (*combo, *extras)}
                predicted = unmet_role_group(roles) is None
                actual = _core_loads(path, roles)
                if predicted != actual:
                    disagreements.append((sorted(combo), bool(extras), predicted, actual))
    assert not disagreements, f"rule vs core (roles, +other roles, rule says loads, core loads): {disagreements}"


def test_question_text_alone_is_not_enough_and_the_message_says_what_is_missing():
    from backend.role_requirement import role_requirement_error

    msg = role_requirement_error("aou.csv", {"question_text": "Field Label"})
    assert msg is not None
    assert "aou.csv" in msg
    # It names the roles that would fix it — the ones core's description chain actually reads.
    for role in ("description", "variable_name"):
        assert role in msg
    assert role_requirement_error("aou.csv", {"question_text": "Field Label", "variable_name": "Item"}) is None


# --- 2. the frontend mirror is the same data --------------------------------------------------------------


def test_the_frontend_rule_is_the_backend_rule():
    """Setup's blocker, the mapping table's flag and the New Run form all read `REQUIRED_ROLE_GROUPS` from
    `frontend/src/lib/dictionary.ts`. It must be this module's constant, group for group."""
    from backend.role_requirement import REQUIRED_ROLE_GROUPS

    src = (_REPO / "frontend/src/lib/dictionary.ts").read_text()
    m = re.search(r"export const REQUIRED_ROLE_GROUPS[^=]*=\s*\[(.*?)\]\s*as const;", src, re.S)
    assert m, "frontend/src/lib/dictionary.ts must export REQUIRED_ROLE_GROUPS"
    groups = [tuple(re.findall(r'"([a-z_]+)"', g)) for g in re.findall(r"\[([^\[\]]*)\]", m.group(1))]
    assert groups == [tuple(g) for g in REQUIRED_ROLE_GROUPS]


# --- 3. the door refuses the outcome ----------------------------------------------------------------------


@pytest.fixture
def door(monkeypatch, tmp_path):
    """`/batch` with a tiny CDE catalogue and a runner that records instead of running."""
    monkeypatch.setattr(app_module, "_WORK_ROOT", tmp_path)
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    monkeypatch.setattr(app_module, "CDE_FILES", {"endorsed": cde, "full": cde})
    started: list = []
    monkeypatch.setattr(app_module, "run_harmonization", lambda *a, **k: started.append(a))

    def post(files: dict[str, bytes], roles: dict[str, dict[str, str]]):
        cfg = {
            "dictionaries": [
                {"filename": name, "cohortName": Path(name).stem, "columnRoles": roles[name]} for name in files
            ],
            "cdeSet": "endorsed",
            "runMode": "preview",
        }
        return client.post(
            "/api/harmonize/batch",
            files=[("files", (name, body, "text/csv")) for name, body in files.items()],
            data={"config": json.dumps(cfg)},
        )

    post.started = started  # type: ignore[attr-defined]
    return post


_AOU = b"Item Concept,Field Label,Field Type\nq1,How is your health?,radio\nq2,Do you smoke?,radio\n"
_UKBB = b"field_name,description,units\nAge,Age at recruitment,years\nHeight,Standing height,cm\n"


def test_start_refuses_a_question_text_only_mapping_naming_the_file_and_the_missing_role(door):
    resp = door(
        {"aou.csv": _AOU, "ukbb.csv": _UKBB},
        {"aou.csv": {"question_text": "Field Label"}, "ukbb.csv": {"variable_name": "field_name"}},
    )
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "aou.csv" in detail and "ukbb.csv" not in detail
    assert "description" in detail and "variable_name" in detail
    assert door.started == [], "a refused start must not start a run"


def test_start_accepts_question_text_once_the_row_has_a_name(door):
    resp = door({"aou.csv": _AOU}, {"aou.csv": {"question_text": "Field Label", "variable_name": "Item Concept"}})
    assert resp.status_code == 200, resp.text


def test_start_refuses_a_mapping_that_meets_the_rule_but_loads_no_variables(door):
    """The rule is a prediction; the door also checks the outcome. `description` is mapped, but to a column
    that is empty on every row and no name is mapped — core loads zero variables from this file."""
    blank = b"code_label,notes,units\n,, kg\n,,cm\n"
    resp = door(
        {"blank.csv": blank, "ukbb.csv": _UKBB},
        {"blank.csv": {"description": "notes", "units": "units"}, "ukbb.csv": {"variable_name": "field_name"}},
    )
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "blank.csv" in detail
    assert "no variables" in detail.lower()
    assert "description" in detail, "it names the role whose column came up empty"
    assert door.started == []


def test_the_prestart_export_applies_the_same_rule(monkeypatch, tmp_path):
    """The embedding export takes `/batch`'s payload and must refuse what `/batch` refuses."""
    resp = client.post(
        "/api/harmonize/dictionary/embedding.csv",
        files=[("files", ("aou.csv", _AOU, "text/csv"))],
        data={
            "config": json.dumps(
                {
                    "dictionaries": [
                        {"filename": "aou.csv", "cohortName": "aou", "columnRoles": {"question_text": "Field Label"}}
                    ]
                }
            )
        },
    )
    assert resp.status_code == 400, resp.text
    assert "aou.csv" in resp.json()["detail"] and "description" in resp.json()["detail"]


def test_a_run_never_continues_without_a_cohort_it_was_given(tmp_path):
    """Belt to the door's braces: a dictionary that reaches the adapter and loads nothing FAILS the run
    (before any paid stage) rather than being dropped while the other cohorts carry on and bill."""
    from backend.engine.adapter import run_pipeline

    good = tmp_path / "good.csv"
    good.write_text("var,desc\nage,Age in years\nsmoke,Do you smoke\n")
    empty = tmp_path / "empty.csv"
    empty.write_text("var,prompt\n,How is your health?\n,Do you smoke?\n")
    cde = tmp_path / "cde.tsv"
    cde.write_text("designation\tdefinition\nAgeCDE\tAge of participant\n")
    dict_specs = [
        {"path": str(good), "cohort_name": "Good", "column_roles": {"variable_name": "var", "description": "desc"}},
        {"path": str(empty), "cohort_name": "Empty", "column_roles": {"question_text": "prompt"}},
    ]
    cde_spec = {
        "path": str(cde),
        "cohort_name": "NIH_CDE",
        "column_roles": {"variable_name": "designation", "description": "definition"},
    }
    config = {"run_mode": "preview", "cde_cohort": "NIH_CDE", "work_dir": str(tmp_path), "stop_at_gate": "gate0"}
    with pytest.raises(ValueError, match="Empty"):
        run_pipeline(dict_specs, cde_spec, config, provider=_StubProvider())
