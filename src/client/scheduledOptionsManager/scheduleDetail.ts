import type { StrategyProfile } from "../../trading";
import type { ScheduledTaskItem } from "./types";
import type { ScheduleProvenance } from "../../schedule";
import { scheduleSourceDisplay } from "../../config/scheduleSourceModes";
import { systemJobFor } from "./systemJobs";
import { cadenceText, formatNextRun, payloadOf } from "./format";
import { formatNoViewConstraints } from "./noView";

/**
 * One canonical model for a schedule's details (issue #2329).
 *
 * Before this module the schedule card built its own ad-hoc key/value
 * rows per kind, and the detail expansion built a second, different
 * set — the same fact appeared under three labels ("input model",
 * "Input model:", "Type:"). This model is the single source for both
 * the table row's one-line scope summary and the Details dialog, so
 * the row and the dialog cannot disagree, and every kind is described
 * with the same vocabulary.
 *
 * Consistency rule (pinned by tests/schedule_rows_2329.test.tsx): a
 * kind's scope fields are a subsequence of
 * SCHEDULE_SCOPE_LABEL_ORDER — a field is omitted when the schedule
 * genuinely has no value for it, never renamed or reordered.
 */

export type ScheduleKind = "options" | "stock" | "discovery" | "system";

export type ScheduleInputModel =
  | "Options analysis"
  | "Stock screen"
  | "Saved views"
  | "Profile-derived"
  | "No-view"
  | "System job";

export interface ScheduleDetailField {
  label: string;
  value: string;
  /** Render in the tabular/mono face (identifiers, cron, payload). */
  mono?: boolean;
}

export interface ScheduleDetailSection {
  id: "schedule" | "source" | "ownership" | "scope" | "delivery" | "views" | "constraints" | "run";
  title: string;
  fields: ScheduleDetailField[];
}

export interface ScheduleDetailModel {
  kind: ScheduleKind;
  kindLabel: string;
  /** Discovery only: which of the three input models the schedule uses. */
  modelLabel?: string;
  title: string;
  cadence: string;
  statusLabel: string;
  /** One-line summary for the table row's Scope cell. */
  scope: string;
  /** What this job does, stated by the job registry (never invented). */
  note?: string;
  sections: ScheduleDetailSection[];
  /** The stored payload as returned by the server record. */
  payload: unknown;
}

/** A stored screener preset, as listed for the schedule form — the
 *  detail resolves a schedule's presetId against this list. Only
 *  id, name and criteria are read here, so any compatible record
 *  (the shared listPresets helper's ScreenerPreset included) fits. */
export interface PresetRef {
  id: string;
  name: string;
  criteria?: Record<string, unknown>;
}

/** Canonical order of the Scope section's labels (see the module note). */
export const SCHEDULE_SCOPE_LABEL_ORDER = [
  "Input model",
  "Universe",
  "Symbols",
  "Watchlist",
  "Max items",
  "Sector",
  // Issue #3655 S4b: which preset arms a stock schedule — the preset
  // replaces the filters, so it sits directly before them.
  "Preset",
  "Filters",
  "Thesis",
  "Risk profile",
  "Profile",
] as const;

const DEFAULT_SLACK_CHANNEL_NOTE = "Configured (no channel recorded)";

export function scheduleKind(item: ScheduledTaskItem): ScheduleKind {
  if (item.callback === "autonomousOptionsAnalysis") return "options";
  if (item.callback === "autonomousMarketScreen") return "stock";
  if (item.callback === "autonomousStrategyDiscovery") return "discovery";
  // Every other callback is a system/maintenance job: it is described by
  // its own callback name, never dressed up as a screening kind.
  return "system";
}

