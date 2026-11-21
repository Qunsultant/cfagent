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
 * two create actions on the page (the screening section's hero
 * buttons: New Schedule for one schedule, Quick create for one
 * schedule per job with defaults — issue #5895). The page's one
 * Refresh control refetches both surfaces.
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
  Card,
  CardHeader,
  Flex,
  Notice,
  PageSection,
  PillGroup,
  Stack,
  Table,
  useToast,
  type TableColumn,
} from "./components/ui";
import {
  bulkScheduleAction,
  deleteSchedule,
  getSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  updateSchedule,
  type BulkScheduleResult,
} from "./jobsApi";
import { CadenceModal } from "./scheduledOptionsManager/CadenceModal";
import { ConfirmModal } from "./scheduledOptionsManager/ConfirmModal";
import { ScheduleDetailModal } from "./scheduledOptionsManager/ScheduleDetailModal";
import { formatNextRun } from "./scheduledOptionsManager/format";
import "./reports.deprecated.css";

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
  /** Issue #3121 #4239 — the token-renewal row's last ledger run. */
  lastRunAt?: string;
  lastRunOutcome?: string;
  /** Issue #3121 #4240 — the retention row's last pass summary (dispatch detail, verbatim). */
  lastRunDetail?: string;
  /**
   * Issue #5889 — the row's source (kind + job identity + arming
   * origin, derived once on the server) and the record's creation
   * provenance where present. Absent on legacy rows, which read as
   * Unknown / not recorded, never a fabricated source.
   */
  source?: ScheduleSource;
  provenance?: ScheduleProvenance;
}

// Issue #4329 S2 (#4331): the owner's ten filters, configured in
// src/config/scheduleListModes.ts — one vocabulary, not a second one here.
type ScheduleGroup = ScheduleListFilter;

/** Frequency presets for the one cadence dialog — defined once in the
 *  screening section's format module since S7; re-exported here for
 *  existing importers. */
export { FREQUENCY_PRESETS } from "./scheduledOptionsManager/format";
import { ScheduledOptionsManager } from "./ScheduledOptionsManager";
import { scheduleTitle } from "./scheduledOptionsManager/scheduleDetail";
import type { ScheduledTaskItem } from "./scheduledOptionsManager/types";
import {
  SCHEDULE_LIST_FILTER_LABELS,
  SCHEDULE_LIST_STATUS_LABELS,
  resolveScheduleListFilters,
  resolveScheduleListStatusFilters,
  type ScheduleListFilter,
  type ScheduleListKind,
  type ScheduleListStatusFilter,
} from "../config/scheduleListModes";
import {
  SCHEDULE_SOURCE_FILTER_LABELS,
  resolveScheduleSourceFilters,
  scheduleSourceAgents,
  scheduleSourceDisplay,
  scheduleSourceKindOf,
  scheduleSourceWorkflows,
  type ScheduleSource,
  type ScheduleSourceFilter,
} from "../config/scheduleSourceModes";
import type { ScheduleProvenance } from "../schedule";
import { SCHEDULE_ROW_COLUMN_LABELS } from "../config/scheduleRowModes";
import {
  nextTableSort,
  sortTableRows,
  tableSortAria,
  type TableSort,
} from "./tableSort";
import { classifyScheduleKind, countSchedulesByKind } from "../services/scheduleKinds";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import { resolveScheduleRowColumns } from "../config/scheduleRowModes";

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
  // Issue #4354 — the scope cell shows its value IN FULL. It used to cut at
  // 90 characters with an ellipsis, which hid the very ids an operator needs
  // (taskId, scheduleHash). The cell wraps now; the table scrolls instead of
  // clipping.
  return keys
    .map((k) => {
      const v = payload[k];
      const rendered = typeof v === "object" ? "…" : String(v);
      return `${k}: ${rendered}`;
    })
    .join(" · ");
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
  // Issue #4329 S2 (#4331): the one list keeps the friendly title the hosted
  // sections used, so a screening row reads "Strategy Discovery · No-view"
  // rather than the raw callback. Unknown callbacks fall through to the
  // callback itself, exactly as before.
  return scheduleTitle(s as unknown as ScheduledTaskItem);
}

