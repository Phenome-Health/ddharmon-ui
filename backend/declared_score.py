"""The declared score on Gate 4 — matched against the final records, and carried out in its own export (08-28 1f).

Decision Q5 (2026-09-30): a score is DECLARED on Gate 1 (free — the ``composite_swap`` rows, one per component)
and MATCHED on Gate 4 (one paid model call), against the concepts as the reviewer leaves them: scope, renames,
target picks and edits all applied. Matching on Gate 1 was never possible on a staged run — a run parked there
has concept groups but no assigned records — so Gate 1's panel promised a verdict that could not arrive.

Three pure pieces, no store and no request, so each is asserted directly:

* :func:`declared_scores` — the declarations, grouped by score, in the order they were DECLARED (each row's
  ``alternatives`` carries the whole list as typed, which is the paper's order; the artifact store's own order
  is by identity, i.e. alphabetical — live verify 3 H3).
* :func:`definition_for` — a declaration as core's ``ScoreDefinition``: names only. The declaration states no
  coding, kind or rule, so none is invented; core flags every unstated cutoff for review.
* :func:`score_export` — the ``score_json`` export: each declared score with its status, verdict and the full
  derived spec (per-component matches, per-cohort coverage, the derivation recipe). A score declared but not
  matched says so and carries ``indeterminate`` — never a negative verdict assembled from no evidence.

WHY A FILE OF ITS OWN, not a key on the records JSON: a score is RUN-level (one verdict and one recipe across
many concepts), while ``records_json`` is a bare array of per-concept records that consumers index into.
Putting the score there would either change that file's top-level shape or copy the score onto every record;
a separate file changes nothing that already ships.

AND ITS FREE HALF ON GATE 1 (08-28 Decision 6, option A). Because the match moved to Gate 4, Gate 1 had nothing to
seed its score-scoped default from. :func:`gate1_suggestions` runs ONLY core's retrieval half (``suggest_groups``:
no judge, $0) for each declaration, against the groups as the reviewer currently has them, and returns each reached
group with the dense cosine of its best member and core's calibrated cut-off. These are SUGGESTIONS for scoping;
the verdict is still Gate 4's.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from backend.artifact_kinds import COMPOSITE, COMPOSITE_SWAP

#: The file's own statement of what it is, carried IN the file so it survives being forwarded without the app.
EXPORT_NOTE = (
    "A recipe, not a computed score. Presence is per data dictionary: it says a cohort records a variable, "
    "not how many participants have a value for it. ddharmon never computes the score — run the derivation "
    "on your own rows. Partial coverage is not the published score."
)


def declared_scores(grouped: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """``[{"scoreName", "components"}]`` — every score the caller declared, components in declared order.

    Order within a score: first appearance across the rows' ``alternatives`` (the list as it was declared),
    restricted to components that still have a row; a component no ``alternatives`` list names follows in the
    store's order. Scores appear in the order their first row does.
    """
    rows = [r for r in (grouped or {}).get(COMPOSITE_SWAP) or [] if isinstance(r, Mapping)]
    by_score: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        score = str(row.get("scoreName") or "").strip()
        if score and str(row.get("componentName") or "").strip():
            by_score.setdefault(score, []).append(row)

    out: list[dict[str, Any]] = []
    for score, score_rows in by_score.items():
        present = {str(r["componentName"]).strip() for r in score_rows}
        ordered: list[str] = []
        for r in score_rows:
            for name in r.get("alternatives") or []:
                name = str(name).strip()
                if name in present and name not in ordered:
                    ordered.append(name)
        for r in score_rows:
            name = str(r["componentName"]).strip()
            if name not in ordered:
                ordered.append(name)
        out.append({"scoreName": score, "components": ordered})
    return out


def find_declared(grouped: Mapping[str, Any] | None, score_name: str) -> dict[str, Any] | None:
    """The declaration named ``score_name`` (exact, surrounding whitespace ignored), or ``None``."""
    wanted = (score_name or "").strip()
    return next((s for s in declared_scores(grouped) if s["scoreName"] == wanted), None)


def definition_for(declared: Mapping[str, Any]) -> Any:
    """A declaration as core's ``ScoreDefinition``: the declared names, every one required, nothing invented.

    ``required=True`` for each, as the re-derive path defaults: the reviewer named these as the score's
    components, so a missing one is a gap in the score (``partial``), not an optional extra.
    """
    from ddharmon.harmonization.composite import (
        CodingKind,
        ComponentCoding,
        CompositeKind,
        ScoreComponent,
        ScoreDefinition,
    )

    return ScoreDefinition(
        name=str(declared["scoreName"]),
        kind=CompositeKind.CUSTOM,
        components=[
            ScoreComponent(name=name, definition="", required=True, coding=ComponentCoding(kind=CodingKind.UNSTATED))
            for name in declared["components"]
        ],
    )


def scoped_field_index(
    field_index: Mapping[str, Any] | None, records: Iterable[Mapping[str, Any]]
) -> dict[str, Any] | None:
    """The run's field index cut to the members of ``records`` — the variable-level matching corpus.

    Variable-level matching indexes every variable in the field index and rolls each rated one up to its group;
    a variable of a group the reviewer scoped out has no group to roll up to, so it is dropped AFTER it has
    taken one of a component's shortlist slots. Cutting the index to the final records' members keeps the
    closed world the reviewer's, and the prompt no larger than it needs to be.
    """
    if not field_index:
        return None
    members = {str(m) for r in records for m in (r.get("members") or [])}
    return {k: v for k, v in field_index.items() if k in members}


def gate1_suggestions(
    declared: Iterable[Mapping[str, Any]],
    field_index: Mapping[str, Any] | None,
    membership: Mapping[str, Sequence[str]],
    *,
    embed: Any | None,
) -> dict[str, Any]:
    """Gate 1's score suggestions: for each declaration, the groups each component's FREE search reached.

    ``membership`` is Gate 1's effective grouping (``{groupId: [variable ids]}``, moves and New groups applied);
    ``embed`` is the run's cache-backed embedder, or ``None`` when no dense encoder is available — core then
    returns no suggestions and says why, because a lexical score is not comparable across components and is never
    thresholded. Pure: no store, no request, no model call. ``billedUsd`` is always 0 — nothing here is paid for.

    ``{"scored", "scoreKind", "threshold", "reason", "billedUsd", "scores": [{"scoreName", "components":
    [{"component", "groups": [{"groupId", "score", "bestMember", "bestOption"?}]}], "nVariablesIndexed"}]}``
    """
    from ddharmon.harmonization.composite import GATE1_SUGGEST_MIN_COSINE, suggest_groups, suggestions_to_dict

    payload: dict[str, Any] = {
        "scored": embed is not None,
        "scoreKind": "dense_cosine",
        "threshold": GATE1_SUGGEST_MIN_COSINE,
        "reason": "",
        "billedUsd": 0.0,
        "scores": [],
    }
    for declaration in declared:
        definition = definition_for(declaration)
        result = suggestions_to_dict(suggest_groups(definition.components, field_index or {}, membership, embed=embed))
        payload.update(scored=result["scored"], scoreKind=result["scoreKind"], threshold=result["threshold"])
        payload["reason"] = payload["reason"] or result["reason"]
        payload["scores"].append(
            {
                "scoreName": definition.name,
                "components": result["components"],
                "nVariablesIndexed": result["nVariablesIndexed"],
            }
        )
    return payload


def _spec_for(composites: Iterable[Mapping[str, Any]], score_name: str) -> dict[str, Any] | None:
    """The newest derived spec named ``score_name`` (case-insensitive — the ``composite`` kind's identity)."""
    wanted = score_name.strip().lower()
    found = None
    for spec in composites:
        name = str(((spec.get("definition") or {}) if isinstance(spec, Mapping) else {}).get("name") or "")
        if name.strip().lower() == wanted:
            found = dict(spec)
    return found


def score_export(grouped: Mapping[str, Any] | None) -> dict[str, Any]:
    """The ``score_json`` export: each declared score (then any derived score no declaration names).

    ``status`` is ``matched`` (a spec exists for it), ``declared`` (declared, not matched yet) or ``derived``
    (a spec derived from a document, with no declaration behind it). ``verdict`` is the spec's presentation
    verdict, or ``indeterminate`` when nothing was matched.
    """
    composites = [c for c in (grouped or {}).get(COMPOSITE) or [] if isinstance(c, Mapping)]
    scores: list[dict[str, Any]] = []
    named: set[str] = set()
    for declared in declared_scores(grouped):
        spec = _spec_for(composites, declared["scoreName"])
        named.add(declared["scoreName"].strip().lower())
        scores.append(_entry(declared["scoreName"], declared["components"], spec, "matched" if spec else "declared"))
    for spec in composites:
        name = str((spec.get("definition") or {}).get("name") or "")
        if name.strip().lower() in named:
            continue
        named.add(name.strip().lower())
        scores.append(_entry(name, [], _spec_for(composites, name), "derived"))
    return {"note": EXPORT_NOTE, "scores": scores}


def _entry(name: str, components: list[str], spec: Mapping[str, Any] | None, status: str) -> dict[str, Any]:
    verdict = str(((spec or {}).get("feasibility") or {}).get("verdict") or "indeterminate")
    return {
        "scoreName": name,
        "declaredComponents": list(components),
        "status": status,
        "verdict": verdict,
        "spec": dict(spec) if spec is not None else None,
    }


__all__ = [
    "EXPORT_NOTE",
    "declared_scores",
    "definition_for",
    "find_declared",
    "gate1_suggestions",
    "score_export",
    "scoped_field_index",
]
