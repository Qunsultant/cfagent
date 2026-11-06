/**
 * Issue #700 (point 2): the paid scanner's audit event is rerouted to the
 * ORCHESTRATOR's mas_events store.
 *
 * Before this change, OptionsScannerMCP.persistAudit wrote to the scanner
 * DO's own storage via `new DatabaseORM(this.ctx.storage)` — the ORM
 * constructor expects ctx.storage.sql, and the scanner DO never ran
 * initializeSchema, so the write threw on every paid scan and a bare catch
 * swallowed it: no CF_WALLET_SCANNER_PAID record has ever existed anywhere,
 * and nothing could have read one (the event name appeared nowhere else).
 *
 * The reroute sends the event through the channel the scanner already uses
 * for scan jobs — forwardToOrchestrator over the SEARCH_AGENT binding — to
 * POST /api/audit/event, which funnels into recordAudit(), the single owner
 * of mas_events inserts (issue #270). That store is the one GET /api/audit
 * reads (Chat audit log, AutopilotControlCenter, MarketDataResearchHub,
 * ScheduledOptionsManager).
 *
 * Harness: full-fake module mocks for the agent graph the node loader
 * cannot resolve (same pattern as tests/scanner_session_affinity.test.ts
 * and tests/audit-event-endpoint.test.ts). The scanner is exercised through
 * its REAL paid-tool handler (captured from init()), and the orchestrator
 * side is a REAL OrchestratorAgent prototype instance backed by
 * MockSqlStorage, so assertions read the actual mas_events rows.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return {
    McpAgent: class MockMcpAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents/x402", () => {
  return { withX402: (server: any) => server };
});

import { OptionsScannerMCP } from "../src/mcps/scanner/cloudflareWalletsScanner";
// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { AGENT_DIDS } from "../src/agents/did";
import { MockSqlStorage } from "./mock-sql";

const ORCH_SESSION = "scanner-audit-orchestrator-instance";
const JOB_ID = "3f6b0f3a-5d2c-4c1e-9a8b-7d6e5f4a3b2c";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SUBSTRING_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** #3515 S3: parse spied console.info lines into structured-log events. */
function structuredLogEvents(infoSpy: { mock: { calls: unknown[][] } }): Array<{
  operation: string;
  level: string;
  fields: Record<string, unknown>;
}> {
  const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
  for (const call of infoSpy.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as {
        operation?: unknown;
        level?: unknown;
        fields?: unknown;
      };
      if (parsed && typeof parsed.operation === "string") {
        events.push({
          operation: parsed.operation,
          level: typeof parsed.level === "string" ? parsed.level : "",
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

function makeOrchestrator() {
  const sql = new MockSqlStorage();
  const agent: any = Object.create(OrchestratorAgent.prototype);
  agent.ctx = { storage: { sql }, id: { toString: () => ORCH_SESSION } };
  agent.env = { APP_ENV: "TEST" };
  return { agent, sql };
}

interface AuditRow {
  id: string;
  session_id: string;
  type: string;
  agent: string;
  payload: string;
  created_at: string;
}

function auditRows(sql: MockSqlStorage): AuditRow[] {
  return Array.from(
    sql.exec("SELECT id, session_id, type, agent, payload, created_at FROM mas_events")
  ) as AuditRow[];
}

function paidRows(sql: MockSqlStorage): AuditRow[] {
  return auditRows(sql).filter((r) => r.type === "CF_WALLET_SCANNER_PAID");
}

/**
 * Builds a scanner instance whose SEARCH_AGENT binding answers the
 * scan-job forward with a canned queued-job response and routes every
 * other forward (the audit write) into the real orchestrator instance —
 * unless failAudit is set, in which case the audit forward fails.
 */
function makeScanner(
  orchestrator: { agent: any },
  opts: { failAudit?: "throw" | "http500" } = {}
) {
  const pending: Array<Promise<unknown>> = [];
  const scanner: any = Object.create(OptionsScannerMCP.prototype);
  scanner.ctx = {
    id: { toString: () => "scanner-instance-1" },
    storage: { sql: new MockSqlStorage() },
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  };
  scanner.env = {
    CF_WALLET_NETWORK: "base-sepolia",
    SEARCH_AGENT: {
      idFromName: (name: string) => name,
      get: (_id: string) => ({
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (path === "/api/trading/options/screen") {
            return Response.json({
              jobId: JOB_ID,
              status: "queued",
              statusUrl: `/api/jobs/${JOB_ID}`,
            });
          }
          if (opts.failAudit === "throw") throw new Error("orchestrator unreachable");
          if (opts.failAudit === "http500") {
            return Response.json({ error: "audit store unavailable" }, { status: 500 });
          }
          return orchestrator.agent.onRequest(req);
        },
      }),
    },
  };
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  scanner.server = {
    paidTool: (name: string, ...rest: any[]) => {
      handlers.set(name, rest[rest.length - 1]);
    },
    tool: (name: string, ...rest: any[]) => {
      handlers.set(name, rest[rest.length - 1]);
    },
  };
  return { scanner, handlers, pending };
}

async function runPaidScan(
  opts: { failAudit?: "throw" | "http500"; args?: Record<string, unknown> } = {}
) {
  const orchestrator = makeOrchestrator();
  const { scanner, handlers, pending } = makeScanner(orchestrator, opts);
  await scanner.init();
  const handler = handlers.get("screen_options");
  expect(handler).toBeDefined();
  const result = await handler!(opts.args ?? { underlying: "aapl" });
  // persistAudit never rejects (failures are logged), so this cannot throw.
  await Promise.all(pending);
  return { orchestrator, result };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OptionsScannerMCP persistAudit reroute (#700 point 2)", () => {
  it("a paid scan lands a CF_WALLET_SCANNER_PAID event in the ORCHESTRATOR's mas_events", async () => {
    const { orchestrator, result } = await runPaidScan();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.jobId).toBe(JOB_ID);

    const rows = paidRows(orchestrator.sql);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.agent).toBe("payments");
    // Tenant-scoped to the orchestrator instance that owns the scan jobs.
    expect(row.session_id).toBe(ORCH_SESSION);
    // recordAudit assigns a full-UUID row id and a timestamp.
    expect(row.id).toMatch(UUID_RE);
    expect(typeof row.created_at).toBe("string");
    expect(row.created_at.length).toBeGreaterThan(0);

    const payload = JSON.parse(row.payload);
    expect(payload.underlying).toBe("AAPL");
    expect(payload.jobId).toBe(JOB_ID);
    expect(payload.pricePaid).toBe(0.05);
    expect(payload.protocol).toBe("x402");
    expect(payload.proposerDid).toBe(AGENT_DIDS.PAYMENTS);
    expect(payload.source).toBe("cf_wallet_scanner");
    // Scanner-generated correlation id: a FULL UUID (the dead local write
    // used only 8 hex chars of one).
    expect(payload.eventId).toMatch(UUID_RE);
    // The scan is only QUEUED at this point — there is no match count, and
    // none may be fabricated.
    expect(payload).not.toHaveProperty("matchedCount");
  });

  it("the stored event is returned by the orchestrator's GET /api/audit (the read surface)", async () => {
    const { orchestrator } = await runPaidScan();
    const res = await orchestrator.agent.onRequest(
      new Request("https://agent.test/api/audit?limit=10")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const found = body.events.find((e: any) => e.type === "CF_WALLET_SCANNER_PAID");
    expect(found).toBeDefined();
    expect(found.payload.jobId).toBe(JOB_ID);
    expect(found.payload.underlying).toBe("AAPL");
  });

  it("a broad scan records underlying as all_exchange_listings", async () => {
    const { orchestrator } = await runPaidScan({ args: {} });
    const rows = paidRows(orchestrator.sql);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).underlying).toBe("all_exchange_listings");
  });

  it("a supplied matchedCount is carried through (the field is only omitted when unknown)", async () => {
    const orchestrator = makeOrchestrator();
    const { scanner } = makeScanner(orchestrator);
    await (scanner as any).persistAudit("MSFT", 7, JOB_ID);
    const rows = paidRows(orchestrator.sql);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.underlying).toBe("MSFT");
    expect(payload.matchedCount).toBe(7);
  });

  it("a failing audit write is logged with the event id and never fails the paid scan (transport throw)", async () => {
    // #3515 S3: the audit failure now travels as a structured
    // options_scanner.audit_persist_failed event on the console-info JSON
    // fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { orchestrator, result } = await runPaidScan({ failAudit: "throw" });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.jobId).toBe(JOB_ID);
    expect(auditRows(orchestrator.sql)).toHaveLength(0);
    const events = structuredLogEvents(infoSpy);
    expect(events.some((e) => e.operation === "options_scanner.audit_persist_failed")).toBe(true);
    const logged = events.map((e) => String(e.fields?.message ?? "")).join("\n");
    expect(logged).toContain("CF_WALLET_SCANNER_PAID");
    expect(logged).toMatch(UUID_SUBSTRING_RE);
  });

  it("a failing audit write is logged with the event id and never fails the paid scan (orchestrator HTTP 500)", async () => {
    // #3515 S3: see the transport-throw test above — same structured event.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { orchestrator, result } = await runPaidScan({ failAudit: "http500" });
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.jobId).toBe(JOB_ID);
    expect(auditRows(orchestrator.sql)).toHaveLength(0);
    const events = structuredLogEvents(infoSpy);
    expect(events.some((e) => e.operation === "options_scanner.audit_persist_failed")).toBe(true);
    const logged = events.map((e) => String(e.fields?.message ?? "")).join("\n");
    expect(logged).toContain("CF_WALLET_SCANNER_PAID");
    expect(logged).toMatch(UUID_SUBSTRING_RE);
  });

  it("the dead local write is gone: the scanner no longer constructs DatabaseORM", () => {
    const src = readFileSync(
      new URL("../src/mcps/scanner/cloudflareWalletsScanner.ts", import.meta.url),
      "utf8"
    );
    expect(src).not.toContain("DatabaseORM");
    expect(src).toContain("/api/audit/event");
  });
});
