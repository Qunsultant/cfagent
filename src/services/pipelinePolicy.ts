/**
 * Pipeline policy (issue #1181, slice R1 of the #1173 screener trust
 * program; owner requirements 2026-10-23).
 *
 * One module owns the screener/report pipeline's operational policy:
 * how many times a failure is retried and with what exponential
 * backoff, which notifications fire on which channels for which
 * events, and the fetch timeout. Before this module the answers were
 * scattered and hardcoded per path — the E*TRADE acquisition retried
 * (hardcoded constants in liveScreener.ts), Yahoo never retried,
 * delivery had its own ad-hoc behavior, and notification coverage
 * depended on incidental config.
 *
 * Resolution precedence: code defaults < Worker env (`PIPELINE_*`)
 * < settings map (`pipeline.*` keys — the mas_settings pattern the
 * #277 gate uses, so an operator can tune policy without a deploy).
 * Invalid values are ignored with a log line — policy resolution
 * never throws and never blocks a run.
 */
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/pipelinePolicy",
});

export interface RetryPolicy {
  /** Total attempts including the first try (>= 1). */
  maxAttempts: number;
  /** Delay before the first retry; doubles per retry. */
  baseDelayMs: number;
  /** Backoff cap. */
  maxDelayMs: number;
  /** Symmetric jitter ratio (0..1): delay varies by ±ratio. */
  jitterRatio: number;
}

export type NotificationEvent =
  | "started"
  | "completed"
  | "partial"
  | "failed"
  | "blocked"
  | "held"
  | "delivered";

export interface NotificationPolicy {
  /** Master switch: false silences every pipeline notification. */
  enabled: boolean;
  slack: boolean;
  email: boolean;
  webhook: boolean;
  events: Record<NotificationEvent, boolean>;
}

export interface PipelinePolicy {
  retry: {
    /** Quote/chain/listings acquisition fetches (all providers). */
    acquisition: RetryPolicy;
    /** Email/Slack/webhook delivery attempts. */
    delivery: RetryPolicy;
    /** Report (PDF/XLSX) generation attempts. */
    report: RetryPolicy;
  };
  notifications: NotificationPolicy;
  /** Per-fetch timeout budget for provider calls. */
  fetchTimeoutMs: number;
}

export const DEFAULT_PIPELINE_POLICY: PipelinePolicy = {
  retry: {
    acquisition: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000, jitterRatio: 0.25 },
    delivery: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.25 },
    report: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 4_000, jitterRatio: 0.25 },
  },
  notifications: {
    enabled: true,
    slack: true,
    email: true,
    webhook: true,
    events: {
      started: true,
      completed: true,
      partial: true,
      failed: true,
      blocked: true,
      held: true,
      delivered: true,
    },
  },
  fetchTimeoutMs: 15_000,
};

const ATTEMPTS_MIN = 1;
const ATTEMPTS_MAX = 10;
const DELAY_MIN_MS = 0;
const DELAY_MAX_MS = 120_000;

function parseIntClamped(
  raw: string | undefined,
  min: number,
  max: number,
  label: string
): number | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    structuredLog.warn("pipeline_policy.ignoring_non_numeric", {
      message: `[pipelinePolicy] ignoring non-numeric ${label}: ${String(raw).slice(0, 40)}`,
      label,
      raw: String(raw).slice(0, 40),
    });
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseBool(raw: string | undefined, label: string): boolean | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  structuredLog.warn("pipeline_policy.ignoring_unrecognized_boolean", {
    message: `[pipelinePolicy] ignoring unrecognized boolean ${label}: ${String(raw).slice(0, 40)}`,
    label,
    raw: String(raw).slice(0, 40),
  });
  return undefined;
}

function parseEvents(
  raw: string | undefined
): Partial<Record<NotificationEvent, boolean>> | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const known: NotificationEvent[] = ["started", "completed", "partial", "failed", "blocked", "held", "delivered"];
  const out: Partial<Record<NotificationEvent, boolean>> = {};
  // A list sets exactly the named events ON and all others OFF
  // ("failed,blocked" = only failures and blocks notify). Prefix an
  // event with "-" to turn just it off ("-delivered").
  const tokens = String(raw).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const hasPositive = tokens.some((t) => !t.startsWith("-"));
  if (hasPositive) for (const e of known) out[e] = false;
  for (const t of tokens) {
    const off = t.startsWith("-");
    const name = (off ? t.slice(1) : t) as NotificationEvent;
    if (!known.includes(name)) {
      structuredLog.warn("pipeline_policy.ignoring_unknown_event", {
        message: `[pipelinePolicy] ignoring unknown notification event: ${t.slice(0, 40)}`,
        event: t.slice(0, 40),
      });
      continue;
    }
    out[name] = !off;
  }
  return out;
}

/**
 * Resolve the effective policy. `env` is any string-valued record
 * (Worker env bindings read as strings); `settings` is the
 * operator-settings map (mas_settings values under `pipeline.*`).
 */