/**
 * Issue #5891 — the six derived rows Delete cannot remove (they
 * re-derive from code), keyed by the same literal ids the cadence
 * column already reads below. A row Delete cannot remove reports
 * its refusal here so the button can be disabled with the reason —
 * the owner's rule is no new button: Delete either deletes or is
 * disabled with the reason. The sentences are the server's own
 * refusal sentences, so the button and the route never disagree.
 */
const DERIVED_SCHEDULE_IDS = new Set([
  "token-renewal",
  "retention",
  "nightly-research",
  "sweep-stale-ledger-tasks",
  "sweep-stale-async-jobs",
  "schedule-watchdog",
]);

/** The reason Delete cannot remove this row, or null when it can. */
export function deleteRefusalReason(s: ScheduleItem): string | null {
  if (DERIVED_SCHEDULE_IDS.has(s.id)) {
    return `Schedule '${s.id}' is a derived record with no alarm to delete.`;
  }
  if (s.kind === "goal") {
    return "Goal schedules delete through the goals surface (/api/schedule/goals/:id), not the SDK schedule routes.";
  }
  if (
    s.kind !== undefined &&
    s.kind !== "screen" &&
    s.kind !== "workflow-stage" &&
    s.kind !== "internal" &&
    s.kind !== "ticker-push"
  ) {
    return `Schedule kind '${s.kind}' cannot be deleted.`;
  }
  return null;
}

