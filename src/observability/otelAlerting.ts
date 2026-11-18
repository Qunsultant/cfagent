/**
 * Issue #5083 (S4, observability program #5080) — the one
 * error-reporting owner module + one alerting port.
 *
 * This is the single path every error report takes to reach a
 * human: Slack (SCREENER_SLACK_CHANNEL) AND email
 * (CHANNEL_EMAIL_PRINCIPALS) — both, every alert goes to both.
 * Alerts are notifications, never approval cards: an alert
 * never asks the recipient to approve anything, and no Block
 * Kit action is ever attached.
 *
 * The port CONSUMES logs/metrics/audit: it reads them to
 * enrich the alert (the report carries a trace id / run id /
 * context) and it records every alert through the structured
 * logger (src/observability/structuredLogger.ts). It does not
 * replace or duplicate them, and it writes no second store.
 *
 * S7 dependency (owner decision, option b): S4 builds ONLY the
 * owner module + port with PLACEHOLDER rules. The alert
 * rules/severities catalog lands with S7 (#5086). The port
 * accepts a severity + rule id from the caller but S4 does NOT
 * define the real rule/severity catalog — the values are
 * placeholders, clearly marked, to be replaced by S7. There is
 * no second catalog.
 *
 * Credentials: Slack (SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL) and
 * email (the EMAIL binding) come from GitHub secrets (Worker
 * secrets), never hardcoded, never in config files. The port
 * reads them from env only; no secret value ever appears in
 * code or config.
 *
 * Config (config/otel.json `alerting` + env, resolved through
 * src/config/otelModes.ts, run > session > user > env > file >
 * builtin): master enabled, Slack + email each individually
 * on/off, and the free-tier guard maxAlertsPerDay. An invalid
 * value fails closed to OFF with a coded OBS-1001 message.
 * The free-tier guard drops alerts past maxAlertsPerDay with
 * exactly one OBS-1016 per day.
 *
 * The three first consumers (owner decision: ALL wired first):
 * sweep alerts (#3784), the 70% SessionStore cap alert
 * (#1819), and CI failure alerts. Each routes through this
 * port; what triggers them does not change, only the delivery
 * path. #3765 S2 alerting is a consumer of this port, not a
 * parallel alerter.
 */
import {
  OTEL_FILE_CONFIG,
  resolveOtelAlertingSettings,
  type OtelScopeLevels,
} from "../config/otelModes";
import { parseEmailPrincipals } from "../security/emailPrincipals";
import {
  OBS_ALERTING_DESTINATION_MISSING,
  OBS_ALERTING_FREE_TIER_GUARD,
  OBS_ALERTING_SEND_FAILED,
  OBS_CONFIG_INVALID,
} from "./otelMessages";
import { createStructuredLogger, type StructuredLogger } from "./structuredLogger";
import { createObservabilitySink } from "./createObservabilityPorts";
import { createEmailSender } from "../services/cloudflareEmailSender";
import type { EmailSender } from "../services/emailSenderPorts";
import type { Env } from "../types";
import {
  fetchSlackPost,
  postSlackText,
  type SlackDeliveryEnv,
  type SlackPostFn,
} from "../agents/social/delivery";

/**
 * The alert source — the consumer that raised the report.
 * The three first consumers (owner decision) are sweep,
 * cap-alert, and ci-failure. Later consumers (e.g. #3765 S2)
 * add their own source value; the port routes them all the
 * same way.
 */
export type AlertSource = "sweep" | "cap-alert" | "ci-failure" | "other";

/**
 * PLACEHOLDER severity values (S4). S7 (#5086) defines the
 * real severity/rule catalog; until then the caller passes one
 * of these placeholders and the port marks the report as
 * placeholder-ruled (result.placeholderRules === true).
 */
export type AlertSeverityPlaceholder = "info" | "warning" | "error" | "critical";

/**
 * One alert report — the unit the port delivers.
 * severity + ruleId are PLACEHOLDERS in S4 (S7 replaces them
 * with the real catalog). ruleId MUST start with
 * "placeholder-" so a real rule id is never confused with a
 * placeholder.
 */
export interface AlertReport {
  /** Which consumer raised the report. */
  source: AlertSource;
  /** The coded message for this alert (e.g. OBS-1014). */
  code: string;
  /** PLACEHOLDER severity (S7 defines the real catalog). */
  severity: AlertSeverityPlaceholder;
  /** PLACEHOLDER rule id, "placeholder-<name>" (S7 replaces). */
  ruleId: string;
  /** The short title shown in the Slack text + email subject. */
  title: string;
  /** The alert body (plain text). */
  text: string;
  /** Optional trace id to link the alert to the OTel trace. */
  traceId?: string;
  /** Optional run id / job id to link the alert to the run. */
  runId?: string;
  /** Optional free-form context (links, workflow, counts). */
  context?: Record<string, string>;
}

