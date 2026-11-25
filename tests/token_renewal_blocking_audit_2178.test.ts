/**
 * Issue #2178 (Q7 S2) — token-ops family.
 * TDD: written before the implementation.
 *
 * Contract: the scheduled token-renewal callback audits the
 * renewal OUTCOME through the blocking helper (new claim row,
 * distinct from the service's own warn-path outcome notes, which
 * stay — the service is also called from the NLQ path, where no
 * callback exists). A throwing audit store propagates out of
 * the callback: the renewal is reported as an error, never as
 * success. The no-user early return audits nothing (no renewal
 * was attempted).
 */
import { describe, it, expect, vi } from "vitest";

let stubResult: any = { success: true, data: { renewed: true, userLogin: "alice" } };

vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: class {
    async autoRenewETradeTokens() {
      return stubResult;
    }
  },
}));

vi.mock("../src/services/etradeAuthPreflight", () => ({
  etradeAuthEpisodeKey: () => "episode-key",
  fireAuthEpisodeAlertOnce: async () => {},
}));

vi.mock("../src/services/gatedSlackDelivery", () => ({
  deliverGatedSlack: async () => ({ ok: true }),
}));

import { autoRenewETradeTokens } from "../src/agents/orchestrator/scheduledCallbacks";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";

function makeCtx(_orm: any) {
  // #6102: the renewal outcome claim writes to D1 now — the
  // callback resolves the audit port from ctx.env.AGENT_DB, so
  // each test binds a FRESH MockD1Database and reads the claim
  // back from the D1 store (payload is stored JSON TEXT).
  const d1Mock = new MockD1Database();
  const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
  return {
    ctx: {
      env: { AGENT_DB: d1Mock },
      agentCtx: { storage: { get: async () => undefined, put: async () => {}, sql: {} } },
      self: {},
      getScreenerExecutionContext: async () => ({ userLogin: "alice", environment: "TEST" }),
      removeUnownedBaselineSchedules: async () => {},
      getOrm: () => _orm,
      sessionKey: () => "session-1",
      waitUntilStable: async () => true,
      scheduledScreenerSlots: new Set<string>(),
      scheduledDiscoverySlots: new Set<string>(),
    } as any,
    d1Store,
  };
}

/** A stub DB whose every statement rejects with "audit store unavailable" (see trading_door_blocking_audit_2178.test.ts: the rejection must be async — a sync prepare throw is wrapped by Drizzle's session.run and the message is lost). */
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

function makeThrowingCtx(orm: any) {
  const { ctx } = makeCtx(orm);
  (ctx as any).env = { AGENT_DB: throwingDb() };
  return ctx;
}

describe("token renewal blocking audit (#2178 S2)", () => {
  it("a successful renewal writes a blocking outcome claim", async () => {
    stubResult = { success: true, data: { renewed: true, userLogin: "alice" } };
    const { ctx, d1Store } = makeCtx(null);
    await autoRenewETradeTokens(ctx, { userLogin: "alice" });
    const claims = await d1Store.findMany({ where: { type: "etrade.token_renewal_claim" } });
    expect(claims).toHaveLength(1);
    const payload = JSON.parse(claims[0].payload as unknown as string);
    expect(payload.userLogin).toBe("alice");
    expect(payload.success).toBe(true);
    expect(payload.renewed).toBe(true);
  });

  it("a failed renewal writes a failure claim, not a success", async () => {
    stubResult = { success: false, error: "upstream rejected" };
    const { ctx, d1Store } = makeCtx(null);
    await autoRenewETradeTokens(ctx, { userLogin: "alice" });
    const claims = await d1Store.findMany({ where: { type: "etrade.token_renewal_claim" } });
    expect(claims).toHaveLength(1);
    const payload = JSON.parse(claims[0].payload as unknown as string);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("upstream rejected");
  });

  it("a throwing audit store propagates: renewal reported as error, never success", async () => {
    stubResult = { success: true, data: { renewed: true, userLogin: "alice" } };
    // #6102: see trading_door_blocking_audit_2178.test.ts — the
    // store failure surfaces as a DrizzleQueryError whose .cause
    // is the verbatim "audit store unavailable".
    const err: any = await autoRenewETradeTokens(makeThrowingCtx(null), { userLogin: "alice" }).catch(
      (e: any) => e,
    );
    expect(err.message).toMatch(/Failed query/);
    expect(err.cause?.message).toBe("audit store unavailable");
  });
});
