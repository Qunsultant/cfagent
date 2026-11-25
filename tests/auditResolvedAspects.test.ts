/**
 * Issue #2371 (AOP phase 2, program #1969; renders the #2381 outcome
 * catalog): audit-channel rendering resolves outcome aspects at read
 * time, through the single outcome resolver only.
 *
 * RED tests (fail on the pre-slice code, which returns the 5-field
 * projection with no resolved field):
 * - GET /api/audit and GET /api/audit/:id attach `resolvedAspects`
 *   (code, businessMessage, category, retryable, variant) for a
 *   cataloged code found in the payload (`coded_error` or `code`),
 *   for failure AND success codes.
 * - Pre-rename codes resolve through legacyAliases to the NEW code's
 *   aspects (stored value untouched): AUTH_003 ->
 *   FAILURE_AUTH_NO_SESSION, SCREEN_003 ->
 *   FAILURE_SCREEN_NO_CONTRACTS_EVALUATED, REPORT_002 ->
 *   FAILURE_REPORT_XLSX_GENERATION.
 * - Unknown codes pass through unresolved (null) without error.
 * - Unparseable payloads ({ raw } fallback) still read, unresolved.
 * - Stored rows are byte-identical after reads (no rewrite).
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

/**
 * #6102: the event log lives in D1 now — seeds write through the
 * real chained store, so the route reads exactly what production
 * reads. Seeding mirrors production storage: mas_events.payload is
 * a JSON TEXT column (recordAudit stringifies), so seeds stringify
 * too.
 */
