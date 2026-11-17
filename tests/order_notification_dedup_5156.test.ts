import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifyOrderExecution,
  resetOrderNotificationDedupForTests,
} from "../src/services/orderExecutionNotifier";

describe("Issue #5156 (Sub-issue 2 of #5154) — Idempotent Order Notification Delivery", () => {
  beforeEach(() => {
    resetOrderNotificationDedupForTests();
  });

  it("delivers Slack once per (orderId, status, channel) and marks subsequent calls deduped", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXXX",
    };
    const input = {
      orderId: "3cb39fdd-7790-4903-9731-df292c80b0da",
      broker: "alpaca",
      mode: "paper",
      symbol: "MSFT",
      action: "SELL",
      quantity: 25,
      orderType: "LIMIT",
      price: 517.99,
      status: "executed",
      origin: "stock_copilot_exit",
      userLogin: "trader@example.com",
    };

    const first = await notifyOrderExecution(env, input);
    expect(first.slack.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await notifyOrderExecution(env, input);
    expect(second.slack.status).toBe("deduped");
    expect(second.slack.sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
