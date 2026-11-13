/**
 * Issue #4389 — the one table-order helper for the schedules surfaces.
 *
 * A header click orders the rows by that column; a second click reverses it.
 * The rules are the same for every table that uses it:
 * - a fixed vocabulary of keys, supplied by the caller's accessor;
 * - empty values sort last in BOTH directions (a blank cell is not "smallest");
 * - numbers compare numerically, strings compare with `localeCompare`
 *   (numeric-aware, case-insensitive), and ties keep the caller's order
 *   (a stable sort — the list must not shuffle when two rows are equal).
 */

export type SortDirection = "asc" | "desc";

export interface TableSort<K extends string = string> {
  key: K;
  direction: SortDirection;
}

/** The next state for a header click: new column → ascending; same → reverse. */
export function nextTableSort<K extends string>(
  current: TableSort<K> | null,
  key: K,
  initial: SortDirection = "asc",
): TableSort<K> {
  if (!current || current.key !== key) return { key, direction: initial };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** The `aria-sort` a column announces for the current state. */
export function tableSortAria(
  current: TableSort | null,
  key: string,
): "ascending" | "descending" | "none" {
  if (!current || current.key !== key) return "none";
  return current.direction === "asc" ? "ascending" : "descending";
}

/**
 * Order rows by the current sort, through the caller's accessor. Returns a new
 * array (never mutates), and an empty sort returns the rows in their order.
 */
export function sortTableRows<T>(
  rows: readonly T[],
  sort: TableSort | null,
  accessor: (row: T, key: string) => string | number | null | undefined,
): T[] {
  if (!sort) return [...rows];
  const factor = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = accessor(a.row, sort.key);
      const bv = accessor(b.row, sort.key);
      const aEmpty = av === null || av === undefined || av === "";
      const bEmpty = bv === null || bv === undefined || bv === "";
      if (aEmpty && bEmpty) return a.index - b.index;
      // A blank cell is not a small value: it sits last either way.
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const byValue =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, {
              numeric: true,
              sensitivity: "base",
            });
      return byValue * factor || a.index - b.index;
    })
    .map((entry) => entry.row);
}
