/**
 * Issue #277: research-report dispatch (POST /trading/reports/email and
 * POST /trading/reports/webhook) stays AUTONOMOUS by default, and a
 * server-side setting ("Report dispatch HITL", default OFF) switches both
 * routes to hold dispatch for human confirmation via
 * POST /trading/reports/confirm — mirroring the /payments/confirm HITL
 * flow. The setting is server-owned (mas_settings), not localStorage, so
 * the gate cannot be bypassed from the browser; the Settings section
 * toggle only writes it through the settings API.
 *
 * Harnesses follow the repo patterns: agent-SDK module mocks and the
 * MockSqlStorage agent harness from tests/payment_webhook_default_deny.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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
vi.mock("agents", () => {
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
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
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

// Source pins read via cwd-relative paths (vitest runs at the repo root).
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    APP_ENV: "TEST",
    OUTBOUND_WEBHOOK_URL: "https://webhook.example.com/hook",
    OUTBOUND_WEBHOOK_SECRET: "wh-secret-277",
    ...overrides,
  }) as Env;

const seedAgent = (env: Env) => {
  const sql = new MockSqlStorage();
  const ctx = {
    id: { toString: () => "system_report_277" },
    storage: { sql },
    waitUntil: vi.fn(),
  };
  const agent = new OrchestratorAgent(ctx as any, env);
  return { agent, sql };
};

const post = (agent: OrchestratorAgent, path: string, body: unknown) =>
  agent.onRequest(
    new Request(`https://agent.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

const get = (agent: OrchestratorAgent, path: string) =>
  agent.onRequest(new Request(`https://agent.internal${path}`, { method: "GET" }));

// Minimal valid .xlsx payload: base64 whose decoded bytes start with "PK".
const XLSX_B64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]).toString("base64");
const EMAIL_BODY = {
  to: "analyst@example.com",
  fileName: "report.xlsx",
  attachmentBase64: XLSX_B64,
  title: "Weekly scan",
};
const WEBHOOK_BODY = {
  title: "Weekly scan",
  query: "momentum",
  sheets: [{ name: "Picks", rows: [{ symbol: "NVDA", score: 9 }] }],
};

const setHitl = (agent: OrchestratorAgent, enabled: boolean) =>
  post(agent, "/trading/settings/report-dispatch-hitl", { enabled });

const pendingRows = (sql: MockSqlStorage) =>
  Array.from(sql.exec("SELECT * FROM mas_report_confirmations")) as any[];

describe("Issue #277 — report-dispatch HITL setting (server-owned)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults ON (#1144, owner decision 2026-10-23): GET reports {enabled:true}", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await get(agent, "/trading/settings/report-dispatch-hitl");
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ enabled: true });
  });

  it("POST rejects a non-boolean value with 400", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, "/trading/settings/report-dispatch-hitl", { enabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("POST toggles the setting and GET reflects it (round-trip)", async () => {
    const { agent } = seedAgent(makeEnv());
    expect(((await (await setHitl(agent, true)).json()) as any).enabled).toBe(true);
    expect(((await (await get(agent, "/trading/settings/report-dispatch-hitl")).json()) as any).enabled).toBe(true);
    expect(((await (await setHitl(agent, false)).json()) as any).enabled).toBe(false);
    expect(((await (await get(agent, "/trading/settings/report-dispatch-hitl")).json()) as any).enabled).toBe(false);
  });

  it("HITL OFF: email dispatch sends immediately (opted out), no pending row", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, false);
    const res = await post(agent, "/trading/reports/email", EMAIL_BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBeUndefined();
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(pendingRows(sql)).toHaveLength(0);
  });

  it("HITL OFF: webhook dispatch sends immediately (opted out), no pending row", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const { agent, sql } = seedAgent(makeEnv());
    await setHitl(agent, false);
    const res = await post(agent, "/trading/reports/webhook", WEBHOOK_BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pendingRows(sql)).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("HITL ON: email dispatch is held — pending response, nothing sent", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, true);
    const res = await post(agent, "/trading/reports/email", EMAIL_BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBe("pending_confirmation");
    expect(typeof json.confirmationId).toBe("string");
    expect(json.confirmationId.startsWith("rc_")).toBe(true);
    expect(emailSend).not.toHaveBeenCalled();
    const rows = pendingRows(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("email");
    expect(rows[0].status).toBe("pending");
  });

  it("HITL ON: webhook dispatch is held — pending response, nothing sent", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const { agent, sql } = seedAgent(makeEnv());
    await setHitl(agent, true);
    const res = await post(agent, "/trading/reports/webhook", WEBHOOK_BODY);
    const json = (await res.json()) as any;
    expect(json.status).toBe("pending_confirmation");
    expect(typeof json.confirmationId).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingRows(sql)[0].kind).toBe("webhook");
    vi.unstubAllGlobals();
  });

  it("approve: pending email is dispatched exactly once, audit records the confirmation", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any).confirmationId;
    const res = await post(agent, "/trading/reports/confirm", { confirmationId: id, decision: "approved" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ success: true, status: "dispatched", confirmationId: id });
    expect(emailSend).toHaveBeenCalledTimes(1);
    const audits = Array.from(
      sql.exec("SELECT * FROM mas_events WHERE type = ?", "research_report.emailed")
    ) as any[];
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.parse(audits[0].payload).confirmationId).toBe(id);
  });

  it("approve: pending webhook is dispatched with the stored payload", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = seedAgent(makeEnv());
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/webhook", WEBHOOK_BODY)).json()) as any).confirmationId;
    const res = await post(agent, "/trading/reports/confirm", { confirmationId: id, decision: "approved" });
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ success: true, status: "dispatched", confirmationId: id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://webhook.example.com/hook");
    vi.unstubAllGlobals();
  });

  it("reject: pending email is NOT sent and the row is marked rejected", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any).confirmationId;
    const res = await post(agent, "/trading/reports/confirm", { confirmationId: id, decision: "rejected", note: "nope" });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ success: true, status: "rejected", confirmationId: id });
    expect(emailSend).not.toHaveBeenCalled();
    expect(pendingRows(sql)[0].status).toBe("rejected");
  });

  it("confirm: unknown id → 404, double confirm → 409", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, true);
    const missing = await post(agent, "/trading/reports/confirm", { confirmationId: "rc_missing", decision: "approved" });
    expect(missing.status).toBe(404);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any).confirmationId;
    await post(agent, "/trading/reports/confirm", { confirmationId: id, decision: "rejected" });
    const again = await post(agent, "/trading/reports/confirm", { confirmationId: id, decision: "approved" });
    expect(again.status).toBe(409);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("confirm: expired pending confirmation → 410 and nothing is sent", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any).confirmationId;
    sql.exec("UPDATE mas_report_confirmations SET created_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", id);
    const res = await post(agent, "/trading/reports/confirm", { confirmationId: id, decision: "approved" });
    expect(res.status).toBe(410);
    expect(emailSend).not.toHaveBeenCalled();
    expect(pendingRows(sql)[0].status).toBe("expired");
  });

  it("validation still runs first when HITL is on: bad email → 400, no pending row", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    await setHitl(agent, true);
    const res = await post(agent, "/trading/reports/email", { ...EMAIL_BODY, to: "not-an-email" });
    expect(res.status).toBe(400);
    expect(pendingRows(sql)).toHaveLength(0);
  });
});

describe("Issue #277 — source pins (no fabricated surfaces)", () => {
  const agentSrc = () => src("agents/orchestrator.ts");

  it("dispatch routes read the server setting through a single owner", () => {
    expect(agentSrc()).toContain("getReportDispatchHitl");
    // Issue #359-01: the routes live in the extracted reports module, wired
    // into routeRequest via handleReportsRoutes at the original position.
    const routesSrc = () => src("agents/routes/reports.ts");
    expect(routesSrc()).toContain("/trading/settings/report-dispatch-hitl");
    expect(routesSrc()).toContain("/trading/reports/confirm");
    expect(src("agents/orchestrator/routeRequest.ts")).toContain("handleReportsRoutes(request, url, path, sessionId");
    // #2359 (#1976 step 4d) pin update: the confirmations DDL
    // moved behind the orchestrator-table ports — the class
    // now wires the table through the composition root
    // (ensureSchema) instead of naming the CREATE TABLE. The
    // pin's intent (the class owns the confirmations table's
    // wiring alongside mas_settings) is unchanged.
    expect(src("agents/orchestrator/tableSchema.ts")).toContain("createOrchestratorTablePorts(");
    expect(src("agents/orchestrator/tableSchema.ts")).toContain(".confirmations.ensureSchema()");
    expect(src("agents/orchestrator/tableSchema.ts")).toContain("mas_settings");
  });

  it("the Settings menu toggle writes through the real settings API", () => {
    const menu = src("client/BrokerDynamicMenu.tsx");
    expect(menu).toContain("onToggleReportDispatchHitl");
    const chat = src("client/Chat.tsx");
    expect(chat).toContain("/api/trading/settings/report-dispatch-hitl");
    // The toggle is never backed by localStorage-only state.
    expect(chat).not.toContain("localStorage.getItem(\"cfagent_report_dispatch_hitl");
  });
});

describe("Issue #1324 — pending-review queue list (Reports)", () => {
  const seedScreenerRow = (sql: MockSqlStorage, overrides: Record<string, unknown> = {}) => {
    const id = (overrides.id as string) ?? "rc_screener1";
    const createdAt =
      (overrides.createdAt as string) ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const delivery = {
      outcome: {
        kind: "stock",
        universe: "SP100",
        matchedCount: 3,
        totalScanned: 100,
        reportUrl: "https://agent.openaimp.com/api/screener/report.pdf?key=abc",
      },
      userLogin: "user1",
      channel: "slack",
      artifacts: [
        { key: "pdf1", fileName: "screener-report.pdf" },
        { key: "xlsx1", fileName: "screener-report.xlsx" },
      ],
      displayName: "SP100 screen",
    };
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      "screener",
      JSON.stringify({ delivery }),
      "pending",
      createdAt,
      null
    );
    return id;
  };

  const listPending = async (agent: OrchestratorAgent) => {
    const res = await get(agent, "/trading/reports/pending");
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  };

  it("pending items carry expiresAt = createdAt + 24h TTL", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any)
      .confirmationId as string;
    const json = await listPending(agent);
    const item = json.pending.find((p: any) => p.confirmationId === id);
    expect(item).toBeDefined();
    const row = pendingRows(sql).find((r: any) => r.id === id);
    const expected = new Date(new Date(String(row.created_at)).getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(item.expiresAt).toBe(expected);
  });

  it("screener items carry artifacts, channel, displayName, and the report link", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    await get(agent, "/trading/reports/pending");
    const id = seedScreenerRow(sql);
    const json = await listPending(agent);
    const item = json.pending.find((p: any) => p.confirmationId === id);
    expect(item).toBeDefined();
    expect(item.kind).toBe("screener");
    expect(item.artifacts).toEqual(["screener-report.pdf", "screener-report.xlsx"]);
    expect(item.channel).toBe("slack");
    expect(item.displayName).toBe("SP100 screen");
    expect(item.reportUrl).toBe("https://agent.openaimp.com/api/screener/report.pdf?key=abc");
  });

  it("email items carry their fileName as the artifact", async () => {
    const { agent } = seedAgent(makeEnv());
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any)
      .confirmationId as string;
    const json = await listPending(agent);
    const item = json.pending.find((p: any) => p.confirmationId === id);
    expect(item.artifacts).toEqual(["report.xlsx"]);
  });

  it("expired pending rows leave the queue, marked expired with an audit row", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    await get(agent, "/trading/reports/pending");
    const id = seedScreenerRow(sql, {
      id: "rc_old",
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    const json = await listPending(agent);
    expect(json.pending.find((p: any) => p.confirmationId === id)).toBeUndefined();
    const row = pendingRows(sql).find((r: any) => r.id === id);
    expect(row.status).toBe("expired");
    const audits = Array.from(
      sql.exec("SELECT * FROM mas_events WHERE type = ?", "research_report.confirmation_expired")
    ) as any[];
    expect(audits.some((a: any) => JSON.parse(a.payload).confirmationId === id)).toBe(true);
  });

  it("existing summary fields are unchanged (no regression)", async () => {
    const { agent } = seedAgent(makeEnv());
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any)
      .confirmationId as string;
    const json = await listPending(agent);
    const item = json.pending.find((p: any) => p.confirmationId === id);
    expect(item).toMatchObject({
      confirmationId: id,
      kind: "email",
      detail: "analyst@example.com · report.xlsx",
    });
    expect(typeof item.createdAt).toBe("string");
  });
});
