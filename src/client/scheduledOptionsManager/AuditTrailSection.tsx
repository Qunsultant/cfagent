import React from "react";
import { Badge, Table, type TableColumn } from "../components/ui";
import { formatAuditTimestamp } from "./format";

export interface AuditTrailSectionProps {
  auditLogs: any[];
  loadingAudit: boolean;
}

/**
 * Execution history, one row per event (issue #2329). Read-only: the
 * page's single Refresh control refetches it. Every cell renders an
 * explicit value (an em dash where nothing was recorded) so a blank
 * cell never reads as "fine".
 */
export function AuditTrailSection({ auditLogs, loadingAudit }: AuditTrailSectionProps) {
  const columns: TableColumn<any>[] = [
    {
      key: "timestamp",
      header: "Timestamp",
      // Issue #4353 — the date AND the time: a time alone cannot say when.
      render: (log) => (
        <span className="schedule-row-muted">
          {formatAuditTimestamp(log.created_at ?? log.createdAt)}
        </span>
      ),
    },
    {
      key: "eventType",
      header: "Event Type",
      render: (log) => (
        <span className="sched-audit-event">
          <Badge tone={String(log.type).includes("failed") ? "danger" : "success"} size="xs" dot>
            {String(log.type).includes("failed") ? "Failed" : "Recorded"}
          </Badge>
          <code>{log.type}</code>
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      render: (log) => {
        const payload = log.payload || {};
        const reason = payload.reason ? String(payload.reason) : null;
        const detail = payload.detail ? String(payload.detail) : null;
        const action = payload.action ? String(payload.action) : null;
        if (!reason && !detail) return <span className="schedule-row-muted">—</span>;
        return (
          <code title={[detail, action].filter(Boolean).join(" ")}>
            {reason ?? detail}
          </code>
        );
      },
    },
    {
      key: "runId",
      header: "Run ID",
      render: (log) => <code>{(log.payload || {}).runId || "–"}</code>,
    },
    {
      key: "screenType",
      header: "Screen Type",
      render: (log) => {
        const payload = log.payload || {};
        const callback = String(payload.callback || "");
        const screenType =
          payload.screenType ||
          (String(log.type).startsWith("screener.") || callback.includes("MarketScreen")
            ? "stock"
            : String(log.type).startsWith("options.") || callback.includes("OptionsAnalysis")
              ? "options"
              : null);
        return screenType ? screenType[0].toUpperCase() + screenType.slice(1) : "–";
      },
    },
    {
      key: "runType",
      header: "Run Type",
      render: (log) => {
        const payload = log.payload || {};
        const runType =
          payload.runType ||
          payload.trigger ||
          (String(log.type).startsWith("schedule.") ? "scheduled" : null);
        return runType
          ? String(runType)
              .replace(/[-_]/g, " ")
              .replace(/^./, (value: string) => value.toUpperCase())
          : "–";
      },
    },
    {
      key: "symbols",
      header: "Symbols",
      render: (log) => {
        const symbols = Array.isArray((log.payload || {}).symbols) ? (log.payload || {}).symbols : [];
        return symbols.length > 0 ? symbols.join(", ") : "–";
      },
    },
    {
      key: "setups",
      header: "Actionable Setups",
      align: "right",
      render: (log) => {
        const payload = log.payload || {};
        const actionableSetups =
          payload.opportunityCount ?? payload.matchedCount ?? payload.withTrades;
        return <strong>{actionableSetups ?? "–"}</strong>;
      },
    },
    {
      key: "channels",
      header: "Dispatched Channels",
      render: (log) => {
        const notifications = (log.payload || {}).notifications || {};
        const dispatched = ["slack", "email", "webhook"]
          .filter((channel) => Object.prototype.hasOwnProperty.call(notifications, channel))
          .map(
            (channel) =>
              `${channel[0].toUpperCase()}${channel.slice(1)}: ${notifications[channel] ? "sent" : "not sent"}`
          );
        return dispatched.length > 0 ? dispatched.join(", ") : "–";
      },
    },
  ];

  return (
    // Issue #4353 — ONE heading row: the section name, its count and what the
    // table IS (the caption it used to stack above) live on the same line, so
    // the page no longer shows two titles for one table.
    <section className="sched-section-card" aria-labelledby="sched-audit-heading">
      <header className="sched-section-header">
        <h4 id="sched-audit-heading">
          <span aria-hidden="true">📜</span> Execution History &amp; Audit Trail
          <span className="sched-count-pill">{auditLogs.length} Events</span>
          <small className="schedule-row-muted">Schedule execution history</small>
        </h4>
        {loadingAudit && <span className="schedule-row-muted">Loading…</span>}
      </header>

      <Table
        columns={columns}
        rows={auditLogs}
        rowKey={(log) => log.id}
        containerClassName="sched-table-scroll"
        empty={
          <p className="sched-table-status">
            No recent options scheduling audit logs found. Run a screen or wait for the next
            scheduled interval to populate this ledger.
          </p>
        }
      />
    </section>
  );
}
