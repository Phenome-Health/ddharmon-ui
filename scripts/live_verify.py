#!/usr/bin/env python
"""live_verify.py — walk a FRESH staged run Setup → Gate 4 on the rig and assert every invariant (08-28 0d).

One iteration of the phase-8 verify loop: start a run on the committed fixture (``tests/live/fixture``), make a
fixed script of reviewer decisions at every gate through the SAME API calls the screens make, and check the
invariants I1–I14 from ``08-28-PLAN.md`` against what the server then serves and exports. The run is driven over
HTTP exactly as the browser drives it; the rig's work root and spend tap are read from disk only for evidence the
API deliberately does not serve (a checkpoint's recorded stage answers, the provider-billed usage).

    scripts/rig.sh start
    .venv/bin/python scripts/live_verify.py --run-mode sync --out .ddharmon_ui/rig/iterations/0
    # continue a parked run from its current gate (nothing already bought is bought again):
    .venv/bin/python scripts/live_verify.py --job <id> --out .ddharmon_ui/rig/iterations/0

The driver never handles a credential: the rig backend holds the key in its own environment.

A failed invariant is a finding, not a crash — every check records evidence and the run continues, so one
iteration reports every broken invariant at once. The process exits 1 when any invariant failed, 2 on a cap or
driver error, 0 when clean. Display-only invariants (header == rail, editor seeding, empty states, label
rendering) are asserted by the live Playwright project (``frontend/tests/live``); ``--playwright`` runs it at
each gate against this run.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.artifact_kinds import content_key, option_set_key  # noqa: E402

GATES = ("gate1", "gate2", "gate3", "gate4")
CDE_SETS = ("endorsed", "full")
NEW_RUN_CDE_SET = "full"  # backend/app.py DEFAULT_CDE_SET: what a run gets when it names no catalog
UNASSIGNED_GROUP_ID = "__unassigned__"  # frontend/src/components/gate/MemberChip.tsx
IN_SCOPE, OUT_OF_SCOPE = "in", "out"
SCOPE_OPTIONS = [IN_SCOPE, OUT_OF_SCOPE]
EXPORT_FORMATS = ("eitl_tsv", "records_json", "decisions_csv", "notebook_py", "notebook_r", "score_json")
INVARIANTS = {
    "I1": "frozen scope == displayed; assign prompts == scope; a resumed leg buys no generate/split/judge answer",
    "I2": "cost: costSoFar monotonic; perStage grows; actualUsd = prior + new; every paid route billed",
    "I3": "quote vs bill (reported, never a fail)",
    "I4": "renames and New groups carry into Gates 2–4 and every export",
    "I5": "re-pick → specs target the pick; provenance kept (targetPickedBy=reviewer, modelCde = model's)",
    "I6": "GenCDE edit → recodes use the edited values",
    "I7": "Gate 3 editor seeds from the model's codeMap; saved edits are in target CODES",
    "I8": "a spec that couldn't be produced is never 'no transform needed' nor exported as a copy",
    "I9": "notebook: no target column assigned twice without a declared combination rule",
    "I10": "decision log before ≠ after for real changes; revision rate correct; empty rows not 'annotated'",
    "I11": "score: extraction billed + cached; declaration persists; matching reachable on a staged run",
    "I12": "no false empty state while a leg runs (Gate 2 and Gate 3)",
    "I13": "permissible-value labels round-trip intact",
    "I14": "every Gate 1 move is applied (member absent from its origin group downstream)",
}


def fixture_cde_set(manifest: dict[str, Any]) -> str:
    """The catalog a run on this fixture uses when ``--cde-set`` is not given: the one the fixture RECORDS.

    A fixture keeps the catalog it was captured with. The committed one was designed and validated against
    ``endorsed`` (``tests/live/fixture/VALIDATION.md``), and the catalog's rows are part of the clustered matrix,
    so starting it on another catalog changes the partition its paths were built to land in. A fixture that
    records no catalog is a new run like any other and gets the product default (``full``).
    """
    recorded = manifest.get("cdeSet")
    return recorded if recorded in CDE_SETS else NEW_RUN_CDE_SET


# --- reporting ------------------------------------------------------------------------------------------------


def playwright_log_name(stage: str, tag: str | None = None) -> str:
    """One log per live Playwright run. The in-flight watch runs once per leg, so it is tagged with the leg — an
    untagged name let each leg overwrite the last, and the Gate 4 leg (it parks in 0 s) always erased the evidence."""
    return f"playwright_{stage}_{tag}.log" if tag else f"playwright_{stage}.log"


def inflight_outcome(log_text: str) -> str:
    """``pass`` / ``fail`` / ``skip`` for one in-flight watch, from the line reporter's summary.

    ``LIVE_STAGE=inflight`` skips every other live spec, so the in-flight spec's own result decides it; it skips
    itself when the leg parked before the page could be looked at.
    """
    if re.search(r"^\s*\d+ failed\b", log_text, re.M):
        return "fail"
    if re.search(r"^\s*\d+ passed\b", log_text, re.M):
        return "pass"
    return "skip"


@dataclass
class Check:
    ok: bool
    what: str
    evidence: str = ""


@dataclass
class Report:
    out: Path
    checks: dict[str, list[Check]] = field(default_factory=dict)
    notes: dict[str, list[str]] = field(default_factory=dict)
    info: dict[str, Any] = field(default_factory=dict)

    def check(self, inv: str, ok: bool, what: str, evidence: Any = "") -> bool:
        ev = evidence if isinstance(evidence, str) else json.dumps(evidence, default=str)[:600]
        self.checks.setdefault(inv, []).append(Check(bool(ok), what, ev))
        mark = "PASS" if ok else "FAIL"
        print(f"  [{inv} {mark}] {what}" + (f" — {ev[:200]}" if ev and not ok else ""))
        return bool(ok)

    def note(self, inv: str, text: str) -> None:
        self.notes.setdefault(inv, []).append(text)
        print(f"  [{inv} note] {text}")

    def status(self, inv: str) -> str:
        cs = self.checks.get(inv) or []
        if not cs:
            return "skip"
        return "pass" if all(c.ok for c in cs) else "fail"

    def failed(self) -> list[str]:
        return [i for i in INVARIANTS if self.status(i) == "fail"]

    def write(self) -> None:
        self.out.mkdir(parents=True, exist_ok=True)
        doc = {
            "info": self.info,
            "invariants": {
                inv: {
                    "title": INVARIANTS[inv],
                    "status": self.status(inv),
                    "checks": [c.__dict__ for c in self.checks.get(inv) or []],
                    "notes": self.notes.get(inv) or [],
                }
                for inv in INVARIANTS
            },
        }
        (self.out / "report.json").write_text(json.dumps(doc, indent=2, default=str))
        lines = [f"# live verify — job {self.info.get('jobId', '?')}", ""]
        for k in ("startedAt", "runMode", "commitUi", "commitCore", "tapUsd", "appUsd"):
            if k in self.info:
                lines.append(f"- {k}: {self.info[k]}")
        lines += ["", "| # | status | failing checks |", "|---|---|---|"]
        for inv in INVARIANTS:
            bad = [c.what for c in self.checks.get(inv) or [] if not c.ok]
            lines.append(f"| {inv} | {self.status(inv)} | {'; '.join(bad)[:300]} |")
        lines.append("")
        for inv in INVARIANTS:
            cs = self.checks.get(inv) or []
            ns = self.notes.get(inv) or []
            if not cs and not ns:
                continue
            lines.append(f"## {inv} — {INVARIANTS[inv]}")
            for c in cs:
                lines.append(f"- {'✓' if c.ok else '✗'} {c.what}" + (f" — `{c.evidence[:300]}`" if c.evidence else ""))
            for n in ns:
                lines.append(f"- note: {n}")
            lines.append("")
        (self.out / "report.md").write_text("\n".join(lines))


class CapHitError(RuntimeError):
    pass


# --- the API, as the screens call it ---------------------------------------------------------------------------


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/") + "/api/harmonize"
        self.http = httpx.Client(timeout=httpx.Timeout(600.0, connect=10.0))

    def _ok(self, r: httpx.Response) -> Any:
        if r.status_code >= 400:
            raise ApiError(r.status_code, r.text[:800], str(r.request.url))
        ctype = r.headers.get("content-type", "")
        return r.json() if "json" in ctype else r.text

    def get(self, path: str, **kw: Any) -> Any:
        return self._ok(self.http.get(self.base + path, **kw))

    def post(self, path: str, **kw: Any) -> Any:
        return self._ok(self.http.post(self.base + path, **kw))

    def put(self, path: str, **kw: Any) -> Any:
        return self._ok(self.http.put(self.base + path, **kw))

    def job(self, job_id: str) -> dict[str, Any]:
        for j in self.get("/jobs"):
            if j.get("jobId") == job_id:
                return j
        raise ApiError(404, "job not in /jobs", job_id)

    def checkpoint(self, job_id: str) -> dict[str, Any]:
        return self.get(f"/checkpoint/{job_id}")

    def artifacts(self, job_id: str) -> dict[str, Any]:
        return self.get(f"/jobs/{job_id}/artifacts")

    def decide(self, job_id: str, kind: str, payload: dict[str, Any]) -> Any:
        return self.put(f"/jobs/{job_id}/artifacts/{kind}", json=payload)

    def stream(self, job_id: str, on_frame: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        """Consume the progress SSE until the leg parks or ends; returns the last frame."""
        last: dict[str, Any] = {}
        with self.http.stream("GET", f"{self.base}/stream/{job_id}", timeout=httpx.Timeout(None, connect=10.0)) as r:
            event = ""
            for line in r.iter_lines():
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and event == "progress":
                    frame = json.loads(line.split(":", 1)[1])
                    frame["_t"] = time.time()
                    last = frame
                    on_frame(frame)
        return last


class ApiError(RuntimeError):
    def __init__(self, status: int, body: str, url: str) -> None:
        super().__init__(f"{status} {url}: {body}")
        self.status = status
        self.body = body


def decision(fields: dict[str, Any], chosen: str, alternatives: list[str], **extra: Any) -> dict[str, Any]:
    """A gate-decision payload exactly as ``useGateDecisions.write`` assembles it."""
    return {
        **fields,
        **extra,
        "chosen": chosen,
        "alternatives": alternatives,
        "optionSetKey": option_set_key(alternatives),
    }


# --- the spend tap (the reference the app's ledger is checked against) --------------------------------------------


def tap_rows(tap: Path, since: float, until: float | None = None) -> list[dict[str, Any]]:
    if not tap.exists():
        return []
    rows, seen = [], set()
    for line in tap.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("transport") not in ("sync", "batch") or row.get("ts", 0) < since:
            continue
        if until is not None and row["ts"] > until:
            continue
        if row["transport"] == "batch":  # a batch answer is billed once, however often its results are read
            key = (row.get("batchId"), row.get("customId"))
            if key in seen:
                continue
            seen.add(key)
        rows.append(row)
    return rows


def tap_usd(rows: Iterable[dict[str, Any]]) -> float:
    from ddharmon.llm.cost import price_usage

    return round(
        sum(
            price_usage(r.get("model"), r["inputTokens"], r["outputTokens"], batch=r["transport"] == "batch")
            for r in rows
        ),
        6,
    )


# --- the driver ----------------------------------------------------------------------------------------------------


class Driver:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.api = Api(args.base_url)
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.report = Report(self.out)
        self.tap = Path(args.rig_dir) / "tap.jsonl"
        self.work_root = Path(args.rig_dir) / "work"
        self.state_path = self.out / "state.json"
        self.state: dict[str, Any] = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.state.setdefault("frames", [])
        self.state.setdefault("legs", [])
        self.state.setdefault("snapshots", {})
        self.state.setdefault("decisions", {})
        self.state.setdefault("startedAt", time.time())
        self.manifest = json.loads((Path(args.fixture) / "manifest.json").read_text())
        self._restore_checks()

    # -- persistence ---------------------------------------------------------------------------------------------

    def _restore_checks(self) -> None:
        """A resumed iteration keeps the checks its earlier invocation recorded (same --out), so one report
        covers the whole walk however many times the driver was restarted along it."""
        prior = self.out / "report.json"
        if not self.state_path.exists() or not prior.exists():
            return
        doc = json.loads(prior.read_text())
        for inv, body in (doc.get("invariants") or {}).items():
            for c in body.get("checks") or []:
                self.report.checks.setdefault(inv, []).append(Check(bool(c["ok"]), c["what"], c.get("evidence", "")))
            for n in body.get("notes") or []:
                self.report.notes.setdefault(inv, []).append(n)

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=1, default=str))

    @property
    def job_id(self) -> str:
        return str(self.state["jobId"])

    def spent(self) -> float:
        return tap_usd(tap_rows(self.tap, float(self.state["startedAt"])))

    def guard(self) -> None:
        usd = self.spent()
        if usd > self.args.cap:
            with contextlib.suppress(Exception):
                self.api.post(f"/jobs/{self.job_id}/cancel", params={"mode": "discard"})
            raise CapHitError(f"iteration spend ${usd:.4f} exceeds the ${self.args.cap:.2f} cap — run cancelled")

    # -- legs ----------------------------------------------------------------------------------------------------

    def run_leg(self, label: str, start: Callable[[], Any]) -> dict[str, Any]:
        """Start a leg (a paid step) and follow its progress stream until it parks; record every frame."""
        t0 = time.time()
        started = start()
        leg = {"label": label, "t0": t0, "response": started}
        self.state["legs"].append(leg)
        self.save()
        last_guard = [0.0]

        def on_frame(frame: dict[str, Any]) -> None:
            self.state["frames"].append(
                {k: frame.get(k) for k in ("_t", "status", "phase", "costSoFar", "gatePosition", "completed", "total",
                                           "transport")}  # fmt: skip
                | {"leg": label, "batchStatus": (frame.get("batch") or {}).get("status")}
            )
            if time.time() - last_guard[0] > 5:
                last_guard[0] = time.time()
                self.guard()
            self.maybe_switch(label, frame, t0)

        playwright_inflight = None
        if self.args.playwright and label != "leg1":
            playwright_inflight = self.playwright_async("inflight", tag=label)
        last = self.api.stream(self.job_id, on_frame)
        if last.get("status") not in ("awaiting_review", "complete"):
            # the stream can end on a transient frame; poll the job until it settles
            for _ in range(600):
                j = self.api.job(self.job_id)
                if j.get("status") in ("awaiting_review", "complete", "error", "cancelled"):
                    last = j
                    break
                time.sleep(1)
        leg["t1"] = time.time()
        leg["status"] = last.get("status")
        leg["gate"] = last.get("gatePosition")
        leg["error"] = last.get("errorMessage")
        leg["tapUsd"] = tap_usd(tap_rows(self.tap, t0, leg["t1"]))
        leg["tapCalls"] = len(tap_rows(self.tap, t0, leg["t1"]))
        if playwright_inflight is not None:
            res = playwright_inflight.wait()
            leg["playwrightInflight"] = res
            outcome = inflight_outcome(Path(res["log"]).read_text(errors="replace"))
            if outcome == "skip":
                self.report.note("I12", f"{label}: parked before the in-flight watch could look")
            else:
                self.report.check("I12", outcome == "pass", f"{label}: no false empty state while the leg ran",
                                  res["log"])  # fmt: skip
        self.save()
        print(f"· {label}: {leg['status']} at {leg['gate']} in {leg['t1'] - t0:.0f}s, tap ${leg['tapUsd']:.4f}")
        if leg["status"] not in ("awaiting_review", "complete"):
            raise RuntimeError(f"{label} ended {leg['status']}: {leg['error']}")
        self.guard()
        return last

    def maybe_switch(self, label: str, frame: dict[str, Any], t0: float) -> None:
        """Press "Finish now with sync" (0e) once per iteration, on the first leg whose batch is still queued after
        ``--switch-after`` seconds — the loop's exit needs one batch iteration with the switch exercised."""
        after = self.args.switch_after
        if after is None or self.state.get("switch") or time.time() - t0 < after:
            return
        batch = frame.get("batch") or {}
        if not batch.get("switchable"):
            return
        rec: dict[str, Any] = {"leg": label, "at": time.time(), "batch": batch}
        try:
            rec["response"] = self.api.post(f"/jobs/{self.job_id}/switch-to-sync")
        except ApiError as exc:
            rec["refused"] = {"status": exc.status, "detail": exc.body[:200]}
        self.state["switch"] = rec
        self.save()
        print(f"· switched {label} to sync: {rec.get('response') or rec.get('refused')}")

    def snapshot(self, gate: str) -> dict[str, Any]:
        """What the gate screen reads (the checkpoint route) plus the run's own recorded checkpoint file."""
        ck = self.api.checkpoint(self.job_id)
        disk_path = self.work_root / self.job_id / f"checkpoint_{gate}.json"
        disk = json.loads(disk_path.read_text()) if disk_path.exists() else None
        job = self.api.job(self.job_id)
        snap = {
            "gate": gate,
            "costSoFar": ck.get("costSoFar"),
            "config": job.get("config") or {},
            "cost": ((ck.get("result") or {}).get("cost")),
            "responseIds": {k: sorted(v) for k, v in ((disk or {}).get("responses") or {}).items()},
            "realizedCost": (disk or {}).get("realizedCost"),
        }
        (self.out / f"checkpoint_{gate}.json").write_text(json.dumps(ck, default=str))
        self.state["snapshots"][gate] = snap
        self.save()
        return ck

    # -- playwright ----------------------------------------------------------------------------------------------

    def playwright_async(self, stage: str, tag: str | None = None) -> Any:
        env = {**os.environ, "LIVE_BASE_URL": self.args.base_url, "LIVE_JOB": self.job_id, "LIVE_STAGE": stage,
               "LIVE_OUT": str(self.out.resolve())}  # fmt: skip
        log_path = self.out / playwright_log_name(stage, tag)
        log = open(log_path, "w")  # noqa: SIM115 - closed by the waiter
        proc = subprocess.Popen(
            ["npx", "playwright", "test", "--config", "playwright.live.config.ts", "--reporter=line"],
            cwd=ROOT / "frontend",
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )

        class _Waiter:
            def wait(self) -> dict[str, Any]:
                code = proc.wait(timeout=900)
                log.close()
                return {"stage": stage, "exit": code, "log": str(log_path)}

        return _Waiter()

    def playwright(self, stage: str) -> None:
        if not self.args.playwright:
            return
        res = self.playwright_async(stage).wait()
        self.state.setdefault("playwright", []).append(res)
        self.save()
        print(f"· playwright {stage}: exit {res['exit']}")

    # -- the fixture ---------------------------------------------------------------------------------------------

    def path_ids(self, name: str) -> list[str]:
        """The ``cohort:var`` ids the fixture manifest chose for one path (see tests/live/fixture/manifest.json)."""
        out: list[str] = []
        spec = (self.manifest.get("paths") or {}).get(name) or {}
        entries = spec.get("variables") if isinstance(spec, dict) else spec
        for entry in entries or []:
            if isinstance(entry, dict):
                out.append(str(entry.get("memberId") or f"{entry.get('cohort')}:{entry.get('variable')}"))
            elif isinstance(entry, str):
                out.append(entry)
        return out

    def all_path_ids(self) -> dict[str, list[str]]:
        return {k: self.path_ids(k) for k in (self.manifest.get("paths") or {})}

    # -- step 0: start --------------------------------------------------------------------------------------------

    def start(self) -> None:
        fx = Path(self.args.fixture)
        dicts = self.manifest["cohorts"]
        files = [("files", (d["file"], (fx / d["file"]).read_bytes(), "text/csv")) for d in dicts]
        cfg = {
            "dictionaries": [
                {"filename": d["file"], "cohortName": d["cohortName"], "columnRoles": d["columnRoles"]} for d in dicts
            ],
            "cdeSet": self.args.cde_set or fixture_cde_set(self.manifest),
            "runMode": self.args.run_mode,
            "displayName": f"live-verify {time.strftime('%Y-%m-%d %H:%M')}",
            "estFields": sum(int(d.get("rows") or 0) for d in dicts) or None,
            "estCohorts": len(dicts),
            "allowReadjudication": True,
            "suggestAnalysisIdeas": False,
        }
        if self.args.model:
            cfg["modelTag"] = self.args.model

        def go() -> Any:
            r = self.api.post("/batch", files=files, data={"config": json.dumps(cfg)})
            self.state["jobId"] = r["jobId"]
            self.save()
            print(f"· started job {r['jobId']} on the {cfg['cdeSet']!r} CDE catalog")
            return r

        self.run_leg("leg1", go)

    # -- Gate 1 ---------------------------------------------------------------------------------------------------

    def gate1(self) -> None:
        ck = self.snapshot("gate1")
        if "gate1" in self.state.setdefault("done", []):
            return self.advance("gate1", {"gate1Scope": self.state["decisions"]["scope"]})
        res = ck.get("result") or {}
        groups = res.get("conceptGroups") or []
        members: dict[str, list[str]] = res.get("conceptGroupMembers") or {}
        by_id = {g["groupId"]: g for g in groups}
        self.report.info["gate1Groups"] = len(groups)

        def groups_with(ids: Iterable[str]) -> list[str]:
            want = set(ids)
            return [gid for gid in by_id if want & set(members.get(gid) or [])]

        scope: list[str] = []
        for path in self.manifest.get("scopePriority") or list(self.manifest.get("paths") or {}):
            for gid in groups_with(self.path_ids(path)):
                if gid not in scope:
                    scope.append(gid)
        scope = scope[: self.args.max_scope]
        if len(scope) < 4:  # the fixture did not land as designed — keep the walk meaningful anyway
            extra = sorted(groups, key=lambda g: (-int(bool(g.get("crossCohort"))), -int(g.get("nMembers") or 0)))
            scope += [g["groupId"] for g in extra if g["groupId"] not in scope][: 4 - len(scope)]
            self.report.note("I1", f"fixture paths matched only {len(scope)} groups; padded scope")
        d = self.state["decisions"]
        d["scope"] = scope
        for gid in scope:
            self.api.decide(self.job_id, "gate1_group_scope", decision({"groupId": gid}, IN_SCOPE, SCOPE_OPTIONS))

        # rename (I4)
        target = scope[0]
        generated = str(by_id[target].get("concept") or "")
        new_name = f"LV renamed · {generated[:40]}".strip()
        self.api.decide(
            self.job_id,
            "gate1_rename",
            decision({"groupId": target}, new_name, [generated, new_name], generatedName=generated),
        )
        d["rename"] = {"groupId": target, "name": new_name, "generated": generated}

        # a move (I14): an eye-condition member out of one in-scope group into another in-scope group
        eye = list(self.path_ids("eye_conditions_spread"))
        eye_groups = [g for g in groups_with(eye) if g in scope]
        move = None
        for gid in eye_groups:
            dest = next((g for g in scope if g != gid and g in eye_groups), None) or next(
                (g for g in scope if g != gid), None
            )
            mem = next((m for m in members.get(gid) or [] if m in eye), None)
            if dest and mem:
                move = {"memberId": mem, "fromGroupId": gid, "toGroupId": dest}
                break
        if move is None and len(scope) >= 2:
            src = scope[-1]
            mem = (members.get(src) or [None])[0]
            if mem and len(members.get(src) or []) > 1:
                move = {"memberId": mem, "fromGroupId": src, "toGroupId": scope[0]}
        if move:
            alts = list(dict.fromkeys([move["fromGroupId"], UNASSIGNED_GROUP_ID, move["toGroupId"]]))
            self.api.decide(
                self.job_id,
                "gate1_regroup",
                decision({"memberId": move["memberId"], "fromGroupId": move["fromGroupId"]}, move["toGroupId"], alts,
                         movedAt=int(time.time() * 1000)),  # fmt: skip
            )
        d["move"] = move

        # New group (I4/I14): a reviewer group filled with the remaining eye items. The payload is exactly what the
        # Gate 1 sidebar writes (frontend/src/pages/run/gate1.tsx `createGroup`): name in `chosen` and `name`.
        new_gid = f"rev:{uuid.uuid4()}"
        new_name = "LV eye conditions"
        try:
            self.api.decide(
                self.job_id,
                "gate1_new_group",
                decision({"groupId": new_gid}, new_name, [new_name], name=new_name, createdAt=int(time.time() * 1000)),
            )
            # Fill it from ANY group, in scope or not (moving a variable out of a group the reviewer left out is a
            # legal Gate 1 move), so the check does not depend on where the fixture's eye items clustered this run.
            taken = (move or {}).get("memberId")
            home = {m: g for g in by_id for m in members.get(g) or []}
            fill = [m for m in eye if m in home and m != taken]
            if len(fill) < 2:  # the fixture did not land as designed — two members of the largest in-scope group
                big = max(scope, key=lambda g: len(members.get(g) or []))
                fill = [m for m in members.get(big) or [] if m != taken][:2] if len(members.get(big) or []) > 2 else []
                self.report.note("I4", f"eye items not found in any group; filled the New group from {big}")
            moved = []
            for m in fill[:3]:
                src = home[m]
                alts = list(dict.fromkeys([src, UNASSIGNED_GROUP_ID, new_gid]))
                self.api.decide(
                    self.job_id,
                    "gate1_regroup",
                    decision({"memberId": m, "fromGroupId": src}, new_gid, alts, movedAt=int(time.time() * 1000)),
                )
                moved.append({"memberId": m, "fromGroupId": src})
            d["newGroup"] = {"groupId": new_gid, "name": new_name, "members": moved}
            # Continue sends the groups Gate 1 BILLS — in scope and non-empty (`gate1BillableGroups`), and a New
            # group is in scope by default — so a filled New group rides in the scope the server freezes.
            if moved:
                scope.append(new_gid)
        except ApiError as exc:
            d["newGroup"] = {"refused": exc.status, "detail": exc.body[:300]}
            self.report.check("I4", False, "Gate 1 can create a New group", f"PUT gate1_new_group → {exc.status}")

        # score (I11)
        self.score_gate1()
        self.state["done"].append("gate1")
        self.save()
        self.playwright("gate1")
        self.advance("gate1", {"gate1Scope": scope})

    def advance(self, gate: str, body: dict[str, Any]) -> None:
        """Press Continue on ``gate`` (the paid leg to the next gate) unless the iteration stops here."""
        if self.args.until == gate:
            return
        leg = f"leg{GATES.index(gate) + 2}"
        self.run_leg(leg, lambda: self.api.post(f"/resume/{self.job_id}", json=body))

    def score_gate1(self) -> None:
        doc = self.args.score_doc
        if not doc or not Path(doc).exists():
            self.report.note("I11", "no --score-doc; score path not exercised")
            return
        s: dict[str, Any] = {}
        self.state["decisions"]["score"] = s
        with open(doc, "rb") as fh:
            read = self.api.post("/score/extract", files={"file": (Path(doc).name, fh.read())})
        s["nChars"] = read.get("nChars")
        before_app = float(self.api.job(self.job_id).get("costSoFar") or 0)
        t0 = time.time()
        body = {"text": read["text"], "sha256": read["sha256"], "provenance": read.get("provenance", "")}
        prop = self.api.post(f"/jobs/{self.job_id}/score/components", json=body)
        t1 = time.time()
        tap = tap_usd(tap_rows(self.tap, t0, t1))
        after_app = float(self.api.job(self.job_id).get("costSoFar") or 0)
        s["extractTapUsd"] = tap
        s["found"] = prop.get("found")
        s["n"] = len(prop.get("components") or [])
        self.report.check("I11", bool(prop.get("found")) and s["n"] > 0, "extraction proposes components", s["n"])
        self.report.check(
            "I11",
            tap <= 0 or after_app - before_app >= tap * 0.9,
            "extraction spend is recorded on the run",
            {"tapUsd": tap, "appDelta": round(after_app - before_app, 6)},
        )
        t2 = time.time()
        again = self.api.post(f"/jobs/{self.job_id}/score/components", json=body)
        self.report.check(
            "I11",
            again.get("cached") is True and tap_usd(tap_rows(self.tap, t2, time.time())) == 0,
            "a repeat extraction is cached and not charged",
        )
        name = str(prop.get("scoreName") or "LV score")
        comps = [c["name"] for c in prop.get("components") or [] if c.get("verbatim")]
        s["scoreName"], s["declared"] = name, comps
        for c in comps:
            self.api.decide(self.job_id, "composite_swap", decision({"scoreName": name, "componentName": c}, "", comps))
        rows = (self.api.artifacts(self.job_id).get("artifacts") or {}).get("composite_swap") or []
        self.report.check("I11", len(rows) == len(comps), "the declaration persists", f"{len(rows)} of {len(comps)}")

    # -- Gate 2 ---------------------------------------------------------------------------------------------------

    def gate2(self) -> None:
        ck = self.snapshot("gate2")
        if "gate2" in self.state.setdefault("done", []):
            return self.advance("gate2", {})
        records = (ck.get("result") or {}).get("records") or []
        d = self.state["decisions"]
        self.check_scope_and_replay(records)
        self.check_moves(records, "gate2")
        self.check_labels(records, "gate2")

        # a re-pick (I5): a novel record re-pointed at a catalog candidate, else an adopt at its runner-up
        repick = None
        for r in records:
            cands = [c for c in r.get("candidates") or [] if c.get("cdeId")]
            model = next((c["cdeId"] for c in cands if c.get("isChosen")), (r.get("cde") or {}).get("id") or "")
            alt = next((c["cdeId"] for c in cands if c["cdeId"] != model), None)
            if alt and r.get("verdict") == "novel":
                repick = (r, alt, model)
                break
        if repick is None:
            for r in records:
                cands = [c for c in r.get("candidates") or [] if c.get("cdeId")]
                model = next((c["cdeId"] for c in cands if c.get("isChosen")), "")
                alt = next((c["cdeId"] for c in cands if c["cdeId"] != model), None)
                if alt:
                    repick = (r, alt, model)
                    break
        if repick:
            r, alt, model = repick
            alts = [c["cdeId"] for c in r.get("candidates") or [] if c.get("cdeId")]
            self.api.decide(self.job_id, "gate2_candidate_pick", decision({"groupId": r["groupId"]}, alt, alts))
            d["repick"] = {"groupId": r["groupId"], "chosen": alt, "model": model, "modelGencde":
                           (r.get("gencde") or {}).get("gencdeId", "")}  # fmt: skip
        else:
            self.report.note("I5", "no record had a second candidate to re-pick")

        # a GenCDE edit (I6): every permissible code re-lettered so the regenerated recodes are unmistakable
        edit = None
        for r in records:
            g = r.get("gencde") or {}
            pvs = g.get("permissibleValues") or []
            if r.get("verdict") == "novel" and len(pvs) >= 2 and r["groupId"] != (d.get("repick") or {}).get("groupId"):
                values = " / ".join(f"E{pv['code']}={pv['label']}" for pv in pvs)
                anchor = {"name": g.get("preferredName") or g.get("title") or "", "definition": g.get("definition", ""),
                          "units": g.get("units", ""), "values": values}  # fmt: skip
                alts = [c["cdeId"] for c in r.get("candidates") or [] if c.get("cdeId")]
                chosen = g.get("gencdeId") or ""
                self.api.decide(
                    self.job_id,
                    "gate2_candidate_pick",
                    decision({"groupId": r["groupId"]}, chosen, alts, gencdeEdit=anchor),
                )
                edit = {"groupId": r["groupId"], "codes": [f"E{pv['code']}" for pv in pvs], "gencdeId": chosen}
                break
        d["gencdeEdit"] = edit
        if edit is None:
            self.report.note("I6", "no novel record with a ≥2-value GenCDE to edit")
        self.state["done"].append("gate2")
        self.save()
        self.playwright("gate2")
        self.advance("gate2", {})

    # -- Gate 3 ---------------------------------------------------------------------------------------------------

    def gate3(self) -> None:
        ck = self.snapshot("gate3")
        if "gate3" in self.state.setdefault("done", []):
            return self.advance("gate3", {})
        records = (ck.get("result") or {}).get("records") or []
        d = self.state["decisions"]
        self.check_moves(records, "gate3")
        self.check_labels(records, "gate3")
        self.check_repick_and_gencde(records, "gate3")
        by_group = {r["groupId"]: r for r in records}
        taken: set[str] = set()
        skip_groups = {(d.get("gencdeEdit") or {}).get("groupId"), (d.get("repick") or {}).get("groupId")}

        def pick_transform(pred: Callable[[dict[str, Any]], bool]) -> tuple[dict[str, Any], dict[str, Any]] | None:
            for r in records:
                if r["groupId"] in skip_groups:
                    continue
                for t in r.get("transforms") or []:
                    sv = t.get("sourceVariable")
                    if sv and sv not in taken and pred(t):
                        taken.add(sv)
                        return r, t
            return None

        def write_spec(r: dict[str, Any], t: dict[str, Any], **extra: Any) -> None:
            sv = t["sourceVariable"]
            pick = next(
                (p for p in (self.api.artifacts(self.job_id).get("artifacts") or {}).get("gate2_candidate_pick") or []
                 if p.get("groupId") == r["groupId"]),
                None,
            )  # fmt: skip
            payload = decision({"sourceVariable": sv}, "" if extra.get("rejected") else sv, [sv], **extra)
            if pick:
                payload["upstream"] = {"kind": "gate2_candidate_pick", "itemKey": r["groupId"],
                                       "contentKey": content_key(pick)}  # fmt: skip
            self.api.decide(self.job_id, "gate3_spec_edit", payload)

        rej = pick_transform(lambda t: t.get("kind") == "categorical")
        if rej:
            write_spec(*rej, rejected=True)
            d["rejected"] = rej[1]["sourceVariable"]
        noted = pick_transform(lambda t: True)
        if noted:
            write_spec(*noted, note="LV note: checked against the codebook")
            d["noted"] = noted[1]["sourceVariable"]
        empty = pick_transform(lambda t: True)
        if empty:
            write_spec(*empty, note="")  # what the screen writes for a note cleared back to nothing
            d["emptyEdit"] = empty[1]["sourceVariable"]
        d["noneSpecs"] = [
            t["sourceVariable"] for r in records for t in r.get("transforms") or [] if t.get("kind") == "none"
        ]
        d["gate3Groups"] = sorted(by_group)
        self.state["done"].append("gate3")
        self.save()
        # The recode EDIT is made through the real editor (live Playwright), because I7 is about what the screen
        # seeds and saves — an API write would only store whatever this script sent.
        self.playwright("gate3")
        self.advance("gate3", {})

    # -- Gate 4 ---------------------------------------------------------------------------------------------------

    def gate4(self) -> None:
        ck = self.snapshot("gate4")
        d = self.state["decisions"]
        records = (ck.get("result") or {}).get("records") or []
        self.check_moves(records, "gate4")

        # score matching on the staged run (I11)
        s = d.get("score")
        if s and s.get("scoreName"):
            # Gate 4's "Match" (Q5): the Gate 1 declaration IS the definition — one model call, nothing transcribed.
            t0 = time.time()
            try:
                spec = self.api.post(f"/jobs/{self.job_id}/composite", json={"declaredScore": s["scoreName"]})
                s["match"] = {"verdict": spec.get("feasibility") or spec.get("verdict"), "keys": sorted(spec)[:20],
                              "billedUsd": spec.get("billedUsd")}  # fmt: skip
                self.report.check("I11", True, "score matching is reachable on a staged run at Gate 4")
            except ApiError as exc:
                s["match"] = {"refused": exc.status, "detail": exc.body[:200]}
                self.report.check("I11", False, "score matching is reachable on a staged run at Gate 4",
                                  f"{exc.status}: {exc.body[:160]}")  # fmt: skip
            s["matchTapUsd"] = tap_usd(tap_rows(self.tap, t0, time.time()))
            billed = (s.get("match") or {}).get("billedUsd")
            if s["matchTapUsd"] > 0:
                self.report.check("I11", billed is not None and abs(float(billed) - s["matchTapUsd"]) <= 0.002,
                                  "the match's bill equals what the provider billed",
                                  {"billed": billed, "tap": s["matchTapUsd"]})  # fmt: skip

        exports: dict[str, Any] = {}
        for fmt in EXPORT_FORMATS:
            r = self.api.http.get(f"{self.api.base}/jobs/{self.job_id}/export", params={"format": fmt})
            ok = r.status_code == 200
            self.report.check("I4", ok, f"export {fmt} downloads", r.status_code)
            ext = "json" if fmt in ("records_json",) or fmt.startswith("notebook") else fmt.split("_")[-1]
            (self.out / f"export_{fmt}.{ext}").write_text(r.text)
            exports[fmt] = r.text
        self.save()
        self.playwright("gate4")
        self.check_exports(exports)

    # -- invariant checks --------------------------------------------------------------------------------------------

    def check_scope_and_replay(self, records: list[dict[str, Any]]) -> None:
        d, snaps = self.state["decisions"], self.state["snapshots"]
        frozen = (snaps["gate2"]["config"] or {}).get("gate1_scope")
        # The server freezes the scope in CHECKPOINT order (unknown ids dropped), so compare the sets.
        self.report.check("I1", sorted(frozen or []) == sorted(d["scope"]), "the frozen scope is exactly what Gate 1 "
                          "showed in scope", {"frozen": frozen, "shown": d["scope"]})  # fmt: skip
        got = sorted({r["groupId"] for r in records})
        ng = d.get("newGroup") or {}
        want = sorted(set(d["scope"]) | ({ng.get("groupId")} if ng.get("members") else set()))
        self.report.check("I1", got == want, "Gate 2 lists exactly the in-scope groups", {"got": got, "want": want})
        r1, r2 = snaps["gate1"]["responseIds"], snaps["gate2"]["responseIds"]
        if not r1 or not r2:
            self.report.note("I1", "checkpoint files unreadable — replay check skipped (is --rig-dir right?)")
            return
        for stage in ("generate", "split", "coherence", "kinds"):
            extra = sorted(set(r2.get(stage) or []) - set(r1.get(stage) or []))
            self.report.check("I1", not extra, f"the Gate 1→2 leg bought no new {stage} answer", extra[:8])
        # The ONE sanctioned new generate-style call, on its own stage (never `generate`): an ideal for the filled New
        # group, and (Option B) a REGENERATED one for each edited group that was sent — one each, and nothing else.
        ng = d.get("newGroup") or {}
        ideals = sorted(r2.get("group_generate") or [])
        got = [i.split("@")[0].removeprefix("leanb:groupideal:") for i in ideals]
        edited = {x for x in ((d.get("move") or {}).get("fromGroupId"), (d.get("move") or {}).get("toGroupId")) if x}
        edited |= {m.get("fromGroupId") for m in ng.get("members") or [] if m.get("fromGroupId")}
        allowed = ({ng["groupId"]} if ng.get("members") else set()) | (edited & set(d["scope"]))
        self.report.check(
            "I4",
            all(i.startswith("leanb:groupideal:") for i in ideals)
            and len(got) == len(set(got))
            and set(got) <= allowed
            and (not ng.get("members") or ng["groupId"] in got),
            "the Gate 1→2 leg bought one ideal per filled New group and per edited in-scope group, and no other",
            {"bought": got[:8], "allowed": sorted(allowed)[:8]},
        )
        assigned = sorted(r2.get("classify") or [])
        self.report.check(
            "I1",
            len(assigned) == len(want),
            "one assign prompt per in-scope group",
            {"assignPrompts": len(assigned), "groups": len(want)},
        )

    def check_moves(self, records: list[dict[str, Any]], gate: str) -> None:
        d = self.state["decisions"]
        by_group = {r["groupId"]: r for r in records}
        moves = []
        if d.get("move"):
            moves.append(d["move"])
        for m in (d.get("newGroup") or {}).get("members") or []:
            moves.append({**m, "toGroupId": d["newGroup"]["groupId"]})
        if not moves:
            self.report.note("I14", "no move was made")
            return
        for mv in moves:
            origin = by_group.get(mv["fromGroupId"])
            dest = by_group.get(mv["toGroupId"])
            gone = origin is None or mv["memberId"] not in (origin.get("members") or [])
            there = dest is not None and mv["memberId"] in (dest.get("members") or [])
            self.report.check("I14", gone and there, f"{gate}: {mv['memberId']} moved {mv['fromGroupId']} → "
                              f"{mv['toGroupId']}", {"leftOrigin": gone, "inDestination": there})  # fmt: skip
        ng = d.get("newGroup") or {}
        if ng.get("groupId") and ng.get("members"):
            self.report.check(
                "I4", ng["groupId"] in by_group, f"{gate}: the New group is its own record", ng["groupId"]
            )

    def check_labels(self, records: list[dict[str, Any]], gate: str) -> None:
        bad = []
        for r in records:
            for c in r.get("candidates") or []:
                for label in c.get("permissibleValues") or []:
                    if str(label).count("(") != str(label).count(")"):
                        bad.append(f"{c.get('cdeId')}: {label}")
            for pv in (r.get("gencde") or {}).get("permissibleValues") or []:
                lab = str(pv.get("label") or "")
                if lab.count("(") != lab.count(")"):
                    bad.append(f"{(r.get('gencde') or {}).get('gencdeId')}: {lab}")
        self.report.check("I13", not bad, f"{gate}: every permissible-value label has balanced parentheses", bad[:6])

    def check_repick_and_gencde(self, records: list[dict[str, Any]], gate: str) -> None:
        d = self.state["decisions"]
        by_group = {r["groupId"]: r for r in records}
        rp = d.get("repick")
        if rp and rp["groupId"] in by_group:
            r = by_group[rp["groupId"]]
            targets = sorted({t.get("targetCdeId") for t in r.get("transforms") or []})
            self.report.check("I5", bool(targets) and targets == [rp["chosen"]], f"{gate}: specs target the re-pick",
                              {"targets": targets, "pick": rp["chosen"]})  # fmt: skip
            pick = r.get("reviewerPick") or {}
            self.report.check("I5", pick.get("modelTarget") in (rp["model"], rp.get("modelGencde")) and
                              bool(pick.get("modelTarget")), f"{gate}: the record keeps the model's own pick",
                              pick)  # fmt: skip
        ge = d.get("gencdeEdit")
        if ge and ge["groupId"] in by_group:
            r = by_group[ge["groupId"]]
            codes = set(ge["codes"])
            vals = {str(v) for t in r.get("transforms") or [] if t.get("kind") == "categorical"
                    for v in (t.get("codeMap") or {}).values()}  # fmt: skip
            self.report.check("I6", bool(vals) and vals <= codes | {"", "__missing__"},
                              f"{gate}: recodes map onto the EDITED GenCDE codes", {"used": sorted(vals)[:10],
                              "edited": sorted(codes)})  # fmt: skip

    def check_exports(self, ex: dict[str, str]) -> None:
        d = self.state["decisions"]
        try:
            recs = json.loads(ex.get("records_json") or "[]")
        except json.JSONDecodeError:
            recs = []
        by_group = {r.get("groupId"): r for r in recs}
        # I4 — rename
        rn = d.get("rename") or {}
        rr = by_group.get(rn.get("groupId"))
        self.report.check("I4", bool(rr) and rr.get("concept") == rn.get("name") and
                          rr.get("generatedConcept") == rn.get("generated"), "records JSON carries the rename and "
                          "keeps the generated name", {k: (rr or {}).get(k) for k in ("concept", "generatedConcept")})  # fmt: skip
        tsv = ex.get("eitl_tsv") or ""
        self.report.check("I4", bool(rn.get("name")) and rn["name"] in tsv, "the EITL TSV carries the rename")
        ng = d.get("newGroup") or {}
        if ng.get("groupId") and ng.get("members"):
            self.report.check("I4", ng["groupId"] in by_group, "the New group is exported as its own record")
        # I5 — re-pick provenance
        rp = d.get("repick")
        if rp:
            r = by_group.get(rp["groupId"]) or {}
            self.report.check("I5", (r.get("cde") or {}).get("id") == rp["chosen"], "export target = the reviewer's pick",
                              r.get("cde"))  # fmt: skip
            self.report.check("I5", r.get("targetPickedBy") == "reviewer", "export says the reviewer picked it",
                              r.get("targetPickedBy"))  # fmt: skip
            model_ids = {rp["model"], rp.get("modelGencde")} - {"", None}
            mc = (r.get("modelCde") or {}).get("id") or (r.get("modelCde") or {}).get("gencdeId")
            self.report.check("I5", mc in model_ids or (not mc and not rp["model"]),
                              "export keeps the model's own pick", {"modelCde": r.get("modelCde"),
                              "model": sorted(model_ids)})  # fmt: skip
        # I6 — GenCDE edit reaches the exported recodes
        ge = d.get("gencdeEdit")
        if ge:
            r = by_group.get(ge["groupId"]) or {}
            vals = {str(v) for t in r.get("transforms") or [] if t.get("kind") == "categorical"
                    for v in (t.get("codeMap") or {}).values()}  # fmt: skip
            self.report.check("I6", bool(vals) and vals <= set(ge["codes"]) | {"", "__missing__"},
                              "exported recodes use the edited GenCDE codes", sorted(vals)[:10])  # fmt: skip
        # I7 — any reviewer mapping is in target codes
        for r in recs:
            targets = self._target_codes(r)
            for t in r.get("transforms") or []:
                m = (t.get("reviewerEdit") or {}).get("mapping")
                if not m:
                    continue
                vals = {str(v) for v in m.values()} - {"", "__missing__", "missing"}
                self.report.check("I7", not targets or vals <= targets, f"reviewer mapping for {t['sourceVariable']} "
                                  "is in target codes", {"mapping": m, "targetCodes": sorted(targets)[:12]})  # fmt: skip
        # I11 — a matched score travels in the exports
        if ((d.get("score") or {}).get("match") or {}).get("billedUsd") is not None:
            try:
                sj = json.loads(ex.get("score_json") or "{}")
            except json.JSONDecodeError:
                sj = {}
            self.report.check("I11", bool(sj) and "verdict" in json.dumps(sj).lower(), "the score export carries the "
                              "match verdict", sorted(sj)[:10] if isinstance(sj, dict) else type(sj).__name__)  # fmt: skip
        # I8 / I9 — the notebook
        self.check_notebook(ex.get("notebook_py") or "", recs)
        # I10 — the decision log
        self.check_decision_log(ex.get("decisions_csv") or "")

    @staticmethod
    def _target_codes(r: dict[str, Any]) -> set[str]:
        g = r.get("gencde") or {}
        cde = r.get("cde") or {}
        if not cde or cde.get("id") == g.get("gencdeId"):
            return {str(pv.get("code")) for pv in g.get("permissibleValues") or []}
        return set()  # a catalog target's codes are not on the record; the Playwright project checks those

    def check_notebook(self, text: str, recs: list[dict[str, Any]]) -> None:
        try:
            nb = json.loads(text)
        except json.JSONDecodeError:
            self.report.check("I9", False, "the Python notebook parses")
            return
        none_specs = set(self.state["decisions"].get("noneSpecs") or [])
        kind_of = {t.get("sourceVariable"): t.get("kind") for r in recs for t in r.get("transforms") or []}
        copies_of_none, double = [], []
        for cell in nb.get("cells") or []:
            if cell.get("cell_type") != "code":
                continue
            src = "".join(cell.get("source") or [])
            m = re.search(r"^# ===== (.+?) =====", src, re.M)
            if not m:
                continue
            cohort = m.group(1)
            assigned: dict[str, int] = {}
            lines = src.splitlines()
            for i, ln in enumerate(lines):
                a = re.match(r"^h_\w+\[(['\"])(.+?)\1\]\s*=", ln)
                if not a:
                    continue
                assigned[a.group(2)] = assigned.get(a.group(2), 0) + 1
                v = re.search(r"raw_\w+\[(['\"])(.+?)\1\]\s*$", ln)
                head = lines[i - 1] if i else ""
                if v and "(copy)" in head:
                    sv = f"{cohort}:{v.group(2)}"
                    if sv in none_specs or kind_of.get(sv) == "none":
                        copies_of_none.append(sv)
            double += [f"{cohort}: {tgt} ×{n}" for tgt, n in assigned.items() if n > 1]
        self.report.check("I8", not copies_of_none, "no spec that could not be produced is exported as a copy",
                          copies_of_none[:8])  # fmt: skip
        self.report.check("I9", not double, "no target column is assigned twice within a cohort", double[:8])

    def check_decision_log(self, text: str) -> None:
        import csv
        import io

        rows = list(csv.DictReader(io.StringIO(text)))
        d = self.state["decisions"]
        if not rows:
            self.report.check("I10", False, "the decision log has rows")
            return
        rp = d.get("repick")
        if rp:
            row = next(
                (r for r in rows if r.get("kind") == "gate2_candidate_pick" and r.get("item") == rp["groupId"]), None
            )
            self.report.check("I10", bool(row) and row.get("before") != row.get("after"), "the re-pick logs a real "
                              "before → after", {k: (row or {}).get(k) for k in ("before", "after")})  # fmt: skip
        ge = d.get("gencdeEdit")
        if ge:
            row = next(
                (r for r in rows if r.get("kind") == "gate2_candidate_pick" and r.get("item") == ge["groupId"]), None
            )
            reads_as_noop = (
                bool(row) and row.get("before") == row.get("after") and "gencdeEdit" not in (row.get("detail") or "")
            )
            self.report.check("I10", bool(row) and not reads_as_noop, "the GenCDE edit is logged as a change",
                              {k: (row or {}).get(k) for k in ("before", "after", "detail")})  # fmt: skip
        empty = d.get("emptyEdit")
        if empty:
            row = next((r for r in rows if r.get("kind") == "gate3_spec_edit" and r.get("item") == empty), None)
            self.report.check("I10", not row or row.get("after") != "annotated", "an empty Gate 3 row is not "
                              "logged as 'annotated'", {k: (row or {}).get(k) for k in ("after", "note")})  # fmt: skip
        declared = [r for r in rows if r.get("kind") == "composite_swap"]
        if declared:
            self.report.check("I10", len(declared) <= 1, "a score declaration is one log row, not one per component",
                              len(declared))  # fmt: skip

    def check_costs(self) -> None:
        frames = [f for f in self.state["frames"] if f.get("costSoFar") is not None]
        drops = []
        for a, b in zip(frames, frames[1:], strict=False):
            if float(b["costSoFar"]) + 1e-9 < float(a["costSoFar"]):
                drops.append(f"{a['leg']}:{a['costSoFar']} → {b['leg']}:{b['costSoFar']}")
        self.report.check("I2", not drops, "costSoFar never goes down", drops[:6])
        snaps = self.state["snapshots"]
        prev = None
        for g in GATES:
            s = snaps.get(g)
            if not s:
                continue
            per = ((s.get("cost") or {}).get("perStage")) or {}
            if prev is not None:
                pper = ((prev.get("cost") or {}).get("perStage")) or {}
                lost = sorted(set(pper) - set(per))
                shrunk = sorted(k for k in pper if k in per and float(per[k]["usd"]) + 1e-9 < float(pper[k]["usd"]))
                self.report.check("I2", not lost and not shrunk, f"{g}: every earlier stage's cost carries forward",
                                  {"lost": lost, "shrunk": shrunk})  # fmt: skip
                pa = float((prev.get("cost") or {}).get("actualUsd") or 0)
                a = float((s.get("cost") or {}).get("actualUsd") or 0)
                self.report.check(
                    "I2", a + 1e-9 >= pa, f"{g}: the run total does not go down", {"before": pa, "now": a}
                )
            prev = s
        legs = self.state["legs"]
        tap_total = self.spent()
        app_total = float(self.api.job(self.job_id).get("costSoFar") or 0)
        self.report.info["tapUsd"] = tap_total
        self.report.info["appUsd"] = app_total
        self.report.info["legs"] = [
            {k: lg.get(k) for k in ("label", "status", "gate", "tapUsd", "tapCalls")} for lg in legs
        ]
        sw = self.state.get("switch")
        if sw:
            self.report.check("I2", "response" in sw, "the batch→sync switch was accepted mid-leg", sw.get("refused") or
                              sw.get("leg"))  # fmt: skip
        elif self.args.switch_after is not None:
            self.report.note("I2", "the switch was requested but no leg's batch was still queued long enough")
        tol = max(0.002, 0.03 * tap_total)
        self.report.check("I2", abs(app_total - tap_total) <= tol, "the run's spend equals what the provider billed",
                          {"app": app_total, "tap": tap_total})  # fmt: skip

    def check_quote(self) -> None:
        self.report.note("I3", "quote vs bill is read by the live Playwright project (the quote is a screen value)")

    # -- orchestration ----------------------------------------------------------------------------------------------

    def run(self) -> int:
        self.report.info.update(
            {
                "runMode": self.args.run_mode,
                "startedAt": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.state["startedAt"])),
                "commitUi": _git(ROOT),
                "commitCore": _git(Path(self.args.core)) if self.args.core else "",
                "cap": self.args.cap,
            }
        )
        try:
            if "jobId" not in self.state:
                if self.args.job:
                    self.state["jobId"] = self.args.job
                else:
                    self.start()
            self.report.info["jobId"] = self.job_id
            for gate, step in (
                ("gate1", self.gate1),
                ("gate2", self.gate2),
                ("gate3", self.gate3),
                ("gate4", self.gate4),
            ):
                pos = self.api.job(self.job_id).get("gatePosition")
                if pos is None or GATES.index(pos) > GATES.index(gate):
                    continue
                print(f"== {gate}")
                step()
                if self.args.until == gate:
                    break
                if gate != "gate4" and self.api.job(self.job_id).get("gatePosition") == gate:
                    raise RuntimeError(f"the run is still parked at {gate} after Continue")
            self.check_costs()
            self.check_quote()
            code = 1 if self.report.failed() else 0
        except CapHitError as exc:
            print(f"CAP: {exc}")
            self.report.info["capHit"] = str(exc)
            code = 2
        except Exception as exc:  # noqa: BLE001 - a driver fault is reported, not swallowed
            import traceback

            traceback.print_exc()
            self.report.info["driverError"] = f"{type(exc).__name__}: {exc}"
            code = 2
        self.report.info["spentUsd"] = self.spent() if "startedAt" in self.state else None
        self.report.write()
        self.save()
        print(f"\nfailed: {self.report.failed() or 'none'} · spent ${self.report.info.get('spentUsd') or 0:.4f}")
        print(f"report: {self.out / 'report.md'}")
        return code


