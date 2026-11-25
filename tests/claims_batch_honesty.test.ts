/** @vitest-environment jsdom */
/**
 * Issue #123 (audit #115 findings F15/F16/F19/F20): the success-claims
 * batch. Four surfaces claimed outcomes the system had not established:
 *
 *  - F15 ScheduledOptionsManager: hero copy claimed 24/7 scanning with
 *    alerts pushed to Slack/Email/Webhook regardless of configuration,
 *    a hard-coded "Broadcast: ✓ Active" pill, and an unconditional
 *    Broadcast badge on every options card.
 *  - F16 Chat execution card: rendered FILLED whenever `success` was
 *    not exactly false (absent = filled), defaulted the status pill to
 *    "EXECUTED", and fabricated a broker reference — `Ref: simulated`.
 *  - F19 dispatchReminder: audited "reminder.dispatched" and returned
 *    success unconditionally, swallowing the chat-message insert error
 *    that IS the delivery.
 *  - F20 outbound webhooks: signed with the literal published string
 *    "default_trading_secret" when no secret was configured, under UI
 *    copy claiming "Signed Webhooks / HMAC authenticated".
 *
 * Harnesses follow the repo patterns: jsdom component rendering from
 * tests/scheduled_options_manager.test.ts (real apiFetch against a
 * stubbed global fetch), the MockSqlStorage ORM from
 * tests/scheduled_tasks.test.ts, and source pins from the other
 * #115-family honesty suites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

// #6102 (jsdom): this file MUST NOT import tests/mock-d1.ts — it
// imports node:sqlite, which cannot bundle in jsdom and fails the
// whole file at collection. Instead the audit-event port module is
// mocked with an in-memory stub port: create appends the record
// (payload stored as JSON text, exactly as the D1 store returns
// it); findMany filters by where.type. The service resolves the
// port via auditEventPort(env), so the F19 tests observe the stub.
const { stubAuditRows } = vi.hoisted(() => ({
  stubAuditRows: [] as Array<{
    id: string;
    sessionId?: string;
    type: string;
    agent?: string;
    payload: unknown;
    createdAt: string;
  }>,
}));
vi.mock("../src/data/createAuditEventPorts", () => ({
  auditEventPort: async () => ({
    create: async (record: any) => {
      const stored = {
        ...record,
        payload:
          typeof record.payload === "string"
            ? record.payload
            : JSON.stringify(record.payload ?? {}),
      };
      stubAuditRows.push(stored);
      return stored;
    },
    findMany: async (options: any = {}) => {
      const where = options.where ?? {};
      return stubAuditRows.filter(
        (r) =>
          (where.type === undefined || r.type === where.type) &&
          (where.sessionId === undefined || r.sessionId === where.sessionId) &&
          (where.agent === undefined || r.agent === where.agent) &&
          (where.id === undefined || r.id === where.id),
      );
    },
    findById: async (id: string) => stubAuditRows.find((r) => r.id === id) ?? null,
    idsCreatedBefore: async () => [],
    delete: async () => false,
    readChainWindow: async () => [],
  }),
  createAuditEventAdapter: () => null,
  createEnsuredAuditEventAdapter: async () => null,
  ensureAuditEventSchema: async () => [],
}));
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { ETradeWebhookService } from "../src/services/tradingWebhooks";
import { verifyHmacSha256Signature } from "../src/security/webhookSecurity";
import { DispatchTradingWebhookCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";
import { executionCardPresentation } from "../src/client/executionCard";
import { ScheduledOptionsManager } from "../src/client/ScheduledOptionsManager";
import type { Env } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Source pins read via cwd-relative paths (vitest runs at the repo
// root) — the pattern used by tests/mcp_sandbox_backtest_honesty.test.ts.
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

// ===========================================================================
// F20 — outbound webhooks are never signed with a default secret
// ===========================================================================

describe("F20 — dispatchOutboundWebhook signing honesty", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends nothing and fails honestly when no signing secret is configured anywhere", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const env = { OUTBOUND_WEBHOOK_URL: "https://subscriber.example/hook" } as Env;
    const svc = new ETradeWebhookService(undefined, env, "sess_f20");

    const res = await svc.dispatchOutboundWebhook("order.executed", { symbol: "NVDA" });

    expect(res.success).toBe(false);
    expect(res.error).toContain("OUTBOUND_WEBHOOK_SECRET");
    expect(res.error).toContain("not sent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with an env secret configured, dispatches a signature that verifies under THAT secret — and not under the old published default", async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined;
    const fetchSpy = vi.fn(async (_url: any, init: any) => {
      captured = { headers: init.headers, body: String(init.body) };
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = {
      OUTBOUND_WEBHOOK_URL: "https://subscriber.example/hook",
      OUTBOUND_WEBHOOK_SECRET: "real-test-secret-123",
    } as Env;
    const svc = new ETradeWebhookService(undefined, env, "sess_f20");

    const res = await svc.dispatchOutboundWebhook("order.executed", { symbol: "NVDA" });

    expect(res.success).toBe(true);
    const sig = captured!.headers["X-Signature-256"];
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyHmacSha256Signature(captured!.body, sig, "real-test-secret-123")).toBe(true);
    expect(await verifyHmacSha256Signature(captured!.body, sig, "default_trading_secret")).toBe(false);
  });

  it("a per-call secret satisfies the requirement even when the env has none", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const env = { OUTBOUND_WEBHOOK_URL: "https://subscriber.example/hook" } as Env;
    const svc = new ETradeWebhookService(undefined, env, "sess_f20");

    const res = await svc.dispatchOutboundWebhook("alert.triggered", {}, undefined, "per-call-secret");
    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("the MCP tool description states the secret requirement up front", () => {
    const cmd = new DispatchTradingWebhookCommand();
    expect(cmd.description).toContain("OUTBOUND_WEBHOOK_SECRET");
    expect(cmd.description).toContain("NOT sent");
  });

  it("source pin: the published default secret exists nowhere in src/", () => {
    expect(src("services/tradingWebhooks.ts")).not.toContain("default_trading_secret");
  });
});

// ===========================================================================
// F19 — dispatchReminder reports what actually happened per channel
// ===========================================================================

describe("F19 — dispatchReminder failure propagation", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const sessionId = "reminder_test_trader";
  // #6102: the service's audit() resolves the port via
  // auditEventPort(env) — the module mock above serves an
  // in-memory stub, so no AGENT_DB binding is needed here.
  let env: Env;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    stubAuditRows.length = 0;
    env = { APP_ENV: "TEST" } as unknown as Env;
  });

  // The service's audit() helper is sync fire-and-forget, so poll
  // briefly until the row lands in the stub instead of asserting a race.
  async function pollAuditEvents(type: string) {
    let rows = stubAuditRows.filter((r) => r.type === type);
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = stubAuditRows.filter((r) => r.type === type);
    }
    return rows;
  }

  function stubAuditEvents(type: string) {
    return stubAuditRows.filter((r) => r.type === type);
  }

  it("happy path: success with per-channel truth and a dispatched audit", async () => {
    const service = new ScheduledTasksService(env, orm, sessionId);
    const res = await service.dispatchReminder("rem_ok", "Stretch and hydrate");

    expect(res.success).toBe(true);
    expect(res.data?.channels).toEqual({ audit: true, chatMessage: true });
    expect((await pollAuditEvents("reminder.dispatched")).length).toBe(1);
    expect(stubAuditEvents("reminder.dispatch_failed").length).toBe(0);
    expect(
      orm.messages.findMany({ where: { sessionId } }).some((m) => m.content.includes("Stretch and hydrate"))
    ).toBe(true);
  });

  it("a failing chat-message insert is a FAILED dispatch: audited as failed, never as dispatched", async () => {
    (orm.messages as any).create = () => {
      throw new Error("sqlite locked");
    };
    const service = new ScheduledTasksService(env, orm, sessionId);
    const res = await service.dispatchReminder("rem_fail", "Review the watchlist");

    expect(res.success).toBe(false);
    expect(res.error).toContain("could not be delivered");
    expect(res.data?.channels.chatMessage).toBe(false);
    expect(res.data?.messageError).toContain("sqlite locked");
    expect(stubAuditEvents("reminder.dispatched").length).toBe(0);
    const failed = await pollAuditEvents("reminder.dispatch_failed");
    expect(failed.length).toBe(1);
    // #2178 S1: stored payload is JSON text — parse the stored form.
    expect((JSON.parse(failed[0].payload as unknown as string) as any)?.error).toContain("sqlite locked");
  });

  it("with no message store attached, the dispatch fails honestly instead of claiming success", async () => {
    const service = new ScheduledTasksService(env, {} as any, sessionId);
    const res = await service.dispatchReminder("rem_nostore", "Check earnings");

    expect(res.success).toBe(false);
    expect(res.data?.channels).toEqual({ audit: false, chatMessage: false });
    expect(res.data?.messageError).toContain("No message store");
  });
});

// ===========================================================================
// F16 — Chat execution card claims FILLED only on an explicit success signal
// ===========================================================================

describe("F16 — executionCardPresentation", () => {
  it("explicit success + executed status + broker ref renders FILLED with the real ref", () => {
    const p = executionCardPresentation({
      success: true,
      status: "executed",
      orderId: "ord_1",
      brokerOrderRef: "et_order_99",
    });
    expect(p.verdict).toBe("FILLED");
    expect(p.pillLabel).toBe("EXECUTED");
    expect(p.pillClass).toBe("success");
    expect(p.detail).toBe("Order ord_1 executed on E*TRADE broker. Ref: et_order_99");
  });

  it("an explicit executed status alone is enough (NLQ approve rows)", () => {
    const p = executionCardPresentation({ status: "EXECUTED", executionId: "et_1", orderId: "ord_2" });
    expect(p.verdict).toBe("FILLED");
    expect(p.pillClass).toBe("success");
  });

  it("ambiguous result (executionId but no success, no status) is NOT filled — the old card's fabrication case", () => {
    const p = executionCardPresentation({ executionId: "et_x", orderId: "ord_3", symbol: "NVDA" });
    expect(p.verdict).toBe("STATUS UNAVAILABLE");
    expect(p.pillLabel).toBe("STATUS UNAVAILABLE");
    expect(p.pillClass).toBe("info");
    expect(p.detail).toBe("Execution status unavailable for order ord_3.");
    expect(p.detail).not.toContain("simulated");
  });

  it("explicit failure renders the result's own status, never a relabelled CANCELLED", () => {
    const p = executionCardPresentation({ success: false, status: "failed", orderId: "ord_4" });
    expect(p.verdict).toBe("FAILED");
    expect(p.pillClass).toBe("priority-urgent");
    expect(p.detail).toBe("Order ord_4 was not executed.");
  });

  it("a reported message always wins over the fallback text", () => {
    const p = executionCardPresentation({
      success: false,
      status: "failed",
      message: "E*TRADE Broker Error: market closed",
      orderId: "ord_5",
    });
    expect(p.detail).toBe("E*TRADE Broker Error: market closed");
  });

  it("filled without a broker ref shows no Ref segment at all — never 'simulated'", () => {
    const p = executionCardPresentation({ success: true, status: "executed", orderId: "ord_6" });
    expect(p.detail).toBe("Order ord_6 executed on E*TRADE broker.");
    expect(p.detail).not.toContain("Ref:");
    expect(p.detail).not.toContain("simulated");
  });

  it("source pins: the card derives from the helper and the fabricated fallbacks are gone", () => {
    const chat = src("client/chat/ToolResultView.tsx");
    expect(chat).toContain("executionCardPresentation(data)");
    expect(chat).not.toContain('data.success !== false ? "FILLED" : "CANCELLED"');
    expect(chat).not.toContain('data.brokerOrderRef || "simulated"');
  });
});

// ===========================================================================
// F15 — ScheduledOptionsManager copy and badges reflect configuration
// ===========================================================================

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const analysisNoChannels = {
  id: "user-analysis-plain",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: { symbols: ["NVDA"], thesis: "bullish", riskProfile: "balanced" },
  time: NEXT_RUN_S,
};

const analysisSlack = {
  id: "user-analysis-slack",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: {
    symbols: ["AAPL"],
    thesis: "bullish",
    riskProfile: "balanced",
    pushToSlack: true,
    slackChannel: "#options-alerts",
  },
  time: NEXT_RUN_S,
};

function installManagerFetch(schedules: any[]) {
  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    if (url === "/api/schedules" && method === "GET") {
      return Response.json({ count: schedules.length, schedules });
    }
    if (url.startsWith("/api/audit")) {
      return Response.json({ events: [] });
    }
    if (url === "/api/schedules/trigger-options-analysis" && method === "POST") {
      return Response.json({
        success: true,
        taskType: "options_analysis",
        data: {
          totalScanned: 2,
          withTrades: 1,
          symbols: ["NVDA"],
          summary: "stub analysis complete",
          notifications: { slack: true, webhook: false },
        },
      });
    }
    return Response.json({ error: `unstubbed ${method} ${url}` }, { status: 500 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (document.body.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${document.body.textContent?.slice(0, 600)}`);
}

async function renderManager() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ScheduledOptionsManager, { activeEnv: "TEST", userLogin: "trader1" })
    );
  });
  await flush(60);
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

/** #2329: one table row per schedule. */
function rowFor(id: string): HTMLElement {
  const row = [...container.querySelectorAll("tr.schedule-item-card")].find((r) =>
    r.textContent?.includes(id)
  );
  if (!row) throw new Error(`row ${id} not found`);
  return row as HTMLElement;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(40);
}

