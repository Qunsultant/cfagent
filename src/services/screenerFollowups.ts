/**
 * Issue #1123: the screener follow-up pipeline — one harmonized path by
 * which EVERY completed screener (stock or options) schedules its
 * follow-up work as tracked sub-jobs of the main job: report generation
 * (S2), channel deliveries (S3), lifecycle notifications (S4).
 *
 * This module is the pure core: the typed config, the run-outcome
 * record, the http-job adapter that recognizes screener completions, and
 * the planner that turns an outcome into sub-job specs. Execution lives
 * in the async-job executor (src/agents/orchestrator/asyncJobs.ts),
 * which owns the job store; spawn points beyond the job executor (bus
 * sources) join in S5.
 *
 * Assessment alignment (docs/Assessment.md): email recipients are
 * allowlisted (cross-channel exfiltration), generation runs on the job
 * queue (CPU-heavy work off the request path), and every transition is
 * audited by the executor into mas_events.
 */

import type { AsyncJobChannel, AsyncJobSubmission, StageChainConfig } from "../types";
import type { OptionsPartialQualification } from "../trading";
import {
  formatTraceBlock,
  type ScreenerTrace,
} from "./screenerTrace";
import { codedMessage } from "../outcomes/outcomeAspects";
import {
  absoluteReportUrl,
  optionsReportUrl,
  screenerReportUrl,
} from "./screenerReportUrl";

/** Consolidation C4 (#1329): discovery + goal runs join the bridge, so
 *  the outcome kind covers them too. kindLabel (below) names each. */
export type ScreenerKind = "stock" | "options" | "discovery" | "goal";

export function screenerKindLabel(kind: ScreenerKind): string {
  switch (kind) {
    case "stock":
      return "Stock";
    case "options":
      return "Options";
    case "discovery":
      return "Discovery";
    case "goal":
      return "Goal";
  }
}

/**
 * Consolidation #1236 (discovery notifications): the email subject
 * for a followup delivery. Stock/options/goal keep exactly today's
 * subjects (goal still renders "Options", as the port's else branch
 * always did — this PR does not change goal behavior); discovery
 * renders "Discovery" instead of inheriting the "Options" fallback.
 */
export function followupDeliveryEmailSubject(outcome: ScreenerRunOutcome): string {
  const kindLabel = outcome.kind === "stock"
    ? "Stock"
    : outcome.kind === "discovery"
      ? "Discovery"
      : "Options";
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  return `📊 ${kindLabel} Screen${scope ? ` [${scope}]` : ""} — ${outcome.matchedCount ?? "?"} matched`;
}

/** One standout opportunity, as carried for delivery content (S3). */
export interface ScreenerOutcomeOpportunity {
  symbol: string;
  companyName?: string;
  signal?: string;
  momentumScore?: number;
  lastPrice?: number;
  changePercent?: number;
}

/** The canonical record of a finished screener run, from any source. */
export interface ScreenerRunOutcome {
  kind: ScreenerKind;
  trigger: "manual" | "scheduled";
  success: boolean;
  /** Stored report artifact keys (one per universe for sharded runs). */
  pdfKeys: string[];
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  /** Issue #1191 (#1173 R3): the run's XLSX artifact, carried so
   *  deliveries attach text + PDF + XLSX (the pre-R3 outcome dropped
   *  it, which is why XLSX never reached email/Slack). */
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  /** Issue #1346: the run's CSV artifact, carried so the serve
   *  stage adopts it and deliveries attach text + PDF + XLSX + CSV. */
  csvKey?: string;
  csvStatus?: "generated" | "failed" | "skipped";
  csvError?: string;
  reportUrl?: string;
  matchedCount?: number;
  totalScanned?: number;
  universe?: string;
  thesis?: string;
  summary?: string;
  /** Top opportunities for delivery content (stock screens). */
  opportunities?: ScreenerOutcomeOpportunity[];
  /**
   * Issue #1527: whole-run fallback marker, carried from the event /
   * run result so the report body records the fallback.
   */
  providerFallback?: { from: string; reason: string };
  /** Per-task channel overrides (scheduled tasks may name their own
   *  recipients — the bus events carry them; S5b). Honored by the
   *  delivery planner/port; the email allowlist still applies. */
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
  /** Stable per-run delivery id (dedupe for notifications/deliveries). */
  deliveryId?: string;
  /**
   * Issue #1718: the options run's partial qualification, when the scan
   * could not judge its whole requested universe. Carried so the
   * broadcast coverage floor can degrade (not success-broadcast)
   * below-floor runs at notification time. Stock/goal/discovery runs
   * never carry it, so their notifications are unchanged.
   */
  partial?: OptionsPartialQualification;
  /** Consolidation C3 (#1277): the schedule record's stage-chain
   *  config, when the run opted into stage-layered scheduling. The
   *  bridge stamps the chain's stage jobs from it; absent = the
   *  fused immediate chain (the degenerate case). */
  stageChain?: StageChainConfig;
  /** Consolidation C4 (#1329): the canonical mas_reports row this run
   *  published (discovery/goal runs, whose artifact is the canonical
   *  row rather than a PDF). The serve stage verifies this row. */
  canonicalReportId?: string;
  /**
   * Issue #2091: the chain's run timestamp + symbol list, carried so
   * the serve stage can record the run (canonical row + history row)
   * without re-deriving them. Absent on outcomes that predate #2091 —
   * the recorder skips those.
   */
  timestamp?: string;
  symbols?: string[];
  /** The scan-store run id this outcome is about, when the producing
   *  path carried it (run-result / HTTP options adapters). The serve
   *  recorder stamps it into the canonical body so
   *  mergeRunSummaries() can absorb the scan-store row into the
   *  canonical row instead of listing the run twice. Absent on
   *  outcomes that predate the stamp — the recorder skips it. */
  scanRunId?: string;
  /** Consolidation C4 (#1329): false when the run's delivery stays on
   *  its direct path and the chain must NOT plan deliveries (discovery
   *  chains before #1236 notifications — the chain covered generate +
   *  serve only). Absent/true = the chain delivers. Discovery chains
   *  flip to true in #1236 when the run carries stageChain (with a
   *  deliveryChannels allowlist from the task's own fields; an empty
   *  allowlist plans nothing). Goal chains flipped to true in #1236. */
  deliverViaChain?: boolean;
  /** Consolidation #1236: chain-delivery channel allowlist. When set,
   *  the delivery planner sends only to these channels — a goal chain
   *  mirrors its direct path's recipients instead of adding
   *  env-configured channels the direct path never used. Absent =
   *  config channels + per-task overrides (legacy). */
  deliveryChannels?: AsyncJobChannel[];
  error?: string;
  /** Issue #2216: the run's human-readable trace, rendered onto every
   *  outbound message for the run (failure legs, delivery legs) so a
   *  single message attributes its schedule, run, workflow, and stage. */
  trace?: ScreenerTrace;
}

