import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { DictionaryMappingTable } from "@/components/gate/DictionaryMappingTable";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { extractScoreDocument, listDemos } from "@/lib/api";
import { estimateRunCostBreakdown, formatUsd } from "@/lib/estimate";
import { SCOPE_VERDICT_COPY, declaredComponents, setupScopeVerdict } from "@/lib/score-scope";
import { participantLevelColumn, type DictRow } from "@/lib/dictionary";
import { lookupPrefill } from "@/lib/column-prefill";
import { COLUMN_ROLES } from "@/types";
import demoManifest from "@/data/demo-column-assignments.json";
import { GATE_LABELS } from "@/components/gate/GateRail";
import type { CdeSet, GatePosition, JobResult, RunMode } from "@/types";

/**
 * Set up — the first of the six staged-review screens (08-13).
 *
 * WHAT THIS SCREEN IS FOR. Setup is where the phase's central promise is made concrete: everything up to
 * and including Gate 0's review is local, so nothing is charged yet, and the figure quoted here is the one
 * the reviewer consents to. Every other element on the screen exists to stop something being lost or
 * misstated before that consent is given.
 *
 * TWO HAZARDS ARE SURFACED RATHER THAN SWALLOWED:
 *
 *  1. **A repeated variable name is a silent last-wins drop.** `load_dictionary` keys on the variable-name
 *     column and the last row with a repeated name wins, so the earlier ones vanish with no warning — the
 *     run completes and the counts look plausible. It has cost real debugging time in this project, so the
 *     row count and the unique-name count are both shown, per file, before the run starts.
 *  2. **One dictionary is CDE-mapping, not harmonization.** Harmonization is cross-dictionary pooling; a
 *     single dictionary against the CDE backbone is a different, narrower job. Saying so beats proceeding
 *     as though the two were the same thing.
 *
 * ONE LAYOUT, TWO SOURCES OF DICTIONARIES. A run that does not exist yet is COMPOSED here (drop files, map
 * their columns). A run that already exists is READ BACK here from its own record, with the controls
 * disabled and the reason named on the start action. One layout rather than two, because a second layout
 * is a second set of empty states, error states and overflow behaviours to keep honest.
 *
 * WHAT A RUN-SEEDED DICTIONARY CANNOT SAY. The source file is not kept with the run, so the unique-name
 * count is genuinely unknown for one. It renders as not-available WITH THE REASON — never as "all names
 * unique", which is a claim the run record cannot support (P8-D3).
 */

// --- the file model ------------------------------------------------------------------------------------

type ParseState = "parsing" | "ready";

interface SetupDict {
  /** Stable identity for React and for removal. */
  key: string;
  filename: string;
  cohortName: string;
  headers: string[];
  /** Parsed rows — present only for a file read in this browser. Null for a run-seeded dictionary. */
  rows: DictRow[] | null;
  /** Rows in the source file, for a file read in this browser. Null for a run-seeded dictionary. */
  rowCount: number | null;
  /**
   * The demo dataset this dictionary came from, when it did. Its variable count is DERIVED from the demo
   * catalogue at render rather than stored here: the catalogue is fetched, so storing the count would bake
   * in whatever was known at seed time and a later edit would freeze it as unknown forever.
   */
  datasetId?: string;
  /** role -> source column. */
  roles: Record<string, string>;
  state: ParseState;
  origin: "run" | "upload";
}

/** A file that never became a dictionary, and why. Rendered problem-then-next-step (UI-SPEC §8.4). */
interface FileProblem {
  key: string;
  filename: string;
  kind: "participant-level" | "unreadable" | "no-rows";
  detail: string;
}

interface DemoEntry {
  cohort: string;
  filename: string;
  signature: string;
  roles: Record<string, string>;
}
const DEMO_ENTRIES = (demoManifest as { entries: DemoEntry[] }).entries;

/** Fold a cohort id or display name to one comparable token: `aireadi` and `AI-READI` are the same cohort. */
const foldCohort = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Recover a demo dictionary's source columns from the shipped column-assignment manifest.
 *
 * The manifest's `signature` is the file's headers lowercased and sorted (it exists to recognise a file by
 * its shape), so it carries the column SET but not each name's original casing. The `roles` map does carry
 * the original casing for every mapped column, so the two together reconstruct the real header list. An
 * unmapped column keeps its folded form — visibly lowercase, which is honest about where it came from,
 * rather than a guessed capitalisation.
 */
function headersFromManifest(entry: DemoEntry): string[] {
  const originalByFolded = new Map(Object.values(entry.roles).map((c) => [c.toLowerCase(), c]));
  return entry.signature.split("|").map((folded) => originalByFolded.get(folded) ?? folded);
}

