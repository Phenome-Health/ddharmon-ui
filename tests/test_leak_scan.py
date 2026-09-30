"""The leak scan, run inside the backend suite.

``scripts/leak_scan.py --profile public`` is the "ship clean" gate for this PUBLIC repo: it greps every
tracked file for local-machine paths, personal handles and internal-only names. It already runs as its own
GitHub workflow, but a separate workflow is easy to not look at, and nothing ran it locally — so a leak
could sit in a commit through a whole green ``pytest`` and only surface on the push. Running it here puts
it on the path every change already takes.

Run as a SUBPROCESS, exactly the way CI invokes it, rather than by calling ``scan()`` on a file list built
here: the script's own file discovery (``git ls-files``) and its exit code are part of what is being
trusted, and a reimplementation of either could drift from the real gate while still passing.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCANNER = REPO / "scripts" / "leak_scan.py"


def _in_git_work_tree() -> bool:
    if shutil.which("git") is None:
        return False
    probe = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"], cwd=REPO, capture_output=True, text=True, check=False
    )
    return probe.returncode == 0 and probe.stdout.strip() == "true"


def test_the_public_leak_scan_is_clean() -> None:
    """Every tracked file passes the public profile. Any finding fails the suite, with the scanner's report."""
    if not _in_git_work_tree():  # pragma: no cover - the suite runs from a checkout
        pytest.skip("not a git work tree: the scanner discovers files with `git ls-files`")
    result = subprocess.run(
        [sys.executable, str(SCANNER), "--profile", "public"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert result.returncode == 0, (
        "scripts/leak_scan.py --profile public found internal or local-machine strings in tracked files. "
        "Remove them (or, for a genuine false positive, refine the rule in the scanner):\n"
        f"{result.stderr}{result.stdout}"
    )
    assert "leak-scan: clean" in result.stdout, f"the scanner exited 0 without reporting clean:\n{result.stdout}"


def _scanner_module():
    spec = importlib.util.spec_from_file_location("leak_scan", SCANNER)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_leak_scan_is_not_vacuous(tmp_path: Path) -> None:
    """A clean result means something only if the scanner can find a leak — prove it on a planted one.

    The planted strings are assembled at runtime so this file does not itself trip the gate it tests.
    """
    scanner = _scanner_module()
    home_path = "/" + "Users" + "/someone/project/data.csv"
    internal_term = "secure" + "-server"
    leaky = tmp_path / "leaky.md"
    leaky.write_text(f"see {home_path}\nruns on the {internal_term}\n", encoding="utf-8")
    ignored = tmp_path / "ignored.md"
    ignored.write_text(f"pattern {home_path}  # {scanner.IGNORE_MARKER}\n", encoding="utf-8")

    public = scanner.scan([str(leaky), str(ignored)], "public")
    assert {(Path(f).name, lineno) for f, lineno, _desc, _frag in public} == {("leaky.md", 1), ("leaky.md", 2)}

    # The internal profile checks local paths only: an internal term is a public-profile-only rule.
    internal = scanner.scan([str(leaky)], "internal")
    assert [(Path(f).name, lineno) for f, lineno, _desc, _frag in internal] == [("leaky.md", 1)]
