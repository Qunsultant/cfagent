/**
 * Issue #215: A2A client for cfpay's notification agents.
 *
 * Calls cfpay's Slack and Email agents via the A2A protocol using
 * STRUCTURED operations (not conversational). Each agent's handleA2AMessage
 * routes on a `data` part with an `operation` field — no LLM is involved.
 *
 * - Slack: `slack.post` with { text, channel? }
 * - Email: `email.send` with { to, subject, body }
 * - Webhook: cfpay has no outbound dispatch via A2A (only webhook.receive
 *   for inbound); use the local ETradeWebhookService instead.
 *
 * Requires `CFPAY_URL` (default https://pay.openaimp.com) and
 * `CFPAY_OUTBOUND_TOKEN` (outbound bearer token to cfpay, #2053) in
 * env. The token is never logged. `DASHBOARD_API_KEY_IS_A2A_TOKEN` is
 * kept only as a deprecated transitional fallback, superseded by
 * `CFPAY_OUTBOUND_TOKEN`; `CFPAY_A2A_TOKEN` is the pre-existing third
 * fallback. `A2A_API_TOKEN` is NEVER an outbound token: it is the
 * inbound dispatch token and must not enable outbound calls.
 */

export interface CfpayA2AConfig {
  baseUrl: string;
  token: string;
}

