/**
 * Issue #1968: audit read path — filters honored, payloads retrievable.
 *
 * RED tests (fail on the pre-fix code):
 * - GET /api/audit?type=<event type> returns ONLY that type, even when
 *   more than 50 newer async_job events exist (the pre-fix command
 *   fetched the newest 50 events overall and ignored every query param,
 *   so a type filter could never surface an older matching event).
 * - GET /api/audit?before/after honors the time window (limit applies
 *   AFTER filtering, not before).
 * - GET /api/audit/:id returns the single event with its full payload;
 *   unknown ids and cross-session ids 404 (pre-fix: no handler, "Not
 *   found" via fall-through).
 * - The explorer's table read (getTableData) returns newest-first so a
 *   payload-field search surfaces recent matches instead of arbitrary
 *   first-50 insertion order.
 *
 * Seeding mirrors production storage: mas_events.payload is a JSON
 * TEXT column (recordAudit stringifies), so seeds stringify too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  handleAuditRoutes,
  type AuditRouteContext,
} from "../src/agents/routes/audit";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import type { AuditEvent } from "../src/types";

const req = (method: string, path: string) =>
  new Request(`https://agent.internal${path}`, { method });

function seed(orm: DatabaseORM) {
  const ev = (id: string, sessionId: string, type: string, createdAt: string, payload: Record<string, unknown>) =>
    orm.events.create({
      id,
      sessionId,
      type,
      agent: "orchestrator",
      payload: JSON.stringify(payload),
      createdAt,
    } as never);
  // The known non-async-job event, OLDER than the async_job flood.
  ev("auth-1", "s1", "etrade.auth_blocked", "2026-10-27T09:00:00Z", {
    userLogin: "OpenAIMP",
    kind: "options",
    alerted: false,
  });
  ev("fallback-1", "s1", "screener.run_fallback", "2026-10-27T09:30:00Z", {
    from: "etrade",
    reason: "etrade-auth-dead",
  });
  for (let i = 0; i < 60; i++) {
    const mm = String(i).padStart(2, "0");
    ev(`async-${i}`, "s1", "async_job.queued", `2026-10-27T10:${mm}:00Z`, { job: i });
  }
  // Cross-session row: must never leak into session s1 reads.
  ev("other-session-1", "s2", "etrade.auth_blocked", "2026-10-27T11:00:00Z", {
    userLogin: "someone-else",
    kind: "options",
    alerted: false,
  });
}

function ctxFor(
  orm: DatabaseORM,
  sql: MockSqlStorage,
  env: { AGENT_DB: MockD1Database },
): AuditRouteContext {
  return {
    ensureTables: () => sql,
    getOrm: () => orm,
    audit: vi.fn(),
    recordAudit: vi.fn(),
    env,
  } as unknown as AuditRouteContext;
}

/**
 * #6102: the same rows in D1, through the real chained store — the
 * route reads D1 now, so the read-path tests seed D1. The DO seed
 * above stays for the getTableData assertions (the table browser
 * still reads the DO table).
 */
async function seedD1(): Promise<{ AGENT_DB: MockD1Database }> {
  const mock = new MockD1Database();
  const store = new D1AuditEventStore(createD1AuditEventDb(mock as never));
  const ev = (
    id: string,
    sessionId: string,
    type: string,
    createdAt: string,
    payload: Record<string, unknown>,
  ) =>
    store.create({
      id,
      sessionId,
      type,
      agent: "orchestrator",
      payload: JSON.stringify(payload),
      createdAt,
    } as unknown as AuditEvent);
  // Awaited in order: the store serializes appends on a module-level
  // mutex, so un-awaited seeds would still be queued behind it when
  // the test's read runs.
  await ev("auth-1", "s1", "etrade.auth_blocked", "2026-10-27T09:00:00Z", {
    userLogin: "OpenAIMP",
    kind: "options",
    alerted: false,
  });
  await ev("fallback-1", "s1", "screener.run_fallback", "2026-10-27T09:30:00Z", {
    from: "etrade",
    reason: "etrade-auth-dead",
  });
  for (let i = 0; i < 60; i++) {
    const mm = String(i).padStart(2, "0");
    await ev(`async-${i}`, "s1", "async_job.queued", `2026-10-27T10:${mm}:00Z`, { job: i });
  }
  await ev("other-session-1", "s2", "etrade.auth_blocked", "2026-10-27T11:00:00Z", {
    userLogin: "someone-else",
    kind: "options",
    alerted: false,
  });
  return { AGENT_DB: mock };
}