export interface ScreenerChannelConfig {
  configured: boolean;
  to?: string;
  channel?: string;
  url?: string;
}

export interface ScreenerFollowupConfig {
  enabled: boolean;
  reportEnabled: boolean;
  channels: Record<AsyncJobChannel, ScreenerChannelConfig>;
  /** Assessment rule: email may only go to allowlisted addresses. */
  emailAllowlist: string[];
  /** True when the allowlist was set explicitly (SCREENER_EMAIL_ALLOWLIST);
   *  an explicit list gates even per-task override recipients. */
  emailAllowlistExplicit: boolean;
}

function envFlag(env: Record<string, unknown>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "";
}

function envStr(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveScreenerFollowupConfig(
  env: Record<string, unknown>,
): ScreenerFollowupConfig {
  const emailTo = envStr(env, "SCREENER_EMAIL_TO") ?? envStr(env, "OPTIONS_EMAIL_TO");
  const allowlistRaw = envStr(env, "SCREENER_EMAIL_ALLOWLIST");
  const emailAllowlist = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : emailTo
      ? [emailTo.toLowerCase()]
      : [];
  return {
    enabled: envStr(env, "SCREENER_FOLLOWUPS") !== "off",
    reportEnabled: envStr(env, "SCREENER_FOLLOWUP_REPORT") !== "off",
    channels: {
      email: { configured: Boolean(emailTo), to: emailTo },
      slack: {
        configured:
          envFlag(env, "SLACK_WEBHOOK_URL") ||
          envFlag(env, "SCREENER_SLACK_CHANNEL") ||
          envFlag(env, "SLACK_CHANNEL"),
        channel: envStr(env, "SCREENER_SLACK_CHANNEL") ?? envStr(env, "SLACK_CHANNEL"),
      },
      webhook: {
        configured: envFlag(env, "SCREENER_WEBHOOK_URL"),
        url: envStr(env, "SCREENER_WEBHOOK_URL"),
      },
    },
    emailAllowlist,
    emailAllowlistExplicit: Boolean(allowlistRaw),
  };
}

/** True when an email recipient is permitted for screener delivery:
 *  the configured allowlist — plus, when the list is only the default
 *  (derived from SCREENER_EMAIL_TO, not set explicitly), the run's
 *  own per-task recipient: schedule definitions are owner-configured,
 *  the same trust level as the env recipient (S5b). An explicitly
 *  configured allowlist gates every recipient. */
export function isEmailAllowed(
  config: ScreenerFollowupConfig,
  address: string,
  outcome?: ScreenerRunOutcome,
): boolean {
  const normalized = address.trim().toLowerCase();
  if (config.emailAllowlist.includes(normalized)) return true;
  if (config.emailAllowlistExplicit) return false;
  return Boolean(outcome?.emailTo && outcome.emailTo.trim().toLowerCase() === normalized);
}

export type FollowupReportSubmission = Extract<
  AsyncJobSubmission,
  { capability: "followup.report" }
>;

export type FollowupDeliverySubmission = Extract<
  AsyncJobSubmission,
  { capability: "followup.deliver" }
>;

/** The report sub-job's result, as consumed by the delivery planner. */
export interface FollowupReportResult {
  status: "ready" | "skipped" | string;
  artifacts?: Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" | "csv" }>;
  reason?: string;
  /** Consolidation C4 (#1329): the canonical mas_reports row the serve
   *  stage verified. A ready result carrying it is deliverable content
   *  even with no file artifacts (goal chains, #1236). */
  canonicalReportId?: string;
}

const CHANNEL_ORDER: AsyncJobChannel[] = ["slack", "email", "webhook"];
const CHANNEL_LABEL: Record<AsyncJobChannel, string> = {
  slack: "Slack",
  email: "email",
  webhook: "webhook",
};

/** Display label for a channel ("Slack" / "email" / "webhook"). */
export function followupChannelLabel(channel: AsyncJobChannel): string {
  return CHANNEL_LABEL[channel];
}

/**
 * Issue #1123 S3: when the report sub-job completes, plan one delivery
 * sub-job per configured channel, parented to the MAIN job (the tree
 * reads main → report / deliveries / notifications as siblings). A
 * skipped report still plans its deliveries, each carrying the skip
 * reason so the tree shows them completing as 'skipped' instead of
 * silently vanishing — and nothing is sent.
 */
/**
 * Issue #1228 (#1209 F2): the channels a run's deliver jobs will be
 * planned on — a channel counts when configured via env OR named by a
 * per-task override on the outcome (scheduled tasks, S5b), the same
 * precedence the legacy publishers applied. Shared by the delivery
 * planner and the lifecycle planner (which suppresses the text-only
 * 'completed' notify on exactly these channels: the delivery message
 * IS the completion message there).
 */
export function plannedDeliveryChannels(
  outcome: ScreenerRunOutcome,
  config: ScreenerFollowupConfig,
): AsyncJobChannel[] {
  if (!config.enabled) return [];
  const channels: AsyncJobChannel[] = [];
  for (const channel of CHANNEL_ORDER) {
    // Consolidation #1236: an outcome allowlist restricts the planner
    // to the run's own recipients (goal chains mirror their direct
    // path); env-configured channels outside it are not added.
    if (outcome.deliveryChannels && !outcome.deliveryChannels.includes(channel)) continue;
    const override = channel === "email"
      ? outcome.emailTo
      : channel === "slack"
        ? outcome.slackChannel
        : outcome.webhookUrl;
    if (config.channels[channel].configured || override) channels.push(channel);
  }
  return channels;
}

/** Consolidation C3 (#1277): chain context for one planning hop —
 *  the chain the stage jobs belong to and the predecessor's
 *  completion time the stage's delay counts from. */
export interface StageChainPlanContext {
  chainId: string;
  nowIso?: string;
}

function stageRunAt(chain: StageChainPlanContext, delaySeconds: number | undefined): string {
  const base = chain.nowIso ? Date.parse(chain.nowIso) : Date.now();
  const from = Number.isFinite(base) ? base : Date.now();
  return new Date(from + Math.max(0, delaySeconds ?? 0) * 1000).toISOString();
}

export function planDeliveryFollowups(
  outcome: ScreenerRunOutcome,
  config: ScreenerFollowupConfig,
  reportResult: FollowupReportResult,
  mainJobId: string,
  userLogin: string,
  chain?: StageChainPlanContext,
): FollowupDeliverySubmission[] {
  if (!config.enabled) return [];
  // Consolidation C4 (#1329): a run whose delivery stays on its direct
  // path plans no chain deliveries — the chain covers generate + serve.
  if (outcome.deliverViaChain === false) return [];
  const kindLabel = screenerKindLabel(outcome.kind);
  const artifacts = reportResult.artifacts ?? [];
  // Consolidation #1236: a ready result whose serve stage verified a
  // canonical row is deliverable content (the canonical row IS the
  // artifact for goal chains) — no "no artifact" skipReason. A ready
  // result with neither artifacts nor a verified row keeps the
  // undeliverable notice; a skipped report keeps its reason.
  const skipReason = reportResult.status === "skipped"
    ? reportResult.reason || "Report was skipped."
    : artifacts.length === 0 && !reportResult.canonicalReportId
      ? "Report produced no artifact to deliver."
      : undefined;
  const specs: FollowupDeliverySubmission[] = [];
  for (const channel of plannedDeliveryChannels(outcome, config)) {
    specs.push({
      capability: "followup.deliver",
      payload: { outcome, userLogin, channel, artifacts, skipReason },
      parentJobId: mainJobId,
      jobKind: "delivery",
      channel,
      displayName: `Deliver by ${CHANNEL_LABEL[channel]} — ${kindLabel} screen`,
      // Consolidation C3 (#1277): in chain mode the delivery is the
      // chain's deliver stage, deferred by its own delay. Without a
      // chain context the spec is byte-identical to the legacy one.
      ...(chain && outcome.stageChain
        ? {
            stage: "deliver" as const,
            chainId: chain.chainId,
            runAt: stageRunAt(chain, outcome.stageChain.deliverDelaySeconds),
          }
        : {}),
    });
  }
  return specs;
}

export type FollowupNotifySubmission = Extract<
  AsyncJobSubmission,
  { capability: "followup.notify" }
>;

/** Lifecycle transitions that emit notification sub-jobs (S4). */
export type FollowupLifecycleEvent = "started" | "completed" | "failed" | "delivered";

const NOTIFICATION_CHANNELS: AsyncJobChannel[] = ["slack", "email"];
const EVENT_LABEL: Record<FollowupLifecycleEvent, string> = {
  started: "screen started",
  completed: "screen completed",
  failed: "screen failed",
  delivered: "report delivered",
};

/**
 * Issue #1123 S4: plan the notification sub-jobs for one lifecycle
 * transition — Slack + email only (the webhook is a delivery
 * channel). Each transition is planned exactly once by the executor
 * that claims the job, so (main job, event, channel) is the natural
 * dedupe key; no duplicates by construction.
 */
export function planLifecycleNotifications(
  event: FollowupLifecycleEvent,
  outcome: ScreenerRunOutcome,
  config: ScreenerFollowupConfig,
  mainJobId: string,
  userLogin: string,
  detail?: string,
  options?: { suppressChannels?: readonly AsyncJobChannel[] },
): FollowupNotifySubmission[] {
  if (!config.enabled) return [];
  const specs: FollowupNotifySubmission[] = [];
  for (const channel of NOTIFICATION_CHANNELS) {
    // Issue #1228 (#1209 F2): on 'completed', channels that will
    // receive a deliver job get NO text-only notify — the delivery
    // message (text + artifacts, or the held / undeliverable notice
    // the deliver executor sends) is the completion message there.
    // Callers pass plannedDeliveryChannels(...) only when the report
    // chain will actually run for the run.
    if (event === "completed" && options?.suppressChannels?.includes(channel)) continue;
    // Issue #1191 (#1173 R3): a per-task override destination counts
    // for notifications too (mirroring the delivery planner) — a
    // scheduled task that names its own Slack channel / email
    // recipient hears about failures there, not only via env config.
    const override = channel === "email" ? outcome.emailTo : outcome.slackChannel;
    if (!config.channels[channel].configured && !override) continue;
    specs.push({
      capability: "followup.notify",
      payload: { event, outcome, userLogin, channel, detail },
      parentJobId: mainJobId,
      jobKind: "notification",
      channel,
      displayName: `Notify: ${EVENT_LABEL[event]} via ${CHANNEL_LABEL[channel]}`,
    });
  }
  return specs;
}

/**
 * Issue #1718: the single broadcast coverage floor for options runs.
 * A partial run below this fraction of its requested universe evaluated
 * must NOT be broadcast as a success ("✅ Screen completed" + report
 * link) on any notification surface — its notification degrades instead
 * (formatDegradedCoverageNotice). The run record and report are still
 * persisted as evidence; only the broadcast changes. Owner-adjustable:
 * change this one constant, not the call sites.
 */
export const OPTIONS_BROADCAST_COVERAGE_FLOOR = 0.5;

/** True when a partial qualification sits below the broadcast floor.
 *  No partial (complete coverage) or an empty universe never degrades. */
export function optionsCoverageBelowBroadcastFloor(
  partial: OptionsPartialQualification | undefined,
): boolean {
  if (!partial || partial.consideredCount <= 0) return false;
  return partial.evaluatedCount / partial.consideredCount < OPTIONS_BROADCAST_COVERAGE_FLOOR;
}

/**
 * Issue #1718: the degraded notice replacing a success broadcast for a
 * below-floor partial run. Names coverage (evaluated of considered,
 * failures, truncated) and the top skip reason when stamped. Deliberately
 * carries no success mark, no "completed" text, and no report link — the
 * report stays stored as evidence, it is just not broadcast.
 */
export function formatDegradedCoverageNotice(
  partial: OptionsPartialQualification,
  kindLabel: string,
  scope?: string,
): string {
  const parts = [
    `⚠️ ${kindLabel}${scope ? ` — ${scope}` : ""}: degraded coverage — ${partial.evaluatedCount} of ${partial.consideredCount} underlyings evaluated (${partial.coverageErrors} failures, ${partial.truncatedCount} truncated).`,
  ];
  if (partial.topSkipReason) {
    parts.push(
      `Top skip reason: "${partial.topSkipReason}"${partial.topSkipCount ? ` (${partial.topSkipCount} symbols)` : ""}.`,
    );
  }
  parts.push(
    `No report broadcast: coverage is below the ${Math.round(OPTIONS_BROADCAST_COVERAGE_FLOOR * 100)}% broadcast floor. The run record and report remain stored as evidence.`,
  );
  return parts.join(" ");
}

/** Notification text for one lifecycle transition. */
export function formatLifecycleNotification(
  event: FollowupLifecycleEvent,
  outcome: ScreenerRunOutcome,
  detail?: string,
): string {
  const kindLabel = `${screenerKindLabel(outcome.kind)} screen`;
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  const scopeText = scope ? ` — ${scope}` : "";
  switch (event) {
    case "started":
      return `🔔 ${kindLabel}${scopeText} started`;
    case "completed":
      // Issue #1718: a below-floor options partial never posts as a
      // success — the degraded notice replaces the completed text on
      // every channel the notify job reaches. Other kinds carry no
      // partial, so their completed text is byte-identical to before.
      if (outcome.kind === "options" && optionsCoverageBelowBroadcastFloor(outcome.partial)) {
        return formatDegradedCoverageNotice(outcome.partial!, kindLabel, scope);
      }
      return `✅ Screen completed\n${formatFollowupDeliveryText(outcome)}`;
    case "failed": {
      // Issue #1252 (#1173 R4): run failures carry the catalog code
      // (FAILURE_SCREEN_RUN_FAILED) in the notification, as in the job record.
      // Issue #2248 (AOP P1): the code renders FROM the catalog via
      // codedMessage — not a hand-built literal — so the failure
      // email (notify subject = first line) and the Slack failed leg
      // carry the same catalog message. The #2216 trace behavior is
      // preserved: the trace block still appends when carried.
      const traceBlock = formatTraceBlock(outcome.trace);
      const detail = `${kindLabel}${scopeText}${outcome.error ? ` — ${outcome.error}` : ""}`;
      return `❌ ${codedMessage("FAILURE_SCREEN_RUN_FAILED", detail)}${traceBlock ? `\n${traceBlock}` : ""}`;
    }
    case "delivered":
      return `📬 Report delivered${detail ? ` ${detail}` : ""} — ${kindLabel}${scopeText}${outcome.reportUrl ? `\n📄 Report: ${outcome.reportUrl}` : ""}`;
  }
}

/**
 * Issue #1191 (#1173 R3): the announcement sent when the #277 gate
 * holds a delivery — before R3 a held delivery was silent, which is
 * how completed runs on 2026-10-23 produced no message of any kind.
 */
export function formatHeldNotification(
  outcome: ScreenerRunOutcome,
  options?: { expiresAtIso?: string },
): string {
  const kindLabel = `${screenerKindLabel(outcome.kind)} screen`;
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  const lines = [
    `⏸️ ${kindLabel}${scope ? ` — ${scope}` : ""} completed — delivery held for approval`,
    "",
    formatFollowupDeliveryText(outcome),
    ...(outcome.reportUrl ? ["", `📄 Report: ${outcome.reportUrl}`] : []),
    "",
    "The report (text + PDF + XLSX) is ready but the report-dispatch confirmation gate (#277) is on. Approve it in the Reports panel's pending-review list to send." +
      (options?.expiresAtIso
        ? ` The held delivery expires ${options.expiresAtIso} — approve before then or it is discarded unsent.`
        : ""),
  ];
  return lines.join("\n");
}

/**
 * Issue #1228 (#1209 F2): the message a deliver job sends when the
 * report produced nothing deliverable — the completion text plus the
 * reason, so a channel whose 'completed' notify was suppressed in
 * favor of the delivery still hears the outcome (with why no report
 * is attached) instead of going silent.
 */
export function formatUndeliverableNotification(outcome: ScreenerRunOutcome, reason: string): string {
  // Issue #1718: same floor as the completed notice — a below-floor
  // partial must not post a success header through this surface either.
  if (outcome.kind === "options" && optionsCoverageBelowBroadcastFloor(outcome.partial)) {
    const kindLabel = `${screenerKindLabel(outcome.kind)} screen`;
    return formatDegradedCoverageNotice(outcome.partial!, kindLabel, outcome.thesis);
  }
  return `✅ Screen completed\n${formatFollowupDeliveryText(outcome)}\n⚠️ No report is attached: ${reason}`;
}

/** Delivery/notification text for a run outcome (S3; reused by S4). */
export function formatFollowupDeliveryText(outcome: ScreenerRunOutcome): string {
  const kindLabel = `${screenerKindLabel(outcome.kind)} screen`;
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  const lines: string[] = [
    `📊 ${kindLabel}${scope ? ` — ${scope}` : ""}`,
  ];
  if (outcome.matchedCount !== undefined || outcome.totalScanned !== undefined) {
    lines.push(`${outcome.matchedCount ?? "?"} matched · ${outcome.totalScanned ?? "?"} scanned`);
  }
  if (outcome.summary) lines.push(outcome.summary);
  if (outcome.opportunities && outcome.opportunities.length > 0) {
    lines.push("");
    for (const opp of outcome.opportunities.slice(0, 10)) {
      const price = opp.lastPrice !== undefined ? ` @ $${opp.lastPrice}` : "";
      const change = opp.changePercent !== undefined ? ` (${opp.changePercent > 0 ? "+" : ""}${opp.changePercent}%)` : "";
      lines.push(`• ${opp.symbol}${opp.companyName ? ` — ${opp.companyName}` : ""}${opp.signal ? ` [${opp.signal}]` : ""}${price}${change}`);
    }
  }
  if (outcome.reportUrl) {
    lines.push("", `📄 Report: ${outcome.reportUrl}`);
  }
  return lines.join("\n");
}

/**
 * Issue #1123 S5b: adapt a screener bus event (the scheduled tasks'
 * publish shape) into the canonical outcome.
 */
export function screenerOutcomeFromEvent(
  event: import("../events/screenerEvents").ScreenerEvent,
  appBaseUrl?: string,
): ScreenerRunOutcome {
  const trigger = event.trigger === "manual" ? "manual" : "scheduled";
  switch (event.type) {
    case "screener.completed":
      return {
        kind: "stock",
        trigger,
        success: true,
        pdfKeys: event.pdfKey ? [event.pdfKey] : [],
        pdfStatus: event.pdfStatus,
        pdfError: event.pdfError,
        xlsxKey: event.xlsxKey,
        xlsxStatus: event.xlsxStatus,
        xlsxError: event.xlsxError,
        csvKey: event.csvKey,
        csvStatus: event.csvStatus,
        csvError: event.csvError,
        reportUrl: event.pdfKey ? screenerReportUrl(appBaseUrl, event.pdfKey) : undefined,
        matchedCount: event.matchedCount,
        totalScanned: event.totalScanned,
        universe: event.universe,
        opportunities: asOpportunities(event.opportunities as unknown),
        providerFallback: event.providerFallback,
        emailTo: event.emailTo,
        slackChannel: event.slackChannel,
        webhookUrl: event.webhookUrl,
        deliveryId: event.deliveryId,
        stageChain: event.stageChain,
      };
    case "screener.failed":
      return {
        kind: "stock",
        trigger,
        success: false,
        pdfKeys: [],
        universe: event.universe,
        emailTo: event.emailTo,
        slackChannel: event.slackChannel,
        webhookUrl: event.webhookUrl,
        deliveryId: event.deliveryId,
        stageChain: event.stageChain,
        error: event.error,
      };
    case "options.completed":
      return {
        kind: "options",
        trigger,
        success: true,
        // Consolidation C4 (#1329): the options run's PDF key rides
        // the event now, so a chained options run's serve stage can
        // adopt the same artifact its direct path used to deliver —
        // and the chain, not the direct path, delivers in chain mode.
        pdfKeys: event.pdfKey ? [event.pdfKey] : [],
        pdfStatus: event.pdfStatus,
        pdfError: event.pdfError,
        // Options run-record fix: carry every produced format (and its failure)
        // into the recorded outcome — the job-tree outcome is what
        // Workflow Runs reads its artifact list from.
        xlsxKey: event.xlsxKey,
        xlsxStatus: event.xlsxStatus,
        xlsxError: event.xlsxError,
        csvKey: event.csvKey,
        csvStatus: event.csvStatus,
        csvError: event.csvError,
        reportUrl: event.reportUrl
          ? absoluteReportUrl(appBaseUrl, event.reportUrl)
          : undefined,
        // The options event names matches "withTrades"; the ledger
        // calls the same fact matchedCount. Dropping it rendered every
        // options run with a null match count.
        matchedCount: event.withTrades,
        totalScanned: event.totalScanned,
        thesis: event.thesis,
        summary: event.summary,
        stageChain: event.stageChain,
        // Issue #1718: the qualification rides the event so the
        // lifecycle completed notice can apply the broadcast floor.
        partial: event.partial,
      };
    case "options.failed":
      return {
        kind: "options",
        trigger,
        success: false,
        pdfKeys: [],
        thesis: event.thesis,
        error: event.error,
        stageChain: event.stageChain,
      };
  }
}

/**
 * Issue #1123 S5a: adapt a run-result object (ScreenerRunResult from
 * the agent/routes, or the options screen's result fields) into the
 * canonical outcome — the bridge entry for sources that did not run
 * as async jobs.
 */
export function screenerOutcomeFromRunResult(
  kind: ScreenerKind,
  result: Record<string, unknown>,
  appBaseUrl?: string,
): ScreenerRunOutcome {
  // Issue #2545: an explicit generatePdf:false on the run result is a
  // DELIVERY-projection instruction (the manual route stamps it from
  // the caller's delivery selection): the outcome carries no report
  // artifacts, so deliveries send text without attachments. The run
  // record itself — and its stored report — are untouched.
  const includeReportArtifacts = result.generatePdf !== false;
  const pdfKey = includeReportArtifacts && typeof result.pdfKey === "string" ? result.pdfKey : undefined;
  const reportUrl = !includeReportArtifacts
    ? undefined
    : typeof result.reportUrl === "string"
      ? absoluteReportUrl(appBaseUrl, result.reportUrl)
      : pdfKey
        ? kind === "stock"
          ? screenerReportUrl(appBaseUrl, pdfKey)
          : optionsReportUrl(appBaseUrl, pdfKey)
        : undefined;
  return {
    kind,
    trigger: result.trigger === "scheduled" ? "scheduled" : "manual",
    success: result.success !== false,
    pdfKeys: pdfKey ? [pdfKey] : [],
    pdfStatus: !includeReportArtifacts
      ? "skipped"
      : result.pdfStatus === "generated" || result.pdfStatus === "failed" || result.pdfStatus === "skipped"
        ? result.pdfStatus
        : pdfKey
          ? "generated"
          : undefined,
    pdfError: includeReportArtifacts && typeof result.pdfError === "string" ? result.pdfError : undefined,
    xlsxKey: includeReportArtifacts && typeof result.xlsxKey === "string" ? result.xlsxKey : undefined,
    xlsxStatus: includeReportArtifacts && (result.xlsxStatus === "generated" || result.xlsxStatus === "failed" || result.xlsxStatus === "skipped")
      ? result.xlsxStatus
      : undefined,
    xlsxError: includeReportArtifacts && typeof result.xlsxError === "string" ? result.xlsxError : undefined,
    csvKey: includeReportArtifacts && typeof result.csvKey === "string" ? result.csvKey : undefined,
    csvStatus: includeReportArtifacts && (result.csvStatus === "generated" || result.csvStatus === "failed" || result.csvStatus === "skipped")
      ? result.csvStatus
      : undefined,
    csvError: includeReportArtifacts && typeof result.csvError === "string" ? result.csvError : undefined,
    reportUrl,
    matchedCount: asNumber(result.matchedCount),
    totalScanned: asNumber(result.totalScanned) ?? asNumber(result.totalUnderlyingsScanned),
    universe: typeof result.universe === "string" ? result.universe : undefined,
    thesis: typeof result.thesis === "string" ? result.thesis : undefined,
    summary: typeof result.summary === "string" ? result.summary : undefined,
    opportunities: asOpportunities(result.opportunities),
    providerFallback: asProviderFallback(result.providerFallback),
    ...(typeof result.scanRunId === "string" && result.scanRunId ? { scanRunId: result.scanRunId } : {}),
    ...(typeof result.emailTo === "string" && result.emailTo.trim() !== "" ? { emailTo: result.emailTo.trim() } : {}),
    // Issue #2545: the manual route's delivery selection rides the
    // enriched run result — the same per-task overrides the scheduled
    // path's bus events carry into this outcome (S5b), plus the
    // channel allowlist an explicit selection stamps (#1236 field).
    ...(typeof result.slackChannel === "string" && result.slackChannel.trim() !== "" ? { slackChannel: result.slackChannel.trim() } : {}),
    ...(typeof result.webhookUrl === "string" && result.webhookUrl.trim() !== "" ? { webhookUrl: result.webhookUrl.trim() } : {}),
    ...(Array.isArray(result.deliveryChannels)
      ? {
          deliveryChannels: result.deliveryChannels.filter(
            (c): c is AsyncJobChannel => c === "slack" || c === "email" || c === "webhook",
          ),
        }
      : {}),
    error: typeof result.error === "string" ? result.error : undefined,
    partial: asPartialQualification(result.partial),
  };
}

/**
 * The initial plan for a completed run: exactly one report sub-job.
 * Deliveries are planned when the report completes (S3) and lifecycle
 * notifications at their transitions (S4) — the chain keeps each step
 * dependent on the artifact it consumes instead of racing siblings.
 */
export function planInitialFollowups(
  outcome: ScreenerRunOutcome,
  config: ScreenerFollowupConfig,
  mainJobId: string,
  userLogin: string,
  chain?: StageChainPlanContext,
): FollowupReportSubmission[] {
  if (!config.enabled || !config.reportEnabled || !outcome.success) return [];
  const kindLabel = screenerKindLabel(outcome.kind);
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  // Consolidation C3 (#1277): in chain mode the report job is the
  // chain's serve stage — deferred by its own delay, with the chain
  // config riding its payload so the deliver hop planned at its
  // completion reads its delay from the completed stage's record.
  // Without a chain context the spec is byte-identical to the
  // legacy one (the degenerate case).
  const chained = chain && outcome.stageChain ? chain : undefined;
  return [
    {
      capability: "followup.report",
      payload: {
        outcome,
        userLogin,
        ...(chained
          ? { stageChain: outcome.stageChain, chainId: chained.chainId }
          : {}),
      },
      parentJobId: mainJobId,
      jobKind: "report",
      displayName: `Generate report — ${kindLabel} screen${scope ? ` (${scope})` : ""}`,
      ...(chained
        ? {
            stage: "serve" as const,
            chainId: chained.chainId,
            runAt: stageRunAt(chained, outcome.stageChain?.serveDelaySeconds),
          }
        : {}),
    },
  ];
}

/**
 * Consolidation C4 (#1329): the chain context of a staged http.request
 * job — a job submitted as a chain's generate stage (stage +
 * chain_id on the row) whose payload carries the stageChain config.
 * Undefined unless all three are present: an unstaged job, or a staged
 * job without a config, plans the legacy immediate chain. The executor
 * completion hook resolves this and hands the context to the planners;
 * only recognized screener completions yield an outcome to plan from,
 * so a generic http job gains chain identity + generate-stage status
 * while serve/deliver planning for arbitrary routes applies only when
 *  a registered outcome adapter produces an outcome for the route
 *  (#1236); unregistered routes keep the legacy chain.
 */
export function resolveHttpJobChain(
  job: { stage?: string | null; chainId?: string | null },
  payload: { stageChain?: StageChainConfig },
): { chainId: string; stageChain: StageChainConfig } | undefined {
  if (job.stage !== "generate") return undefined;
  if (typeof job.chainId !== "string" || !job.chainId) return undefined;
  if (!payload.stageChain || typeof payload.stageChain !== "object") return undefined;
  return { chainId: job.chainId, stageChain: payload.stageChain };
}

/** Path recognition for screener main-jobs among http.request jobs. */
export function screenerKindForPath(pathAndQuery: string): ScreenerKind | null {
  const path = pathAndQuery.split("?")[0];
  if (path.endsWith("/etrade/screen")) return "stock";
  if (path.endsWith("/trading/options/screen")) return "options";
  return null;
}

function pdfKeyFromReportUrl(reportUrl: unknown): string | undefined {
  if (typeof reportUrl !== "string") return undefined;
  const match = reportUrl.match(/[?&]key=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Issue #1718: accept only a well-shaped partial qualification from an
 * untyped run result — a malformed stamp must not arm the floor (nor
 * crash the bridge); it is dropped, leaving today's behavior.
 */
function asPartialQualification(value: unknown): OptionsPartialQualification | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const evaluatedCount = asNumber(p.evaluatedCount);
  const consideredCount = asNumber(p.consideredCount);
  const coverageErrors = asNumber(p.coverageErrors);
  const truncatedCount = asNumber(p.truncatedCount);
  if (
    evaluatedCount === undefined ||
    consideredCount === undefined ||
    coverageErrors === undefined ||
    truncatedCount === undefined
  ) {
    return undefined;
  }
  return {
    evaluatedCount,
    consideredCount,
    coverageErrors,
    truncatedCount,
    ...(typeof p.topSkipReason === "string" && p.topSkipReason ? { topSkipReason: p.topSkipReason } : {}),
    ...(asNumber(p.topSkipCount) !== undefined ? { topSkipCount: asNumber(p.topSkipCount)! } : {}),
  };
}

function asOpportunities(value: unknown): ScreenerOutcomeOpportunity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ScreenerOutcomeOpportunity[] = [];
  for (const item of value as Array<Record<string, unknown>>) {
    if (!item || typeof item.symbol !== "string") continue;
    out.push({
      symbol: item.symbol,
      companyName: typeof item.companyName === "string" ? item.companyName : undefined,
      signal: typeof item.signal === "string" ? item.signal : undefined,
      momentumScore: asNumber(item.momentumScore),
      lastPrice: asNumber(item.lastPrice),
      changePercent: asNumber(item.changePercent),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Issue #1527: validate a provider-fallback marker off an untyped run result. */
function asProviderFallback(value: unknown): { from: string; reason: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  return typeof v.from === "string" && typeof v.reason === "string"
    ? { from: v.from, reason: v.reason }
    : undefined;
}

/**
 * Consolidation #1236: opt-in outcome adapters for arbitrary
 * http.request routes. screenerKindForPath recognizes only the two
 * screener routes; a route outside them has no outcome semantics the
 * pipeline may invent (what "success" means for an arbitrary POST is
 * the route owner's design decision). A route owner registers an
 * adapter — a path matcher plus an extractor from (status, parsed
 * body) to the canonical outcome — and screenerOutcomeFromHttpJob
 * consults adapters, in registration order, only when no builtin kind
 * matches. Unregistered routes keep the legacy chain (null: no
 * follow-ups). Adapters are code, not config: registering one is a
 * deliberate per-route decision, recorded with the route owner.
 */
export interface HttpOutcomeAdapter {
  match: (pathAndQuery: string) => boolean;
  adapt: (input: {
    pathAndQuery: string;
    responseStatus: number | undefined;
    body: Record<string, unknown>;
  }) => ScreenerRunOutcome | null;
}

const httpOutcomeAdapters: HttpOutcomeAdapter[] = [];

export function registerHttpOutcomeAdapter(adapter: HttpOutcomeAdapter): void {
  httpOutcomeAdapters.push(adapter);
}

/**
 * Adapt a completed http.request job (path, response status, body) into
 * the canonical outcome. Returns null when the job is not a screener
 * completion or the body is unparseable — follow-ups simply don't apply.
 */
export function screenerOutcomeFromHttpJob(
  pathAndQuery: string,
  responseStatus: number | undefined,
  bodyText: string,
): ScreenerRunOutcome | null {
  const kind = screenerKindForPath(pathAndQuery);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Consolidation #1236: builtins win; adapters cover only routes no
  // builtin recognizes. An adapter that declines (null) leaves the job
  // without follow-ups — the same as an unregistered route.
  if (!kind) {
    for (const adapter of httpOutcomeAdapters) {
      if (!adapter.match(pathAndQuery)) continue;
      const adapted = adapter.adapt({ pathAndQuery, responseStatus, body });
      if (adapted) return adapted;
    }
    return null;
  }
  const failed = (responseStatus !== undefined && responseStatus >= 400) || typeof body.error === "string";
  if (failed) {
    return {
      kind,
      trigger: "manual",
      success: false,
      pdfKeys: [],
      error: typeof body.error === "string" ? body.error : `screen request failed (${responseStatus})`,
    };
  }
  if (kind === "stock") {
    if (body.sharded === true && Array.isArray(body.universes)) {
      const shards = body.universes as Array<Record<string, unknown>>;
      const pdfKeys = shards
        .map((s) => (typeof s.pdfKey === "string" ? s.pdfKey : pdfKeyFromReportUrl(s.reportUrl)))
        .filter((k): k is string => Boolean(k));
      const shardOpportunities = shards.flatMap((s) => asOpportunities(s.opportunities) ?? []);
      return {
        kind,
        trigger: "manual",
        success: shards.some((s) => s.success !== false),
        pdfKeys,
        pdfStatus: pdfKeys.length > 0 ? "generated" : undefined,
        matchedCount: shards.reduce((n, s) => n + (asNumber(s.matchedCount) ?? 0), 0),
        totalScanned: shards.reduce((n, s) => n + (asNumber(s.totalScanned) ?? 0), 0),
        universe: "ALL",
        opportunities: shardOpportunities.length > 0 ? shardOpportunities : undefined,
        reportUrl: typeof body.reportUrl === "string" ? body.reportUrl : undefined,
      };
    }
    const pdfKey = typeof body.pdfKey === "string" ? body.pdfKey : pdfKeyFromReportUrl(body.reportUrl);
    return {
      kind,
      trigger: "manual",
      success: true,
      pdfKeys: pdfKey ? [pdfKey] : [],
      pdfStatus: body.pdfStatus === "generated" || body.pdfStatus === "failed" || body.pdfStatus === "skipped"
        ? body.pdfStatus
        : pdfKey
          ? "generated"
          : undefined,
      pdfError: typeof body.pdfError === "string" ? body.pdfError : undefined,
      xlsxKey: typeof body.xlsxKey === "string" ? body.xlsxKey : undefined,
      xlsxStatus: body.xlsxStatus === "generated" || body.xlsxStatus === "failed" || body.xlsxStatus === "skipped"
        ? body.xlsxStatus
        : undefined,
      xlsxError: typeof body.xlsxError === "string" ? body.xlsxError : undefined,
      matchedCount: asNumber(body.matchedCount),
      totalScanned: asNumber(body.totalScanned),
      universe: typeof body.universe === "string" ? body.universe : undefined,
      opportunities: asOpportunities(body.opportunities),
      reportUrl: typeof body.reportUrl === "string" ? body.reportUrl : undefined,
    };
  }
  const data = (body.data ?? {}) as Record<string, unknown>;
  const pdfKey = typeof body.pdfKey === "string" ? body.pdfKey : pdfKeyFromReportUrl(body.reportUrl);
  const statusOf = (v: unknown): "generated" | "failed" | "skipped" | undefined =>
    v === "generated" || v === "failed" || v === "skipped" ? v : undefined;
  const strOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const xlsxKey = strOf(body.xlsxKey) ?? strOf(data.xlsxKey);
  const csvKey = strOf(body.csvKey) ?? strOf(data.csvKey);
  return {
    kind,
    trigger: "manual",
    success: true,
    pdfKeys: pdfKey ? [pdfKey] : [],
    pdfStatus: statusOf(body.pdfStatus) ?? (pdfKey ? "generated" : undefined),
    pdfError: strOf(body.pdfError) ?? strOf(data.pdfError),
    xlsxKey,
    xlsxStatus: statusOf(body.xlsxStatus) ?? statusOf(data.xlsxStatus) ?? (xlsxKey ? "generated" : undefined),
    xlsxError: strOf(body.xlsxError) ?? strOf(data.xlsxError),
    csvKey,
    csvStatus: statusOf(body.csvStatus) ?? statusOf(data.csvStatus) ?? (csvKey ? "generated" : undefined),
    csvError: strOf(body.csvError) ?? strOf(data.csvError),
    matchedCount: asNumber(body.matchedCount) ?? asNumber(data.matchedCount),
    totalScanned: asNumber(body.totalUnderlyingsScanned) ?? asNumber(body.totalScanned) ?? asNumber(data.totalScanned),
    thesis: typeof body.thesis === "string" ? body.thesis : undefined,
    summary: typeof body.summary === "string" ? body.summary : undefined,
    reportUrl: typeof body.reportUrl === "string" ? body.reportUrl : undefined,
    ...(strOf(body.scanRunId) ?? strOf(data.scanRunId) ? { scanRunId: (strOf(body.scanRunId) ?? strOf(data.scanRunId))! } : {}),
  };
}
