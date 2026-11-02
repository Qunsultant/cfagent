/**
 * Issue #255 (Assessment P1, part of #143): mas_messages retention.
 *
 * The scheduled() handler's nightly cron triggers
 * runStorageRetention() against the Orchestrator agent's DatabaseORM
 * (see src/security/storageRetention.ts). Rows older than the window go
 * away oldest-first in bounded batches with a per-run cap, and one
 * mas_events row records each run.
 *
 * Harness: MockSqlStorage + DatabaseORM (tests/mock-sql.ts). The mock was
 * extended (issue #255) to support <, >, <=, >= in WHERE so the retention
 * cutoff predicate behaves like real SQLite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  STORAGE_RETENTION_DEFAULT_DAYS,
  resolveRetentionDays,
  runStorageRetention,
} from "../src/security/storageRetention";

const FIXED_NOW = new Date("2026-10-18T12:00:00.000Z").getTime();
const DAY = 86_400_000;
const isoDaysAgo = (days: number) => new Date(FIXED_NOW - days * DAY).toISOString();

let orm: DatabaseORM;
let seq = 0;

function makeOrm(): DatabaseORM {
  const sql = new MockSqlStorage();
  const o = new DatabaseORM(sql);
  o.initializeSchema("sess_retention_test");
  return o;
}

function seedMessage(daysAgo: number): string {
  const id = `msg_${seq++}`;
  orm.messages.create({
    id,
    sessionId: "sess_retention_test",
    role: "user",
    content: `message ${daysAgo}d old`,
    agent: "chat",
    createdAt: isoDaysAgo(daysAgo),
  });
  return id;
}

beforeEach(() => {
  seq = 0;
  orm = makeOrm();
});

describe("resolveRetentionDays", () => {
  it("defaults to 90 when unset, blank, or unparseable", () => {
    expect(resolveRetentionDays(undefined)).toBe(STORAGE_RETENTION_DEFAULT_DAYS);
    expect(resolveRetentionDays(null)).toBe(STORAGE_RETENTION_DEFAULT_DAYS);
    expect(resolveRetentionDays("")).toBe(STORAGE_RETENTION_DEFAULT_DAYS);
    expect(resolveRetentionDays("not-a-number")).toBe(STORAGE_RETENTION_DEFAULT_DAYS);
  });
  it("parses string values", () => {
    expect(resolveRetentionDays("30")).toBe(30);
  });
  it("passes numbers through and honors <= 0 as 'disabled'", () => {
    expect(resolveRetentionDays(7)).toBe(7);
    expect(resolveRetentionDays(0)).toBe(0);
    expect(resolveRetentionDays(-1)).toBe(-1);
  });
});

describe("runStorageRetention", () => {
  it("prunes rows older than the default 90d window and keeps fresh rows", () => {
    const oldId = seedMessage(91);
    const freshId1 = seedMessage(10);
    const freshId2 = seedMessage(1);

    const res = runStorageRetention(orm, { now: () => FIXED_NOW });

    expect(res.skipped).toBe(false);
    expect(res.pruned).toBe(1);
    expect(res.windowDays).toBe(90);
    expect(res.cutoffIso).toBe(isoDaysAgo(90));
    expect(orm.messages.findById(oldId)).toBeNull();
    expect(orm.messages.findById(freshId1)).not.toBeNull();
    expect(orm.messages.findById(freshId2)).not.toBeNull();
  });

  it("never deletes an unexpired row: a row exactly at the cutoff survives (#2928)", () => {
    const atCutoffId = seedMessage(90);
    const olderId = seedMessage(91);
    const freshId = seedMessage(10);

    const res = runStorageRetention(orm, { now: () => FIXED_NOW });

    expect(res.pruned).toBe(1);
    expect(res.cutoffIso).toBe(isoDaysAgo(90));
    expect(orm.messages.findById(olderId)).toBeNull();
    expect(orm.messages.findById(atCutoffId)).not.toBeNull();
    expect(orm.messages.findById(freshId)).not.toBeNull();
  });

  it("honors a custom window", () => {
    const oldId = seedMessage(40);
    const freshId = seedMessage(20);

    const res = runStorageRetention(orm, { retentionDays: 30, now: () => FIXED_NOW });

    expect(res.pruned).toBe(1);
    expect(orm.messages.findById(oldId)).toBeNull();
    expect(orm.messages.findById(freshId)).not.toBeNull();
  });

  it("prunes oldest first across batches", () => {
    for (const d of [200, 150, 120, 100]) seedMessage(d);
    const freshId = seedMessage(5);

    const res = runStorageRetention(orm, {
      now: () => FIXED_NOW,
      batchSize: 2,
      maxPerRun: 100,
    });

    expect(res.pruned).toBe(4);
    expect(res.capped).toBe(false);
    expect(orm.messages.count()).toBe(1);
    expect(orm.messages.findById(freshId)).not.toBeNull();
  });

  it("respects the per-run cap and flags it", () => {
    for (let i = 0; i < 5; i++) seedMessage(100 + i);

    const first = runStorageRetention(orm, {
      now: () => FIXED_NOW,
      maxPerRun: 3,
    });
    expect(first.pruned).toBe(3);
    expect(first.capped).toBe(true);
    expect(orm.messages.count()).toBe(2);

    const second = runStorageRetention(orm, {
      now: () => FIXED_NOW,
      maxPerRun: 3,
    });
    expect(second.pruned).toBe(2);
    expect(second.capped).toBe(false);
    expect(orm.messages.count()).toBe(0);
  });

  it("is disabled when the window is <= 0: nothing touched, no audit event", () => {
    const id1 = seedMessage(300);
    const id2 = seedMessage(1);

    for (const window of [0, -5]) {
      const res = runStorageRetention(orm, { retentionDays: window, now: () => FIXED_NOW });
      expect(res.skipped).toBe(true);
      expect(res.pruned).toBe(0);
      expect(res.cutoffIso).toBeNull();
    }
    expect(orm.messages.findById(id1)).not.toBeNull();
    expect(orm.messages.findById(id2)).not.toBeNull();
    expect(
      orm.events.findMany({ where: { type: "STORAGE_RETENTION" } })
    ).toHaveLength(0);
  });

  it("records one mas_events row per run with the run summary", () => {
    seedMessage(95);
    seedMessage(2);

    const res = runStorageRetention(orm, { now: () => FIXED_NOW });

    const events = orm.events.findMany({ where: { type: "STORAGE_RETENTION" } });
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.agent).toBe("orchestrator");
    expect(ev.sessionId).toBe("system");
    // #2178 S1: stored payload is JSON text — parse the stored form.
    const payload = JSON.parse(ev.payload as unknown as string) as Record<string, unknown>;
    expect(payload.pruned).toBe(1);
    expect(payload.windowDays).toBe(90);
    expect(payload.cutoffIso).toBe(res.cutoffIso);
    expect(payload.capped).toBe(false);
    expect(ev.id).toMatch(/^retention_/);
  });

  it("still records an audit event when nothing was pruned", () => {
    seedMessage(1);

    const res = runStorageRetention(orm, { now: () => FIXED_NOW });

    expect(res.pruned).toBe(0);
    const events = orm.events.findMany({ where: { type: "STORAGE_RETENTION" } });
    expect(events).toHaveLength(1);
    expect((JSON.parse(events[0].payload as unknown as string) as Record<string, unknown>).pruned).toBe(0);
  });
});
