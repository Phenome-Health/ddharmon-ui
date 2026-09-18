import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { ArtifactTile } from "@/components/gate/ArtifactTile";
import { CommitBar } from "@/components/gate/CommitBar";
import { DecisionLog } from "@/components/gate/DecisionLog";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { NotAvailable } from "@/components/gate/NotAvailable";
import { ReproducibilityInfo } from "@/components/gate/ReproducibilityInfo";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { resolvePinned, useGateDecisions } from "@/hooks/use-gate-decisions";
import { exportUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  NOT_AVAILABLE_GAPS,
  REAL_ARTIFACTS,
  type ArtifactState,
  type NotebookLang,
  type RealArtifact,
  downloadLabel,
  previewFor,
  resolveFormat,
  verdictBreakdown,
} from "@/lib/gate4";

/**
 * Gate 4 — Export — the staged review flow's sixth and terminal screen (08-17, STGD-15 / R15).
 *
 * The reviewer chooses what leaves the tool, checks it before it leaves, and — for the first time — reads
 * the decision trail that justifies it. It is the terminal half of the phase goal's "so that I can defend
 * the mappings I export", and it is where the honest-absence rules bite hardest: FIVE export formats ship,
 * the design draws more, and the difference is rendered as three "not available" tiles rather than quietly
 * dropped (UI-SPEC §0.2, §9). It costs nothing — pure read and serialization.
 *
 * SCOPE (frontend-only, per the 2026-09-17 amendment): the export set with real previews, the three honest
 * gaps and two limitations, the in-app decision log with the E3 revision-rate, the lifted reproducibility
 * disclosure, and the terminal next-actions (analysis ideas, run again). No backend change.
 */
