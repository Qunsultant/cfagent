/**
 * Issue #3897 — Real-time Slack & Email Notifications for On-Demand and Copilot Order Placements.
 *
 * Dispatches multi-channel order notifications (Slack + Email) whenever Stock Copilot
 * or on-demand order execution tools place or settle a broker order.
 *
 * Invariants:
 * - Best-effort delivery: notification failures never abort or roll back a placed broker order.
 * - Tenant channel gate awareness: honors `resolveTenantChannelGate` when `userLogin` is present.
 * - Per-user email destination precedence: `eventEmailTo > storedEmailTo > OPTIONS_EMAIL_TO > SCREENER_EMAIL_TO`.
 * - Honest status reporting: returns `delivered`, `not_configured`, `disabled`, or `failed` per channel.
 */

import { createDeliverChannelSenders } from "./deliverJobs";
import { getStoredEmailDestination, resolveEmailDestination } from "./userEmailDestination";
import { channelDisabledError, resolveTenantChannelGate } from "./tenantChannelGate";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import type { Env } from "../types";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/orderExecutionNotifier",
});

export type OrderNotificationStatus = "delivered" | "not_configured" | "disabled" | "failed";

export interface ChannelNotificationReceipt {
  sent: boolean;
  status: OrderNotificationStatus;
  to?: string;
  error?: string;
}

export interface OrderExecutionNotificationResult {
  slack: ChannelNotificationReceipt;
  email: ChannelNotificationReceipt;
}