export function resolvePipelinePolicy(
  env?: Record<string, unknown>,
  settings?: Record<string, string | undefined>
): PipelinePolicy {
  const e = (key: string): string | undefined => {
    const v = env?.[key];
    return v === undefined || v === null ? undefined : String(v);
  };
  const s = (key: string): string | undefined => settings?.[key];

  const retryFor = (
    base: RetryPolicy,
    envPrefix: string,
    settingsPrefix: string,
    sharedAttempts: string | undefined,
    sharedBase: string | undefined,
    sharedMax: string | undefined
  ): RetryPolicy => {
    const attempts =
      parseIntClamped(s(`${settingsPrefix}.attempts`) ?? e(`${envPrefix}_ATTEMPTS`) ?? sharedAttempts, ATTEMPTS_MIN, ATTEMPTS_MAX, `${envPrefix}_ATTEMPTS`) ??
      base.maxAttempts;
    const baseDelay =
      parseIntClamped(s(`${settingsPrefix}.baseDelayMs`) ?? e(`${envPrefix}_BASE_DELAY_MS`) ?? sharedBase, DELAY_MIN_MS, DELAY_MAX_MS, `${envPrefix}_BASE_DELAY_MS`) ??
      base.baseDelayMs;
    const maxDelay =
      parseIntClamped(s(`${settingsPrefix}.maxDelayMs`) ?? e(`${envPrefix}_MAX_DELAY_MS`) ?? sharedMax, DELAY_MIN_MS, DELAY_MAX_MS, `${envPrefix}_MAX_DELAY_MS`) ??
      base.maxDelayMs;
    return {
      maxAttempts: attempts,
      baseDelayMs: baseDelay,
      maxDelayMs: Math.max(maxDelay, baseDelay),
      jitterRatio: base.jitterRatio,
    };
  };

  const d = DEFAULT_PIPELINE_POLICY;
  const retry = {
    acquisition: retryFor(
      d.retry.acquisition,
      "PIPELINE_ACQUISITION_RETRY",
      "pipeline.retry.acquisition",
      s("pipeline.retry.attempts") ?? e("PIPELINE_RETRY_ATTEMPTS"),
      s("pipeline.retry.baseDelayMs") ?? e("PIPELINE_RETRY_BASE_DELAY_MS"),
      s("pipeline.retry.maxDelayMs") ?? e("PIPELINE_RETRY_MAX_DELAY_MS")
    ),
    delivery: retryFor(
      d.retry.delivery,
      "PIPELINE_DELIVERY_RETRY",
      "pipeline.retry.delivery",
      s("pipeline.retry.attempts") ?? e("PIPELINE_RETRY_ATTEMPTS"),
      s("pipeline.retry.baseDelayMs") ?? e("PIPELINE_RETRY_BASE_DELAY_MS"),
      s("pipeline.retry.maxDelayMs") ?? e("PIPELINE_RETRY_MAX_DELAY_MS")
    ),
    report: retryFor(
      d.retry.report,
      "PIPELINE_REPORT_RETRY",
      "pipeline.retry.report",
      s("pipeline.retry.attempts") ?? e("PIPELINE_RETRY_ATTEMPTS"),
      s("pipeline.retry.baseDelayMs") ?? e("PIPELINE_RETRY_BASE_DELAY_MS"),
      s("pipeline.retry.maxDelayMs") ?? e("PIPELINE_RETRY_MAX_DELAY_MS")
    ),
  };

  const eventsOverride =
    parseEvents(s("pipeline.notify.events") ?? e("PIPELINE_NOTIFY_EVENTS")) ?? {};
  const notifications: NotificationPolicy = {
    enabled:
      parseBool(s("pipeline.notifications.enabled") ?? e("PIPELINE_NOTIFICATIONS"), "PIPELINE_NOTIFICATIONS") ??
      d.notifications.enabled,
    slack:
      parseBool(s("pipeline.notify.slack") ?? e("PIPELINE_NOTIFY_SLACK"), "PIPELINE_NOTIFY_SLACK") ??
      d.notifications.slack,
    email:
      parseBool(s("pipeline.notify.email") ?? e("PIPELINE_NOTIFY_EMAIL"), "PIPELINE_NOTIFY_EMAIL") ??
      d.notifications.email,
    webhook:
      parseBool(s("pipeline.notify.webhook") ?? e("PIPELINE_NOTIFY_WEBHOOK"), "PIPELINE_NOTIFY_WEBHOOK") ??
      d.notifications.webhook,
    events: { ...d.notifications.events, ...eventsOverride },
  };

  const fetchTimeoutMs =
    parseIntClamped(s("pipeline.fetchTimeoutMs") ?? e("PIPELINE_FETCH_TIMEOUT_MS"), 1_000, 120_000, "PIPELINE_FETCH_TIMEOUT_MS") ??
    d.fetchTimeoutMs;

  return { retry, notifications, fetchTimeoutMs };
}

/** Should a notification for `event` go out on `channel` at all? */
export function shouldNotify(
  policy: PipelinePolicy,
  event: NotificationEvent,
  channel: "slack" | "email" | "webhook"
): boolean {
  const n = policy.notifications;
  return n.enabled && n[channel] && n.events[event];
}
