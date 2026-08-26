import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { Eye, EyeOff, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { GateShell, railFor } from "@/components/gate/GateShell";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { DictionaryMappingTable } from "@/components/gate/DictionaryMappingTable";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { InfoTip } from "@/components/ui/info-tip";
import { IS_STATIC, listDemos, listModels, startHarmonize } from "@/lib/api";
import { estimateRunCostBreakdown, formatUsd } from "@/lib/estimate";
import { participantLevelColumn, type DictRow } from "@/lib/dictionary";
import { lookupPrefill, rememberAssignment } from "@/lib/column-prefill";
import { PROVIDER_KEY_INFO } from "@/lib/provider-keys";
import { COLUMN_ROLES, PROVIDER_LABELS, estimateRunTime, formatDurationRange } from "@/types";
import demoManifest from "@/data/demo-column-assignments.json";
import { GATE_LABELS } from "@/components/gate/GateRail";
import type { CdeSet, GatePosition, JobResult, RunMode } from "@/types";

/**
 * Only Sonnet 4.6 has been validated end to end against this pipeline. Untested choices are OFFERED but
 * DISABLED, the same treatment the shipped New Run form gives them — visible so the picker does not
 * misrepresent what exists, unselectable so a run cannot be pointed at an unvalidated model.
 */
const isModelTested = (id: string): boolean => /sonnet.*4[.-]6/i.test(id);

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
  /** The file itself, for an upload — this is what `startHarmonize` posts. Absent for a run-seeded entry. */
  file?: File;
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
  const [, navigate] = useLocation();
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
  const [provider, setProvider] = useState("anthropic");
  /** Reveal the key field. Rendering only — the key itself is never persisted either way. */
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState("");
  const [starting, setStarting] = useState(false);
  /** True once the reviewer has touched the dictionary list, so a late run frame cannot overwrite it. */
  const composed = useRef(false);

  // The demo catalogue's own field counts, used only to size a run-seeded demo dictionary. Static-safe.
  const { data: demos } = useQuery({ queryKey: ["demos"], queryFn: listDemos, staleTime: Infinity });
  const { data: modelCatalog } = useQuery({ queryKey: ["models"], queryFn: listModels });
  const models = useMemo(() => modelCatalog?.models ?? [], [modelCatalog]);
  const modelsForProvider = useMemo(() => models.filter((m) => m.provider === provider), [models, provider]);
  const providers = useMemo(() => [...new Set(models.map((m) => m.provider))], [models]);
  const isProviderTested = (pr: string): boolean =>
    models.some((m) => m.provider === pr && isModelTested(m.id));
  // Land on the first TESTED model for the provider, so Anthropic defaults to Sonnet 4.6 rather than to
  // whatever the catalogue happens to list first.
  useEffect(() => {
    if (!modelsForProvider.length) return;
    const ok = model && modelsForProvider.some((m) => m.id === model && isModelTested(m.id));
    if (!ok) setModel((modelsForProvider.find((m) => isModelTested(m.id)) ?? modelsForProvider[0]).id);
  }, [modelsForProvider, model]);
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

  /**
   * The selected provider's key hint — what a key looks like, and where to get one.
   *
   * OPTIONAL BY DESIGN: `PROVIDER_LABELS` also carries `local` and `other`, neither of which has a hint,
   * so this is `undefined` for them and the field falls back to a generic placeholder with NO link. An
   * anchor with an empty href is a dead control, and this screen does not render dead controls.
   */
  const keyInfo = PROVIDER_KEY_INFO[provider];

  /** True while a figure would be premature: a file still parsing, or a corpus size still resolving. */
  const estimatePending = sizePending || dicts.some((d) => d.state === "parsing");

  /**
   * How long the run will take — the WALL-CLOCK companion to the cost estimate (08-13b Task 2).
   *
   * A batch run can sit in the provider's queue for a long time before it produces anything, and a
   * reviewer who was never told that reads a long run as a hung one. So the duration is quoted beside the
   * price, from the SAME estimator the shipped New Run form uses (`estimateRunTime` + `formatDurationRange`
   * in `types.ts`) rather than a second model that could disagree with it.
   *
   * It is a RANGE and it is hedged in copy. `estimateRunTime`'s own comment calls it order-of-magnitude —
   * batch turnaround is set mostly by the Anthropic Batch API queue, which is only weakly tied to corpus
   * size — so a single figure here would be a commitment the run cannot keep.
   */
  const time = useMemo(
    () => estimateRunTime(totalFields ?? 0, dicts.length, runMode),
    [totalFields, dicts.length, runMode],
  );

    /** A run that has already moved past Setup is a read-back: its configuration cannot be changed. */
  const runStarted = Boolean(jobState?.status && jobState.status !== "pending");

  /**
   * Dictionaries that look like the SAME source added twice — matched on filename, or on an identical
   * (size, row count) pair when the names differ.
   *
   * Not cosmetic. A duplicated dictionary enters clustering as two cohorts, so every concept it touches
   * reads as CROSS-COHORT agreement that does not exist — and cross-cohort breadth is the signal Gate 1
   * partitions its ledger on. The run would look like it pooled where it only counted the same variables
   * twice.
   *
   * FLAGGED, NOT BLOCKED, following this screen's standing discipline: two genuinely different cohorts can
   * legitimately ship files of the same name, and refusing them outright would be wrong more often than the
   * duplicate is right. The reviewer is told what it costs and can remove one.
   */
  const duplicateDicts = useMemo(() => {
    const byName = new Map<string, number>();
    const bySize = new Map<string, number>();
    for (const d of dicts) {
      const n = d.filename.trim().toLowerCase();
      byName.set(n, (byName.get(n) ?? 0) + 1);
      if (d.file && d.rowCount !== null) {
        const k = `${d.file.size}:${d.rowCount}`;
        bySize.set(k, (bySize.get(k) ?? 0) + 1);
      }
    }
    const names = new Set<string>();
    for (const d of dicts) {
      const n = d.filename.trim().toLowerCase();
      const k = d.file && d.rowCount !== null ? `${d.file.size}:${d.rowCount}` : "";
      if ((byName.get(n) ?? 0) > 1 || (k && (bySize.get(k) ?? 0) > 1)) names.add(d.filename);
    }
    return [...names];
  }, [dicts]);

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
          file,
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
      // The ONLY blocker in this case. Every other one asks for a change that cannot be made, and a list
      // of things to fix that cannot be fixed is worse than the single true sentence.
      return ["This run has already started, so its setup cannot be changed. Rejoin it at its own gate."];
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
    // Batch and synchronous both call a provider; preview calls nothing. A missing key is a blocker rather
    // than a failure at submit time, because the reason belongs beside the disabled control.
    if (runMode !== "preview" && !apiKey.trim()) {
      out.push("Enter your Anthropic API key, or switch the run mode to Preview, which calls no model.");
    }
    return out;
  }, [dicts, runStarted, runMode, apiKey]);

  /**
   * Start the run and hand off to Gate 0.
   *
   * The button is only reachable with an empty blocker list, so this does not re-validate — it submits. It
   * posts the FILES, which is why each upload keeps its `File` rather than only its parsed rows: a run
   * cannot be started from a table that was parsed in the browser.
   */
  async function onStart() {
    setStarting(true);
    try {
      const files = dicts.map((d) => d.file).filter((f): f is File => Boolean(f));
      const { jobId: started } = await startHarmonize(
        files,
        {
          dictionaries: dicts.map((d) => ({
            filename: d.filename,
            cohortName: d.cohortName,
            columnRoles: d.roles,
          })),
          cdeSet,
          runMode,
          genTransformSpecs: genSpecs,
          suggestAnalysisIdeas: suggestIdeas,
          conceptGate,
          displayName: displayName || undefined,
          provider,
          modelTag: model || undefined,
          // Echoed onto the run so a later screen can price a partial stop without re-counting dictionaries
          // it no longer has. The same fields the New Run form persists.
          estFields: totalFields ?? 0,
          estCohorts: dicts.length,
        },
        "anthropic",
        runMode === "preview" ? undefined : apiKey.trim(),
      );
      // WRITE the column-mapping cache Setup already READ. `initialRoles` calls `lookupPrefill`, so before
      // this line Setup consumed a cache that only the New Run form ever filled — a read path fed by a
      // writer living on another screen. Written HERE, at run start, exactly where `home.tsx:228` writes
      // it: a mid-mapping edit would cache a half-finished assignment as if it were the reviewer's answer.
      //
      // HEADERS AND ROLES ONLY (T-08b-2). Both are dictionary METADATA — column names and which role each
      // column plays. Nothing derived from the FIRST VALUE column the mapping table displays goes in here;
      // that column holds cell contents, and a cache of cell contents is a different thing entirely.
      dicts.forEach((d) => rememberAssignment(d.headers, d.roles));
      navigate(`/run/${started}/gate0`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start this run");
    } finally {
      setStarting(false);
    }
  }

  return (
    <GateShell
      gate="setup"
      subhead="Add a data dictionary per cohort, map its columns, and choose how the run should be priced. Nothing is charged yet — the first charge is Continue at Gate 0."
      rail={railFor("setup", { totalRealized: costSoFar })}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
    >
      {/* TWO COLUMNS, following the shipped New Run form (08-13 review).
          The single-column stack put the price and the start control ~3,000px below the fold, behind five
          mapping tables — so the number the user is consenting to was never on screen at the same time as
          the choices that change it. Left: what the run IS (the dictionaries, and how each one's columns map). Right,
          sticky: how it RUNS, what it COSTS, and the control that starts it — the three that belong
          together and must stay visible while the left column is scrolled. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        {/* ── left: what the run is ── */}
        <div className="flex min-w-0 flex-col gap-8">
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
          {duplicateDicts.length > 0 && (
            <p
              data-testid="duplicate-dictionaries"
              data-count={String(duplicateDicts.length)}
              className="max-w-[68ch] rounded-inner border border-rule-warn bg-surface-warn px-3 py-2 text-xs text-on-warn"
            >
              <span className="font-semibold">
                The same dictionary looks like it was added more than once: {duplicateDicts.join(", ")}.
              </span>{" "}
              A duplicate enters clustering as a second cohort, so concepts it touches will read as
              cross-cohort agreement that is not real — and cross-cohort breadth is what Gate 1 sorts and
              filters on. Remove one, or rename it if these really are different cohorts.
            </p>
          )}
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

        </div>

        {/* ── right: how it runs, what it costs, and starting it (sticky) ── */}
        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-8">
      {/* --- run configuration ------------------------------------------------------------------- */}
      <section className="flex flex-col gap-4 rounded-card bg-surface-raised px-6 py-4 shadow-card">
        <h2 className="text-sm font-semibold text-on-raised">How this run should work</h2>

        <div className="grid grid-cols-1 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cde-set" className="flex items-center gap-1 text-xs font-semibold text-on-raised">
              CDE catalogue
              <InfoTip
                text="Which Common Data Element catalogue your variables are matched against. NIH-endorsed is a small curated high-signal set; the full repository is the whole catalogue — broader coverage, but many more candidates to weigh per concept."
                label="About the CDE catalogue options"
              />
            </label>
            <select
              id="cde-set"
              data-testid="cde-set"
              value={cdeSet}
              onChange={(e) => setCdeSet(e.target.value as CdeSet)}
              className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-xs text-on-raised"
            >
              <option value="endorsed">NIH-Endorsed CDEs (~174)</option>
              <option value="full">Full NIH CDE Repository (~22.7k)</option>
              {/* Offered and DISABLED: bringing your own catalogue is not built. Hiding it would leave no
                  trace of the gap; a live control would promise something the backend cannot do. */}
              {/* NOT-YET-AVAILABLE catalogues, offered and disabled. Listing them is the point: the choice of
                  catalogue is the single biggest lever on what a run can match to, and a dropdown with two
                  entries implies two exist. Disabled because no retrieval index is built for them. */}
              {/* RoP is disabled for a LICENCE reason, not an engineering one, and the label says which:
                  CC-BY-NC-4.0 (data) + AGPLv3 (code). ddharmon is MIT, so shipping RoP content or an index
                  built from it needs a commercial licence from DataTecnica first. Saying only "not yet
                  available" would imply this is queued work. */}
              <option value="rop" disabled>
                DataTecnica RoP (~1.33M) — non-commercial licence, not cleared
              </option>
              <option value="monarch" disabled>
                Monarch CDE harmonization — early, no released catalogue
              </option>
              <option value="upload" disabled>
                Upload your own — not yet available
              </option>
            </select>
            {/* TWO LINES, deliberately. The steward roll-call that used to sit here (NINDS 13,545, LOINC
                3,731, …) was measured and correct and still wrong for this screen: nobody choosing a
                catalogue needs a per-organization census mid-form. It belongs on a content page that can
                give it room. Link out; do not inline. */}
            <p className="text-xs leading-relaxed text-on-raised-muted">
              Both draw from the{" "}
              <a href="https://cde.nlm.nih.gov/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-accent-on-raised">NIH CDE Repository</a>
              . <Link href="/methods" className="underline underline-offset-2 hover:text-accent-on-raised">How matching works</Link>
              {" · "}
              <Link href="/related" className="underline underline-offset-2 hover:text-accent-on-raised">Other catalogues</Link>
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="run-mode" className="flex items-center gap-1 text-xs font-semibold text-on-raised">
              Run mode
              <InfoTip
                text="How the run executes. Batch: the model stages are submitted to Anthropic's Batch API and collected when they finish — about half the cost, but the wait is not under our control and can reach hours. Synchronous: the same pipeline with immediate calls — finishes in minutes with predictable wall-clock, at roughly twice the batch cost. Preview: no LLM call at all — clustering and candidate retrieval only. Retrieval needs no language model: it is BM25 keyword search fused with dense vector similarity, and the encoder that produces those vectors runs locally, so it costs nothing and needs no key. You see the groups and the candidate elements each one retrieved, but nothing is named, split, assigned or verdicted — those are the LLM stages. Batch and Synchronous both need your API key."
                label="About the run mode options"
              />
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
              <option value="preview">Preview — no LLM call, free</option>
            </select>
            <p className="text-xs leading-relaxed text-on-raised-muted">
              Batch pricing and turnaround are Anthropic's, not ours —{" "}
              <a
                href="https://docs.anthropic.com/en/docs/build-with-claude/batch-processing"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-accent-on-raised"
              >
                Batch API docs
              </a>
              .
            </p>
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
          {/* PROVIDER + MODEL, drawn from the shipped New Run form (08-13 review). Setup originally fixed
              these to Anthropic on the grounds that a picker would offer untested choices — but the New Run
              form already solved that by OFFERING every option and DISABLING the ones not validated, which
              is more honest than hiding them: the gap stays visible and stays unselectable. Both are hidden
              in preview mode, which calls no provider at all. */}
          {runMode !== "preview" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="provider" className="flex items-center gap-1 text-xs font-semibold text-on-raised">
                Provider
                <InfoTip
                  text="Which API the model stages call. Anthropic is the only provider validated end to end against this pipeline; anything else is listed so you can see it exists, and disabled so a run cannot be pointed at it."
                  label="About the provider options"
                />
              </label>
              <select
                id="provider"
                data-testid="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={!providers.length}
                className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-xs text-on-raised disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-on-raised-muted"
              >
                {providers.length === 0 && <option value="anthropic">Anthropic</option>}
                {providers.map((pr) => {
                  const tested = isProviderTested(pr);
                  return (
                    <option key={pr} value={pr} disabled={!tested}>
                      {PROVIDER_LABELS[pr] ?? pr}
                      {tested ? "" : " — not yet tested"}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          {runMode !== "preview" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="model" className="flex items-center gap-1 text-xs font-semibold text-on-raised">
                Model
                <InfoTip
                  text="The model the paid stages run on. Claude Sonnet 4.6 is the only one this pipeline's prompts and benchmarks were validated against, so it is the default and the others are disabled. Model choice changes both cost and the quality of concept grouping and assignment."
                  label="About the model options"
                />
              </label>
              <select
                id="model"
                data-testid="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!modelsForProvider.length}
                className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 text-xs text-on-raised disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-on-raised-muted"
              >
                {modelsForProvider.length === 0 && <option value="">No models available</option>}
                {modelsForProvider.map((m) => {
                  const tested = isModelTested(m.id);
                  return (
                    <option key={m.id} value={m.id} disabled={!tested}>
                      {m.label}
                      {tested ? "" : " — not yet tested"}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          {runMode !== "preview" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="api-key" className="flex items-center gap-1 text-xs font-semibold text-on-raised">
                {PROVIDER_LABELS[provider] ?? provider} API key
                <InfoTip
                  text={
                    "Your provider API key authorises this run's model calls — concept assignment and " +
                    "transform specs. It is sent over HTTPS for this run only: never written to disk, to " +
                    "logs, or into the saved run configuration, and it is cleared when you reload this " +
                    "page. Preview mode and local/on-prem models need no provider key at all."
                  }
                  label="About the API key"
                />
              </label>
              {/* The reveal is a RENDERING toggle and nothing else — no storage, no echo, no second copy
                  of the value. Same ARIA pattern as the shipped New Run form (`home.tsx:461`): the label
                  states the ACTION the button will perform, so it changes with state. */}
              <div className="relative">
                <input
                  id="api-key"
                  data-testid="api-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  placeholder={keyInfo?.placeholder ?? "your API key"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${PROVIDER_LABELS[provider] ?? provider} API key`}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="h-8 w-full rounded border border-rule-control-on-raised bg-surface-raised px-2 pr-8 font-mono text-xs text-on-raised placeholder:text-on-raised-muted"
                />
                <button
                  type="button"
                  data-testid="api-key-reveal"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  aria-pressed={showKey}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-on-raised-muted transition-colors hover:text-accent-on-raised"
                >
                  {showKey ? (
                    <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              {/* The fuller production wording. The short form said where the key goes; this one also says
                  what it is NOT written to and that a reload clears it, which is the part a reviewer being
                  asked to paste a credential into a browser actually wants to read. */}
              <p data-testid="api-key-handling" className="max-w-[68ch] text-xs text-on-raised-muted">
                Used only for this run, sent over HTTPS — never written to disk, to logs, or into the saved
                run configuration, and cleared when you reload this page.{" "}
                {keyInfo?.link && (
                  <a
                    data-testid="api-key-help-link"
                    href={keyInfo.link}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link-on-raised underline hover:text-on-raised"
                  >
                    Get a key
                  </a>
                )}
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
              decidedAt: "Gate 3",
              priced: "in the estimate",
              label: "Generate transform specs",
              help:
                "The recipe that converts your values into the form the matched element expects — value " +
                "recodes for categoricals, unit and arithmetic conversions for numerics. Without it you get " +
                "matches but no instructions for actually transforming your data.",
              detail: "Turns each match into instructions for converting your values.",
            },
            {
              id: "suggest-ideas",
              testid: "suggest-ideas-toggle",
              checked: suggestIdeas,
              set: setSuggestIdeas,
              decidedAt: "the results page",
              priced: "~$0.05 flat",
              label: "Suggest analysis ideas",
              help:
                "One pass over the finished concepts, proposing cross-cohort analyses this harmonization " +
                "makes possible. A small flat add, independent of corpus size. It suggests; it never runs " +
                "anything.",
              detail: "One pass over the finished concepts. A small flat add, independent of corpus size.",
            },
            {
              // STGD-16. Default OFF, and deliberately NOT buried: an opt-in the reviewer never sees is an
              // unavailable feature with extra code behind it.
              id: "concept-gate",
              testid: "concept-gate-toggle",
              checked: conceptGate,
              set: setConceptGate,
              decidedAt: "Gate 2",
              priced: "1 call / match",
              label: "Double-check matches",
              help:
                "One call per concept group that got matched to an element — the same granularity as the " +
                "coherence check, not per variable and not pairwise. Where coherence asks whether a group's " +
                "members are one concept, this asks whether the element the group was matched TO is the " +
                "right one. It exists because value coverage is not evidence of meaning: two 1-5 Likert " +
                "items map cleanly onto each other, so a recode reads 100% covered even when one asks how " +
                "confident you are filling out medical forms and the other asks whether you felt happy. " +
                "Flags the suspect recodes at Gate 3; never changes a verdict on its own.",
              // Third rewrite. v1 named the mechanism ("a second model pass ... the same CONCEPT"). v2 led
              // with a units example I invented, which is the wrong shape — the real failure is a shared
              // ANSWER FORMAT, and the documented case is far sharper. This one leads with the transform
              // spec, which is what the check actually protects: a recode whose coverage reads 100% and is
              // still wrong. Source: transform.py's M7 comment + the 2026-07-04 full-5 audit.
              detail: "A recode can read 100% covered and still mean the wrong thing.",
            },
          ].map((opt) => (
            <div
              key={opt.id}
              data-testid={opt.testid}
              data-default={String(opt.checked)}
              className="flex flex-col gap-0.5 rounded-inner border border-rule-on-raised px-3 py-2"
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="inline-flex items-baseline gap-1 text-xs font-semibold text-on-raised">
                  {opt.label}
                  <InfoTip text={opt.help} label={`About ${opt.label}`} />
                </span>
                <span className="shrink-0 text-xs tabular-nums text-on-raised-muted">{opt.priced}</span>
              </span>
              <span className="text-xs text-on-raised-muted">{opt.detail}</span>
              <span className="text-xs text-on-raised-muted">
                <span className="text-on-raised">{opt.checked ? "On" : "Off"}</span> by default · you choose
                at {opt.decidedAt}
              </span>
            </div>
          ))}
          {/* NOT CONTROLS, on purpose (08-13 review). Each of these is a decision you make better once you
              can see what it would apply to: whether specs are worth generating depends on the assignments
              at Gate 2, and analysis ideas are a post-run add. Asking at Setup is asking at the moment of
              least information, which is the opposite of what the staged gates are for. They are shown here
              PRICED so the estimate is honest about what the defaults cost, and the decision moves to the
              gate that owns it. */}
          <p className="text-xs text-on-raised-muted">
            The estimate below assumes these defaults. Changing them at their gate changes what you pay from
            that gate onward — nothing already spent.
          </p>
        </div>
      </section>

      {/* --- the estimate ------------------------------------------------------------------------ */}
      <section
        data-testid="estimate-panel"
        data-pending={String(estimatePending)}
        className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card"
      >
        <div className="flex flex-col gap-1">
          <div className="flex flex-col gap-0.5">
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

        {/* HOW LONG, beside HOW MUCH. Rendered for every mode including preview — a mode whose duration is
            blank reads as unknown when it is in fact the shortest and cheapest of the three. */}
        {!estimatePending && time.mid > 0 && (
          <div
            data-testid="estimate-duration"
            data-low={String(Math.round(time.low))}
            data-mid={String(Math.round(time.mid))}
            data-high={String(Math.round(time.high))}
            data-mode={runMode}
            className="flex flex-col gap-1 border-t border-rule-on-raised pt-2"
          >
            <div className="flex items-baseline justify-between gap-4 text-xs">
              <span className="text-on-raised">Estimated time</span>
              <span
                data-testid="estimate-duration-range"
                className="shrink-0 tabular-nums text-on-raised"
              >
                about {formatDurationRange(time)}
              </span>
            </div>
            {/* A RANGE, hedged. Never one figure and never a promise: the estimate covers the work, and
                for batch the provider's queue sits in front of the work and is not ours to predict. */}
            <p className="max-w-[68ch] text-xs text-on-raised-muted">
              {runMode === "batch"
                ? "A rough estimate of the work, not a commitment. A batch run also waits in the " +
                  `provider's queue before it starts${time.note ? `, and ${time.note}` : ""} — a busy ` +
                  "queue can push a batch run out by hours, so a long quiet stretch is normal for batch " +
                  "rather than a stalled run."
                : runMode === "preview"
                  ? "A rough estimate, not a commitment. Preview runs entirely on this machine — no " +
                    "model is called and nothing waits on a provider, which is why it is the quickest " +
                    "of the three."
                  : "A rough estimate, not a commitment. A synchronous run calls the model variable by " +
                    "variable, so it scales with how many variables the run covers."}
            </p>
          </div>
        )}

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

            {/* The judge's workload in GROUPS, not dollars — the money above means little without it. The
                caveat that under-six groups are left explicitly unjudged (not "coherent") is real and
                load-bearing, but it is a footnote, so it is a tooltip rather than a paragraph. */}
            <p data-testid="coherence-workload" className="text-xs text-on-raised-muted">
              {estimate.judgeCalls > 0 ? (
                <>
                  Coherence judge priced for{" "}
                  <span className="font-semibold text-on-raised">
                    {estimate.judgeCalls.toLocaleString()} {estimate.judgeCalls === 1 ? "group" : "groups"}
                  </span>{" "}
                  {estimate.judgeCallsEstimated ? "(estimated)" : "(counted)"}
                  <InfoTip
                    label="How the coherence judge is priced"
                    text={
                      `Only groups of at least six variables are judged — below that the judge cannot form a ` +
                      `disjoint sample to verify against. ${estimate.judgeCallsEstimated
                        ? "This run's groups do not exist yet, so the count is estimated from corpus size."
                        : "Counted from this run's own groups."} ` +
                      `Smaller groups are left explicitly UNJUDGED and marked as such — which is not the ` +
                      `same as coherent. A judge that was never asked has not approved anything.`
                    }
                  />
                </>
              ) : (
                <>
                  No group can reach six variables, so the judge is not asked:{" "}
                  <span className="font-semibold text-on-raised">$0</span>
                  <InfoTip
                    label="Why the line still shows"
                    text={
                      "The line stays on the bill at zero rather than disappearing, because a line that " +
                      "vanishes is indistinguishable from a stage nobody costed. Those groups will be " +
                      "marked NOT JUDGED, which is not the same as coherent."
                    }
                  />
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
                You pay gate by gate. First charge: Continue at Gate 0, about{" "}
                {formatUsd(estimate.firstCharge)}.
              </span>{" "}
              Each gate quotes its own cost from the real run before you commit to it.
              <InfoTip
                label="What the first charge buys, and what is free"
                text={
                  "Everything up to that point can be abandoned at no cost: setting up, loading, preparing " +
                  "and grouping your dictionaries, and reading Gate 0's review. Pressing Continue at Gate 0 " +
                  "is what buys the next step — a candidate element generated per group, groups that fuse " +
                  "more than one concept split apart, and the coherence judge. From there every gate is its " +
                  "own decision: you can stop after any of them and keep what you have already paid for."
                }
              />
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
              These are estimates, not quotes.
              <InfoTip
                label="Why this is a range"
                text={
                  "Derived from observed runs on other corpora. The paid stages scale with the number of " +
                  "concept GROUPS, which do not exist until clustering has run, rather than linearly with " +
                  "variable count — so the figure can only be a range until the groups are real. Each gate " +
                  "re-quotes from this run's actual groups before you commit, and those numbers are the " +
                  "ones that bind."
                }
              />
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
      <div className="flex flex-col gap-3 rounded-card bg-surface-raised px-6 py-4 shadow-card">
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
        <div className="flex flex-col items-start gap-1">
          <Button
            type="button"
            data-testid="start-run"
            onClick={onStart}
            disabled={blockers.length > 0 || starting || IS_STATIC}
          >
            {starting && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />}
            Start run
          </Button>
          <p data-testid="nothing-charged-yet" className="text-xs text-on-raised-muted">
            Nothing is charged yet.
          </p>
        </div>
      </div>
        </div>
      </div>
    </GateShell>
  );
}
