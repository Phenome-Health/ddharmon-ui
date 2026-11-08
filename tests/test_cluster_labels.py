"""Keyword labels for a Preview run's Gate 1 rows: c-TF-IDF over each cluster's member text (08-31).

A Preview run calls no model, so nothing names its clusters. Core's own label (`derive_cluster_label`) counts the
most common words inside ONE cluster, so boilerplate every cluster shares wins: on run 7fafc83f six clusters were all
"Skip / Pattern / Selected". c-TF-IDF (BERTopic's class-based TF-IDF) weighs a term by how much it marks THIS cluster
out from the others, which is what tells a reviewer which rows to open. Measured on that run: 7 ms for 42 clusters.
"""

from __future__ import annotations

import time

from backend.engine.cluster_labels import keyword_labels

_DIABETES = [
    "Do you take pills to control your blood sugar? Reported at the baseline visit.",
    "Diabetes type 2 diagnosed by a doctor. Reported at the baseline visit.",
    "Fasting glucose and HbA1c for diabetes control. Reported at the baseline visit.",
]
_HEARING = [
    "Hearing impairment or deafness. Reported at the baseline visit.",
    "Do you use a hearing aid? Reported at the baseline visit.",
    "Difficulty hearing in a noisy room. Reported at the baseline visit.",
]
_EYES = [
    "Cataracts in one or both eyes. Reported at the baseline visit.",
    "Glaucoma diagnosed in either eye. Reported at the baseline visit.",
    "Macular degeneration of the eyes. Reported at the baseline visit.",
]


def _tokens(label: str) -> list[str]:
    return [t for term in label.split(" · ") for t in term.split()]


def test_each_cluster_is_labelled_by_what_sets_it_apart() -> None:
    labels = keyword_labels([_DIABETES, _HEARING, _EYES])
    assert len(labels) == 3
    assert "diabetes" in labels[0]
    assert "hearing" in labels[1]
    assert any(w in labels[2] for w in ("cataracts", "glaucoma", "eyes", "degeneration"))


def test_a_phrase_every_cluster_shares_does_not_win() -> None:
    # "Reported at the baseline visit" is in every member of every cluster: it says nothing about which cluster is
    # which. (Not a phrase core's text cleaner strips, so this tests the weighting, not the cleaner.)
    for label in keyword_labels([_DIABETES, _HEARING, _EYES]):
        for word in ("reported", "baseline", "visit"):
            assert word not in _tokens(label), label


def test_markup_never_reaches_a_label() -> None:
    styled = [f'<span style="font-weight:normal">{t}</span>' for t in _HEARING]
    labels = keyword_labels([_DIABETES, styled])
    for word in ("span", "style", "font", "weight", "normal"):
        assert word not in _tokens(labels[1])
    assert "hearing" in labels[1]


def test_top_terms_are_joined_and_never_repeat_a_word() -> None:
    labels = keyword_labels([_DIABETES, _HEARING, _EYES], top_n=3)
    for label in labels:
        terms = label.split(" · ")
        assert 1 <= len(terms) <= 3
        words = _tokens(label)
        assert len(words) == len(set(words)), label


def test_labels_do_not_depend_on_cluster_order() -> None:
    forward = keyword_labels([_DIABETES, _HEARING, _EYES])
    backward = keyword_labels([_EYES, _HEARING, _DIABETES])
    assert forward == list(reversed(backward))
    assert keyword_labels([_DIABETES, _HEARING, _EYES]) == forward


def test_a_single_cluster_still_gets_a_label() -> None:
    (label,) = keyword_labels([_HEARING])
    assert "hearing" in label


def test_a_cluster_with_no_words_falls_back_to_its_most_typical_member() -> None:
    # Codes only: no term survives tokenizing, so the label is the member text itself rather than nothing.
    codes = ["Q12", "Q12", "Q13"]
    labels = keyword_labels([_DIABETES, codes])
    assert labels[1] == "Q12"


def test_a_cluster_with_no_text_at_all_gets_an_empty_label() -> None:
    # Empty means "no label": the screen shows its own placeholder rather than an invented one.
    assert keyword_labels([_DIABETES, ["", "  "]])[1] == ""


def test_no_clusters_no_labels() -> None:
    assert keyword_labels([]) == []


def test_a_long_fallback_is_cut_to_a_label_length() -> None:
    long_code = "X" * 5 + "1" * 200
    (label,) = keyword_labels([[long_code]])
    assert 0 < len(label) <= 80


def test_a_thousand_clusters_label_in_well_under_two_seconds() -> None:
    clusters = [
        [f"measure{i} item{i % 7} reading", f"measure{i} value", f"measure{i} repeat item"] for i in range(1000)
    ]
    t0 = time.perf_counter()
    labels = keyword_labels(clusters)
    assert time.perf_counter() - t0 < 2.0
    assert len(labels) == 1000 and all(labels)
