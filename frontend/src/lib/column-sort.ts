/**
 * Click-to-sort state, shared by prod's Review queue and Gate 1's ledger (08-16c Task 10).
 *
 * Bhargav: *"let the user sort the cols directly - it should resemble the way Review queue is built from
 * the prod UI."* That queue is `pages/dashboard.tsx`, and it already had a typed key, a direction, and a
 * toggle that flips on a re-click of the same column and resets to ascending on a new one.
 *
 * WHAT TRANSFERRED AND WHAT DID NOT. The STATE and the TOGGLE live here and are now literally the same
 * code on both screens — that is the part where a second, subtly different behaviour would be felt, since
 * the reviewer moves between the two surfaces. `SortableHead` did NOT transfer: the dashboard renders a
 * real `<table>` and returns a `TableHead`, while the ledger's head is a CSS grid of spans (UI-SPEC
 * §7.3.3). Forcing one component to serve both would have meant reshaping one of the two tables to suit
 * the other's markup. The ledger draws its own header button against this shared state instead.
 *
 * `null` means NO explicit column sort — each screen keeps its own documented default order, which is not
 * something click-to-sort may quietly replace.
 */
export type SortDir = "asc" | "desc";

export interface ColumnSort<K extends string> {
  key: K;
  dir: SortDir;
}

/**
 * The toggle, lifted verbatim from `dashboard.tsx`: re-clicking the active column reverses it, and a new
 * column starts ascending.
 */
export function toggleSort<K extends string>(cur: ColumnSort<K> | null, key: K): ColumnSort<K> {
  return cur?.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

/** What `aria-sort` must say for a column, so the sorted column and its direction are announced. */
export function ariaSortFor<K extends string>(
  cur: ColumnSort<K> | null,
  key: K,
): "ascending" | "descending" | "none" {
  if (cur?.key !== key) return "none";
  return cur.dir === "asc" ? "ascending" : "descending";
}