export default function Gate4Page() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState, cancel } = useHarmonizeStream(jobId, true, true);
  const result = jobState?.result ?? null;
  const records = result?.records ?? [];
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;
  const coreVersion = jobState?.coreVersion;

  // The decision log reads EVERY kind's decisions (`all`); the requested kind only names which sandbox key
  // this hook writes, and Gate 4 writes none of them (artifact selection is ephemeral UI state, not a
  // persisted gate decision — the `gate4_export_selection` kind is per-record inclusion, a different thing).
  const gate = useGateDecisions(jobId, "gate4_export_selection", {
    pinned: resolvePinned(jobState?.config),
  });

  const [lang, setLang] = useState<NotebookLang>("py");
  // Every ready artifact is selected by default: the terminal, free action is "take my work away", so the
  // deliberate act is opting one OUT, not opting each one in.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<RealArtifact | null>(null);

  // A finished run has produced every serialization; a run still streaming has not. There is no per-format
  // build-failure signal for these five formats (they are serialization, not builds), so the page derives
  // ready/generating from run state — the `failed` claim exists in `ArtifactTile` for when a signal appears.
  const artifactState: ArtifactState = records.length > 0 ? "ready" : "generating";

  const isSelected = (id: string) => artifactState === "ready" && !deselected.has(id);
  const selectedArtifacts = useMemo(
    () => REAL_ARTIFACTS.filter((a) => artifactState === "ready" && !deselected.has(a.id)),
    [deselected, artifactState],
  );
  const selectedCount = selectedArtifacts.length;

  const toggle = (id: string) =>
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const download = () => {
    for (const a of selectedArtifacts) {
      const url = exportUrl(jobId, resolveFormat(a.id, lang));
      const el = document.createElement("a");
      el.href = url;
      el.rel = "noopener";
      el.download = "";
      document.body.appendChild(el);
      el.click();
      el.remove();
    }
  };

  const breakdown = verdictBreakdown(result);
  const unassignedCount = result?.unassignedFields?.length ?? 0;
  const filenameFor = (a: RealArtifact) => (a.id === "notebook" ? `harmonization.${lang}.ipynb` : a.filename);

  return (
    <GateShell
      gate="gate4"
      jobId={jobId}
      subhead="Choose what to take away, check it before it goes, and read the decision trail behind it. Downloading is free."
      rail={railFor("gate4", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      job={jobState}
      onStop={cancel}
      resumed={jobState?.status === "awaiting_review" && jobState?.gatePosition === "gate4"}
    >
      <div className="flex flex-col gap-6">
        {/* Surface 1 — notebook language, + the lifted reproducibility disclosure. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3" data-testid="notebook-language">
            <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">Notebook language</span>
            <div className="inline-flex rounded-inner border border-rule-on-field p-0.5">
              {(["py", "r"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  data-testid={`notebook-lang-${l}`}
                  data-active={String(lang === l)}
                  onClick={() => setLang(l)}
                  className={cn(
                    "rounded-inner px-3 py-1 text-sm font-semibold",
                    lang === l ? "bg-surface-raised text-on-raised shadow-card" : "text-on-field-muted",
                  )}
                >
                  {l === "py" ? "Python" : "R"}
                </button>
              ))}
            </div>
          </div>
          <ReproducibilityInfo coreVersion={coreVersion} />
        </div>

        {/* Surface 2 — what ships: the real artifacts, then the honest gaps. */}
        <section className="flex flex-col gap-3" data-testid="export-set">
          <h2 className="text-sm font-semibold text-on-field">What leaves the tool</h2>
          {REAL_ARTIFACTS.map((a) => (
            <ArtifactTile
              key={a.id}
              slug={a.id}
              name={a.name}
              description={a.description}
              filename={filenameFor(a)}
              state={artifactState}
              selected={isSelected(a.id)}
              onToggle={() => toggle(a.id)}
              onPreview={() => setPreview(a)}
              assurance={
                a.id === "notebook"
                  ? "The notebook runs where your data already lives. Your data never enters ddharmon."
                  : undefined
              }
            >
              {a.id === "eitl_tsv" && (
                // Surface 3 — the review campaign the EITL file produces, only when it is selected.
                <div
                  data-testid="review-campaigns"
                  className="flex flex-col gap-1 border-t border-rule-on-raised pt-2 text-xs text-on-raised-muted"
                >
                  <p className="font-semibold text-on-raised">The review campaign this produces</p>
                  <p>
                    <span className="font-mono">{a.filename}</span> — {breakdown.total}{" "}
                    {breakdown.total === 1 ? "concept" : "concepts"} for expert sign-off ({breakdown.adopt} adopt,{" "}
                    {breakdown.refine} refine, {breakdown.novel} novel).
                  </p>
                </div>
              )}
            </ArtifactTile>
          ))}

          {NOT_AVAILABLE_GAPS.map((g) => (
            <NotAvailable key={g.slug} slug={g.slug} thing={g.thing} claim="deferred">
              {g.body}
            </NotAvailable>
          ))}
        </section>

        {/* The two stated limitations — notes, not hidden (UI-SPEC §0.2 "Explicitly OUT"). */}
        <ul data-testid="export-limitations" className="flex flex-col gap-1 text-xs text-on-field-muted">
          <li>Export is per format — there is no subsetting of records within a single format.</li>
          <li>Review campaigns download as files and are uploaded to the expert-review app by hand.</li>
        </ul>

        {/* Adapt UnassignedRow — the no-concept population, made visible rather than silently omitted. */}
        {unassignedCount > 0 && (
          <p data-testid="unassigned-summary" className="text-xs text-on-field-muted">
            <span className="font-semibold text-on-field">{unassignedCount}</span>{" "}
            {unassignedCount === 1 ? "variable" : "variables"} reached no concept and are not represented in these
            artifacts. They are not part of the mapping — they are listed on the results view so the export never
            silently omits them.
          </p>
        )}

        {/* Surface 4 — the in-app decision log, with the E3 revision rate. */}
        <DecisionLog index={gate.all} result={result} coreVersion={coreVersion} />

        {/* Terminal next-actions: analysis ideas (Task 4, existing route) and run again (Task 5). */}
        <div data-testid="gate4-next-actions" className="flex flex-wrap items-center gap-4 text-sm">
          <Link
            href={`/job/${jobId}/analysis`}
            data-testid="analysis-ideas-link"
            className="font-semibold text-link-on-field underline underline-offset-2"
          >
            Explore analysis ideas for this run →
          </Link>
          <Link
            href="/run/new/setup"
            data-testid="rerun-action"
            className="font-semibold text-link-on-field underline underline-offset-2"
          >
            Run again with new dictionaries →
          </Link>
        </div>

        {selectedCount === 0 && (
          <GateEmptyState heading="No artifacts selected" nextStep="Tick at least one artifact above to download.">
            Nothing is currently selected, so there is nothing to download.
          </GateEmptyState>
        )}
      </div>

      {/* Surface 5 — commit bar: free download of the selected artifacts, with the participant-data assurance. */}
      <CommitBar
        action={downloadLabel(selectedCount)}
        actionTestId="download-artifacts"
        onCommit={download}
        disabled={selectedCount === 0}
        assurance="Nothing here contains participant data. Every file is metadata, a decision, or code."
        className="mt-6"
      />

      {/* The preview drawer — real generated content at the wider width, not a description of it. */}
      <Sheet open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{preview?.name ?? "Preview"}</SheetTitle>
          </SheetHeader>
          {preview && (
            <pre
              data-testid="artifact-preview-content"
              className="mt-4 max-h-[calc(100vh-8rem)] overflow-auto whitespace-pre-wrap break-words rounded-inner bg-surface-inset p-4 font-mono text-xs text-on-inset"
            >
              {previewFor(preview.id, lang, result, jobState?.decisions)}
            </pre>
          )}
        </SheetContent>
      </Sheet>
    </GateShell>
  );
}
