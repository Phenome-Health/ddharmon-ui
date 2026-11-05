#!/usr/bin/env python3
"""Pre-deploy check: what would a restart interrupt?

Read-only. Prints two counts and two id lists — runs with a LIVE WORKER, and runs AWAITING REVIEW —
against the durable job store the app uses.

**Why paused runs belong in this report.** The deploy runbook's warn gate today covers in-flight runs
only. From the reviewer's side a paused run is equally interruptible: they are mid-review, and a restart
that lands between their Continue and the next checkpoint costs them a leg. 08-08 made a paused run
survive a restart, which is what makes the honest answer "you may restart, N reviewers are parked" rather
than "no runs are executing" — but the operator can only say that if something tells them N.

**Why it is a script and not an endpoint** (T-08-57). It prints run ids, which are the operator's
diagnostic handle; an HTTP surface exposing them would need auth scoping, and there is no caller for it.
Local, read-only, no new surface. It prints ids and counts only — never uploaded content and never a
display name, which a user chose and which can carry cohort names.

Usage::

    python scripts/inflight_report.py [path/to/jobs.db]

With no argument it resolves the same path the app does: ``$DDHARMON_UI_DB``, else
``$DDHARMON_UI_WORK/jobs.db``, else ``<repo>/.ddharmon_ui/jobs.db``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from backend.db import _LIVE_WORKER_STATUSES, JobDB  # noqa: E402
from backend.jobs import AWAITING_REVIEW  # noqa: E402


def default_db_path() -> Path:
    """The store path the app would open. Mirrors ``backend/app.py``'s resolution, deliberately."""
    explicit = os.environ.get("DDHARMON_UI_DB")
    if explicit:
        return Path(explicit)
    work = Path(os.environ.get("DDHARMON_UI_WORK", REPO / ".ddharmon_ui"))
    return work / "jobs.db"


def _section(label: str, ids: list[str]) -> str:
    """One category. Prints an EXPLICIT ZERO when empty.

    "Checked, nothing in flight" and "the check did not run" must not look the same to an operator who is
    about to restart production — printing nothing is how a skipped step disguises itself as a clean one.
    """
    head = f"  {label:<24} {len(ids)}"
    if not ids:
        return head
    return head + "\n" + "\n".join(f"      - {i}" for i in ids)


def report(db_path: str | Path | None = None) -> str:
    """The report as text. Opens the store read-only-in-effect (it only ever SELECTs) and closes it."""
    path = Path(db_path) if db_path is not None else default_db_path()
    lines = ["ddharmon — runs a restart would interrupt", f"  store: {path}"]
    if not path.exists():
        lines.append("  (no durable store at that path — nothing has been persisted yet)")
        lines.append(_section("in flight:", []))
        lines.append(_section("awaiting review:", []))
        return "\n".join(lines)
    db = JobDB(path)
    try:
        live = [r["job_id"] for r in db.list_by_status(list(_LIVE_WORKER_STATUSES))]
        paused = [r["job_id"] for r in db.list_by_status([AWAITING_REVIEW])]
    finally:
        db.close()
    lines.append(_section("in flight:", live))
    lines.append(_section("awaiting review:", paused))
    if live:
        lines.append("  A restart will lose the in-flight stage(s) above — work already submitted is billed.")
    if paused:
        lines.append("  Paused runs survive a restart (08-08); their reviewers are mid-review.")
    if not live and not paused:
        lines.append("  Nothing to interrupt.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    print(report(args[0] if args else None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
