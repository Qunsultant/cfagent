/**
 * Issue #3311 — webhook-triggered scheduling: the Worker-edge ingress
 * for POST /api/schedules/webhook/followup.
 *
 * A workflow step calls this route; ScheduledAgent's follow-up is
 * minted on the async-job chain by the OrchestratorAgent DO route
 * (src/agents/routes/schedules.ts) through the one submitAsyncJob
 * minter. This module is the single-owner edge handler, following
 * the NLQ webhook precedent (src/server/routes/messaging.ts,
 * handleNlqWebhookRequest) exactly:
 *
 *  1. Per-source-IP throttle, before touching the body.
 *  2. 503 when INBOUND_SCHEDULE_WEBHOOK_SECRET is not configured
 *     (fail-closed, #140: an unconfigured verifier never verifies).
 *  3. 128 KB body cap (413).
 *  4. HMAC-SHA256 over the raw body (any known carrier spelling via
 *     pickWebhookSignature); missing/invalid → 401.
 *  5. Zod shape validation (400).
 *  6. 5-minute timestamp window (401, same message as the NLQ route).
 *  7. Nonce replay claim, 24h TTL (409 on a replayed delivery).
 *  8. Forward a REBUILT request to the asserted owner's
 *     OrchestratorAgent instance — validated body only, with
 *     x-user-login stamped from the verified body and the
 *     x-schedule-webhook edge marker. No signature or secret header
 *     ever reaches the DO, and the DO route refuses calls without
 *     the marker. The DO's response is returned as-is (its non-OK
 *     responses included — the NLQ precedent).
 *
 * Trust model (recorded for review): the HMAC secret is
 * platform-held — our own workflows and operator-configured callers.
 * The signed body asserts userLogin, the run-as owner (#2331); the
 * edge stamps it, never a caller header, and the DO route
 * PDP-authorizes that principal for task:create (#3122).
 */
import type { Env } from "../../types";
import { verifyHmacSha256Signature } from "../../security/webhookSecurity";
import { pickWebhookSignature } from "../../api/ingress";
import { scheduleWebhookFollowupBodySchema } from "../../api/ingressSchemas";
import {
  deriveScheduleWebhookNonce,
  sharedMemoryReplayStore,
} from "../../security/webhookReplay";
import { actorGateway } from "../../services/cloudflareActorGateway";

/** The one canonical spelling for the schedule webhook (no legacy aliases). */
export const SCHEDULE_WEBHOOK_ROUTE = "/api/schedules/webhook/followup";

/** Edge marker the DO route requires: a call that did not pass this handler is refused. */
export const SCHEDULE_WEBHOOK_EDGE_MARKER = "1";

export interface ScheduleWebhookHandlerDeps {
  /** Injectable dispatch for tests; defaults to the real actor gateway. */
  dispatch?: (userLogin: string, request: Request) => Promise<Response>;
  /** Injectable replay store for tests; defaults to the shared memory store. */
  replayStore?: { claim(nonce: string, source: string, ttlMs?: number): Promise<boolean> };
  /** Injectable clock for tests; defaults to Date.now. */
  nowMs?: () => number;
}

export async function handleScheduleWebhookRequest(
  request: Request,
  env: Env,
  throttle: (route: string, maxRequests: number, windowMs: number) => Response | null,
  deps: ScheduleWebhookHandlerDeps = {},
): Promise<Response> {
  const limited = throttle("schedule_webhook", 30, 60_000);
  if (limited) return limited;
  if (!env.INBOUND_SCHEDULE_WEBHOOK_SECRET) {
    return Response.json(
      { error: "INBOUND_SCHEDULE_WEBHOOK_SECRET is not configured." },
      { status: 503 },
    );
  }
  const rawBody = await request.text();
  if (rawBody.length > 128_000) {
    return Response.json({ error: "Webhook payload exceeds 128 KB." }, { status: 413 });
  }
  const pickedSignature = pickWebhookSignature(request.headers);
  const isValid = await verifyHmacSha256Signature(
    rawBody,
    pickedSignature?.value ?? null,
    env.INBOUND_SCHEDULE_WEBHOOK_SECRET,
  );
  if (!isValid) {
    return Response.json({ error: "Invalid schedule webhook signature." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const shaped = scheduleWebhookFollowupBodySchema.safeParse(body);
  if (!shaped.success) {
    const field = shaped.error.issues[0]?.path[0];
    if (field === "timestamp") {
      return Response.json({ error: "Webhook timestamp is missing, invalid, or expired." }, { status: 401 });
    }
    if (field === "userLogin") {
      return Response.json({ error: "userLogin must be a login-shaped string." }, { status: 400 });
    }
    if (field === "capability") {
      return Response.json(
        { error: "capability must be followup.report, followup.deliver, or followup.notify." },
        { status: 400 },
      );
    }
    return Response.json({ error: "Webhook body is invalid." }, { status: 400 });
  }
  const validBody = shaped.data;
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  if (
    typeof validBody.timestamp !== "string" ||
    !Number.isFinite(Date.parse(validBody.timestamp)) ||
    Math.abs(nowMs - Date.parse(validBody.timestamp)) > 5 * 60 * 1000
  ) {
    return Response.json({ error: "Webhook timestamp is missing, invalid, or expired." }, { status: 401 });
  }
  const nonce = await deriveScheduleWebhookNonce(pickedSignature?.value ?? null, rawBody);
  const replayStore = deps.replayStore ?? sharedMemoryReplayStore();
  if (await replayStore.claim(nonce, "schedule-webhook")) {
    return Response.json(
      { error: "Duplicate schedule webhook event rejected (replay protection)." },
      { status: 409 },
    );
  }
  const userLogin = validBody.userLogin;
  const target = new URL("/schedules/webhook/followup", "https://agent.internal");
  const forwarded = new Request(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-login": userLogin,
      "x-schedule-webhook": SCHEDULE_WEBHOOK_EDGE_MARKER,
    },
    body: JSON.stringify(validBody),
  });
  const dispatch =
    deps.dispatch ??
    ((login: string, req: Request) => actorGateway.dispatch(env.ORCHESTRATOR_AGENT, login, req));
  return dispatch(userLogin, forwarded);
}

/**
 * Worker dispatch branch for the schedule webhook. Returns null when
 * the path does not match, so handleFetch falls through exactly as
 * the other route families do.
 */
export async function handleScheduleWebhookRoutes(
  request: Request,
  env: Env,
  _url: URL,
  path: string,
  throttle: (route: string, maxRequests: number, windowMs: number) => Response | null,
): Promise<Response | null> {
  if (path === SCHEDULE_WEBHOOK_ROUTE && request.method === "POST") {
    return handleScheduleWebhookRequest(request, env, throttle);
  }
  return null;
}
