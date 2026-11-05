"""Build the shared demo's DECLARED SCORE — declaration, Gate 1 hints, Gate 4 match — into a small sidecar.

The demo is guest-facing and pinned: it never spends, so its score panel could never show the flow it exists for
(declare the components on Gate 1, see which groups the free search reaches, match them on Gate 4). This builds that
flow ONCE, against a rig serving the demo's own run, and writes it to ``backend/demos/score.json`` keyed by snapshot
filename. ``backend.demos.seed_demos`` attaches it to the seeded demo: the declaration and hints ride the demo's
payload as ``demoScore``, the match rides it as the run's ``composites``.

How, through the rig's own HTTP API (the same routes a reviewer's screens call):

  1. clone the run behind the demo — a pinned or auto-accepted Gate 1 refuses a declaration; a clone is a finished
     run the caller owns, so it takes one — and check the clone's records ARE the shipped snapshot's (same ids, same
     concept names), so everything below is grounded in what a guest sees;
  2. write the score's components as ``composite_swap`` rows, exactly the payload the score panel's "Declare these
     components" writes (one row per component, ``chosen: ""``, the whole list as ``alternatives``);
  3. read Gate 1's free hints (``GET /score/suggestions`` — embedding only, $0);
  4. run Gate 4's match (``POST /composite {declaredScore}`` — ONE paid model call on the run's model, billed to the
     clone), reading the clone's ledger before and after;
  5. read the stored match back and write the sidecar.

The rig holds the provider key; this script never takes, reads or prints one. Re-running with ``--clone <id>``
resumes against an existing clone and never pays twice: rows already written are kept, and a match already stored
for the score is reused instead of bought again.

Usage:
    scripts/rig.sh start   # in the worktree whose rig serves the demo's run
    python scripts/build_demo_score.py --rig http://127.0.0.1:8018 --run <the demo's run id>

Rebuild it after every demo rebuild: the sidecar names the run's groups and concepts, and
``tests/test_demo_score.py`` fails when they are no longer the shipped snapshot's.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

from backend.demos import _DIR, _SCORE  # noqa: E402

#: The score the demo declares. Its name is what Gate 4 pairs a declaration with its match by.
SCORE_NAME = "Frailty index (Williams et al. 2019, 49 items)"
#: Williams DM, Jylhava J, Pedersen NL, Hagg S. A Frailty Index for UK Biobank Participants. J Gerontol A Biol Sci Med
#: Sci 2019;74(4):582-587, doi:10.1093/gerona/gly094 — Table 1's 49 deficits, in the paper's order.
COMPONENTS = (
    "Glaucoma",
    "Cataracts",
    "Hearing difficulty",
    "Migraine",
    "Dental problems",
    "Self-rated health",
    "Fatigue: frequency of tiredness / lethargy in last two weeks",
    "Sleep: experience of sleeplessness / insomnia",
    "Depressed feelings: frequency in last two weeks",
    "Self-described nervous personality",
    "Severe anxiety / panic attacks",
    "Common to feel loneliness",
    "Sense of misery (ever / never)",
    "Infirmity: long-standing illness or disability",
    "Falls in last year",
    "Fractures / broken bones in last five years",
    "Diabetes",
    "Myocardial infarction",
    "Angina",
    "Stroke",
    "High blood pressure",
    "Hypothyroidism",
    "Deep-vein thrombosis",
    "High cholesterol",
    "Breathing: wheeze in last year",
    "Pneumonia",
    "Chronic bronchitis / emphysema",
    "Asthma",
    "Rheumatoid arthritis",
    "Osteoarthritis",
    "Gout",
    "Osteoporosis",
    "Hayfever, allergic rhinitis or eczema",
    "Psoriasis",
    "Any cancer diagnosis",
    "Multiple cancers diagnosed (number reported)",
    "Chest pain",
    "Head and / or neck pain",
    "Back pain",
    "Stomach / abdominal pain",
    "Hip pain",
    "Knee pain",
    "Whole-body pain",
    "Facial pain",
    "Sciatica",
    "Gastric reflux",
    "Hiatus hernia",
    "Gall stones",
    "Diverticulitis",
)
#: The match's modelled price (frontend/src/lib/estimate.ts: base + per component) — the pre-spend budget check.
_MATCH_BASE_USD, _MATCH_PER_COMPONENT_USD = 0.005, 0.003


def option_set_key(alternatives: list[str]) -> str:
    """backend.artifact_kinds.option_set_key, inlined so the payload is built exactly as the panel builds it."""
    ids = sorted({str(a).strip() for a in alternatives if str(a).strip()})
    return hashlib.sha256("\x1f".join(ids).encode("utf-8")).hexdigest()[:16]


def declaration_rows(score: str = SCORE_NAME, components: tuple[str, ...] = COMPONENTS) -> list[dict[str, Any]]:
    """The ``composite_swap`` rows "Declare these components" writes for a list typed into the components box.

    ``source`` records the box as entered (one component per line). Its ``at`` is fixed rather than the build time,
    so a rebuild writes the same file — and any re-declaration a guest makes is newer than it.
    """
    names = list(components)
    source = {"kind": "paste", "text": "\n".join(names), "at": 0}
    return [
        {
            "scoreName": score,
            "componentName": name,
            "source": source,
            "chosen": "",
            "alternatives": names,
            "optionSetKey": option_set_key(names),
        }
        for name in names
    ]


class Rig:
    """The rig's HTTP API — the only thing this script talks to."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/") + "/api/harmonize"

    def call(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=900) as res:  # noqa: S310 — a rig URL the operator names
                raw = res.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise SystemExit(f"{method} {path} -> {exc.code}: {detail}") from exc
        return json.loads(raw) if raw else None

    def spent(self, job_id: str) -> float:
        """The run's realized spend, from the Runs list (the ledger a reviewer sees)."""
        row = next((j for j in self.call("GET", "/jobs") if j.get("jobId") == job_id), None)
        if row is None:
            raise SystemExit(f"run {job_id} is not on the rig's Runs list")
        return float(row.get("costSoFar") or 0.0)


