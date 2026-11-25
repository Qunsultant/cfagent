/**
 * Issue #3121 Phase 3 (#3122) — store-integration pins (3122-P18..P22):
 * the capability adapters operate on #3123's unified store.
 * - P18: an executor SDK create records a paused unified screen
 *   record (#6482: paused by default — no alarm until resume, so
 *   the record id is a stable id and alarmId is null).
 * - P19: adoption never clobbers an existing record (insert-if-absent).
 * - P20: a failing store write fails the creation (fail-closed,
 *   #6482 — the paused record IS the schedule; creation arms
 *   nothing, so there is nothing to create without it).
 * - P21: cancelling an SDK schedule removes its unified record.
 * - P22: the goals adapter operates on the unified store (the
 *   ScheduledAgent's getGoals/saveGoals read/write unified records,
 *   and goal ↔ record round-trips through the store).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import {
  adoptAgentSdkScheduleRecord,
  executeAgentScheduleAction,
  nlqPortToAgentSdkAdapter,
  type AgentScheduleApprovalConfig,
  type PendingScheduleApproval,
} from "../src/services/agentScheduleCapability";
import {
  goalToRecord,
  recordToGoal,
} from "../src/services/unifiedScheduleManagement";
import type { AgentScheduleItem } from "../src/types";
import type { NLQSchedulingPort } from "../src/agents/nlq/types";

const CONFIG: AgentScheduleApprovalConfig = {
  budgetCentsThreshold: 10_000,
  minIntervalSeconds: 3_600,
};

/** Fake NLQ scheduling port: arms SDK alarms in memory (no SDK). */
function fakeNlqPort() {
  const items: AgentScheduleItem[] = [];
  let seq = 0;
  let nextId: string | undefined;
  const port: NLQSchedulingPort = {
    schedule: async (when, callback, payload) => {
      const item: AgentScheduleItem = {
        id: nextId ?? `alarm-${++seq}`,
        callback,
        type: "cron",
        cron: typeof when === "string" ? when : undefined,
        payload,
      };
      nextId = undefined;
      items.push(item);
      return item;
    },
    scheduleEvery: async (intervalSeconds, callback, payload) => {
      const item: AgentScheduleItem = {
        id: nextId ?? `alarm-${++seq}`,
        callback,
        type: "interval",
        intervalSeconds,
        payload,
      };
      nextId = undefined;
      items.push(item);
      return item;
    },
    cancelSchedule: async (id) => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return false;
      items.splice(idx, 1);
      return true;
    },
    listSchedules: async () => [...items],
  };
  return { port, items, setNextId: (id: string) => { nextId = id; } };
}