/** The result of one channel leg (Slack or email). */
export interface AlertChannelResult {
  ok: boolean;
  /** How the channel delivered (Slack: webhook or bot token). */
  method?: "webhook" | "bot";
  /** The reason this leg did not deliver (or was skipped). */
  error?: string;
  /** The reason this leg was skipped (disabled / no destination). */
  skipped?: string;
  /** Email only: the addresses the email was sent to. */
  sentTo?: string[];
}

/** The result of one alert report. */
export interface AlertResult {
  /** True when at least one channel delivered the alert. */
  delivered: boolean;
  slack: AlertChannelResult;
  email: AlertChannelResult;
  /** The OBS code describing this result (the report code, or OBS-1014/1015/1016 on failure). */
  code: string;
  /** True: the severity + rule id are S4 placeholders (S7 defines the real catalog). */
  placeholderRules: boolean;
}

/** The alerting port: the single path an error report takes to reach a human. */
export interface AlertingPort {
  reportAlert(report: AlertReport): Promise<AlertResult>;
}

/** Dependencies the alerting port consumes (all injectable for tests). */
export interface AlertingPortDeps {
  /** The Worker env (secrets + config). */
  env: Env;
  /** Slack poster (defaults to the env-resolved poster). */
  slackPost?: SlackPostFn;
  /** Email sender (defaults to the env-resolved sender; null = unbound). */
  emailSender?: EmailSender | null;
  /** Structured logger (defaults to the env-resolved logger). */
  logger?: StructuredLogger;
  /** Scope levels for the alerting settings (run/session/user overrides). */
  scopeLevels?: {
    enabled?: OtelScopeLevels;
    slackEnabled?: OtelScopeLevels;
    emailEnabled?: OtelScopeLevels;
    maxAlertsPerDay?: OtelScopeLevels;
  };
}

/**
 * Creates the alerting port. The free-tier guard state is
 * module-level (shared across every port instance in the
 * isolate, keyed by UTC day + the resolved cap): a fresh port
 * per alert must NOT reset the guard, or a runaway alert
 * storm would never be capped. In production there is one
 * alerting config (one cap), so all ports share one bucket;
 * in tests, different caps are different buckets. The guard
 * counts alerts DELIVERED per UTC day; an alert past the cap
 * is dropped, not queued.
 */
const alertingGuard = new Map<string, { count: number; fired: boolean }>();

function alertingGuardKey(day: string, maxAlertsPerDay: number): string {
  return `${day}:${maxAlertsPerDay}`;
}

