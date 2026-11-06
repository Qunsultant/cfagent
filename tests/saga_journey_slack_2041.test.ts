/**
 * Issue #2041 S2 — Slack journey-gate buttons: approve/deny
 * dispatch through ETradeSlackTradingService.processSlackInteraction.
 *
 * Direct-call tests (same shape as the approve_trade cases in
 * browser_and_slack_agents.test.ts): principal undefined, so no
 * tier gate; the decider login is the session id. The audit stub
 * is a fake ORCHESTRATOR_AGENT binding; the saga binding is a fake
 * SAGA_WORKFLOW binding; response_url edits go through a stubbed
 * fetch.
 *
 * Invariants pinned here:
 * - approve/deny on a pending own gate → decided, exact event
 *   payload (surface slack), and a response_url edit (the
 *   Slack-surface cleanup on the decide path);
 * - an already-decided gate → superseded, never a second decision;
 * - a foreign gate → error, never delivered (no cross-user leak);
 * - an unbound saga binding → error, never a silent drop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import type { AuditOwnerStub } from "../src/workflows/sagaJourneyGate";

const TEAM_ID = "T_JOURNEY";

let sql: MockSqlStorage;
let orm: DatabaseORM;

beforeEach(() => {
  sql = new MockSqlStorage();
  orm = new DatabaseORM(sql);
  orm.initializeSchema(`slack_${TEAM_ID}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function promptedEvent(sagaId: string, userLogin: string) {
  return {
    type: "saga.journey_prompted",
    agent: "saga",
    payload: { sagaId, runRequestId: `run-${sagaId}`, userLogin, family: "goal", rail: "stripe" },
    created_at: "2026-10-31T00:00:00Z",
  };
}

function decidedEvent(sagaId: string, surface: string) {
  return {
    type: "saga.journey_decided",
    agent: "saga",
    payload: { sagaId, decidingSurface: surface },
    created_at: "2026-10-31T01:00:00Z",
  };
}

function auditStub(prompted: Array<Record<string, unknown>>, decided: Array<Record<string, unknown>>): AuditOwnerStub {
  return {
    fetch: async (req: Request) => {
      const type = new URL(req.url).searchParams.get("type");
      return Response.json({ events: type === "saga.journey_prompted" ? prompted : decided });
    },
  };
}

function serviceFor(opts: {
  stub: AuditOwnerStub;
  sagaGet?: (id: string) => Promise<unknown>;
}): { service: ETradeSlackTradingService; sentEvents: Array<{ type: string; payload: unknown }> } {
  const sentEvents: Array<{ type: string; payload: unknown }> = [];
  const env = {
    ORCHESTRATOR_AGENT: { idFromName: () => "stub-id", get: () => opts.stub },
    SAGA_WORKFLOW: opts.sagaGet
      ? {
          get: async (id: string) => opts.sagaGet!(id),
        }
      : undefined,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "test-secret",
  } as unknown as Env;
  const service = new ETradeSlackTradingService(env, orm, TEAM_ID, undefined);
  return { service, sentEvents };
}

function runningSagaInstance(sentEvents: Array<{ type: string; payload: unknown }>) {
  return {
    status: async () => ({ status: "running" }),
    sendEvent: async (ev: { type: string; payload: unknown }) => {
      sentEvents.push(ev);
    },
  };
}

function journeyPayload(actionId: string, sagaId: string) {
  return {
    type: "block_actions",
    user: { id: "U_DECIDE", username: "decider" },
    channel: { id: "C_FLOOR" },
    actions: [{ action_id: actionId, value: sagaId }],
    response_url: "https://hooks.slack.com/commands/decision-hook",
  };
}

function stubFetchOk() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "ok",
    json: async () => ({ ok: true }),
  } as never);
}

describe("Slack journey-gate buttons (S2, #2041)", () => {
  it("approve on a pending own gate decides, sends the exact event, and edits the original", async () => {
    const fetchSpy = stubFetchOk();
    const sentEvents: Array<{ type: string; payload: unknown }> = [];
    const { service } = serviceFor({
      stub: auditStub([promptedEvent("saga-1", TEAM_ID)], []),
      sagaGet: async () => runningSagaInstance(sentEvents),
    });
    const result = await service.processSlackInteraction(journeyPayload("saga_journey_approve", "saga-1"));
    expect(result.success).toBe(true);
    expect(result.status).toBe("decided");
    expect(result.message).toContain("Journey approved");
    expect(result.message).toContain("its own approval");
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toEqual({
      type: "saga-journey-decision",
      payload: { sagaId: "saga-1", decision: "approved", deciderLogin: TEAM_ID, surface: "slack" },
    });
    // The response_url edit IS the Slack-surface cleanup on decide.
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("decision-hook"))).toBe(true);
  });

  it("deny on a pending own gate decides with no trades and no proposals", async () => {
    stubFetchOk();
    const sentEvents: Array<{ type: string; payload: unknown }> = [];
    const { service } = serviceFor({
      stub: auditStub([promptedEvent("saga-1", TEAM_ID)], []),
      sagaGet: async () => runningSagaInstance(sentEvents),
    });
    const result = await service.processSlackInteraction(journeyPayload("saga_journey_deny", "saga-1"));
    expect(result.success).toBe(true);
    expect(result.status).toBe("decided");
    expect(result.message).toContain("Journey declined");
    expect(sentEvents[0].payload).toEqual({
      sagaId: "saga-1",
      decision: "denied",
      deciderLogin: TEAM_ID,
      surface: "slack",
    });
  });

  it("an already-decided gate is refused as superseded, never a second decision", async () => {
    stubFetchOk();
    const sentEvents: Array<{ type: string; payload: unknown }> = [];
    const { service } = serviceFor({
      stub: auditStub([], [decidedEvent("saga-1", "panel")]),
      sagaGet: async () => runningSagaInstance(sentEvents),
    });
    const result = await service.processSlackInteraction(journeyPayload("saga_journey_approve", "saga-1"));
    expect(result.success).toBe(false);
    expect(result.status).toBe("superseded");
    expect(result.message).toContain("Already decided (by panel)");
    expect(sentEvents).toHaveLength(0);
  });

  it("a foreign gate is refused, never delivered", async () => {
    stubFetchOk();
    const sentEvents: Array<{ type: string; payload: unknown }> = [];
    const { service } = serviceFor({
      stub: auditStub([promptedEvent("saga-1", "someone-else")], []),
      sagaGet: async () => runningSagaInstance(sentEvents),
    });
    const result = await service.processSlackInteraction(journeyPayload("saga_journey_approve", "saga-1"));
    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.message).toContain("No pending journey gate");
    expect(sentEvents).toHaveLength(0);
  });

  it("an unbound saga binding errors, never a silent drop", async () => {
    stubFetchOk();
    const { service } = serviceFor({
      stub: auditStub([promptedEvent("saga-1", TEAM_ID)], []),
    });
    const result = await service.processSlackInteraction(journeyPayload("saga_journey_approve", "saga-1"));
    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.message).toContain("could not be delivered");
  });
});