export interface OrderExecutionNotificationInput {
  orderId: string;
  broker: string;
  mode?: "paper" | "live" | "sandbox" | string;
  symbol: string;
  action: string;
  quantity: number;
  orderType?: string;
  orderClass?: string;
  price?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  status: string;
  origin: string;
  userLogin?: string;
  emailTo?: string;
  slackChannel?: string;
  session?: string;
  strategy?: string;
  reason?: string;
  timestamp?: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatOrderNotificationPayload(input: OrderExecutionNotificationInput): {
  subject: string;
  slackText: string;
  emailText: string;
  emailHtml: string;
} {
  const action = (input.action || "ORDER").toUpperCase();
  const symbol = (input.symbol || "UNKNOWN").toUpperCase();
  const qty = Number.isFinite(input.quantity) ? input.quantity : 0;
  const orderType = (input.orderType || "MARKET").toUpperCase();
  const broker = (input.broker || "BROKER").toUpperCase();
  const mode = (input.mode || "paper").toUpperCase();
  const status = (input.status || "executed").toUpperCase();
  const timestamp = input.timestamp || new Date().toISOString();

  const priceLine =
    typeof input.price === "number" && Number.isFinite(input.price) && input.price > 0
      ? `$${input.price.toFixed(2)}`
      : orderType === "MARKET"
        ? "MARKET"
        : "N/A";

  const bracketParts: string[] = [];
  if (typeof input.takeProfitPrice === "number" && Number.isFinite(input.takeProfitPrice)) {
    bracketParts.push(`TP $${input.takeProfitPrice.toFixed(2)}`);
  }
  if (typeof input.stopLossPrice === "number" && Number.isFinite(input.stopLossPrice)) {
    bracketParts.push(`SL $${input.stopLossPrice.toFixed(2)}`);
  }
  const bracketSummary = bracketParts.length > 0 ? bracketParts.join(" / ") : null;

  const subject = `[Stock Copilot Order] ${action} ${qty} ${symbol} (${orderType}) — ${status}`;

  const lines: string[] = [
    `Stock Copilot Order Notification — ${status}`,
    `• Action: ${action} ${qty} ${symbol}`,
    `• Order Type: ${orderType}${input.orderClass ? ` (${input.orderClass})` : ""}`,
    `• Price: ${priceLine}`,
    ...(bracketSummary ? [`• Bracket Exits: ${bracketSummary}`] : []),
    `• Broker / Mode: ${broker} (${mode})`,
    `• Order ID: ${input.orderId}`,
    `• Origin: ${input.origin}`,
    ...(input.strategy ? [`• Strategy: ${input.strategy}`] : []),
    ...(input.session ? [`• Session: ${input.session}`] : []),
    ...(input.reason ? [`• Reason: ${input.reason}`] : []),
    `• Timestamp: ${timestamp}`,
  ];

  const slackText = [
    `:rocket: *Stock Copilot Order ${status}* — *${action} ${qty} ${symbol}*`,
    ...lines.slice(1),
  ].join("\n");

  const emailText = lines.join("\n");

  const htmlRows = [
    ["Status", status],
    ["Action", `${action} ${qty} ${symbol}`],
    ["Order Type", `${orderType}${input.orderClass ? ` (${input.orderClass})` : ""}`],
    ["Price", priceLine],
    ...(bracketSummary ? [["Bracket Exits", bracketSummary]] : []),
    ["Broker / Mode", `${broker} (${mode})`],
    ["Order ID", input.orderId],
    ["Origin", input.origin],
    ...(input.strategy ? [["Strategy", input.strategy]] : []),
    ...(input.session ? [["Session", input.session]] : []),
    ...(input.reason ? [["Reason", input.reason]] : []),
    ["Timestamp", timestamp],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px;border:1px solid #393939;font-weight:600;">${escapeHtml(k)}</td><td style="padding:6px 12px;border:1px solid #393939;">${escapeHtml(v)}</td></tr>`,
    )
    .join("");

  const emailHtml = `<div style="font-family:IBM Plex Sans,system-ui,sans-serif;color:#f4f4f4;background:#161616;padding:16px;border-radius:4px;">
  <h2 style="margin:0 0 12px 0;font-size:16px;">${escapeHtml(subject)}</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">${htmlRows}</table>
</div>`;

  return { subject, slackText, emailText, emailHtml };
}

export async function notifyOrderExecution(
  env: Env | Record<string, unknown> | undefined | null,
  input: OrderExecutionNotificationInput,
): Promise<OrderExecutionNotificationResult> {
  const envRecord = (env ?? {}) as Record<string, unknown>;
  const { subject, slackText, emailText, emailHtml } = formatOrderNotificationPayload(input);
  const { senders, unconfiguredReasons } = createDeliverChannelSenders(envRecord);

  const gate =
    input.userLogin && input.userLogin.trim()
      ? await resolveTenantChannelGate(envRecord, input.userLogin.trim()).catch(() => null)
      : null;

  // 1. Slack Notification
  let slackReceipt: ChannelNotificationReceipt;
  if (gate && !gate.isEnabled("slack")) {
    slackReceipt = {
      sent: false,
      status: "disabled",
      error: channelDisabledError("slack", gate.tenantId),
    };
  } else if (!senders.slack) {
    slackReceipt = {
      sent: false,
      status: "not_configured",
      error: unconfiguredReasons.slack ?? "slack_transport_not_configured",
    };
  } else {
    try {
      const res = await senders.slack({
        text: slackText,
        ...(input.slackChannel ? { channel: input.slackChannel } : {}),
      });
      slackReceipt = {
        sent: res.ok,
        status: res.ok ? "delivered" : "failed",
        ...(res.error ? { error: res.error } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      structuredLog.warn("orderExecutionNotifier.slack_failed", {
        orderId: input.orderId,
        origin: input.origin,
        error: message,
      });
      slackReceipt = {
        sent: false,
        status: "failed",
        error: message,
      };
    }
  }

  // 2. Email Notification
  let emailReceipt: ChannelNotificationReceipt;
  if (gate && !gate.isEnabled("email")) {
    emailReceipt = {
      sent: false,
      status: "disabled",
      error: channelDisabledError("email", gate.tenantId),
    };
  } else if (!senders.email) {
    emailReceipt = {
      sent: false,
      status: "not_configured",
      error: unconfiguredReasons.email ?? "email_transport_not_configured",
    };
  } else {
    const storedEmailTo =
      input.userLogin && input.userLogin.trim() && env
        ? await getStoredEmailDestination(env as Env, input.userLogin.trim()).catch(() => undefined)
        : undefined;
    const to = resolveEmailDestination({
      eventEmailTo: input.emailTo,
      storedEmailTo,
      env: envRecord,
    });
    if (!to) {
      emailReceipt = {
        sent: false,
        status: "not_configured",
        error: "email_destination_not_configured",
      };
    } else {
      try {
        const res = await senders.email({
          to,
          subject,
          text: emailText,
          html: emailHtml,
        });
        emailReceipt = {
          sent: res.ok,
          to,
          status: res.ok ? "delivered" : "failed",
          ...(res.error ? { error: res.error } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        structuredLog.warn("orderExecutionNotifier.email_failed", {
          orderId: input.orderId,
          origin: input.origin,
          to,
          error: message,
        });
        emailReceipt = {
          sent: false,
          to,
          status: "failed",
          error: message,
        };
      }
    }
  }

  return {
    slack: slackReceipt,
    email: emailReceipt,
  };
}

