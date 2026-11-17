import { describe, expect, it } from "vitest";
import { formatOrderNotificationPayload } from "../src/services/orderExecutionNotifier";

describe("Issue #5155 (Sub-issue 1 of #5154) — Order Notification End-to-End Traceability", () => {
  it("renders userLogin, triggerSource, schedule/task, runId, traceId, and accountId in Slack and email payloads", () => {
    const payload = formatOrderNotificationPayload({
      orderId: "3cb39fdd-7790-4903-9731-df292c80b0da",
      broker: "alpaca",
      mode: "paper",
      accountId: "PA3XYZ123",
      symbol: "MSFT",
      action: "SELL",
      quantity: 25,
      orderType: "LIMIT",
      price: 517.99,
      status: "executed",
      origin: "stock_copilot_exit",
      userLogin: "trader@example.com",
      triggerSource: "scheduled_task",
      taskId: "stock-copilot-paper-cycle",
      runId: "occ-2026-11-17T13:32:00Z",
      traceId: "trace-5155-1",
      session: "pre_market",
      reason: "strategy_exit",
      timestamp: "2026-11-17T13:32:36.729Z",
    });

    for (const body of [payload.slackText, payload.emailText, payload.emailHtml]) {
      expect(body).toContain("trader@example.com");
      expect(body).toContain("scheduled_task");
      expect(body).toContain("stock-copilot-paper-cycle");
      expect(body).toContain("occ-2026-11-17T13:32:00Z");
      expect(body).toContain("trace-5155-1");
      expect(body).toContain("PA3XYZ123");
    }
  });
});
