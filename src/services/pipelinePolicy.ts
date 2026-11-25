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
  /**
   * Issue #6551 — the bound a `wait.event` stage waits under when the job
   * declares none. A durable wait with no bound inherits the platform's 24h
   * maximum, which is a live instance by default: the cost direction
   * (2026-11-25) forbids that shape, so the default is a configured bound and
   * expiry stays the declared outcome #3955 defined.
   */
  waitDefaultTimeoutMs: number;
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
  waitDefaultTimeoutMs: 3_600_000,
};

const ATTEMPTS_MIN = 1;
const ATTEMPTS_MAX = 10;
const DELAY_MIN_MS = 0;
const DELAY_MAX_MS = 120_000;
/** Issue #6551 — a wait bound is clamped to the platform's own maximum (365d is the API ceiling; 24h is the default a bound replaces). */
const WAIT_TIMEOUT_MIN_MS = 1_000;
const WAIT_TIMEOUT_MAX_MS = 86_400_000;
const JITTER_MIN = 0;
const JITTER_MAX = 1;

/**
 * Issue #4782 S3 — the resolver's defaults as stored-setting
 * strings, for the settings route + UI: a field with no stored
 * value renders this. Derived from
 * {@link DEFAULT_PIPELINE_POLICY} — never a second literal set,
 * so a default change lands in the UI with no edit here. The
 * shared `pipeline.retry.*` keys carry no default of their own
 * (they only override per-bucket values when set), so they are
 * absent from this record by construction.
 */
export const PIPELINE_POLICY_DEFAULTS: Record<string, string> = {
  "pipeline.retry.acquisition.attempts": String(DEFAULT_PIPELINE_POLICY.retry.acquisition.maxAttempts),
  "pipeline.retry.acquisition.baseDelayMs": String(DEFAULT_PIPELINE_POLICY.retry.acquisition.baseDelayMs),
  "pipeline.retry.acquisition.maxDelayMs": String(DEFAULT_PIPELINE_POLICY.retry.acquisition.maxDelayMs),
  "pipeline.retry.acquisition.jitterRatio": String(DEFAULT_PIPELINE_POLICY.retry.acquisition.jitterRatio),
  "pipeline.retry.delivery.attempts": String(DEFAULT_PIPELINE_POLICY.retry.delivery.maxAttempts),
  "pipeline.retry.delivery.baseDelayMs": String(DEFAULT_PIPELINE_POLICY.retry.delivery.baseDelayMs),
  "pipeline.retry.delivery.maxDelayMs": String(DEFAULT_PIPELINE_POLICY.retry.delivery.maxDelayMs),
  "pipeline.retry.delivery.jitterRatio": String(DEFAULT_PIPELINE_POLICY.retry.delivery.jitterRatio),
  "pipeline.retry.report.attempts": String(DEFAULT_PIPELINE_POLICY.retry.report.maxAttempts),
  "pipeline.retry.report.baseDelayMs": String(DEFAULT_PIPELINE_POLICY.retry.report.baseDelayMs),
  "pipeline.retry.report.maxDelayMs": String(DEFAULT_PIPELINE_POLICY.retry.report.maxDelayMs),
  "pipeline.retry.report.jitterRatio": String(DEFAULT_PIPELINE_POLICY.retry.report.jitterRatio),
  "pipeline.notifications.enabled": DEFAULT_PIPELINE_POLICY.notifications.enabled ? "1" : "0",
  "pipeline.notify.slack": DEFAULT_PIPELINE_POLICY.notifications.slack ? "1" : "0",
  "pipeline.notify.email": DEFAULT_PIPELINE_POLICY.notifications.email ? "1" : "0",
  "pipeline.notify.webhook": DEFAULT_PIPELINE_POLICY.notifications.webhook ? "1" : "0",
  "pipeline.notify.events": (Object.keys(DEFAULT_PIPELINE_POLICY.notifications.events) as NotificationEvent[])
    .filter((event) => DEFAULT_PIPELINE_POLICY.notifications.events[event])
    .join(","),
  "pipeline.fetchTimeoutMs": String(DEFAULT_PIPELINE_POLICY.fetchTimeoutMs),
  "pipeline.waitDefaultTimeoutMs": String(DEFAULT_PIPELINE_POLICY.waitDefaultTimeoutMs),
};

/**
 * Issue #4781 S2 — the retry-bucket names: the single source for
 * which buckets exist. Derived from the policy's own retry table
 * (whose keys are fixed by the `PipelinePolicy` interface — env
 * and settings only tune the values, never the keys), never a
 * second list. The define route, the binder, the resolver, and
 * the engine all validate against these names.
 */