/**
 * The dictionaries a run was set up with, read from the run's OWN record.
 *
 * Two shapes, because two kinds of run exist. A run started from the New Run form persists
 * `config.dictionaries` (filename, cohort, column roles). The shipped demo run persists only its dataset
 * ids, so its dictionaries are recovered from the manifest that produced them plus the demo catalogue's
 * own field counts — both shipped provenance, neither invented here.
 */
function dictionariesFromRun(job: JobResult | null): SetupDict[] {
  const config = (job?.config ?? {}) as Record<string, unknown>;
  const declared = config.dictionaries;
  if (Array.isArray(declared) && declared.length) {
    return declared.map((d, i) => {
      const spec = d as { filename?: string; cohortName?: string; columnRoles?: Record<string, string> };
      const roles = spec.columnRoles ?? {};
      return {
        key: `run:${i}`,
        filename: spec.filename ?? `dictionary ${i + 1}`,
        cohortName: spec.cohortName ?? `cohort ${i + 1}`,
        // Only the columns the run actually used are recorded. That is a partial view of the file and is
        // the whole of what the record knows — the alternative is inventing the ones it does not.
        headers: Object.values(roles),
        rows: null,
        rowCount: null,
        roles,
        state: "ready" as ParseState,
        origin: "run" as const,
      };
    });
  }
  const datasets = Array.isArray(config.datasets) ? (config.datasets as string[]) : [];
  const runCohorts = job?.result?.summary?.cohorts ?? [];
  return datasets.flatMap((id, i) => {
    const entry = DEMO_ENTRIES.find((e) => foldCohort(e.cohort) === foldCohort(id));
    if (!entry) return [];
    const cohortName = runCohorts.find((c) => foldCohort(c) === foldCohort(id)) ?? id;
    return [
      {
        key: `run:${id}:${i}`,
        filename: entry.filename,
        cohortName,
        headers: headersFromManifest(entry),
        rows: null,
        rowCount: null,
        datasetId: id,
        roles: { ...entry.roles },
        state: "ready" as ParseState,
        origin: "run" as const,
      },
    ];
  });
}

/**
 * The starting column mapping for a freshly parsed file.
 *
 * Two sources, in order, and NEITHER of them is a guess about meaning:
 *
 *  1. The shipped/remembered mapping for a file with exactly these columns (`lookupPrefill` — the demo
 *     manifest, or this browser's own last-used assignment for the same header set).
 *  2. Failing that, columns whose name IS a role name, case-insensitively. `variable_name` -> the variable
 *     name is an identity, not an inference, and it is the same identity the demo manifest encodes.
 *
 * This matters more than convenience: the row-count against unique-name-count check cannot run until a
 * variable-name column is mapped, and a hazard check that must be configured before it works is one the
 * person who needed it will never see. Every assignment stays editable.
 */
function initialRoles(headers: string[]): Record<string, string> {
  const prefilled = lookupPrefill(headers);
  if (prefilled) return prefilled.roles;
  const byFolded = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  const roles: Record<string, string> = {};
  for (const role of COLUMN_ROLES) {
    const column = byFolded.get(role);
    if (column) roles[role] = column;
  }
  return roles;
}

/** At least one meaning-bearing column, which is the pipeline's real requirement (not any single role). */
const MEANING_ROLES = ["description", "question_text", "variable_name"] as const;
const hasMeaning = (roles: Record<string, string>): boolean => MEANING_ROLES.some((r) => Boolean(roles[r]));

// --- the screen ----------------------------------------------------------------------------------------

