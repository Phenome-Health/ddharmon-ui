"""Which build is this server, exactly? (`/api/health` → uiCommit, uiTree, coreCommit)

The review loop's promise is that what Bhargav approves in the Lavish review surface is what lands on
dev.ddharmon.io. That is only checkable if both ends can NAME their build: the UI's git tree (identical across
the merge commits `integration/dev` adds, which a commit SHA is not) and the exact core commit installed (the dev
channel pins core to a git ref whose version string does not move). Health is what the deploy runbook and the
review build both read, so the identity lives there.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from backend import build_identity
from backend.app import app

client = TestClient(app)
REPO = Path(__file__).resolve().parents[1]


def _git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, check=True).stdout.strip()


def test_health_names_the_ui_build_by_commit_and_tree():
    body = client.get("/api/health").json()
    assert body["uiCommit"] == _git("rev-parse", "HEAD")[:7]
    assert body["uiTree"] == _git("rev-parse", "HEAD^{tree}")[:7]


def test_health_names_the_core_commit_key_even_when_unknown():
    body = client.get("/api/health").json()
    assert "coreCommit" in body
    assert body["coreCommit"] is None or len(body["coreCommit"]) == 7


def test_a_directory_that_is_not_a_git_checkout_has_no_ui_build(tmp_path: Path):
    assert build_identity.ui_build(tmp_path) == {"commit": None, "tree": None}


def test_core_commit_is_read_from_a_git_install(monkeypatch):
    class Dist:
        def read_text(self, name: str) -> str | None:
            assert name == "direct_url.json"
            return json.dumps(
                {
                    "url": "https://github.com/Phenome-Health/ddharmon.git",
                    "vcs_info": {"vcs": "git", "commit_id": "8283fbe0674bac82ad066863bb63b5819875da17"},
                }
            )

    monkeypatch.setattr(build_identity, "_distribution", lambda name: Dist())
    assert build_identity.core_commit() == "8283fbe"


def test_core_commit_is_none_for_a_pypi_or_editable_install(monkeypatch):
    class NoUrl:
        def read_text(self, name: str) -> str | None:
            return None

    class Editable:
        def read_text(self, name: str) -> str | None:
            return json.dumps({"url": "file:///src/ddharmon", "dir_info": {"editable": True}})

    for dist in (NoUrl(), Editable()):
        monkeypatch.setattr(build_identity, "_distribution", lambda name, d=dist: d)
        assert build_identity.core_commit() is None
