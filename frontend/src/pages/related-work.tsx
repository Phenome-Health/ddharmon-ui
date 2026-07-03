import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { REF } from "@/lib/links";

interface Entry {
  name: string;
  by?: string;
  desc: string;
  href?: string;
}

interface Ref {
  authors: string;
  year: number;
  title: string;
  venue?: string;
  href?: string;
}

const TOOLS: Entry[] = [
  {
    name: "CDEMapper",
    by: "Yale Clinical NLP Lab",
    desc: "Maps user variables to NIH Common Data Elements via BM25 + embeddings + an LLM re-ranker. Convergent prior art for ddharmon's retrieval + rerank.",
    href: "https://cdemapper.clinicalnlp.org",
  },
  {
    name: "Harmony",
    by: "Fast Data Science · Ulster/UCL",
    desc: "Semantic harmonization of questionnaire items (mental health) with SBERT; first to validate similarity against real respondent-correlation data.",
    href: "https://harmonydata.ac.uk",
  },
  {
    name: "Datastew",
    by: "Fraunhofer SCAI",
    desc: "Embedding-based dictionary harmonization library (pgvector + OLS). Ships with cross-cohort benchmarks (PASSIONATE, ADHTEB).",
    href: "https://github.com/SCAI-BIO/datastew",
  },
  {
    name: "BDI-Kit",
    by: "VIDA-NYU",
    desc: "Composable matchers for mapping a source schema onto a target common data model; the agent layer (Harmonia) builds on it.",
    href: "https://github.com/VIDA-NYU/bdi-kit",
  },
  {
    name: "cde-harmonization",
    by: "Monarch Initiative",
    desc: "Open-source pipeline grounding CDEs to ontologies with LinkML schemas + SSSOM mappings across NIH/PhenX/caDSR/RADx/HEAL.",
    href: "https://github.com/monarch-initiative/cde-harmonization",
  },
  {
    name: "FAIRkit / GenCDE",
    by: "DataTecnica",
    desc: "LLM generation of Common Data Elements at scale (npj Digital Medicine, 2026). ddharmon inverts this — it generates GenCDEs from cluster empirics.",
    href: "https://doi.org/10.1038/s41746-026-02795-z",
  },
  {
    name: "Usagi",
    by: "OHDSI",
    desc: "Lexical source→OMOP-vocabulary mapping with human approval — the pre-LLM workflow standard.",
    href: "https://github.com/OHDSI/Usagi",
  },
];

const CONCEPTS: Entry[] = [
  { name: "Common Data Elements (CDEs)", desc: "NIH CDE Repository — the curated standard definitions ddharmon assigns fields to.", href: REF.cde },
  { name: "LOINC", desc: "Standard codes for labs, measurements, and survey instruments.", href: REF.loinc },
  { name: "SNOMED CT", desc: "Clinical terminology for conditions, findings, and procedures.", href: REF.snomed },
  { name: "OMOP CDM", desc: "OHDSI's common data model — a frequent harmonization target.", href: REF.omop },
  { name: "SSSOM", desc: "Simple Standard for Sharing Ontological Mappings — a portable mapping-set format.", href: REF.sssom },
  { name: "FAIR principles", desc: "Findable, Accessible, Interoperable, Reusable — the motivation for harmonization.", href: REF.fair },
  { name: "Biolink Model", desc: "The entity/association schema ddharmon uses for typing (PhenotypicFeature, etc.).", href: REF.biolink },
  { name: "BERTopic", desc: "The embedding + UMAP + HDBSCAN topic-clustering method behind the grouping stage.", href: REF.bertopic },
];

const GROUPS: Entry[] = [
  { name: "Yale Clinical NLP Lab", desc: "NIH CDE alignment + clinical NLP (CDEMapper).", href: "https://medicine.yale.edu/lab/clinical-nlp/" },
  { name: "Monarch Initiative", desc: "Open ontology infrastructure and CDE→ontology grounding.", href: "https://monarchinitiative.org/" },
  { name: "Fraunhofer SCAI (SCAI-BIO)", desc: "Cohort harmonization tools + benchmarks (Datastew).", href: "https://www.scai.fraunhofer.de/" },
  { name: "VIDA-NYU", desc: "Data integration and schema-matching research (BDI-Kit).", href: "https://vida.engineering.nyu.edu/" },
  { name: "Maelstrom Research", desc: "Rule-based cross-cohort population-health harmonization (McGill).", href: "https://www.maelstrom-research.org/" },
  { name: "ARPA-H", desc: "Funds the multi-omics data-harmonization program ddharmon is part of.", href: "https://arpa-h.gov/" },
];

