/**
 * Issue #3422 — Stock Copilot panel for the chat tab (?tab=chat).
 *
 * Surfaces the signed-in user's own copilot loop (#3391): its live
 * status, the effective broker + mode selection it runs under
 * (#3451 — selected in the dynamic panel menu, only reported here),
 * open positions with their exit plans, recently closed positions,
 * and the recent cycle activity feed — plus the pause/resume
 * control. Pause stops new entries from the next cycle; exit
 * management for open positions keeps running while paused (the
 * panel says so, because that is the safety contract).
 *
 * Built only from src/client/components/ui/ primitives with
 * token-only styling (ux-architecture §20); data loads through
 * stockCopilotApi.ts (apiFetch), mirroring the ApiKeysPanel /
 * NotificationPreferencesPanel panel+api split.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  Spinner,
  Table,
  type BadgeTone,
  type TableColumn,
} from "./components/ui";
import {
  copilotSelectionLabel,
  exitReasonLabel,
  fetchStockCopilotStatus,
  fmtCopilotMoney,
  fmtCopilotTime,
  setStockCopilotPaused,
  type StockCopilotActivityRecord,
  type StockCopilotOpenPosition,
  type StockCopilotStatus,
  type StockCopilotStatusKind,
} from "./stockCopilotApi";
import "./stockCopilotPanel.css";

/** Auto-refresh cadence for the panel (the loop itself runs every 30 minutes). */
const REFRESH_MS = 60_000;

