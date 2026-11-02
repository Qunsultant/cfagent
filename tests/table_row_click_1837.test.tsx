import { describe, it, expect, vi } from "vitest";
import { Table } from "../src/client/components/ui/Table";

/**
 * Table row-click / title / aria-sort / indexed rowKey props (P2, #1837).
 * Table uses no hooks, so it is called directly and its element tree is
 * walked — the repo's DOM-free convention.
 */

type Row = { id: string; label: string };

const ROWS: Row[] = [
  { id: "dup", label: "first" },
  { id: "dup", label: "second" },
];

function getParts(props: Record<string, unknown>) {
  const el = Table({
    columns: [
      { key: "label", header: "Label", ariaSort: "ascending", render: (row: Row) => row.label },
    ],
    rows: ROWS,
    rowKey: (row: Row, index: number) => `${row.id}:${index}`,
    ...props,
  }) as unknown as {
    key: string | null;
    props: { children: { props: { children: unknown[] } } };
  };
  const table = el.props.children;
  const children = (table.props.children as unknown[]).filter(Boolean);
  const thead = children.find(
    (c) => (c as { type: string }).type === "thead",
  ) as unknown as { props: { children: { props: { children: unknown[] } } } };
  const tbody = children.find(
    (c) => (c as { type: string }).type === "tbody",
  ) as unknown as { props: { children: unknown[] } };
  const headRow = thead.props.children as { props: { children: Array<{ props: Record<string, unknown> }> } };
  const bodyRows = tbody.props.children as Array<{
    key: string | null;
    props: { onClick?: () => void; title?: string };
  }>;
  return { th: headRow.props.children[0].props, bodyRows };
}

describe("Table row props (#1837)", () => {
  it("passes the row index to rowKey, disambiguating duplicate ids", () => {
    const { bodyRows } = getParts({});
    expect(bodyRows[0].key).toBe("dup:0");
    expect(bodyRows[1].key).toBe("dup:1");
  });

  it("wires onRowClick to the tr, delivering the row", () => {
    const handler = vi.fn();
    const { bodyRows } = getParts({ onRowClick: handler });
    bodyRows[1].props.onClick?.();
    expect(handler).toHaveBeenCalledWith(ROWS[1]);
  });

  it("leaves tr without onClick when no handler is given", () => {
    const { bodyRows } = getParts({});
    expect(bodyRows[0].props.onClick).toBeUndefined();
  });

  it("applies rowTitle as a string and as a per-row function", () => {
    expect(getParts({ rowTitle: "Open" }).bodyRows[0].props.title).toBe("Open");
    expect(getParts({ rowTitle: (row: Row) => `Open ${row.label}` }).bodyRows[1].props.title).toBe(
      "Open second",
    );
  });

  it("renders aria-sort on the th", () => {
    expect(getParts({}).th["aria-sort"]).toBe("ascending");
  });

  it("spreads rowProps onto the tr (#2723)", () => {
    const parts = getParts({
      rowProps: (row: Row) => ({ "data-testid": `row-${row.label}` } as React.HTMLAttributes<HTMLTableRowElement>),
    });
    expect((parts.bodyRows[0].props as Record<string, unknown>)["data-testid"]).toBe("row-first");
  });
});
