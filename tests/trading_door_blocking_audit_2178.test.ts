/**
 * Issue #2178 (Q7 S2) — trade family, TradingAgent doors.
 * TDD: written before the implementation.
 *
 * Contract: executeApprovedOrder audits the approval decision BEFORE
 * settle and the execution result AFTER settle, both through the
 * blocking helper (a throwing audit store blocks: no settle on a
 * decision-audit throw, no success report on a result-audit throw).
 * decideTradeApproval audits the decision BEFORE delivering the event
 * to the workflow (a throw means the decision never takes effect).
 * Input validation still runs first — invalid calls never audit.
 *
 * Issue #6102: the blocking audits write to D1 now (the door
 * resolves the port from env.AGENT_DB). Each test binds a FRESH
 * MockD1Database as AGENT_DB and reads the rows back from the D1
 * store (payload reads back as JSON TEXT, exactly as the DO port
 * returned it); the throwing tests bind a throwing stub DB instead.
 * The old fakeEvents/getOrm audit observations are dead on this
 * branch — the door never reads agent.getOrm() for audit.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});

import { TradingPlatformRegistry } from "../src/trading";
import type { Env } from "../src/types";
import { MockD1Database } from "./mock-d1";
import { MockSqlStorage } from "./mock-sql";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";

const baseEnv = { SERVICE_USER_LOGIN: "svc-trader" } as Env;

TradingPlatformRegistry.register("faketrade2178" as any, () => ({
  platformId: "faketrade2178",
  name: "Fake Trade 2178",
  getStatus: async () => ({}),
  getQuote: async () => ({}),
  getAccounts: async () => [],
  getPositions: async () => ({ account: {}, positions: [] }),
  previewOrder: async (params: any) => ({ id: "draft-2178", ...params }),
  executeOrder: async (orderId: string, authorizerDid: string, decision: string) => {
    executions.push({ orderId, authorizerDid, decision });
    return { orderId, status: decision === "approved" ? "placed" : "cancelled", authorizerDid };
  },
}) as any);

const executions: any[] = [];

const tradeConfig = {
  enabledProviders: ["faketrade2178"],
  defaultProvider: "faketrade2178",
  enabledServices: ["stock_trading"],
};

/** Fresh working D1 + a store reading it, per test. */
function auditStore() {
  const d1Mock = new MockD1Database();
  const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
  return { d1Mock, d1Store };
}

/**
 * A stub DB whose every statement rejects: the port ensure fails
 * with "audit store unavailable" before anything settles. The
 * rejection must be ASYNC (from bind().run()/all()/first()): a
 * synchronous throw from prepare() is wrapped by Drizzle's
 * session.run into "Failed to run the query ..." and the message
 * is lost — an async rejection propagates raw.
 */
function throwingDb() {
  const boom = () => Promise.reject(new Error("audit store unavailable"));
  return {
    prepare: (_sql: string) => ({
      bind: (..._params: unknown[]) => ({
        run: () => boom(),
        all: () => boom(),
        first: () => boom(),
        raw: () => boom(),
      }),
    }),
    batch: async () => {
      throw new Error("audit store unavailable");
    },
  };
}

/**
 * A working D1 mock that throws "audit store unavailable" on the
 * SECOND mas_events insert: the decision audit lands, the result
 * audit fails — the unaudited execution must never report success.
 * Only the chained-insert statement is counted (migration and
 * tail-read statements pass through untouched).
 */
class ThrowOnSecondAuditInsertDb extends MockD1Database {
  private masEventsInserts = 0;
  override prepare(sql: string): any {
    const stmt: any = super.prepare(sql);
    if (!/^\s*insert\s+into\s+mas_events\b/i.test(sql)) return stmt;
    return {
      bind: (...params: unknown[]) => {
        const bound: any = stmt.bind(...params);
        return {
          ...bound,
          run: async () => {
            this.masEventsInserts += 1;
            if (this.masEventsInserts >= 2) {
              throw new Error("audit store unavailable");
            }
            return bound.run();
          },
        };
      },
    };
  }
}

async function door(db: unknown) {
  const { TradingAgent } = await import("../src/agents/trading-agent");
  const agent: any = Object.create(TradingAgent.prototype);
  // #6102: fresh env per test — the port is memoized per env object.
  agent.env = { ...baseEnv, AGENT_DB: db } as unknown as Env;
  agent.config = () => tradeConfig;
  // The settle threads the instance ORM (the draft store), so the
  // prototype agent needs a ctx like a real instance's.
  agent.ctx = {
    id: { toString: () => "trading:test" },
    storage: { sql: new MockSqlStorage() },
  };
  return agent;
}

