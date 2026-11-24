/**
 * Issue 6273 — Opportunity Hunt sub-tab panel (Stock Hub), reworked into a
 * report-style view by issue 6406 (UX first; the report in issue 6403 is
 * deferred and must generate the same output this panel shows).
 *
 * Runs the hunt on demand and shows its output as a report: a sortable
 * one-row-per-symbol table with a pattern count, entry and exit signals
 * with their price ranges, and a detail section for the selected symbol —
 * its entry and exit recommendations grouped, with a price chart carrying
 * the recommendation levels. The hunt itself is unchanged — the panel
 * calls the synchronous run seam (POST /api/opportunity-hunt/run), which
 * reuses the hunt as-is over the persisted technicals bars. A run that
 * finds nothing is a completed hunt (an empty table), not an error; only
 * an unreadable bar source fails, with its named reason shown.
 *
 * Exit signals come from the tenant's holdings, which the run seam loads
 * from the selected broker and feeds to the evaluator. When the holdings
 * read is unavailable the run still completes on entries only, and the
 * panel states the reason — exits are never silently dropped.
 *
 * The panel also shows the latest scheduled run from the run ledger
 * (the daily scheduled goal firing, or a run triggered from the
 * ledger), so the on-demand result and the scheduled history sit side
 * by side. The on-demand run writes no ledger row — its result is
 * shown here immediately.
 *
 * Built only from src/client/components/ui primitives, token-only
 * styling. No broker or provider is named here: the hunt reads the
 * persisted technicals bars, and the run carries no venue selection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  PageSection,
  SmallHeader,
  Table,
} from "./components/ui";
import { asyncJobErrorCode } from "./apiFetch";
import { codedMessage } from "../outcomes/outcomeAspects";
import {
  generateOpportunityHuntReport,
  listAllRuns,
  runOpportunityHuntNow,
  type JobRunRecord,
} from "./jobsApi";
import type { OpportunityHuntResult } from "../services/opportunityHunt";
import { OpportunityHuntChart } from "./OpportunityHuntChart";
import {
  HUNT_SORT_DEFAULT,
  formatHuntPct,
  formatHuntPrice,
  groupHuntSetupsBySymbol,
  huntTradingDayLabels,
  nextHuntSort,
  sortHuntRows,
  type HuntSort,
  type HuntSortKey,
  type OpportunityHuntSymbolRow,
} from "./opportunityHuntView";

/** The goal id the scheduled hunt records under. */
const HUNT_JOB_ID = "opportunity-hunt";

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

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

