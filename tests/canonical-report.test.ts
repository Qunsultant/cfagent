/**
 * Issue #308: one canonical copy of each report, max. The generator stores
 * the canonical copy at generation time through the single seam
 * (storeReportAtGeneration, idempotent on generation id); every channel
 * (email, webhook, HITL dispatch) delivers THAT stored copy.
 *
 * Acceptance:
 *  1. generate once, deliver to 3 channels → exactly 1 stored row.
 *  2. HITL ON: generation stores 1 row, the pending row references it,
 *     approve delivers the stored bytes, still 1 row.
 *  3. byte-identity: delivered body == stored body.
 *  4. scheduled-run path still stores exactly once.
 *  5. legacy rows (pre-#308, full payload embedded) still approve.
 *
 * Harness follows tests/report_dispatch_hitl.test.ts (OrchestratorAgent +
 * MockSqlStorage via onRequest).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
import {
  storeReportAtGeneration,
  canonicalResearchEmailBody,
  canonicalResearchWebhookBody,
  parseResearchReportBody,
} from "../src/services/scheduledReports";
import type { Env } from "../src/types";

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

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    APP_ENV: "TEST",
    OUTBOUND_WEBHOOK_URL: "https://webhook.example.com/hook",
    OUTBOUND_WEBHOOK_SECRET: "test-webhook-secret",
    ...overrides,
  }) as Env;

const seedAgent = (env: Env) => {
  const sql = new MockSqlStorage();
  const ctx = {
    id: { toString: () => "system_report_308" },
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

const setHitl = (agent: OrchestratorAgent, enabled: boolean) =>
  post(agent, "/trading/settings/report-dispatch-hitl", { enabled });

const reportRows = (sql: MockSqlStorage) =>
  Array.from(sql.exec("SELECT * FROM mas_reports")) as any[];

const pendingRows = (sql: MockSqlStorage) =>
  Array.from(sql.exec("SELECT * FROM mas_report_confirmations")) as any[];

describe("Issue #308 — one canonical report copy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("seam idempotency: same generation id stores exactly one row", () => {
    const sql = new MockSqlStorage();
    const input = {
      runId: "gen-1",
      generationId: "gen-1",
      title: "T",
      source: "screener",
      summary: "S",
      body: { a: 1 },
      userLogin: "tenant@example.com",
    };
    const first = storeReportAtGeneration(sql, input);
    const second = storeReportAtGeneration(sql, input);
    expect(first).not.toBeNull();
    expect(first!.created).toBe(true);
    expect(second).not.toBeNull();
    expect(second!.created).toBe(false);
    expect(second!.reportId).toBe(first!.reportId);
    expect(reportRows(sql)).toHaveLength(1);
  });

  it("HITL ON: generation stores 1 row, pending references it, approve delivers stored bytes", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    // Spy the send leg: pins "what is delivered == what is stored".
    const sendSpy = vi.spyOn(agent as any, "sendReportEmail");
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any)
      .confirmationId;

    // One canonical row stored at generation.
    const rows = reportRows(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("research_report");
    expect(rows[0].generation_id).toBeTruthy();

    // The pending row references the stored copy (no report bytes embedded).
    const pending = pendingRows(sql);
    expect(pending).toHaveLength(1);
    expect(pending[0].report_id).toBe(rows[0].id);
    const meta = JSON.parse(pending[0].payload_json);
    expect(meta.attachmentBase64).toBeUndefined();
    expect(meta.recipient).toBe("analyst@example.com");

    // Byte-identity: stored body is the canonical JSON of the input.
    const expectedBody = canonicalResearchEmailBody({
      title: "Weekly scan",
      fileName: "report.xlsx",
      attachmentBase64: XLSX_B64,
    });
    expect(rows[0].body).toBe(expectedBody);

    // Approve delivers the STORED bytes (send leg receives stored fields).
    const res = await post(agent, "/trading/reports/confirm", {
      confirmationId: id,
      decision: "approved",
    });
    expect((await res.json()) as any).toMatchObject({
      success: true,
      status: "dispatched",
      confirmationId: id,
    });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const stored = parseResearchReportBody(rows[0].body)!;
    expect(sendSpy.mock.calls[0][1]).toBe(stored.title);
    expect(sendSpy.mock.calls[0][2]).toBe(stored.fileName);
    expect(sendSpy.mock.calls[0][3]).toBe(stored.attachmentBase64);
    expect(sendSpy.mock.calls[0][3]).toBe(XLSX_B64);

    // Still exactly one stored row after delivery.
    expect(reportRows(sql)).toHaveLength(1);
  });

  it("dedupe: generate once, deliver via multiple channels → exactly 1 stored row", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, true);
    // Same report posted twice → two pending holds, one canonical row.
    const id1 = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any)
      .confirmationId;
    const id2 = ((await (await post(agent, "/trading/reports/email", EMAIL_BODY)).json()) as any)
      .confirmationId;
    expect(id1).not.toBe(id2);
    expect(pendingRows(sql)).toHaveLength(2);
    expect(reportRows(sql)).toHaveLength(1);

    // Deliver both holds → both deliver, still one row.
    await post(agent, "/trading/reports/confirm", { confirmationId: id1, decision: "approved" });
    await post(agent, "/trading/reports/confirm", { confirmationId: id2, decision: "approved" });
    expect(emailSend).toHaveBeenCalledTimes(2);
    expect(reportRows(sql)).toHaveLength(1);

    // Same webhook report posted twice → one row.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    await post(agent, "/trading/reports/webhook", WEBHOOK_BODY);
    await post(agent, "/trading/reports/webhook", WEBHOOK_BODY);
    expect(reportRows(sql).filter((r) => r.source === "research_report")).toHaveLength(2); // email + webhook kinds
    vi.unstubAllGlobals();
  });

  it("webhook: approve delivers the stored canonical payload (data == stored body)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const { agent, sql } = seedAgent(makeEnv());
    await setHitl(agent, true);
    const id = ((await (await post(agent, "/trading/reports/webhook", WEBHOOK_BODY)).json()) as any)
      .confirmationId;

    const rows = reportRows(sql);
    expect(rows).toHaveLength(1);
    const expectedBody = canonicalResearchWebhookBody({
      title: "Weekly scan",
      query: "momentum",
      sheets: WEBHOOK_BODY.sheets,
    });
    expect(rows[0].body).toBe(expectedBody);

    const res = await post(agent, "/trading/reports/confirm", {
      confirmationId: id,
      decision: "approved",
    });
    expect((await res.json()) as any).toMatchObject({ success: true, status: "dispatched" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Byte-identity: the dispatched data envelope carries the stored body.
    const dispatched = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(dispatched.data).toEqual(JSON.parse(rows[0].body));
    expect(reportRows(sql)).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("HITL OFF: generation still stores first, then delivers the stored copy", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    await setHitl(agent, false);
    const sendSpy = vi.spyOn(agent as any, "sendReportEmail");
    const res = await post(agent, "/trading/reports/email", EMAIL_BODY);
    expect((await res.json()) as any).toEqual({ success: true });
    expect(emailSend).toHaveBeenCalledTimes(1);
    const rows = reportRows(sql);
    expect(rows).toHaveLength(1);
    expect(sendSpy.mock.calls[0][3]).toBe(
      parseResearchReportBody(rows[0].body)!.attachmentBase64
    );
    expect(pendingRows(sql)).toHaveLength(0);
  });

  it("legacy rows (pre-#308, full payload embedded) still approve via fallback", async () => {
    const emailSend = vi.fn(async () => true);
    const { agent, sql } = seedAgent(makeEnv({ EMAIL: { send: emailSend } }));
    // Insert a legacy-shaped row directly: no report_id, full payload.
    const legacyPayload = JSON.stringify({
      recipient: "legacy@example.com",
      title: "Old report",
      fileName: "old.xlsx",
      attachmentBase64: XLSX_B64,
    });
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?)",
      "rc_legacy01",
      "email",
      legacyPayload,
      "pending",
      new Date().toISOString()
    );
    const res = await post(agent, "/trading/reports/confirm", {
      confirmationId: "rc_legacy01",
      decision: "approved",
    });
    expect((await res.json()) as any).toMatchObject({ success: true, status: "dispatched" });
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it("pending list renders the metadata-only payload (no report bytes needed)", async () => {
    const { agent } = seedAgent(makeEnv());
    await setHitl(agent, true);
    await post(agent, "/trading/reports/email", EMAIL_BODY);
    await post(agent, "/trading/reports/webhook", WEBHOOK_BODY);
    const res = await get(agent, "/trading/reports/pending");
    const json = (await res.json()) as any;
    expect(json.pending).toHaveLength(2);
    const email = json.pending.find((p: any) => p.kind === "email");
    const webhook = json.pending.find((p: any) => p.kind === "webhook");
    expect(email.detail).toBe("analyst@example.com · report.xlsx");
    expect(webhook.detail).toBe("Weekly scan · 1 sheets");
  });

  it("scheduled seam via DatabaseORM stores exactly once per generation", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    const orm = (agent as any).getOrm();
    const input = {
      runId: "screener:2026-10-18T00:00:00.000Z",
      generationId: "screener:2026-10-18T00:00:00.000Z",
      title: "Market screen — TECH (scheduled)",
      source: "screener",
      summary: "S",
      body: { ok: true },
      createdAt: "2026-10-18T00:00:00.000Z",
      userLogin: "tenant@example.com",
    };
    const first = orm.storeCanonicalReport(input);
    const second = orm.storeCanonicalReport(input);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.created).toBe(false);
    expect(second!.reportId).toBe(first!.reportId);
    expect(
      reportRows(sql).filter((r) => r.generation_id === "screener:2026-10-18T00:00:00.000Z")
    ).toHaveLength(1);
  });
});
