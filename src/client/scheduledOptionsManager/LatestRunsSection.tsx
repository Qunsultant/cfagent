import React from "react";
import { Badge, CardHeader, Table, type TableColumn } from "../components/ui";
import type { OptionsRunSummary } from "./types";

export interface LatestRunsSectionProps {
  latestRuns: OptionsRunSummary[];
  runsLoading: boolean;
  runsError: string | null;
}

/**
 * Latest autonomous options runs (#223), one row per run (issue
 * #2329). This section is read-only: the page's single Refresh control
 * refetches it, and it polls every 60s so a scheduled fire appears
 * without a manual refresh.
 */
export function LatestRunsSection({ latestRuns, runsLoading, runsError }: LatestRunsSectionProps) {
  const columns: TableColumn<OptionsRunSummary>[] = [
    {
      key: "timestamp",
      header: "Completed",
      render: (run) => (
        <span className="schedule-row-muted">{new Date(run.timestamp).toLocaleString()}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (run) => (
        <Badge tone={run.success ? "success" : "danger"} size="xs" dot>
          {run.success ? "Completed" : "Failed"}
        </Badge>
      ),
    },
    {
      key: "symbols",
      header: "Symbols",
      render: (run) =>
        run.symbols && run.symbols.length > 0 ? run.symbols.join(", ") : "Whole universe",
    },
    {
      key: "setups",
      header: "Actionable setups",
      align: "right",
      render: (run) => <strong>{run.withTrades ?? 0}</strong>,
    },
    {
      key: "trigger",
      header: "Trigger",
      render: (run) => (
        <span className="schedule-row-stack">
          <span className="schedule-row-value">{run.trigger || "scheduled"}</span>
          {run.thesis && <span className="schedule-row-muted">{run.thesis}</span>}
        </span>
      ),
    },
    {
      key: "summary",
      header: "Summary",
      render: (run) => (
        <span className="schedule-row-summary">{run.summary || run.error || "—"}</span>
      ),
    },
  ];

  return (
    <section className="sched-section-card">
      <header className="sched-section-header">
        <CardHeader
          title={
            <>
              <span aria-hidden="true">📈</span> Latest Autonomous Options Runs
              <span className="sched-count-pill">{latestRuns.length} Runs</span>
            </>
          }
        />
        {runsLoading && <span className="schedule-row-muted">Refreshing…</span>}
      </header>

      {runsError ? (
        <p className="sched-inline-error" role="alert">
          {runsError}
        </p>
      ) : null}

      <Table
        columns={columns}
        rows={latestRuns}
        rowKey={(run, index) => `${run.timestamp}-${index}`}
        caption="Latest autonomous options analysis runs"
        containerClassName="sched-table-scroll"
        empty={
          <p className="sched-table-status">
            No options runs recorded yet. A scheduled or manual analysis appears here once it
            completes.
          </p>
        }
      />
    </section>
  );
}