function payloadOf(row: any): any {
  return JSON.parse(row.payload as unknown as string);
}

describe("TradingAgent doors blocking audit (#2178 S2)", () => {
  it("executeApprovedOrder audits decision before settle and result after", async () => {
    const { d1Mock, d1Store } = auditStore();
    const agent = await door(d1Mock);
    executions.length = 0;
    const placed: any = await agent.executeApprovedOrder({
      provider: "faketrade2178",
      orderId: "draft-2178",
      userLogin: "alice",
      authorizerDid: "did:web:alice",
      decision: "approved",
    });
    expect(placed.status).toBe("placed");
    expect(executions).toHaveLength(1);
    // The door awaits both audits, so direct reads are settled.
    const decisions = await d1Store.findMany({ where: { type: "trade.approval_decision" } });
    const results = await d1Store.findMany({ where: { type: "trade.order_executed" } });
    expect(decisions).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((await d1Store.findMany({})).length).toBe(2);
    expect(payloadOf(decisions[0]).orderId).toBe("draft-2178");
    expect(payloadOf(decisions[0]).authorizerDid).toBe("did:web:alice");
  });

  it("a throwing decision audit blocks settle entirely", async () => {
    const agent = await door(throwingDb());
    executions.length = 0;
    // #6102: on the D1 stack every SQL failure surfaces as a
    // DrizzleQueryError ("Failed query: ...") whose .cause is the
    // store's own error — the verbatim "audit store unavailable"
    // lives on the cause, not the top-level message (drizzle-orm
    // sqlite-core/session.js queryWithCache wraps every failure).
    // The contract is unchanged: the door rejects and nothing settles.
    const err: any = await agent
      .executeApprovedOrder({
        provider: "faketrade2178",
        orderId: "draft-2178",
        userLogin: "alice",
        authorizerDid: "did:web:alice",
        decision: "approved",
      })
      .catch((e: any) => e);
    expect(err.message).toMatch(/Failed query/);
    expect(err.cause?.message).toBe("audit store unavailable");
    expect(executions).toHaveLength(0);
  });

  it("a throwing result audit never reports success for an unaudited execution", async () => {
    const agent = await door(new ThrowOnSecondAuditInsertDb());
    executions.length = 0;
    const err: any = await agent
      .executeApprovedOrder({
        provider: "faketrade2178",
        orderId: "draft-2178",
        userLogin: "alice",
        authorizerDid: "did:web:alice",
        decision: "approved",
      })
      .catch((e: any) => e);
    expect(err.code).toBe("internal_error");
    expect(err.message).toMatch(/draft-2178.*audit/i);
    expect(executions).toHaveLength(1);
  });

  it("decideTradeApproval audits the decision before delivering the event", async () => {
    const { d1Mock, d1Store } = auditStore();
    const agent = await door(d1Mock);
    const delivered: any[] = [];
    agent.sendWorkflowEvent = async (...args: any[]) => {
      delivered.push(args);
    };
    const out: any = await agent.decideTradeApproval({
      workflowId: "wf-1",
      authorizerDid: "did:web:alice",
      decision: "approved",
    });
    expect(out.delivered).toBe(true);
    expect(delivered).toHaveLength(1);
    const decisions = await d1Store.findMany({ where: { type: "trade.approval_decision" } });
    expect(decisions).toHaveLength(1);
    expect(payloadOf(decisions[0]).workflowId).toBe("wf-1");
  });

  it("a throwing decision audit means the decision never reaches the workflow", async () => {
    const agent = await door(throwingDb());
    const delivered: any[] = [];
    agent.sendWorkflowEvent = async (...args: any[]) => {
      delivered.push(args);
    };
    // #6102: see the executeApprovedOrder throwing test — the
    // store failure surfaces as a DrizzleQueryError whose .cause
    // is the verbatim "audit store unavailable".
    const err: any = await agent
      .decideTradeApproval({
        workflowId: "wf-1",
        authorizerDid: "did:web:alice",
        decision: "approved",
      })
      .catch((e: any) => e);
    expect(err.message).toMatch(/Failed query/);
    expect(err.cause?.message).toBe("audit store unavailable");
    expect(delivered).toHaveLength(0);
  });

  it("input validation still runs before any audit", async () => {
    const { d1Mock, d1Store } = auditStore();
    const agent = await door(d1Mock);
    const anon: any = await agent
      .decideTradeApproval({ workflowId: "wf-1", decision: "approved" })
      .catch((e: any) => e);
    expect(anon.code).toBe("invalid_input");
    expect(await d1Store.findMany({})).toHaveLength(0);
  });
});