describe("3122-P18..P21 SDK adapter adopts into the unified store", () => {
  it("P18 an executor SDK create records a paused unified screen record (paused by default, no alarm id)", async () => {
    const { port } = fakeNlqPort();
    const store = new InMemoryUnifiedScheduleStore();
    const ledger: unknown[] = [];
    let pending: PendingScheduleApproval[] = [];
    const deps = {
      pdp: async () => ({ enforced: true as const, allowed: true as const }),
      config: CONFIG,
      nowMs: () => 1_700_000_000_000,
      nowIso: () => "2026-11-11T12:00:00.000Z",
      recordLedger: (record: unknown) => {
        ledger.push(record);
      },
      audit: () => {},
      pendingApprovals: {
        load: async () => pending,
        save: async (list: PendingScheduleApproval[]) => {
          pending = list;
        },
      },
      stores: { sdk: nlqPortToAgentSdkAdapter(port, store) },
    };
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "sdk",
      principal: { login: "OpenAIMP", agentId: "agent-1" },
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "cron", cron: "0 9 * * 1-5" },
      payload: {},
    });
    expect(out.ok).toBe(true);
    expect(out.scheduleId).toBeTruthy();
    const record = await store.get(out.scheduleId as string);
    expect(record).toBeDefined();
    expect(record?.id).toBe(out.scheduleId);
    expect(record?.kind).toBe("screen");
    // Issue #6482 — paused by default: creation records a paused
    // schedule and never arms the port, so there is no alarm id
    // yet (alarmId is set on resume) and the record id is a stable
    // id, not the alarm id.
    expect(record?.state).toBe("paused");
    expect(record?.callback).toBe("autonomousMarketScreen");
    expect(record?.alarmId ?? null).toBeNull();
    // ownerLogin comes from the executor-stamped provenance, never invented.
    expect(record?.ownerLogin).toBe("OpenAIMP");
    expect((record?.definition as Record<string, unknown>)?.callback).toBe("autonomousMarketScreen");
  });

  it("P19 adoption never clobbers an existing record (insert-if-absent)", async () => {
    // Issue #6482 — adapter.create no longer arms the port (paused
    // by default), so there is no alarm id to adopt at creation; the
    // insert-if-absent pin lives on adoptAgentSdkScheduleRecord, the
    // function that still owns adoption of an armed alarm — and a
    // fresh create mints its own record and leaves the existing one
    // alone.
    const { port } = fakeNlqPort();
    const store = new InMemoryUnifiedScheduleStore();
    await store.save({
      id: "alarm-1",
      kind: "screen",
      state: "active",
      callback: "autonomousMarketScreen",
      definition: { type: "cron", callback: "autonomousMarketScreen", marker: "original" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await adoptAgentSdkScheduleRecord(
      store,
      { id: "alarm-1", callback: "autonomousMarketScreen", type: "cron", cron: "0 9 * * 1-5", payload: {} },
      "2026-11-11T12:00:00.000Z",
    );
    const record = await store.get("alarm-1");
    expect(record?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect((record?.definition as Record<string, unknown>)?.marker).toBe("original");
    const adapter = nlqPortToAgentSdkAdapter(port, store);
    const created = await adapter.create({
      timing: { type: "cron", cron: "0 9 * * 1-5" },
      callback: "autonomousMarketScreen",
      payload: {},
    });
    expect(created.id).not.toBe("alarm-1");
    expect((await store.get("alarm-1"))?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(await store.get(created.id)).toBeDefined();
  });

  it("P20 a failing store write fails the creation (fail-closed, #6482)", async () => {
    // Issue #6482 — the paused record IS the schedule (creation
    // arms nothing), so a store write that cannot persist it fails
    // the creation: returning an id for a schedule that does not
    // exist would be the fabricated id #111 forbids. Nothing is
    // armed.
    const { port, items } = fakeNlqPort();
    const real = new InMemoryUnifiedScheduleStore();
    const failingStore = {
      save: async () => {
        throw new Error("store down");
      },
      get: (id: string) => real.get(id),
      list: () => real.list(),
      listByKind: (kind: Parameters<typeof real.listByKind>[0]) => real.listByKind(kind),
      listByState: (state: Parameters<typeof real.listByState>[0]) => real.listByState(state),
      remove: (id: string) => real.remove(id),
      clear: () => real.clear(),
      clearPaused: () => real.clearPaused(),
    };
    const adapter = nlqPortToAgentSdkAdapter(port, failingStore);
    await expect(
      adapter.create({
        timing: { type: "cron", cron: "0 9 * * 1-5" },
        callback: "autonomousMarketScreen",
        payload: {},
      }),
    ).rejects.toThrow("store down");
    expect(items).toHaveLength(0);
    expect(await real.list()).toHaveLength(0);
  });

  it("P21 cancelling an SDK schedule removes its unified record", async () => {
    const { port } = fakeNlqPort();
    const store = new InMemoryUnifiedScheduleStore();
    const adapter = nlqPortToAgentSdkAdapter(port, store);
    const armed = await adapter.create({
      timing: { type: "interval", intervalSeconds: 3600 },
      callback: "autonomousMarketScreen",
      payload: {},
    });
    expect(await store.get(armed.id)).toBeDefined();
    expect(await adapter.cancel(armed.id)).toBe(true);
    expect(await store.get(armed.id)).toBeUndefined();
    expect(await adapter.cancel("no-such-alarm")).toBe(false);
  });
});

describe("3122-P22 goals adapter operates on the unified store", () => {
  it("the ScheduledAgent goals adapter delegates to getGoals/addGoal, which read/write unified records", () => {
    const src = readFileSync(join(process.cwd(), "src/agents/scheduled-agent.ts"), "utf8");
    // The capability's goals adapter is built over the DO's goal funnel.
    expect(src).toContain("list: async () => (await this.getGoals())");
    expect(src).toContain("const created = await this.addGoal(");
    expect(src).toContain("remove: (id) => this.removeGoal(id)");
    expect(src).toContain("setEnabled: (id, enabled) => this.setGoalEnabled(id, enabled)");
    // The funnel reads/writes the unified store, not the legacy KV key.
    expect(src).toContain('store.listByKind("goal")');
    // saveGoals converts each goal via goalToRecord into a record
    // and saves the record (the intermediate variable preserves
    // createdAt and sets updatedAt between conversion and save).
    expect(src).toContain("const record = goalToRecord(goal);");
    expect(src).toContain("store.save(record);");
  });

  it("a goal round-trips goal → unified record → goal through the store", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const goal = {
      id: "goal-1",
      name: "Daily social publish",
      cron: "0 9 * * *",
      operation: "social.publish",
      budgetCents: 500,
      enabled: true,
    };
    await store.save(goalToRecord(goal));
    const goals = (await store.listByKind("goal")).map((r) => recordToGoal(r));
    expect(goals).toHaveLength(1);
    expect(goals[0]?.id).toBe("goal-1");
    expect(goals[0]?.operation).toBe("social.publish");
    expect(goals[0]?.cron).toBe("0 9 * * *");
    expect(goals[0]?.budgetCents).toBe(500);
    expect(goals[0]?.enabled).toBe(true);
  });
});
