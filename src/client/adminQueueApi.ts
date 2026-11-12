/**
 * #2173 admin-panel Queue tab — API client for the wipe surface.
 *
 * The Queue tab reads and mutates ONLY through existing routes:
 * - GET /api/schedules — the per-instance schedule/queue dump.
 * - POST /api/schedules/cancel-all — fail-closed preview without
 *   { confirm: true }, confirmed cancel, audit schedules.cancelled.all.
 * - POST /api/maintenance/clear-table — allowlisted tables only,
 *   audit maintenance.table.cleared.
 * - POST /api/schedules/create — Track 1 recreation, one create per
 *   schedule, audit schedule.created / schedule.duplicate_suppressed.
 *
 * No new server route exists for this slice. Every function throws
 * on a non-ok response (server message) or a malformed payload —
 * the UI never renders partial or silently empty data for a
 * destructive action. The dump exposes universe only from payloads:
 * logins and delivery addresses stay server-side.
 */
import { apiFetch } from "./apiFetch";
import {
  buildScheduleSubmission,
  validateScheduleCriteriaClient,
} from "./scheduledOptionsManager/payloadBuilders";
import type { ScheduleFormState } from "./scheduledOptionsManager/types";

/** One dump row: identity, cadence, and universe — nothing else. */
export interface QueueScheduleView {
  id: string;
  callback: string;
  type?: string;
  cron?: string;
  intervalSeconds?: number;
  time?: number;
  nextRun?: string;
  paused?: boolean;
  universe?: string;
}

export interface QueueDump {
  count: number;
  schedules: QueueScheduleView[];
}

export interface CancelAllPreview {
  confirmRequired: boolean;
  wouldCancel: Array<{ id: string; callback: string }>;
  wouldCancelCount: number;
  pausedPreserved: number;
}

export interface CancelAllResult {
  cancelled: number;
  cancelledIds: string[];
  failed: Array<{ id: string; error: string }>;
  pausedPreserved: number;
}

export type ClearableTable = "mas_async_jobs" | "mas_job_outcomes" | "mas_job_outcomes_meta" | "mas_events" | "unified_schedules";

export interface ClearTablePreview {
  table: string;
  scope: string;
  confirmed: false;
  confirmRequired: boolean;
  wouldDelete: number;
  breakdown?: Record<string, number>;
  skippedRunning?: number;
}

export interface ClearTableResult {
  table: string;
  scope: string;
  confirmed: true;
  deleted: number;
  skippedRunning?: number;
}

export interface Track1PlanItem {
  label: string;
  requestBody: {
    callback: string;
    scheduleType: string;
    payload: Record<string, unknown>;
    intervalSeconds?: number;
    cron?: string;
  };
}

export interface RecreateResultItem {
  label: string;
  ok: boolean;
  scheduleId?: string;
  duplicate?: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Malformed admin queue response: ${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`Malformed admin queue response: ${field} must be a number`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Malformed admin queue response: body is not JSON");
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function fetchQueueDump(): Promise<QueueDump> {
  const response = await apiFetch("/api/schedules");
  const data = await readJson(response);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  if (!isRecord(data) || !Array.isArray(data.schedules)) {
    throw new Error("Malformed admin queue response: schedules must be an array");
  }
  const schedules: QueueScheduleView[] = data.schedules.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Malformed admin queue response: schedule row must be an object");
    }
    const payload = isRecord(item.payload) ? item.payload : undefined;
    return {
      id: requireString(item.id, "id"),
      callback: requireString(item.callback, "callback"),
      type: optionalString(item.type),
      cron: optionalString(item.cron),
      intervalSeconds: optionalNumber(item.intervalSeconds),
      time: optionalNumber(item.time),
      nextRun: optionalString(item.nextRun),
      paused: optionalBoolean(item.paused),
      universe: payload ? optionalString(payload.universe) : undefined,
    };
  });
  return {
    count: typeof data.count === "number" ? data.count : schedules.length,
    schedules,
  };
}

export async function previewCancelAll(): Promise<CancelAllPreview> {
  const data = await postJson("/api/schedules/cancel-all", {});
  if (!isRecord(data) || !Array.isArray(data.wouldCancel)) {
    throw new Error("Malformed cancel-all preview: wouldCancel must be an array");
  }
  return {
    confirmRequired: data.confirmRequired === true,
    wouldCancel: data.wouldCancel.map((item) => {
      if (!isRecord(item)) throw new Error("Malformed cancel-all preview: wouldCancel row must be an object");
      return { id: requireString(item.id, "id"), callback: requireString(item.callback, "callback") };
    }),
    wouldCancelCount: requireNumber(data.wouldCancelCount, "wouldCancelCount"),
    pausedPreserved: requireNumber(data.pausedPreserved, "pausedPreserved"),
  };
}