export const RETRY_BUCKET_NAMES: ReadonlyArray<keyof PipelinePolicy["retry"]> =
  Object.keys(DEFAULT_PIPELINE_POLICY.retry) as Array<keyof PipelinePolicy["retry"]>;

/** Issue #4781 S2 — membership in the policy's retry keys. */
export function isRetryBucketName(value: unknown): value is keyof PipelinePolicy["retry"] {
  return (
    typeof value === "string" &&
    (RETRY_BUCKET_NAMES as ReadonlyArray<string>).includes(value)
  );
}

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

/**
 * Issue #4782 S3 — the float parser the retry fields were missing:
 * jitterRatio is a 0..1 ratio, not an int. Same contract as
 * parseIntClamped: blank/missing → undefined, non-numeric → warn
 * + undefined, out of range → clamped. Never throws.
 */
function parseFloatClamped(
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
  return Math.min(max, Math.max(min, n));
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
 * Issue #6278 — the one resolution of the per-fetch timeout
 * budget: the operator setting wins, then the Worker env knob,
 * then the recorded default. The market-data provider reads the
 * same value (env-only — it carries no tenant settings) for the
 * per-request AbortSignal.timeout in throttledFetch, so the
 * provider and the policy can never disagree about the bound.
 * Never a second literal set: the clamp and the default live
 * here and in DEFAULT_PIPELINE_POLICY only.
 */
export function resolveFetchTimeoutMs(
  envValue: string | undefined,
  settingsValue?: string | undefined,
): number {
  return (
    parseIntClamped(
      settingsValue ?? envValue,
      1_000,
      120_000,
      "PIPELINE_FETCH_TIMEOUT_MS",
    ) ?? DEFAULT_PIPELINE_POLICY.fetchTimeoutMs
  );
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
    sharedMax: string | undefined,
    sharedJitter: string | undefined
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
    // Issue #4782 S3 — jitterRatio is overridable like the other
    // retry values (per-bucket, then shared), float clamped 0..1.
    const jitterRatio =
      parseFloatClamped(s(`${settingsPrefix}.jitterRatio`) ?? e(`${envPrefix}_JITTER_RATIO`) ?? sharedJitter, JITTER_MIN, JITTER_MAX, `${envPrefix}_JITTER_RATIO`) ??
      base.jitterRatio;
    return {
      maxAttempts: attempts,
      baseDelayMs: baseDelay,
      maxDelayMs: Math.max(maxDelay, baseDelay),
      jitterRatio,
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
      s("pipeline.retry.maxDelayMs") ?? e("PIPELINE_RETRY_MAX_DELAY_MS"),
      s("pipeline.retry.jitterRatio") ?? e("PIPELINE_RETRY_JITTER_RATIO")
    ),
    delivery: retryFor(
      d.retry.delivery,
      "PIPELINE_DELIVERY_RETRY",
      "pipeline.retry.delivery",
      s("pipeline.retry.attempts") ?? e("PIPELINE_RETRY_ATTEMPTS"),
      s("pipeline.retry.baseDelayMs") ?? e("PIPELINE_RETRY_BASE_DELAY_MS"),
      s("pipeline.retry.maxDelayMs") ?? e("PIPELINE_RETRY_MAX_DELAY_MS"),
      s("pipeline.retry.jitterRatio") ?? e("PIPELINE_RETRY_JITTER_RATIO")
    ),
    report: retryFor(
      d.retry.report,
      "PIPELINE_REPORT_RETRY",
      "pipeline.retry.report",
      s("pipeline.retry.attempts") ?? e("PIPELINE_RETRY_ATTEMPTS"),
      s("pipeline.retry.baseDelayMs") ?? e("PIPELINE_RETRY_BASE_DELAY_MS"),
      s("pipeline.retry.maxDelayMs") ?? e("PIPELINE_RETRY_MAX_DELAY_MS"),
      s("pipeline.retry.jitterRatio") ?? e("PIPELINE_RETRY_JITTER_RATIO")
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

  const fetchTimeoutMs = resolveFetchTimeoutMs(
    e("PIPELINE_FETCH_TIMEOUT_MS"),
    s("pipeline.fetchTimeoutMs"),
  );

  // Issue #6551 — the durable-wait bound, resolved here with every other
  // pipeline knob (settings beat env, both beat the default) so a host never
  // invents its own. Clamped to the platform's own wait ceiling.
  const waitDefaultTimeoutMs =
    parseIntClamped(
      s("pipeline.waitDefaultTimeoutMs") ?? e("PIPELINE_WAIT_DEFAULT_TIMEOUT_MS"),
      WAIT_TIMEOUT_MIN_MS,
      WAIT_TIMEOUT_MAX_MS,
      "PIPELINE_WAIT_DEFAULT_TIMEOUT_MS",
    ) ?? DEFAULT_PIPELINE_POLICY.waitDefaultTimeoutMs;

  return { retry, notifications, fetchTimeoutMs, waitDefaultTimeoutMs };
}

/**
 * Issue #4782 S3 — every `pipeline.*` key the resolver reads, in
 * one list. The single source for which settings exist: the
 * settings reader, the settings route's validation, and the UI
 * all enumerate these keys — never a second list.
 */
export const PIPELINE_POLICY_SETTING_KEYS: ReadonlyArray<string> = [
  "pipeline.retry.attempts",
  "pipeline.retry.baseDelayMs",
  "pipeline.retry.maxDelayMs",
  "pipeline.retry.jitterRatio",
  "pipeline.retry.acquisition.attempts",
  "pipeline.retry.acquisition.baseDelayMs",
  "pipeline.retry.acquisition.maxDelayMs",
  "pipeline.retry.acquisition.jitterRatio",
  "pipeline.retry.delivery.attempts",
  "pipeline.retry.delivery.baseDelayMs",
  "pipeline.retry.delivery.maxDelayMs",
  "pipeline.retry.delivery.jitterRatio",
  "pipeline.retry.report.attempts",
  "pipeline.retry.report.baseDelayMs",
  "pipeline.retry.report.maxDelayMs",
  "pipeline.retry.report.jitterRatio",
  "pipeline.notifications.enabled",
  "pipeline.notify.slack",
  "pipeline.notify.email",
  "pipeline.notify.webhook",
  "pipeline.notify.events",
  "pipeline.fetchTimeoutMs",
];

/**
 * Issue #4782 S3 — build the settings map the resolver takes from
 * any per-tenant settings reader (the orchestrator's
 * `readSettingRaw` over mas_settings). Only keys the resolver
 * reads are ever asked for, and only non-null values are carried —
 * an absent key stays env-only, never an empty string.
 */
export function readPipelineSettings(
  read: (key: string) => string | null,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of PIPELINE_POLICY_SETTING_KEYS) {
    const value = read(key);
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Issue #4782 S3 — validate one settings write by name, for the
 * settings route (and any other writer). Returns an error message
 * or null when the value is acceptable. Refused by name, never
 * clamped: a write that reads back differently from what the
 * operator asked for is a lie, so out-of-range values are errors
 * here even though the resolver clamps them at read time.
 */
export function validatePipelinePolicySetting(key: string, value: string): string | null {
  if (!PIPELINE_POLICY_SETTING_KEYS.includes(key)) return `unknown pipeline setting: ${key}`;
  const v = String(value).trim();
  if (v === "") return `${key} must not be empty`;
  if (key.endsWith(".attempts")) {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return `${key} must be a whole number`;
    if (n < ATTEMPTS_MIN || n > ATTEMPTS_MAX) return `${key} must be ${ATTEMPTS_MIN}..${ATTEMPTS_MAX}`;
    return null;
  }
  if (key.endsWith(".baseDelayMs") || key.endsWith(".maxDelayMs")) {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return `${key} must be a whole number of milliseconds`;
    if (n < DELAY_MIN_MS || n > DELAY_MAX_MS) return `${key} must be ${DELAY_MIN_MS}..${DELAY_MAX_MS}`;
    return null;
  }
  if (key.endsWith(".jitterRatio")) {
    const n = Number(v);
    if (!Number.isFinite(n)) return `${key} must be a number`;
    if (n < JITTER_MIN || n > JITTER_MAX) return `${key} must be ${JITTER_MIN}..${JITTER_MAX}`;
    return null;
  }
  if (key === "pipeline.fetchTimeoutMs") {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return `${key} must be a whole number of milliseconds`;
    if (n < 1_000 || n > 120_000) return `${key} must be 1000..120000`;
    return null;
  }
  if (key === "pipeline.notify.events") {
    const known: NotificationEvent[] = ["started", "completed", "partial", "failed", "blocked", "held", "delivered"];
    for (const token of v.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)) {
      const name = token.startsWith("-") ? token.slice(1) : token;
      if (!known.includes(name as NotificationEvent)) return `${key} has unknown event: ${token}`;
    }
    return null;
  }
  // The boolean toggles: notifications.enabled, notify.slack/email/webhook.
  if (!["1", "true", "on", "yes", "0", "false", "off", "no"].includes(v.toLowerCase())) {
    return `${key} must be true or false`;
  }
  return null;
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
