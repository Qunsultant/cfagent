/**
 * Issue #2808 (S3, observability program #5080) — the OTLP
 * traces ingestion HTTP route: POST /api/otel/v1/traces.
 *
 * A real HTTP endpoint for external OTLP senders, under the
 * same OTEL_INGEST_TOKEN gate as the logs and metrics routes:
 * the route is DISABLED (404) unless the token secret is set,
 * and requires `Authorization: Bearer <token>` when it is.
 * The Worker-side SDK uses the same handler in-process (the
 * transport calls handleOtelTracesIngestion directly), so
 * S3's J1–J7 span recording works without the token; the
 * token only gates the external HTTP surface.
 *
 * TDD Red first: OTEL_TRACES_INGESTION_ROUTE in
 * src/server/routes/otel.ts does not exist yet, so this file
 * fails at import.
 */
import { describe, it, expect } from "vitest";
import {
  OTEL_TRACES_INGESTION_ROUTE,
  handleOtelRoutes,
} from "../src/server/routes/otel";
import type { Env } from "../src/types";

const TOKEN = "test-ingest-token";

/** A minimal valid ExportTraceServiceRequest with one span. */
function tracesBody() {
  return JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "d0cdb8dfb8975b76faa869258aa19991",
                spanId: "6c423a69d362c7af",
                name: "job.stage.step",
                startTimeUnixNano: "1794956615912000000",
                endTimeUnixNano: "1794956615912423605",
              },
            ],
          },
        ],
      },
    ],
  });
}

function envWithToken(token: string | undefined): Env {
  return { OTEL_INGEST_TOKEN: token } as unknown as Env;
}

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/otel/v1/traces — the traces ingestion route", () => {
  it("exposes the traces route path", () => {
    expect(OTEL_TRACES_INGESTION_ROUTE).toBe("/api/otel/v1/traces");
  });

  it("returns 404 when no OTEL_INGEST_TOKEN is configured (external surface disabled)", async () => {
    const res = await handleOtelRoutes(
      post(OTEL_TRACES_INGESTION_ROUTE, tracesBody()),
      envWithToken(undefined),
      new URL(`https://example.test${OTEL_TRACES_INGESTION_ROUTE}`),
      OTEL_TRACES_INGESTION_ROUTE,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await handleOtelRoutes(
      post(OTEL_TRACES_INGESTION_ROUTE, tracesBody()),
      envWithToken(TOKEN),
      new URL(`https://example.test${OTEL_TRACES_INGESTION_ROUTE}`),
      OTEL_TRACES_INGESTION_ROUTE,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns 401 with a wrong Bearer token", async () => {
    const res = await handleOtelRoutes(
      post(OTEL_TRACES_INGESTION_ROUTE, tracesBody(), {
        Authorization: "Bearer wrong-token",
      }),
      envWithToken(TOKEN),
      new URL(`https://example.test${OTEL_TRACES_INGESTION_ROUTE}`),
      OTEL_TRACES_INGESTION_ROUTE,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("accepts a valid OTLP traces payload with the right Bearer token (202, R2 unbound falls back)", async () => {
    const res = await handleOtelRoutes(
      post(OTEL_TRACES_INGESTION_ROUTE, tracesBody(), {
        Authorization: `Bearer ${TOKEN}`,
      }),
      envWithToken(TOKEN),
      new URL(`https://example.test${OTEL_TRACES_INGESTION_ROUTE}`),
      OTEL_TRACES_INGESTION_ROUTE,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.received).toBe(1);
    // No R2 binding in this env: the ingestion falls back to the structured log.
    expect(body.stored).toBe(false);
    expect(body.fallback).toBe("console");
  });

  it("rejects a malformed OTLP traces payload with 400", async () => {
    const res = await handleOtelRoutes(
      post(OTEL_TRACES_INGESTION_ROUTE, "{not json", {
        Authorization: `Bearer ${TOKEN}`,
      }),
      envWithToken(TOKEN),
      new URL(`https://example.test${OTEL_TRACES_INGESTION_ROUTE}`),
      OTEL_TRACES_INGESTION_ROUTE,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("OBS-1004");
  });

  it("returns 405 for a non-POST method", async () => {
    const res = await handleOtelRoutes(
      new Request(`https://example.test${OTEL_TRACES_INGESTION_ROUTE}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      envWithToken(TOKEN),
      new URL(`https://example.test${OTEL_TRACES_INGESTION_ROUTE}`),
      OTEL_TRACES_INGESTION_ROUTE,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(405);
  });

  it("returns null for an unrelated path (falls through to the next handler)", async () => {
    const res = await handleOtelRoutes(
      post("/api/otel/v1/unknown", "{}"),
      envWithToken(TOKEN),
      new URL("https://example.test/api/otel/v1/unknown"),
      "/api/otel/v1/unknown",
    );
    expect(res).toBeNull();
  });
});