export async function confirmCancelAll(): Promise<CancelAllResult> {
  const data = await postJson("/api/schedules/cancel-all", { confirm: true });
  if (!isRecord(data)) {
    throw new Error("Malformed cancel-all result: expected an object");
  }
  const failed = Array.isArray(data.failed)
    ? data.failed.map((item) => {
        if (!isRecord(item)) throw new Error("Malformed cancel-all result: failed row must be an object");
        return { id: requireString(item.id, "id"), error: requireString(item.error, "error") };
      })
    : [];
  return {
    cancelled: requireNumber(data.cancelled, "cancelled"),
    cancelledIds: Array.isArray(data.cancelledIds)
      ? data.cancelledIds.map((id) => requireString(id, "cancelledIds"))
      : [],
    failed,
    pausedPreserved: requireNumber(data.pausedPreserved, "pausedPreserved"),
  };
}

export async function previewClearTable(table: ClearableTable): Promise<ClearTablePreview> {
  const data = await postJson("/api/maintenance/clear-table", { table });
  if (!isRecord(data) || data.confirmRequired !== true) {
    throw new Error("Malformed clear-table preview: confirmRequired must be true");
  }
  return {
    table: requireString(data.table, "table"),
    scope: requireString(data.scope, "scope"),
    confirmed: false,
    confirmRequired: true,
    wouldDelete: requireNumber(data.wouldDelete, "wouldDelete"),
    breakdown: isRecord(data.breakdown) ? (data.breakdown as Record<string, number>) : undefined,
    skippedRunning: optionalNumber(data.skippedRunning),
  };
}

export async function confirmClearTable(table: ClearableTable, statuses?: string[]): Promise<ClearTableResult> {
  const data = await postJson("/api/maintenance/clear-table", {
    table,
    confirm: true,
    ...(statuses ? { statuses } : {}),
  });
  if (!isRecord(data) || data.confirmed !== true) {
    throw new Error("Malformed clear-table result: confirmed must be true");
  }
  return {
    table: requireString(data.table, "table"),
    scope: requireString(data.scope, "scope"),
    confirmed: true,
    deleted: requireNumber(data.deleted, "deleted"),
    skippedRunning: optionalNumber(data.skippedRunning),
  };
}

/**
 * The exact Track 1 recreation set, built through the schedule form's
 * single payload-construction path (buildScheduleSubmission) so the
 * bodies are form-identical by construction, not hand-copied.
 *
 * Stock legs carry the spec delivery (Slack #screener_slack_channel +
 * dhmprstw@gmail.com); options legs carry the builder's blank delivery
 * (slackChannel "" raw, emailTo undefined), which delivery treats as
 * unset (falsy) so alerts flow via the configured env channel — the
 * same bodies the schedule form submits. The server
 * re-stamps identity from the trusted session on create; no login is
 * sent from this client.
 */
function track1FormState(
  jobType: "marketScreen" | "optionsAnalysis",
  scheduleType: "cron" | "interval",
  cadence: { cron?: string; intervalSeconds?: number },
  overrides: Partial<ScheduleFormState>,
): ScheduleFormState {
  return {
    jobType,
    targetSymbols: "",
    maxItems: 100,
    targetUniverse: "NASDAQ100",
    sector: "ALL",
    minPrice: "",
    maxPrice: "",
    minMarketCap: "",
    maxPe: "",
    trendFilter: "",
    presetId: undefined,
    scheduleType,
    intervalSeconds: cadence.intervalSeconds ?? 0,
    cronExpression: cadence.cron ?? "",
    delaySeconds: 0,
    scheduledDate: "",
    thesis: "bullish",
    riskProfile: "balanced",
    pushToSlack: true,
    slackChannel: "",
    emailTo: "",
    webhookUrl: "",
    discoveryRequests: [],
    discoveryInputModel: "saved-request",
    derivedSource: "symbols",
    derivedSymbolsText: "",
    derivedWatchlistName: "",
    derivedProfileId: "",
    noViewDraft: {
      symbolsText: "",
      maxPlannedLoss: "",
      minRewardRisk: "",
      minProbabilityOfProfit: "",
      minDte: "",
      maxDte: "",
      riskProfile: "balanced",
    },
    environment: "PROD",
    ...overrides,
  };
}

export function track1RecreatePlan(): Track1PlanItem[] {
  const specs: Array<{ label: string; state: ScheduleFormState }> = [
    {
      label: "Stock pre-market",
      state: track1FormState("marketScreen", "cron", { cron: "30 12 * * 1-5" }, {
        slackChannel: "#screener_slack_channel",
        emailTo: "dhmprstw@gmail.com",
      }),
    },
    {
      label: "Stock intra-day",
      state: track1FormState("marketScreen", "cron", { cron: "30 16 * * 1-5" }, {
        slackChannel: "#screener_slack_channel",
        emailTo: "dhmprstw@gmail.com",
      }),
    },
    {
      label: "Options NASDAQ100",
      state: track1FormState("optionsAnalysis", "interval", { intervalSeconds: 3600 }, {}),
    },
    {
      label: "Options SP100",
      state: track1FormState("optionsAnalysis", "interval", { intervalSeconds: 3600 }, {
        targetUniverse: "SP100",
      }),
    },
  ];
  return specs.map(({ label, state }) => {
    const built = buildScheduleSubmission(state);
    if ("error" in built) {
      throw new Error(`Track 1 plan for ${label} failed validation: ${built.error}`);
    }
    const criteriaError = validateScheduleCriteriaClient(built.requestBody.callback, built.requestBody.payload);
    if (criteriaError) {
      throw new Error(`Track 1 plan for ${label} failed criteria validation: ${criteriaError}`);
    }
    // Narrow the builder's Record<string, any> body to the typed plan
    // shape the panel renders and posts. A shape change in the builder
    // fails here, loudly, instead of posting a malformed create.
    const raw = built.requestBody as Record<string, unknown>;
    if (typeof raw.callback !== "string" || typeof raw.scheduleType !== "string" || !isRecord(raw.payload)) {
      throw new Error(`Track 1 plan for ${label} has a malformed body: callback, scheduleType, and payload are required`);
    }
    return {
      label,
      requestBody: {
        callback: raw.callback,
        scheduleType: raw.scheduleType,
        payload: raw.payload,
        intervalSeconds: optionalNumber(raw.intervalSeconds),
        cron: optionalString(raw.cron),
      },
    };
  });
}