async function seedD1(): Promise<{
  env: { AGENT_DB: MockD1Database };
  store: D1AuditEventStore;
}> {
  const mock = new MockD1Database();
  const store = new D1AuditEventStore(createD1AuditEventDb(mock as never));
  const ev = (id: string, payload: Record<string, unknown> | string) =>
    store.create({
      id,
      sessionId: "s1",
      type: "test.event",
      agent: "orchestrator",
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      createdAt: "2026-10-27T09:00:00Z",
    } as unknown as AuditEvent);
  await ev("coded-1", { coded_error: "AUTH_003", job: 1 });
  await ev("code-1", { code: "SCREEN_003" });
  await ev("bracket-1", { coded_error: "[REPORT_002] The XLSX report could not be generated." });
  await ev("obj-1", { coded_error: { code: "AUTH_003" } });
  await ev("both-1", { coded_error: "NOPE_999", code: "AUTH_003" });
  await ev("newcode-1", { coded_error: "FAILURE_REPORT_XLSX_GENERATION" });
  await ev("success-1", { code: "SUCCESS_SCREEN_COMPLETED" });
  await ev("unknown-1", { coded_error: "NOPE_999" });
  await ev("raw-1", "not-json{");
  await ev("plain-1", { job: 1 });
  return { env: { AGENT_DB: mock }, store };
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

const AUTH_MSG =
  "No E*TRADE session is stored for this account. Please connect your account in Settings.";
const SCREEN_MSG =
  "The options screen was discarded — no contracts could be evaluated.";
const REPORT_MSG = "The XLSX report could not be generated.";

describe("audit resolved aspects (#2371, outcome catalog #2381)", () => {
  let orm: DatabaseORM;
  let sql: MockSqlStorage;
  let ctx: AuditRouteContext;
  let store: D1AuditEventStore;

  beforeEach(async () => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    const seeded = await seedD1();
    store = seeded.store;
    ctx = ctxFor(orm, sql, seeded.env);
  });

  async function listEvents() {
    const res = await handleAuditRoutes(
      req("GET", "/api/audit"),
      new URL("https://agent.internal/api/audit"),
      "/api/audit",
      "s1",
      ctx
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { events: Array<Record<string, any>> };
    const byId = new Map(body.events.map((e) => [e.id, e]));
    return byId;
  }

  it("list resolves a pre-rename coded_error through legacyAliases to the new code", async () => {
    const byId = await listEvents();
    expect(byId.get("coded-1")!.resolvedAspects).toEqual({
      code: "FAILURE_AUTH_NO_SESSION",
      businessMessage: AUTH_MSG,
      category: "auth",
      retryable: false,
      variant: `[FAILURE_AUTH_NO_SESSION] ${AUTH_MSG}`,
    });
    // Original payload returned unchanged alongside the projection.
    expect(byId.get("coded-1")!.payload).toEqual({ coded_error: "AUTH_003", job: 1 });
  });

  it("list resolves code fields, bracket renderings, object codes, and new codes", async () => {
    const byId = await listEvents();
    expect(byId.get("code-1")!.resolvedAspects).toEqual({
      code: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
      businessMessage: SCREEN_MSG,
      category: "screen",
      retryable: true,
      variant: `[FAILURE_SCREEN_NO_CONTRACTS_EVALUATED] ${SCREEN_MSG}`,
    });
    expect(byId.get("bracket-1")!.resolvedAspects).toEqual({
      code: "FAILURE_REPORT_XLSX_GENERATION",
      businessMessage: REPORT_MSG,
      category: "report",
      retryable: true,
      variant: `[FAILURE_REPORT_XLSX_GENERATION] ${REPORT_MSG}`,
    });
    expect(byId.get("obj-1")!.resolvedAspects!.code).toBe("FAILURE_AUTH_NO_SESSION");
    expect(byId.get("newcode-1")!.resolvedAspects!.code).toBe("FAILURE_REPORT_XLSX_GENERATION");
    // First cataloged code wins: unknown coded_error falls through to code.
    expect(byId.get("both-1")!.resolvedAspects!.code).toBe("FAILURE_AUTH_NO_SESSION");
  });

  it("list resolves cataloged success codes, not only failures", async () => {
    const byId = await listEvents();
    expect(byId.get("success-1")!.resolvedAspects).toEqual({
      code: "SUCCESS_SCREEN_COMPLETED",
      businessMessage: "Screen completed.",
      category: "screen",
      retryable: false,
      variant: "[SUCCESS_SCREEN_COMPLETED] Screen completed.",
    });
  });

  it("list passes unknown codes and plain payloads through unresolved", async () => {
    const byId = await listEvents();
    expect(byId.get("unknown-1")!.resolvedAspects).toBeNull();
    expect(byId.get("unknown-1")!.payload).toEqual({ coded_error: "NOPE_999" });
    expect(byId.get("plain-1")!.resolvedAspects).toBeNull();
  });

  it("list keeps the { raw } fallback readable and unresolved", async () => {
    const byId = await listEvents();
    expect(byId.get("raw-1")!.payload).toEqual({ raw: "not-json{" });
    expect(byId.get("raw-1")!.resolvedAspects).toBeNull();
  });

  it("detail resolves a cataloged code", async () => {
    const res = await handleAuditRoutes(
      req("GET", "/api/audit/coded-1"),
      new URL("https://agent.internal/api/audit/coded-1"),
      "/api/audit/coded-1",
      "s1",
      ctx
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.resolvedAspects).toEqual({
      code: "FAILURE_AUTH_NO_SESSION",
      businessMessage: AUTH_MSG,
      category: "auth",
      retryable: false,
      variant: `[FAILURE_AUTH_NO_SESSION] ${AUTH_MSG}`,
    });
    expect(body.payload).toEqual({ coded_error: "AUTH_003", job: 1 });
  });

  it("detail passes an unknown code through unresolved without error", async () => {
    const res = await handleAuditRoutes(
      req("GET", "/api/audit/unknown-1"),
      new URL("https://agent.internal/api/audit/unknown-1"),
      "/api/audit/unknown-1",
      "s1",
      ctx
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.resolvedAspects).toBeNull();
  });

  it("reads never rewrite stored rows", async () => {
    await listEvents();
    await handleAuditRoutes(
      req("GET", "/api/audit/coded-1"),
      new URL("https://agent.internal/api/audit/coded-1"),
      "/api/audit/coded-1",
      "s1",
      ctx
    );
    // #6102: the stored rows live in D1 now.
    const row = await store.findById("coded-1");
    // Pre-rename value stays stored verbatim; only the read-time
    // projection carries the new code.
    expect(row!.payload).toBe(JSON.stringify({ coded_error: "AUTH_003", job: 1 }));
    const raw = await store.findById("raw-1");
    expect(raw!.payload).toBe("not-json{");
  });
});
