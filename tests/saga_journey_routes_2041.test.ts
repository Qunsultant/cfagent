/**
 * Issue #2041 S2 — saga journey routes: GET /api/saga/journey-gates
 * and POST /api/saga/journey-decision.
 *
 * Handler-level tests (no server, no session middleware): the
 * caller passes sessionLogin, mirroring the extracted-route
 * pattern. The audit stub is a fake ORCHESTRATOR_AGENT binding; the
 * saga binding is a fake SAGA_WORKFLOW binding.
 *
 * Invariants pinned here:
 * - absent login → 401, never a synthetic identity (#1185);
 * - GET lists only the session user's pending gates (decided
 *   gates drop out — that IS the panel/chat dismissal);
 * - POST validates sagaId/decision/surface (400), answers
 *   foreign or never-prompted gates 404 (no cross-user leak),
 *   decided gates 409 superseded with the winner, and accepted
 *   gates 200 with the exact event payload;
 * - unbound bindings and delivery failures → 503, never a
 *   silent drop; non-matching paths → null (caller keeps routing).
 */
import { describe, expect, it } from "vitest";
import { handleSagaJourneyRoutes } from "../src/agents/routes/sagaJourney";
import type { Env } from "../src/types";
import type { AuditOwnerStub } from "../src/workflows/sagaJourneyGate";

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

function envFor(opts: {
  stub?: AuditOwnerStub | null;
  sagaGet?: (id: string) => Promise<unknown>;
}): { env: Env; sentEvents: Array<{ type: string; payload: unknown }>; gotIds: string[] } {
  const sentEvents: Array<{ type: string; payload: unknown }> = [];
  const gotIds: string[] = [];
  const env = {
    ORCHESTRATOR_AGENT:
      opts.stub === null
        ? undefined
        : {
            idFromName: () => "stub-id",
            get: () => opts.stub as AuditOwnerStub,
          },
    SAGA_WORKFLOW: opts.sagaGet
      ? {
          get: async (id: string) => {
            gotIds.push(id);
            return opts.sagaGet!(id);
          },
        }
      : undefined,
  } as unknown as Env;
  return { env, sentEvents, gotIds };
}

function runningSagaInstance(sentEvents: Array<{ type: string; payload: unknown }>) {
  return {
    status: async () => ({ status: "running" }),
    sendEvent: async (ev: { type: string; payload: unknown }) => {
      sentEvents.push(ev);
    },
  };
}

