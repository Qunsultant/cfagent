/**
 * Issue #5081 (S1, observability program #5080) — the OTLP
 * ingestion HTTP route: POST /api/otel/v1/logs.
 *
 * A real HTTP endpoint for external OTLP senders (a future
 * Collector, Cloudflare's automatic tracing export, or any
 * OTLP/HTTP client). The Worker-side SDK uses the same handler
 * in-process (the transport calls handleOtelLogsIngestion
 * directly — a real HTTP POST to the Worker's own domain returns
 * Cloudflare 522 in production).
 *
 * Safety: the route is DISABLED (404) unless the OTEL_INGEST_TOKEN
 * secret is set (an owner step: `wrangler secret put
 * OTEL_INGEST_TOKEN`), and requires `Authorization: Bearer
 * <token>` when it is. An unauthenticated ingestion endpoint
 * could be used to fill R2. The token is a secret, never in
 * wrangler.jsonc and never in the repo. The in-process transport
 * bypasses HTTP auth (it calls the handler directly, not over
 * HTTP), so S1's J1–J7 logging works without the token; the
 * token only gates the external HTTP surface.
 */

import type { Env } from "../../types";
import { createBlobStore } from "../../services/blobStoreR2Adapter";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { createStructuredLogger } from "../../observability/structuredLogger";
import {
  createOtelIngestionLog,
  handleOtelLogsIngestion,
  handleOtelMetricsIngestion,
  handleOtelTracesIngestion,
} from "../../observability/otelIngestion";

/** The OTLP ingestion route path (logs). */
export const OTEL_INGESTION_ROUTE = "/api/otel/v1/logs" as const;

/** Issue #5082 (S2) — the OTLP metrics ingestion route path. */
export const OTEL_METRICS_INGESTION_ROUTE = "/api/otel/v1/metrics" as const;

/** Issue #2808 (S3) — the OTLP traces ingestion route path. */
export const OTEL_TRACES_INGESTION_ROUTE = "/api/otel/v1/traces" as const;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The OTel ingestion route handler (the server.ts dispatch
 * shape: returns a Response when the path matches, null to
 * fall through to the next handler). Handles the logs route
 * (POST /api/otel/v1/logs), the metrics route (POST
 * /api/otel/v1/metrics, issue #5082 S2), and the traces route
 * (POST /api/otel/v1/traces, issue #2808 S3) under the same
 * OTEL_INGEST_TOKEN gate.
 */
export async function handleOtelRoutes(
  request: Request,
  env: Env,
  _url: URL,
  path: string,
): Promise<Response | null> {
  if (
    path !== OTEL_INGESTION_ROUTE &&
    path !== OTEL_METRICS_INGESTION_ROUTE &&
    path !== OTEL_TRACES_INGESTION_ROUTE
  )
    return null;

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const token = env.OTEL_INGEST_TOKEN?.trim();
  if (!token) {
    // No token configured: the external HTTP surface is disabled.
    return new Response("Not Found", { status: 404 });
  }

  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization !== `Bearer ${token}`) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  // The ingestion fallback writes through the structured logger
  // over the BASE sink only (never the OTel sink — a fallback
  // record must not re-enter the OTel pipeline).
  const structuredLog = createStructuredLogger(createObservabilitySink(env), {
    component: "otel-ingestion",
  });
  // Issue #5082 (S2): the metrics route hands the OTLP metrics
  // payload to the metrics ingestion handler; the logs route
  // keeps the logs handler.
  if (path === OTEL_METRICS_INGESTION_ROUTE) {
    const result = await handleOtelMetricsIngestion({
      body,
      blobStore: createBlobStore(env),
      log: createOtelIngestionLog(structuredLog),
    });
    return jsonResponse(result.status, {
      received: result.received,
      stored: result.stored,
      ...(result.key ? { key: result.key } : {}),
      ...(result.fallback ? { fallback: result.fallback } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.code ? { code: result.code } : {}),
    });
  }
  // Issue #2808 (S3): the traces route hands the OTLP traces
  // payload to the traces ingestion handler.
  if (path === OTEL_TRACES_INGESTION_ROUTE) {
    const result = await handleOtelTracesIngestion({
      body,
      blobStore: createBlobStore(env),
      log: createOtelIngestionLog(structuredLog),
    });
    return jsonResponse(result.status, {
      received: result.received,
      stored: result.stored,
      ...(result.key ? { key: result.key } : {}),
      ...(result.fallback ? { fallback: result.fallback } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.code ? { code: result.code } : {}),
    });
  }
  const result = await handleOtelLogsIngestion({
    body,
    blobStore: createBlobStore(env),
    log: createOtelIngestionLog(structuredLog),
  });
  return jsonResponse(result.status, {
    received: result.received,
    stored: result.stored,
    ...(result.key ? { key: result.key } : {}),
    ...(result.fallback ? { fallback: result.fallback } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.code ? { code: result.code } : {}),
  });
}