describe("F15 — ScheduledOptionsManager claims", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("hero copy describes configured-channel delivery; no 24/7 marketing claims", async () => {
    installManagerFetch([analysisNoChannels]);
    await renderManager();
    await waitForText("Autonomous Options Screening");

    expect(container.textContent).toContain("sent only to the channels configured on that job");
    expect(container.textContent).not.toContain("24/7");
    expect(container.textContent).not.toContain("continuously scanning");
    expect(container.textContent).not.toContain("Broadcast: ✓ Active");
  });

  it("the Details dialog states only the channels the payload configures; no unconditional Broadcast badge", async () => {
    installManagerFetch([analysisNoChannels, analysisSlack]);
    await renderManager();
    await waitForText("user-analysis-slack");

    // The configured schedule states its stored channel; nothing is invented.
    await click(buttonByText(rowFor("user-analysis-slack"), "Details"));
    await waitForText("Delivery");
    const slackDialog = document.querySelector(".sched-detail-modal") as HTMLElement;
    expect(slackDialog.textContent).toContain("#options-alerts");
    expect(slackDialog.textContent).not.toContain("Broadcast");
    await click(buttonByText(slackDialog, "Close"));

    // The unconfigured schedule states the absence, channel by channel.
    await click(buttonByText(rowFor("user-analysis-plain"), "Details"));
    await waitForText("Not configured");
    const plainDialog = document.querySelector(".sched-detail-modal") as HTMLElement;
    expect(plainDialog.textContent).toContain("Not configured");
    expect(plainDialog.textContent).not.toContain("Broadcast");
    expect(container.textContent).not.toContain("Broadcast");
  });

  it("the live-result banner reports per-channel results only — no hard-coded Broadcast pill", async () => {
    installManagerFetch([analysisNoChannels]);
    await renderManager();
    await waitForText("Autonomous Options Screening");

    await click(buttonByText(container, "Run Now"));
    await waitForText("Live Screening Execution Completed");

    // #2329: the per-channel result pills are Badge primitives now; the
    // claim (per-channel truth, no Broadcast) is unchanged.
    const pillTexts = [...container.querySelectorAll(".dispatch-status-pills .ui-badge")].map(
      (p) => p.textContent
    );
    expect(pillTexts.some((t) => t?.includes("Slack: ✓ Sent"))).toBe(true);
    expect(pillTexts.some((t) => t?.includes("Webhook: ✕ Error"))).toBe(true);
    expect(pillTexts.some((t) => t?.includes("Broadcast"))).toBe(false);
  });

  it("create form: webhook copy states the secret requirement; broadcast is a note, not a fake channel checkbox", async () => {
    installManagerFetch([analysisNoChannels]);
    await renderManager();
    await waitForText("Autonomous Options Screening");

    await click(buttonByText(container, "New Schedule"));
    await waitForText("Outbound Signed Webhook");

    expect(document.body.textContent).toContain("OUTBOUND_WEBHOOK_SECRET");
    expect(document.body.textContent).toContain("the webhook is not sent");
    expect(document.body.textContent).toContain("Not a channel you configure");
    const broadcastCard = [...document.querySelectorAll(".channel-check-card")].find((c) =>
      c.textContent?.includes("WebSocket UI Broadcast")
    );
    expect(broadcastCard).toBeTruthy();
    expect(broadcastCard!.querySelector("input")).toBeNull();
  });

  it("source pins: the unconditional claims are gone from the manager", () => {
    const manager = src("client/ScheduledOptionsManager.tsx");
    expect(manager).not.toContain("Broadcast: ✓ Active");
    expect(manager).not.toContain("runs 24/7");
    expect(manager).not.toContain("pushing alerts to Slack, Email, Webhook");
  });
});