function inputModelOf(item: ScheduledTaskItem): ScheduleInputModel {
  const payload = payloadOf(item);
  if (item.callback === "autonomousOptionsAnalysis") return "Options analysis";
  if (item.callback === "autonomousMarketScreen") return "Stock screen";
  if (item.callback === "autonomousStrategyDiscovery") {
    if (payload.inputModel === "profile-derived") return "Profile-derived";
    if (payload.inputModel === "no-view") return "No-view";
    return "Saved views";
  }
  return "System job";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function savedViewFields(item: ScheduledTaskItem): ScheduleDetailField[] {
  const requests = Array.isArray(payloadOf(item).requests) ? payloadOf(item).requests : [];
  return requests
    .filter((request: any) => request && typeof request === "object")
    .map((request: any) => {
      const symbol = typeof request.symbol === "string" ? request.symbol : "—";
      const thesis = typeof request.thesis === "string" ? request.thesis : "—";
      const target =
        typeof request.targetPrice === "number" ? `$${request.targetPrice}` : "no target";
      const date = typeof request.targetDate === "string" ? ` by ${request.targetDate}` : "";
      return { label: symbol, value: `${thesis} · ${target}${date}` };
    });
}

function constraintSetFields(item: ScheduledTaskItem): ScheduleDetailField[] {
  const sets = Array.isArray(payloadOf(item).constraintSets) ? payloadOf(item).constraintSets : [];
  return sets
    .filter((set: any) => set && typeof set === "object")
    .map((set: any) => ({
      label: typeof set.symbol === "string" ? set.symbol : "—",
      value: formatNoViewConstraints(set),
    }));
}

function filterText(filters: unknown): string | undefined {
  if (!filters || typeof filters !== "object") return undefined;
  const entries = Object.entries(filters as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== ""
  );
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => `${key} ${String(value)}`).join(" · ");
}

function profileText(item: ScheduledTaskItem, profiles: StrategyProfile[] | undefined): string {
  const payload = payloadOf(item);
  const profileId = typeof payload.profileId === "string" ? payload.profileId : "";
  const profile = profileId ? profiles?.find((p) => p.id === profileId) : undefined;
  if (profile) return `${profile.name} (v${profile.version})`;
  return profileId || "—";
}

function targetSymbols(item: ScheduledTaskItem): string[] {
  const payload = payloadOf(item);
  if (Array.isArray(payload.constraintSets)) {
    return payload.constraintSets
      .map((set: any) => (typeof set?.symbol === "string" ? set.symbol : ""))
      .filter(Boolean);
  }
  if (Array.isArray(payload.requests)) {
    return payload.requests
      .map((request: any) => (typeof request?.symbol === "string" ? request.symbol : ""))
      .filter(Boolean);
  }
  return strings(payload.symbols);
}

export function scheduleTitle(item: ScheduledTaskItem, _profiles?: StrategyProfile[]): string {
  if (item.callback === "autonomousStrategyDiscovery") {
    const model = payloadOf(item).inputModel;
    if (model === "no-view") return "Strategy Discovery · No-view";
    if (model === "profile-derived") return "Strategy Discovery · Profile-derived";
    return "Strategy Discovery";
  }
  // Issue #3121 #4238 — the daily IV history collection (#15) is an
  // internal-only job with no system-job registry entry (the registry
  // is deliberately the three screening jobs, and the manager pins
  // no trigger route for it); the Schedules home names it here, so
  // its row reads "Scheduled IV collection" instead of the raw
  // callback. The description lives with the callback (#15): one ATM
  // IV record per tracked name per day, never fabricated.
  if (item.callback === "collectIvHistory") return "Scheduled IV collection";
  // Issue #3121 #4239 — the daily token renewal is an internal-only
  // job with no system-job registry entry (the registry is
  // deliberately the three screening jobs); the Schedules home names
  // it here, so its row reads "Scheduled token renewal" instead of
  // the raw callback. The label is reused from workflowLifecycle.ts
  // ("Scheduled token renewal", family "other").
  if (item.callback === "autoRenewETradeTokens") return "Scheduled token renewal";
  // Issue #3121 #4240 — the nightly retention pass is an internal-only
  // job with no system-job registry entry (the registry is
  // deliberately the three screening jobs); the Schedules home names
  // it here, so its row reads "Scheduled retention pass" instead of
  // the raw callback.
  if (item.callback === "retention") return "Scheduled retention pass";
  // Issue #3121 #4241 — the nightly research run is an internal-only
  // job with no system-job registry entry (the registry is
  // deliberately the three screening jobs); the Schedules home names
  // it here, so its row reads "Scheduled nightly research run"
  // instead of the raw callback.
  if (item.callback === "nightly-research") return "Scheduled nightly research run";
  // Issue #3121 #4242 — the three maintenance duties are
  // internal-only jobs with no system-job registry entry (the
  // registry is deliberately the three screening jobs); the
  // Schedules home names them here, so their rows read by duty
  // instead of the raw callback.
  if (item.callback === "sweepStaleLedgerTasks") return "Scheduled stale-task sweep";
  if (item.callback === "sweepStaleAsyncJobs") return "Scheduled stale async-job sweep";
  if (item.callback === "watchdogMissedSchedules") return "Scheduled missed-schedule watchdog";
  return systemJobFor(item.callback)?.label || item.callback;
}

