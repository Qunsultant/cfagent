import React from "react";

export interface TableColumn<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  align?: "left" | "center" | "right";
  /** aria-sort for the column's <th> (sortable-column tables, #1837). */
  ariaSort?: "ascending" | "descending" | "none";
  /** Class applied to every body cell in this column (surface cell styles); a function computes it per row. */
  cellClassName?: string | ((row: T) => string);
  /** Class applied to the column's <th> (e.g. sticky first columns). */
  headerClassName?: string;
  /** Inline style for the column's body cells, computed per row (e.g. heatmap shading). */
  cellStyle?: (row: T) => React.CSSProperties;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  caption?: string;
  /** Rendered instead of the table when rows is empty (usually EmptyState). */
  empty?: React.ReactNode;
  rowClassName?: string | ((row: T) => string);
  className?: string;
  containerClassName?: string;
  /** Row click handler, attached to the <tr> (clickable-row tables, #1837). */
  onRowClick?: (row: T) => void;
  /** title for every row's <tr> (string or per-row function). */
  rowTitle?: string | ((row: T) => string);
  /** Extra HTML attributes (e.g. data-* attrs) for every row's <tr> (#2723). */
  rowProps?: (row: T, index: number) => React.HTMLAttributes<HTMLTableRowElement>;
  /** Keep the header cells stuck to the top of the scroll container. */
  stickyHeader?: boolean;
}

/**
 * Table (#492)
 * Semantic data table from a column config (docs/agents/ux-architecture.md
 * section 6: task table; section 13: charts/tables need text alternatives
 * — a real <table> is the accessible baseline). Styles: ./primitives.css.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  rowClassName = "",
  className = "",
  containerClassName = "",
  onRowClick,
  rowTitle,
  rowProps,
  stickyHeader = false,
}: TableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className={containerClassName || undefined}>
      <table className={`ui-table ${className}`}>
        {caption && <caption className="ui-table-caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={col.ariaSort}
                className={`${col.headerClassName ?? ""} ${stickyHeader ? "sticky-head" : ""} ${col.align ? `align-${col.align}` : ""}`.trim() || undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr
              key={rowKey(row, rowIdx)}
              className={
                (typeof rowClassName === "function" ? rowClassName(row) : rowClassName) || undefined
              }
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              title={typeof rowTitle === "function" ? rowTitle(row) : rowTitle}
              {...(rowProps ? rowProps(row, rowIdx) : undefined)}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`${typeof col.cellClassName === "function" ? col.cellClassName(row) : (col.cellClassName ?? "")} ${col.align ? `align-${col.align}` : ""}`.trim() || undefined}
                  style={col.cellStyle?.(row)}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
