/**
 * Reading the model picker's list (`GET /api/harmonize/models`) — which model to start on, and how to name the
 * validated ones in help copy.
 *
 * Which models ddharmon was validated against is DATA, decided in core and served by the backend: no model id or
 * name is written here, so a model bump is a core release plus a repin, never a UI edit.
 */
import type { ModelCatalog, ModelInfo } from "@/types";

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
  const ok = (id: string) => mine.some((m) => m.id === id && m.validated);
  if (current && ok(current)) return current;
  if (ok(catalog.default)) return catalog.default;
  return (mine.find((m) => m.validated) ?? mine[0])?.id;
}
