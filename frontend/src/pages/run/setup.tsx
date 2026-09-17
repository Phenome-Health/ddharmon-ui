import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { ChevronDown, Eye, EyeOff, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { GateShell, railFor, realizedRailArgs } from "@/components/gate/GateShell";
import { GateEmptyState } from "@/components/gate/GateEmptyState";
import { CommitBar } from "@/components/gate/CommitBar";
import { DictionaryMappingTable } from "@/components/gate/DictionaryMappingTable";
import { ColumnRolesPanel } from "@/components/gate/ColumnRolesPanel";
import { DictionaryTipsPanel } from "@/components/gate/DictionaryTipsPanel";
import {
  DictionaryEmbeddingExport,
  PreparedExport,
  WorkbookExport,
} from "@/components/gate/PreparedExport";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useHarmonizeStream } from "@/hooks/use-harmonize-stream";
import { InfoTip } from "@/components/ui/info-tip";
import {
  GATE_ORDER,
  IS_STATIC,
  embeddingCsv,
  embeddingWorkbook,
  listDemos,
  listModels,
  resumeRun,
  saveBlob,
  startHarmonize,
} from "@/lib/api";
import { RETIRED_GATE, pathForGate, startedPathFor } from "@/lib/gate-routes";
import { estimateRunCostBreakdown, formatUsd } from "@/lib/estimate";
import { participantLevelColumn, type DictRow } from "@/lib/dictionary";
import { preparationProgress } from "@/lib/run-state";
import { lookupPrefill, rememberAssignment } from "@/lib/column-prefill";
import { PROVIDER_KEY_INFO } from "@/lib/provider-keys";
import { COLUMN_ROLES, PROVIDER_LABELS, estimateRunTime, formatDuration, formatDurationRange } from "@/types";
import demoManifest from "@/data/demo-column-assignments.json";
import { GATE_LABELS } from "@/components/gate/GateRail";
import type { CdeSet, GatePosition, JobResult, RunMode } from "@/types";

/**
 * PER-LINE DETAIL FOR THE CONSOLIDATED BILL (review 2026-08-26).
 *
 * Setup used to render three blocks: informational cards for the three opt-in run options, then a list of
 * stage costs, then a list of per-gate forecasts. The reviewer's verdicts, in order: the cards are
 * redundant with the estimate beneath them and their tooltips belong on the cost lines; and nothing tied
 * an itemised cost to the gate where its go/no-go decision is actually made. So all three collapse into
 * ONE list, grouped by gate, and this map carries what the cards used to say.
 *
 * `help` is the card's own tooltip text, kept verbatim where it was already reviewed. `optIn` marks the
 * three lines that are a CHOICE rather than an inevitability — rendered with their default and the gate
 * that owns the decision, which is the whole content of the deleted cards.
 *
 * Keyed by `CostLine.id`, so a label can be rewritten without breaking the mapping.
 */
const LINE_HELP: Record<string, { help: string; optIn?: { on: boolean; decidedAt: string } }> = {
  embedding: {
    help:
      // Phrased to NAME WHERE THE CHARGE LANDS, which is what the content-drift truth gate
      // `test_no_public_surface_claims_the_staged_flow_is_free` requires of any sentence that pairs a
      // free claim with a staged-flow subject. My first version said "…it is why Gate 0 is free to
      // reach" — true (reaching Gate 0 IS free; its Continue is the first charge) but exactly the
      // ambiguous shape the gate exists to catch, because a skimming reader sees "Gate 0 is free".
      // The gate's own passing fixture is the model: "Starting costs nothing — the first charge is
      // Continue at Gate 0."
      "Grouping your variables runs on this machine — embedding, dimensionality reduction and " +
      "clustering. No provider is called, so this step costs nothing; the first charge is the Continue " +
      "button on this screen, once your dictionaries are prepared.",
  },
  ideal: {
    help:
      "For each group, a description of what the ideal common data element WOULD be, written before any " +
      "catalogue candidate is retrieved. Deliberately shown no candidates, so it describes the concept " +
      "your variables actually share instead of rationalising whatever retrieval happened to return.",
  },
  split: {
    help:
      "Clustering over-merges: a group can fuse blood pressure with pulse because they travel together " +
      "in a dictionary. This step partitions such a group into its distinct concepts before anything is " +
      "matched, which is why it is Gate 1's — Gate 1 reviews the groups it produces.",
  },
  assign: {
    help:
      "Each post-split group is re-retrieved on its own and ranked against the catalogue, then given a " +
      "verdict: adopt an existing element, refine one with a value transform, or route to novel. This is " +
      "the largest single stage in a run.",
  },
  coherence: {
    help:
      "A second model reads each group and says whether its members are really one concept. Only groups " +
      "of at least six variables are judged — below that the judge cannot form a disjoint sample to " +
      "verify against, so smaller groups are left explicitly UNJUDGED and marked as such. That is not " +
      "the same as coherent: a judge that was never asked has not approved anything.",
  },
  gencde: {
    help:
      "Where no catalogue element fits, one is generated so the residual has a target instead of being " +
      "dropped. Generated elements are marked as generated and carry no catalogue identifier.",
  },
  specgen: {
    help:
      "The recipe that converts your values into the form the matched element expects — value recodes " +
      "for categoricals, unit and arithmetic conversions for numerics. Without it you get matches but no " +
      "instructions for actually transforming your data.",
    optIn: { on: true, decidedAt: "Gate 3" },
  },
  conceptGate: {
    help:
      "One call per group that got matched to an element, asking whether the element it was matched TO " +
      "is the right one. It exists because value coverage is not evidence of meaning: two 1-5 Likert " +
      "items map cleanly onto each other, so a recode reads 100% covered even when one asks how " +
      "confident you are filling out medical forms and the other asks whether you felt happy. Flags the " +
      "suspect recodes at Gate 3; never changes a verdict on its own.",
    optIn: { on: false, decidedAt: "Gate 2" },
  },
  analysisIdeas: {
    help:
      "One pass over the finished concepts, proposing cross-cohort analyses this harmonization makes " +
      "possible. A small flat add, independent of corpus size. It suggests; it never runs anything.",
    optIn: { on: true, decidedAt: "the results page" },
  },
};