export function OpportunityHuntPanel() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorJobId, setErrorJobId] = useState<string | null>(null);
  const [result, setResult] = useState<OpportunityHuntResult | null>(null);
  const [lastRun, setLastRun] = useState<JobRunRecord | null>(null);
  const [lastRunError, setLastRunError] = useState<string | null>(null);
  // Issue #6293 — a visible status line while a run is pending: when
  // the run started and how long it has been going. The hunt normally
  // answers in seconds (the seam is synchronous); a run that lingers
  // past the poll deadline is reported as still running, with its job
  // id, instead of a bare disabled button.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  // Issue 6406 — the report-style view: sort state for the one-row-per
  // symbol table, and the symbol whose recommendations + chart are shown.
  const [sort, setSort] = useState<HuntSort>(HUNT_SORT_DEFAULT);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  // Issue 6403 — the downloadable report (PDF) for the current result.
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    if (runStartedAt === null) return;
    const id = setInterval(
      () => setElapsedSec(Math.floor((Date.now() - runStartedAt) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [runStartedAt]);

  const refreshLastRun = useCallback(async () => {
    try {
      const { runs } = await listAllRuns(HUNT_JOB_ID, 50);
      setLastRun(runs[0] ?? null);
    } catch (cause) {
      setLastRunError(
        cause instanceof Error
          ? cause.message
          : "Could not read the run ledger.",
      );
    }
  }, []);

  useEffect(() => {
    void refreshLastRun();
  }, [refreshLastRun]);

  const rows = useMemo(
    () => (result ? sortHuntRows(groupHuntSetupsBySymbol(result), sort) : []),
    [result, sort],
  );

  // A fresh result selects its first symbol; a stale selection is dropped.
  useEffect(() => {
    setSelectedSymbol((current) =>
      rows.some((row) => row.symbol === current) ? current : (rows[0]?.symbol ?? null),
    );
  }, [rows]);

  const selectedRow: OpportunityHuntSymbolRow | null =
    rows.find((row) => row.symbol === selectedSymbol) ?? rows[0] ?? null;

  const selectedCloses: readonly number[] = selectedRow
    ? (result?.seriesBySymbol?.[selectedRow.symbol] ?? [])
    : [];
  const selectedLabels: readonly string[] = useMemo(
    () =>
      result && selectedCloses.length > 0
        ? huntTradingDayLabels(result.asOf, selectedCloses.length)
        : [],
    [result, selectedCloses.length],
  );

  const handleSort = useCallback((key: HuntSortKey) => {
    setSort((current) => nextHuntSort(current, key));
  }, []);

  const runNow = async () => {
    setRunning(true);
    setError(null);
    setErrorJobId(null);
    setElapsedSec(0);
    setRunStartedAt(Date.now());
    try {
      const res = await runOpportunityHuntNow();
      setResult(res);
    } catch (cause) {
      // Issue #6293 — classify structurally, never render the raw
      // transport text. A 408/500 from the 202 poll carries a job id:
      // the caller renders the catalog message for the code
      // (`asyncJobErrorCode`), with the job id so the run can be found
      // in the ledger. A genuine hunt failure (a named reason such as
      // an unreadable bar source) has no async-job code and its named
      // reason is shown as-is, as before.
      const failure = cause as { status?: number; data?: unknown };
      const code =
        typeof failure.status === "number"
          ? asyncJobErrorCode(failure.status, failure.data)
          : undefined;
      if (code) {
        const jobId =
          (failure.data as { jobId?: string } | null)?.jobId ?? null;
        setError(codedMessage(code));
        setErrorJobId(jobId);
      } else {
        setError(
          cause instanceof Error ? cause.message : "The hunt could not run.",
        );
      }
    } finally {
      setRunning(false);
      setRunStartedAt(null);
    }
  };

  // Issue 6403 — download the report (PDF) for the current result.
  // The result rides to the report endpoint, so the PDF renders the
  // exact output this panel shows. A generation failure shows its
  // error, never a fabricated link.
  const downloadReport = async () => {
    if (!result || reportBusy) return;
    setReportBusy(true);
    setReportError(null);
    try {
      const { reportUrl } = await generateOpportunityHuntReport(result);
      const anchor = document.createElement("a");
      anchor.href = reportUrl;
      anchor.download = "";
      anchor.click();
    } catch (cause) {
      setReportError(
        cause instanceof Error ? cause.message : "The report could not be generated.",
      );
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <PageSection
      title="Opportunity Hunt"
      description="Entry and exit signals from the pattern strategies over the tradable universe's daily closes. Run it on demand here; the scheduled goal also fires daily, and its runs land in the run ledger."
    >
      <Card>
        <Button variant="primary" onClick={runNow} loading={running}>
          Run hunt now
        </Button>{" "}
        <Button
          variant="secondary"
          onClick={downloadReport}
          loading={reportBusy}
          disabled={!result}
          title={result ? "Download this run as a coloured PDF report" : "Run the hunt first"}
        >
          Download report (PDF)
        </Button>
        {reportError ? (
          <Notice tone="danger" title="The report could not be generated">
            {reportError}
          </Notice>
        ) : null}
        {running ? (
          <p>
            Running… {elapsedSec}s elapsed. The hunt reads the persisted
            bars and returns its setups here.
          </p>
        ) : null}
        {error ? (
          <Notice tone="danger" title="The hunt could not run">
            {error}
            {errorJobId ? (
              <p>
                <a href="/?tab=schedules&view=runs">
                  Check the run ledger for job {errorJobId}
                </a>
              </p>
            ) : null}
          </Notice>
        ) : null}
        {result ? (
          <>
            <p>
              {result.summary} (as of {formatTime(result.asOf)})
            </p>
            {result.holdingsStatus && !result.holdingsStatus.available ? (
              <Notice tone="warning" title="Exit signals unavailable">
                The hunt ran on entries only: the holdings read did not
                report
                {result.holdingsStatus.broker
                  ? ` for ${result.holdingsStatus.broker}`
                  : ""}
                {result.holdingsStatus.reason
                  ? ` — ${result.holdingsStatus.reason}`
                  : ""}
                . No exit was silently dropped; there was nothing held to
                evaluate.
              </Notice>
            ) : null}
            <Table<OpportunityHuntSymbolRow>
              columns={[
                {
                  key: "symbol",
                  header: (
                    <SortHeader label="Symbol" sortKey="symbol" sort={sort} onSort={handleSort} />
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
                    <SortHeader label="Patterns" sortKey="patterns" sort={sort} onSort={handleSort} />
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
                  render: (row) =>
                    row.entryLow !== null && row.entryHigh !== null
                      ? `${formatHuntPrice(row.entryLow)} – ${formatHuntPrice(row.entryHigh)}`
                      : "—",
                },
                {
                  key: "stopLoss",
                  header: "Stop-loss",
                  align: "right",
                  render: (row) => formatHuntPrice(row.stopLoss),
                },
                {
                  key: "takeProfit",
                  header: "Take-profit",
                  align: "right",
                  render: (row) => formatHuntPrice(row.takeProfit),
                },
                {
                  key: "lastClose",
                  header: (
                    <SortHeader label="Last close" sortKey="lastClose" sort={sort} onSort={handleSort} />
                  ),
                  ariaSort:
                    sort.key === "lastClose"
                      ? sort.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined,
                  align: "right",
                  render: (row) => formatHuntPrice(row.lastClose),
                },
              ]}
              rows={rows}
              rowKey={(row) => row.symbol}
              onRowClick={(row) => setSelectedSymbol(row.symbol)}
              rowClassName={(row) =>
                row.symbol === selectedRow?.symbol ? "is-selected" : ""
              }
              caption="One row per symbol — pattern count, entry and exit signals, and the entry recommendation's price range. Select a row for its recommendations and chart."
              empty={
                <EmptyState
                  title="No setups"
                  description="The latest bar produced no entry signal for any symbol."
                />
              }
            />
            <p>
              Scanned {result.scanned} symbol(s)
              {result.skipped > 0
                ? `, ${result.skipped} skipped (short history)`
                : ""}
              .
            </p>
            {selectedRow ? (
              <Card>
                <CardHeader
                  title={`${selectedRow.symbol} — recommendations`}
                />
                <p>
                  Last close {formatHuntPrice(selectedRow.lastClose)}
                  {selectedRow.exitGainPct !== null
                    ? ` · exits ${formatHuntPct(selectedRow.exitGainPct)} vs cost basis`
                    : ""}
                  .
                </p>
                {selectedRow.entries.length > 0 ? (
                  <>
                    <SmallHeader title="Entry recommendations" />
                    <ul>
                      {selectedRow.entries.map((setup) => (
                        <li key={setup.strategy}>
                          <Badge tone="success">{setup.strategy}</Badge>{" "}
                          {setup.detail} — enter{" "}
                          {setup.levels
                            ? `${formatHuntPrice(setup.levels.entryLow)} – ${formatHuntPrice(setup.levels.entryHigh)}`
                            : "—"}
                          , stop-loss{" "}
                          {formatHuntPrice(setup.levels?.stopLoss)}, take-profit{" "}
                          {formatHuntPrice(setup.levels?.takeProfit)}.
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {selectedRow.exits.length > 0 ? (
                  <>
                    <SmallHeader title="Exit recommendations" />
                    <ul>
                      {selectedRow.exits.map((setup) => (
                        <li key={setup.strategy}>
                          <Badge tone="danger">{setup.strategy}</Badge>{" "}
                          {setup.detail} — exit at{" "}
                          {formatHuntPrice(setup.lastClose)}, entered at{" "}
                          {formatHuntPrice(setup.entryPrice)}
                          {setup.entryPrice
                            ? ` (${formatHuntPct((setup.lastClose - setup.entryPrice) / setup.entryPrice)})`
                            : ""}
                          .
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {selectedRow.entries.length === 0 &&
                selectedRow.exits.length === 0 ? (
                  <p>No recommendations for this symbol.</p>
                ) : null}
                <OpportunityHuntChart
                  symbol={selectedRow.symbol}
                  closes={selectedCloses}
                  labels={selectedLabels}
                  entryLow={selectedRow.entryLow}
                  entryHigh={selectedRow.entryHigh}
                  stopLoss={selectedRow.stopLoss}
                  takeProfit={selectedRow.takeProfit}
                  entryPrice={
                    selectedRow.exits[0]?.entryPrice ?? null
                  }
                  lastClose={selectedRow.lastClose}
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </Card>
      <Card>
        <CardHeader title="Latest scheduled run" />
        {lastRunError ? (
          <Notice tone="warning" title="The run ledger could not be read">
            {lastRunError}
          </Notice>
        ) : lastRun ? (
          <p>
            {formatTime(lastRun.finished)} — {lastRun.outcome}
            {lastRun.descriptor ? `: ${lastRun.descriptor}` : ""}
          </p>
        ) : (
          <EmptyState
            title="No scheduled run yet"
            description="The scheduled goal has not recorded a hunt run in the ledger."
          />
        )}
        <p>
          <a href="/?tab=schedules&view=runs">Open the run ledger</a>
        </p>
      </Card>
    </PageSection>
  );
}
