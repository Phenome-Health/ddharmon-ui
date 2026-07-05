// The source fields a concept pooled, with their human text — the "which variables drove this?" view.
// Lives in the deep surface (review workbench); the queue links here rather than duplicating it.
import { Badge } from "@/components/ui/badge";
import type { UIMember, UIRecord } from "@/types";

const MEMBER_CAP = 40; // cap the list so a giant concept doesn't blow up the panel

// A member name the loader synthesized (no usable id column in the source) — not worth showing raw.
const isSyntheticName = (n: string): boolean => /^_ROW_\d+$/.test(n);

function memberList(r: UIRecord): UIMember[] {
  if (r.memberDetails?.length) return r.memberDetails;
  // Fallback for pre-enrichment data: derive minimal members from the id list.
  return r.members.map((m) => {
    const i = m.indexOf(":");
    const cohort = i > 0 ? m.slice(0, i) : "";
    const name = i > 0 ? m.slice(i + 1) : m;
    return { id: m, cohort, name, text: name };
  });
}

export function MemberVariables({ record }: { record: UIRecord }) {
  const members = memberList(record);
  if (!members.length) return null;
  const shown = members.slice(0, MEMBER_CAP);
  const extra = members.length - shown.length;
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
        Source variables ({members.length}) — the fields this concept pooled
      </div>
      <div className="space-y-1">
        {shown.map((m) => (
          <div key={m.id} className="flex items-start gap-2 text-xs">
            <Badge variant="neutral" className="mt-0.5 shrink-0 font-normal">
              {m.cohort}
            </Badge>
            <span className="text-neutral-700">{m.text || m.name}</span>
            {!isSyntheticName(m.name) && <span className="ml-auto shrink-0 font-mono text-neutral-400">{m.name}</span>}
          </div>
        ))}
      </div>
      {extra > 0 && <div className="mt-1 text-xs text-neutral-400">+{extra} more</div>}
    </div>
  );
}