/** What each pause point charges for, in words, when it charges nothing. */
const GATE_FREE_REASON: Partial<Record<GatePosition, string>> = {
  setup: "local — no charge",
  gate0: "local — no charge",
  gate4: "no charge",
};

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
 * and including the free boundary below is local, so nothing is charged yet, and the figure quoted here is
 * the one the reviewer consents to — on the control this screen now carries itself. Every other element on the screen exists to stop something being lost or
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
 * THREE STATES SINCE THE GATE 0 DEMOTION (2026-08-26; pre-build question Q1, answered Option B). Gate 0
 * was retired as a screen and its content moved here as a FREE PRE-FLIGHT — free until the first charge,
 * which this screen's own control now commits.
 *
 * (Both halves of that reconciling phrase have to sit on ONE line. `test_no_public_surface_claims_the_
 * staged_flow_is_free` reads SOURCE text, so a comment wrap between "first" and "charge" splits the very
 * words that reconcile the claim and the gate convicts a true sentence.)
 *
 * So this screen now spans the whole local, unpaid part of a run:
 *
 *  1. **`compose`** — no run yet. Exactly what it was before: drop files, map columns, price the run.
 *  2. **`preflight`** — the run has been started and has not yet passed the free boundary. The state
 *     keeps its name because the BOUNDARY keeps its name: `08-DECISION-GATE0.md` D-3 leaves the backend
 *     pause at `gate0: before_harmonize` exactly as built. The run parks before `harmonize_leanb` is ever
 *     called, so this state costs nothing and the control that commits the first charge is the one thing
 *     on it that spends. The dictionaries collapse to a summary disclosure, since their column roles are
 *     fixed for this run.
 *  3. **`past`** — the run has moved beyond that boundary, or finished. It renders as a read-back with a
 *     link back into the run. NO commit control is offered — that charge has already happened, and
 *     re-offering it would be a false claim about the run.
 *
 * WHAT 08-14d REMOVED. 08-14b put the demoted Gate 0's preprocessing report in the left column of states
 * 2 and 3. Bhargav retired it on 2026-08-31 after reading it live: the verbosity buried the screen and the
 * phase's value is in Gates 1-4. The report is deleted; the boundary, the first charge and the
 * prepared-dictionary export (D-5) are not.
 *
 * THE STATE IS DERIVED FROM THE RUN, NOT STORED. `useHarmonizeStream` is already subscribed at the top of
 * this component and everything below reads THAT — a second subscription beside it would be two sources
 * for one run's state, which is the defect the shell's own stop control was written to avoid.
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
  /**
   * The mapping AS CONFIRMED by the reviewer, or null while it has not been.
   *
   * A MAPPING, NOT A BOOLEAN, and that is the whole design. Confirmation has to invalidate the moment a
   * column is re-assigned — a reviewer downloading a CSV that describes a mapping they have since edited,
   * and believing it, is worse than no download at all. Holding the confirmed mapping makes that
   * invalidation STRUCTURAL: `confirmedRoles` simply stops matching `roles`, with no effect to remember
   * to fire and nothing to keep in sync.
   */
  confirmedRoles: Record<string, string> | null;
  state: ParseState;
  origin: "run" | "upload";
}