export function getCfpayConfig(env: unknown): CfpayA2AConfig | null {
  const e = env as Record<string, unknown>;
  const baseUrl = (e.CFPAY_URL as string) || "https://pay.openaimp.com";
  // CFPAY_OUTBOUND_TOKEN is the outbound A2A bearer token (#2053,
  // direction-explicit: this name cannot be read as the inbound token).
  // DASHBOARD_API_KEY_IS_A2A_TOKEN is a deprecated transitional
  // fallback, superseded by CFPAY_OUTBOUND_TOKEN — kept only until the
  // new Worker secret is proven live, then retired by a later
  // owner-directed removal. CFPAY_A2A_TOKEN is the pre-existing third
  // fallback. A2A_API_TOKEN is never read here: aliasing it in would
  // silently enable inbound dispatch, which is a separate owner
  // decision, so inbound handling stays untouched (fail-closed 503
  // when unset, 401 on a wrong token, at the A2A edge).
  const token =
    (e.CFPAY_OUTBOUND_TOKEN as string) ||
    (e.DASHBOARD_API_KEY_IS_A2A_TOKEN as string) ||
    (e.CFPAY_A2A_TOKEN as string);
  if (!token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

export interface A2AOperationResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * Stable local failure code when ok is false and the failure is a
   * DELIVERY condition rather than a network throw, so a caller can
   * branch on it without parsing the message: `cfpay_http_error` (the
   * agent answered a non-2xx status) or `cfpay_no_delivery_receipt`
   * (the agent answered, but reported no outcome at all).
   */
  code?: string;
}

/**
 * Invoke a structured operation on one of cfpay's A2A agents.
 * Sends a message with a `data` part: { operation, ...args }.
 * Never throws — returns { ok: false, error } on failure.
 */
export type CfpayAgentPath =
  | "/a2a"
  | "/a2a/payments"
  | "/a2a/email"
  | "/a2a/webhooks"
  | "/a2a/slack"
  | "/a2a/qa"
  | "/a2a/chat"
  | "/a2a/voice"
  | "/a2a/search"
  | "/a2a/orchestrator"
  | "/a2a/scheduled"
  | "/a2a/autopilot";

export async function cfpayA2AOperation(
  config: CfpayA2AConfig,
  agentPath: CfpayAgentPath,
  operation: string,
  args: Record<string, unknown> = {}
): Promise<A2AOperationResult> {
  try {
    const res = await fetch(`${config.baseUrl}${agentPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "message/send",
        params: {
          message: {
            kind: "message",
            role: "user",
            messageId: `cfagent-${Date.now()}`,
            parts: [
              { kind: "data", data: { operation, ...args } },
            ],
          },
        },
      }),
    });

    if (!res.ok) {
      return {
        ok: false,
        code: "cfpay_http_error",
        error:
          `cfpay A2A answered HTTP ${res.status} on ${agentPath} for "${operation}": the operation was not ` +
          `confirmed delivered. Check the cfpay deployment and its inbound credential.`,
      };
    }

    const data = (await res.json()) as any;
    // The agent returns { text, data } via an artifact-update; the SDK
    // surfaces it in the task result. Extract the data part.
    const result = data?.result;
    const artifacts = result?.artifacts || [];
    for (const a of artifacts) {
      for (const p of a.parts || []) {
        if (p.kind === "data" && p.data && typeof p.data === "object") {
          const d = p.data as { ok?: boolean; error?: string };
          return { ok: d.ok !== false, data: p.data, error: d.error };
        }
      }
    }
    // Fallback: check history for a data part.
    const history = result?.history || [];
    for (const m of history) {
      for (const p of m.parts || []) {
        if (p.kind === "data" && p.data && typeof p.data === "object") {
          const d = p.data as { ok?: boolean; error?: string };
          return { ok: d.ok !== false, data: p.data, error: d.error };
        }
      }
    }
    // The agent answered 2xx but reported no outcome at all. Delivery
    // is therefore UNKNOWN, not failed and not delivered — say so, and
    // keep the protocol detail in-band so the cause stays traceable.
    return {
      ok: false,
      code: "cfpay_no_delivery_receipt",
      error:
        `cfpay accepted "${operation}" on ${agentPath} but returned no delivery receipt ` +
        `(no_data_part_in_response): the notification agent reported no outcome, so delivery is ` +
        `unconfirmed rather than successful. Check that the cfpay notification agent is deployed ` +
        `and the destination channel is configured.`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Post to Slack via cfpay. Channel is optional (falls back to webhook).
 */
export async function cfpayPostToSlack(
  config: CfpayA2AConfig,
  text: string,
  channel?: string
): Promise<A2AOperationResult> {
  return cfpayA2AOperation(config, "/a2a/slack", "slack.post", {
    text,
    ...(channel ? { channel } : {}),
  });
}

/**
 * Post a file (PDF) to Slack via cfpay A2A (issue #331).
 * Uses the slack.postFile operation added to cfpay's Slack agent.
 */
export async function cfpayPostFileToSlack(
  config: CfpayA2AConfig,
  args: {
    channel: string;
    filename: string;
    contentB64: string;
    title?: string;
    initial_comment?: string;
  }
): Promise<A2AOperationResult> {
  return cfpayA2AOperation(config, "/a2a/slack", "slack.postFile", {
    channel: args.channel,
    filename: args.filename,
    contentB64: args.contentB64,
    ...(args.title ? { title: args.title } : {}),
    ...(args.initial_comment ? { initial_comment: args.initial_comment } : {}),
  });
}

/**
 * Send email via cfpay.
 */
export async function cfpaySendEmail(
  config: CfpayA2AConfig,
  to: string,
  subject: string,
  body: string
): Promise<A2AOperationResult> {
  return cfpayA2AOperation(config, "/a2a/email", "email.send", {
    to,
    subject,
    body,
  });
}

/**
 * Send email with attachments via cfpay A2A (issue #384).
 * Mirrors cfpayPostFileToSlack for email delivery.
 */
export async function cfpaySendEmailWithAttachments(
  config: CfpayA2AConfig,
  args: {
    to: string;
    subject: string;
    body: string;
    attachments: Array<{
      filename: string;
      contentB64: string;
      contentType?: string;
    }>;
  }
): Promise<A2AOperationResult> {
  return cfpayA2AOperation(config, "/a2a/email", "email.sendWithAttachments", {
    to: args.to,
    subject: args.subject,
    body: args.body,
    attachments: args.attachments,
  });
}
