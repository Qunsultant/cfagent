/**
 * Issue #2178 (Q7 S2) — report family, scheduled path.
 * TDD: written before the implementation.
 *
 * Contract (correcting the S2 design's premise on one half):
 * the goal path ALREADY fails visibly on a null canonical store
 * (persistWorkflowGoalScreenReport throws, pinned in
 * goal_workflow_flag_1997.test.ts) — that half needs no change.
 * The scheduled path does not: autonomousMarketScreen ignores
 * storeCanonicalReport's return and swallows persistence errors
 * as "non-critical", so a run whose canonical report was never
 * stored reads exactly like a stored one. After this slice, a
 * null store writes a chained audit row naming the run instead
 * of vanishing — without throwing, preserving the callback's
 * deliberate no-throw contract.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: class {
    async autonomousMarketScreen() {
      return {
        success: true,
        timestamp: "2026-10-30T12:00:00.000Z",
        data: { universe: "NASDAQ100", totalScanned: 10, matchedCount: 1, opportunities: [] },
      };
    }
  },
}));

import { autonomousMarketScreen } from "../src/agents/orchestrator/scheduledCallbacks";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";

/** A D1 whose every statement throws — the throwing-audit-store seam (#6102). */
function throwingD1(message: string): unknown {
  const boom = async () => {
    throw new Error(message);
  };
  return {
    prepare: () => ({ bind: () => ({ run: boom, all: boom, first: boom, raw: boom }) }),
    batch: boom,
  };
}

function makeCtx(orm: any, d1Mock: unknown) {
  const store = new Map<string, unknown>();
  return {
    // #6102: the failure record writes to D1 now — bind the mock here.
    env: { AGENT_DB: d1Mock },
    agentCtx: {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value); },
        sql: {},
      },
    },
    self: {},
    getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
    removeUnownedBaselineSchedules: async () => {},
    getOrm: () => orm,
    sessionKey: () => "session-1",
    waitUntilStable: async () => true,
    scheduledScreenerSlots: new Set<string>(),
    scheduledDiscoverySlots: new Set<string>(),
  } as any;
}

describe("scheduled report store failure (#2178 S2)", () => {
  it("a null canonical store writes a failure audit row naming the run", async () => {
    const d1Mock = new MockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    const orm = {
      storeCanonicalReport: () => null,
    };
    await autonomousMarketScreen(makeCtx(orm, d1Mock), { trigger: "manual", userLogin: "alice", universe: "NASDAQ100" });
    // #6102: the failure record writes to D1 now (payload is JSON text).
    const failures = await d1Store.findMany({ where: { type: "screener.report_store_failed" } });
    expect(failures).toHaveLength(1);
    const payload = JSON.parse(failures[0].payload as unknown as string) as Record<string, unknown>;
    expect(payload.runId).toBe("screener:2026-10-30T12:00:00.000Z");
    expect(payload.userLogin).toBe("alice");
  });

  it("a stored report writes no failure row", async () => {
    const d1Mock = new MockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    const orm = {
      storeCanonicalReport: () => ({ reportId: "r1", created: true }),
    };
    await autonomousMarketScreen(makeCtx(orm, d1Mock), { trigger: "manual", userLogin: "alice", universe: "NASDAQ100" });
    expect(await d1Store.findMany({ where: { type: "screener.report_store_failed" } })).toHaveLength(0);
  });

  it("a failing audit write still never throws out of the callback", async () => {
    const orm = {
      storeCanonicalReport: () => null,
    };
    // Issue #3515 S3: the callback logs through the S2 structured
    // logger, whose sink writes one JSON line per event via
    // console.info — assert on the parsed event, not console.error.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // Issue #2964: the extracted callback now returns its outcome
      // object instead of void (the recording wrapper's truth source).
      // The no-throw contract this test pins is unchanged: the call
      // still resolves, and the audit failure still surfaces via the
      // error path rather than a throw.
      // #6102: the failing audit store is a throwing D1 now.
      const outcome = await autonomousMarketScreen(makeCtx(orm, throwingD1("audit store unavailable")), { trigger: "manual", userLogin: "alice", universe: "NASDAQ100" });
      expect(outcome.outcome).toBe("success");
      const events = info.mock.calls
        .flatMap((args) => args.map(String))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      const auditFailed = events.find(
        (e) => e.type === "scheduledCallbacks.report_store_failure_audit_failed" && e.level === "error",
      );
      expect(auditFailed).toBeDefined();
      expect(auditFailed.fields.runId).toBe("screener:2026-10-30T12:00:00.000Z");
    } finally {
      info.mockRestore();
    }
  });
});
