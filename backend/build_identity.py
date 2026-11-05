"""Which build this server is: the UI's git commit and tree, and the core commit installed.

Read by ``/api/health`` so the deploy runbook and the Lavish review build can check they are looking at the SAME
build. The UI is named by its git TREE as well as its commit, because `integration/dev` adds merge commits whose
content is identical to the branch that was reviewed — the tree matches where the commit SHA does not. The core is
named by the commit in its install record, because the dev channel installs core from a git ref whose version
string does not move from one commit to the next.

All values are 7-character hex prefixes, or ``None`` when they cannot be known (not a git checkout; core installed
from PyPI or editable). Nothing here raises: health must answer whatever the install looks like.
"""

from __future__ import annotations

import json
import subprocess
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from typing import Any

SHORT = 7


def _git(repo: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=5, check=True
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out[:SHORT] if out else None


def ui_build(repo: Path) -> dict[str, str | None]:
    """``{"commit", "tree"}`` of the checkout at ``repo`` (its HEAD), or ``None`` values outside git."""
    commit = _git(repo, "rev-parse", "--verify", "HEAD")
    tree = _git(repo, "rev-parse", "--verify", "HEAD^{tree}") if commit else None
    return {"commit": commit, "tree": tree}


def _distribution(name: str) -> Any:
    return distribution(name)


def core_commit() -> str | None:
    """The git commit core ``ddharmon`` was installed from (PEP 610 ``direct_url.json``), else ``None``."""
    try:
        raw = _distribution("ddharmon").read_text("direct_url.json")
    except PackageNotFoundError:
        return None
    if not raw:
        return None
    try:
        commit = json.loads(raw).get("vcs_info", {}).get("commit_id")
    except (ValueError, AttributeError):
        return None
    return str(commit)[:SHORT] if commit else None
