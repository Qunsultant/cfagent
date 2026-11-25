/**
 * Assessment P1 (#143, issue #257): the NLQ execution seam records exactly
 * one mas_events audit row per execution (nlq.executed / nlq.error), and
 * the audit write never carries the raw query text (redaction discipline).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  executeNLQQuery,
  executeNLQQueryAsync,
  type NLQPlan,
  type NLQQueryResult,
} from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import type { Env } from "../src/types";

function tablesPlan(): NLQPlan {
  return { domain: "tables", operation: "list", role: "any" };
}

describe("NLQ execution observability (Assessment P1 #143, issue #257)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  // #6102: audit rows land in D1 now — one fresh mock + env per test
  // (a shared env would share the memoized port across tests).
  let d1Store: D1AuditEventStore;
  let env: Env;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("obs_session");
    const d1Mock = new MockD1Database();
    d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    env = { AGENT_DB: d1Mock } as unknown as Env;
  });

  // The sync entry fire-and-forgets the D1 write, so poll briefly
  // until the row lands instead of asserting a race.
  async function pollAuditEvents(type: string) {
    let rows = await d1Store.findMany({ where: { type } });
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await d1Store.findMany({ where: { type } });
    }
    return rows;
  }

  it("writes exactly one nlq.executed audit row per sync execution", async () => {
    const result: NLQQueryResult = executeNLQQuery(orm, "obs_session", tablesPlan(), env);
    expect(result.domain).toBe("tables");

    const events = await pollAuditEvents("nlq.executed");
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.agent).toBe("nlq");
    expect(ev.sessionId).toBe("obs_session");
    // #2178 S1: stored payload is JSON text — parse the stored form.
    const payload = JSON.parse(ev.payload as unknown as string) as Record<string, unknown>;
    expect(payload.domain).toBe("tables");
    expect(typeof payload.count).toBe("number");
    expect(typeof payload.durationMs).toBe("number");
    // Redaction: the raw query must never be logged.
    expect("query" in payload).toBe(false);
    expect("terms" in payload).toBe(false);
  });

  it("writes exactly one nlq.executed row for the async entry (no double audit)", async () => {
    await executeNLQQueryAsync(orm, "obs_session", tablesPlan(), env);

    // The async entry awaits the audit write — direct read.
    const executed = await d1Store.findMany({ where: { type: "nlq.executed" } });
    expect(executed).toHaveLength(1);
    const errors = await d1Store.findMany({ where: { type: "nlq.error" } });
    expect(errors).toHaveLength(0);
  });

  it("writes an nlq.error row and rethrows when execution throws", async () => {
    const boom = new Error("listTables exploded");
    const brokenOrm = {
      listTables: () => {
        throw boom;
      },
      events: orm.events,
    } as unknown as DatabaseORM;

    expect(() => executeNLQQuery(brokenOrm, "obs_session", tablesPlan(), env)).toThrow(boom);

    const events = await pollAuditEvents("nlq.error");
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.agent).toBe("nlq");
    // #2178 S1: stored payload is JSON text — parse the stored form.
    const payload = JSON.parse(ev.payload as unknown as string) as Record<string, unknown>;
    expect(payload.error).toContain("listTables exploded");
    expect("query" in payload).toBe(false);
  });

  it("executes normally when no events repository exists (audit is best-effort)", () => {
    const noEventsOrm = { listTables: () => [] } as unknown as DatabaseORM;
    const result = executeNLQQuery(noEventsOrm, "obs_session", tablesPlan());
    expect(result.domain).toBe("tables");
  });
});