def _concepts(records: list[dict[str, Any]]) -> Counter[tuple[str, str]]:
    return Counter((str(r.get("id")), (r.get("concept") or "").strip()) for r in records)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rig", required=True, help="the rig's base URL, e.g. http://127.0.0.1:8018")
    ap.add_argument("--run", help="the run behind the demo (cloned; never written to)")
    ap.add_argument("--clone", help="resume against an existing clone instead of making a new one")
    ap.add_argument("--snapshot", default="aireadi_aou_clsa_mesa_ukbb.json", help="the shipped snapshot it is for")
    ap.add_argument("--budget", type=float, default=0.50, help="refuse to match when the estimate exceeds this (USD)")
    args = ap.parse_args()
    if not args.run and not args.clone:
        ap.error("name the demo's run (--run) or an existing clone of it (--clone)")

    snap_path = _DIR / args.snapshot
    snap = json.loads(snap_path.read_text())
    shipped = snap.get("result", snap)
    rig = Rig(args.rig)

    # 1. A clone the caller owns, grounded in the shipped snapshot BEFORE anything is spent.
    clone = args.clone or rig.call("POST", f"/jobs/{args.run}/clone", {"displayName": "FI demo build"})["jobId"]
    print(f"clone: {clone}")
    served = rig.call("GET", f"/result/{clone}")["result"]
    if _concepts(served.get("records") or []) != _concepts(shipped.get("records") or []):
        raise SystemExit(
            f"the clone's records are not {args.snapshot}'s (ids / concept names differ) — the rig is not serving "
            "the run this demo was built from; nothing was spent"
        )
    print(f"grounded: {len(served['records'])} records, the same ids and concept names as {args.snapshot}")

    # 2. The declaration, as the score panel writes it. Rows already there (a resumed clone) are left alone.
    rows = declaration_rows()
    held = rig.call("GET", f"/jobs/{clone}/artifacts")["artifacts"].get("composite_swap") or []
    have = {(r.get("scoreName"), r.get("componentName")) for r in held}
    for row in rows:
        if (row["scoreName"], row["componentName"]) not in have:
            rig.call("PUT", f"/jobs/{clone}/artifacts/composite_swap", row)
    held = rig.call("GET", f"/jobs/{clone}/artifacts")["artifacts"].get("composite_swap") or []
    if sorted(r["componentName"] for r in held if r.get("scoreName") == SCORE_NAME) != sorted(COMPONENTS):
        raise SystemExit("the declaration did not land as written; nothing was spent")
    print(f"declared: {len(rows)} components of {SCORE_NAME!r}")

    # 3. Gate 1's free hints ($0 — embedding only, no model, nothing billed).
    suggestions = rig.call("GET", f"/jobs/{clone}/score/suggestions")
    if suggestions.get("billedUsd"):
        raise SystemExit(f"the free hints reported a charge ({suggestions['billedUsd']}) — refusing to continue")
    reached = sum(len(c["groups"]) for s in suggestions["scores"] for c in s["components"])
    print(f"hints: scored={suggestions['scored']} threshold={suggestions['threshold']} groups reached={reached}")

    # 4. Gate 4's match — the ONE paid call — unless this clone already holds one for the score.
    def stored() -> dict[str, Any] | None:
        specs = rig.call("GET", f"/result/{clone}").get("composites") or []
        named = [s for s in specs if (s.get("definition") or {}).get("name", "").strip() == SCORE_NAME]
        return named[-1] if named else None

    spec = stored()
    before = rig.spent(clone)
    if spec is None:
        estimate = _MATCH_BASE_USD + _MATCH_PER_COMPONENT_USD * len(COMPONENTS)
        if estimate > args.budget:
            raise SystemExit(f"the match is estimated at ${estimate:.3f}, over the ${args.budget:.2f} budget")
        print(f"matching (one model call, estimated ${estimate:.3f}); ledger before ${before:.4f}")
        answer = rig.call("POST", f"/jobs/{clone}/composite", {"declaredScore": SCORE_NAME})
        after = rig.spent(clone)
        print(f"matched: billed ${answer.get('billedUsd', 0):.4f}; ledger after ${after:.4f} (+${after - before:.4f})")
        spec = stored()
        if spec is None:
            raise SystemExit("the match ran but no composite was stored for the score")
    else:
        print(f"reusing the match already stored on {clone} (nothing spent); ledger ${before:.4f}")

    # 5. The sidecar: deterministic (fixed row order and timestamps), keyed by snapshot filename.
    by_snapshot: dict[str, Any] = json.loads(_SCORE.read_text()) if _SCORE.exists() else {}
    by_snapshot[args.snapshot] = {"declaration": rows, "suggestions": suggestions, "composite": spec}
    _SCORE.write_text(json.dumps(by_snapshot, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
    feas = spec.get("feasibility") or {}
    print(
        f"verdict: {feas.get('verdict')} — {len(feas.get('matched') or [])}/{len(COMPONENTS)} components matched; "
        f"wrote {_SCORE.relative_to(_ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
