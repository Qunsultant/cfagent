import type { ScheduledTaskItem } from "./types";

/** Frequency presets shared by the inline frequency editors (the
 *  generic cards in SchedulesPanel and the screening cards here) —
 *  one definition site since S7 merged the two schedule UIs;
 *  SchedulesPanel re-exports this as FREQUENCY_PRESETS. */
export const FREQUENCY_PRESETS: {
  id: string;
  label: string;
  body: { scheduleType: "interval" | "cron"; intervalSeconds?: number; cron?: string };
}[] = [
  { id: "5m", label: "5m", body: { scheduleType: "interval", intervalSeconds: 300 } },
  { id: "15m", label: "15m", body: { scheduleType: "interval", intervalSeconds: 900 } },
  { id: "30m", label: "30m", body: { scheduleType: "interval", intervalSeconds: 1800 } },
  { id: "hourly", label: "Hourly", body: { scheduleType: "cron", cron: "0 * * * *" } },
  { id: "2h", label: "2h", body: { scheduleType: "interval", intervalSeconds: 7200 } },
  { id: "daily", label: "Daily", body: { scheduleType: "cron", cron: "0 13 * * *" } },
];

export const INTERVAL_PRESETS = [
  { label: "Every 15 min", seconds: 900 },
  { label: "Every 30 min", seconds: 1800 },
  { label: "Every 1 hour", seconds: 3600 },
  { label: "Every 4 hours", seconds: 14400 },
];

// Presets are Eastern-Time intents: picking one converts the ET time to
// a UTC cron for the current ET offset (see ./cronTime). The cron string
// is computed at pick time, never stored here as a literal — a literal
// would fire 4-5 hours early, as the previous hard-coded values did.
export const CRON_PRESETS = [
  { label: "Market Open (9:30 AM ET M-F)", etHour: 9, etMinute: 30, daysOfWeek: "1-5" },
  { label: "Midday Scan (12:00 PM ET M-F)", etHour: 12, etMinute: 0, daysOfWeek: "1-5" },
  { label: "Market Close (4:00 PM ET M-F)", etHour: 16, etMinute: 0, daysOfWeek: "1-5" },
  { label: "Daily Overnight (11:00 PM ET)", etHour: 23, etMinute: 0, daysOfWeek: "*" },
];

/**
 * Issue #4353 — a history row's timestamp, DATE AND TIME (the owner's ask:
 * "Execution History & Audit Trail must contain datetimestamp"). One format
 * for every audit row, and a missing/unparseable value says so instead of
 * rendering "Invalid Date" or today's date.
 */
export function formatAuditTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "not recorded";
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The payload object of a schedule, or {} when absent/malformed. */
export function payloadOf(item: ScheduledTaskItem): Record<string, any> {
  const p = item?.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? p : {};
}

/** Faithful one-line rendering of an arbitrary payload value. */
export function formatPayloadValue(value: any): string {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((v) => String(v)).join(", ") : "—";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Next-run display from an SDK Schedule object (detail or list row). */
export function formatNextRun(schedule: any): string {
  const t = schedule?.time;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) {
    const d = new Date(t * 1000);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  if (typeof schedule?.nextRun === "string" && schedule.nextRun) return schedule.nextRun;
  if (typeof schedule?.date === "string" && schedule.date) {
    const d = new Date(schedule.date);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return "—";
}

export function cadenceText(item: ScheduledTaskItem): string {
  if (item.intervalSeconds) return `Every ${Math.round(item.intervalSeconds / 60)} min`;
  if (item.cron) return `Cron: ${item.cron}`;
  if (item.type === "delayed" && item.delayInSeconds) return `Once, after ${item.delayInSeconds}s`;
  if (item.type === "scheduled" && item.date) {
    const d = new Date(item.date);
    return Number.isNaN(d.getTime()) ? "One-shot (date)" : `Once at ${d.toLocaleString()}`;
  }
  return "Scheduled Timer";
}
