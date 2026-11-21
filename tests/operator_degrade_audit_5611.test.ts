/**
 * Issue #5611 (G-9/G-14) — the operator-list degrade is loud; the audit
 * pagination default is externalized.
 *
 * Pins:
 * - G-9: a failing store operator read logs structurally
 *   (`agenticPayments.store_operator_read_failed`) AND writes an audit
 *   record (`payments.store_operator_read_failed` on the payments funnel).
 * - G-9: the degrade behavior is unchanged — env operators stay
 *   authorized, non-operators stay denied (403), no 500, no lockout.
 * - G-14: GET /audit with no limit returns COMMERCIAL_DEFAULTS
 *   .auditDefaultLimit rows; the value is 50; explicit limits unchanged.
 * - G-14: the audit route reads the default from COMMERCIAL_DEFAULTS —
 *   no `|| 50` literal remains in the list branch.
 *
 * The failing store here is the documented failure mode from the
 * degrade comment itself: the 0032 table is not yet migrated, so the
 * Drizzle SELECT throws "no such table" (real adapter path over
 * node:sqlite, no Cloudflare credentials).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  handleAuditRoutes,
  type AuditRouteContext,
} from "../src/agents/routes/audit";
import { COMMERCIAL_DEFAULTS } from "../src/config/commercialDefaults";

/** Minimal D1Database stand-in over node:sqlite (mirrors store_operators_ports). */
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

/** An AGENT_DB whose store-operators table was never migrated (no 0032). */
function unmigratedAgentDb(): unknown {
  return new MockD1Database();
}

const REFERRAL_RULES = "/payments/agentic/commercial/referral-code-rules";

const payCtx = (overrides: Partial<AgenticPaymentsRouteContext> = {}): AgenticPaymentsRouteContext =>
  ({
    env: {},
    getOrm: vi.fn(() => ({ orm: true })),
    audit: vi.fn(),
    ...overrides,
  }) as unknown as AgenticPaymentsRouteContext;

const payReq = (login: string | null) =>
  new Request(`https://agent.internal${REFERRAL_RULES}`, {
    method: "GET",
    headers: login ? { "x-user-login": login } : {},
  });

const payUrl = () => new URL(`https://agent.internal${REFERRAL_RULES}`);

interface StructuredEvent {
  operation: string;
  level: string;
  component: string;
  fields: Record<string, unknown>;
}

function structuredLogEvents(spy: { mock: { calls: unknown[][] } }): StructuredEvent[] {
  const events: StructuredEvent[] = [];
  for (const call of spy.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as {
        operation?: unknown;
        level?: unknown;
        component?: unknown;
        fields?: unknown;
      };
      if (parsed && typeof parsed.operation === "string") {
        events.push({
          operation: parsed.operation,
          level: typeof parsed.level === "string" ? parsed.level : "",
          component: typeof parsed.component === "string" ? parsed.component : "",
          fields:
            parsed.fields && typeof parsed.fields === "object"
              ? (parsed.fields as Record<string, unknown>)
              : {},
        });
      }
    } catch {
      // Non-JSON console.info lines are not structured events.
    }
  }
  return events;
}