def _git(path: Path) -> str:
    try:
        return subprocess.check_output(["git", "-C", str(path), "rev-parse", "--short", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://127.0.0.1:8018")
    ap.add_argument("--fixture", default=str(ROOT / "tests/live/fixture"))
    ap.add_argument("--rig-dir", default=str(ROOT / ".ddharmon_ui/rig"))
    ap.add_argument(
        "--core", default=os.environ.get("LIVE_CORE_DIR", ""), help="core checkout, for the report's commit"
    )
    ap.add_argument("--out", required=True, help="iteration directory (state.json makes it resumable)")
    ap.add_argument("--run-mode", default="sync", choices=("sync", "batch"))
    ap.add_argument(
        "--cde-set",
        default=None,
        choices=CDE_SETS,
        help="default: the catalog the fixture records (manifest cdeSet), else full — the default for a new run",
    )
    ap.add_argument("--model", default=None)
    ap.add_argument("--job", default=None, help="drive an existing parked run instead of starting one")
    ap.add_argument("--until", default=None, choices=GATES, help="stop after making this gate's decisions")
    ap.add_argument("--max-scope", type=int, default=10)
    ap.add_argument("--score-doc", default=os.environ.get("LIVE_SCORE_DOC"))
    ap.add_argument("--cap", type=float, default=1.50, help="USD; the run is cancelled when the tap passes it")
    ap.add_argument("--playwright", action="store_true", help="run the live Playwright project at each gate")
    ap.add_argument("--switch-after", type=float, default=None, help="batch mode: press 'Finish now with sync' once, "
                    "on the first leg still queued after this many seconds")  # fmt: skip
    args = ap.parse_args()
    return Driver(args).run()


if __name__ == "__main__":
    sys.exit(main())
