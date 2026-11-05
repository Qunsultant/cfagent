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

function makeCtx(orm: any) {
  return {
    env: {},
    agentCtx: { storage: { get: async () => undefined, put: async () => {}, sql: {} } },
    self: {},
    getScreenerExecutionContext: async () => ({ userLogin: "alice", environment: "TEST" }),
    removeUnownedBaselineSchedules: async () => {},
    getOrm: () => orm,
    sessionKey: () => "session-1",
    waitUntilStable: async () => true,
    scheduledScreenerSlots: new Set<string>(),
    scheduledDiscoverySlots: new Set<string>(),
  } as any;
}

describe("token renewal blocking audit (#2178 S2)", () => {
  it("a successful renewal writes a blocking outcome claim", async () => {
    stubResult = { success: true, data: { renewed: true, userLogin: "alice" } };
    const created: any[] = [];
    const orm = { events: { create: (record: any) => { created.push(record); return record; } } };
    await autoRenewETradeTokens(makeCtx(orm), { userLogin: "alice" });
    const claims = created.filter((r) => r.type === "etrade.token_renewal_claim");
    expect(claims).toHaveLength(1);
    expect(claims[0].payload.userLogin).toBe("alice");
    expect(claims[0].payload.success).toBe(true);
    expect(claims[0].payload.renewed).toBe(true);
  });

  it("a failed renewal writes a failure claim, not a success", async () => {
    stubResult = { success: false, error: "upstream rejected" };
    const created: any[] = [];
    const orm = { events: { create: (record: any) => { created.push(record); return record; } } };
    await autoRenewETradeTokens(makeCtx(orm), { userLogin: "alice" });
    const claims = created.filter((r) => r.type === "etrade.token_renewal_claim");
    expect(claims).toHaveLength(1);
    expect(claims[0].payload.success).toBe(false);
    expect(claims[0].payload.error).toBe("upstream rejected");
  });

  it("a throwing audit store propagates: renewal reported as error, never success", async () => {
    stubResult = { success: true, data: { renewed: true, userLogin: "alice" } };
    const orm = { events: { create: () => { throw new Error("audit store unavailable"); } } };
    await expect(
      autoRenewETradeTokens(makeCtx(orm), { userLogin: "alice" }),
    ).rejects.toThrowError("audit store unavailable");
  });
});
