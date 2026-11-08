"""Keyword labels for clusters no model named — c-TF-IDF over each cluster's member text (08-31).

A Preview run calls no model, so its Gate 1 rows have no generated name. They get BERTopic's own topic-naming
approach instead: class-based TF-IDF, which treats each cluster as one document and weighs a term by how much it marks
THAT cluster out from the rest. Core's cluster label (`ddharmon.clustering.labeling.derive_cluster_label`) counts words
inside one cluster only, so boilerplate every cluster shares wins it — on run 7fafc83f six clusters were all
"Skip / Pattern / Selected", which c-TF-IDF tells apart ("immunotherapy · cancer type · chemotherapy",
"hearing · difficulty · aid", "fall · injury sustained").

COMPUTED HERE, NOT IN CORE: a frozen-substrate replay never re-fits BERTopic, so a label kept on the fitted model would
differ between a fresh run and its replay; this one is a pure function of the member text. Core's label is left alone
because it may feed prompts.

A cut-off that drops terms found in more than 20% of clusters was tried on 7fafc83f and NOT adopted: it emptied one
label and swapped "currently prescribed" for "ptsd currently" on another.

COST: no model, no money; 7 ms for 42 clusters. Importing ``bertopic.vectorizers`` loads the whole package (~5 s cold),
so it is imported inside the call — a Preview run has already loaded it to cluster, so in practice it is warm.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Sequence

# Markup first, generically: AoU's labels carry inline <span style=...>, which otherwise surfaces as "font weight".
_MARKUP_RE = re.compile(r"<[^>]+>")
# Words of two or more letters. Codes ("Q12"), numbers and units-with-digits are not words a reviewer scans for.
_TOKEN_PATTERN = r"(?u)\b[a-zA-Z][a-zA-Z]+\b"
_TERM_SEPARATOR = " · "
# A fallback label is a member's own text; a label is read in a row, so it is cut rather than wrapped.
_FALLBACK_MAX_CHARS = 80


def _clean(text: str) -> str:
    from ddharmon.text_hygiene import clean_field_text

    return clean_field_text(_MARKUP_RE.sub(" ", text or ""))


def _cut(text: str) -> str:
    return text if len(text) <= _FALLBACK_MAX_CHARS else text[: _FALLBACK_MAX_CHARS - 1].rstrip() + "…"


def _most_typical_member(texts: list[str], weight_of: dict[str, float]) -> str:
    """The member that best carries its cluster's weighted terms — BERTopic's representative-document idea.

    With no weighted terms at all (codes only), the most frequent text; ties go to the first seen, so the answer
    follows the clustering's own member order and never the run's.
    """
    present = [t for t in texts if t]
    if not present:
        return ""
    if weight_of:
        scored = [
            (sum(weight_of.get(w, 0.0) for w in re.findall(_TOKEN_PATTERN, t.lower())), i)
            for i, t in enumerate(present)
        ]
        best_score, best_i = max(scored, key=lambda s: (s[0], -s[1]))
        if best_score > 0:
            return _cut(present[best_i])
    return _cut(Counter(present).most_common(1)[0][0])


def keyword_labels(clusters: Sequence[Sequence[str]], *, top_n: int = 3) -> list[str]:
    """One label per cluster, in the order given: its ``top_n`` most distinctive terms joined with " · ".

    ``clusters`` holds each cluster's member texts. Terms are English 1–2-grams with stop words removed; a term that
    shares a word with one already chosen is skipped, so "diabetes · diabetes control" never happens. A cluster with
    no distinctive term falls back to its most typical member's text; a cluster with no text at all gets ``""``,
    which the screen renders as its own placeholder rather than an invented name.
    """
    if not clusters:
        return []
    from sklearn.feature_extraction.text import CountVectorizer

    cleaned = [[_clean(t) for t in members] for members in clusters]
    docs = [" ".join(members) for members in cleaned]
    vectorizer = CountVectorizer(stop_words="english", ngram_range=(1, 2), token_pattern=_TOKEN_PATTERN)
    try:
        counts = vectorizer.fit_transform(docs)
    except ValueError:  # no word anywhere ("empty vocabulary"): every cluster falls back to its own text
        return [_most_typical_member(members, {}) for members in cleaned]

    from bertopic.vectorizers import ClassTfidfTransformer

    weights = ClassTfidfTransformer(reduce_frequent_words=True).fit_transform(counts).tocsr()
    vocab = vectorizer.get_feature_names_out()
    labels: list[str] = []
    for i, members in enumerate(cleaned):
        row = weights.getrow(i)
        # Rounded before ranking, and ties broken by the term itself, so cluster ORDER can never change a label
        # through floating-point summation order.
        ranked = sorted(
            ((round(float(w), 12), str(vocab[j])) for j, w in zip(row.indices, row.data, strict=True) if w > 0),
            key=lambda tw: (-tw[0], tw[1]),
        )
        chosen: list[str] = []
        used: set[str] = set()
        for _, term in ranked:
            words = set(term.split())
            if words & used:
                continue
            chosen.append(term)
            used |= words
            if len(chosen) == top_n:
                break
        if chosen:
            labels.append(_TERM_SEPARATOR.join(chosen))
        else:
            weight_of = {term: w for w, term in ranked if " " not in term}
            labels.append(_most_typical_member(members, weight_of))
    return labels
