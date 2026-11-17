/**
 * Issue #5169 — the SecHub-style Archive panel: the R2 archive
 * file browser for the Observability tab
 * (`?tab=observability&view=archive`).
 *
 * A RAW file browser, not a dashboard: it lists the archived
 * OTLP JSONL objects (date, signal, size) with a link to view
 * or download each object's raw content. No charts, no
 * aggregation, no querying — that is the S8 dashboard (#5087).
 * Read-only: no delete, rename, or move of archived objects.
 *
 * Honest states: when the R2 destination switch is OFF the
 * panel states plainly that archiving is off instead of showing
 * an empty list; an empty archive (enabled, zero objects) says
 * so; a failed fetch renders its error, never invented rows.
 * Composed from ui/ primitives (ADR-0004): Stack for layout,
 * Spinner for loading, Notice for the fail-closed warning,
 * EmptyState for honest empty states, Table for the rows.
 * No bespoke className tokens, no inline styles, no CSS imports.
 */
import { useEffect, useState } from "react";
import {
  Button,
  CardHeader,
  EmptyState,
  Notice,
  Spinner,
  Stack,
  Table,
  type TableColumn,
} from "./components/ui";
import {
  fetchOtelArchiveList,
  otelArchiveObjectUrl,
  type OtelArchiveListObject,
  type OtelArchiveListResponse,
} from "./otelArchiveApi";

/** Human-readable byte size (B / KB / MB, one decimal above bytes). */
export function formatArchiveBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      archivingEnabled: boolean;
      objects: OtelArchiveListObject[];
      truncated: boolean;
      cursor?: string;
      loadingMore: boolean;
    };

function groupByDate(objects: OtelArchiveListObject[]): { date: string; rows: OtelArchiveListObject[] }[] {
  const groups = new Map<string, OtelArchiveListObject[]>();
  for (const obj of objects) {
    const rows = groups.get(obj.date) ?? [];
    rows.push(obj);
    groups.set(obj.date, rows);
  }
  // Newest date first — the archive is read newest-first.
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, rows]) => ({ date, rows }));
}

const ARCHIVE_COLUMNS: TableColumn<OtelArchiveListObject>[] = [
  {
    key: "object",
    header: "Object",
    render: (row) => row.key.split("/").pop() ?? row.key,
  },
  {
    key: "signal",
    header: "Signal",
    render: (row) => row.signal,
  },
  {
    key: "size",
    header: "Size",
    render: (row) => formatArchiveBytes(row.sizeBytes),
    align: "right",
  },
  {
    key: "lines",
    header: "Lines",
    render: (row) => String(row.lines),
    align: "right",
  },
  {
    key: "links",
    header: "Raw content",
    render: (row) => (
      <>
        <a href={otelArchiveObjectUrl(row.key)} target="_blank" rel="noreferrer">
          View
        </a>{" "}
        <a href={otelArchiveObjectUrl(row.key)} download={row.key.split("/").pop() ?? "archive.jsonl"}>
          Download
        </a>
      </>
    ),
  },
];

export function OtelArchivePanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchOtelArchiveList()
      .then((list: OtelArchiveListResponse) => {
        if (cancelled) return;
        setState({
          status: "ready",
          archivingEnabled: list.archivingEnabled,
          objects: list.objects,
          truncated: list.truncated,
          cursor: list.cursor,
          loadingMore: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load the OTel archive.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = () => {
    if (state.status !== "ready" || !state.cursor || state.loadingMore) return;
    const cursor = state.cursor;
    setState({ ...state, loadingMore: true });
    void fetchOtelArchiveList(cursor)
      .then((list: OtelArchiveListResponse) => {
        setState((current) => {
          if (current.status !== "ready") return current;
          return {
            ...current,
            objects: [...current.objects, ...list.objects],
            truncated: list.truncated,
            cursor: list.cursor,
            loadingMore: false,
          };
        });
      })
      .catch((err: unknown) => {
        setState({
          status: "error",
          message:
            err instanceof Error ? err.message : "Failed to load the OTel archive.",
        });
      });
  };

  if (state.status === "loading") {
    return (
      <Stack>
        <Spinner label="Loading archived telemetry" />
        <p>Loading archived telemetry…</p>
      </Stack>
    );
  }

  if (state.status === "error") {
    const forbidden = /platform admins only/i.test(state.message);
    return (
      <EmptyState
        title={
          forbidden
            ? "The OTel archive is available to platform admins only."
            : "The OTel archive could not be loaded."
        }
        description={state.message}
      />
    );
  }

  if (!state.archivingEnabled) {
    return (
      <Stack>
        <p>
          The OTel archive is the raw OTLP JSONL written to R2 — one object per ingestion
          batch, one OTLP record per line. This is a file browser, not a dashboard: open
          any object to see its raw content.
        </p>
        <Notice tone="warning">
          R2 archiving is off — the R2 destination switch (OTEL_DESTINATION_R2_ENABLED) is
          off, so no new telemetry is being archived to R2. Turn the destination on to
          resume archiving.
        </Notice>
      </Stack>
    );
  }

  const groups = groupByDate(state.objects);

  return (
    <Stack gap="2">
      <p>
        The OTel archive is the raw OTLP JSONL written to R2 — one object per ingestion
        batch, one OTLP record per line. This is a file browser, not a dashboard: open
        any object to see its raw content. Charts, aggregation, and querying arrive with
        the S8 dashboard.
      </p>
      {groups.length === 0 ? (
        <EmptyState title="No archived objects yet." description="Nothing has been archived to R2 yet — S1 logs and S2 metrics write one object per ingestion batch." />
      ) : (
        groups.map(({ date, rows }) => (
          <div key={date}>
            <CardHeader title={date} />
            <Table<OtelArchiveListObject>
              columns={ARCHIVE_COLUMNS}
              rows={rows}
              rowKey={(row) => row.key}
              caption={`Archived OTLP objects from ${date}`}
            />
          </div>
        ))
      )}
      {state.truncated && state.cursor ? (
        <Button variant="secondary" onClick={loadMore} loading={state.loadingMore}>
          Load more
        </Button>
      ) : null}
    </Stack>
  );
}
