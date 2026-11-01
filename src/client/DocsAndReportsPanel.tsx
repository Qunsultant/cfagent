/**
 * Docs & Reports — the document index for the screener workflow.
 *
 * Every run of the screener workflow records the artifacts it produced
 * (PDF / XLSX / CSV) in the Runs read surface (GET /api/runs). This page
 * lists those runs as one row per run, with the run's family
 * (stock / options / goal / strategy), how it was started
 * (manual / scheduled), direct download links for each artifact, and the
 * run id for cross-referencing.
 *
 * The page reads, it never generates: a link is only shown when the run
 * recorded that artifact's key, so a missing file is an honest "—" and
 * not a 404 in disguise.
 *
 * Every column is sortable (header buttons + `aria-sort`), and the table
 * scrolls inside a constrained page frame: a long run ledger is reachable
 * without the shell clipping it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch as fetch } from "./apiFetch";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Spinner,
  Table,
  type TableColumn,
} from "./components/ui";
import {
  DOCUMENT_SORT_DEFAULT,
  DOCUMENT_SOURCE_LABELS,
  formatRunTimestamp,
  nextDocumentSort,
  sortDocumentRows,
  toDocumentRows,
  type DocumentRow,
  type DocumentRunType,
  type DocumentSort,
  type DocumentSortKey,
} from "./docsAndReports";
import { RunDetailsModal } from "./components/RunDetailsModal";
import type { RunDetail } from "./runDetails";
import "./docsAndReports.css";

const RUN_TYPE_LABELS: Record<DocumentRunType, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
};

const SORT_LABELS: Record<DocumentSortKey, string> = {
  createdAt: "Date-Time",
  runType: "Run Type",
  runSource: "Run Source",
  pdf: "PDF",
  xlsx: "XLSX",
  csv: "CSV",
  runId: "Run ID",
};

function RunTypeCell({ row }: { row: DocumentRow }) {
  if (!row.runType) {
    // Honest absence: some stores record no trigger at all (options scans).
    return (
      <span className="docs-run-type unknown" title="The run's store recorded no trigger">
        —
      </span>
    );
  }
  return (
    <span className={`docs-run-type ${row.runType}`} title={row.rawTrigger ?? undefined}>
      <Badge size="sm" tone={row.runType === "scheduled" ? "info" : "neutral"}>
        {RUN_TYPE_LABELS[row.runType]}
      </Badge>
    </span>
  );
}

function ArtifactLink({
  url,
  kind,
  runId,
  status,
  error,
}: {
  url: string | null;
  kind: "PDF" | "XLSX" | "CSV";
  runId: string;
  status?: string | null;
  error?: string | null;
}) {
  if (!url && status === "failed") {
    // Issue #2088: a recorded leg failure renders as a failure
    // state with its reason, never a bare "—".
    return (
      <span className="docs-artifact-failed" title={error ?? undefined}>
        <Badge size="sm" tone="danger">failed</Badge>
      </span>
    );
  }
  if (!url) {
    return (
      <span className="docs-artifact-missing" title={`This run recorded no ${kind} artifact`}>
        —
      </span>
    );
  }
  return (
    <a
      className="docs-artifact-link"
      href={url}
      download
      title={`Download the ${kind} for run ${runId}`}
      aria-label={`Download the ${kind} for run ${runId}`}
    >
      {kind}
    </a>
  );
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
  sortKey: DocumentSortKey;
  sort: DocumentSort;
  onSort: (key: DocumentSortKey) => void;
}) {
  const active = sort.key === sortKey;
  const direction = sort.dir === "asc" ? "ascending" : "descending";
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`ui-table-sort${active ? " active" : ""}`}
      onClick={() => onSort(sortKey)}
      title={active ? `Sorted ${direction} — click to reverse` : `Sort by ${label}`}
      aria-label={active ? `${label}, sorted ${direction}. Reverse order` : `Sort by ${label}`}
    >
      <span className="docs-sort-label">{label}</span>
      <span className="ui-table-sort-indicator" aria-hidden="true">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </Button>
  );
}

export function DocsAndReportsPanel() {
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeErrors, setStoreErrors] = useState<Record<string, string>>({});
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [sort, setSort] = useState<DocumentSort>(DOCUMENT_SORT_DEFAULT);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [details, setDetails] = useState<RunDetail | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const openDetails = useCallback(async (row: DocumentRow) => {
    setDetailsOpen(true);
    setDetailsLoading(true);
    setDetailsError(null);
    setDetails(null);
    try {
      const res = await fetch(`/api/runs/details?runId=${encodeURIComponent(row.runId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { detail?: RunDetail };
      if (!data.detail) throw new Error("No run details returned");
      setDetails(data.detail);
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : "Failed to load run details");
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/runs?kind=all&limit=100");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        runs?: unknown[];
        storeErrors?: Record<string, string>;
      };
      setRows(toDocumentRows((data.runs ?? []) as Parameters<typeof toDocumentRows>[0]));
      setStoreErrors(data.storeErrors ?? {});
      setLoadedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSort = useCallback((key: DocumentSortKey) => {
    setSort((current) => nextDocumentSort(current, key));
  }, []);

  const sortedRows = useMemo(() => sortDocumentRows(rows, sort), [rows, sort]);

  const columns = useMemo<TableColumn<DocumentRow>[]>(() => {
    const ariaSort = (key: DocumentSortKey) =>
      sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;

    return [
      {
        key: "createdAt",
        header: (
          <SortHeader label={SORT_LABELS.createdAt} sortKey="createdAt" sort={sort} onSort={handleSort} />
        ),
        ariaSort: ariaSort("createdAt"),
        render: (row) => (
          <time className="docs-time" dateTime={row.createdAt} title={row.createdAt}>
            {formatRunTimestamp(row.createdAt)}
          </time>
        ),
      },
      {
        key: "runType",
        header: <SortHeader label={SORT_LABELS.runType} sortKey="runType" sort={sort} onSort={handleSort} />,
        ariaSort: ariaSort("runType"),
        render: (row) => <RunTypeCell row={row} />,
      },
      {
        key: "runSource",
        header: (
          <SortHeader label={SORT_LABELS.runSource} sortKey="runSource" sort={sort} onSort={handleSort} />
        ),
        ariaSort: ariaSort("runSource"),
        render: (row) => (
          <span className={`docs-source ${row.runSource}`}>
            {DOCUMENT_SOURCE_LABELS[row.runSource]}
          </span>
        ),
      },
      {
        key: "pdf",
        header: <SortHeader label={SORT_LABELS.pdf} sortKey="pdf" sort={sort} onSort={handleSort} />,
        ariaSort: ariaSort("pdf"),
        render: (row) => (
          <ArtifactLink
            url={row.pdfUrl}
            kind="PDF"
            runId={row.runId}
            status={row.pdfStatus}
            error={row.pdfError}
          />
        ),
      },
      {
        key: "xlsx",
        header: <SortHeader label={SORT_LABELS.xlsx} sortKey="xlsx" sort={sort} onSort={handleSort} />,
        ariaSort: ariaSort("xlsx"),
        render: (row) => (
          <ArtifactLink
            url={row.xlsxUrl}
            kind="XLSX"
            runId={row.runId}
            status={row.xlsxStatus}
            error={row.xlsxError}
          />
        ),
      },
      {
        key: "csv",
        header: <SortHeader label={SORT_LABELS.csv} sortKey="csv" sort={sort} onSort={handleSort} />,
        ariaSort: ariaSort("csv"),
        render: (row) => (
          <ArtifactLink
            url={row.csvUrl}
            kind="CSV"
            runId={row.runId}
            status={row.csvStatus}
            error={row.csvError}
          />
        ),
      },
      {
        key: "runId",
        header: <SortHeader label={SORT_LABELS.runId} sortKey="runId" sort={sort} onSort={handleSort} />,
        ariaSort: ariaSort("runId"),
        render: (row) => (
          <code className="docs-run-id" title={row.runId}>
            {row.runId}
          </code>
        ),
      },
      {
        key: "details",
        header: "Run Details",
        render: (row) => (
          <Button variant="secondary" size="sm" onClick={() => void openDetails(row)} aria-label={`Run details for ${row.runId}`}>
            Run Details
          </Button>
        ),
      },
    ];
  }, [handleSort, openDetails, sort]);

  const storeErrorNames = Object.keys(storeErrors);

  return (
    <div className="docs-report-page">
      <header className="docs-header">
        <div>
          <h2 className="docs-title">Docs & Reports</h2>
          <p className="docs-scope">
            Every document set produced by a screener-workflow run — stock, options, goal and
            strategy — with the PDF, XLSX and CSV that run generated. Links are shown only when
            the run recorded that artifact.
          </p>
        </div>
        <div className="docs-toolbar">
          {loadedAt && <span className="docs-loaded-at">Updated {loadedAt}</span>}
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </header>

      {error && (
        <Notice tone="danger" title="Documents unavailable">
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </Notice>
      )}

      {!error && storeErrorNames.length > 0 && (
        <Notice tone="warning" title="Some run stores were skipped">
          {storeErrorNames.map((name) => `${name}: ${storeErrors[name]}`).join(" · ")}
        </Notice>
      )}

      {loading && rows.length === 0 ? (
        <div className="docs-loading">
          <Spinner label="Loading documents" />
          <span>Loading documents…</span>
        </div>
      ) : (
        <>
          <div className="docs-count" aria-live="polite">
            {sortedRows.length} {sortedRows.length === 1 ? "run" : "runs"} · sorted by{" "}
            {SORT_LABELS[sort.key]}, {sort.dir === "asc" ? "ascending" : "descending"}
          </div>
          {sortedRows.length >= 100 && (
            <Notice tone="info" title="Run list capped at 100">
              The request fetches at most 100 runs, so older runs are not shown here.
            </Notice>
          )}
          <RunDetailsModal
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            detail={details}
            loading={detailsLoading}
            error={detailsError}
          />
          <Table
            caption="Documents generated by screener-workflow runs, newest first"
            columns={columns}
            rows={sortedRows}
            rowKey={(row) => `${row.runSource}:${row.id}`}
            containerClassName="docs-table-container"
            stickyHeader
            empty={
              <EmptyState
                icon="🗂"
                title="No screener documents yet"
                description="Documents appear here after a stock, options, goal or strategy run completes. Each row links the PDF, XLSX and CSV that run generated."
                action={
                  <Button variant="secondary" size="sm" onClick={() => void load()}>
                    Check again
                  </Button>
                }
              />
            }
          />
        </>
      )}
    </div>
  );
}
