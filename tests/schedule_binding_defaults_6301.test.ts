/**
 * Issue #6301 — one defaults home: blank-broker schedules resolve to
 * alpaca/paper, never Public.com.
 *
 * Pins:
 * - `defaultAccountTypeForCallback` — the one home for the
 *   callback → asset-class default (options analysis → options,
 *   everything else → the configured default "stock").
 * - `resolveScheduleBindingDefaults` — a blank payload resolves
 *   broker/mode/accountType from the one home (stored selection →
 *   vocabulary default alpaca/paper); a stamped broker is never
 *   overridden; a present-but-unknown broker is flagged, not defaulted.
 * - `enforceScheduleBinding` (via the orchestrator harness) — a blank
 *   payload resolves to the alpaca/paper tuple instead of being
 *   refused; a refusal still carries the resolved broker/mode.
 * - `recordScheduleCallbackRun` — the outcome's resolved binding is
 *   stamped onto the ledger record, winning over the payload stamp.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
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

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import {
  resolveScheduleBindingDefaults,
  resolveValidatedExecutionAccountContext,
} from "../src/services/accountBindings";
import { defaultAccountTypeForCallback } from "../src/config/accountBindings";
import { TradingPlatformRegistry } from "../src/trading";
import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import type { SqlStorage } from "../src/orm";

vi.mock("../src/services/accountBindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/accountBindings")>();
  return { ...actual, resolveValidatedExecutionAccountContext: vi.fn() };
});

const mockedResolveValidatedExecutionAccountContext = vi.mocked(
  resolveValidatedExecutionAccountContext,
);

/** node:sqlite double for the SqlStorage seam (same shape as #2337). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  get sql(): SqliteTestStorage {
    return this;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

let agent: any;
let getPlatformSpy: any;

beforeEach(() => {
  agent = Object.create(OrchestratorAgent.prototype);
  agent.ctx = { storage: { sql: new MockSqlStorage() }, id: { toString: () => "binding-defaults-test" } };
  agent.env = {};
  agent.getOrm = () => ({});
  // The guard's broker enumeration: a fake platform that lists the
  // bound account, so the validation passes for the resolved tuple.
  getPlatformSpy = vi
    .spyOn(TradingPlatformRegistry, "getPlatform")
    .mockImplementation((() => ({
      getAccounts: async () => [{ accountId: "acct-venus-1", accountName: "Venus Alpaca" }],
    })) as never);
  // The guard's account resolution: a bound alpaca/paper options
  // account, so a blank payload resolves to a full tuple.
  mockedResolveValidatedExecutionAccountContext.mockResolvedValue({
    ok: true,
    context: {
      broker: "alpaca",
      mode: "paper",
      accountType: "options",
      accountId: "acct-venus-1",
      scope: "schedule",
      source: "binding",
    },
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defaultAccountTypeForCallback (#6301)", () => {
  it("options analysis runs against the options account", () => {
    expect(defaultAccountTypeForCallback("autonomousOptionsAnalysis")).toBe("options");
  });

  it("every other callback runs against the configured default (stock)", () => {
    expect(defaultAccountTypeForCallback("autonomousMarketScreen")).toBe("stock");
    expect(defaultAccountTypeForCallback("autonomousGoalScreen")).toBe("stock");
    expect(defaultAccountTypeForCallback("autonomousStrategyDiscovery")).toBe("stock");
    expect(defaultAccountTypeForCallback("")).toBe("stock");
    expect(defaultAccountTypeForCallback("unknownCallback")).toBe("stock");
  });
});

describe("resolveScheduleBindingDefaults (#6301)", () => {
  it("a blank payload resolves to the alpaca/paper default with the callback's account type", async () => {
    const resolved = await resolveScheduleBindingDefaults({
      env: agent.env,
      callback: "autonomousOptionsAnalysis",
    });
    expect(resolved.brokerId).toBe("alpaca");
    expect(resolved.mode).toBe("paper");
    expect(resolved.accountType).toBe("options");
  });

  it("a blank payload for a stock callback resolves the stock account type", async () => {
    const resolved = await resolveScheduleBindingDefaults({
      env: agent.env,
      callback: "autonomousMarketScreen",
    });
    expect(resolved.brokerId).toBe("alpaca");
    expect(resolved.mode).toBe("paper");
    expect(resolved.accountType).toBe("stock");
  });

  it("a stamped broker is never overridden, and a stamped mode is kept", async () => {
    const resolved = await resolveScheduleBindingDefaults({
      env: agent.env,
      brokerId: "public",
      mode: "live",
      accountType: "options",
      callback: "autonomousOptionsAnalysis",
    });
    expect(resolved.brokerId).toBe("public");
    expect(resolved.mode).toBe("live");
    expect(resolved.accountType).toBe("options");
  });

  it("a present-but-unknown broker is returned as-is, never defaulted", async () => {
    const resolved = await resolveScheduleBindingDefaults({
      env: agent.env,
      brokerId: "nope",
      callback: "autonomousOptionsAnalysis",
    });
    expect(resolved.brokerId).toBe("nope");
  });

  it("a blank mode for alpaca resolves by inference when no environment is present", async () => {
    const resolved = await resolveScheduleBindingDefaults({
      env: agent.env,
      brokerId: "alpaca",
      callback: "autonomousOptionsAnalysis",
    });
    expect(resolved.mode).toBe("paper");
    expect(resolved.modeSource).toBe("inference");
  });

  it("a blank mode for alpaca with a TEST environment resolves by selection", async () => {
    const resolved = await resolveScheduleBindingDefaults({
      env: agent.env,
      brokerId: "alpaca",
      environment: "TEST",
      callback: "autonomousOptionsAnalysis",
    });
    expect(resolved.mode).toBe("paper");
    expect(resolved.modeSource).toBe("selection");
  });
});

describe("enforceScheduleBinding (#6301)", () => {
  it("a blank payload resolves to the alpaca/paper tuple instead of being refused", async () => {
    const guard = await (agent as any).enforceScheduleBinding(
      { userLogin: "venus", environment: "TEST" },
      "autonomousOptionsAnalysis",
    );
    expect(guard.ok).toBe(true);
    expect(guard.tuple.broker).toBe("alpaca");
    expect(guard.tuple.mode).toBe("paper");
    expect(guard.tuple.accountType).toBe("options");
    expect(guard.tuple.accountId).toBe("acct-venus-1");
  });

  it("a blank payload for a stock callback resolves the stock account type", async () => {
    mockedResolveValidatedExecutionAccountContext.mockResolvedValue({
      ok: true,
      context: {
        broker: "alpaca",
        mode: "paper",
        accountType: "stock",
        accountId: "acct-venus-1",
        scope: "schedule",
        source: "binding",
      },
    } as never);
    const guard = await (agent as any).enforceScheduleBinding(
      { userLogin: "venus", environment: "TEST" },
      "autonomousMarketScreen",
    );
    expect(guard.ok).toBe(true);
    expect(guard.tuple.broker).toBe("alpaca");
    expect(guard.tuple.accountType).toBe("stock");
  });

  it("a stamped broker is honored, never overridden by the default", async () => {
    // Public.com is live-only in the default registry (modes: ["live"]),
    // so the stamped combination here is public/live — public/paper
    // cannot validate at fire time (pre-existing registry rule, not
    // this change: the 11/20 public/paper runs failed at auth before
    // reaching validation).
    mockedResolveValidatedExecutionAccountContext.mockResolvedValue({
      ok: true,
      context: {
        broker: "public",
        mode: "live",
        accountType: "options",
        accountId: "pub-1",
        scope: "schedule",
        source: "binding",
      },
    } as never);
    getPlatformSpy.mockImplementation((() => ({
      getAccounts: async () => [{ accountId: "pub-1", accountName: "Venus Public" }],
    })) as never);
    const guard = await (agent as any).enforceScheduleBinding(
      { userLogin: "venus", brokerId: "public", mode: "live", accountType: "options", accountId: "pub-1" },
      "autonomousOptionsAnalysis",
    );
    expect(guard.ok).toBe(true);
    expect(guard.tuple.broker).toBe("public");
    expect(guard.tuple.mode).toBe("live");
  });

  it("an unresolvable account is a named refusal that still carries the resolved broker/mode", async () => {
    mockedResolveValidatedExecutionAccountContext.mockResolvedValue({
      ok: false,
      code: "FAILURE_ACCOUNT_BINDING_MISSING",
      error: "[FAILURE_ACCOUNT_BINDING_MISSING] No binding found.",
      status: 404,
    } as never);
    const guard = await (agent as any).enforceScheduleBinding(
      { userLogin: "venus", environment: "TEST" },
      "autonomousOptionsAnalysis",
    );
    expect(guard.ok).toBe(false);
    expect(guard.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(guard.resolved?.brokerId).toBe("alpaca");
    expect(guard.resolved?.mode).toBe("paper");
  });

  it("a present-but-unknown broker is refused by name, never defaulted", async () => {
    const guard = await (agent as any).enforceScheduleBinding(
      { userLogin: "venus", brokerId: "nope" },
      "autonomousOptionsAnalysis",
    );
    expect(guard.ok).toBe(false);
    expect(guard.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
    expect(guard.error).toContain('unknown broker "nope"');
    expect(guard.resolved?.brokerId).toBe("nope");
  });

  it("a payload with no owner login is refused (the default never invents an owner)", async () => {
    const guard = await (agent as any).enforceScheduleBinding({}, "autonomousOptionsAnalysis");
    expect(guard.ok).toBe(false);
    expect(guard.code).toBe("FAILURE_ACCOUNT_BINDING_MISSING");
  });
});

describe("recordScheduleCallbackRun ledger stamping (#6301)", () => {
  it("the outcome's resolved binding is stamped onto the record for a blank payload", async () => {
    const storage = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(storage.sql as never);
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousOptionsAnalysis",
      { userLogin: "venus" },
      { id: "sched-6301-blank" },
      async () => ({
        outcome: "success",
        descriptor: "sharded to the one engine",
        brokerId: "alpaca",
        mode: "paper",
        modeSource: "inference",
      }),
    );
    const runs = store.listByJob("sched-6301-blank");
    expect(runs).toHaveLength(1);
    expect(runs[0].brokerId).toBe("alpaca");
    expect(runs[0].mode).toBe("paper");
    expect(runs[0].modeSource).toBe("inference");
  });

  it("the outcome's binding wins over a stamped payload (a re-resolved run records what it ran as)", async () => {
    const storage = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(storage.sql as never);
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousOptionsAnalysis",
      { userLogin: "venus", brokerId: "etrade", mode: "paper", accountType: "options", accountId: "ET-1" },
      { id: "sched-6301-stamped" },
      async () => ({
        outcome: "success",
        descriptor: "ok",
        brokerId: "alpaca",
        mode: "paper",
        modeSource: "selection",
      }),
    );
    const runs = store.listByJob("sched-6301-stamped");
    expect(runs).toHaveLength(1);
    expect(runs[0].brokerId).toBe("alpaca");
    expect(runs[0].mode).toBe("paper");
    expect(runs[0].modeSource).toBe("selection");
    expect(runs[0].accountId).toBe("ET-1");
  });

  it("a stamped payload's broker survives when the outcome carries none", async () => {
    const storage = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(storage.sql as never);
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousMarketScreen",
      { userLogin: "alice", brokerId: "etrade", mode: "paper", accountType: "stock", accountId: "ET-GONE" },
      { id: "sched-6301-legacy" },
      async () => ({ outcome: "skipped", detail: "FAILURE_ACCOUNT_UNKNOWN" }),
    );
    const runs = store.listByJob("sched-6301-legacy");
    expect(runs).toHaveLength(1);
    expect(runs[0].brokerId).toBe("etrade");
    expect(runs[0].mode).toBe("paper");
    expect(runs[0].accountType).toBe("stock");
  });
});