/**
 * The row's Scope cell: one short line naming what the schedule acts
 * on. Booleans and absent values are left out — a row states the
 * target, and the dialog explains the rest.
 *
 * Issue #3655 S4b: a stock row also names its preset — "Preset:
 * <name>" when the armed preset resolves, "Preset: <id> (no longer
 * exists)" when the id is gone, "Preset: <id>" when the preset list
 * is unavailable (the raw id, never an invented name), and "Custom
 * thresholds" when no preset is armed. Non-stock kinds are untouched.
 */
export function scheduleScope(
  item: ScheduledTaskItem,
  profiles?: StrategyProfile[],
  presets?: PresetRef[]
): string {
  const payload = payloadOf(item);
  const kind = scheduleKind(item);
  const symbols = targetSymbols(item);

  if (kind === "discovery") {
    const model = payload.inputModel;
    if (model === "no-view") {
      return symbols.length > 0 ? `No-view · ${symbols.join(", ")}` : "No-view";
    }
    if (model === "profile-derived") {
      const profile = profileText(item, profiles);
      const source =
        symbols.length > 0
          ? symbols.join(", ")
          : typeof payload.watchlistName === "string" && payload.watchlistName
            ? `watchlist ${payload.watchlistName}`
            : "no symbol source";
      return `${profile} · ${source}`;
    }
    const count = Array.isArray(payload.requests) ? payload.requests.length : 0;
    const summary = `${count} saved view${count === 1 ? "" : "s"}`;
    if (symbols.length === 0) return summary;
    const shown = symbols.slice(0, 4).join(", ");
    return `${summary} · ${shown}${symbols.length > 4 ? "…" : ""}`;
  }

  if (kind === "system") {
    if (symbols.length > 0) return symbols.join(", ");
    if (typeof payload.universe === "string" && payload.universe) return payload.universe;
    const scalars = Object.entries(payload)
      .filter(
        ([key, value]) =>
          !["userLogin", "environment", "env", "trigger"].includes(key) &&
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      )
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${String(value)}`);
    return scalars.length > 0 ? scalars.join(" · ") : "—";
  }

  const parts: string[] = [];
  if (symbols.length > 0) {
    parts.push(symbols.join(", "));
  } else if (typeof payload.universe === "string" && payload.universe) {
    parts.push(payload.universe);
  }
  if (typeof payload.sector === "string" && payload.sector && payload.sector !== "ALL") {
    parts.push(payload.sector);
  }
  // The scan cap qualifies a symbol list; on a universe row it would
  // just repeat what the run definition already states.
  if (symbols.length > 0 && typeof payload.maxItems === "number") {
    parts.push(`max ${payload.maxItems}`);
  }
  if (kind === "stock") {
    const presetId =
      typeof payload.presetId === "string" && payload.presetId ? payload.presetId : "";
    parts.push(presetId ? `Preset: ${presetValue(payload, presets)}` : "Custom thresholds");
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * Issue #3655 S4b: what a stock schedule screens on, in the row's
 * and the dialog's shared vocabulary. A preset-armed schedule names
 * its preset; a custom schedule states "Custom thresholds". The
 * preset name comes from the caller's preset list — a missing list
 * yields the raw id, never an invented name.
 */
function presetValue(payload: Record<string, any>, presets?: PresetRef[]): string {
  const presetId =
    typeof payload.presetId === "string" && payload.presetId ? payload.presetId : "";
  if (!presetId) return "Custom thresholds";
  const resolved = presets?.find((p) => p.id === presetId);
  if (resolved) return resolved.name;
  if (presets) return `${presetId} (no longer exists)`;
  return presetId;
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/**
 * Build the canonical detail model for one schedule. `detail` is the
 * server's own record from GET /api/schedules/:id — when present it
 * supplies the authoritative run definition and payload; the row data
 * is never presented as if it were the server record.
 */
export function buildScheduleDetail(
  item: ScheduledTaskItem,
  ctx: {
    profiles?: StrategyProfile[];
    activeEnv?: string;
    userLogin?: string;
    detail?: any | null;
    /** Issue #3655 S4b: the caller's stocks presets, for resolving a
     *  stock schedule's presetId to its name (and its current
     *  criteria). Absent, the Preset field falls back to the raw id. */
    presets?: PresetRef[];
  } = {}
): ScheduleDetailModel {
  const payload = payloadObject(item, ctx.detail);
  const kind = scheduleKind(item);
  const model = inputModelOf(item);
  const symbols = targetSymbols(item);
  const isDiscovery = kind === "discovery";

  const scheduleFields: ScheduleDetailField[] = [
    { label: "Schedule ID", value: item.id, mono: true },
    { label: "Job", value: scheduleTitle(item, ctx.profiles) },
    { label: "Callback", value: item.callback, mono: true },
    { label: "Cadence type", value: item.type },
    { label: "Cadence", value: cadenceText(item) },
    { label: "Status", value: item.paused ? "Paused" : "Active" },
    { label: "Next run", value: item.paused ? "—" : formatNextRun(ctx.detail ?? item) },
  ];
  if (item.createdAt) {
    const created = new Date(item.createdAt);
    scheduleFields.push({
      label: "Created",
      value: Number.isNaN(created.getTime()) ? item.createdAt : created.toLocaleString(),
    });
  }

  const ownershipFields: ScheduleDetailField[] = [
    {
      label: "Owner",
      value:
        typeof payload.userLogin === "string" && payload.userLogin
          ? payload.userLogin
          : ctx.userLogin || "—",
    },
    {
      label: "Environment",
      value:
        (typeof payload.environment === "string" && payload.environment) ||
        (typeof payload.env === "string" && payload.env) ||
        ctx.activeEnv ||
        "—",
    },
    // Issue #3655: broker + mode recorded on the schedule at creation.
    // Legacy payloads without them show "—" rather than a guessed value.
    {
      label: "Broker",
      value:
        typeof payload.brokerId === "string" && payload.brokerId
          ? payload.brokerId === "etrade"
            ? "E*TRADE"
            : payload.brokerId === "alpaca"
              ? "Alpaca"
              : payload.brokerId
          : "—",
    },
    {
      label: "Mode",
      value:
        typeof payload.mode === "string" && payload.mode
          ? payload.mode
          : "—",
    },
    { label: "Trigger", value: typeof payload.trigger === "string" ? payload.trigger : "scheduled" },
  ];

  const scopeByLabel: Record<string, string | undefined> = {
    "Input model": model,
    Universe: typeof payload.universe === "string" ? payload.universe : undefined,
    Symbols: symbols.length > 0 ? symbols.join(", ") : undefined,
    Watchlist:
      typeof payload.watchlistName === "string" && payload.watchlistName
        ? payload.watchlistName
        : undefined,
    "Max items": typeof payload.maxItems === "number" ? String(payload.maxItems) : undefined,
    Sector: typeof payload.sector === "string" ? payload.sector : undefined,
    // Issue #3655 S4b: which criteria/preset the schedule uses. A
    // preset-armed schedule carries presetId and no frozen filters
    // (#1499 — the run resolves the preset's CURRENT criteria at
    // fire time), so the Preset field names the preset and the
    // Filters field shows its current criteria — the criteria the
    // run will use. A custom schedule shows "Custom thresholds"
    // and its stored filters, as before. Stock kind only: no other
    // kind arms a preset.
    Preset: kind === "stock" ? presetValue(payload, ctx.presets) : undefined,
    Filters:
      kind === "stock" && typeof payload.presetId === "string" && payload.presetId
        ? filterText(ctx.presets?.find((p) => p.id === payload.presetId)?.criteria)
        : filterText(payload.filters),
    Thesis: typeof payload.thesis === "string" ? titleCase(payload.thesis) : undefined,
    "Risk profile": typeof payload.riskProfile === "string" ? payload.riskProfile : undefined,
    Profile: isDiscovery ? profileText(item, ctx.profiles) : undefined,
  };
  const scopeFields: ScheduleDetailField[] = SCHEDULE_SCOPE_LABEL_ORDER.flatMap((label) => {
    const value = scopeByLabel[label];
    return value === undefined ? [] : [{ label, value }];
  });

  // Issue #5889 — the Source section: the same source the list's
  // Source column shows (kind + job identity + arming origin), plus
  // the agent / workflow the row names and the creation record where
  // the row carries one. A row with no source reads Unknown / not
  // recorded — the dialog and the column can never disagree, because
  // both read the one display helper over the row's server source.
  const sourceDisplay = scheduleSourceDisplay(item);
  const sourceProvenance: ScheduleProvenance | undefined =
    item.provenance ??
    (payload.provenance &&
    typeof payload.provenance === "object" &&
    ["user", "system", "agent"].includes(
      (payload.provenance as Record<string, unknown>).origin as string,
    )
      ? (payload.provenance as ScheduleProvenance)
      : undefined);
  const sourceFields: ScheduleDetailField[] = [
    { label: "Source", value: sourceDisplay.label },
    { label: "Job", value: sourceDisplay.job, mono: true },
    { label: "Arming origin", value: sourceDisplay.origin },
    ...(sourceDisplay.agent ? [{ label: "Agent", value: sourceDisplay.agent, mono: true }] : []),
    ...(sourceDisplay.workflow
      ? [{ label: "Workflow", value: sourceDisplay.workflow, mono: true }]
      : []),
    ...(sourceProvenance?.createdBy
      ? [{ label: "Created by", value: sourceProvenance.createdBy }]
      : []),
  ];

  const deliveryFields: ScheduleDetailField[] = [
    {
      label: "Slack",
      value:
        payload.pushToSlack === true
          ? typeof payload.slackChannel === "string" && payload.slackChannel
            ? payload.slackChannel
            : DEFAULT_SLACK_CHANNEL_NOTE
          : "Not configured",
    },
    {
      label: "Email",
      value: typeof payload.emailTo === "string" && payload.emailTo ? payload.emailTo : "Not configured",
    },
    {
      label: "Webhook",
      value:
        typeof payload.webhookUrl === "string" && payload.webhookUrl
          ? payload.webhookUrl
          : "Not configured",
    },
  ];

  const sections: ScheduleDetailSection[] = [
    { id: "schedule", title: "Schedule", fields: scheduleFields },
    { id: "source", title: "Source", fields: sourceFields },
    { id: "ownership", title: "Ownership", fields: ownershipFields },
    { id: "scope", title: "Scope", fields: scopeFields },
    { id: "delivery", title: "Delivery", fields: deliveryFields },
  ];

  if (isDiscovery && model === "Saved views") {
    const fields = savedViewFields(item);
    if (fields.length > 0) sections.push({ id: "views", title: "Saved views", fields });
  }
  if (model === "No-view") {
    const fields = constraintSetFields(item);
    if (fields.length > 0) sections.push({ id: "constraints", title: "Constraint sets", fields });
  }

  const runFields: ScheduleDetailField[] = [];
  const detail = ctx.detail;
  if (detail && typeof detail === "object") {
    if (typeof detail.cron === "string" && detail.cron) {
      runFields.push({ label: "Cron (UTC)", value: detail.cron, mono: true });
    }
    if (typeof detail.intervalSeconds === "number") {
      runFields.push({ label: "Interval", value: `${detail.intervalSeconds}s` });
    }
    if (typeof detail.delayInSeconds === "number") {
      runFields.push({ label: "Delay", value: `${detail.delayInSeconds}s` });
    }
    if (typeof detail.date === "string" && detail.date) {
      runFields.push({ label: "Runs at", value: formatNextRun({ date: detail.date }) });
    }
  }
  if (runFields.length > 0) sections.push({ id: "run", title: "Run definition", fields: runFields });

  return {
    kind,
    kindLabel:
      kind === "options" ? "Options" : kind === "stock" ? "Stock" : kind === "discovery" ? "Discovery" : "System",
    modelLabel: isDiscovery ? model : undefined,
    title: scheduleTitle(item, ctx.profiles),
    cadence: cadenceText(item),
    statusLabel: item.paused ? "Paused" : "Active",
    scope: scheduleScope(item, ctx.profiles, ctx.presets),
    note: modelNote(item, model),
    sections,
    payload: detailPayload(item, ctx.detail),
  };
}

/** The server record's payload when loaded, otherwise the list row's. */
function detailPayload(item: ScheduledTaskItem, detail: any | null | undefined): unknown {
  if (detail && typeof detail === "object" && detail.payload && typeof detail.payload === "object") {
    return detail.payload;
  }
  return item.payload;
}

function payloadObject(item: ScheduledTaskItem, detail: any | null | undefined): Record<string, any> {
  const candidate = detailPayload(item, detail);
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, any>)
    : {};
}

/** The job's own statement of what it does — never composed here. */
function modelNote(item: ScheduledTaskItem, model: ScheduleInputModel): string | undefined {
  if (model === "No-view") {
    return "No view is stored on this schedule: it stores constraint sets only — no thesis, no target, and no view is set when it fires. When it runs, each symbol's live chain is ranked under its stored constraints (target-free no-view-v1 score model), and a symbol where nothing qualifies abstains, with the gate reasons recorded on the run.";
  }
  if (model === "Profile-derived") {
    return "Targets derived at run time: no target is stored on this schedule — each symbol's target is derived from its live chain under a saved Strategy Profile when the schedule fires, and a symbol whose target cannot be derived honestly abstains, with the reason recorded on the run.";
  }
  return systemJobFor(item.callback)?.description;
}