/** Two role -> column mappings are the same mapping. Order-insensitive: the object is rebuilt on edit. */
function sameRoles(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Whether this dictionary's CURRENT mapping is the one the reviewer marked complete. */
function isConfirmed(d: SetupDict): boolean {
  return d.confirmedRoles !== null && sameRoles(d.confirmedRoles, d.roles);
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
 * Two shapes, because two kinds of run exist. A run started from the New Run form exposes its column
 * mapping as `job.dictionaries` (filename, cohort, column roles — the backend's roles-only projection of
 * the persisted dict_specs). The shipped demo run persists only its dataset
 * ids, so its dictionaries are recovered from the manifest that produced them plus the demo catalogue's
 * own field counts — both shipped provenance, neither invented here.
 */
function dictionariesFromRun(job: JobResult | null): SetupDict[] {
  const config = (job?.config ?? {}) as Record<string, unknown>;
  // The run's own column mapping, read from the backend's roles-only projection of its persisted
  // dict_specs (`job.dictionaries`). run_config keeps no dictionaries, so this — not `config` — is the
  // source for a run started from the New Run form.
  const declared = job?.dictionaries;
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
        confirmedRoles: null,
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
        confirmedRoles: null,
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
  const { jobState, cancel, error: streamError, reconnecting } = useHarmonizeStream(jobId, true, true);
  const costSoFar = jobState?.costSoFar ?? jobState?.result?.cost?.actualUsd ?? 0;

  const [dicts, setDicts] = useState<SetupDict[]>([]);
  const [problems, setProblems] = useState<FileProblem[]>([]);

  // --- run configuration. Same vocabulary as the shipped New Run form, so a run described here and a run
  // described there are the same object. `conceptGate` is the one addition (STGD-16) and defaults OFF.
  const [cdeSet, setCdeSet] = useState<CdeSet>("endorsed");
  const [runMode, setRunMode] = useState<RunMode>("batch");
  // THE RUN'S DEFAULTS, not controls. All three decisions moved to the gate that owns them (08-16
  // amendment for the first and third, 08-17 for the second), and the 2026-08-26 review then removed the
  // informational cards that restated them here — the consolidated bill below now shows each one under its
  // gate with its cost and its default, which is the same information without a second block to read.
  // Setters are deliberately absent: nothing on this screen may change them.
  const [genSpecs] = useState(true);
  const [suggestIdeas] = useState(true);
  const [conceptGate] = useState(false);
  /**
   * Re-adjudication: OFF by default, and a real control rather than a fixed default (08-16c Task 4).
   *
   * Bhargav asked *"where does user get to enable re-split for a run?"* and the honest answer was nowhere.
   * Everything downstream is built — the backend reads `allowReadjudication` at creation, `/readjudicate`
   * 409s without it, and `CarveProposal` already renders both branches — so the checkbox was the only
   * missing piece.
   *
   * IT STAYS OFF BY DEFAULT. The backend's own reasoning is that a run only pays for a stage it asked for,
   * and the endpoint carries three separate refusals precisely so a flagged group is never auto-resolved.
   * The control makes the choice AVAILABLE; it does not make it the default.
   */
  const [allowReadjudication, setAllowReadjudication] = useState(false);
  const [displayName, setDisplayName] = useState("");
  // BYOK: component memory only. Never persisted, never echoed back, cleared on reload.
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("anthropic");
  /** Reveal the key field. Rendering only — the key itself is never persisted either way. */
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState("");
  const [starting, setStarting] = useState(false);
  /** Whether the read-back of the dictionaries is expanded. Closed by default — see below. */
  const [dictsOpen, setDictsOpen] = useState(false);
  /** True while the run's first charge is being committed. */
  const [committing, setCommitting] = useState(false);
  // The pre-Start export's own state. Per-dictionary busy/note/error are keyed by dictionary, because a
  // failure on one file must not read as a failure of the set.
  const [runConfirmed, setRunConfirmed] = useState(false);
  const [exportBusy, setExportBusy] = useState<Record<string, boolean>>({});
  const [exportNote, setExportNote] = useState<Record<string, string | undefined>>({});
  const [exportError, setExportError] = useState<Record<string, string | undefined>>({});
  const [workbookBusy, setWorkbookBusy] = useState(false);
  const [workbookError, setWorkbookError] = useState<string | undefined>(undefined);
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
   * The dictionaries the pre-Start export can actually be built from — the ones read in THIS browser.
   *
   * A run-seeded entry is a read-back with no `File` behind it, so it can be neither confirmed nor
   * exported. Counting it towards "how many are still to be marked complete" would give the reviewer an
   * outstanding item they have no control that can clear.
   */
  const uploadedDicts = useMemo(() => dicts.filter((d) => d.origin === "upload" && d.file), [dicts]);

  /** A run that has already moved past Setup is a read-back: its configuration cannot be changed. */
  const runStarted = Boolean(jobState?.status && jobState.status !== "pending");

  /**
   * Which of the three states this screen is in — see the file docstring.
   *
   * `preflight` is *"started, and not past the pre-flight boundary"*, and it is deliberately written as
   * two facts about the RUN rather than one:
   *
   *  - **parked at it** — `awaiting_review` AT the retired position. That is the wire value the backend
   *    still emits (D-3) and the only state in which the first charge has not happened yet.
   *  - **on its way to it** — started, not terminal, and carrying NO gate position at all, which is the
   *    window between Start and the first checkpoint.
   *
   * `gatePosition` alone is not enough for either. It is NOT cleared when a run resumes (`app.py`'s
   * resume endpoint sets only `status`/`phase`), so a run running from the retired position TOWARD Gate 1
   * still reports it — and offering the first charge there would offer to buy work already bought. The
   * `awaiting_review` half is what excludes that.
   */
  const gatePosition = jobState?.gatePosition ?? jobState?.result?.gatePosition ?? null;
  const atPreflightBoundary = jobState?.status === "awaiting_review" && gatePosition === RETIRED_GATE;
  //
  // NARROWED IN 08-14f, and the narrowing is a safety property rather than a tidy-up. `preflight` used to
  // also cover "started, not terminal, carrying no gate position" — the window between Start and the
  // first checkpoint, which every fresh run passed through. Fresh runs now enter at Gate 1 and never park
  // at the retired position, so that arm would offer the first-charge control for a run whose first
  // charge has ALREADY been committed by Start. Only a run genuinely parked at the retired boundary — the
  // six that exist today — still gets it.
  const stage: "compose" | "preflight" | "past" = !runStarted
    ? "compose"
    : atPreflightBoundary
      ? "preflight"
      : "past";

  /**
   * WHY A PAST SETUP'S CONTROLS ARE STILL INTERACTIVE — investigated under 08-16c Task 2, left as found.
   *
   * The rail now links BACK here, so a reviewer reaches this screen on purpose and the question "can a
   * record still be edited?" became live. It cannot: in the `past` stage this screen offers NO submit
   * path — Start belongs to `compose` and the first-charge control to `preflight` — so `cdeSet`,
   * `runMode`, the key and the rest drive nothing but the local cost/duration read-out beside them. They
   * are calculators here, not decisions, which is why the run genuinely cannot be changed from this screen
   * and why disabling them was NOT done: seven existing specs steer exactly these controls on this route
   * to assert the estimate's behaviour, and they are right to — the panel is where that behaviour lives.
   *
   * The freeze that IS enforced is the one that matters: every gate DECISION (`gate1_group_scope`,
   * `gate1_regroup`, `gate2_*`, `gate3_spec_edit`) refuses at the write path in `use-gate-decisions` when
   * its gate is past. Setup writes no decisions, so it has nothing to refuse.
   */


  /**
   * How far preparation has got — ONE derivation, read by the estimate above and by the control that
   * commits this run's first charge.
   *
   * IT LIVES IN `lib/run-state.ts` SINCE 08-14d. It arrived here inside the pre-flight panel, deleted
   * along with the rest of the preprocessing report; this predicate is not part of that report. It answers
   * *"is the free leg finished?"*, which is a fact about the run and a precondition for spending money.
   */
  const preparation = useMemo(() => preparationProgress(jobState), [jobState]);

  /**
   * Where a run that is PAST the pre-flight should be rejoined.
   *
   * The retired position is mapped forward rather than linked to: its URL redirects back to this screen,
   * so offering it as the way onward would be a loop. `GATE_ORDER` is the WIRE order and is what knows
   * which position follows it.
   */
  const resumeAt: GatePosition = useMemo(() => {
    if (!gatePosition || gatePosition === RETIRED_GATE) {
      return GATE_ORDER[GATE_ORDER.indexOf(RETIRED_GATE) + 1] ?? "gate1";
    }
    return gatePosition;
  }, [gatePosition]);

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
    // THE RUN'S OWN CORPUS WINS AT THE PRE-FLIGHT. There the rules have already run, so the real variable
    // counts are on the report and they are a better denominator than the `est_fields` this run was
    // quoted at before a file was parsed — and this is the state whose control commits the first charge,
    // so it is the one where the denominator has to be the real one.
    //
    // Read ONLY when every declared cohort has finished: a sum over the cohorts that happen to have
    // reported is not a smaller estimate, it is an UNDER-QUOTE that looks finished (R8). Scoped to this
    // state for the same reason the mode override is — see `effectiveRunMode`.
    if (stage === "preflight" && preparation.allPrepared && preparation.variables > 0) {
      return { totalFields: preparation.variables, sizePending: false };
    }
    if (!dicts.length) return { totalFields: 0, sizePending: false };
    const counts = dicts.map(variableCount);
    if (counts.every((n) => n !== null)) {
      return { totalFields: counts.reduce((a, b) => a + (b ?? 0), 0), sizePending: false };
    }
    const config = (jobState?.config ?? {}) as Record<string, unknown>;
    const persisted = typeof config.est_fields === "number" ? config.est_fields : null;
    if (persisted !== null) return { totalFields: persisted, sizePending: false };
    return { totalFields: null as number | null, sizePending: true };
  }, [dicts, variableCount, jobState, stage, preparation.allPrepared, preparation.variables]);

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

  /**
   * The mode the quote is computed at.
   *
   * A RUN AT THE PRE-FLIGHT IS PRICED AT ITS OWN MODE, not at this screen's local default. `runMode` is
   * component state seeded to `batch`, and nothing seeds it from the run — so a PREVIEW run sitting at the
   * boundary would be quoted as a batch run and, by the control beside it, told it was about to spend on a
   * leg that calls no model. Quoting a charge that will not happen is the same class of error as
   * under-quoting one, and R8 binds in both directions.
   *
   * SCOPED TO THE `preflight` STATE on purpose. That is the only state carrying a control that spends, so
   * it is the only one where the local default can cause a false claim about money. Elsewhere the mode
   * select stays a live control over the quote, which is what it is for while a run is being composed.
   *
   * `run_mode` is the key the backend persists (`app.py` writes it from the form's `runMode`). The demo
   * fixtures carry a different `mode` key describing the demo, not the run, and it is deliberately NOT
   * read here: reinterpreting one key as another is how a figure comes to describe the wrong thing.
   */
  const effectiveRunMode: RunMode = useMemo(() => {
    if (stage !== "preflight") return runMode;
    const declared = ((jobState?.config ?? {}) as Record<string, unknown>).run_mode;
    return typeof declared === "string" ? (declared as RunMode) : runMode;
  }, [stage, runMode, jobState?.config]);

  /**
   * How many cohorts the quote is for.
   *
   * MEASURED ON A LIVE RUN, not on the fixture. A run-seeded page now knows its dictionaries: the backend
   * projects the run's persisted roles as `job.dictionaries`, which `dictionariesFromRun` reads, so
   * `dicts.length` is the real cohort count for a run-seeded page (before that projection it was ZERO — a
   * wrong number that, once the commit control moved here, would have mis-stated the figure on the button,
   * the one number on this screen that must not be wrong).
   *
   * At the pre-flight the run knows its own cohorts — one preparation report each — so that is the count
   * used. Everywhere else the composed list is still the only source there is.
   */
  const corpusCohorts =
    stage === "preflight" && preparation.cohorts.length > 0 ? preparation.cohorts.length : dicts.length;

  const estimate = useMemo(
    () =>
      totalFields === null
        ? null
        : estimateRunCostBreakdown(totalFields, corpusCohorts, effectiveRunMode, genSpecs, suggestIdeas, {
            conceptGate,
            groupSizes,
          }),
    [totalFields, corpusCohorts, effectiveRunMode, genSpecs, suggestIdeas, conceptGate, groupSizes],
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
    () => estimateRunTime(totalFields ?? 0, corpusCohorts, effectiveRunMode),
    [totalFields, corpusCohorts, effectiveRunMode],
  );

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
          confirmedRoles: null,
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
    // The run-level confirmation is dropped on ANY mapping edit. Per-dictionary confirmation invalidates
    // structurally (`confirmedRoles` stops matching `roles`); this one is a separate gesture about the
    // whole set, so it has to be dropped explicitly or the workbook would stay on offer for a set the
    // reviewer has since changed.
    setRunConfirmed(false);
    setWorkbookError(undefined);
  }
  function removeDict(key: string) {
    composed.current = true;
    setDicts((prev) => prev.filter((d) => d.key !== key));
    setRunConfirmed(false);
    setWorkbookError(undefined);
  }

  /**
   * PER-DICTIONARY EXPORT: mark the mapping complete, then take that dictionary's embedding-text CSV.
   *
   * Everything here is FREE and starts no run — the endpoint is job-less by construction, because the
   * file is still in the browser at this point. That is what makes the new flow better than the one it
   * replaces: the reviewer can read the exact clustering input, in Excel, before spending anything.
   */
  function confirmMapping(key: string) {
    setDicts((prev) => prev.map((d) => (d.key === key ? { ...d, confirmedRoles: { ...d.roles } } : d)));
  }

  async function downloadEmbeddingCsv(d: SetupDict) {
    if (!d.file) return;
    setExportBusy((prev) => ({ ...prev, [d.key]: true }));
    setExportError((prev) => ({ ...prev, [d.key]: undefined }));
    try {
      const out = await embeddingCsv({ file: d.file, cohortName: d.cohortName, columnRoles: d.roles });
      saveBlob(out.blob, out.filename);
      // THE SERVER'S OWN COUNTS, reported back on the screen. The live `nameCheck` in the mapping table
      // already tells the reviewer their file repeats a name; this says what the LOADER did about it,
      // which is the half no client-side check can know.
      const parts = [`${out.rows.toLocaleString()} rows · ${out.variables.toLocaleString()} variables`];
      if (out.collapsed > 0) {
        parts.push(
          `${out.collapsed.toLocaleString()} ${out.collapsed === 1 ? "row was" : "rows were"} collapsed onto a repeated variable name` +
            (out.repeatedNames.length ? ` (${out.repeatedNames.slice(0, 5).join(", ")})` : "") +
            " and carry no text",
        );
      }
      if (out.nothingToEmbed > 0) {
        parts.push(
          `${out.nothingToEmbed.toLocaleString()} ${out.nothingToEmbed === 1 ? "row embeds" : "rows embed"} nothing and will reach no concept group`,
        );
      }
      setExportNote((prev) => ({ ...prev, [d.key]: parts.join(" · ") }));
    } catch (e) {
      setExportError((prev) => ({ ...prev, [d.key]: e instanceof Error ? e.message : "Export failed" }));
    } finally {
      setExportBusy((prev) => ({ ...prev, [d.key]: false }));
    }
  }

  async function downloadWorkbook() {
    const mapped = dicts.filter((d) => d.file).map((d) => ({ file: d.file!, cohortName: d.cohortName, columnRoles: d.roles }));
    setWorkbookBusy(true);
    setWorkbookError(undefined);
    try {
      const out = await embeddingWorkbook(mapped);
      saveBlob(out.blob, out.filename);
    } catch (e) {
      setWorkbookError(e instanceof Error ? e.message : "The workbook could not be built");
    } finally {
      setWorkbookBusy(false);
    }
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
   * Start the run and hand off to the free boundary — which is THIS screen, in its second state.
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
          allowReadjudication,
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
      // ONE navigation, STRAIGHT TO GATE 1 (08-14f). It used to come back here, into a "pre-flight" state
      // whose Continue was the real first charge — so Start bought nothing and the reviewer met an
      // intermediate screen before the run began. The free inspection that screen existed for now happens
      // BEFORE Start, per dictionary. The target lives in `startedPathFor` so it can be asserted directly;
      // its docstring records why the retired path must never be it.
      navigate(startedPathFor(started));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start this run");
    } finally {
      setStarting(false);
    }
  }

  /**
   * The dictionaries and their column mapping — one JSX value, rendered either open or inside the
   * boundary state's disclosure. Held in a variable rather than duplicated: two copies of a mapping table is
   * two places for an empty state, an overflow rule and an honest-absence branch to drift apart.
   */
  const dictionariesSection = (
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

        {dicts.length === 0 && runStarted ? (
          /* A STARTED RUN WHOSE RECORD CARRIES NO PER-DICTIONARY COLUMN ROLES — now only a legacy run from
             before the backend projected its persisted dict_specs as `job.dictionaries` (a current run reads
             that and renders its mapping below). Rendering the compose empty state here would read as "this
             run had no dictionaries", a claim about the RUN and a false one. The cohorts it covers are the
             ones the export above lists, one file each. */
          <div className="rounded-card bg-surface-raised shadow-card">
            <GateEmptyState
              heading="This run kept no record of its column mapping"
              nextStep="Download a prepared dictionary above to see exactly what each file gave the model."
            >
              The run stores the prepared dictionaries, not the mapping that produced them, so there is
              nothing here to read back. That is a gap in what the run records — not a run without
              dictionaries.
            </GateEmptyState>
          </div>
        ) : dicts.length === 0 ? (
          <div className="rounded-card bg-surface-raised shadow-card">
            <GateEmptyState
              heading="No dictionaries yet"
              nextStep="Drop one file per cohort above. Reading, mapping and exporting them costs nothing — the first charge is Start run."
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

              {/* PER-DICTIONARY CONFIRMATION AND EXPORT, compose stage only. A started run's column roles
                  are fixed at `startHarmonize`, so there is nothing left to confirm and the job-scoped
                  export above is the one that applies. A run-seeded read-back has no File to post. */}
              {stage === "compose" && d.state !== "parsing" && d.origin === "upload" && (
                <DictionaryEmbeddingExport
                  cohortName={d.cohortName}
                  confirmed={isConfirmed(d)}
                  canConfirm={hasMeaning(d.roles)}
                  blockedReason={
                    hasMeaning(d.roles)
                      ? undefined
                      : "Map at least a variable name, a description or the question text before marking this dictionary complete — with none of them there is no text to cluster."
                  }
                  onConfirm={() => confirmMapping(d.key)}
                  onDownload={() => void downloadEmbeddingCsv(d)}
                  downloading={Boolean(exportBusy[d.key])}
                  note={exportNote[d.key]}
                  error={exportError[d.key]}
                  available={!IS_STATIC}
                />
              )}
            </article>
          ))
        )}
      </section>
  );

  /**
   * PREVIEW BUYS NOTHING, so it must not be told it is about to spend.
   *
   * Preview run mode calls no model: it clusters, builds the prompts and stops. Quoting a charge that
   * will not happen is the same class of error as under-quoting one, and R8 binds in both directions.
   */
  const isPreview = effectiveRunMode === "preview";

  /**
   * Commit the run's first charge — the control the retired gate used to carry (UI-SPEC §0.1 as amended
   * by D-3).
   *
   * AND THEN LEAVE. The retired screen stayed put after resuming, which was harmless there because it
   * was the run's own screen. Here it is not: the moment the charge lands this run is past the
   * boundary, and a reviewer left on Setup would watch it turn into a read-back of a decision they
   * just made. `resumeRun` returns the gate it is heading for, so that is where they go.
   */
  async function onCommitFirstCharge() {
    setCommitting(true);
    try {
      const { target } = await resumeRun(jobId);
      toast.success(`Continuing to ${GATE_LABELS[target as GatePosition] ?? target}`);
      // Through the helper, not an inline template. `next_gate("setup")` is the RETIRED position — it is
      // still in `GATE_ORDER` — so this call site could genuinely receive `gate0` and send the reviewer to
      // a URL that redirects straight back to this screen: Setup -> retired -> Setup, on the run's very
      // first transition, and invisible to any check that reads only the final url. `pathForGate` owns
      // that translation for every caller (08-16c Task 8).
      navigate(pathForGate(jobId, target));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not continue this run");
    } finally {
      setCommitting(false);
    }
  }

  return (
    <GateShell
      gate="setup"
      // The rail navigates backwards from here (08-16c Task 2); a shell with no jobId renders it inert.
      jobId={jobId}
      subhead={
        // THREE STATES, THREE SENTENCES, because two of them make a claim about money and the claim is
        // different in each. A run PAST this point has already been charged, so the compose subhead's
        // "nothing is charged until you press Start run" would be false of the run in front of the
        // reviewer — it was false in the old wording too, and it is not a thing to carry forward while
        // relocating the charge.
        stage === "preflight"
          ? "Your dictionaries are loaded, prepared and grouped, all on this machine. Commit the run's first charge when you are ready — nothing has been charged for anything so far."
          : stage === "past"
            ? "What this run was set up with. It is a record now, not a decision — the column mapping is fixed for a run that has started, and this run is already past its first charge."
            : "Add a data dictionary per cohort, map its columns, and choose how the run should be priced. Mark each dictionary complete to export the exact text that will be clustered — all of that is free. Nothing is charged until you press Start run."
      }
      rail={railFor("setup", realizedRailArgs(jobState?.result?.cost, costSoFar))}
      runName={jobState?.displayName}
      costSoFar={costSoFar}
      // Inherited from the shell (08-14 Task 4): the stop control is placed ONCE in `GateShell`, so a
      // gate's whole part in it is handing over the run and the stream's own `cancel(mode)`.
      job={jobState}
      onStop={cancel}
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

      {/* --- the free boundary (08-14b, stripped back by 08-14d) -----------------------------------

          WHAT USED TO BE HERE. 08-14b moved the demoted Gate 0 onto this screen as a pre-flight report —
          a per-rule pipeline, worked before/after examples, per-cohort findings and declared gaps.
          Bhargav read it live on 2026-08-31 and retired it: the verbosity buried the screen and the
          phase's value is in Gates 1-4. The report is deleted, not hidden.

          WHAT IS LEFT, and why each part earned it. The stream's own status lines, because a stale figure
          must say it is stale. The moved-on note, because a run past this boundary must not read as a live
          decision. And the prepared-dictionary export (D-5) — the reviewer's OWN file handed back, which
          is the one thing here that never depended on the report and is now the only way to see what
          preparation did.

          It reads the run off the subscription this component already has; nothing below opens a second
          one. */}
      {stage !== "compose" && (
        <div className="flex flex-col gap-3">
          {reconnecting && (
            <p role="status" data-testid="stream-reconnecting" className="text-sm font-semibold text-status-warn">
              Lost contact with the server — reconnecting. The figures below are from the last update, not
              live.
            </p>
          )}
          {streamError && (
            <p role="alert" className="text-sm font-semibold text-status-danger">
              {streamError.message}
            </p>
          )}
          {/*
            THE "MOVED ON" NOTE LIVES IN `GateShell` NOW (08-16c Task 2), not here.
            It was written here by 08-14f, when Setup was the only screen a reviewer could arrive at after
            the run had passed it. The rail now links back to EVERY passed gate, so the same sentence is
            needed on all five screens and the shell renders it once for all of them — including the link
            onward, which is the part that stops a reviewer being stranded in the past.
            Keeping this copy as well put the identical sentence on the screen TWICE, a few centimetres
            apart, in two different wordings. One fact, stated once.
          */}
          <PreparedExport jobId={jobId} cohorts={preparation.cohorts.map((c) => c.cohort)} />
        </div>
      )}

      {/* --- dictionaries -------------------------------------------------------------------------

          COLLAPSED ONCE THE RUN IS STARTED (pre-build question Q1, Option B). At the pre-flight the
          mapping is FIXED — a run's column roles are set at `startHarmonize` and changing one means
          starting a fresh run — so five open mapping tables above the findings would be five tables of
          decisions that can no longer be made. It is a disclosure rather than a deletion: the read-back
          is still the record of what this run was configured with, including the honest not-available
          where a run-seeded dictionary genuinely cannot report its unique-name count.

          NOT collapsed in the `past` state, where the screen is a plain read-back and there is no
          finding above it competing for the reader's attention. */}
      {/* --- dictionary-hygiene tips (08-14d) -----------------------------------------------------

          COMPOSE ONLY, and that placement is D-4's rule rather than a layout preference. The advice is
          "tidy the file before you upload it", and a run's column roles are fixed at `startHarmonize` —
          so from the boundary onwards none of it can be acted on without starting again. A recommendation
          shown where it cannot be taken is noise on a screen this plan has just cleared of noise.

          ABOVE the dictionaries, because that is the order the reviewer works in. It matches the shell's
          own how-to disclosure rather than inventing a second pattern, and it is CLOSED, so it costs one
          row until it is asked for. */}
      {/* TWO disclosures, not one. They answer different questions at different moments — "is my file
          clean enough to upload?" and "which column is which?" — and merging them reproduces the
          verbosity that got the first version rewritten. Both CLOSED, so together they cost two rows.

          ROLES FIRST, CHECKLIST SECOND (08-14g Task 2), and the order is load-bearing rather than a
          layout preference: every checklist directive is ABOUT a role — the variable name, the
          description, the question text — so a reviewer who meets the checklist first is being told what
          to do in vocabulary they have not been given yet. Context precedes instruction. Gated in
          `setup.spec.ts`, by geometry rather than by source order, because a flex container can reverse
          what the JSX says. */}
      {stage === "compose" && (
        <div className="flex flex-col gap-2">
          <ColumnRolesPanel />
          <DictionaryTipsPanel />
        </div>
      )}

      {stage === "preflight" ? (
        <Collapsible
          open={dictsOpen}
          onOpenChange={setDictsOpen}
          data-testid="setup-dictionaries-disclosure"
          className="rounded-inner bg-on-field/5 px-4 py-3"
        >
          <CollapsibleTrigger
            aria-label={dictsOpen ? "Hide the dictionaries and their column mapping" : "Show the dictionaries and their column mapping"}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-semibold uppercase tracking-eyebrow text-on-field-muted">
                What this run was set up with
              </span>
              <span data-testid="setup-dictionaries-summary" className="truncate text-sm text-on-field">
                {dicts.length} {dicts.length === 1 ? "dictionary" : "dictionaries"}
                {totalFields === null ? "" : ` · ${totalFields.toLocaleString()} variables`} · the column
                mapping is fixed for this run
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-4 w-4 shrink-0 text-on-field-muted transition-transform",
                dictsOpen && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4">{dictionariesSection}</CollapsibleContent>
        </Collapsible>
      ) : (
        dictionariesSection
      )}

      {/* --- the whole set, once every dictionary is mapped (08-14f) ------------------------------

          BELOW the dictionaries, because it is the step after them: the reviewer marks each file
          complete going down the list, and the workbook is what they reach at the bottom. Compose only —
          after Start the mapping is fixed and the job-scoped export above serves the same need. */}
      {stage === "compose" && (
        <WorkbookExport
          total={uploadedDicts.length}
          remaining={uploadedDicts.filter((d) => !isConfirmed(d)).length}
          confirmed={runConfirmed}
          onConfirm={() => setRunConfirmed(true)}
          onDownload={() => void downloadWorkbook()}
          downloading={workbookBusy}
          error={workbookError}
          available={!IS_STATIC}
        />
      )}

        </div>

        {/* ── right: how it runs, what it costs, and starting it (sticky) ── */}
        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-8">
      {/* --- the run's FIRST CHARGE, at the pre-flight (08-14b Task 3) -----------------------------

          IT SITS HERE, IN THE STICKY COLUMN, and that is the property pre-build question Q1 was decided
          on: the screen carrying the run's first charge keeps the amount and the reason on screen
          together, whatever the left column is doing. Appending it under five mapping tables is the exact
          defect the 08-13 two-column review was opened to fix.

          THE AMOUNT IS ON THE BUTTON AND THE IRREVERSIBLE-SPEND STATEMENT IS INLINE, never a modal
          (R8 / UI-SPEC §8.5). A modal on the primary path is met at every gate, always says yes, and by
          the third gate is dismissed unread. `CommitBar` is CONSUMED, not rebuilt.

          ONE FUNCTION, TWO SURFACES. The figure is `estimate.firstCharge` — the same object the bill
          above quotes — so the two amounts a reviewer can see for one press cannot disagree. */}
      {stage === "preflight" && (
        <div className="flex flex-col gap-3">
          {/* ON THE FIELD, so it takes the FIELD's foreground role. It sits outside the commit card on
              the ground, and `text-on-raised-muted` here would be a foreground paired with a surface it
              is not drawn on — the exact drift the three-tier role tokens exist to prevent. */}
          <p data-testid="nothing-charged-yet" className="text-xs text-on-field-muted">
            Nothing is charged yet. Loading, preparing and grouping all ran on this machine.
          </p>
          <CommitBar
            action="Continue to Concept groups"
            total={isPreview || !estimate ? undefined : estimate.firstCharge}
            firstCharge={!isPreview}
            scopeLabel={totalFields === null ? undefined : `${totalFields.toLocaleString()} variables`}
            onCommit={onCommitFirstCharge}
            busy={committing}
            disabled={!preparation.allPrepared || IS_STATIC}
            recheckNotice={
              !preparation.allPrepared
                ? "Some dictionaries are still being prepared. Continue once they finish."
                : isPreview
                  ? "This run is a preview, so this calls no model and buys nothing — it groups your variables and stops."
                  : undefined
            }
          />
        </div>
      )}

      {/* --- run configuration -------------------------------------------------------------------

          NOT RENDERED AT THE PRE-FLIGHT. Every control in it — catalogue, run mode, model, key — is
          fixed once `startHarmonize` has been called, and this screen's copies of them are LOCAL state
          that was never seeded from the run. Leaving them live would offer a reviewer choices that
          change nothing about the run in front of them, which is worse than a disabled control: it is a
          control that lies about what it does. What the run was actually configured with is read back in
          the disclosure on the left. */}
      {stage !== "preflight" && (
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
            <label htmlFor="allow-readjudication" className="flex items-center gap-2 text-xs font-semibold text-on-raised">
              <input
                id="allow-readjudication"
                data-testid="allow-readjudication"
                type="checkbox"
                  checked={allowReadjudication}
                onChange={(e) => setAllowReadjudication(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-rule-control-on-raised"
              />
              Allow re-splitting a group during review
            </label>
            <p className="text-xs leading-relaxed text-on-raised-muted">
              {/*
                SAYS WHAT IT BUYS, IN WORDS, NOT A NUMBER. The cost depends on how many groups the reviewer
                re-splits and how large they are — neither is known here — so quoting a figure this screen
                cannot honour would repeat the error already corrected once on this page (batch quoted as
                faster than sync). It states the unit of charge instead, which is the part that is knowable.
              */}
              Off by default. When on, Gate 1 can send a group back for a further{" "}
              <strong className="font-semibold text-on-raised">split-and-assign pass</strong>, which calls
              the model again and <strong className="font-semibold text-on-raised">costs money each time
              you use it</strong> — charged per re-split, on top of the estimate below, and only when you
              ask for one. Leaving this off does not change what this run costs. It cannot be turned on
              later: the answer is recorded when the run is created so the run keeps matching the price it
              was quoted.
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

      </section>
      )}

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
              {/* THE RUN BEING PRICED, not the controls beside it. On a started run the mode comes from
                  the run's own record and the cohort count from its preparation reports — reading either
                  off local state put "0 dictionaries · batch" above a correctly-priced PREVIEW quote on a
                  live run, which is two readings of one thing disagreeing on the same line. */}
              {totalFields === null
                ? "Working out how many variables this run covers."
                : `${totalFields.toLocaleString()} variables · ${corpusCohorts} ${
                    corpusCohorts === 1 ? "dictionary" : "dictionaries"
                  } · ${effectiveRunMode}`}
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
            data-mode={effectiveRunMode}
            className="flex flex-col gap-1 border-t border-rule-on-raised pt-2"
          >
            {/* CONCISE, with the reasoning in a tooltip (review 2026-08-26). This block previously
                carried a four-line paragraph per mode. The reviewer's verdict: long prose does not earn
                main-display space — shorten it or move it to a tooltip. The numbers stay on screen; the
                explanation of WHY a batch run goes quiet for an hour is one hover away.

                Batch still itemises, because its two terms have nothing in common: the work is minutes and
                predictable from the corpus, the queue is hours and not ours to predict. Sync and preview
                have one term, so one figure is honest and an itemisation would be false precision. */}
            <div className="flex items-baseline justify-between gap-4 text-xs">
              <span className="inline-flex items-baseline gap-1 text-on-raised">
                Estimated time
                <InfoTip
                  label="How the time estimate is derived"
                  text={
                    effectiveRunMode === "batch"
                      ? "An estimate, not a commitment. Batch work is queued by the provider, and the " +
                        "queue — not your corpus — is what makes a batch run long: it does not shrink if " +
                        "your dictionaries are small. Most batches finish within the hour and the provider " +
                        "permits up to 24, so a long quiet stretch is normal for batch rather than a " +
                        "stalled run."
                      : effectiveRunMode === "preview"
                        ? "An estimate, not a commitment. Preview runs entirely on this machine — no model " +
                          "is called and nothing waits on a provider, which is why it is the quickest of " +
                          "the three."
                        : "An estimate, not a commitment. A synchronous run calls the model variable by " +
                          "variable, so it scales with how many variables the run covers."
                  }
                />
              </span>
              {!time.parts && (
                <span
                  data-testid="estimate-duration-range"
                  className="shrink-0 tabular-nums text-on-raised"
                >
                  about {formatDurationRange(time)}
                </span>
              )}
            </div>
            {time.parts && (
              <>
                <div
                  data-testid="estimate-duration-processing"
                  data-low={String(Math.round(time.parts.processing.low))}
                  data-mid={String(Math.round(time.parts.processing.mid))}
                  data-high={String(Math.round(time.parts.processing.high))}
                  className="flex items-baseline justify-between gap-4 pl-3 text-xs"
                >
                  <span className="text-on-raised-muted">Processing this corpus</span>
                  <span className="shrink-0 tabular-nums text-on-raised">
                    about {formatDurationRange(time.parts.processing)}
                  </span>
                </div>
                <div
                  data-testid="estimate-duration-queue"
                  data-low={String(Math.round(time.parts.queue.low))}
                  data-mid={String(Math.round(time.parts.queue.mid))}
                  data-high={String(Math.round(time.parts.queue.high))}
                  className="flex items-baseline justify-between gap-4 pl-3 text-xs"
                >
                  <span className="text-on-raised-muted">
                    Waiting in the provider&rsquo;s queue
                  </span>
                  <span className="shrink-0 tabular-nums text-on-raised">
                    {formatDurationRange(time.parts.queue)}
                    <span className="text-on-raised-muted">
                      {" "}
                      · typically {formatDuration(time.parts.queue.mid)}
                    </span>
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {!estimatePending && estimate && !estimate.free && (
          <>
            {/* ONE BILL, GROUPED BY GATE (review 2026-08-26).

                Replaces three blocks: informational cards for the opt-in options, a flat list of stage
                costs, and a separate list of per-gate forecasts. The reviewer's finding was that nothing
                connected an itemised cost to the gate where its go/no-go decision is made — the screen
                could say what the coherence judge costs and, separately, what Gate 1 costs, without ever
                saying the first is part of the second. On a screen whose only job is informed consent to
                spend, that is the connection that matters.

                Each line now sits under the gate whose Continue buys it, from `CostLine.gate`. The three
                lines that are a CHOICE carry their default and the gate that owns the decision, which is
                all the deleted cards said. Detail is in tooltips, not prose. */}
            <p
              data-testid="first-charge"
              className="border-t border-rule-on-raised pt-2 text-xs text-on-raised"
            >
              <span className="font-semibold">
                You pay gate by gate. First charge {formatUsd(estimate.firstCharge)}, on this
                screen, when you press Start run.
              </span>
              <InfoTip
                label="What the first charge buys, and what is free"
                text={
                  "Everything up to that point can be abandoned at no cost: adding dictionaries, mapping " +
                  "their columns, marking each one complete and exporting the exact text that will be " +
                  "clustered. Pressing Start run here is what buys the first step — the work listed " +
                  "under Concept groups below. From there every gate is its own decision: you can stop " +
                  "after any of them and keep what you have already paid for. Each gate re-quotes from " +
                  "this run's real groups before you commit."
                }
              />
            </p>

            <ul className="flex flex-col gap-2">
              {/* THE RETIRED POSITION DRAWS NO ROW. `byGate` is keyed by the WIRE type and still carries
                  it (D-3), and mapping the keys blindly printed a bill line labelled "Load & prepare" for
                  a screen the flow no longer has — beside Setup's own row, which describes the very same
                  free local leg. One leg, one line. */}
              {(Object.keys(estimate.byGate) as GatePosition[])
                .filter((gate) => gate !== RETIRED_GATE)
                .map((gate) => {
                const g = estimate.byGate[gate];
                // SETUP ABSORBS THE RETIRED POSITION'S LINES. The estimator files embedding + clustering
                // under `gate0` because that leg used to be Gate 0's; it is Setup's now, and the work
                // itself did not move an inch. Filing it here keeps the $0 local line VISIBLE — dropping
                // the phantom row without re-homing its lines would have deleted the one place the bill
                // says that grouping calls no provider.
                const own = estimate.lines.filter(
                  (l) => l.gate === gate || (gate === "setup" && l.gate === RETIRED_GATE),
                );
                // POTENTIAL, NOT YET CHOSEN. An opt-in that is off produces no cost line, so without this
                // the bill would silently omit the thing the reviewer is being told they can turn on. It
                // renders under its gate with no figure — present, priced as not-included.
                const offer =
                  gate === "gate3" && !conceptGate
                    ? ([{ id: "conceptGate", label: "Concept-match check" }] as const)
                    : ([] as const);
                const free = GATE_FREE_REASON[gate];
                return (
                  <li key={gate} data-gate-forecast={gate} className="flex flex-col gap-0.5">
                    <div className="flex items-baseline justify-between gap-4 text-xs">
                      <span className="font-semibold text-on-raised">{GATE_LABELS[gate]}</span>
                      <span className="shrink-0 tabular-nums text-on-raised">
                        {free ?? `est. ${formatUsd(g.forecast)}`}
                      </span>
                    </div>
                    {(own.length > 0 || offer.length > 0) && (
                      <ul className="flex flex-col gap-0.5 pl-3">
                        {own.map((l) => {
                          const meta = LINE_HELP[l.id];
                          return (
                            <li
                              key={l.id}
                              data-cost-line={l.id}
                              className="flex items-baseline justify-between gap-4 text-xs"
                            >
                              <span className="text-on-raised-muted">
                                <span className="inline-flex items-baseline gap-1">
                                  {l.label}
                                  {meta && <InfoTip text={meta.help} label={`About ${l.label}`} />}
                                </span>
                                {l.note && <span className="ml-1">· {l.note}</span>}
                                {meta?.optIn && (
                                  <span className="ml-1" data-opt-in={String(meta.optIn.on)}>
                                    ·{" "}
                                    <span className="text-on-raised">
                                      {meta.optIn.on ? "on" : "off"}
                                    </span>{" "}
                                    by default, you choose at {meta.optIn.decidedAt}
                                  </span>
                                )}
                              </span>
                              <span className="shrink-0 tabular-nums text-on-raised-muted">
                                {l.cost === 0 ? "$0" : `~${formatUsd(l.cost)}`}
                              </span>
                            </li>
                          );
                        })}
                        {offer.map((o) => {
                          const meta = LINE_HELP[o.id];
                          return (
                            <li
                              key={o.id}
                              data-cost-line={o.id}
                              data-offered="true"
                              className="flex items-baseline justify-between gap-4 text-xs"
                            >
                              <span className="text-on-raised-muted">
                                <span className="inline-flex items-baseline gap-1">
                                  {o.label}
                                  {meta && <InfoTip text={meta.help} label={`About ${o.label}`} />}
                                </span>
                                {meta?.optIn && (
                                  <span className="ml-1" data-opt-in="false">
                                    · <span className="text-on-raised">off</span> by default, you choose at{" "}
                                    {meta.optIn.decidedAt}
                                  </span>
                                )}
                              </span>
                              <span className="shrink-0 tabular-nums text-on-raised-muted">
                                not included
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}

              {/* NO GATE BUYS THIS ONE, which is why the per-gate figures sum to the total less this line.
                  Filed under the run rather than under a gate, so the arithmetic stays checkable. */}
              {estimate.lines.some((l) => l.gate === "after") && (
                <li data-gate-forecast="after" className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-4 text-xs">
                    <span className="font-semibold text-on-raised">After the run</span>
                    <span className="shrink-0 tabular-nums text-on-raised">
                      est.{" "}
                      {formatUsd(
                        estimate.lines
                          .filter((l) => l.gate === "after")
                          .reduce((s, l) => s + l.cost, 0),
                      )}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-0.5 pl-3">
                    {estimate.lines
                      .filter((l) => l.gate === "after")
                      .map((l) => {
                        const meta = LINE_HELP[l.id];
                        return (
                          <li
                            key={l.id}
                            data-cost-line={l.id}
                            className="flex items-baseline justify-between gap-4 text-xs"
                          >
                            <span className="text-on-raised-muted">
                              <span className="inline-flex items-baseline gap-1">
                                {l.label}
                                {meta && <InfoTip text={meta.help} label={`About ${l.label}`} />}
                              </span>
                              {meta?.optIn && (
                                <span className="ml-1" data-opt-in={String(meta.optIn.on)}>
                                  ·{" "}
                                  <span className="text-on-raised">
                                    {meta.optIn.on ? "on" : "off"}
                                  </span>{" "}
                                  by default, you choose at {meta.optIn.decidedAt}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 tabular-nums text-on-raised-muted">
                              ~{formatUsd(l.cost)}
                            </span>
                          </li>
                        );
                      })}
                  </ul>
                </li>
              )}
            </ul>

            <p className="text-xs text-on-raised-muted">
              Estimates, not quotes.
              <InfoTip
                label="Why this is a range"
                text={
                  "Derived from observed runs on other corpora. The paid stages scale with the number of " +
                  "concept GROUPS, which do not exist until clustering has run, rather than linearly with " +
                  "variable count — so the figure can only be a range until the groups are real. Each gate " +
                  "re-quotes from this run's actual groups before you commit, and those numbers are the " +
                  "ones that bind." +
                  (estimate.judgeCalls > 0
                    ? ` The coherence judge is priced for ${estimate.judgeCalls.toLocaleString()} ` +
                      `${estimate.judgeCalls === 1 ? "group" : "groups"}, ` +
                      `${estimate.judgeCallsEstimated ? "estimated from corpus size because this run's groups do not exist yet" : "counted from this run's own groups"}.`
                    : "")
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

      {/* --- start: the run's FIRST CHARGE ---------------------------------------------------------

          COMPOSE ONLY, and that is a correctness constraint rather than a layout one. This block used to
          render in the `past` state too, holding a Start button that a blocker disabled — harmless while
          it was a plain button. It is now the control that commits the first charge, and a bar stating an
          amount and "this is where spending begins" on a run that has ALREADY spent it is a lie about the
          run in front of the reviewer, disabled or not. A run past this point has the read-back note and
          its rejoin link; it does not need a charge control. */}
      {stage === "compose" && (
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
              Ready to start. Uploading, mapping, confirming and exporting all ran on this machine and cost
              nothing — pressing Start run is this run's first charge.
            </p>
          )}
        </div>
        {/* ABOVE the control, and that ordering is asserted: the statement a reviewer needs before they
            press must not be discoverable only after they have. */}
        <p data-testid="nothing-charged-yet" className="text-xs text-on-raised-muted">
          Nothing is charged yet.
        </p>
        {/* --- THE RUN'S FIRST CHARGE (08-14f) -------------------------------------------------

            THE OBLIGATION MOVED WITH THE CHARGE. Until this plan the first charge was the pre-flight's
            Continue, one screen later; deleting that screen relocated the charge here, so this control
            inherits both of its duties verbatim — the AMOUNT ON THE BUTTON and the irreversible-spend
            statement INLINE, never a modal (R8 / UI-SPEC §8.5). `CommitBar` is consumed rather than
            rebuilt, so there is one implementation of that promise on the six screens rather than two.

            EVERYTHING ABOVE IT IS FREE, and that is what makes the new flow better than the old one: the
            reviewer can read the exact clustering input, in Excel, before spending a cent.

            A PREVIEW RUN BUYS NOTHING and must not be told it is about to spend — R8 binds in both
            directions, so the amount is withheld and the reason is stated. */}
        <CommitBar
          action="Start run"
          actionTestId="start-run"
          total={isPreview || !estimate || estimate.free ? undefined : estimate.firstCharge}
          firstCharge={!isPreview && !estimate?.free}
          scopeLabel={totalFields === null ? undefined : `${totalFields.toLocaleString()} variables`}
          onCommit={() => void onStart()}
          busy={starting}
          disabled={blockers.length > 0 || IS_STATIC}
          className="static"
          recheckNotice={
            isPreview || estimate?.free
              ? "This run is a preview, so it calls no model and buys nothing — it groups your variables and stops."
              : undefined
          }
        />
      </div>
      )}
        </div>
      </div>
    </GateShell>
  );
}
