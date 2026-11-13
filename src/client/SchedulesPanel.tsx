/**
 * S7 (consolidation, umbrella #958): THE one schedule UI. This panel
 * hosts the screening-schedule section (ScheduledOptionsManager —
 * kind-specific rows, structured create/edit forms, latest runs,
 * audit trail, live preview) for the three screening callbacks and
 * renders every other schedule in the store (system, queued, NLQ
 * reminders, …) as generic rows below it. Payload construction for the
 * screening kinds lives in exactly one place
 * (scheduledOptionsManager/payloadBuilders).
 *
 * Issue #2329: the page is one table per surface — one row per
 * schedule, the full id, and every action on that row. One Edit
 * control (the full form, cadence included), one Details dialog
 * (scheduleDetail.ts's canonical model), one cadence dialog for the
 * generic rows, one confirmation dialog for destructive actions, and
 * exactly one create action on the page (the screening section's hero
 * button). The page's one Refresh control refetches both surfaces.
 *
 * Issue #309: Schedules Panel with tabbed grouping.
 * Issue #273: full schedules management UI — pause/resume, per-job
 * trigger, delete, and a create form fed by the server's callback
 * allow-list (GET /api/schedules returns `creatableCallbacks`).
 *
 * Displays all durable schedules grouped by category:
 * - All | Stocks | Options | System | Queued
 *
 * Paused jobs stay listed with a Paused badge (the backend keeps their
 * definition in the unified store; see services/unifiedScheduleManagement.ts).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Badge,
  Button,
  Notice,
  PillGroup,
  Table,
  useToast,
  type TableColumn,
} from "./components/ui";
import {
  deleteSchedule,
  getSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  updateSchedule,
} from "./jobsApi";
import { CadenceModal } from "./scheduledOptionsManager/CadenceModal";
import { ConfirmModal } from "./scheduledOptionsManager/ConfirmModal";
import { ScheduleDetailModal } from "./scheduledOptionsManager/ScheduleDetailModal";
import { formatNextRun } from "./scheduledOptionsManager/format";
import "./reports.css";

export interface ScheduleItem {
  id: string;
  type: "interval" | "cron" | "delayed" | "scheduled";
  callback: string;
  payload?: any;
  intervalSeconds?: number;
  cron?: string;
  date?: string;
  delayInSeconds?: number;
  /** Unix seconds of the next run (SDK schedules). */
  time?: number;
  createdAt?: string;
  nextRun?: string;
  /** Issue #273: paused jobs are merged into the list by the backend. */
  paused?: boolean;
  pausedAt?: string;
  /** Issue #3121 #3310 — the unified kind, and the workflow + stage a stage-schedule names. */
  /** Issue #3121 #4237 — the ticker-push row's feed facts. */
  kind?: string;
  jobId?: string;
  stageId?: string;
  lastPushAt?: string;
  armed?: boolean;
  health?: "healthy" | "idle" | "stale";
}

// Issue #4329 S2 (#4331): the owner's ten filters, configured in
// src/config/scheduleListModes.ts — one vocabulary, not a second one here.
type ScheduleGroup = ScheduleListFilter;

/** Frequency presets for the one cadence dialog — defined once in the
 *  screening section's format module since S7; re-exported here for
 *  existing importers. */
export { FREQUENCY_PRESETS } from "./scheduledOptionsManager/format";
import { ScheduledOptionsManager } from "./ScheduledOptionsManager";
import {
  SCHEDULE_LIST_FILTER_LABELS,
  resolveScheduleListFilters,
  type ScheduleListFilter,
  type ScheduleListKind,
} from "../config/scheduleListModes";
import { classifyScheduleKind, countSchedulesByKind } from "../services/scheduleKinds";
import type { TradeOrderContext } from "./trading/tradeOrderContext";

/**
 * Translate a cron expression to human-readable English.
 * Supports the patterns used by our schedulers.
 */
export function cronToEnglish(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;

  const [min, hour, dom, month, dow] = parts;

  // Hourly: "5 * * * *" → "Every hour at :05"
  if (hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const m = min.padStart(2, "0");
    return `Every hour at :${m}`;
  }

  // Daily: "0 3 * * *" → "Daily at 3:00 AM UTC"
  if (dom === "*" && month === "*" && dow === "*") {
    const h = parseInt(hour, 10);
    const m = min.padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `Daily at ${h12}:${m} ${ampm} UTC`;
  }

  // Weekly: "15 22 * * 1-5" → "Weekdays at 10:15 PM UTC"
  if (dom === "*" && month === "*") {
    const h = parseInt(hour, 10);
    const m = min.padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const days = dow === "1-5" ? "Weekdays" :
                 dow === "0" ? "Sundays" :
                 dow === "6" ? "Saturdays" : `Days ${dow}`;
    return `${days} at ${h12}:${m} ${ampm} UTC`;
  }

  return cron;
}