// Papers that shaped ddharmon's design (accurate metadata; PDFs kept in the research repo).
const REFERENCES: Ref[] = [
  {
    authors: "Krishnamurthy et al.",
    year: 2025,
    title: "A Dynamic Framework for Semantic Grouping of Common Data Elements (CDEs) Using Embeddings and Clustering",
    venue: "arXiv:2506.02160",
    href: "https://arxiv.org/abs/2506.02160",
  },
  {
    authors: "Salimi, Adams, Ay, Balabin, Jacobs & Hofmann-Apitius",
    year: 2025,
    title:
      "Evaluating language model embeddings for Parkinson's disease cohort harmonization using a novel manually curated variable mapping schema (PASSIONATE)",
    venue: "Scientific Reports 15:20210",
    href: "https://doi.org/10.1038/s41598-025-06447-2",
  },
  {
    authors: "Islam",
    year: 2026,
    title: "Reasoning-Based Refinement of Unsupervised Text Clusters with LLMs",
    venue: "arXiv:2604.07562",
    href: "https://arxiv.org/abs/2604.07562",
  },
  {
    authors: "Gottfried et al.",
    year: 2025,
    title: "Semantic search helper: embeddings in multi-item questionnaires as a harmonization tool",
  },
  {
    authors: "Wang et al.",
    year: 2025,
    title: "CDEMapper: enhancing NIH Common Data Element use with large language models",
    href: "https://cdemapper.clinicalnlp.org",
  },
  {
    authors: "Mimno, Wallach, Talley, Leenders & McCallum",
    year: 2011,
    title: "Optimizing Semantic Coherence in Topic Models",
    venue: "EMNLP",
  },
  {
    authors: "Newman, Lau, Grieser & Baldwin",
    year: 2010,
    title: "Automatic Evaluation of Topic Coherence",
    venue: "NAACL-HLT",
  },
  {
    authors: "Lau, Newman & Baldwin",
    year: 2014,
    title: "Machine Reading Tea Leaves: Automatically Evaluating Topic Coherence and Topic Model Quality",
    venue: "EACL",
    href: "https://doi.org/10.3115/v1/e14-1056",
  },
  {
    authors: "Yang, Zhao, Phung, Buntine & Du",
    year: 2024,
    title: "LLM Reading Tea Leaves: Automatically Evaluating Topic Models with Large Language Models",
    venue: "arXiv:2406.09008",
    href: "https://arxiv.org/abs/2406.09008",
  },
];

function ReferencesCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Works cited</CardTitle>
        <p className="text-xs text-neutral-400">
          Papers that shaped ddharmon's design — the embedding → clustering → LLM-labeling lineage for variable/CDE
          harmonization, and the topic-coherence work behind its semantic-coherence clustering.
        </p>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2.5">
          {REFERENCES.map((r) => (
            <li key={r.title} className="text-xs leading-relaxed text-neutral-600">
              <span className="font-medium text-neutral-700">{r.authors}</span> ({r.year}).{" "}
              {r.href ? (
                <a
                  href={r.href}
                  target="_blank"
                  rel="noreferrer"
                  className="italic text-ph-navy underline decoration-ph-navy/30 underline-offset-2 hover:decoration-ph-navy"
                >
                  {r.title}
                </a>
              ) : (
                <span className="italic">{r.title}</span>
              )}
              .{r.venue && <span className="text-neutral-400"> {r.venue}.</span>}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export default function RelatedWorkPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ph-ink">Related work</h1>
        <p className="mt-1 text-sm text-neutral-500">
          ddharmon builds on and complements a broad ecosystem of data-harmonization tools, standards, and
          research groups. A non-exhaustive map of the neighborhood.
        </p>
      </div>

      <Section title="Tools" subtitle="Related and prior-art harmonization / mapping tools" entries={TOOLS} />
      <Section title="Standards & concepts" subtitle="The vocabularies and methods ddharmon builds on" entries={CONCEPTS} />
      <Section title="Groups" subtitle="Research groups and programs in the space" entries={GROUPS} />
      <ReferencesCard />
    </div>
  );
}

function Section({ title, subtitle, entries }: { title: string; subtitle: string; entries: Entry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-neutral-400">{subtitle}</p>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {entries.map((e) => (
          <EntryCard key={e.name} entry={e} />
        ))}
      </CardContent>
    </Card>
  );
}

function EntryCard({ entry }: { entry: Entry }) {
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-neutral-700 group-hover:text-ph-navy">{entry.name}</span>
        {entry.href && <ExternalLink className="h-3 w-3 text-neutral-400 group-hover:text-ph-navy" />}
      </div>
      {entry.by && <div className="text-xs text-neutral-400">{entry.by}</div>}
      <p className="mt-1 text-xs leading-relaxed text-neutral-600">{entry.desc}</p>
    </>
  );
  const cls = "group block rounded-md border border-neutral-200 p-3 transition-colors";
  return entry.href ? (
    <a href={entry.href} target="_blank" rel="noreferrer" className={`${cls} hover:border-ph-navy/40`}>
      {inner}
    </a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
