/**
 * Issue #3980 — a bot-API Slack leg must resolve a channel, and refuse
 * by name when it cannot.
 *
 * `sendTransactionSnapToSlack` / `captureAndSendToSlack` posted
 * `channel: options.channel` straight to `chat.postMessage`. Callers
 * (`browser_snap_transaction`, `browser_capture_page`) often pass none,
 * and this class had no SLACK_CHANNEL fallback — unlike the trading
 * agent and slackFiles — so with only SLACK_BOT_TOKEN configured Slack
 * rejected the post and the operator saw a Slack API error instead of a
 * configuration one.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ETradeBrowserService } from "../src/services/browserAgent";
import type { TransactionSnapData } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

const TX = {
  transactionId: "6314402b-cb1b-47d1-9744-8e8665f68d8a",
  symbol: "AAPL",
  action: "BUY",
  quantity: 10,
  status: "SUBMITTED",
  price: 238,
  orderType: "LIMIT",
  totalValue: 2380,
  environment: "paper",
  timestamp: "2026-11-10T08:28:00.000Z",
} as TransactionSnapData;

/** A slack.com stub that records what would have been posted. */
function slackStub(payload: unknown = { ok: true }) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

function pageStub(service: ETradeBrowserService) {
  vi.spyOn(service, "inspectPage").mockResolvedValue({
    success: true,
    url: "https://example.com/page",
    title: "Example",
    status: 200,
    timestamp: "2026-11-10T08:28:00.000Z",
    text: "Example page",
    screenshotKind: "real",
  } as never);
}

// ---------------------------------------------------------------------------
// The snap path
// ---------------------------------------------------------------------------

describe("snap delivery resolves a bot-API channel (#3980)", () => {
  it("falls back to SLACK_CHANNEL when the caller passes none", async () => {
    const calls = slackStub();
    const service = new ETradeBrowserService({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_CHANNEL: "#desk",
    } as never);

    const res = await service.sendTransactionSnapToSlack(TX);

    expect(res.success).toBe(true);
    expect(res.channel).toBe("#desk");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("chat.postMessage");
    expect(calls[0].body.channel).toBe("#desk");
  });

  it("falls back to SCREENER_SLACK_CHANNEL second", async () => {
    const calls = slackStub();
    const service = new ETradeBrowserService({
      SLACK_BOT_TOKEN: "xoxb-test",
      SCREENER_SLACK_CHANNEL: "#screener",
    } as never);

    await service.sendTransactionSnapToSlack(TX);
    expect(calls[0].body.channel).toBe("#screener");
  });

  it("lets the caller's channel win over the configured default", async () => {
    const calls = slackStub();
    const service = new ETradeBrowserService({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_CHANNEL: "#desk",
    } as never);

    const res = await service.sendTransactionSnapToSlack(TX, { channel: "#orders" });
    expect(res.channel).toBe("#orders");
    expect(calls[0].body.channel).toBe("#orders");
  });

  it("refuses by name — and sends nothing — when no channel resolves", async () => {
    const calls = slackStub();
    const service = new ETradeBrowserService({ SLACK_BOT_TOKEN: "xoxb-test" } as never);

    const res = await service.sendTransactionSnapToSlack(TX);

    expect(res.success).toBe(false);
    expect(res.error).toContain("slack_channel_not_configured");
    expect(res.error).toContain("SLACK_CHANNEL");
    expect(calls).toHaveLength(0);
    // The prepared snap still travels back to the caller.
    expect(res.screenshotBase64).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The page-capture path
// ---------------------------------------------------------------------------

describe("page capture resolves a bot-API channel (#3980)", () => {
  it("uses SLACK_CHANNEL when the caller passes none", async () => {
    const calls = slackStub();
    const service = new ETradeBrowserService({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_CHANNEL: "#desk",
    } as never);
    pageStub(service);

    const res = await service.captureAndSendToSlack("https://example.com/page");
    expect(res.success).toBe(true);
    expect(calls[0].body.channel).toBe("#desk");
  });

  it("refuses by name — and sends nothing — when no channel resolves", async () => {
    const calls = slackStub();
    const service = new ETradeBrowserService({ SLACK_BOT_TOKEN: "xoxb-test" } as never);
    pageStub(service);

    const res = await service.captureAndSendToSlack("https://example.com/page");
    expect(res.success).toBe(false);
    expect(res.error).toContain("slack_channel_not_configured");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The webhook leg is untouched: a webhook needs no channel
// ---------------------------------------------------------------------------

describe("the webhook leg needs no channel (#3980)", () => {
  it("delivers through a webhook with no channel configured anywhere", async () => {
    const calls = slackStub();
    const service = new ETradeBrowserService({
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/X0",
    } as never);

    const res = await service.sendTransactionSnapToSlack(TX);
    expect(res.success).toBe(true);
    expect(calls[0].url).toContain("hooks.slack.com");
    expect(res.error).toBeUndefined();
  });
});
