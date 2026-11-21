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
  addBuiltinGoals,
  bulkScheduleAction,
  deleteSchedule,
  getSchedule,
  listBuiltinGoals,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  updateSchedule,
  type BulkScheduleResult,
  type PresetGoalResult,
  type ScheduledGoal,
} from "./jobsApi";
import {
  confirmCancelAll,
  confirmClearTable,
  previewCancelAll,
  previewClearTable,
  recreateTrack1,
  track1RecreatePlan,
  type CancelAllPreview,
  type CancelAllResult,
  type ClearTablePreview,
  type RecreateResultItem,
  type Track1PlanItem,
} from "./adminQueueApi";
import {
  jobCatalogueEntryForCallback,
  jobCatalogueEntryForOperation,
} from "../config/jobCatalogue";
import { fetchAdminOverview } from "./iaaaAdminApi";
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

/**
 * Issue #5893 — the rows of a list that come back on their own after
 * an empty, by class. Derived rows re-derive from code on the next
 * list (the six ids above, or any row the server stamps source
 * `derived`); declared tasks re-arm on the next Think reconcile
 * (source `declared-task`); built-in goals re-seed when the store is
 * empty, except goals the owner removed (kind `goal`, or source
 * `seeded`). Each id lands in exactly one bucket. Everything else —
 * user-created, agent-created, pipeline, workflow, ticker-push,
 * system, unknown rows — goes and stays gone.
 */
export interface EmptyListComeback {
  derived: string[];
  declaredTasks: string[];
  seededGoals: string[];
}

export function emptyListComeback(schedules: ScheduleItem[]): EmptyListComeback {
  const derived: string[] = [];
  const declaredTasks: string[] = [];
  const seededGoals: string[] = [];
  for (const s of schedules) {
    if (DERIVED_SCHEDULE_IDS.has(s.id) || scheduleSourceKindOf(s) === "derived") {
      derived.push(s.id);
    } else if (scheduleSourceKindOf(s) === "declared-task") {
      declaredTasks.push(s.id);
    } else if (s.kind === "goal" || scheduleSourceKindOf(s) === "seeded") {
      seededGoals.push(s.id);
    }
  }
  return { derived, declaredTasks, seededGoals };
}

/** The verified outcome of one Empty-the-list run, for the result notice. */
export interface EmptyListResult {
  cancelled: number;
  pausedDeleted: number;
  /** Alarms the cancel step failed to cancel (they stay listed). */
  failed: CancelAllResult["failed"];
  /** The clear-table step's failure, when the wipe was partial. */
  clearError?: string;
  /** Row ids still listed after the verifying re-fetch. */
  remaining: string[];
  /** Remaining rows that were NOT expected to come back. */
  unexpectedRemaining: string[];
}

/**
 * Issue #5894 — the needed set a reset plants, in one place. The
 * seedable built-in goal ids come from the server (GET
 * /api/schedule/builtin-goals — the config read, owner-removed goals
 * subtracted, never a client copy); the Track 1 labels come from
 * `track1RecreatePlan()`; the comeback classes reuse #5893's
 * `emptyListComeback`. Gone-for-good is every current row the reset
 * neither re-plants nor expects back on its own — including a goal
 * row the server no longer seeds (owner-removed, or user-created).
 */
export interface ResetNeededSet {
  /** Built-in goal ids the reset will re-seed (the server's seedable list). */
  seededGoals: string[];
  /** Owner-removed built-in goal ids: they stay removed, named so the preview proves it. */
  removedGoals: string[];
  /** Track 1 labels the reset will re-create. */
  track1: string[];
  /** Derived rows that come back on their own (re-derived from code). */
  derived: string[];
  /** Declared tasks that re-arm on the next Think reconcile. */
  declaredTasks: string[];
  /** Current rows that go and stay gone. */
  goneForGood: string[];
}

