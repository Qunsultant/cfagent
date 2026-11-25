/**
 * Issue 6479 — the Opportunity Hunt report body, rendered from the ONE view
 * model (`buildOpportunityHuntReportModel`).
 *
 * Issue 6499 — the evaluated universe is rendered as TWO sections, each with
 * its own heading/count and its own sort: symbols with patterns (most patterns
 * first, then symbol) and symbols with no patterns (symbol A→Z). The PDF
 * renders the same groups from the same model.
 *
 * The panel is a thin shell around this component: run controls, report link,
 * errors, and the latest scheduled run. Everything the report says — summary,
 * counts narrative, holdings/no-setups notes, table cells, per-symbol section
 * text, methodology — comes from the model, which the PDF renderer reads too.
 * The sync pin renders this component and the PDF from the same model.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Modal,
  Notice,
  SmallHeader,
  Table,
} from "./components/ui";
import { OpportunityHuntChart } from "./OpportunityHuntChart";
import {
  huntTradingDayLabels,
  nextHuntSort,
  sortHuntRows,
  type HuntSort,
  type HuntSortKey,
  type OpportunityHuntSymbolRow,
} from "./opportunityHuntView";
import type {
  OpportunityHuntReportModel,
  OpportunityHuntReportTableGroup,
  OpportunityHuntReportTableRow,
} from "./opportunityHuntReportModel";

/**
 * A sortable column header. The `th` carries `aria-sort` (from the column
 * config); this button is the control. The indicator is decorative — the
 * button's accessible name states the current direction.
 */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: HuntSortKey;
  sort: HuntSort;
  onSort: (key: HuntSortKey) => void;
}) {
  const active = sort.key === sortKey;
  const direction = sort.dir === "asc" ? "ascending" : "descending";
  return (
    <Button
      variant="secondary"
      size="sm"
      className="ui-table-sort"
      onClick={() => onSort(sortKey)}
      title={active ? `Sorted ${direction} — click to reverse` : `Sort by ${label}`}
      aria-label={active ? `${label}, sorted ${direction}. Reverse order` : `Sort by ${label}`}
    >
      {label}
      <span className="ui-table-sort-indicator" aria-hidden="true">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </Button>
  );
}

/**
 * Issue #6473 — the row's trend, drawn as an inline sparkline rather than a
 * chart instance: a hunt can carry sixty-plus symbols, and one canvas per row
 * would cost a chart per row for a shape the eye reads at 40px. The full chart
 * opens on click, in the dialog.
 */
