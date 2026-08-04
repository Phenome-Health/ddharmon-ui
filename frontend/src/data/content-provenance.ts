// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONTENT PROVENANCE — when was this page's hand-authored content last checked against the pipeline?
//
// The UI is a touchpoint for the ddharmon pipeline, and the public content pages (Methods,
// Benchmarks, Design, Roadmap) restate pipeline facts as prose. Some of those facts are DERIVABLE
// in-repo and are enforced mechanically by `tests/test_content_drift.py` (stage list, phase order,
// demo phase list). The rest — benchmark numbers grounded in the canonical `docs/methods.md §3`,
// design rationale, roadmap status — cannot be asserted from code. They can only be *re-read* by a
// human against the current pipeline.
//
// A stamp does not make that content correct. It makes its age VISIBLE: "these numbers were last
// checked against core X / contract N". Silent staleness becomes a dated claim you can act on, which
// is the whole problem — the `gencde` stage sat undocumented on prod for months because nothing
// anywhere recorded that the Methods page had not been re-read since M12.
//
// WHEN TO RE-STAMP: after re-reading the manifest's content against the pipeline it now describes —
// not as a reflex to make a check go green. Bumping the stamp without re-reading is worse than a
// stale stamp, because it launders an unverified claim as a verified one.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ContentProvenance {
  /** Short commit of canonical `Phenome-Health/ddharmon` the content was last checked against. */
  coreCommit: string;
  /** `CONTRACT_VERSION` (backend/engine/contract.py) at the time of that check. */
  contractVersion: string;
  /** ISO date of the check — the human-legible half; the machine checks the two fields above. */
  checkedOn: string;
  /** What was actually re-read, so a later reader knows the check's scope rather than guessing. */
  scope: string;
}