/**
 * Categorize a schedule into a kind for filtered display.
 *
 * Issue #4329 S2 — one classifier for the page: `classifyScheduleKind`
 * (src/services/scheduleKinds.ts). Kept as the exported name existing
 * importers use; the rule table lives in the service, not here.
 */
export function categorizeSchedule(s: ScheduleItem): ScheduleListKind {
  return classifyScheduleKind(s);
}

/** One-line payload summary for payloads without universe/thesis. */
export function payloadSummary(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  if (Array.isArray(payload.symbols) && payload.symbols.length) {
    return `Symbols: ${payload.symbols.slice(0, 6).join(", ")}${payload.symbols.length > 6 ? "…" : ""}`;
  }
  const keys = Object.keys(payload).filter(
    (k) => !["userLogin", "environment", "env", "trigger"].includes(k)
  );
  if (!keys.length) return "";
  const text = keys
    .slice(0, 4)
    .map((k) => {
      const v = payload[k];
      const rendered = typeof v === "object" ? "…" : String(v);
      return `${k}: ${rendered}`;
    })
    .join(" · ");
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

interface SchedulesPanelProps {
  activeEnv?: string;
  userLogin?: string;
  /** S7: forwarded to the screening section's live-result preview. */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  /**
   * Issue #3121 S2: `schedule=<id>` deep link — once the list loads,
   * open the detail dialog for this schedule (the panel's per-schedule
   * view). A missing id shows a notice instead of silently landing on
   * the unfiltered list. Re-applies when the id changes; closing the
   * dialog does not re-open it.
   */
  focusScheduleId?: string | null;
}

export const SCREENING_CALLBACKS = new Set([
  "autonomousMarketScreen",
  "autonomousOptionsAnalysis",
  "autonomousStrategyDiscovery",
]);

const ACCOUNT_SCOPED = [
  "autonomousmarketscreen",
  "autonomousoptionsanalysis",
  "autorenewetradetokens",
  "collectivhistory",
];

/** The row name: a stage-schedule names its workflow + stage, a ticker-push row names the live feed, not the firing callback. */
export function scheduleDisplayName(s: ScheduleItem): string {
  if (s.kind === "workflow-stage" && s.jobId) {
    return s.stageId ? `${s.jobId} · ${s.stageId}` : s.jobId;
  }
  if (s.kind === "ticker-push") return "Ticker push";
  return s.callback;
}

/** Last-push rendering for a ticker-push row (never a fabricated time). */
function formatLastPush(lastPushAt?: string): string {
  if (!lastPushAt) return "never";
  const ms = Date.parse(lastPushAt);
  if (!Number.isFinite(ms)) return "never";
  return new Date(ms).toLocaleString();
}

/** Cadence sentence for a generic row. */
function genericCadence(s: ScheduleItem): string {
  if (s.cron) return cronToEnglish(s.cron);
  // Issue #3121 #4237 — sub-minute intervals (the ticker default is
  // 5s) read as seconds, not "Every 0 min".
  if (s.type === "interval" && (s.intervalSeconds || 0) > 0 && (s.intervalSeconds || 0) < 60) {
    return `Every ${s.intervalSeconds} sec`;
  }
  if (s.type === "interval") return `Every ${Math.round((s.intervalSeconds || 0) / 60)} min`;
  if (s.type === "delayed") return "Delayed (queued)";
  return s.type;
}

export function SchedulesPanel({ activeEnv, userLogin, onPreviewTrade, focusScheduleId = null }: SchedulesPanelProps) {
  const toast = useToast();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduleGroup>("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cadenceTarget, setCadenceTarget] = useState<ScheduleItem | null>(null);
  const [cadenceBusy, setCadenceBusy] = useState(false);
  const [cadenceError, setCadenceError] = useState<string | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<ScheduleItem | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const envHeaders = activeEnv ? { "x-environment": activeEnv } : undefined;

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Issue #3121 Phase 2 (#3123) — the one client module; the
      // list item is the server shape (ScheduleItem is the panel's
      // wider local view of the same rows).
      setSchedules(
        (await listSchedules(envHeaders)) as unknown as ScheduleItem[],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [activeEnv]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  /** Shared mutating-action helper: run, surface errors, refresh. */
  const runAction = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await fetchSchedules();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  /** The page's ONE refresh: both surfaces, one round trip each. */
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await fetchSchedules();
      setRefreshSignal((n) => n + 1);
    } finally {
      setRefreshing(false);
    }
  };

  const handleTriggerNow = async (s: ScheduleItem) => {
    const ok = await runAction(() => triggerSchedule(s.id, envHeaders));
    if (ok) {
      toast.success(`Triggered ${s.callback}`);
      setRefreshSignal((n) => n + 1);
    }
  };

  const handlePauseResume = async (s: ScheduleItem) => {
    const ok = await runAction(() =>
      s.paused
        ? resumeSchedule(s.id, envHeaders)
        : pauseSchedule(s.id, envHeaders),
    );
    if (ok) setRefreshSignal((n) => n + 1);
  };

  const applyFrequency = async (
    s: ScheduleItem,
    body: { scheduleType: "interval" | "cron"; intervalSeconds?: number; cron?: string }
  ) => {
    setCadenceBusy(true);
    setCadenceError(null);
    try {
      await updateSchedule(s.id, body, envHeaders);
      setCadenceTarget(null);
      toast.success(`Cadence updated for ${s.id}`);
      await fetchSchedules();
      setRefreshSignal((n) => n + 1);
    } catch (err) {
      setCadenceError(err instanceof Error ? err.message : String(err));
    } finally {
      setCadenceBusy(false);
    }
  };

  const readDetails = async (s: ScheduleItem) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await getSchedule(s.id, envHeaders));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Schedule details unavailable.");
    } finally {
      setDetailLoading(false);
    }
  };

  // Issue #3121 S2: `schedule=<id>` deep link — open the detail dialog
  // for the focused schedule once the list has loaded. The applied id
  // is tracked so a refresh or a modal close does not re-open it, and
  // a new id re-applies. A list that loads without the id reports it
  // instead of silently showing the unfiltered list.
  const focusAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusScheduleId || loading) return;
    if (focusAppliedRef.current === focusScheduleId) return;
    focusAppliedRef.current = focusScheduleId;
    const found = schedules.find((s) => s.id === focusScheduleId);
    if (found) {
      setFocusMissing(false);
      setDetailsTarget(found);
      void readDetails(found);
    } else {
      setFocusMissing(true);
    }
  }, [focusScheduleId, loading, schedules]);

  // Issue #4329 S2 (#4331): ONE list. Every durable schedule is a row here —
  // the screening callbacks included — and the options manager renders its
  // form, latest runs and audit trail without an embedded list of its own.
  const allSchedules = schedules;

  // Filter by the active kind (issue #4329 S2): "all" is the unfiltered list.
  const filtered = allSchedules.filter(
    (s) => activeTab === "all" || classifyScheduleKind(s) === activeTab,
  );

  // Count by kind (issue #4329 S2): one classifier, every configured filter.
  const kindCounts = countSchedulesByKind(allSchedules);
  const counts: Record<string, number> = {
    all: allSchedules.length,
    ...kindCounts,
  };

  // The generic table only appears when it has something to say: on
  // the groups it owns, or when rows exist. On "all" with no generic
  // rows the screening section's own empty state is the page's single
  // empty state (issue #2329: no duplicate "nothing here" blocks).
  const showGenericSection = filtered.length > 0 || activeTab === "system" || activeTab === "queued";

  // The filter buttons are configuration (#4329 S2): the set and the default
  // live in src/config/scheduleListModes.ts, with the owner's order as the
  // built-in default.
  const scheduleFilters = resolveScheduleListFilters();
  const tabs: { id: ScheduleGroup; label: string }[] = scheduleFilters.map((id) => ({
    id,
    label: `${SCHEDULE_LIST_FILTER_LABELS[id]} (${counts[id] ?? 0})`,
  }));

  const genericColumns: TableColumn<ScheduleItem>[] = [
    {
      key: "job",
      header: "Schedule",
      render: (s) => (
        <div className="schedule-row-job">
          <span className="schedule-row-name">{scheduleDisplayName(s)}</span>
          <span className="schedule-row-badges">
            {/* #2329: the same badge vocabulary as the screening rows — a
                generic job is a System job, never a screening kind. */}
            <Badge tone="neutral" size="xs">
              System
            </Badge>
            {/* Issue #3121 #4237 — a ticker-push row carries its feed
                health: a stopped push reads as a missed push, an
                idle feed (no listeners) as Idle, never as missed. */}
            {s.kind === "ticker-push" ? (
              <Badge
                tone={s.health === "stale" ? "warning" : s.health === "idle" ? "neutral" : "success"}
                size="xs"
                dot
              >
                {s.health === "stale" ? "Missed push" : s.health === "idle" ? "Idle" : "Healthy"}
              </Badge>
            ) : null}
            {/* Issue #3122 — agent-created schedules carry an Agent
                badge (provenance origin agent on the payload); user-
                and system-created rows show no badge. */}
            {s.payload?.provenance?.origin === "agent" ? (
              <Badge
                tone="info"
                size="xs"
                title={
                  s.payload.provenance.agentId
                    ? `Created by agent ${s.payload.provenance.agentId}`
                    : "Created by an agent"
                }
              >
                Agent
              </Badge>
            ) : null}
            <Badge tone={s.paused ? "warning" : "success"} size="xs" dot>
              {s.paused ? "Paused" : "Active"}
            </Badge>
            <Badge tone="neutral" size="xs" uppercase>
              {s.type}
            </Badge>
          </span>
        </div>
      ),
    },
    {
      key: "id",
      header: "Schedule ID",
      render: (s) => (
        <code className="schedule-row-id" title={s.id}>
          {s.id}
        </code>
      ),
    },
    {
      key: "cadence",
      header: "Cadence",
      render: (s) => (
        <div className="schedule-row-stack">
          <span className="schedule-row-value">{genericCadence(s)}</span>
          <span className="schedule-row-muted">
            {s.kind === "ticker-push"
              ? `Last push: ${formatLastPush(s.lastPushAt)}`
              : `Next run: ${s.paused ? "paused" : formatNextRun(s)}`}
          </span>
        </div>
      ),
    },
    {
      key: "scope",
      header: "Scope",
      render: (s) => {
        const payload = s.payload || {};
        const universe = payload.universe;
        const thesis = payload.thesis;
        const summary = !universe && !thesis ? payloadSummary(payload) : "";
        const lines: string[] = [];
        if (universe) lines.push(`Universe: ${universe}`);
        if (thesis) lines.push(`Thesis: ${thesis}`);
        if (summary) lines.push(summary);
        if (payload.maxItems != null) lines.push(`Max items: ${payload.maxItems}`);
        const accountScoped = ACCOUNT_SCOPED.some((name) => s.callback.toLowerCase().includes(name));
        const owner = payload.userLogin;
        const environment = payload.environment || payload.env;
        // Issue #3655: the account label names the schedule's broker
        // (recorded at creation), never a hard-coded E*TRADE. Legacy
        // payloads without a broker read as E*TRADE — the only broker
        // wired when they were armed — rather than borrowing the
        // currently selected broker's name.
        const brokerLabel =
          typeof payload.brokerId === "string" && payload.brokerId
            ? payload.brokerId === "etrade"
              ? "E*TRADE"
              : payload.brokerId === "alpaca"
                ? "Alpaca"
                : payload.brokerId
            : "E*TRADE";
        const modeLabel =
          typeof payload.mode === "string" && payload.mode
            ? payload.mode === "live"
              ? "live"
              : "paper"
            : environment === "TEST"
              ? "paper"
              : environment === "PROD"
                ? "live"
                : "";
        const account = accountScoped
          ? owner
            ? `${brokerLabel} account: ${owner}${environment ? ` · ${environment}` : ""}${modeLabel ? ` · ${modeLabel}` : ""}`
            : `${brokerLabel} account: missing — this schedule cannot authenticate`
          : "";
        return (
          <div className="schedule-row-stack">
            <span className="schedule-row-value">{lines.length > 0 ? lines[0] : "—"}</span>
            {(lines.length > 1 || account) && (
              <span className="schedule-row-muted">
                {[...lines.slice(1), account].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      headerClassName: "schedule-row-actions-head",
      render: (s) => {
        // Issue #3121 #4237 — a ticker-push row is a live feed, not a
        // manageable schedule: pause/resume/trigger/delete/update are
        // refused server-side, so the row offers no action buttons.
        // A Badge (ui/ primitive) keeps the row at zero new bespoke
        // classes — the interior ratchet counts className tokens.
        if (s.kind === "ticker-push") {
          return (
            <Badge
              tone="neutral"
              size="xs"
              title="Managed by listeners — the feed runs while clients are connected"
            >
              Live feed
            </Badge>
          );
        }
        return (
          <div className="schedule-row-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setDetailsTarget(s);
                void readDetails(s);
              }}
              title="Open every stored detail for this schedule"
            >
              Details
            </Button>
            <Button
              type="button"
              variant="accent"
              tone="subtle"
              size="sm"
              disabled={!!s.paused}
              onClick={() => handleTriggerNow(s)}
              title={s.paused ? "Resume before triggering" : "Run this job now"}
            >
              Trigger Now
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handlePauseResume(s)}
              title={s.paused ? "Resume schedule" : "Pause schedule"}
            >
              {s.paused ? "Resume" : "Pause"}
            </Button>
            {/* Issue #2957: every generic row gets Edit frequency —
                picking a cadence converts a one-shot to recurring (the
                backend treats a supplied cron/interval as a timing-kind
                switch); the modal warns one-shot rows before they pick. */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setCadenceError(null);
                setCadenceTarget(s);
              }}
              title="Edit this schedule's cadence"
            >
              Edit frequency
            </Button>
            <Button
              type="button"
              variant="danger"
              tone="subtle"
              size="sm"
              onClick={() => setDeleteTarget(s)}
              title="Delete this schedule"
            >
              Delete
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="schedules-panel">
      <ScheduleDetailModal
        item={detailsTarget}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        profiles={[]}
        activeEnv={activeEnv || ""}
        userLogin={userLogin || ""}
        onRetry={() => {
          if (detailsTarget) void readDetails(detailsTarget);
        }}
        onClose={() => {
          setDetailsTarget(null);
          setDetail(null);
          setDetailError(null);
        }}
      />

      <CadenceModal
        item={cadenceTarget}
        busy={cadenceBusy}
        error={cadenceError}
        onApply={applyFrequency}
        onClose={() => {
          setCadenceTarget(null);
          setCadenceError(null);
        }}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete this schedule?"
        confirmLabel="Delete schedule"
        cancelLabel="Keep schedule"
        busy={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const target = deleteTarget;
          if (!target) return;
          setDeleting(true);
          try {
            const ok = await runAction(() => deleteSchedule(target.id, envHeaders));
            if (ok) setRefreshSignal((n) => n + 1);
          } finally {
            setDeleting(false);
            setDeleteTarget(null);
          }
        }}
      >
        <p>
          <code>{deleteTarget?.callback}</code> (<code>{deleteTarget?.id}</code>) is removed from
          the schedule store and will not fire again. This cannot be undone.
        </p>
      </ConfirmModal>

      {userLogin && (
        <div className="schedule-context">
          Schedules for <strong>{userLogin}</strong>{activeEnv ? ` · E*TRADE ${activeEnv}` : ""}
        </div>
      )}

      <div className="schedules-toolbar">
        <PillGroup
          options={tabs.map((t) => ({ id: t.id, label: t.label }))}
          value={activeTab}
          onChange={(value) => setActiveTab(value as ScheduleGroup)}
          size="sm"
          ariaLabel="Filter schedules by group"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={refreshAll}
          loading={refreshing}
          title="Refresh schedules, latest runs, and the audit trail"
        >
          ↻ Refresh
        </Button>
      </div>

      {actionError && (
        <Notice tone="danger" title="Schedule action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

      {focusMissing && focusScheduleId && (
        <Notice tone="warning" title="Schedule not found" onDismiss={() => setFocusMissing(false)}>
          No schedule with id <code>{focusScheduleId}</code> is in the list.
        </Notice>
      )}

      {userLogin && (activeTab === "all" || activeTab === "stocks" || activeTab === "options") && (
        <ScheduledOptionsManager
          activeEnv={activeEnv}
          userLogin={userLogin}
          onPreviewTrade={onPreviewTrade}
          groupFilter={activeTab === "all" ? "all" : activeTab}
          refreshSignal={refreshSignal}
          // Issue #4331: the one list is the table below; this manager keeps
          // its form, latest runs and audit trail.
          showSchedulesSection={false}
        />
      )}

      {loading && schedules.length === 0 ? (
        <p className="sched-table-status">Loading schedules…</p>
      ) : error ? (
        <Notice tone="danger" title="Schedules could not be loaded">
          {error}{" "}
          <Button type="button" variant="secondary" size="sm" onClick={fetchSchedules}>
            Retry
          </Button>
        </Notice>
      ) : showGenericSection ? (
        <section className="sched-section-card">
          <header className="sched-section-header">
            <h4>
              <span aria-hidden="true">🗂️</span> Schedules
              <span className="sched-count-pill">{filtered.length} Shown</span>
            </h4>
            {loading && <span className="schedule-row-muted">Refreshing…</span>}
          </header>
          <Table
            columns={genericColumns}
            rows={filtered}
            rowKey={(s) => s.id}
            rowClassName="schedule-item-card"
            rowTitle={(s) => `${s.id} · ${s.callback}`}
            caption="Every durable schedule, one row each"
            containerClassName="sched-table-scroll"
            empty={<p className="sched-table-status">No schedules in this group.</p>}
          />
        </section>
      ) : null}
    </div>
  );
}