/**
 * Issue #5894 — classify the needed set for a reset, against the one
 * job catalogue (#5880): every planted job must resolve there — a
 * seedable goal by its operation, a Track 1 item by its callback —
 * or the preview refuses instead of planting a job no list knows.
 * Throws on an uncatalogued planted job; that is the fail-closed
 * enforcement that the needed set is expressed against the catalogue,
 * not a second list.
 */
export function resetNeededSet(
  schedules: ScheduleItem[],
  seedableGoals: Array<{ id: string; operation: string }>,
  removedGoalIds: string[],
  track1Plan: Track1PlanItem[],
): ResetNeededSet {
  for (const goal of seedableGoals) {
    if (!jobCatalogueEntryForOperation(goal.operation)) {
      throw new Error(
        `Reset needed set names a job outside the one catalogue: ${goal.id} (${goal.operation})`,
      );
    }
  }
  for (const item of track1Plan) {
    if (!jobCatalogueEntryForCallback(item.requestBody.callback)) {
      throw new Error(
        `Reset needed set names a job outside the one catalogue: ${item.label} (${item.requestBody.callback})`,
      );
    }
  }
  const comeback = emptyListComeback(schedules);
  const seeded = new Set(seedableGoals.map((goal) => goal.id));
  const backOnOwn = new Set([...comeback.derived, ...comeback.declaredTasks]);
  return {
    seededGoals: seedableGoals.map((goal) => goal.id),
    removedGoals: [...removedGoalIds],
    track1: track1Plan.map((item) => item.label),
    derived: comeback.derived,
    declaredTasks: comeback.declaredTasks,
    goneForGood: schedules
      .filter((s) => !backOnOwn.has(s.id) && !seeded.has(s.id))
      .map((s) => s.id),
  };
}

