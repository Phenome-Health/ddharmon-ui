/**
 * Reading the model picker's list (`GET /api/harmonize/models`) — which model to start on, and how to name the
 * validated ones in help copy.
 *
 * Which models ddharmon was validated against is DATA, decided in core and served by the backend: no model id or
 * name is written here, so a model bump is a core release plus a repin, never a UI edit.
 */
import type { ModelCatalog, ModelInfo } from "@/types";
import { INPUT_COST_SHARE } from "@/lib/estimate";

/**
 * Whether a model can be picked. `selectable` comes from core's registry — a model is offered once the server's core
 * knows how to call it, ahead of its benchmark (round 11). A server too old to send the field offers validated
 * models only, which is all its core could call.
 */
export function isSelectable(m: ModelInfo): boolean {
  return m.selectable ?? m.validated;
}

/**
 * What a run on `modelId` costs relative to the catalog default, for scaling an estimate calibrated on the default:
 * each of the input and output shares re-priced at the model's rate, times its tokenizer ratio. `1` for the default,
 * for an unknown id, and for a model without a price — never a lower quote than the calibration supports.
 */
export function costFactor(catalog: ModelCatalog | undefined, modelId: string | undefined): number {
  if (!catalog || !modelId) return 1;
  const strip = (id: string) => (id.toLowerCase().startsWith("anthropic/") ? id.slice("anthropic/".length) : id);
  const find = (id: string) => catalog.models.find((m) => strip(m.id) === strip(id));
  const m = find(modelId);
  const d = find(catalog.default);
  if (!m || !d || m === d) return 1;
  if (m.inputPerMtok == null || m.outputPerMtok == null || !d.inputPerMtok || !d.outputPerMtok) return 1;
  const price =
    INPUT_COST_SHARE * (m.inputPerMtok / d.inputPerMtok) + (1 - INPUT_COST_SHARE) * (m.outputPerMtok / d.outputPerMtok);
  return price * ((m.tokenRatio ?? 1) / (d.tokenRatio ?? 1));
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The validated models' labels as one phrase ("Claude Sonnet 4.6"), or "" when none are validated. */
export function validatedModelNames(models: ModelInfo[]): string {
  return joinNames(models.filter((m) => m.validated).map((m) => m.label));
}

/** The validated models grouped under their provider ("Anthropic (Claude Sonnet 4.6)"), or "" when none. */
export function validatedByProvider(models: ModelInfo[], providerLabels: Record<string, string>): string {
  const byProvider = new Map<string, string[]>();
  for (const m of models) if (m.validated) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m.label]);
  return joinNames([...byProvider].map(([p, labels]) => `${providerLabels[p] ?? p} (${joinNames(labels)})`));
}

/**
 * The model a provider's dropdown should show: the current pick while it is still a validated model of that
 * provider, else the catalog default (when it belongs to the provider), else the provider's first validated
 * model, else its first model. `undefined` only when the provider lists nothing.
 */
export function pickModel(catalog: ModelCatalog, provider: string, current: string): string | undefined {
  const mine = catalog.models.filter((m) => m.provider === provider);
  const ok = (id: string) => mine.some((m) => m.id === id && isSelectable(m));
  if (current && ok(current)) return current;
  if (ok(catalog.default)) return catalog.default;
  return (mine.find((m) => m.validated) ?? mine.find(isSelectable) ?? mine[0])?.id;
}