export async function recreateTrack1(): Promise<RecreateResultItem[]> {
  const plan = track1RecreatePlan();
  const results: RecreateResultItem[] = [];
  for (const item of plan) {
    try {
      const data = await postJson("/api/schedules/create", item.requestBody as unknown as Record<string, unknown>);
      if (!isRecord(data) || data.success !== true) {
        const message = isRecord(data) && typeof data.error === "string" ? data.error : "Create failed";
        results.push({ label: item.label, ok: false, error: message });
        continue;
      }
      const schedule = isRecord(data.schedule) ? data.schedule : undefined;
      results.push({
        label: item.label,
        ok: true,
        scheduleId: schedule ? optionalString(schedule.id) : undefined,
        duplicate: data.duplicate === true,
      });
    } catch (err) {
      results.push({ label: item.label, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/**
 * Issue #2489 — selective wipe API.
 *
 * SQL rows reuse the existing per-table routes (cancel-all for the
 * framework queue, clear-table for the rest, /clear purge for
 * messages). KV rows go through ONE aggregate route call (gate
 * checked once, safe order server-side, sessions last), because a
 * per-call gate re-check after the memberships row would 403 every
 * later row. mas_events needs the second confirmation (auditConfirm)
 * on top of confirm — enforced server-side, not just in the UI.
 */

export type SelectiveSqlRow =
  | "framework"
  | "mas_async_jobs"
  | "mas_job_outcomes"
  | "mas_job_outcomes_meta"
  | "mas_messages"
  | "mas_events"
  | "unified_schedules";

export type SelectiveKvRow =
  | "memberships"
  | "tokens"
  | "bindings"
  | "marker"
  | "sessions";

export interface KvWipeRowResult {
  row: string;
  count: number;
  coupled?: boolean;
  error?: string;
}

function parseKvWipeRows(data: unknown): KvWipeRowResult[] {
  if (!isRecord(data) || !Array.isArray(data.rows)) {
    throw new Error("Malformed KV wipe response: rows must be an array");
  }
  return data.rows.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Malformed KV wipe response: row must be an object");
    }
    return {
      row: requireString(item.row, "row"),
      count: requireNumber(item.count, "count"),
      coupled: optionalBoolean(item.coupled),
      error: optionalString(item.error),
    };
  });
}

export async function previewKvWipe(rows: SelectiveKvRow[]): Promise<KvWipeRowResult[]> {
  const data = await postJson("/api/maintenance/kv-wipe", { rows });
  return parseKvWipeRows(data);
}

export async function confirmKvWipe(rows: SelectiveKvRow[]): Promise<KvWipeRowResult[]> {
  const data = await postJson("/api/maintenance/kv-wipe", { rows, confirm: true });
  return parseKvWipeRows(data);
}

export async function confirmClearTableWithAudit(table: "mas_events"): Promise<ClearTableResult> {
  const data = await postJson("/api/maintenance/clear-table", {
    table,
    confirm: true,
    auditConfirm: true,
  });
  if (!isRecord(data) || data.confirmed !== true) {
    throw new Error("Malformed clear-table result: confirmed must be true");
  }
  return {
    table: requireString(data.table, "table"),
    scope: requireString(data.scope, "scope"),
    confirmed: true,
    deleted: requireNumber(data.deleted, "deleted"),
    skippedRunning: optionalNumber(data.skippedRunning),
  };
}

export interface AuditExport {
  count: number;
  truncated: boolean;
  events: Array<Record<string, unknown>>;
}

export async function exportAuditEvents(): Promise<AuditExport> {
  const response = await apiFetch("/api/maintenance/events-export");
  const data = await readJson(response);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  if (!isRecord(data) || !Array.isArray(data.events)) {
    throw new Error("Malformed audit export: events must be an array");
  }
  return {
    count: requireNumber(data.count, "count"),
    truncated: data.truncated === true,
    events: data.events.filter((e): e is Record<string, unknown> => isRecord(e)),
  };
}

export async function purgeSessionMessages(): Promise<void> {
  const response = await apiFetch("/api/clear?purge=true", { method: "POST" });
  const data = await readJson(response);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }
}
