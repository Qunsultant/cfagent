/**
 * Issue #3515 S2 — structured logging foundation (§2.2): the
 * observability event schema carries the 7 mandatory attributes.
 *
 * The slice 0 audit found the stream schema carrying only
 * trace_id / tenant_id / severity (traceId / tenantId / level),
 * with actor_id, agent_id, component, and timestamp_iso8601
 * absent. This file pins that EVERY event produced by the
 * observability-stream producers carries all seven:
 * trace_id, tenant_id, actor_id, agent_id, timestamp_iso8601,
 * severity, component — with timestamp_iso8601 derived from
 * timestampMs (one clock, never two) and absent scope recorded
 * as null, never fabricated.
 *
 * TDD red first: the schema has no actorId / agentId /
 * component / timestampIso fields yet, so every assertion here
 * fails until the implementation lands.
 */
import { describe, it, expect, vi } from "vitest";
import {
  foldEnvelopeToEvent,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "../src/observability/observabilityPorts";
import {
  withObservability,
  withRequestObservability,
} from "../src/observability/aspects";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import { eventToDataPoint } from "../src/observability/cfAnalyticsEngineAdapter";
import { toObservabilityEvent } from "../src/telemetry/resourceUsagePorts";
import { SinkForwardingTraceStore } from "../src/observability/meshTrace";
import type { MeshTraceHop, MeshTraceStore } from "../src/data/meshTracePorts";
import {
  MCP_PERMISSION_DENIED_CODE,
  authorizeMcpToolCall,
  createInMemoryMcpPermissionPort,
  type McpPrincipal,
  type McpScope,
} from "../src/mcps/openaimp/mcpPermissionPorts";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";

function envelope(
  over: Partial<MessageEnvelope> & { type: string },
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "evt-1",
    source: "test",
    time: "2026-10-26T00:00:00.000Z",
    data: {},
    ...over,
  };
}

/**
 * The §2.2 seven, as the TypeScript schema spells them
 * (camelCase, per the existing traceId / tenantId convention —
 * the audit maps trace_id → traceId, tenant_id → tenantId,
 * severity → level the same way).
 */
function assertSevenAttributes(event: ObservabilityEvent, label: string): void {
  expect(typeof event.traceId, `${label}: traceId present`).toBe("string");
  expect(
    event.tenantId === null || typeof event.tenantId === "string",
    `${label}: tenantId string|null`,
  ).toBe(true);
  expect(
    event.actorId === null || typeof event.actorId === "string",
    `${label}: actorId string|null`,
  ).toBe(true);
  expect(
    event.agentId === null || typeof event.agentId === "string",
    `${label}: agentId string|null`,
  ).toBe(true);
  expect(
    event.component === null || typeof event.component === "string",
    `${label}: component string|null`,
  ).toBe(true);
  expect(["info", "warn", "error"], `${label}: severity`).toContain(event.level);
  // One clock: the ISO string is the derivation of timestampMs.
  expect(event.timestampIso, `${label}: timestampIso`).toBe(
    new Date(event.timestampMs).toISOString(),
  );
}