describe("operator-list degrade is loud (#5611 G-9)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("a failing store read logs structurally and audits, while env operators stay authorized", async () => {
    const ctx = payCtx({
      env: {
        AGENT_DB: unmigratedAgentDb(),
        COMMERCIAL_STORE_OPERATORS: "alice",
      },
    });
    // No productId: the route answers 400 only AFTER the operator gate
    // passes, so the status proves alice stayed an operator.
    const res = await handleAgenticPaymentsRoutes(payReq("alice"), payUrl(), REFERRAL_RULES, "s", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    const events = structuredLogEvents(infoSpy);
    const degrade = events.filter((e) => e.operation === "agenticPayments.store_operator_read_failed");
    expect(degrade).toHaveLength(1);
    expect(degrade[0].level).toBe("error");
    expect(degrade[0].component).toBe("agents/routes/agenticPayments");
    expect(typeof degrade[0].fields.error).toBe("string");

    const audit = ctx.audit as unknown as ReturnType<typeof vi.fn>;
    const degradeAudits = (audit.mock.calls as unknown[][]).filter(
      (call) => call[0] === "payments.store_operator_read_failed",
    );
    expect(degradeAudits).toHaveLength(1);
    expect(degradeAudits[0][1]).toBe("payments");
    expect(degradeAudits[0][2]).toMatchObject({ login: "alice", envOperatorCount: 1 });
    expect(typeof (degradeAudits[0][2] as Record<string, unknown>).error).toBe("string");
  });

  it("a failing store read denies non-operators (env-only, no lockout, no 500)", async () => {
    const ctx = payCtx({
      env: {
        AGENT_DB: unmigratedAgentDb(),
        COMMERCIAL_STORE_OPERATORS: "alice",
      },
    });
    const res = await handleAgenticPaymentsRoutes(payReq("bob"), payUrl(), REFERRAL_RULES, "s", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    // The degrade still logged + audited for bob's request too.
    const events = structuredLogEvents(infoSpy);
    expect(
      events.filter((e) => e.operation === "agenticPayments.store_operator_read_failed"),
    ).toHaveLength(1);
    expect(
      (ctx.audit as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "payments.store_operator_read_failed",
      ),
    ).toHaveLength(1);
  });

  it("an unbound store stays silent (no failure, nothing to degrade from)", async () => {
    const ctx = payCtx({ env: { COMMERCIAL_STORE_OPERATORS: "alice" } });
    const res = await handleAgenticPaymentsRoutes(payReq("alice"), payUrl(), REFERRAL_RULES, "s", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const events = structuredLogEvents(infoSpy);
    expect(
      events.filter((e) => e.operation === "agenticPayments.store_operator_read_failed"),
    ).toHaveLength(0);
    expect(
      (ctx.audit as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "payments.store_operator_read_failed",
      ),
    ).toHaveLength(0);
  });

  it("a route that never consults the operator list stays silent even with a failing store", async () => {
    // Lazy reporting: the degrade is reported on first USE of the
    // operator check. The removed record-native route never consults
    // it, so its inertness pin (tests/native_ledger_routes.test.ts)
    // holds — no log, no audit, null result.
    const ctx = payCtx({
      env: {
        AGENT_DB: unmigratedAgentDb(),
        COMMERCIAL_STORE_OPERATORS: "alice",
      },
    });
    const body = {
      kind: "charge",
      runRequestId: "run-1",
      tenantId: "tenant-a",
      userId: "u1",
      family: "goal",
      priceUSD: 0.1,
      rail: "stripe",
      sessionId: "cs_test_1",
      paymentIntentId: "pi_1",
    };
    const res = await handleAgenticPaymentsRoutes(
      new Request("https://agent.internal/payments/agentic/ledger/record-native", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": "alice" },
        body: JSON.stringify(body),
      }),
      new URL("https://agent.internal/payments/agentic/ledger/record-native"),
      "/payments/agentic/ledger/record-native",
      "s",
      ctx,
    );
    expect(res).toBeNull();
    const events = structuredLogEvents(infoSpy);
    expect(
      events.filter((e) => e.operation === "agenticPayments.store_operator_read_failed"),
    ).toHaveLength(0);
    expect(
      (ctx.audit as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "payments.store_operator_read_failed",
      ),
    ).toHaveLength(0);
  });
});

const makeSql = (tables: Record<string, any[]>) =>
  ({
    exec: (query: string, ..._params: unknown[]) => {
      for (const [table, rows] of Object.entries(tables)) {
        if (query.includes(table)) return rows;
      }
      return [];
    },
  }) as any;

const auditCtx = (overrides: Partial<AuditRouteContext> = {}): AuditRouteContext =>
  ({
    ensureTables: () => makeSql({}),
    audit: vi.fn(),
    recordAudit: vi.fn(),
    ...overrides,
  }) as AuditRouteContext;

const auditReq = (path: string) => new Request(`https://agent.internal${path}`, { method: "GET" });

function auditRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    session_id: "s",
    type: "t",
    agent: "trading",
    payload: JSON.stringify({ k: i }),
    created_at: `2026-10-19T${String(i % 24).padStart(2, "0")}:00:00Z`,
  }));
}

describe("audit pagination default is externalized (#5611 G-14)", () => {
  it("the default value is 50", () => {
    expect(COMMERCIAL_DEFAULTS.auditDefaultLimit).toBe(50);
  });

  it("GET /audit with no limit returns the COMMERCIAL_DEFAULTS default", async () => {
    const ctx = auditCtx({ ensureTables: () => makeSql({ mas_events: auditRows(150) }) });
    const res = await handleAuditRoutes(auditReq("/api/audit"), new URL("https://x/api/audit"), "/api/audit", "s", ctx);
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.count).toBe(COMMERCIAL_DEFAULTS.auditDefaultLimit);
    expect(body.count).toBe(50);
  });

  it("an explicit limit is unchanged", async () => {
    const ctx = auditCtx({ ensureTables: () => makeSql({ mas_events: auditRows(150) }) });
    const res = await handleAuditRoutes(
      auditReq("/api/audit?limit=10"),
      new URL("https://x/api/audit?limit=10"),
      "/api/audit",
      "s",
      ctx,
    );
    expect(res).not.toBeNull();
    expect((await res!.json()).count).toBe(10);
  });

  it("the audit list branch reads the default from COMMERCIAL_DEFAULTS, not a literal", () => {
    const auditSrc = readFileSync("src/agents/routes/audit.ts", "utf8");
    expect(auditSrc).toContain("COMMERCIAL_DEFAULTS.auditDefaultLimit");
    const limitLine = auditSrc
      .split("\n")
      .find((line) => line.includes("limitParam") && line.includes("searchParams"));
    expect(limitLine).toBeDefined();
    expect(limitLine).not.toContain("|| 50");
    expect(limitLine).toContain("COMMERCIAL_DEFAULTS.auditDefaultLimit");
  });
});
