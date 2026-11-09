/**
 * Phase 5 Slice 1 (issue #2000) — DLQ operator routes.
 *
 * Two operator-only routes, dispatched by the orchestrator
 * thin router (see the inventory test):
 * - GET records: un-replayed dead-letter rows, newest first.
 * - POST replay: re-drive one record to its source queue.
 *
 * The gate mirrors the commercial operator routes: the
 * x-user-login header (session-verified by server.ts, #1156)
 * against env COMMERCIAL_STORE_OPERATORS UNION the store
 * operator list (#2680; unbound store degrades to env-only,
 * never a 500, never a lockout). Non-operators get 403, never
 * a separate 401. An unbound DLQ store yields 503: the
 * operator cannot list or replay what cannot be verified.
 *
 * Route handlers take parsed inputs, never match paths:
 * helpers live above the handler so the thin-router inventory
 * scan (handler export to the next export) sees exactly the
 * two conditions in this file, in order.
 */
import { resolveDlqDepthAlertThreshold } from "../../config/dlqDepthAlert";
import { createDeadLetterStoreAdapter, ensureDeadLetterStoreSchema, type DeadLetterStoreDb } from "../../data/createDeadLetterStorePorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import { maybeAlertDlqDepth } from "../../messaging/dlqDepthAlert";
import { replayDeadLetter, type ReplaySender } from "../../messaging/deadLetterReplay";
import type { DeadLetterStore } from "../../messaging/deadLetterStorePorts";
import { postSlackText, resourceSlackPost } from "../resourceGoals";
import type { SlackDeliveryEnv } from "../social/delivery";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/dlq",
});

export interface DlqRouteContext {
  env: unknown;
  /** Test seam: production builds the store from env.AGENT_DB. */
  store?: DeadLetterStore | null;
  /** Test seam: production builds senders from the env queue bindings. */
  senders?: Record<string, ReplaySender>;
  /** Test seam: production binds postSlackText over the worker fetch. */
  sendAlert?: (text: string) => Promise<void>;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function envOperatorLogins(env: unknown): Set<string> {
  const raw = (env as Record<string, unknown>)["COMMERCIAL_STORE_OPERATORS"];
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Effective operators: env list UNION store list, env-only on any store failure. */
async function isDlqOperator(env: unknown, login: string | null): Promise<boolean> {
  if (!login) return false;
  if (envOperatorLogins(env).has(login)) return true;
  try {
    const adapter = createStoreOperatorsAdapter(env as { AGENT_DB?: unknown });
    if (!adapter) return false;
    const entries = await adapter.listOperators();
    return entries.some((entry) => entry.login === login);
  } catch {
    return false;
  }
}

function sendersFromEnv(env: unknown): Record<string, ReplaySender> {
  const bindings = env as Record<string, { send?: (body: unknown) => Promise<void> } | undefined>;
  const senders: Record<string, ReplaySender> = {};
  for (const queue of ["screener-events", "screener-events-delivery"]) {
    const binding = bindings[queue === "screener-events" ? "SCREENER_EVENTS" : "SCREENER_EVENTS_DELIVERY"];
    const send = binding?.send;
    if (typeof send === "function") senders[queue] = { send };
  }
  return senders;
}

export async function handleDlqRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: DlqRouteContext,
): Promise<Response | null> {
  void url;
  void sessionId;
  if (path.endsWith("/api/ops/dlq/records") && request.method === "GET") {
    const login = request.headers.get("x-user-login")?.trim() || null;
    if (!(await isDlqOperator(ctx.env, login))) {
      return new Response("Forbidden: store operator required.", { status: 403 });
    }
    const store = ctx.store ?? createDeadLetterStoreAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!store) return json({ error: "Dead-letter store is not bound." }, 503);
    try {
      const db = (store as { db?: DeadLetterStoreDb }).db;
      if (db) await ensureDeadLetterStoreSchema(db);
    } catch {
      return json({ error: "Dead-letter store schema could not be ensured." }, 503);
    }
    // Issue #3907: the list call is the branch's only unguarded
    // await — a store failure here surfaced as a bare 5xx the
    // panel could not parse (its "could not be loaded" text).
    // Every failure returns {error} JSON, never a bare 500.
    let records;
    try {
      records = await store.listUnreplayed(100);
    } catch (error) {
      structuredLog.error("dlq.list_records_failed", {
        message: "[dlq] dead-letter records could not be listed:",
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ error: "Dead-letter records could not be listed." }, 500);
    }
    return json({ records }, 200);
  }
  if (path.endsWith("/api/ops/dlq/replay") && request.method === "POST") {
    const login = request.headers.get("x-user-login")?.trim() || null;
    if (!(await isDlqOperator(ctx.env, login))) {
      return new Response("Forbidden: store operator required.", { status: 403 });
    }
    const store = ctx.store ?? createDeadLetterStoreAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!store) return json({ error: "Dead-letter store is not bound." }, 503);
    try {
      const db = (store as { db?: DeadLetterStoreDb }).db;
      if (db) await ensureDeadLetterStoreSchema(db);
    } catch {
      return json({ error: "Dead-letter store schema could not be ensured." }, 503);
    }
    const body = (await request.json().catch(() => null)) as { recordId?: unknown } | null;
    if (!body || typeof body.recordId !== "string" || !body.recordId) {
      return json({ error: "recordId is required." }, 400);
    }
    const senders = ctx.senders ?? sendersFromEnv(ctx.env);
    // Issue #3907: same {error}-JSON guarantee as the records
    // branch above — a replay failure never surfaces as a bare 500.
    let result;
    try {
      result = await replayDeadLetter({ store, senders, nowMs: Date.now() }, body.recordId);
    } catch (error) {
      structuredLog.error("dlq.replay_failed", {
        message: "[dlq] dead-letter replay failed:",
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ error: "Dead-letter replay failed." }, 500);
    }
    if (!result.ok) {
      if (result.code === "unknown_record") return json({ error: "Unknown dead-letter record.", code: result.code }, 404);
      if (result.code === "send_failed") return json({ error: "Re-drive to the source queue failed; the record is still un-replayed.", code: result.code }, 502);
      return json({ error: `Record cannot be replayed: ${result.code}.`, code: result.code }, 400);
    }
    // A successful replay may drop the depth below threshold:
    // clear the incident promptly instead of waiting for the
    // next landing. Never fails the replay response.
    try {
      const sendAlert =
        ctx.sendAlert ??
        (async (text: string) => {
          await postSlackText({ post: resourceSlackPost, env: ctx.env as SlackDeliveryEnv, text });
        });
      await maybeAlertDlqDepth({
        store,
        threshold: resolveDlqDepthAlertThreshold(ctx.env as Record<string, unknown>),
        sendAlert,
        nowMs: Date.now(),
      });
    } catch (err) {
      structuredLog.warn("dlq.post_replay_depth_check_failed", {
        message: "[dlq] post-replay depth check failed (replay stands):",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return json({ record: result.record }, 200);
  }
  return null;
}