describe("observability schema — 7 mandatory attributes on every event", () => {
  it("folded envelopes carry all 7, with component per family", () => {
    const cases: Array<{
      label: string;
      env: MessageEnvelope;
      component: string;
    }> = [
      {
        label: "telemetry.realization_recorded",
        component: "telemetry",
        env: envelope({
          type: "telemetry.realization_recorded",
          id: "telemetry-realization:tenant-a:run-1:SYM:struct",
          correlationid: "telemetry:run-1:SYM:struct",
          data: {
            tenantId: "tenant-a",
            outcomeId: "run-1:SYM:struct",
            agentKey: "research",
            structure: "struct",
            regime: "bull",
            directionCorrect: true,
            falsified: false,
          },
        }),
      },
      {
        label: "telemetry.calibration_proposed",
        component: "telemetry",
        env: envelope({
          type: "telemetry.calibration_proposed",
          data: {
            tenantId: "tenant-a",
            decisionId: "dec-1",
            actorKey: "research",
            dimension: "thesis",
            evaluated: 30,
            hits: 10,
          },
        }),
      },
      {
        label: "telemetry.calibration_applied",
        component: "telemetry",
        env: envelope({
          type: "telemetry.calibration_applied",
          data: { tenantId: "tenant-a", decisionId: "dec-1", actorKey: "research" },
        }),
      },
      {
        label: "breaker.state_changed",
        component: "breaker",
        env: envelope({
          type: "breaker.state_changed",
          data: { providerId: "yahoo", from: "closed", to: "open", trips: 3, fallbacks: 1 },
        }),
      },
      {
        label: "gateway.request_completed",
        component: "gateway",
        env: envelope({
          type: "gateway.request_completed",
          data: {
            model: "llama-3",
            provider: "workers-ai",
            cacheHit: false,
            attempts: 2,
            durationMs: 1234,
          },
        }),
      },
      {
        label: "retrieval.completed",
        component: "retrieval",
        env: envelope({
          type: "retrieval.completed",
          data: { denseCount: 5, graphCount: 2, degraded: false },
        }),
      },
      {
        label: "screener.completed",
        component: "screener",
        env: envelope({
          type: "screener.completed",
          data: { event: {}, ownerLogin: "tester" },
        }),
      },
      {
        label: "screener.failed",
        component: "screener",
        env: envelope({
          type: "screener.failed",
          data: { event: {}, ownerLogin: "tester" },
        }),
      },
      {
        label: "resource.sql_op",
        component: "resource",
        env: envelope({
          type: "resource.sql_op",
          traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
          data: {
            ns: "sessions",
            op: "get",
            rowsRead: 3,
            rowsWritten: 0,
            caller: "sessionStore",
            trigger: "user",
            tenantId: "tenant-a",
            runId: "run-1",
            sessionRef: "0123456789ab",
            durationMs: 12,
          },
        }),
      },
      {
        label: "screener.stage.feed_completed",
        component: "screener",
        env: envelope({
          type: "screener.stage.feed_completed",
          data: { tenantId: "tenant-a", runId: "run-1", count: 4 },
        }),
      },
      {
        label: "goal.gather.missed",
        component: "goal",
        env: envelope({
          type: "goal.gather.missed",
          data: { tenantId: "tenant-a", runId: "run-1", requested: 4, stored: 2, missing: 2 },
        }),
      },
    ];
    for (const { label, env, component } of cases) {
      const e = foldEnvelopeToEvent(env);
      expect(e, `${label} folds`).not.toBeNull();
      assertSevenAttributes(e!, label);
      expect(e!.component, `${label}: component`).toBe(component);
    }
  });

  it("folded telemetry promotes the whitelisted agent/actor key — nothing new enters the stream", () => {
    const realization = foldEnvelopeToEvent(
      envelope({
        type: "telemetry.realization_recorded",
        id: "telemetry-realization:tenant-a:run-1:SYM:struct",
        correlationid: "telemetry:run-1:SYM:struct",
        data: {
          tenantId: "tenant-a",
          outcomeId: "run-1:SYM:struct",
          agentKey: "research",
          structure: "struct",
          regime: "bull",
          directionCorrect: true,
          falsified: false,
        },
      }),
    );
    // agentKey was already whitelisted into fields; the promotion
    // moves it to the first-class agentId attribute — same content.
    expect(realization!.agentId).toBe("research");
    expect(realization!.fields.agentKey).toBe("research");
    expect(realization!.actorId).toBeNull();

    const calibration = foldEnvelopeToEvent(
      envelope({
        type: "telemetry.calibration_proposed",
        data: {
          tenantId: "tenant-a",
          decisionId: "dec-1",
          actorKey: "research",
          dimension: "thesis",
          evaluated: 30,
          hits: 10,
        },
      }),
    );
    expect(calibration!.actorId).toBe("research");
    expect(calibration!.fields.actorKey).toBe("research");
    expect(calibration!.agentId).toBeNull();
  });

  it("aspect events carry all 7; component is the caller's to name", async () => {
    const adapter = new InMemoryObservabilityAdapter();
    await withObservability(
      { sink: adapter, operation: "test.op", tenantId: "tenant-a", nowMs: () => 1_791_158_400_000 },
      async () => "ok",
    );
    expect(adapter.events).toHaveLength(1);
    assertSevenAttributes(adapter.events[0], "withObservability");
    // No component named by the caller: null, never fabricated.
    expect(adapter.events[0].component).toBeNull();
    expect(adapter.events[0].timestampIso).toBe("2026-10-05T00:00:00.000Z");

    adapter.clear();
    await withObservability(
      {
        sink: adapter,
        operation: "test.op",
        component: "screener-agent",
        nowMs: () => 1_791_158_400_000,
      },
      async () => "ok",
    );
    expect(adapter.events[0].component).toBe("screener-agent");
  });

  it("the HTTP boundary event carries all 7 with component http", async () => {
    const adapter = new InMemoryObservabilityAdapter();
    const wrapped = withRequestObservability(
      async () => new Response("ok", { status: 200 }),
      { sinkFor: () => adapter, nowMs: () => 1_791_158_400_000 },
    );
    const res = await wrapped(new Request("https://agent.internal/api/x"), {});
    expect(res.status).toBe(200);
    expect(adapter.events).toHaveLength(1);
    assertSevenAttributes(adapter.events[0], "http.request");
    expect(adapter.events[0].component).toBe("http");
    expect(adapter.events[0].actorId).toBeNull();
    expect(adapter.events[0].agentId).toBeNull();
  });

  it("the Analytics Engine datapoint carries the 4 new attributes as blobs", () => {
    const event: ObservabilityEvent = {
      type: "http.request",
      level: "info",
      operation: "http.request",
      tenantId: "tenant-a",
      actorId: "actor-1",
      agentId: "screener",
      component: "http",
      runId: "run-1",
      sessionRef: "abc123def456",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      timestampMs: 1_791_158_400_000,
      timestampIso: "2026-10-05T00:00:00.000Z",
      durationMs: 12,
      count: 1,
      fields: { method: "GET", status: 200 },
    };
    const point = eventToDataPoint(event);
    expect(point.indexes).toEqual(["tenant-a"]);
    expect(point.doubles).toEqual([12, 1]);
    // Blobs: the original eight, then actorId / agentId /
    // component / timestampIso, then the redacted fields JSON last.
    expect(point.blobs[0]).toBe("http.request");
    expect(point.blobs[1]).toBe("info");
    expect(point.blobs[2]).toBe("http.request");
    expect(point.blobs[3]).toBe("run-1");
    expect(point.blobs[4]).toBe("abc123def456");
    expect(point.blobs[5]).toBe("a".repeat(32));
    expect(point.blobs[6]).toBe("");
    expect(point.blobs[7]).toBe("actor-1");
    expect(point.blobs[8]).toBe("screener");
    expect(point.blobs[9]).toBe("http");
    expect(point.blobs[10]).toBe("2026-10-05T00:00:00.000Z");
    expect(JSON.parse(point.blobs[11])).toEqual({ method: "GET", status: 200 });
  });

  it("resource usage events carry all 7 with component resource-usage", () => {
    const e = toObservabilityEvent({
      ns: "sessions",
      op: "get",
      rowsRead: 3,
      rowsWritten: 0,
      caller: "sessionStore",
      trigger: "user",
      tenantId: "tenant-a",
      runId: "run-1",
      sessionRef: "0123456789ab",
      timestampMs: 1_791_158_400_000,
      durationMs: 12,
    });
    assertSevenAttributes(e, "resource.sql_op");
    expect(e.component).toBe("resource-usage");
    expect(e.timestampIso).toBe("2026-10-05T00:00:00.000Z");
    // Documented: resource events are emitted outside request
    // tracing, so the trace id stays empty — the follow-up that
    // stamps traceparents at service-layer call sites owns it.
    expect(e.traceId).toBe("");
  });

  it("mesh trace hops carry all 7 and promote the hop agent", async () => {
    const inner: MeshTraceStore = {
      record: async () => {},
      hopsFor: async () => [],
    };
    const adapter = new InMemoryObservabilityAdapter();
    const store = new SinkForwardingTraceStore(inner, adapter);
    const hop: MeshTraceHop = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      kind: "turn",
      operation: "chat.turn",
      timestampMs: 1_791_158_400_000,
      tenantId: "tenant-a",
      caller: "tester",
      agent: "OrchestratorAgent",
      jobId: "job-1",
    };
    await store.record(hop);
    expect(adapter.events).toHaveLength(1);
    const e = adapter.events[0];
    assertSevenAttributes(e, "mesh.trace.hop");
    expect(e.agentId).toBe("OrchestratorAgent");
    expect(e.component).toBe("mesh-trace");
    // The hop caller is a user login: it stays out of the stream
    // (the #1743 discipline), so actorId is null, not the login.
    expect(e.actorId).toBeNull();
    expect(e.timestampIso).toBe("2026-10-05T00:00:00.000Z");
  });

  it("MCP denial events carry all 7 with component mcp-permissions", async () => {
    const port = createInMemoryMcpPermissionPort({
      overrides: new Map<string, readonly McpScope[]>([
        ["api-key:reader", ["mcp:read"]],
      ]),
    });
    const principal: McpPrincipal = { kind: "api-key", login: "reader" };
    const events: ObservabilityEvent[] = [];
    const sink: ObservabilitySink = {
      write: (event) => {
        events.push(event);
      },
      writeBatch: (list) => {
        for (const event of list) events.push(event);
      },
    };
    await expect(
      authorizeMcpToolCall(port, principal, "draft_payment", {
        sessionId: "session_1",
        audit: vi.fn(),
        decisionSink: sink,
      }),
    ).rejects.toMatchObject({ code: MCP_PERMISSION_DENIED_CODE });
    expect(events).toHaveLength(1);
    assertSevenAttributes(events[0], "mcp.permission_denied");
    expect(events[0].component).toBe("mcp-permissions");
    // The principal identity stays in the audit trail, not the
    // stream: actor/agent are null on the denial event.
    expect(events[0].actorId).toBeNull();
    expect(events[0].agentId).toBeNull();
  });
});