/** The verified outcome of one Reset-to-defaults run, for the result notice. */
export interface ResetToDefaultsResult {
  cancelled: number;
  pausedDeleted: number;
  /** Alarms the cancel step failed to cancel (they stay listed). */
  failed: CancelAllResult["failed"];
  /** The clear-table step's failure, when the wipe was partial. */
  clearError?: string;
  /** Per-goal re-seed outcomes, from the Seed-all machinery. */
  seeded: PresetGoalResult[];
  /** Per-item Track 1 recreation outcomes. */
  track1: RecreateResultItem[];
  /** Row ids still listed after the verifying re-fetch. */
  remaining: string[];
  /** Planted rows (seeded goals, Track 1 creates) absent from the verify re-fetch. */
  missingPlanted: string[];
  /** Declared tasks not yet re-armed (Think reconcile pending — expected, not a failure). */
  pendingDeclared: string[];
  /** Remaining rows that were neither planted nor expected back on their own. */
  unexpectedRemaining: string[];
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
  // Issue #5893 — one-click empty: the platform-admin gate probe
  // (the same overview probe the queue view uses), the preview, and
  // the verified result. The wipe itself reuses the two existing
  // routes (cancel-all + clear-table); no new route, no new wipe
  // primitive, no new audit event type.
  const [emptyGate, setEmptyGate] = useState<"loading" | "allowed" | "denied" | "error">("loading");
  const [emptyGateError, setEmptyGateError] = useState<string | null>(null);
  const [emptyPreview, setEmptyPreview] = useState<{
    cancel: CancelAllPreview;
    clear: ClearTablePreview;
  } | null>(null);
  const [emptyModalOpen, setEmptyModalOpen] = useState(false);
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [emptyResult, setEmptyResult] = useState<EmptyListResult | null>(null);
  // Issue #5894 — wipe-and-reseed: the same gate as the empty
  // action, the preview (wipe previews + the server's seedable list
  // + the Track 1 plan), and the verified result. The wipe itself is
  // the empty action's two steps; the reseed plants the needed set
  // through the Seed-all machinery and the Track 1 recreate.
  const [resetPreview, setResetPreview] = useState<{
    cancel: CancelAllPreview;
    clear: ClearTablePreview;
    builtin: { goals: ScheduledGoal[]; removedBuiltinGoalIds: string[] };
    track1: Track1PlanItem[];
    needed: ResetNeededSet;
  } | null>(null);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetResult, setResetResult] = useState<ResetToDefaultsResult | null>(null);
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

  // Issue #5893 — the empty action is platform-admin gated, with the
  // same probe the queue view uses (GET /api/iaaa/overview): a
  // 403/Forbidden refusal means "not an admin" (the same gate test
  // ScheduleQueueView.isOverviewGateRefusal makes — duplicated here
  // rather than imported, because importing ScheduleQueueView would
  // cycle through AdminQueueWipePanel back into this file). Any other
  // probe failure leaves the action unavailable with the reason.
  useEffect(() => {
    let cancelled = false;
    void fetchAdminOverview()
      .then(() => {
        if (!cancelled) setEmptyGate("allowed");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load IAAA overview.";
        if (/403|Forbidden/.test(message)) {
          setEmptyGate("denied");
        } else {
          setEmptyGateError(message);
          setEmptyGate("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  /**
   * Issue #5893 — the wipe both destructive home actions share: both
   * previews, fail-closed. The clear-table call names the one unified
   * table here, once; the reset (#5894) calls this instead of passing
   * the table name a second time.
   */
  const previewEmptyWipe = async () => {
    const [cancel, clear] = await Promise.all([
      previewCancelAll(),
      previewClearTable("unified_schedules"),
    ]);
    return { cancel, clear };
  };

  /**
   * Issue #5893 — the wipe confirm both destructive home actions
   * share: cancel the alarms, then clear the paused records. A clear
   * failure after a successful cancel is a partial wipe: the error is
   * returned, not thrown, so the caller can still reseed (#5894) and
   * report the partial wipe honestly instead of claiming "empty".
   */
  const confirmEmptyWipe = async (): Promise<{
    cancelResult: CancelAllResult;
    pausedDeleted: number;
    clearError?: string;
  }> => {
    const cancelResult = await confirmCancelAll();
    let pausedDeleted = 0;
    let clearError: string | undefined;
    try {
      pausedDeleted = (await confirmClearTable("unified_schedules")).deleted;
    } catch (err) {
      clearError = err instanceof Error ? err.message : String(err);
    }
    return { cancelResult, pausedDeleted, ...(clearError !== undefined ? { clearError } : {}) };
  };

  /** Issue #5893 — the empty preview: both wipe previews, fail-closed. */
  const onPreviewEmpty = async () => {
    setActionError(null);
    setEmptyResult(null);
    setEmptyBusy(true);
    try {
      const { cancel, clear } = await previewEmptyWipe();
      setEmptyPreview({ cancel, clear });
      setEmptyModalOpen(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setEmptyBusy(false);
    }
  };

  /**
   * Issue #5893 — the empty confirm: the shared wipe, then verify.
   * Verification is the re-fetched list, classified against the
   * comeback the preview promised.
   */
  const runEmptyConfirm = async () => {
    setEmptyBusy(true);
    try {
      const { cancelResult, pausedDeleted, clearError } = await confirmEmptyWipe();
      const fresh = (await listSchedules(envHeaders)) as unknown as ScheduleItem[];
      setSchedules(fresh);
      setRefreshSignal((n) => n + 1);
      const comeback = emptyListComeback(fresh);
      const expected = new Set([...comeback.derived, ...comeback.declaredTasks, ...comeback.seededGoals]);
      setEmptyResult({
        cancelled: cancelResult.cancelled,
        pausedDeleted,
        failed: cancelResult.failed,
        ...(clearError !== undefined ? { clearError } : {}),
        remaining: fresh.map((s) => s.id),
        unexpectedRemaining: fresh.filter((s) => !expected.has(s.id)).map((s) => s.id),
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setEmptyBusy(false);
      setEmptyModalOpen(false);
      setEmptyPreview(null);
    }
  };

  /**
   * Issue #5894 — the reset preview: the shared wipe previews plus
   * the server's seedable list (the built-in half of the needed set,
   * owner-removed goals subtracted by the server) and the Track 1
   * plan. Fail-closed on any of the three: a preview that cannot name
   * the needed set opens no modal and cancels nothing. The catalogue
   * check inside `resetNeededSet` refuses a needed set that names a
   * job outside the one catalogue.
   */
  const onPreviewReset = async () => {
    setActionError(null);
    setResetResult(null);
    setResetBusy(true);
    try {
      const [{ cancel, clear }, builtin] = await Promise.all([
        previewEmptyWipe(),
        listBuiltinGoals(),
      ]);
      const track1 = track1RecreatePlan();
      const needed = resetNeededSet(schedules, builtin.goals, builtin.removedBuiltinGoalIds, track1);
      setResetPreview({ cancel, clear, builtin, track1, needed });
      setResetModalOpen(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetBusy(false);
    }
  };

  /**
   * Issue #5894 — the reset confirm: the shared wipe, then re-seed
   * the needed set, then verify. The reseed runs even after a partial
   * wipe (a failed clear leaves rows the Seed-all batch skips as
   * already-existing, never duplicates), and every step reports
   * per-item so the result never claims a reset it did not verify.
   * Verification is the re-fetched list: planted rows (seeded goals
   * added or skipped, Track 1 creates) must be listed — a planted row
   * that is absent is a failure, named; declared tasks still absent
   * are pending Think reconcile, named, not a failure; anything else
   * listed is unexpected.
   */
  const runResetConfirm = async () => {
    const preview = resetPreview;
    if (!preview) return;
    setResetBusy(true);
    try {
      const { cancelResult, pausedDeleted, clearError } = await confirmEmptyWipe();
      const seeded = await addBuiltinGoals(preview.builtin.goals, []);
      const track1 = await recreateTrack1();
      const fresh = (await listSchedules(envHeaders)) as unknown as ScheduleItem[];
      setSchedules(fresh);
      setRefreshSignal((n) => n + 1);
      const freshIds = new Set(fresh.map((s) => s.id));
      const plantedGoalIds = seeded
        .filter((r) => r.status === "added" || r.status === "skipped")
        .map((r) => r.id);
      const plantedTrack1Ids = track1
        .filter((r) => r.ok && r.scheduleId !== undefined)
        .map((r) => r.scheduleId as string);
      const planted = [...plantedGoalIds, ...plantedTrack1Ids];
      const expected = new Set([
        ...planted,
        ...preview.needed.derived,
        ...preview.needed.declaredTasks,
      ]);
      setResetResult({
        cancelled: cancelResult.cancelled,
        pausedDeleted,
        failed: cancelResult.failed,
        ...(clearError !== undefined ? { clearError } : {}),
        seeded,
        track1,
        remaining: fresh.map((s) => s.id),
        missingPlanted: planted.filter((id) => !freshIds.has(id)),
        pendingDeclared: preview.needed.declaredTasks.filter((id) => !freshIds.has(id)),
        unexpectedRemaining: fresh.filter((s) => !expected.has(s.id)).map((s) => s.id),
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetBusy(false);
      setResetModalOpen(false);
      setResetPreview(null);
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

      {/* Issue #5893 — one-click empty: the preview names what will
          go (alarms + paused records) and what will come back on its
          own, so "empty" is never a surprise. The two wipe steps are
          named as steps: cancel-all alone would preserve the paused
          records, and the clear step is what deletes them. */}
      <ConfirmModal
        open={emptyModalOpen}
        title="Empty the list?"
        confirmLabel="Empty the list"
        cancelLabel="Keep schedules"
        busy={emptyBusy}
        onClose={() => {
          setEmptyModalOpen(false);
          setEmptyPreview(null);
        }}
        onConfirm={() => void runEmptyConfirm()}
      >
        {emptyPreview && (
          <div>
            <p>
              {emptyPreview.cancel.wouldCancelCount} alarm(s) will be cancelled;{" "}
              {emptyPreview.clear.wouldDelete} paused record(s) will be deleted.
            </p>
            {emptyPreview.cancel.pausedPreserved > 0 && (
              <p>
                Cancel-all alone would preserve {emptyPreview.cancel.pausedPreserved} paused
                record(s); this action also clears them, so they go too.
              </p>
            )}
            {(() => {
              const comeback = emptyListComeback(schedules);
              const lines: string[] = [];
              if (comeback.derived.length > 0) {
                lines.push(
                  `${comeback.derived.length} derived row(s) will come back on their own — they are derived from code and re-appear on the next list: ${comeback.derived.join(", ")}.`,
                );
              }
              if (comeback.declaredTasks.length > 0) {
                lines.push(
                  `${comeback.declaredTasks.length} declared task(s) will re-arm on the next Think reconcile: ${comeback.declaredTasks.join(", ")}.`,
                );
              }
              if (comeback.seededGoals.length > 0) {
                lines.push(
                  `${comeback.seededGoals.length} built-in goal(s) will re-seed when the store is empty (except goals the owner removed): ${comeback.seededGoals.join(", ")}.`,
                );
              }
              if (lines.length === 0) return <p>Nothing in the list comes back on its own.</p>;
              return (
                <>
                  {lines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </>
              );
            })()}
            <p>
              Own instance only — KV is never touched; nothing platform-wide is wiped. This
              cannot be undone.
            </p>
          </div>
        )}
      </ConfirmModal>

      {/* Issue #5894 — wipe-and-reseed: the preview names what will
          exist after the reset (the needed set: seedable built-ins +
          Track 1), what comes back on its own, what stays gone for
          good, and which owner-removed goals stay removed — so a
          reset is never a surprise either. */}
      <ConfirmModal
        open={resetModalOpen}
        title="Reset to defaults?"
        confirmLabel="Reset to defaults"
        cancelLabel="Keep schedules"
        busy={resetBusy}
        onClose={() => {
          setResetModalOpen(false);
          setResetPreview(null);
        }}
        onConfirm={() => void runResetConfirm()}
      >
        {resetPreview && (
          <div>
            <p>
              {resetPreview.cancel.wouldCancelCount} alarm(s) will be cancelled;{" "}
              {resetPreview.clear.wouldDelete} paused record(s) will be deleted.
            </p>
            {resetPreview.cancel.pausedPreserved > 0 && (
              <p>
                Cancel-all alone would preserve {resetPreview.cancel.pausedPreserved} paused
                record(s); this action also clears them, so they go too.
              </p>
            )}
            <p>
              After the reset, the list will hold the needed set:{" "}
              {resetPreview.needed.seededGoals.length} built-in goal(s) will be re-seeded:{" "}
              {resetPreview.needed.seededGoals.join(", ")}.{" "}
              {resetPreview.needed.track1.length} Track 1 screen(s) will be re-created:{" "}
              {resetPreview.needed.track1.join(", ")}.
            </p>
            {resetPreview.needed.derived.length > 0 && (
              <p>
                {resetPreview.needed.derived.length} derived row(s) will come back on their own
                — they are derived from code and re-appear on the next list:{" "}
                {resetPreview.needed.derived.join(", ")}.
              </p>
            )}
            {resetPreview.needed.declaredTasks.length > 0 && (
              <p>
                {resetPreview.needed.declaredTasks.length} declared task(s) will re-arm on the
                next Think reconcile: {resetPreview.needed.declaredTasks.join(", ")}.
              </p>
            )}
            {resetPreview.needed.goneForGood.length > 0 && (
              <p>
                {resetPreview.needed.goneForGood.length} row(s) will go and stay gone:{" "}
                {resetPreview.needed.goneForGood.join(", ")}.
              </p>
            )}
            {resetPreview.needed.removedGoals.length > 0 && (
              <p>
                {resetPreview.needed.removedGoals.length} built-in goal(s) stay removed — the
                owner removed them, so the reset never re-seeds them:{" "}
                {resetPreview.needed.removedGoals.join(", ")}.
              </p>
            )}
            <p>
              Own instance only — KV is never touched; nothing platform-wide is wiped. This
              cannot be undone.
            </p>
          </div>
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
        {/* Issue #5893 — one-click empty: the action the issue
            requires, beside the bulk verbs. Platform-admin gated
            (the probe above); a non-admin never sees the button,
            only the note below it. */}
        {emptyGate === "allowed" && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={emptyBusy || loading}
            onClick={() => void onPreviewEmpty()}
            title="Empty the list — preview what will go and what will come back, then confirm. Own instance only; KV is never touched."
          >
            Empty the list
          </Button>
        )}
        {/* Issue #5894 — wipe-and-reseed: the reset consumes the
            empty action, so it sits beside it under the same gate —
            the admin queue holds the same wipe, and the wipe panel
            holds the Track 1 recreate this action calls. */}
        {emptyGate === "allowed" && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={resetBusy || loading}
            onClick={() => void onPreviewReset()}
            title="Reset to defaults — wipe the list, then re-seed the needed set. Preview what will exist after the reset, then confirm. Own instance only; KV is never touched."
          >
            Reset to defaults
          </Button>
        )}
      </Flex>

      {/* Issue #5893 — the gate, said plainly: emptying the list is
          a platform-admin action, and the admin queue holds the same
          wipe. A probe failure names itself instead of hiding the
          action silently. Issue #5894 — the reset shares the gate and
          the probe, so the same note covers it. */}
      {emptyGate === "denied" && (
        <p className="ui-meta">
          Emptying the list and resetting to defaults are platform-admin actions — this account
          is not a platform admin. The admin queue (?tab=schedules&amp;view=queue) holds the
          same wipe.
        </p>
      )}
      {emptyGate === "error" && emptyGateError && (
        <p className="ui-meta">
          Empty the list and reset to defaults are unavailable: {emptyGateError}
        </p>
      )}

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

      {/* Issue #5893 — the verified empty result: what the two steps
          did, and what the re-fetched list still holds. A partial
          wipe (clear failure, failed cancels, unexpected remainders)
          is a warning that names the gap, never a success that claims
          "empty". */}
      {emptyResult && (
        <Notice
          tone={
            emptyResult.clearError !== undefined ||
            emptyResult.unexpectedRemaining.length > 0 ||
            emptyResult.failed.length > 0
              ? "warning"
              : "success"
          }
          title={
            emptyResult.clearError !== undefined ||
            emptyResult.unexpectedRemaining.length > 0 ||
            emptyResult.failed.length > 0
              ? "List not fully emptied"
              : "Emptied the list"
          }
          onDismiss={() => setEmptyResult(null)}
        >
          <p>
            Cancelled {emptyResult.cancelled} alarm(s), deleted {emptyResult.pausedDeleted} paused
            record(s).
          </p>
          {emptyResult.failed.length > 0 && (
            <p>
              Failed to cancel:{" "}
              {emptyResult.failed.map((f) => `${f.id} (${f.error})`).join(", ")}.
            </p>
          )}
          {emptyResult.clearError !== undefined && (
            <p>
              The paused-records clear failed: {emptyResult.clearError} — the alarms were
              cancelled but the paused records were not deleted.
            </p>
          )}
          {emptyResult.remaining.length > 0 && (
            <p>
              {emptyResult.remaining.length} row(s) remain: {emptyResult.remaining.join(", ")}.
              {emptyResult.unexpectedRemaining.length === 0
                ? " They came back on their own — derived rows re-derive from code, declared tasks re-arm on the next Think reconcile, built-in goals re-seed when the store is empty."
                : ` Of those, ${emptyResult.unexpectedRemaining.length} row(s) were not expected to come back: ${emptyResult.unexpectedRemaining.join(", ")}.`}
            </p>
          )}
        </Notice>
      )}

      {/* Issue #5894 — the verified reset result: what the wipe did,
          what the reseed planted per item, and what the re-fetched
          list holds. A partial reset (clear failure, failed cancels,
          a planted row that is not listed, a failed seed or create,
          unexpected remainders) is a warning that names the gap,
          never a success that claims "defaults". Declared tasks still
          absent are pending Think reconcile — expected, not a gap. */}
      {resetResult &&
        (() => {
          const seededAdded = resetResult.seeded.filter((r) => r.status === "added").length;
          const seededSkipped = resetResult.seeded.filter((r) => r.status === "skipped").length;
          const seededFailed = resetResult.seeded.filter((r) => r.status === "failed");
          const track1Ok = resetResult.track1.filter((r) => r.ok).length;
          const track1Failed = resetResult.track1.filter((r) => !r.ok);
          const incomplete =
            resetResult.clearError !== undefined ||
            resetResult.failed.length > 0 ||
            resetResult.missingPlanted.length > 0 ||
            resetResult.unexpectedRemaining.length > 0 ||
            seededFailed.length > 0 ||
            track1Failed.length > 0;
          return (
            <Notice
              tone={incomplete ? "warning" : "success"}
              title={incomplete ? "Reset incomplete" : "Reset to defaults"}
              onDismiss={() => setResetResult(null)}
            >
              <p>
                Cancelled {resetResult.cancelled} alarm(s), deleted {resetResult.pausedDeleted}{" "}
                paused record(s).
              </p>
              {resetResult.failed.length > 0 && (
                <p>
                  Failed to cancel:{" "}
                  {resetResult.failed.map((f) => `${f.id} (${f.error})`).join(", ")}.
                </p>
              )}
              {resetResult.clearError !== undefined && (
                <p>
                  The paused-records clear failed: {resetResult.clearError} — the alarms were
                  cancelled but the paused records were not deleted.
                </p>
              )}
              <p>
                Re-seeded {resetResult.seeded.length} built-in goal(s) ({seededAdded} added
                {seededSkipped > 0 ? `, ${seededSkipped} already present` : ""}).
              </p>
              {seededFailed.length > 0 && (
                <p>
                  Failed to re-seed:{" "}
                  {seededFailed.map((r) => `${r.id} (${r.error})`).join(", ")}.
                </p>
              )}
              <p>
                Re-created {track1Ok} of {resetResult.track1.length} Track 1 screen(s).
              </p>
              {track1Failed.length > 0 && (
                <p>
                  Failed to re-create:{" "}
                  {track1Failed.map((r) => `${r.label} (${r.error ?? "failed"})`).join(", ")}.
                </p>
              )}
              {resetResult.missingPlanted.length > 0 && (
                <p>
                  Planted but not listed after the reset:{" "}
                  {resetResult.missingPlanted.join(", ")}.
                </p>
              )}
              {resetResult.pendingDeclared.length > 0 && (
                <p>
                  {resetResult.pendingDeclared.length} declared task(s) still to re-arm on the
                  next Think reconcile: {resetResult.pendingDeclared.join(", ")}.
                </p>
              )}
              {resetResult.remaining.length > 0 && (
                <p>
                  {resetResult.remaining.length} row(s) remain: {resetResult.remaining.join(", ")}
                  {resetResult.unexpectedRemaining.length > 0
                    ? ` Of those, ${resetResult.unexpectedRemaining.length} row(s) were not expected to be there: ${resetResult.unexpectedRemaining.join(", ")}.`
                    : ""}
                </p>
              )}
            </Notice>
          );
        })()}

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