const STATUS_VIEW: Record<StockCopilotStatusKind, { label: string; tone: BadgeTone }> = {
  live: { label: "Live", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  outside_market_hours: { label: "Outside market hours", tone: "info" },
  off: { label: "Off", tone: "neutral" },
  mode_unresolved: { label: "Mode unresolved", tone: "danger" },
  inactive_broker: { label: "Inactive broker", tone: "neutral" },
};

const OUTCOME_VIEW: Record<StockCopilotActivityRecord["outcome"], { label: string; tone: BadgeTone }> = {
  traded: { label: "Traded", tone: "success" },
  no_trade: { label: "No trade", tone: "neutral" },
  refused: { label: "Refused", tone: "danger" },
  inactive: { label: "Inactive", tone: "neutral" },
};

const POSITION_COLUMNS: Array<TableColumn<StockCopilotOpenPosition>> = [
  { key: "symbol", header: "Symbol", render: (p) => p.symbol },
  { key: "strategy", header: "Strategy", render: (p) => p.strategy },
  { key: "quantity", header: "Qty", align: "right", render: (p) => p.quantity },
  { key: "entry", header: "Entry", align: "right", render: (p) => fmtCopilotMoney(p.entryPrice) },
  { key: "stop", header: "Stop", align: "right", render: (p) => fmtCopilotMoney(p.stopPrice) },
  { key: "target", header: "Target", align: "right", render: (p) => fmtCopilotMoney(p.targetPrice) },
  { key: "opened", header: "Opened", render: (p) => fmtCopilotTime(p.openedAt) },
];

function activitySummary(record: StockCopilotActivityRecord): string {
  const parts: string[] = [];
  for (const symbol of record.entries) parts.push(`Bought ${symbol}`);
  for (const exit of record.exits) {
    parts.push(`Sold ${exit.symbol} (${exitReasonLabel(exit.reason).toLowerCase()})`);
  }
  if (parts.length > 0) return parts.join(" · ");
  if (record.outcome === "no_trade") return record.detail ?? "No trades this cycle";
  if (record.outcome === "inactive") {
    return "Inactive — a different broker is active in the panel menu";
  }
  if (record.outcome === "refused") {
    if (record.detail === "stock_copilot_mode_unresolved") {
      return "Trading mode could not be resolved — cycle refused";
    }
    if (record.detail === "stock_copilot_mode_mismatch") {
      return "The selected mode disagreed with the broker environment — cycle refused";
    }
    return "The mode guard refused this cycle";
  }
  return "Cycle completed";
}

export function StockCopilotPanel() {
  const [status, setStatus] = useState<StockCopilotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchStockCopilotStatus());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const togglePause = async () => {
    if (!status) return;
    setToggling(true);
    setToggleError(false);
    try {
      await setStockCopilotPaused(!status.paused);
      await load();
    } catch {
      setToggleError(true);
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <Card className="scp-panel">
        <Spinner label="Loading Stock Copilot status" />
      </Card>
    );
  }

  if (loadError || status === null) {
    return (
      <Card className="scp-panel">
        <Notice tone="danger">
          Stock Copilot status could not be loaded. Try again.
        </Notice>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  const statusView = STATUS_VIEW[status.status];
  const selectionLabel = copilotSelectionLabel(status);

  return (
    <Card className="scp-panel">
      <div className="scp-header">
        <div className="scp-title-group">
          <span className="scp-title">📈 Stock Copilot</span>
          <Badge size="sm" tone={statusView.tone} dot>
            {statusView.label}
          </Badge>
          {selectionLabel && (
            <Badge size="sm" tone="info">
              {selectionLabel}
            </Badge>
          )}
        </div>
        <div className="scp-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            title="Refresh copilot status"
          >
            🔄 Refresh
          </Button>
          {status.paused ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void togglePause()}
              disabled={toggling || !status.flagEnabled}
              loading={toggling}
              title="Resume new entries from the next cycle"
            >
              ▶ Resume entries
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void togglePause()}
              disabled={toggling || !status.flagEnabled}
              loading={toggling}
              title="Stop new entries from the next cycle (exits keep running)"
            >
              ⏸ Pause entries
            </Button>
          )}
        </div>
      </div>

      <p className="scp-desc">
        Pattern-driven trading on the broker and mode selected in the panel
        menu (shown above) — a cycle runs every 30 minutes during market hours
        (9:30–16:00 ET, Mon–Fri) over SPY, QQQ, AAPL, MSFT and NVDA. Every
        position opens with its exit plan (stop and target) attached.
      </p>

      {status.status === "off" && (
        <Notice tone="info">
          The master switch is off in the production configuration, so the loop
          is not running. The pause control applies once it is switched on.
        </Notice>
      )}
      {status.status === "mode_unresolved" && (
        <Notice tone="danger">
          The trading-mode selection could not be read, so the copilot refuses
          every cycle rather than guess a mode. Check the broker selection in
          the panel menu.
        </Notice>
      )}
      {status.status === "inactive_broker" && (
        <Notice tone="info">
          {selectionLabel
            ? `The active selection is ${selectionLabel} — the Stock Copilot trades on Alpaca only, so it stays inactive while another broker is active.`
            : "A different broker is active in the panel menu — the Stock Copilot trades on Alpaca only, so it stays inactive."}{" "}
          Select Alpaca in the panel menu to activate it.
        </Notice>
      )}
      {status.paused && (
        <Notice tone="warning">
          Paused — no new entries will be placed. Open positions are still
          managed: stops, targets and strategy exits keep running.
        </Notice>
      )}
      {toggleError && (
        <Notice tone="danger">
          The pause control could not be updated. Try again.
        </Notice>
      )}

      <div className="scp-section-title">Open positions</div>
      <Table
        columns={POSITION_COLUMNS}
        rows={status.openPositions}
        rowKey={(p) => p.id}
        empty={
          <EmptyState
            icon="📭"
            title="No open positions"
            description="The copilot opens a position when a pattern signal passes its sizing and risk checks."
          />
        }
      />

      {status.closedPositions.length > 0 && (
        <>
          <div className="scp-section-title">Recently closed</div>
          <div className="scp-feed">
            {status.closedPositions.map((p) => (
              <div className="scp-feed-row" key={p.id}>
                <span className="scp-feed-main">
                  {p.symbol} — {exitReasonLabel(p.exitReason)} ·{" "}
                  {fmtCopilotMoney(p.entryPrice)} → {fmtCopilotMoney(p.exitPrice)}
                </span>
                <span className="scp-feed-time">{fmtCopilotTime(p.closedAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="scp-section-title">Cycle activity</div>
      {status.activity.length === 0 ? (
        <EmptyState
          icon="🕒"
          title="No cycles recorded yet"
          description="Cycles appear here after the loop next evaluates the market."
        />
      ) : (
        <div className="scp-feed">
          {status.activity.map((record) => (
            <div className="scp-feed-row" key={record.id}>
              <Badge size="xs" tone={OUTCOME_VIEW[record.outcome].tone}>
                {OUTCOME_VIEW[record.outcome].label}
              </Badge>
              <span className="scp-feed-main">{activitySummary(record)}</span>
              <span className="scp-feed-time">{fmtCopilotTime(record.cycleAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