export default function SetupPage() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const { jobState } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  const [dicts, setDicts] = useState<SetupDict[]>([]);
  const [problems, setProblems] = useState<FileProblem[]>([]);

  // --- run configuration. Same vocabulary as the shipped New Run form, so a run described here and a run
  // described there are the same object. `conceptGate` is the one addition (STGD-16) and defaults OFF.
  const [cdeSet, setCdeSet] = useState<CdeSet>("endorsed");
  const [runMode, setRunMode] = useState<RunMode>("batch");
  const [genSpecs, setGenSpecs] = useState(true);
  const [suggestIdeas, setSuggestIdeas] = useState(true);
  const [conceptGate, setConceptGate] = useState(false);
  const [displayName, setDisplayName] = useState("");
  // BYOK: component memory only. Never persisted, never echoed back, cleared on reload.
  const [apiKey, setApiKey] = useState("");
  const [scoreText, setScoreText] = useState("");
  const [scoreDoc, setScoreDoc] = useState<{ provenance: string; nChars: number } | null>(null);
  const [scoreDocError, setScoreDocError] = useState("");
  /** True once the reviewer has touched the dictionary list, so a late run frame cannot overwrite it. */
  const composed = useRef(false);

  // The demo catalogue's own field counts, used only to size a run-seeded demo dictionary. Static-safe.
  const { data: demos } = useQuery({ queryKey: ["demos"], queryFn: listDemos, staleTime: Infinity });
  const fieldsByDataset = useMemo(
    () => Object.fromEntries((demos?.datasets ?? []).map((d) => [d.id, d.nFields])),
    [demos],
  );

  /**
   * Seed from the run, ONCE, and never over an edit. A run frame can arrive after the reviewer has already
   * dropped a file (the stream settles asynchronously), and replacing their work with the run's record at
   * that point would silently discard it.
   */
  useEffect(() => {
    if (composed.current) return;
    const seeded = dictionariesFromRun(jobState);
    if (seeded.length) setDicts(seeded);
  }, [jobState]);

  /**
   * One dictionary's variable count, or null when it is not knowable YET or not knowable at all.
   *
   * An uploaded file knows its own row count. A demo dictionary's count comes from the demo catalogue,
   * which is fetched — so it reads null until that lands. Deriving it here rather than storing it is what
   * keeps a late arrival from being frozen out by an earlier edit.
   */
  const variableCount = useCallback(
    (d: SetupDict): number | null =>
      d.origin === "upload" ? d.rowCount : d.datasetId ? (fieldsByDataset[d.datasetId] ?? null) : null,
    [fieldsByDataset],
  );

  /**
   * The corpus the quote is for, and whether it is knowable yet.
   *
   * R8 IS THE WHOLE DESIGN OF THIS BLOCK: never quote lower than what will be charged. A total summed over
   * the dictionaries whose size happens to have arrived is not a smaller estimate — it is an UNDER-QUOTE,
   * and it looks exactly like a finished one. So a corpus with any unknown member yields null, and the
   * panel renders a pending state rather than a figure. `config.est_fields` is the fallback for a real run,
   * which persists the total it was quoted at even though it keeps no per-dictionary counts.
   */
  const { totalFields, sizePending } = useMemo(() => {
    if (!dicts.length) return { totalFields: 0, sizePending: false };
    const counts = dicts.map(variableCount);
    if (counts.every((n) => n !== null)) {
      return { totalFields: counts.reduce((a, b) => a + (b ?? 0), 0), sizePending: false };
    }
    const config = (jobState?.config ?? {}) as Record<string, unknown>;
    const persisted = typeof config.est_fields === "number" ? config.est_fields : null;
    if (persisted !== null) return { totalFields: persisted, sizePending: false };
    return { totalFields: null as number | null, sizePending: true };
  }, [dicts, variableCount, jobState]);

  /**
   * The judge's real workload, when the run already knows it.
   *
   * Post-split group sizes make the coherence line EXACT instead of modelled — `judgeEligibleGroups`
   * counts the groups of at least six members rather than applying a per-variable rate. Absent (a run that
   * has not split yet, or no run at all) the estimator falls back to its measured rate and says so.
   */
  const groupSizes = useMemo(() => {
    const groups = jobState?.result?.conceptGroups ?? [];
    return groups.length ? groups.map((g) => g.nMembers) : undefined;
  }, [jobState]);

  const estimate = useMemo(
    () =>
      totalFields === null
        ? null
        : estimateRunCostBreakdown(totalFields, dicts.length, runMode, genSpecs, suggestIdeas, {
            conceptGate,
            groupSizes,
          }),
    [totalFields, dicts.length, runMode, genSpecs, suggestIdeas, conceptGate, groupSizes],
  );

  /** True while a figure would be premature: a file still parsing, or a corpus size still resolving. */
  const estimatePending = sizePending || dicts.some((d) => d.state === "parsing");

  const scoreComponents = useMemo(() => declaredComponents(scoreText), [scoreText]);
  // No run has produced concepts at Setup, so feasibility is not answerable here. See `score-scope.ts`.
  const scopeVerdict = setupScopeVerdict(0);

    /** A run that has already moved past Setup is a read-back: its configuration cannot be changed. */
  const runStarted = Boolean(jobState?.status && jobState.status !== "pending");

  const onDrop = useCallback(async (accepted: File[]) => {
    composed.current = true;
    for (const file of accepted) {
      const key = `up:${file.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      // The file shows its OWN parse state from the moment it is accepted — one card per file, so a slow
      // file cannot make a fast one look unfinished, and a set-wide banner cannot hide which is which.
      setDicts((prev) => [
        ...prev,
        {
          key,
          filename: file.name,
          cohortName: file.name.replace(/\.(csv|tsv|txt)$/i, ""),
          headers: [],
          rows: null,
          rowCount: null,
          roles: {},
          state: "parsing",
          origin: "upload",
        },
      ]);

      const parsed = await new Promise<{ headers: string[]; rows: DictRow[] }>((resolve) => {
        Papa.parse<DictRow>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res) =>
            resolve({ headers: (res.meta.fields ?? []).filter(Boolean), rows: res.data ?? [] }),
          error: () => resolve({ headers: [], rows: [] }),
        });
      });

      const drop = (problem: Omit<FileProblem, "key" | "filename">) => {
        setDicts((prev) => prev.filter((d) => d.key !== key));
        setProblems((prev) => [...prev, { key, filename: file.name, ...problem }]);
      };

      if (!parsed.headers.length) {
        drop({
          kind: "unreadable",
          detail:
            "No header row could be read, so there are no columns to map. ddharmon reads comma- or " +
            "tab-delimited text with the column names on the first line. Export the dictionary again as " +
            "CSV or TSV and drop it here.",
        });
        continue;
      }
      // Refused BEFORE anything is uploaded, and refused in the browser: this is a standing product
      // prohibition (metadata only, never participant-level data), so the user should not have to wait on
      // a round trip to learn the file is the wrong kind. The server refuses it too — this is the second
      // lock on the same door, not a replacement for it.
      const offender = participantLevelColumn(parsed.headers, parsed.rows);
      if (offender) {
        drop({
          kind: "participant-level",
          detail:
            `The column ${offender} holds a different value on every row. ddharmon only accepts metadata ` +
            "— one row per variable, describing the fields — not the participant records themselves. " +
            "Nothing was uploaded. Upload the study's data dictionary instead.",
        });
        continue;
      }
      if (!parsed.rows.length) {
        drop({
          kind: "no-rows",
          detail:
            "The columns were read but the file has no rows under them, so it describes no variables. " +
            "Check that the export included the dictionary's body, then drop it here again.",
        });
        continue;
      }

      setDicts((prev) =>
        prev.map((d) =>
          d.key === key
            ? {
                ...d,
                headers: parsed.headers,
                rows: parsed.rows,
                rowCount: parsed.rows.length,
                roles: initialRoles(parsed.headers),
                state: "ready",
              }
            : d,
        ),
      );
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "text/csv": [".csv"], "text/tab-separated-values": [".tsv"], "text/plain": [".txt"] },
  });

  function setRoles(key: string, roles: Record<string, string>) {
    composed.current = true;
    setDicts((prev) => prev.map((d) => (d.key === key ? { ...d, roles } : d)));
  }
  function removeDict(key: string) {
    composed.current = true;
    setDicts((prev) => prev.filter((d) => d.key !== key));
  }

  /**
   * Why Start is disabled, in the reviewer's terms. A dead control with no explanation is a defect, so
   * every blocker is a SENTENCE that names the thing to fix — and where a file is at fault, it names the
   * file. Order is stable so the list does not reshuffle as items are fixed.
   */
  const blockers = useMemo(() => {
    const out: string[] = [];
    if (runStarted) {
      out.push("This run has already started, so its setup cannot be changed. Rejoin it at its own gate.");
    }
    if (!dicts.length) {
      out.push("Add at least one data dictionary — one file per cohort.");
    }
    for (const d of dicts) {
      if (d.state === "parsing") {
        out.push(`${d.filename} is still being read.`);
        continue;
      }
      if (!hasMeaning(d.roles)) {
        out.push(
          `${d.filename}: map at least one of description, question_text or variable_name, so the ` +
            "pipeline has meaning to match against common data elements.",
        );
      }
    }
    return out;
  }, [dicts, runStarted]);

  return (
    <GateShell
      gate="setup"
      subhead="Add a data dictionary per cohort, map its columns, and choose how the run should be priced. Nothing is charged yet — the first charge is Continue at Gate 0."
      rail={railFor("setup", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
    >
      {/* --- dictionaries ------------------------------------------------------------------------- */}
      <section data-testid="setup-dictionaries" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-on-field">Data dictionaries</h2>
          <p
            data-testid="dictionary-count"
            data-count={String(dicts.length)}
            className="max-w-[68ch] text-sm text-on-field-muted"
          >
            {dicts.length === 0
              ? "One file per cohort, each describing its variables — one row per variable."
              : totalFields === null
                ? `${dicts.length} ${dicts.length === 1 ? "dictionary" : "dictionaries"} · counting variables…`
                : `${dicts.length} ${
                    dicts.length === 1 ? "dictionary" : "dictionaries"
                  } · ${totalFields.toLocaleString()} variables`}
          </p>
        </div>

        {/* ONE dictionary is a different job from harmonization, and the copy says which. */}
        {dicts.length === 1 && (
          <p
            data-testid="single-dictionary-notice"
            className="max-w-[68ch] rounded-inner border border-rule-on-field px-3 py-2 text-sm text-on-field"
          >
            <span className="font-semibold">One dictionary is CDE-mapping, not harmonization.</span>{" "}
            Harmonization pools variables that mean the same thing across two or more dictionaries; with
            one, every group has a single source and the run maps it to common data elements instead. That
            is a supported run — add a second dictionary if you wanted the cross-cohort comparison.
          </p>
        )}

        {!runStarted && (
          <div
            {...getRootProps()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-card border border-dashed py-8 ${
              isDragActive ? "border-accent-on-field bg-surface-raised" : "border-rule-on-field"
            }`}
          >
            {/* The test hook goes on the ELEMENT, not into `getInputProps()`: react-dropzone's
                `DropzoneInputProps` does not declare `data-testid`, and widening a library type to carry
                our own attribute would be the wrong fix for a spread that already works. */}
            <input {...getInputProps()} data-testid="dict-upload" />
            <Upload aria-hidden="true" className="h-5 w-5 text-on-field-muted" />
            <p className="text-sm font-semibold text-on-field">
              Drop CSV or TSV data dictionaries here, or click to browse
            </p>
            <p className="text-xs text-on-field-muted">
              One file per cohort. The common-data-element catalogue is added for you.
            </p>
          </div>
        )}

        {/* Files that never became dictionaries: the problem, then the next step. */}
        {problems.map((p) => (
          <div
            key={p.key}
            data-testid={p.kind === "participant-level" ? "participant-refusal" : "dict-unparseable"}
            className="flex flex-col gap-1 rounded-card border border-rule-danger bg-surface-danger px-4 py-3"
          >
            <p className="text-sm font-semibold text-on-danger">
              {p.kind === "participant-level"
                ? `${p.filename} looks like participant data, not a data dictionary.`
                : p.kind === "no-rows"
                  ? `${p.filename} was read but describes no variables.`
                  : `${p.filename} could not be read as a data dictionary.`}
            </p>
            <p className="max-w-[68ch] text-xs text-on-danger">{p.detail}</p>
            <button
              type="button"
              onClick={() => setProblems((prev) => prev.filter((x) => x.key !== p.key))}
              className="self-start text-xs font-semibold text-on-danger underline"
            >
              Dismiss
            </button>
          </div>
        ))}

        {dicts.length === 0 ? (
          <div className="rounded-card bg-surface-raised shadow-card">
            <GateEmptyState
              heading="No dictionaries yet"
              nextStep="Drop one file per cohort above. Reading and mapping them costs nothing — the first charge is Continue at Gate 0."
            >
              Nothing has been added to this run, so there is nothing to group and nothing to price. This is
              not an error: a run starts empty.
            </GateEmptyState>
          </div>
        ) : (
          dicts.map((d) => (
            <article
              key={d.key}
              data-testid="dict-card"
              data-cohort={d.cohortName}
              data-parse-state={d.state}
              className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card"
            >
              <header className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <span
                    data-testid="dict-filename"
                    title={d.filename}
                    className="block truncate font-mono text-sm font-semibold text-on-raised"
                  >
                    {d.filename}
                  </span>
                  <p className="text-xs text-on-raised-muted">
                    cohort <span className="font-mono text-on-raised">{d.cohortName}</span> ·{" "}
                    {d.headers.length} {d.headers.length === 1 ? "column" : "columns"}
                    {(() => {
                      const n = variableCount(d);
                      return n === null ? "" : ` · ${n.toLocaleString()} rows`;
                    })()}
                    {d.origin === "run" ? " · from this run's record" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {/* Per FILE, never per set: a state on the card is the only way a reviewer can tell
                      which file is still being read. */}
                  <span data-testid="dict-parse-state" className="text-xs text-on-raised-muted">
                    {d.state === "parsing" ? "reading…" : "read"}
                  </span>
                  {!runStarted && (
                    <button
                      type="button"
                      onClick={() => removeDict(d.key)}
                      aria-label={`Remove ${d.filename}`}
                      className="text-on-raised-muted"
                    >
                      <X aria-hidden="true" className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </header>

              {d.state === "parsing" ? (
                <p className="text-xs text-on-raised-muted">
                  Reading this file in your browser. Nothing has been uploaded.
                </p>
              ) : (
                <DictionaryMappingTable
                  headers={d.headers}
                  roles={d.roles}
                  rows={d.rows}
                  disabled={runStarted}
                  onRolesChange={(roles) => setRoles(d.key, roles)}
                />
              )}
            </article>
          ))
        )}
      </section>

      {/* --- the declared score ------------------------------------------------------------------ */}
      <section data-testid="score-panel" className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-on-raised">Score definition (optional)</h2>
          <p className="max-w-[68ch] text-xs text-on-raised-muted">
            If you came for a published score, name its components here and Gate 1 will offer them as the
            scope to work through first. Reading a document costs nothing — transcribing one into components
            is a model call, so it happens with the run rather than on this screen.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="score-doc" className="text-xs font-semibold text-on-raised">
            Read a paper or supplement ($0)
          </label>
          <input
            id="score-doc"
            data-testid="score-upload"
            type="file"
            accept=".pdf,.docx"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setScoreDocError("");
              setScoreDoc(null);
              try {
                const read = await extractScoreDocument(file);
                setScoreDoc({ provenance: read.provenance, nChars: read.nChars });
              } catch (err) {
                // Problem, then next step — never a bare failure. A publisher PDF is often an access-check
                // interstitial, so "no text came back" is a likely and unalarming outcome.
                setScoreDocError(
                  err instanceof Error
                    ? `${err.message} You can still name the components yourself below.`
                    : "The document could not be read. You can still name the components yourself below.",
                );
              }
            }}
            className="w-full text-xs text-on-raised file:mr-3 file:rounded file:border file:border-rule-control-on-raised file:bg-surface-raised file:px-2 file:py-1 file:text-xs file:font-semibold file:text-on-raised"
          />
          {scoreDoc && (
            <p data-testid="score-doc-read" className="text-xs text-on-raised-muted">
              Read {scoreDoc.nChars.toLocaleString()} characters from{" "}
              <span className="font-mono text-on-raised">{scoreDoc.provenance}</span>. Nothing was charged.
              Check the components below against the document — if its item table did not survive
              extraction, name the items yourself.
            </p>
          )}
          {scoreDocError && (
            <p data-testid="score-doc-error" className="max-w-[68ch] text-xs text-on-raised">
              {scoreDocError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="score-components" className="text-xs font-semibold text-on-raised">
            Components, one per line
          </label>
          <textarea
            id="score-components"
            data-testid="score-components"
            rows={4}
            value={scoreText}
            onChange={(e) => setScoreText(e.target.value)}
            placeholder={"Weak grip strength\nUnintentional weight loss\nSlow walking speed"}
            className="w-full rounded border border-rule-control-on-raised bg-surface-raised px-3 py-2 text-sm text-on-raised placeholder:text-on-raised-muted"
          />
        </div>

        {scoreComponents.length > 0 && (
          /* THE DECLARED-SCORE SCOPE BAND. Its left rule is one of the four places the secondary-accent
             register is allowed (UI-SPEC §5.4), in the contrast-corrected on-paper form — the raw dark-
             surface form measures 2.39:1 here and would be the wrong one. */
          <div
            data-testid="score-scope-band"
            data-components={String(scoreComponents.length)}
            className="flex flex-col gap-2 border-l-2 border-rule-accent-2-on-raised bg-surface-inset px-4 py-3"
          >
            <p className="text-xs font-semibold text-on-inset">
              {scoreComponents.length} declared {scoreComponents.length === 1 ? "component" : "components"} —
              offered as the first scope at Gate 1
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {scoreComponents.map((c) => (
                <li
                  key={c}
                  data-testid="score-component"
                  title={c}
                  className="max-w-[24rem] truncate rounded-pill border border-rule-on-inset px-2 py-0.5 text-xs text-on-inset"
                >
                  {c}
                </li>
              ))}
            </ul>
            {/* Rendered by FORM, not by a status colour: this is the absence of an outcome, not an outcome. */}
            <p
              data-testid="score-verdict"
              data-verdict={scopeVerdict}
              className="flex max-w-[68ch] items-start gap-2 text-xs text-on-inset-muted"
            >
              <span
                aria-hidden="true"
                className="mt-1 h-2 w-2 shrink-0 rounded-full border border-dashed border-rule-control-on-raised"
              />
              <span>
                <span className="font-semibold text-on-inset">Feasibility: cannot be determined yet.</span>{" "}
                {SCOPE_VERDICT_COPY[scopeVerdict]}
              </span>
            </p>
          </div>
        )}
      </section>

      {/* --- run configuration ------------------------------------------------------------------- */}
      <section className="flex flex-col gap-4 rounded-card bg-surface-raised px-6 py-4 shadow-card">
        <h2 className="text-sm font-semibold text-on-raised">How this run should work</h2>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cde-set" className="text-xs font-semibold text-on-raised">
              Element catalogue
            </label>
            <select
              id="cde-set"
              data-testid="cde-set"
              value={cdeSet}
              onChange={(e) => setCdeSet(e.target.value as CdeSet)}
              className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-xs text-on-raised"
            >
              <option value="endorsed">NIH-endorsed — a curated, high-signal set</option>
              <option value="full">Full repository — broader, more candidates to weigh</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="run-mode" className="text-xs font-semibold text-on-raised">
              Run mode
            </label>
            <select
              id="run-mode"
              data-testid="run-mode"
              value={runMode}
              onChange={(e) => setRunMode(e.target.value as RunMode)}
              className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-xs text-on-raised"
            >
              <option value="batch">Batch — about half the cost, can take hours</option>
              <option value="sync">Synchronous — minutes, about twice the cost</option>
              <option value="preview">Preview — no model call at all, free</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="run-name" className="text-xs font-semibold text-on-raised">
              Run name (optional)
            </label>
            {/* User-typed prose, so the SANS face — unlike a filename or an identifier, which are mono. */}
            <input
              id="run-name"
              data-testid="run-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-sm text-on-raised"
            />
          </div>
          {runMode !== "preview" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="api-key" className="text-xs font-semibold text-on-raised">
                Provider API key
              </label>
              <input
                id="api-key"
                data-testid="api-key"
                type="password"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 font-mono text-xs text-on-raised"
              />
              <p className="text-xs text-on-raised-muted">
                Used for this run only, over HTTPS. Never stored, logged, or saved with the run.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {[
            {
              id: "gen-specs",
              testid: "gen-specs-toggle",
              checked: genSpecs,
              set: setGenSpecs,
              label: "Generate transform specs",
              detail: "The recipe to convert your values into each element's expected form.",
            },
            {
              id: "suggest-ideas",
              testid: "suggest-ideas-toggle",
              checked: suggestIdeas,
              set: setSuggestIdeas,
              label: "Suggest analysis ideas",
              detail: "One pass over the finished concepts. A small flat add, independent of corpus size.",
            },
            {
              // STGD-16. Default OFF, and deliberately NOT buried: an opt-in the reviewer never sees is an
              // unavailable feature with extra code behind it.
              id: "concept-gate",
              testid: "concept-gate-toggle",
              checked: conceptGate,
              set: setConceptGate,
              label: "Also check that matches measure the same concept",
              detail:
                "A second model pass per group, asking whether an assigned element measures the same " +
                "CONCEPT and not merely the same values. Buys a per-spec flag at Gate 3; costs an extra " +
                "model call per group, which appears as its own line in the estimate.",
            },
          ].map((opt) => (
            <label
              key={opt.id}
              htmlFor={opt.id}
              className="flex items-start gap-3 rounded-inner border border-rule-on-raised px-3 py-2"
            >
              <input
                id={opt.id}
                data-testid={opt.testid}
                type="checkbox"
                checked={opt.checked}
                disabled={runMode === "preview"}
                onChange={(e) => opt.set(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-xs font-semibold text-on-raised">{opt.label}</span>
                <span className="max-w-[68ch] text-xs text-on-raised-muted">{opt.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* --- the estimate ------------------------------------------------------------------------ */}
      <section
        data-testid="estimate-panel"
        data-pending={String(estimatePending)}
        className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card"
      >
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-on-raised">What this run will cost</h2>
            <p className="text-xs text-on-raised-muted">
              {totalFields === null
                ? "Working out how many variables this run covers."
                : `${totalFields.toLocaleString()} variables · ${dicts.length} ${
                    dicts.length === 1 ? "dictionary" : "dictionaries"
                  } · ${runMode}`}
            </p>
          </div>
          {/* PENDING RATHER THAN STALE. While an input is unresolved there is NO figure on screen — not the
              previous one, and not a zero. A total summed over the dictionaries whose size happened to
              arrive is not a smaller estimate, it is an under-quote that looks finished (R8). */}
          {estimatePending || !estimate ? (
            <p data-testid="estimate-pending" className="text-sm font-semibold text-on-raised-muted">
              working it out…
            </p>
          ) : estimate.free ? (
            <p data-testid="estimate-free" className="text-sm font-semibold text-on-raised">
              Free — preview calls no model
            </p>
          ) : (
            <p
              data-testid="estimate-total"
              data-mid={String(estimate.total.mid)}
              className="text-sm font-semibold tabular-nums text-on-raised"
            >
              {formatUsd(estimate.total.low)}–{formatUsd(estimate.total.high)}
            </p>
          )}
        </div>

        {!estimatePending && estimate && !estimate.free && (
          <>
            {/* Itemised. `data-cost-line` carries the line's STABLE id, so a test can assert the coherence
                line by identity rather than by row position. */}
            <ul className="flex flex-col gap-1 border-t border-rule-on-raised pt-2">
              {estimate.lines.map((l) => (
                <li
                  key={l.id}
                  data-cost-line={l.id}
                  className="flex items-baseline justify-between gap-4 text-xs"
                >
                  <span className="text-on-raised">
                    {l.label}
                    {l.note && <span className="ml-1 text-on-raised-muted">· {l.note}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums text-on-raised">
                    {l.cost === 0 ? "$0" : `~${formatUsd(l.cost)}`}
                  </span>
                </li>
              ))}
            </ul>

            {/* THE COHERENCE STAGE'S WORKLOAD, in variables rather than dollars — the money above is only
                meaningful next to how many groups the judge is actually asked about. Groups under the
                six-member minimum are left explicitly UNJUDGED, which is not the same as coherent. */}
            <p data-testid="coherence-workload" className="max-w-[68ch] text-xs text-on-raised-muted">
              {estimate.judgeCalls > 0 ? (
                <>
                  The coherence judge is priced for{" "}
                  <span className="font-semibold text-on-raised">
                    {estimate.judgeCalls.toLocaleString()}{" "}
                    {estimate.judgeCalls === 1 ? "group" : "groups"}
                  </span>{" "}
                  of at least six variables
                  {estimate.judgeCallsEstimated
                    ? " — estimated from corpus size, since the groups do not exist yet."
                    : " — counted from this run's own groups."}{" "}
                  Smaller groups are left unjudged and marked as such; a judge that was never asked has not
                  approved anything.
                </>
              ) : (
                <>
                  No group here can reach six variables, so the judge is not asked and the coherence line is{" "}
                  <span className="font-semibold text-on-raised">$0</span>. The line stays on the bill
                  anyway: a line that disappears is indistinguishable from a stage nobody costed. Those
                  groups will be marked <span className="font-semibold text-on-raised">not judged</span>,
                  which is not the same as coherent.
                </>
              )}
            </p>

            {/* WHERE THE FIRST CHARGE FALLS. UI-SPEC §0.1 as reversed at plan review: Gate 0's Continue,
                not Gate 1's. Getting this wrong on the one screen whose whole job is informed consent to
                spend is the exact failure R8 exists to prevent. */}
            <p
              data-testid="first-charge"
              className="max-w-[68ch] border-t border-rule-on-raised pt-2 text-xs text-on-raised"
            >
              <span className="font-semibold">
                The first charge is Continue at Gate 0 — about {formatUsd(estimate.firstCharge)}.
              </span>{" "}
              Setting up, loading, preparing and grouping your dictionaries all run on the server for
              nothing, and Gate 0's review is free to read. Pressing Continue there is what buys the next
              step: generating a candidate element per group, splitting groups that fuse more than one
              concept, and the coherence judge. Everything up to that press can be abandoned at no cost.
            </p>

            <ul className="flex flex-col gap-1">
              {(Object.keys(estimate.byGate) as GatePosition[]).map((gate) => {
                const g = estimate.byGate[gate];
                return (
                  <li
                    key={gate}
                    data-gate-forecast={gate}
                    className="flex items-baseline justify-between gap-4 text-xs"
                  >
                    <span className="text-on-raised-muted">
                      {GATE_LABELS[gate]}
                      {gate === "gate0" && " · no model call happens here, but its Continue is the first charge"}
                      {gate === "setup" && " · local"}
                      {gate === "gate4" && " · a terminal read"}
                    </span>
                    <span className="shrink-0 tabular-nums text-on-raised-muted">
                      {gate === "setup" || gate === "gate0"
                        ? "local — no charge"
                        : gate === "gate4"
                          ? "no charge"
                          : `est. ${formatUsd(g.forecast)}`}
                    </span>
                  </li>
                );
              })}
            </ul>

            <p className="text-xs text-on-raised-muted">
              A rough estimate, from observed runs. The stages scale with groups rather than linearly with
              variables, so treat the range as a range.
            </p>
          </>
        )}

        {!estimatePending && estimate && estimate.free && (
          <p className="max-w-[68ch] border-t border-rule-on-raised pt-2 text-xs text-on-raised-muted">
            Preview groups your variables and retrieves candidate elements without calling a model, so
            nothing is charged at any gate. Switch to batch or synchronous when you want the assignment.
          </p>
        )}
      </section>

      {/* --- start ------------------------------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-6 rounded-card bg-surface-raised px-6 py-4 shadow-card">
        <div className="flex min-w-0 flex-col gap-1">
          {blockers.length > 0 ? (
            <div data-testid="start-blocked" className="flex flex-col gap-1">
              <p className="text-sm font-semibold text-on-raised">
                Not ready to start — {blockers.length === 1 ? "one thing" : `${blockers.length} things`} to
                fix:
              </p>
              <ul className="flex flex-col gap-0.5">
                {blockers.map((b) => (
                  <li key={b} data-testid="blocker" className="max-w-[68ch] text-xs text-on-raised-muted">
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="max-w-[68ch] text-sm text-on-raised-muted">
              Ready to start. Loading, preparing and grouping all run before anything is charged.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button type="button" data-testid="start-run" disabled={blockers.length > 0}>
            Start run
          </Button>
          <p data-testid="nothing-charged-yet" className="text-xs text-on-raised-muted">
            Nothing is charged yet.
          </p>
        </div>
      </div>
    </GateShell>
  );
}
