/**
 * Issue #4223 — persistent webhook idempotency keys for the schedule
 * webhook (sub-issue of #3311).
 *
 * #3311 mints follow-ups from a signed webhook whose only replay
 * protection is the edge's isolate-scoped memory claim (24h TTL): a
 * duplicate delivery after the TTL — or after a Worker isolate
 * restart — would mint the same follow-up twice. This slice adds the
 * durable layer: the DO route claims the delivery's idempotency key
 * in DO SQLite (the existing `webhook_replay_nonces` table, via the
 * reused `OrmReplayStore`) BEFORE minting, with a longer retention,
 * so a replay can never mint twice.
 *
 * Layers under test here (store-level; the DO-route layer lives in
 * tests/schedule-3121-3311-webhook.test.ts §6):
 *  1. Key derivation — deterministic per delivery, distinct per
 *     delivery content, insensitive to JSON key order.
 *  2. Retention config — 30-day default, env-overridable, invalid
 *     values fail safe to the default.
 *  3. Durable claim — a replay past the 24h edge TTL is still a
 *     replay; a fresh store instance over the same ORM (an isolate
 *     restart) still sees the claim; the row lives in the ORM table.
 *  4. Cleanup — pruneExpired removes only expired keys.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS,
  WEBHOOK_REPLAY_TTL_MS,
  deriveScheduleWebhookIdempotencyKey,
  resolveScheduleWebhookIdempotencyTtlMs,
  OrmReplayStore,
  MemoryReplayStore,
} from "../src/security/webhookReplay";
import {
  scheduleWebhookFollowupBodySchema,
  type ScheduleWebhookFollowupBody,
} from "../src/api/ingressSchemas";

const RUN_AT = new Date(Date.now() + 3_600_000).toISOString();

function validBody(overrides: Partial<ScheduleWebhookFollowupBody> = {}): Record<string, unknown> {
  return {
    workflowId: "wf-4223-1",
    scheduleId: "sched-4223-1",
    asyncJobId: "job-parent-4223-1",
    capability: "followup.report",
    runAt: RUN_AT,
    userLogin: "octocat",
    outcome: {
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: ["r2/reports/stock-4223.pdf"],
      universe: "NASDAQ100",
      totalScanned: 100,
      matchedCount: 3,
    },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("sess_4223_idempotency");
  return orm;
}

function parsedBody(overrides: Partial<ScheduleWebhookFollowupBody> = {}): ScheduleWebhookFollowupBody {
  return scheduleWebhookFollowupBodySchema.parse(validBody(overrides));
}

// ===========================================================================
// 1. Key derivation
// ===========================================================================

describe("deriveScheduleWebhookIdempotencyKey (#4223)", () => {
  it("is deterministic per delivery and names its source", async () => {
    const body = parsedBody({ workflowId: "wf-4223-det" });
    const first = await deriveScheduleWebhookIdempotencyKey(body);
    const second = await deriveScheduleWebhookIdempotencyKey(body);
    expect(first).toBe(second);
    expect(first.startsWith("schedule-webhook-idem:")).toBe(true);
  });

  it("is distinct per delivery content (timestamp, workflow, capability)", async () => {
    const base = await deriveScheduleWebhookIdempotencyKey(parsedBody({ workflowId: "wf-4223-a" }));
    const otherTime = await deriveScheduleWebhookIdempotencyKey(
      parsedBody({ workflowId: "wf-4223-a", timestamp: new Date(Date.now() + 60_000).toISOString() }),
    );
    const otherWorkflow = await deriveScheduleWebhookIdempotencyKey(parsedBody({ workflowId: "wf-4223-b" }));
    const otherCapability = await deriveScheduleWebhookIdempotencyKey(
      parsedBody({
        workflowId: "wf-4223-a",
        capability: "followup.notify",
        channel: "slack",
        event: "completed",
      }),
    );
    expect(otherTime).not.toBe(base);
    expect(otherWorkflow).not.toBe(base);
    expect(otherCapability).not.toBe(base);
  });

  it("is insensitive to JSON key order (same delivery, different serialization)", async () => {
    const raw = validBody({ workflowId: "wf-4223-order" });
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    const a = await deriveScheduleWebhookIdempotencyKey(scheduleWebhookFollowupBodySchema.parse(raw));
    const b = await deriveScheduleWebhookIdempotencyKey(scheduleWebhookFollowupBodySchema.parse(reordered));
    expect(a).toBe(b);
  });
});

// ===========================================================================
// 2. Retention config
// ===========================================================================

describe("resolveScheduleWebhookIdempotencyTtlMs (#4223)", () => {
  it("defaults to 30 days — longer than the 24h edge nonce TTL", () => {
    expect(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS).toBeGreaterThan(WEBHOOK_REPLAY_TTL_MS);
    expect(resolveScheduleWebhookIdempotencyTtlMs(undefined)).toBe(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
    expect(resolveScheduleWebhookIdempotencyTtlMs("")).toBe(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
  });

  it("honors a numeric env override (milliseconds)", () => {
    expect(resolveScheduleWebhookIdempotencyTtlMs("86400000")).toBe(86_400_000);
    expect(resolveScheduleWebhookIdempotencyTtlMs(7 * 24 * 60 * 60 * 1000)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("fails safe to the default on invalid overrides", () => {
    for (const bad of ["not-a-number", "0", "-1000", "  ", "NaN", "Infinity"]) {
      expect(resolveScheduleWebhookIdempotencyTtlMs(bad), bad).toBe(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
    }
    expect(resolveScheduleWebhookIdempotencyTtlMs(-5)).toBe(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
    expect(resolveScheduleWebhookIdempotencyTtlMs(0)).toBe(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
  });
});

// ===========================================================================
// 3. Durable claim
// ===========================================================================

describe("OrmReplayStore durable schedule-webhook claim (#4223)", () => {
  let orm: DatabaseORM;

  beforeEach(() => {
    orm = makeOrm();
  });

  it("a replay past the 24h edge TTL is still a replay at the durable TTL", async () => {
    const store = new OrmReplayStore(orm);
    const now = Date.now();
    expect(await store.claim("idem-past-24h", "schedule-webhook", 25 * 60 * 60 * 1000)).toBe(false);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now + 24 * 60 * 60 * 1000 + 1000);
    try {
      expect(await store.claim("idem-past-24h", "schedule-webhook", 25 * 60 * 60 * 1000)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("survives a fresh store instance over the same ORM (isolate restart)", async () => {
    const key = await deriveScheduleWebhookIdempotencyKey(parsedBody({ workflowId: "wf-4223-restart" }));
    const firstStore = new OrmReplayStore(orm);
    expect(await firstStore.claim(key, "schedule-webhook", SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS)).toBe(false);
    // A new store instance (a new isolate) over the same table still sees it.
    const restartedStore = new OrmReplayStore(orm);
    expect(await restartedStore.claim(key, "schedule-webhook", SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS)).toBe(true);
    // The key is a durable row, not isolate memory.
    const row = orm.webhookReplay.findOne({ nonce: key });
    expect(row).toBeTruthy();
    expect(row!.source).toBe("schedule-webhook");
    expect(Date.parse(row!.expiresAt) - Date.parse(row!.createdAt)).toBe(SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
  });

  it("an expired durable key is reclaimable", async () => {
    const store = new OrmReplayStore(orm);
    expect(await store.claim("idem-expired", "schedule-webhook", 0)).toBe(false);
    expect(await store.claim("idem-expired", "schedule-webhook", SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS)).toBe(false);
  });
});

// ===========================================================================
// 4. Cleanup
// ===========================================================================

describe("ReplayStore.pruneExpired (#4223)", () => {
  it("OrmReplayStore removes only expired rows and reports the count", async () => {
    const orm = makeOrm();
    const store = new OrmReplayStore(orm);
    await store.claim("idem-live", "schedule-webhook", SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
    await store.claim("idem-stale-a", "schedule-webhook", 0);
    await store.claim("idem-stale-b", "trading", 0);
    expect(await store.pruneExpired()).toBe(2);
    expect(orm.webhookReplay.findOne({ nonce: "idem-live" })).toBeTruthy();
    expect(orm.webhookReplay.findOne({ nonce: "idem-stale-a" })).toBeFalsy();
    expect(orm.webhookReplay.findOne({ nonce: "idem-stale-b" })).toBeFalsy();
    expect(await store.pruneExpired()).toBe(0);
  });

  it("MemoryReplayStore removes only expired keys and reports the count", async () => {
    const store = new MemoryReplayStore();
    await store.claim("mem-live", "schedule-webhook", SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS);
    await store.claim("mem-stale", "schedule-webhook", 0);
    expect(await store.pruneExpired()).toBe(1);
    expect(await store.claim("mem-live", "schedule-webhook", SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS)).toBe(true);
    expect(await store.claim("mem-stale", "schedule-webhook", SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS)).toBe(false);
  });
});
