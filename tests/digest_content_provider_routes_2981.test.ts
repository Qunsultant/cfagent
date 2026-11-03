// @vitest-environment node
/**
 * Issue #2981 (monetization Phase 2.18) — digest content provider,
 * route level: the run-due tick path uses the provider; the
 * operator itemsByUser override still wins; other-tenant rows
 * never leak into a subscriber's digest.
 *
 * Harness mirrors tests/lifecycle_digest_pass_2659.test.ts
 * (MockD1Database over node:sqlite). The agent_reports rows are
 * seeded directly into the mock's sqlite handle after
 * ensureAuditReportSchema creates the projection table.
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1LifecycleDb,
  D1LifecycleAdapter,
  ensureLifecycleSchema,
} from "../src/data/d1LifecycleAdapter";
import {
  createD1AuditReportDb,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";

/** Minimal D1Database stand-in over node:sqlite (mirrors #2659). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function setup() {
  const mock = new MockD1Database();
  const db = createD1LifecycleDb(mock as unknown as D1Database);
  await ensureLifecycleSchema(db);
  await ensureAuditReportSchema(createD1AuditReportDb(mock as unknown as D1Database));
  const emailSend = vi.fn(async () => undefined);
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    EMAIL: { send: emailSend },
    LIFECYCLE_UNSUBSCRIBE_SECRET: "route-test-secret",
    SERVICE_USER_LOGIN: "svc",
  };
  const ctx = {
    env,
    getOrm: () => ({}),
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const store = new D1LifecycleAdapter(db);
  return { ctx, emailSend, mock, store };
}

const RUN_DUE = "/payments/agentic/commercial/lifecycle/digest/run-due";

function req(method: string, path: string, login: string | null, body?: unknown) {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function call(
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
) {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
}

function seedReport(
  mock: MockD1Database,
  over: {
    tenant: string;
    reportId: string;
    title: string;
    summary: string;
    createdAtMs: number;
  },
) {
  mock.sqlite
    .prepare(
      `INSERT INTO agent_reports (tenant_id, workspace_id, report_id, run_id, generation_id, title, source, summary, body, created_at_ms, updated_at_ms, version, provenance_writer, provenance_source_do, provenance_source_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      over.tenant,
      "primary",
      over.reportId,
      `run-${over.reportId}`,
      null,
      over.title,
      "screener",
      over.summary,
      "{}",
      over.createdAtMs,
      over.createdAtMs,
      1,
      "test-seed",
      "test-do",
      "1",
    );
}

async function subscribe(
  ctx: AgenticPaymentsRouteContext,
  store: D1LifecycleAdapter,
) {
  await call(ctx, "POST", "/payments/agentic/commercial/lifecycle/preferences", "u1", {
    userId: "u1",
    tenantId: "t1",
    digestEnabled: true,
  });
  await store.setSubscriberEmail("u1", "t1", "u1@example.com");
}

describe("digest run-due tick path with the content provider (#2981)", () => {
  it("tick (no itemsByUser) sends a digest with projection highlights", async () => {
    const { ctx, emailSend, mock, store } = await setup();
    await subscribe(ctx, store);
    const now = Date.now();
    seedReport(mock, {
      tenant: "t1",
      reportId: "r-recent",
      title: "Screener highlights",
      summary: "AAPL flagged",
      createdAtMs: now - 3600_000,
    });
    seedReport(mock, {
      tenant: "t1",
      reportId: "r-old",
      title: "Stale highlights",
      summary: "OLD flagged",
      createdAtMs: now - 5 * 24 * 3600_000,
    });
    seedReport(mock, {
      tenant: "t2",
      reportId: "r-other",
      title: "Other tenant highlights",
      summary: "OTHER flagged",
      createdAtMs: now - 3600_000,
    });

    const run = await call(ctx, "POST", RUN_DUE, "svc", {});
    const body = (await run?.json()) as any;
    expect(run?.status).toBe(200);
    expect(body.fired).toBe(true);
    expect(body.summary.sent).toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    const sentBody = (emailSend.mock.calls[0][0] as any).text as string;
    expect(sentBody).toContain("Screener highlights: AAPL flagged");
    expect(sentBody).not.toContain("Stale highlights");
    expect(sentBody).not.toContain("Other tenant highlights");
  });

  it("operator itemsByUser override wins over projection rows", async () => {
    const { ctx, emailSend, mock, store } = await setup();
    await subscribe(ctx, store);
    seedReport(mock, {
      tenant: "t1",
      reportId: "r-recent",
      title: "Screener highlights",
      summary: "AAPL flagged",
      createdAtMs: Date.now() - 3600_000,
    });

    const run = await call(ctx, "POST", RUN_DUE, "svc", {
      itemsByUser: { u1: ["manual highlight"] },
    });
    const body = (await run?.json()) as any;
    expect(body.summary.sent).toBe(1);
    const sentBody = (emailSend.mock.calls[0][0] as any).text as string;
    expect(sentBody).toContain("manual highlight");
    expect(sentBody).not.toContain("Screener highlights");
  });

  it("tick with no projection rows still skips-on-empty (honest skip)", async () => {
    const { ctx, emailSend, store } = await setup();
    await subscribe(ctx, store);
    const run = await call(ctx, "POST", RUN_DUE, "svc", {});
    const body = (await run?.json()) as any;
    expect(body.fired).toBe(true);
    expect(body.summary.results).toEqual([
      { userId: "u1", tenantId: "t1", sent: false, reason: "empty-skipped" },
    ]);
    expect(emailSend).not.toHaveBeenCalled();
  });
});