async function postDecision(env: Env, login: string | null, body: Record<string, unknown>) {
  const req = new Request("https://agent.internal/api/saga/journey-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSagaJourneyRoutes(req, new URL(req.url), "/api/saga/journey-decision", env, login);
}

describe("GET /api/saga/journey-gates (S2, #2041)", () => {
  it("returns 401 without a session login", async () => {
    const { env } = envFor({ stub: auditStub([], []) });
    const req = new Request("https://agent.internal/api/saga/journey-gates");
    const res = await handleSagaJourneyRoutes(req, new URL(req.url), "/api/saga/journey-gates", env, null);
    expect(res?.status).toBe(401);
  });

  it("lists only the session user's pending gates, decided gates dropped out", async () => {
    const { env } = envFor({
      stub: auditStub(
        [promptedEvent("saga-1", "u1login"), promptedEvent("saga-2", "u1login"), promptedEvent("saga-3", "other")],
        [decidedEvent("saga-2", "panel")],
      ),
    });
    const req = new Request("https://agent.internal/api/saga/journey-gates");
    const res = await handleSagaJourneyRoutes(req, new URL(req.url), "/api/saga/journey-gates", env, "u1login");
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { gates: Array<{ sagaId: string; copy: { title: string } }> };
    expect(body.gates.map((g) => g.sagaId)).toEqual(["saga-1"]);
    expect(body.gates[0].copy.title).toBe("Enter the trading leg?");
  });

  it("returns 503 when ORCHESTRATOR_AGENT is unbound", async () => {
    const { env } = envFor({ stub: null });
    const req = new Request("https://agent.internal/api/saga/journey-gates");
    const res = await handleSagaJourneyRoutes(req, new URL(req.url), "/api/saga/journey-gates", env, "u1login");
    expect(res?.status).toBe(503);
  });

  it("returns 503 when the audit read fails", async () => {
    const { env } = envFor({
      stub: { fetch: async () => new Response("boom", { status: 500 }) },
    });
    const req = new Request("https://agent.internal/api/saga/journey-gates");
    const res = await handleSagaJourneyRoutes(req, new URL(req.url), "/api/saga/journey-gates", env, "u1login");
    expect(res?.status).toBe(503);
  });
});

describe("POST /api/saga/journey-decision (S2, #2041)", () => {
  it("returns 401 without a session login", async () => {
    const { env } = envFor({ stub: auditStub([], []) });
    const res = await postDecision(env, null, { sagaId: "saga-1", decision: "approved" });
    expect(res?.status).toBe(401);
  });

  it.each([
    [{ decision: "approved" }, "sagaId"],
    [{ sagaId: "saga-1", decision: "maybe" }, "decision"],
    [{ sagaId: "saga-1", decision: "approved", surface: "email" }, "surface"],
    [{ sagaId: "saga-1", decision: "approved", surface: "slack" }, "surface"],
  ])("returns 400 for an invalid body %s", async (body) => {
    const { env } = envFor({ stub: auditStub([promptedEvent("saga-1", "u1login")], []) });
    const res = await postDecision(env, "u1login", body);
    expect(res?.status).toBe(400);
  });

  it("accepts a pending own gate and sends the exact event (surface defaults to panel)", async () => {
    const sentEvents: Array<{ type: string; payload: unknown }> = [];
    const gotIds: string[] = [];
    const env = {
      ORCHESTRATOR_AGENT: { idFromName: () => "stub-id", get: () => auditStub([promptedEvent("saga-1", "u1login")], []) },
      SAGA_WORKFLOW: {
        get: async (id: string) => {
          gotIds.push(id);
          return runningSagaInstance(sentEvents);
        },
      },
    } as unknown as Env;
    const res = await postDecision(env, "u1login", { sagaId: "saga-1", decision: "approved" });
    expect(res?.status).toBe(200);
    expect((await res!.json()) as unknown).toEqual({ accepted: true });
    expect(gotIds).toEqual(["saga-saga-1"]);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toEqual({
      type: "saga-journey-decision",
      payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "panel" },
    });
  });

  it("honors an explicit chat surface", async () => {
    const sentEvents: Array<{ type: string; payload: unknown }> = [];
    const env = {
      ORCHESTRATOR_AGENT: { idFromName: () => "stub-id", get: () => auditStub([promptedEvent("saga-1", "u1login")], []) },
      SAGA_WORKFLOW: {
        get: async () => runningSagaInstance(sentEvents),
      },
    } as unknown as Env;
    const res = await postDecision(env, "u1login", { sagaId: "saga-1", decision: "denied", surface: "chat" });
    expect(res?.status).toBe(200);
    expect(sentEvents[0].payload).toEqual({
      sagaId: "saga-1",
      decision: "denied",
      deciderLogin: "u1login",
      surface: "chat",
    });
  });

  it("returns 409 superseded with the winner for an already-decided gate", async () => {
    const { env } = envFor({
      stub: auditStub([], [decidedEvent("saga-9", "slack")]),
      sagaGet: async () => runningSagaInstance([]),
    });
    const res = await postDecision(env, "u1login", { sagaId: "saga-9", decision: "approved" });
    expect(res?.status).toBe(409);
    expect((await res!.json()) as unknown).toEqual({ accepted: false, superseded: true, decidedBy: "slack" });
  });

  it("returns 404 for a foreign gate (no cross-user leak) and for a never-prompted gate", async () => {
    const { env } = envFor({
      stub: auditStub([promptedEvent("saga-3", "other")], []),
      sagaGet: async () => runningSagaInstance([]),
    });
    const foreign = await postDecision(env, "u1login", { sagaId: "saga-3", decision: "approved" });
    expect(foreign?.status).toBe(404);
    const never = await postDecision(env, "u1login", { sagaId: "saga-never", decision: "approved" });
    expect(never?.status).toBe(404);
  });

  it("returns 409 when the instance completed between the pending check and delivery", async () => {
    const { env } = envFor({
      stub: auditStub([promptedEvent("saga-1", "u1login")], []),
      sagaGet: async () => ({
        status: async () => ({ status: "complete", output: { decidingSurface: "chat" } }),
        sendEvent: async () => {
          throw new Error("must not send to a complete instance");
        },
      }),
    });
    const res = await postDecision(env, "u1login", { sagaId: "saga-1", decision: "approved" });
    expect(res?.status).toBe(409);
    expect((await res!.json()) as unknown).toEqual({ accepted: false, superseded: true, decidedBy: "chat" });
  });

  it("returns 503 when SAGA_WORKFLOW is unbound (delivery must never silently drop)", async () => {
    const { env } = envFor({
      stub: auditStub([promptedEvent("saga-1", "u1login")], []),
    });
    const res = await postDecision(env, "u1login", { sagaId: "saga-1", decision: "approved" });
    expect(res?.status).toBe(503);
  });

  it("returns null for a non-matching path", async () => {
    const { env } = envFor({ stub: auditStub([], []) });
    const req = new Request("https://agent.internal/api/saga/other");
    const res = await handleSagaJourneyRoutes(req, new URL(req.url), "/api/saga/other", env, "u1login");
    expect(res).toBeNull();
  });
});
