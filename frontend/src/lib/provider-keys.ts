/**
 * Per-provider API-key hints — the placeholder a key looks like, and where to get one.
 *
 * SHARED, DELIBERATELY. This lived as a local `const` in `pages/home.tsx` (the shipped New Run form)
 * until 08-13b, and Setup's key field had neither hint: an unlabelled password box gives no clue whether
 * the thing being asked for is `sk-ant-…` or `AIza…`, and a reviewer who does not already have a key has
 * nowhere to go. Copying the map into Setup would have made the SECOND screen the one that goes stale —
 * a new provider added to one and not the other is a wrong placeholder, which is worse than none. So it
 * is declared once, here, and imported by both screens.
 *
 * A provider absent from this map is NOT an error: `PROVIDER_LABELS` in `types.ts` also carries `local`
 * (on-prem, needs no provider key) and `other`. Both consumers must therefore read it optionally and
 * degrade to a generic placeholder with NO link — an anchor with an empty `href` is a dead control, and
 * this screen's standing rule is that a control either works or is not rendered.
 */
export interface ProviderKeyInfo {
  /** What a key for this provider looks like, shown as the field's placeholder. */
  placeholder: string;
  /** Where to get one. Absent when we have no stable URL to send someone to. */
  link?: string;
}

export const PROVIDER_KEY_INFO: Record<string, ProviderKeyInfo> = {
  anthropic: { placeholder: "sk-ant-…", link: "https://console.anthropic.com/settings/keys" },
  openai: { placeholder: "sk-…", link: "https://platform.openai.com/api-keys" },
  gemini: { placeholder: "AIza…", link: "https://aistudio.google.com/apikey" },
};

/** The placeholder for a provider, generic when the provider is not one we carry a hint for. */
export function keyPlaceholderFor(provider: string): string {
  return PROVIDER_KEY_INFO[provider]?.placeholder ?? "your API key";
}