/** Last-event rendering for a derived row (never a fabricated time). */
function formatLastEvent(lastAt?: string): string {
  if (!lastAt) return "never";
  const ms = Date.parse(lastAt);
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
  // Issue #4389 — the list's two extra dimensions: a status filter beside the
  // kinds, and a sort applied to the rows (never to the source array).
  const [statusFilter, setStatusFilter] = useState<ScheduleListStatusFilter>("all");
  // Issue #5889 — the source dimension beside the kinds and the status: one
  // source kind at a time (or the Cron timing slice), plus the per-agent and
  // per-workflow views, which name only the agents and workflows the loaded
  // rows actually carry. All three compose with kind and status.
  const [sourceFilter, setSourceFilter] = useState<ScheduleSourceFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [workflowFilter, setWorkflowFilter] = useState<string>("all");
  const [sort, setSort] = useState<TableSort | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleItem | null>(null);
  // Issue #4331: the row's Edit control asks the options manager to open its
  // form for that schedule; the nonce lets the same row re-open.
  const [editRequest, setEditRequest] = useState<{ scheduleId: string; nonce: number } | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  // Issue #5878 — bulk pause / resume / run-now: the confirm target
  // (verb + scope), the last summary, and the in-flight flag.
  const [bulkTarget, setBulkTarget] = useState<{
    verb: "pause" | "resume" | "trigger";
    scope: ScheduleListFilter;
  } | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkScheduleResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
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

  /** Issue #5878 — the bulk toolbar's labels, per verb and scope. */
  const bulkButtonLabel = (verb: "pause" | "resume" | "trigger", scope: ScheduleListFilter) => {
    if (verb === "pause") return scope === "all" ? "Pause all" : `Pause ${SCHEDULE_LIST_FILTER_LABELS[scope]}`;
    if (verb === "resume") return scope === "all" ? "Resume all" : `Resume ${SCHEDULE_LIST_FILTER_LABELS[scope]}`;
    return scope === "all" ? "Run all now" : `Run ${SCHEDULE_LIST_FILTER_LABELS[scope]} now`;
  };

  /** "all schedules" or "Options schedules" — the confirm's scope noun. */
  const bulkScopeNoun = (scope: ScheduleListFilter) =>
    scope === "all" ? "all schedules" : `${SCHEDULE_LIST_FILTER_LABELS[scope]} schedules`;

  /** How many rows the scope names ("2 schedules in scope"). */
  const bulkScopeCount = (scope: ScheduleListFilter) => {
    const n = scope === "all" ? allSchedules.length : (counts[scope] ?? 0);
    return `${n} schedule${n === 1 ? "" : "s"} in scope`;
  };

  /** "1 paused · 1 already paused · 6 refused" — the summary's count sentence. */
  const bulkSummaryLine = (summary: BulkScheduleResult) => {
    const appliedNoun =
      summary.verb === "pause" ? "paused" : summary.verb === "resume" ? "resumed" : "triggered";
    const parts = [`${summary.applied} ${appliedNoun}`];
    if (summary.already > 0) {
      parts.push(
        `${summary.already} ${summary.verb === "pause" ? "already paused" : "already active"}`,
      );
    }
    if (summary.refused > 0) parts.push(`${summary.refused} refused`);
    return parts.join(" · ");
  };

  const bulkSummaryTitle = (summary: BulkScheduleResult) => {
    const noun =
      summary.verb === "pause" ? "Paused" : summary.verb === "resume" ? "Resumed" : "Triggered";
    return `${noun} ${summary.applied} schedule${summary.applied === 1 ? "" : "s"}`;
  };

  const runBulkAction = async () => {
    const target = bulkTarget;
    if (!target) return;
    setBulkBusy(true);
    try {
      const summary = await bulkScheduleAction(target.verb, target.scope, envHeaders);
      setBulkResult(summary);
      await fetchSchedules();
      setRefreshSignal((n) => n + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
      setBulkTarget(null);
    }
  };

  const applyFrequency = async (
    s: ScheduleItem,
    body: { scheduleType: "interval" | "cron"; intervalSeconds?: number; cron?: string; subDailyOptIn?: boolean }
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
  // the screening callbacks included. The options manager keeps its form,
  // latest runs and audit trail, and its Edit flow is reached through the
  // row's Edit control (an edit request), so dropping its embedded list loses
  // nothing.
  const allSchedules = schedules;

  // Filter by the active kind (issue #4329 S2): "all" is the unfiltered list.
  const filtered = allSchedules.filter(
    (s) => activeTab === "all" || classifyScheduleKind(s) === activeTab,
  );
  // Issue #4389 — the status filter composes with the kind: Options + Paused.
  const statusFiltered = filtered.filter(
    (s) =>
      statusFilter === "all" ||
      (statusFilter === "paused" ? Boolean(s.paused) : !s.paused),
  );
  // Issue #5889 — the source filter composes with kind and status. "cron"
  // is a timing slice, not a source: every cron-timed row, whatever its
  // source (it overlaps Derived by design — each row still carries
  // exactly one source). The per-agent and per-workflow views name only
  // the values the loaded rows carry; a selected value that stops
  // existing (a refresh dropped its last row) falls back to all.
  const sourceFiltered = statusFiltered.filter((s) => {
    if (sourceFilter === "all") return true;
    if (sourceFilter === "cron") return s.type === "cron";
    return scheduleSourceKindOf(s) === sourceFilter;
  });
  const agentValues = scheduleSourceAgents(allSchedules);
  const effectiveAgentFilter = agentValues.includes(agentFilter) ? agentFilter : "all";
  const agentFiltered = sourceFiltered.filter(
    (s) => effectiveAgentFilter === "all" || s.source?.agent === effectiveAgentFilter,
  );
  const workflowValues = scheduleSourceWorkflows(allSchedules);
  const effectiveWorkflowFilter = workflowValues.includes(workflowFilter)
    ? workflowFilter
    : "all";
  const workflowFiltered = agentFiltered.filter(
    (s) => effectiveWorkflowFilter === "all" || s.source?.workflow === effectiveWorkflowFilter,
  );
  // The one ordering rule (`src/client/tableSort.ts`): numbers numeric, strings
  // locale-aware, blanks last, ties stable.
  const sortValue = (s: ScheduleItem, key: string): string | number | null => {
    switch (key) {
      case "schedule":
        return scheduleDisplayName(s);
      case "id":
        return s.id;
      case "cadence":
        return genericCadence(s);
      case "source": {
        const display = scheduleSourceDisplay(s);
        return `${display.label} ${display.job}`;
      }
      case "status":
        return s.paused ? 1 : 0;
      case "scope": {
        const payload = s.payload || {};
        return payload.universe ?? payload.thesis ?? payloadSummary(payload);
      }
      default:
        return null;
    }
  };
  const rows = sortTableRows(workflowFiltered, sort, sortValue);
  const statusFilters = resolveScheduleListStatusFilters();

  // Count by source (issue #5889): one count per configured source
  // filter, from the whole list (never the kind-filtered list — the
  // Source buttons are their own dimension, like the kind buttons).
  // The Cron count is the timing slice's count: every cron-timed row.
  const sourceCounts: Record<string, number> = { all: allSchedules.length };
  for (const filter of resolveScheduleSourceFilters()) {
    if (filter === "all") continue;
    sourceCounts[filter] =
      filter === "cron"
        ? allSchedules.filter((s) => s.type === "cron").length
        : allSchedules.filter((s) => scheduleSourceKindOf(s) === filter).length;
  }
  const agentCounts: Record<string, number> = {};
  for (const agent of agentValues) {
    agentCounts[agent] = allSchedules.filter((s) => s.source?.agent === agent).length;
  }
  const workflowCounts: Record<string, number> = {};
  for (const workflow of workflowValues) {
    workflowCounts[workflow] = allSchedules.filter((s) => s.source?.workflow === workflow).length;
  }

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

  // Issue #4389 — a sortable header is a button that announces its own state
  // (an arrow in the label, `aria-sort` on the cell). Actions is the one column
  // that does not sort; a click orders the rows through `sortTableRows`.
  const sortableHeader = (key: string, label: string) => (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => setSort((current) => nextTableSort(current, key))}
      title={`Sort by ${label}`}
    >
      {label}
      {sort?.key === key ? (sort.direction === "asc" ? " ▲" : " ▼") : ""}
    </Button>
  );

  const genericColumns: TableColumn<ScheduleItem>[] = [
    {
      key: "schedule",
      header: sortableHeader("schedule", SCHEDULE_ROW_COLUMN_LABELS.schedule),
      ariaSort: tableSortAria(sort, "schedule"),
      render: (s) => (
        <Stack gap="1">
          <strong>{scheduleDisplayName(s)}</strong>
          <Flex as="span" gap="1" align="center" wrap>
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
            {/* Issue #3121 #4236 — a system-armed strategy-scan
                baseline names its origin (provenance reason on the
                payload); user- and agent-created rows show no badge. */}
            {s.payload?.provenance?.reason === "strategy-scan-baseline" ? (
              <Badge
                tone="neutral"
                size="xs"
                title="System-armed strategy-scan baseline"
              >
                System baseline
              </Badge>
            ) : null}
            <Badge tone="neutral" size="xs" uppercase>
              {s.type}
            </Badge>
          </Flex>
        </Stack>
      ),
    },
    {
      key: "id",
      header: sortableHeader("id", SCHEDULE_ROW_COLUMN_LABELS.id),
      ariaSort: tableSortAria(sort, "id"),
      render: (s) => (
        <code className="ui-mono" title={s.id}>
          {s.id}
        </code>
      ),
    },
    {
      key: "cadence",
      header: sortableHeader("cadence", SCHEDULE_ROW_COLUMN_LABELS.cadence),
      ariaSort: tableSortAria(sort, "cadence"),
      // Issue #4354 — the cadence sentence and its next-run note get a column
      // wide enough to hold them (the owner: widen the cadence column).
      cellClassName: "schedule-row-cadence",
      render: (s) => (
        <Stack gap="0-5">
          <strong className="ui-meta">{genericCadence(s)}</strong>
          <span className="ui-meta">
            {s.kind === "ticker-push"
              ? `Last push: ${formatLastEvent(s.lastPushAt)}`
              : s.id === "token-renewal"
                ? `Last renewal: ${formatLastEvent(s.lastRunAt)}${s.lastRunOutcome ? ` (${s.lastRunOutcome})` : ""}`
                : s.id === "retention"
                  ? `Last pass: ${formatLastEvent(s.lastRunAt)}${s.lastRunOutcome ? ` (${s.lastRunOutcome})` : ""}${s.lastRunDetail ? ` — ${s.lastRunDetail}` : ""}`
                  : s.id === "nightly-research"
                    ? `Last research: ${formatLastEvent(s.lastRunAt)}${s.lastRunOutcome ? ` (${s.lastRunOutcome})` : ""}`
                    : s.id === "sweep-stale-ledger-tasks"
                      ? `Last task sweep: ${formatLastEvent(s.lastRunAt)}${s.lastRunOutcome ? ` (${s.lastRunOutcome})` : ""}${s.lastRunDetail ? ` — ${s.lastRunDetail}` : ""}`
                      : s.id === "sweep-stale-async-jobs"
                        ? `Last job sweep: ${formatLastEvent(s.lastRunAt)}${s.lastRunOutcome ? ` (${s.lastRunOutcome})` : ""}${s.lastRunDetail ? ` — ${s.lastRunDetail}` : ""}`
                        : s.id === "schedule-watchdog"
                          ? `Last watchdog: ${formatLastEvent(s.lastRunAt)}${s.lastRunOutcome ? ` (${s.lastRunOutcome})` : ""}${s.lastRunDetail ? ` — ${s.lastRunDetail}` : ""}`
                          : `Next run: ${s.paused ? "paused" : formatNextRun(s)}`}
          </span>
        </Stack>
      ),
    },
    {
      // Issue #5889 — the Source column: the row's source label, then
      // its job identity and arming origin. A row with no source reads
      // Unknown / not recorded, never a fabricated source.
      key: "source",
      header: sortableHeader("source", SCHEDULE_ROW_COLUMN_LABELS.source),
      ariaSort: tableSortAria(sort, "source"),
      render: (s) => {
        const display = scheduleSourceDisplay(s);
        return (
          <Stack gap="0-5">
            <strong className="ui-meta">{display.label}</strong>
            <span className="ui-meta">
              {display.job} · {display.origin}
            </span>
          </Stack>
        );
      },
    },
    {
      key: "scope",
      header: sortableHeader("scope", SCHEDULE_ROW_COLUMN_LABELS.scope),
      ariaSort: tableSortAria(sort, "scope"),
      // Issue #4354 — the scope value is complete and wraps inside a column
      // wide enough for two lines.
      cellClassName: "schedule-row-scope",
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
          <Stack gap="0-5">
            <strong className="ui-meta">{lines.length > 0 ? lines[0] : "—"}</strong>
            {(lines.length > 1 || account) && (
              <span className="ui-meta">
                {[...lines.slice(1), account].filter(Boolean).join(" · ")}
              </span>
            )}
          </Stack>
        );
      },
    },
    {
      key: "actions",
      header: SCHEDULE_ROW_COLUMN_LABELS.actions,
      align: "right",
      headerClassName: "schedule-row-actions-head",
      render: (s) => {
        // Issue #5891 — Delete either deletes or is disabled with
        // the reason (no new button); the title carries the reason,
        // the Trigger Now disabled+title precedent.
        const deleteRefusal = deleteRefusalReason(s);
        return (
          // Issue #4389 — ONE button set, one vocabulary, for every kind: Edit ·
          // Details · Trigger Now · Pause/Resume · Delete. Edit opens the row's
          // own editor (a screening row's schedule form, whose cadence lives
          // there; any other row's cadence dialog, interval-only for the live
          // feed). No kind gets a shorter list and no kind gets a second word.
          <Flex gap="1" align="center" justify="end">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              if (SCREENING_CALLBACKS.has(s.callback)) {
                setEditRequest({ scheduleId: s.id, nonce: Date.now() });
                return;
              }
              setCadenceError(null);
              setCadenceTarget(s);
            }}
            title={
              SCREENING_CALLBACKS.has(s.callback)
                ? "Edit this schedule"
                : "Edit this schedule's cadence"
            }
          >
            Edit
          </Button>
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
            variant="secondary"
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
          <Button
            type="button"
            variant="danger"
            tone="subtle"
            size="sm"
            disabled={deleteRefusal !== null}
            onClick={() => setDeleteTarget(s)}
            title={deleteRefusal ?? "Delete this schedule"}
          >
            Delete
          </Button>
        </Flex>
        );
      },
    },
    {
      // Issue #4389 — status is its own column, not a badge in the name cell.
      key: "status",
      header: sortableHeader("status", SCHEDULE_ROW_COLUMN_LABELS.status),
      ariaSort: tableSortAria(sort, "status"),
      render: (s) => (
        <Badge tone={s.paused ? "warning" : "success"} size="xs" dot>
          {s.paused ? "Paused" : "Active"}
        </Badge>
      ),
    },
  ];

  // Issue #4333 — the columns this surface shows come from the shared row
  // vocabulary (`src/config/scheduleRowModes.ts`), the same one the goals and
  // queue tables resolve: the base identity columns and this list's own
  // `source` lead, the action column closes. A deployment can hide a column
  // from config; the order is the vocabulary's.
  // The vocabulary also fixes the ORDER: a column the deployment hides is
  // dropped, the rest keep the shared order (source, then status, then scope,
  // actions last), never the order this file happens to declare its factories in.
  const listColumnOrder = resolveScheduleRowColumns("list");
  const columnByKey = new Map(genericColumns.map((column) => [column.key, column]));
  const visibleGenericColumns: TableColumn<ScheduleItem>[] = listColumnOrder
    .map((key) => columnByKey.get(key))
    .filter((column): column is TableColumn<ScheduleItem> => Boolean(column));

  return (
    <PageSection>
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
        {/* Issue #5891 — the modal promises only what the path can
            do: the removal sentence renders only for a row Delete
            can actually remove. A refused row names its refusal
            (unreachable in practice — its Delete is disabled — but
            the modal must never promise removal for it); ticker-push
            keeps its #4389 feed note and promises no removal. */}
        {deleteTarget !== null && deleteRefusalReason(deleteTarget) !== null ? (
          <p>{deleteRefusalReason(deleteTarget)}</p>
        ) : deleteTarget?.kind === "ticker-push" ? (
          // Issue #4389 — the live feed has no stored definition to remove: its
          // record is the feed's own state, so deleting it stops the push for
          // every connected client (Resume brings it back).
          <p>
            The live feed has no stored definition to remove: deleting it stops the push for
            every connected client, and <strong>Resume</strong> brings it back.
          </p>
        ) : (
          <p>
            <code>{deleteTarget?.callback}</code> (<code>{deleteTarget?.id}</code>) is removed from
            the schedule store and will not fire again. This cannot be undone.
          </p>
        )}
      </ConfirmModal>

      {/* Issue #5878 — bulk pause / resume / run-now confirms the scope
          and its count before anything runs. Pause and resume are
          reversible, run-now fires callbacks, so the tone is primary,
          not danger. */}
      <ConfirmModal
        open={bulkTarget !== null}
        title={
          bulkTarget
            ? bulkTarget.verb === "trigger"
              ? `Run ${bulkScopeNoun(bulkTarget.scope)} now?`
              : `${bulkTarget.verb === "pause" ? "Pause" : "Resume"} ${bulkScopeNoun(bulkTarget.scope)}?`
            : ""
        }
        confirmLabel={bulkTarget ? bulkButtonLabel(bulkTarget.verb, bulkTarget.scope) : ""}
        cancelLabel="Cancel"
        tone="primary"
        busy={bulkBusy}
        onClose={() => setBulkTarget(null)}
        onConfirm={runBulkAction}
      >
        {bulkTarget && (
          <p>
            {bulkTarget.verb === "pause"
              ? `Pause ${bulkScopeNoun(bulkTarget.scope)} (${bulkScopeCount(bulkTarget.scope)}). Paused schedules stay listed and can be resumed.`
              : bulkTarget.verb === "resume"
                ? `Resume ${bulkScopeNoun(bulkTarget.scope)} (${bulkScopeCount(bulkTarget.scope)}). Already-active schedules are left alone.`
                : `Run ${bulkScopeNoun(bulkTarget.scope)} now (${bulkScopeCount(bulkTarget.scope)}). Each schedule runs its callback once; paused schedules refuse until resumed.`}
          </p>
        )}
      </ConfirmModal>

      {userLogin && (
        <div className="ui-meta">
          Schedules for <strong>{userLogin}</strong>{activeEnv ? ` · E*TRADE ${activeEnv}` : ""}
        </div>
      )}

      <Flex justify="between" align="center" gap="3" wrap>
        <PillGroup
          options={tabs.map((t) => ({ id: t.id, label: t.label }))}
          value={activeTab}
          onChange={(value) => setActiveTab(value as ScheduleGroup)}
          size="sm"
          ariaLabel="Filter schedules by group"
        />
        {/* Issue #4389 — the status dimension beside the kinds; the two compose
            (Options + Paused). The vocabulary is configuration, like the kinds. */}
        {statusFilters.length > 1 && (
          <PillGroup
            options={statusFilters.map((id) => ({
              id,
              label: SCHEDULE_LIST_STATUS_LABELS[id],
            }))}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as ScheduleListStatusFilter)}
            size="sm"
            ariaLabel="Filter schedules by status"
          />
        )}
        {/* Issue #5889 — the source dimension beside the kinds and the
            status; the three compose (Options + Derived + Active). The
            vocabulary is configuration, like the kinds. Cron is a
            timing slice, not a source: every cron-timed row, whatever
            its source — it overlaps Derived by design. */}
        <PillGroup
          options={resolveScheduleSourceFilters().map((id) => ({
            id,
            label: `${SCHEDULE_SOURCE_FILTER_LABELS[id]} (${sourceCounts[id] ?? 0})`,
            ...(id === "cron"
              ? {
                  tooltip:
                    "Rows armed on a cron expression — a timing slice, overlapping Derived by design; each row still carries one source",
                }
              : {}),
          }))}
          value={sourceFilter}
          onChange={(value) => setSourceFilter(value as ScheduleSourceFilter)}
          size="sm"
          ariaLabel="Filter schedules by source"
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
      </Flex>

      {/* Issue #5889 — the per-agent and per-workflow views: only the
          agents and workflows the loaded rows name get a button, so a
          view with no rows is never invented. Both compose with kind,
          status and source. */}
      {(agentValues.length > 0 || workflowValues.length > 0) && (
        <Flex justify="between" align="center" gap="3" wrap>
          {agentValues.length > 0 && (
            <PillGroup
              options={[
                { id: "all", label: "All agents" },
                ...agentValues.map((agent) => ({
                  id: agent,
                  label: `${agent} (${agentCounts[agent] ?? 0})`,
                })),
              ]}
              value={effectiveAgentFilter}
              onChange={(value) => setAgentFilter(value)}
              size="sm"
              ariaLabel="Filter schedules by agent"
            />
          )}
          {workflowValues.length > 0 && (
            <PillGroup
              options={[
                { id: "all", label: "All workflows" },
                ...workflowValues.map((workflow) => ({
                  id: workflow,
                  label: `${workflow} (${workflowCounts[workflow] ?? 0})`,
                })),
              ]}
              value={effectiveWorkflowFilter}
              onChange={(value) => setWorkflowFilter(value)}
              size="sm"
              ariaLabel="Filter schedules by workflow"
            />
          )}
        </Flex>
      )}

      {/* Issue #5878 — bulk pause / resume / run-now: the same verbs as
          the per-row buttons, over a scope — all schedules, or the kind
          the filter currently shows. A confirm dialog names the scope
          and its count before anything runs. */}
      <Flex gap="1" align="center" wrap>
        {(["pause", "resume", "trigger"] as const).map((verb) => (
          <Button
            key={verb}
            type="button"
            variant="secondary"
            size="sm"
            disabled={bulkBusy}
            onClick={() => setBulkTarget({ verb, scope: "all" })}
            title={`${bulkButtonLabel(verb, "all")} — every schedule in the list`}
          >
            {bulkButtonLabel(verb, "all")}
          </Button>
        ))}
        {activeTab !== "all" &&
          (["pause", "resume", "trigger"] as const).map((verb) => (
            <Button
              key={verb}
              type="button"
              variant="secondary"
              size="sm"
              disabled={bulkBusy}
              onClick={() => setBulkTarget({ verb, scope: activeTab })}
              title={`${bulkButtonLabel(verb, activeTab)} — every ${SCHEDULE_LIST_FILTER_LABELS[activeTab]} schedule in the list`}
            >
              {bulkButtonLabel(verb, activeTab)}
            </Button>
          ))}
      </Flex>

      {bulkResult && (
        <Notice
          tone={bulkResult.refused > 0 ? "warning" : "success"}
          title={bulkSummaryTitle(bulkResult)}
          onDismiss={() => setBulkResult(null)}
        >
          {bulkSummaryLine(bulkResult)}
          {bulkResult.results.some((r) => r.outcome === "refused") && (
            <ul>
              {bulkResult.results
                .filter((r) => r.outcome === "refused")
                .map((r) => (
                  <li key={r.id}>
                    <code>{r.id}</code> — {r.reason}
                  </li>
                ))}
            </ul>
          )}
        </Notice>
      )}

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
          // Issue #4331: the one list is the table below; the manager keeps its
          // form, latest runs and audit trail, and opens that form when a row's
          // Edit control sends a request.
          showSchedulesSection={false}
          // Issue #4332: the options-run columns (symbols, actionable setups) ride
          // the one ledger, so its card is not repeated here.
          showLatestRuns={false}
          editRequest={editRequest ?? undefined}
        />
      )}

      {loading && schedules.length === 0 ? (
        <p className="ui-meta">Loading schedules…</p>
      ) : error ? (
        <Notice tone="danger" title="Schedules could not be loaded">
          {error}{" "}
          <Button type="button" variant="secondary" size="sm" onClick={fetchSchedules}>
            Retry
          </Button>
        </Notice>
      ) : showGenericSection ? (
        <Card>
          <header>
            {/* Issue #4353 — one heading row: the name, the count and the
                table's own description, instead of a title stacked over the
                caption. */}
            <CardHeader
              title={
                <>
                  <span aria-hidden="true">🗂️</span> Schedules
                  <Badge tone="accent" size="xs">{rows.length} Shown</Badge>
                  <span className="ui-meta">Every durable schedule, one row each</span>
                </>
              }
            />
            {loading && <span className="ui-meta">Refreshing…</span>}
          </header>
          <Table
            columns={visibleGenericColumns}
            rows={rows}
            rowKey={(s) => s.id}
            rowClassName="schedule-item-card"
            rowTitle={(s) => `${s.id} · ${s.callback}`}
            containerClassName="sched-table-scroll"
            empty={
              // Issue #5889 — the empty state names the active filters, so
              // an empty source / agent / workflow view reads as "nothing
              // with this source", never as "nothing scheduled".
              <p className="ui-meta">
                {(() => {
                  const parts: string[] = [];
                  if (activeTab !== "all") parts.push(SCHEDULE_LIST_FILTER_LABELS[activeTab]);
                  if (sourceFilter !== "all") {
                    parts.push(
                      sourceFilter === "cron" ? "Cron" : SCHEDULE_SOURCE_FILTER_LABELS[sourceFilter],
                    );
                  }
                  if (effectiveAgentFilter !== "all") parts.push(`agent ${effectiveAgentFilter}`);
                  if (effectiveWorkflowFilter !== "all") {
                    parts.push(`workflow ${effectiveWorkflowFilter}`);
                  }
                  if (statusFilter !== "all") {
                    parts.push(SCHEDULE_LIST_STATUS_LABELS[statusFilter].toLowerCase());
                  }
                  return parts.length > 0
                    ? `No ${parts.join(" · ")} schedules.`
                    : "No schedules in this group.";
                })()}
              </p>
            }
          />
        </Card>
      ) : null}
    </PageSection>
  );
}