export function createAlertingPort(deps: AlertingPortDeps): AlertingPort {
  const { env } = deps;
  // The env-resolved defaults (Slack poster + email sender +
  // logger) are created lazily per alert so a missing binding
  // is evaluated at send time, not at port construction.
  const resolveSlackPost = (): SlackPostFn => deps.slackPost ?? fetchSlackPost;
  const resolveEmailSender = (): EmailSender | null =>
    deps.emailSender === undefined ? createEmailSender(env) : deps.emailSender;
  const resolveLogger = (): StructuredLogger =>
    deps.logger ??
    createStructuredLogger(createObservabilitySink(env), {
      component: "otel-alerting",
    });

  async function reportAlert(report: AlertReport): Promise<AlertResult> {
    const logger = resolveLogger();
    const file = OTEL_FILE_CONFIG.alerting;
    const { settings, invalid } = resolveOtelAlertingSettings({
      enabled: deps.scopeLevels?.enabled ?? { env: env.OTEL_ALERTING_ENABLED, file: file.enabled },
      slackEnabled:
        deps.scopeLevels?.slackEnabled ?? { env: env.OTEL_ALERTING_SLACK_ENABLED, file: file.slackEnabled },
      emailEnabled:
        deps.scopeLevels?.emailEnabled ?? { env: env.OTEL_ALERTING_EMAIL_ENABLED, file: file.emailEnabled },
      maxAlertsPerDay:
        deps.scopeLevels?.maxAlertsPerDay ?? {
          env: env.OTEL_ALERTING_MAX_ALERTS_PER_DAY,
          file: file.maxAlertsPerDay,
        },
    });
    if (invalid) {
      logger.warn("otel.alerting.config_invalid", {
        code: OBS_CONFIG_INVALID,
        source: report.source,
        ruleId: report.ruleId,
      });
    }

    const placeholderRules = report.ruleId.startsWith("placeholder-");

    // Master off (or invalid -> OFF) = no alert is sent to
    // either channel. The alert is recorded, never silently
    // dropped without a log line.
    if (!settings.enabled) {
      logger.info("otel.alerting.disabled", {
        code: report.code,
        source: report.source,
        ruleId: report.ruleId,
      });
      return {
        delivered: false,
        slack: { ok: false, skipped: "alerting disabled" },
        email: { ok: false, skipped: "alerting disabled" },
        code: report.code,
        placeholderRules,
      };
    }

    // Free-tier guard: drop alerts past maxAlertsPerDay, with
    // exactly one OBS-1016 per UTC day (per cap bucket).
    const day = new Date().toISOString().slice(0, 10);
    const guardKey = alertingGuardKey(day, settings.maxAlertsPerDay);
    const guard = alertingGuard.get(guardKey) ?? { count: 0, fired: false };
    if (guard.count >= settings.maxAlertsPerDay) {
      if (!guard.fired) {
        guard.fired = true;
        alertingGuard.set(guardKey, guard);
        logger.warn("otel.alerting.free_tier_guard", {
          code: OBS_ALERTING_FREE_TIER_GUARD,
          source: report.source,
          ruleId: report.ruleId,
          maxAlertsPerDay: String(settings.maxAlertsPerDay),
        });
      }
      return {
        delivered: false,
        slack: { ok: false, skipped: "free-tier guard (max alerts/day reached)" },
        email: { ok: false, skipped: "free-tier guard (max alerts/day reached)" },
        code: OBS_ALERTING_FREE_TIER_GUARD,
        placeholderRules,
      };
    }
    guard.count += 1;
    alertingGuard.set(guardKey, guard);

    // The alert text (plain text, never an approval card).
    const lines: string[] = [report.title, "", report.text];
    if (report.traceId) lines.push(`trace: ${report.traceId}`);
    if (report.runId) lines.push(`run: ${report.runId}`);
    if (report.context) {
      for (const [key, value] of Object.entries(report.context)) {
        lines.push(`${key}: ${value}`);
      }
    }
    const alertText = lines.join("\n");

    // Slack leg (SCREENER_SLACK_CHANNEL passed explicitly — the
    // owner decision; when it is unset postSlackText falls back
    // to the shared channel resolution). Credentials come from
    // Worker secrets (SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL).
    let slack: AlertChannelResult;
    if (!settings.slackEnabled) {
      slack = { ok: false, skipped: "slack channel disabled" };
    } else {
      try {
        const posted = await postSlackText({
          post: resolveSlackPost(),
          // Env carries non-string bindings, so it is not
          // assignable to SlackDeliveryEnv's string index
          // (same cast as server.ts); delivery reads only the
          // string Slack fields at runtime.
          env: env as unknown as SlackDeliveryEnv,
          text: alertText,
          channel: (env.SCREENER_SLACK_CHANNEL as string | undefined) ?? undefined,
        });
        if (posted.ok) {
          slack = { ok: true, method: posted.method };
        } else if (posted.noDestination) {
          slack = { ok: false, skipped: "no destination" };
        } else {
          slack = { ok: false, error: posted.error };
        }
      } catch (error) {
        slack = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // Email leg (CHANNEL_EMAIL_PRINCIPALS: the recipients are
    // the map keys; one email per principal).
    let email: AlertChannelResult;
    if (!settings.emailEnabled) {
      email = { ok: false, skipped: "email channel disabled" };
    } else {
      try {
        const sender = resolveEmailSender();
        const principals = parseEmailPrincipals(env as Env);
        const recipients = Object.keys(principals);
        if (!sender || recipients.length === 0) {
          email = { ok: false, skipped: "no email destination" };
        } else {
          const sentTo: string[] = [];
          let emailOk = false;
          for (const to of recipients) {
            const sent = await sender.send({
              to,
              subject: `[Alert] ${report.title}`,
              text: alertText,
              html: alertText
                .split("\n")
                .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
                .join(""),
            });
            if (sent) {
              emailOk = true;
              sentTo.push(to);
            }
          }
          email = emailOk
            ? { ok: true, sentTo }
            : { ok: false, error: "email send failed" };
        }
      } catch (error) {
        email = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    const delivered = slack.ok || email.ok;
    if (delivered) {
      logger.info("otel.alerting.sent", {
        code: report.code,
        source: report.source,
        ruleId: report.ruleId,
        slack: slack.ok ? "ok" : "failed",
        email: email.ok ? "ok" : "failed",
      });
      return { delivered: true, slack, email, code: report.code, placeholderRules };
    }

    // Nothing delivered. When neither channel has a
    // destination configured at all the coded message is
    // OBS-1015 (destination missing); when a channel was
    // configured but failed, it is OBS-1014 (send failed).
    // Both are logged; the port never throws.
    if (slack.skipped === "no destination" && email.skipped === "no email destination") {
      logger.warn("otel.alerting.destination_missing", {
        code: OBS_ALERTING_DESTINATION_MISSING,
        source: report.source,
        ruleId: report.ruleId,
      });
      return {
        delivered: false,
        slack,
        email,
        code: OBS_ALERTING_DESTINATION_MISSING,
        placeholderRules,
      };
    }
    logger.warn("otel.alerting.send_failed", {
      code: OBS_ALERTING_SEND_FAILED,
      source: report.source,
      ruleId: report.ruleId,
      slackError: slack.error ?? slack.skipped ?? "",
      emailError: email.error ?? email.skipped ?? "",
    });
    return {
      delivered: false,
      slack,
      email,
      code: OBS_ALERTING_SEND_FAILED,
      placeholderRules,
    };
  }

  return { reportAlert };
}

/** Escapes HTML in the email body (plain-text alert, never markup). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
