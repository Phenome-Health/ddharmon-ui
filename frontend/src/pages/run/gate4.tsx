import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { AUTH_ENABLED, useAuthState } from "@/auth";
import { GateShell } from "@/components/gate/GateShell";
import { GuestAuthNotice } from "@/components/gate/SandboxBanner";
import { useSandboxCount } from "@/hooks/use-sandbox-count";
import { demoExportNote } from "@/lib/sandbox";
import { ArtifactTile } from "@/components/gate/ArtifactTile";
import { CommitBar } from "@/components/gate/CommitBar";
import { DecisionLog } from "@/components/gate/DecisionLog";
import { Gate4ScorePanel } from "@/components/gate/Gate4ScorePanel";
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
  unassignedBreakdown,
  verdictBreakdown,
} from "@/lib/gate4";
import { SCORE_ARTIFACT, declaredScores, scoreExport, specForScore } from "@/lib/score-match";
import type { CompositeSpec } from "@/types";

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

  // THE DECLARED SCORE (08-28 1f, decision Q5): declared on Gate 1, matched HERE against the final records.
  // The declaration is read from the decision index (every kind, `gate.all`) — a record on this screen, never
  // written. A match is held locally the moment it returns and the run's stored composites are refetched.
  const queryClient = useQueryClient();
  const pinned = resolvePinned(jobState?.config);
  const scores = useMemo(() => declaredScores(gate.all), [gate.all]);
  const [matched, setMatched] = useState<Record<string, CompositeSpec>>({});
  const composites = useMemo(
    () => [...(jobState?.composites ?? []), ...Object.values(matched)],
    [jobState?.composites, matched],
  );
  // The score file rides the export set only on a run that carries a score — declared (even unmatched: the
  // file then says so) or derived. Otherwise the set is exactly the shipping four.
  const artifacts = useMemo(
    () => (scores.length > 0 || composites.length > 0 ? [...REAL_ARTIFACTS, SCORE_ARTIFACT] : REAL_ARTIFACTS),
    [scores.length, composites.length],
  );

  // A finished run has produced every serialization; a run still streaming has not. There is no per-format
  // build-failure signal for these five formats (they are serialization, not builds), so the page derives
  // ready/generating from run state — the `failed` claim exists in `ArtifactTile` for when a signal appears.
  const artifactState: ArtifactState = records.length > 0 ? "ready" : "generating";

  const isSelected = (id: string) => artifactState === "ready" && !deselected.has(id);
  const selectedArtifacts = useMemo(
    () => artifacts.filter((a) => artifactState === "ready" && !deselected.has(a.id)),
    [artifacts, deselected, artifactState],
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

  // THE SHARED DEMO (08-18). A guest cannot download at all — the export route is not on the guest surface, so
  // the bar says so specifically instead of handing them a 401 as a file. Anyone on the demo who holds edits is
  // told the files leave them out: the previews below read this tab, the download reads the demo's own row.
  const { isGuest } = useAuthState();
  const guestLocked = AUTH_ENABLED && isGuest;
  const held = useSandboxCount(jobId);
  const exportNote = pinned === true ? demoExportNote(held) : null;

  const breakdown = verdictBreakdown(result);
  // F21: the variables no artifact carries, split by WHY — scoped out at Gate 1 is the reviewer's choice, not a
  // concept the pipeline failed to form (live 6c66731c: "506 reached no concept", 497 of them scoped out).
  const unassigned = unassignedBreakdown(
    result,
    jobState?.config as Record<string, unknown> | undefined,
    gate.all.gate1_group_scope,
  );
  const unassignedCount = unassigned.scopedOut + unassigned.noConcept;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const filenameFor = (a: RealArtifact) => (a.id === "notebook" ? `harmonization.${lang}.ipynb` : a.filename);

  return (
    <GateShell
      gate="gate4"
      jobId={jobId}
      subhead="Choose what to take away, check it before it goes, and read the decision trail behind it. Downloading is free."
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

        {/* The declared score, matched here (Q5) — before the export set, because the match is what fills the
            score file's verdict and recipe. Absent when no score was declared. */}
        {scores.map((score) => (
          <Gate4ScorePanel
            key={score.scoreName}
            jobId={jobId}
            score={score}
            spec={specForScore(composites, score.scoreName)}
            pinned={pinned === true}
            onMatched={(spec) => {
              setMatched((prev) => ({ ...prev, [score.scoreName]: spec }));
              void queryClient.invalidateQueries({ queryKey: ["harmonize-result", jobId] });
            }}
          />
        ))}

        {/* Surface 2 — what ships: the real artifacts, then the honest gaps. */}
        <section className="flex flex-col gap-3" data-testid="export-set">
          <h2 className="text-sm font-semibold text-on-field">What leaves the tool</h2>
          {artifacts.map((a) => (
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
          <p
            data-testid="unassigned-summary"
            data-no-concept={unassigned.noConcept}
            data-scoped-out={unassigned.scopedOut}
            className="text-xs text-on-field-muted"
          >
            {unassigned.noConcept > 0 && (
              <>
                <span className="font-semibold text-on-field">
                  {plural(unassigned.noConcept, "variable", "variables")}
                </span>{" "}
                reached no concept.{" "}
              </>
            )}
            {unassigned.scopedOut > 0 && (
              <>
                <span className="font-semibold text-on-field">
                  {plural(unassigned.scopedOut, "variable was", "variables were")}
                </span>{" "}
                in groups you scoped out at Gate 1.{" "}
              </>
            )}
            They are not represented in these artifacts and are not part of the mapping — they are listed on the
            results view so the export never silently omits them.
          </p>
        )}

        {/* Surface 4 — the in-app decision log, with the E3 revision rate. */}
        <DecisionLog
          index={gate.all}
          result={result}
          coreVersion={coreVersion}
          config={jobState?.config as Record<string, unknown> | undefined}
          verdicts={jobState?.decisions}
        />

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
        disabled={selectedCount === 0 || guestLocked}
        recheckNotice={
          guestLocked || exportNote ? (
            <span className="flex flex-col gap-1">
              {guestLocked && <GuestAuthNotice action="downloading the export" />}
              {exportNote && <span data-testid="demo-export-note">{exportNote}</span>}
            </span>
          ) : undefined
        }
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
              {preview.id === "score_json"
                ? JSON.stringify(scoreExport(scores, composites), null, 2)
                : previewFor(preview.id, lang, result, jobState?.decisions, {
                    index: gate.all,
                    config: jobState?.config as Record<string, unknown> | undefined,
                    gatePosition: jobState?.gatePosition,
                  })}
            </pre>
          )}
        </SheetContent>
      </Sheet>
    </GateShell>
  );
}
