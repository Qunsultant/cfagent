/**
 * Issue #786 (RSI-Data Tier 3, C6): retention for mas_events + mas_memory.
 *
 * The nightly pass (runStorageRetention, src/security/storageRetention.ts)
 * historically pruned only mas_messages (#255). mas_events (the audit/event
 * log) and mas_memory (key/value store, aged by updated_at) grew unboundedly
 * in every per-user orchestrator DO. The pass now also prunes both at a
 * default 365-day window, env-configurable via MAS_EVENTS_RETENTION_DAYS /
 * MAS_MEMORY_RETENTION_DAYS, oldest first, batched and capped like the
 * messages pass — and never silently: the run's STORAGE_RETENTION audit row
 * and a console.info line both carry the per-table counts.
 *
 * Red state on pre-#786 code: aged mas_events / mas_memory rows survive the
 * pass (nothing prunes them) and the result carries no per-table counts.
 *
 * Harness: MockSqlStorage + DatabaseORM (tests/mock-sql.ts), same as
 * tests/storage-retention.test.ts. Boundary semantics are the idiom's:
 * the cutoff comparison is a strict `<`, so a row exactly AT the cutoff
 * is younger-side and survives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  MAS_EVENTS_RETENTION_DEFAULT_DAYS,
  MAS_MEMORY_RETENTION_DEFAULT_DAYS,
  runStorageRetention,
  type StorageRetentionOptions,
} from "../src/security/storageRetention";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import type { AuditEvent } from "../src/types";

const FIXED_NOW = new Date("2026-10-18T12:00:00.000Z").getTime();
const DAY = 86_400_000;
const isoDaysAgo = (days: number) => new Date(FIXED_NOW - days * DAY).toISOString();

let orm: DatabaseORM;
let seq = 0;
let infoSpy: ReturnType<typeof vi.spyOn>;
// #6102: the summary row lands in D1 now — one shared mock per test
// plus the writer the pass requires (fail-closed without it).
let d1: { mock: MockD1Database; store: D1AuditEventStore };
let writer: (record: AuditEvent) => Promise<void>;

async function runPass(
  o: DatabaseORM,
  options: Omit<StorageRetentionOptions, "writeAuditEvent" | "auditEvents"> = {},
) {
  return runStorageRetention(o, {
    ...options,
    writeAuditEvent: writer,
    auditEvents: d1.store,
  });
}

function makeOrm(): DatabaseORM {
  const sql = new MockSqlStorage();
  const o = new DatabaseORM(sql);
  o.initializeSchema("sess_data_retention_test");
  return o;
}

function seedEvent(daysAgo: number): string {
  const id = `ev_${seq++}`;
  orm.events.create({
    id,
    sessionId: "sess_data_retention_test",
    type: "TEST_EVENT",
    agent: "orchestrator",
    payload: { seeded: true },
    createdAt: isoDaysAgo(daysAgo),
  });
  return id;
}

function seedMemory(daysAgo: number): string {
  const key = `mem_${seq++}`;
  orm.memory.create({
    key,
    value: `value ${daysAgo}d old`,
    updatedAt: isoDaysAgo(daysAgo),
  });
  return key;
}

beforeEach(() => {
  seq = 0;
  orm = makeOrm();
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  const mock = new MockD1Database();
  d1 = { mock, store: new D1AuditEventStore(createD1AuditEventDb(mock as never)) };
  writer = async (record: AuditEvent) => {
    await d1.store.create(record);
  };
});

afterEach(() => {
  infoSpy.mockRestore();
});

describe("mas_events retention (issue #786)", () => {
  it("exposes 365-day defaults for both new windows", async () => {
    expect(MAS_EVENTS_RETENTION_DEFAULT_DAYS).toBe(365);
    expect(MAS_MEMORY_RETENTION_DEFAULT_DAYS).toBe(365);
  });

  it("prunes events older than the default 365d window and keeps fresh ones", async () => {
    const aged = seedEvent(366);
    const boundary = seedEvent(365); // created_at == cutoff: NOT pruned (strict <)
    const fresh = seedEvent(10);

    const res = await runPass(orm, { now: () => FIXED_NOW });

    expect(res.eventsWindowDays).toBe(365);
    expect(res.eventsCutoffIso).toBe(isoDaysAgo(365));
    expect(res.eventsPruned).toBe(1);
    expect(res.eventsSkipped).toBe(false);
    expect(orm.events.findById(aged)).toBeNull();
    expect(orm.events.findById(boundary)).not.toBeNull();
    expect(orm.events.findById(fresh)).not.toBeNull();
  });

  it("honors a custom MAS_EVENTS window", async () => {
    const aged = seedEvent(40);
    const fresh = seedEvent(20);

    const res = await runPass(orm, {
      eventsRetentionDays: "30",
      now: () => FIXED_NOW,
    });

    expect(res.eventsWindowDays).toBe(30);
    expect(res.eventsPruned).toBe(1);
    expect(orm.events.findById(aged)).toBeNull();
    expect(orm.events.findById(fresh)).not.toBeNull();
  });

  it("prunes the live D1 mas_events table under the same window (#6102)", async () => {
    // Seed the D1 table directly through the real chained store.
    const seedD1Event = async (daysAgo: number, id: string) => {
      await d1.store.create({
        id,
        sessionId: "sess_data_retention_test",
        type: "TEST_EVENT",
        agent: "orchestrator",
        payload: { seeded: true },
        createdAt: isoDaysAgo(daysAgo),
      } as unknown as AuditEvent);
    };
    await seedD1Event(366, "d1_aged");
    await seedD1Event(10, "d1_fresh");

    const res = await runPass(orm, { now: () => FIXED_NOW });

    expect(res.eventsPruned).toBe(1);
    expect(await d1.store.findById("d1_aged")).toBeNull();
    expect(await d1.store.findById("d1_fresh")).not.toBeNull();
    const audits = await d1.store.findMany({ where: { type: "STORAGE_RETENTION" } });
    const payload = JSON.parse(audits[0].payload as unknown as string) as Record<string, unknown>;
    expect(payload.d1EventsPruned).toBe(1);
    expect(payload.d1EventsSkipped).toBe(false);
  });

  it("fails closed without a summary writer — never a silent DO fallback (#6102)", async () => {
    await expect(
      runStorageRetention(orm, { now: () => FIXED_NOW } as never),
    ).rejects.toThrowError("writeAuditEvent");
    expect(
      orm.events.findMany({ where: { type: "STORAGE_RETENTION" } })
    ).toHaveLength(0);
  });

  it("an events window <= 0 disables only the events prune", async () => {
    const agedEvent = seedEvent(400);
    const agedMemory = seedMemory(400);

    const res = await runPass(orm, {
      eventsRetentionDays: 0,
      now: () => FIXED_NOW,
    });

    expect(res.eventsSkipped).toBe(true);
    expect(res.eventsPruned).toBe(0);
    expect(orm.events.findById(agedEvent)).not.toBeNull();
    // Memory pruning is independent and still runs.
    expect(res.memoryPruned).toBe(1);
    expect(orm.memory.findById(agedMemory)).toBeNull();
  });

  it("prunes events oldest-first across batches and respects the per-run cap", async () => {
    for (const d of [500, 480, 460, 440, 420]) seedEvent(d);
    const fresh = seedEvent(3);

    const first = await runPass(orm, {
      now: () => FIXED_NOW,
      batchSize: 2,
      maxPerRun: 3,
    });
    expect(first.eventsPruned).toBe(3);
    expect(first.eventsCapped).toBe(true);

    const second = await runPass(orm, {
      now: () => FIXED_NOW,
      batchSize: 2,
      maxPerRun: 3,
    });
    expect(second.eventsPruned).toBe(2);
    expect(second.eventsCapped).toBe(false);
    expect(orm.events.findById(fresh)).not.toBeNull();
    // Remaining in the DO table: only the fresh seeded event — the two
    // runs' own audit rows land in D1 now (#6102).
    expect(orm.events.count()).toBe(1);
    expect(
      await d1.store.findMany({ where: { type: "STORAGE_RETENTION" } })
    ).toHaveLength(2);
  });
});

describe("mas_memory retention (issue #786)", () => {
  it("prunes memory rows whose updated_at is older than the default 365d window", async () => {
    const aged = seedMemory(366);
    const boundary = seedMemory(365); // updated_at == cutoff: NOT pruned
    const fresh = seedMemory(1);

    const res = await runPass(orm, { now: () => FIXED_NOW });

    expect(res.memoryWindowDays).toBe(365);
    expect(res.memoryCutoffIso).toBe(isoDaysAgo(365));
    expect(res.memoryPruned).toBe(1);
    expect(res.memorySkipped).toBe(false);
    expect(orm.memory.findById(aged)).toBeNull();
    expect(orm.memory.findById(boundary)).not.toBeNull();
    expect(orm.memory.findById(fresh)).not.toBeNull();
  });

  it("honors a custom MAS_MEMORY window and a disabling window", async () => {
    const aged = seedMemory(90);
    const fresh = seedMemory(10);

    const res = await runPass(orm, {
      memoryRetentionDays: 30,
      now: () => FIXED_NOW,
    });
    expect(res.memoryWindowDays).toBe(30);
    expect(res.memoryPruned).toBe(1);
    expect(orm.memory.findById(aged)).toBeNull();
    expect(orm.memory.findById(fresh)).not.toBeNull();

    const stillAged = seedMemory(500);
    const disabled = await runPass(orm, {
      memoryRetentionDays: 0,
      now: () => FIXED_NOW,
    });
    expect(disabled.memorySkipped).toBe(true);
    expect(disabled.memoryPruned).toBe(0);
    expect(orm.memory.findById(stillAged)).not.toBeNull();
  });

  it("a recently-updated memory row survives even when first written long ago", async () => {
    // mas_memory ages by updated_at, not by first write: an entry the
    // agent keeps touching is live state, not residue.
    const key = "mem_live";
    orm.memory.create({ key, value: "v1", updatedAt: isoDaysAgo(700) });
    orm.memory.update(key, { value: "v2", updatedAt: isoDaysAgo(2) });

    const res = await runPass(orm, { now: () => FIXED_NOW });

    expect(res.memoryPruned).toBe(0);
    expect(orm.memory.findById(key)).not.toBeNull();
    expect(orm.memory.findById(key)?.value).toBe("v2");
  });
});

describe("pass-level behaviour (issue #786)", () => {
  it("records the per-table counts in the run's STORAGE_RETENTION audit row", async () => {
    seedEvent(400);
    seedEvent(401);
    seedMemory(400);

    const res = await runPass(orm, { now: () => FIXED_NOW });

    // #6102: the summary row lands in D1 now.
    const audits = await d1.store.findMany({ where: { type: "STORAGE_RETENTION" } });
    expect(audits).toHaveLength(1);
    // #2178 S1: stored payload is JSON text — parse the stored form.
    const payload = JSON.parse(audits[0].payload as unknown as string) as Record<string, unknown>;
    expect(payload.eventsPruned).toBe(res.eventsPruned);
    expect(payload.eventsPruned).toBe(2);
    expect(payload.eventsWindowDays).toBe(365);
    expect(payload.eventsCutoffIso).toBe(res.eventsCutoffIso);
    expect(payload.memoryPruned).toBe(1);
    expect(payload.memoryWindowDays).toBe(365);
    // The audit row itself is fresh and survives its own run's prune.
    expect(await d1.store.findById(audits[0].id)).not.toBeNull();
  });

  it("logs the per-table counts (never prunes silently)", async () => {
    seedEvent(400);
    seedMemory(400);

    await runPass(orm, { now: () => FIXED_NOW });

    const lines = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("mas_events");
    expect(lines).toContain("mas_memory");
    expect(lines).toMatch(/mas_events pruned 1/);
    expect(lines).toMatch(/mas_memory pruned 1/);
  });

  it("the messages window <= 0 still disables the whole pass, events and memory included", async () => {
    const agedEvent = seedEvent(400);
    const agedMemory = seedMemory(400);

    const res = await runPass(orm, {
      retentionDays: 0,
      now: () => FIXED_NOW,
    });

    expect(res.skipped).toBe(true);
    expect(res.eventsPruned).toBe(0);
    expect(res.memoryPruned).toBe(0);
    expect(orm.events.findById(agedEvent)).not.toBeNull();
    expect(orm.memory.findById(agedMemory)).not.toBeNull();
    expect(
      await d1.store.findMany({ where: { type: "STORAGE_RETENTION" } })
    ).toHaveLength(0);
  });

  it("an unparseable events window falls back to the 365d default", async () => {
    const aged = seedEvent(366);
    const fresh = seedEvent(300);

    const res = await runPass(orm, {
      eventsRetentionDays: "not-a-number",
      now: () => FIXED_NOW,
    });

    expect(res.eventsWindowDays).toBe(365);
    expect(res.eventsPruned).toBe(1);
    expect(orm.events.findById(aged)).toBeNull();
    expect(orm.events.findById(fresh)).not.toBeNull();
  });
});