describe("audit read path (#1968)", () => {
  let orm: DatabaseORM;
  let sql: MockSqlStorage;
  let env: { AGENT_DB: MockD1Database };

  beforeEach(async () => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    seed(orm);
    env = await seedD1();
  });

  it("type filter surfaces an older matching event past the async_job flood", async () => {
    const ctx = ctxFor(orm, sql, env);
    const res = await handleAuditRoutes(
      req("GET", "/api/audit?type=etrade.auth_blocked"),
      new URL("https://x/api/audit?type=etrade.auth_blocked"),
      "/api/audit",
      "s1",
      ctx
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.count).toBe(1);
    expect(body.events[0].id).toBe("auth-1");
    // The usable-captures principle: the payload field must survive the read path.
    expect(body.events[0].payload.userLogin).toBe("OpenAIMP");
    expect(body.events[0].payload.kind).toBe("options");
  });

  it("event_type alias behaves like type", async () => {
    const ctx = ctxFor(orm, sql, env);
    const res = await handleAuditRoutes(
      req("GET", "/api/audit?event_type=screener.run_fallback"),
      new URL("https://x/api/audit?event_type=screener.run_fallback"),
      "/api/audit",
      "s1",
      ctx
    );
    const body = await res!.json();
    expect(body.count).toBe(1);
    expect(body.events[0].id).toBe("fallback-1");
  });

  it("before filter returns only events in the window, limit applied after", async () => {
    const ctx = ctxFor(orm, sql, env);
    const res = await handleAuditRoutes(
      req("GET", "/api/audit?before=2026-10-27T09:15:00Z&limit=100"),
      new URL("https://x/api/audit?before=2026-10-27T09:15:00Z&limit=100"),
      "/api/audit",
      "s1",
      ctx
    );
    const body = await res!.json();
    expect(body.count).toBe(1);
    expect(body.events[0].id).toBe("auth-1");
  });

  it("after filter excludes older events and counts the full window", async () => {
    const ctx = ctxFor(orm, sql, env);
    const res = await handleAuditRoutes(
      req("GET", "/api/audit?after=2026-10-27T09:15:00Z&limit=100"),
      new URL("https://x/api/audit?after=2026-10-27T09:15:00Z&limit=100"),
      "/api/audit",
      "s1",
      ctx
    );
    const body = await res!.json();
    // 60 async_job + 1 fallback = 61 in-window session rows.
    expect(body.count).toBe(61);
    expect(body.events.some((e: any) => e.id === "fallback-1")).toBe(true);
    expect(body.events.some((e: any) => e.id === "auth-1")).toBe(false);
  });

  it("detail endpoint returns the single event with its full payload", async () => {
    const ctx = ctxFor(orm, sql, env);
    const res = await handleAuditRoutes(
      req("GET", "/api/audit/auth-1"),
      new URL("https://x/api/audit/auth-1"),
      "/api/audit/auth-1",
      "s1",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.id).toBe("auth-1");
    expect(body.type).toBe("etrade.auth_blocked");
    expect(body.payload.userLogin).toBe("OpenAIMP");
  });

  it("detail endpoint 404s unknown ids and cross-session ids alike", async () => {
    const ctx = ctxFor(orm, sql, env);
    const missing = await handleAuditRoutes(
      req("GET", "/api/audit/nope"),
      new URL("https://x/api/audit/nope"),
      "/api/audit/nope",
      "s1",
      ctx
    );
    expect(missing).not.toBeNull();
    expect(missing!.status).toBe(404);
    const cross = await handleAuditRoutes(
      req("GET", "/api/audit/other-session-1"),
      new URL("https://x/api/audit/other-session-1"),
      "/api/audit/other-session-1",
      "s1",
      ctx
    );
    expect(cross).not.toBeNull();
    expect(cross!.status).toBe(404);
  });

  it("table read returns newest-first so payload search surfaces recent rows", () => {
    const newest = orm.getTableData("mas_events", { limit: 2 });
    // getTableData is unscoped (all sessions): the 11:00 cross-session
    // row is genuinely newest, then the 10:59 async_job row.
    expect(newest.rows.map((r: any) => r.id)).toEqual(["other-session-1", "async-59"]);
    const found = orm.getTableData("mas_events", { search: "userLogin" });
    expect(found.rows.some((r: any) => r.id === "auth-1")).toBe(true);
  });
});