function SymbolSparkline({ symbol, closes }: { symbol: string; closes: readonly number[] }) {
  const series = closes.slice(-40);
  if (series.length < 2) return <span className="ui-meta-sm">—</span>;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const points = series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * 100;
      const y = 24 - ((value - min) / span) * 22;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 26"
      width="100"
      height="26"
      role="img"
      aria-label={`Trend for ${symbol}, last ${series.length} closes`}
      preserveAspectRatio="none"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * One evaluated-symbol section: its own heading/count, its own sort state, and
 * the same columns/row behavior as the report's single table had. The model
 * supplies the heading, rows, and default order; the page only renders it.
 */
function HuntGroupTable({
  group,
  cells,
  rowsBySymbol,
  selectedSymbol,
  onSelect,
}: {
  group: OpportunityHuntReportTableGroup;
  cells: ReadonlyMap<string, OpportunityHuntReportTableRow>;
  rowsBySymbol: ReadonlyMap<string, OpportunityHuntSymbolRow>;
  selectedSymbol: string | null;
  onSelect: (symbol: string) => void;
}) {
  const [sort, setSort] = useState<HuntSort>(group.defaultSort);

  // A new run resets each section to its model order (patterns desc / symbol).
  useEffect(() => {
    setSort(group.defaultSort);
  }, [group]);

  const rows = useMemo(
    () =>
      sortHuntRows(
        group.rows
          .map((row) => rowsBySymbol.get(row.symbol))
          .filter((row): row is OpportunityHuntSymbolRow => !!row),
        sort,
      ),
    [group, rowsBySymbol, sort],
  );

  const onSort = (key: HuntSortKey) => setSort((current) => nextHuntSort(current, key));

  return (
    <>
      <SmallHeader title={group.heading} />
      <Table<OpportunityHuntSymbolRow>
        columns={[
          {
            key: "symbol",
            header: (
              <SortHeader label="Symbol" sortKey="symbol" sort={sort} onSort={onSort} />
            ),
            ariaSort:
              sort.key === "symbol"
                ? sort.dir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined,
            render: (row) => <Badge tone="neutral">{row.symbol}</Badge>,
          },
          {
            key: "patterns",
            header: (
              <SortHeader label="Patterns" sortKey="patterns" sort={sort} onSort={onSort} />
            ),
            ariaSort:
              sort.key === "patterns"
                ? sort.dir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined,
            align: "right",
            render: (row) => <>{row.patternCount}</>,
          },
          {
            key: "entries",
            header: "Entries",
            render: (row) =>
              row.entries.length > 0 ? (
                <>
                  {row.entries.map((setup) => (
                    <Badge key={setup.strategy} tone="success" title={setup.detail}>
                      {setup.strategy}
                    </Badge>
                  ))}
                </>
              ) : (
                <>—</>
              ),
          },
          {
            key: "exits",
            header: "Exits",
            render: (row) =>
              row.exits.length > 0 ? (
                <>
                  {row.exits.map((setup) => (
                    <Badge key={setup.strategy} tone="danger" title={setup.detail}>
                      {setup.strategy}
                    </Badge>
                  ))}
                </>
              ) : (
                <>—</>
              ),
          },
          {
            key: "entryRange",
            header: "Entry range",
            align: "right",
            render: (row) => cells.get(row.symbol)?.entryRange ?? "—",
          },
          {
            key: "stopLoss",
            header: "Stop-loss",
            align: "right",
            render: (row) => cells.get(row.symbol)?.stopLoss ?? "—",
          },
          {
            key: "trend",
            header: "Trend",
            render: (row) => <SymbolSparkline symbol={row.symbol} closes={row.closes} />,
          },
          {
            key: "takeProfit",
            header: "Take-profit",
            align: "right",
            render: (row) => cells.get(row.symbol)?.takeProfit ?? "—",
          },
          {
            key: "lastClose",
            header: (
              <SortHeader label="Last close" sortKey="lastClose" sort={sort} onSort={onSort} />
            ),
            ariaSort:
              sort.key === "lastClose"
                ? sort.dir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined,
            align: "right",
            render: (row) => cells.get(row.symbol)?.lastClose ?? "—",
          },
        ]}
        rows={rows}
        rowKey={(row) => row.symbol}
        onRowClick={(row) => onSelect(row.symbol)}
        rowClassName={(row) => (row.symbol === selectedSymbol ? "is-selected" : "")}
        caption={
          group.key === "patterns"
            ? "Symbols with patterns, most patterns first — select a row for its recommendations and chart."
            : "Symbols with no patterns, symbol A→Z — evaluated, with no entry or exit signal. Select a row for its chart."
        }
        empty={
          <EmptyState
            title={group.key === "patterns" ? "No patterns" : "No quiet symbols"}
            description={
              group.key === "patterns"
                ? "No evaluated symbol produced a pattern in this run."
                : "Every evaluated symbol produced at least one pattern."
            }
          />
        }
      />
    </>
  );
}

export function OpportunityHuntReportView({ model }: { model: OpportunityHuntReportModel }) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(
    model.sections[0]?.symbol ?? null,
  );

  // A fresh result opens its first symbol; a stale selection is dropped. A
  // closed dialog (null) stays closed until the reader selects a row again.
  useEffect(() => {
    setSelectedSymbol((current) =>
      current && model.sections.some((section) => section.symbol === current)
        ? current
        : (model.sections[0]?.symbol ?? null),
    );
  }, [model]);

  const cells = useMemo(
    () =>
      new Map(
        model.tableGroups
          .flatMap((group) => group.rows)
          .map((row) => [row.symbol, row] as const),
      ),
    [model],
  );
  const rowsBySymbol = useMemo(
    () => new Map(model.sections.map((section) => [section.symbol, section.row] as const)),
    [model],
  );
  const selected =
    model.sections.find((section) => section.symbol === selectedSymbol) ?? null;
  const labels = useMemo(
    () =>
      selected && selected.closes.length > 0
        ? huntTradingDayLabels(model.asOfIso, selected.closes.length)
        : [],
    [model.asOfIso, selected],
  );

  return (
    <>
      <p>
        {model.summary} (as of {model.asOfLabel})
      </p>
      {model.holdingsNote ? (
        model.holdingsAvailable === false ? (
          <Notice tone="warning" title="Exit signals unavailable">
            {model.holdingsNote}
          </Notice>
        ) : (
          <p className="ui-meta-sm">
            {model.holdingsHeading ? `${model.holdingsHeading}: ` : ""}
            {model.holdingsNote}
          </p>
        )
      ) : null}

      <SmallHeader title={model.countsHeading} />
      <p>{model.countsExplanation}</p>

      {model.noSetupsNote ? (
        <Notice tone="info" title="No setups">
          {model.noSetupsNote}
        </Notice>
      ) : null}

      {model.tableGroups.map((group) => (
        <HuntGroupTable
          key={group.key}
          group={group}
          cells={cells}
          rowsBySymbol={rowsBySymbol}
          selectedSymbol={selected?.symbol ?? null}
          onSelect={setSelectedSymbol}
        />
      ))}
      <p className="ui-meta-sm">{model.summaryCountsLine}</p>

      <Modal
        open={selected !== null}
        onClose={() => setSelectedSymbol(null)}
        title={selected?.heading ?? "Recommendations"}
        size="lg"
      >
        {selected ? (
          <Card>
            <CardHeader title={selected.heading} />
            <p>{selected.lastCloseLine}</p>
            {selected.noSetupNote ? <p>{selected.noSetupNote}</p> : null}
            {selected.entryLines.length > 0 ? (
              <>
                <SmallHeader title={selected.entryHeading} />
                <ul>
                  {selected.entryLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {selected.exitLines.length > 0 ? (
              <>
                <SmallHeader title={selected.exitHeading} />
                <ul>
                  {selected.exitLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <OpportunityHuntChart
              symbol={selected.symbol}
              closes={selected.closes}
              labels={labels}
              entryLow={selected.row.entryLow}
              entryHigh={selected.row.entryHigh}
              stopLoss={selected.row.stopLoss}
              takeProfit={selected.row.takeProfit}
              entryPrice={selected.row.exits[0]?.entryPrice ?? null}
              lastClose={selected.row.lastClose}
            />
          </Card>
        ) : null}
      </Modal>

      <SmallHeader title="Methodology" />
      <ul>
        {model.methodology.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </>
  );
}
