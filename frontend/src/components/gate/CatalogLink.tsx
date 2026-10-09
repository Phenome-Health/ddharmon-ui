import { ExternalLink } from "lucide-react";
import { Highlight } from "@/components/ui/highlight";
import { catalogPageFor } from "@/lib/links";
import { cn } from "@/lib/utils";

/**
 * A target's NAME, linked to its NIH CDE Repository page when it is a catalog element (review round 2, Gate 3
 * note 1). The decision is `catalogPageFor`'s, so a generated element — which has no catalog page — always
 * renders as plain text, and Gates 2 and 3 link the same targets the same way.
 *
 * A new tab, and `noopener`: the reviewer is mid-review on a gate, and the repository page must neither replace
 * it nor be handed a handle back to it.
 */
export function CatalogLink({
  name,
  externalId,
  generated = false,
  className,
}: {
  name: string;
  /** The element's tinyId, when the wire carries one. */
  externalId?: string | null;
  /** True for a generated element (a GenCDE, a refine's derived element, the reviewer's own). Never linked. */
  generated?: boolean;
  className?: string;
}) {
  const href = catalogPageFor({ externalId, generated });
  // The name follows the gate's search highlight (review round 5: the CDE is searched, so its match is marked).
  if (!href)
    return (
      <span className={className}>
        <Highlight text={name} />
      </span>
    );
  return (
    <a
      data-testid="catalog-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open this CDE's record on the NIH CDE Repository (new tab)"
      className={cn(
        "inline-flex items-baseline gap-1 text-link-on-raised underline underline-offset-2 hover:no-underline",
        className,
      )}
    >
      <Highlight text={name} />
      <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0 self-center" />
    </a>
  );
}
