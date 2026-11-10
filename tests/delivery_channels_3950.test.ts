/**
 * Issue #3950 — delivery via channels: the text leg must carry the
 * receipt, and a transport failure must be a named business error.
 *
 * Reported from a live session: a transaction snap routed through the
 * cfpay Slack leg posted only the one-line headline and reported
 * success, and a cfpay answer with no delivery receipt surfaced as the
 * raw protocol code `no_data_part_in_response` — naming no channel,
 * no outcome, and no action.
 *
 * Pins, in the order the report raised them:
 *   1. A text-only leg carries the receipt the block legs carry.
 *   2. A cfpay failure reads `slack_delivery_failed: …`.
 *   3. A 2xx with no receipt is UNCONFIRMED, with a stable code.
 *   4. The terminal not-delivered message names every transport checked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ETradeBrowserService } from "../src/services/browserAgent";
import * as cfpayA2A from "../src/services/cfpayA2A";
import { cfpayA2AOperation } from "../src/services/cfpayA2A";
import type { TransactionSnapData } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

const CFPAY_ENV = { CFPAY_URL: "https://pay.example", CFPAY_OUTBOUND_TOKEN: "token" };

const TX: TransactionSnapData = {
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
  legs: [
    { action: "SELL", symbol: "AAPL", strike: 247.52 },
    { action: "SELL", symbol: "AAPL", strike: 233.24 },
  ],
} as TransactionSnapData;

const stubFetch = (payload: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })),
  );

// ---------------------------------------------------------------------------
// 3. The protocol answer, named
// ---------------------------------------------------------------------------

describe("cfpay A2A answers are named delivery outcomes (#3950)", () => {
  const config = { baseUrl: "https://pay.example", token: "t" };

  it("a 2xx with no data part is UNCONFIRMED delivery, not a raw protocol code", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: { artifacts: [{ parts: [{ kind: "text", text: "ok" }] }] } });
    const res = await cfpayA2AOperation(config, "/a2a/slack", "slack.post", { text: "hi" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("cfpay_no_delivery_receipt");
    // The protocol detail stays traceable without being the whole story.
    expect(res.error).toContain("no_data_part_in_response");
    expect(res.error).toContain("unconfirmed");
    expect(res.error).toContain("/a2a/slack");
  });

  it("a non-2xx answer is a named HTTP failure that says delivery is unconfirmed", async () => {
    stubFetch({ error: "boom" }, 502);
    const res = await cfpayA2AOperation(config, "/a2a/email", "email.send", {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe("cfpay_http_error");
    expect(res.error).toContain("502");
    expect(res.error).toContain("/a2a/email");
    expect(res.error).toContain("not confirmed delivered");
  });

  it("a delivered answer still reports ok with its data", async () => {
    stubFetch({
      jsonrpc: "2.0",
      id: 1,
      result: { artifacts: [{ parts: [{ kind: "data", data: { ok: true, ts: "123" } }] }] },
    });
    const res = await cfpayA2AOperation(config, "/a2a/slack", "slack.post", {});
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ ok: true, ts: "123" });
  });
});

// ---------------------------------------------------------------------------
// 1. The text leg carries the receipt
// ---------------------------------------------------------------------------

describe("the snap's text leg carries the receipt (#3950)", () => {
  it("posts the receipt fields, not the one-line headline", async () => {
    const post = vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({ ok: true });
    const service = new ETradeBrowserService(CFPAY_ENV as never);

    const res = await service.sendTransactionSnapToSlack(TX, { channel: "#desk" });

    expect(res.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const text = String(post.mock.calls[0][1]);
    // The fields the Block Kit legs carry.
    expect(text).toContain("Transaction Receipt: BUY 10 AAPL (SUBMITTED)");
    expect(text).toContain("Status: SUBMITTED");
    expect(text).toContain("Price / Order Type: $238.00 (LIMIT)");
    expect(text).toContain("Total Consideration: $2,380.00");
    expect(text).toContain("Broker Routing:");
    expect(text).toContain("TxID: 6314402b");
    expect(text).toContain("Legs:");
    // Not the headline alone.
    expect(text).not.toBe("🧾 Transaction Snap: BUY 10 AAPL - SUBMITTED ($2,380.00)");
    expect(post.mock.calls[0][2]).toBe("#desk");
  });

  it("keeps a real (non-cfpay) transport on the block payload", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        calls.push(String(url));
        return new Response("ok", { status: 200 });
      }),
    );
    const service = new ETradeBrowserService({
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/X0",
    } as never);

    const res = await service.sendTransactionSnapToSlack(TX);
    expect(res.success).toBe(true);
    expect(calls[0]).toContain("hooks.slack.com");
  });
});

// ---------------------------------------------------------------------------
// 2. Transport failures are named
// ---------------------------------------------------------------------------

describe("transport failures are named (#3950)", () => {
  it("a cfpay snap failure reads slack_delivery_failed with the cause", async () => {
    vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({
      ok: false,
      code: "cfpay_no_delivery_receipt",
      error: "cfpay returned no delivery receipt (no_data_part_in_response)",
    });
    const service = new ETradeBrowserService(CFPAY_ENV as never);

    const res = await service.sendTransactionSnapToSlack(TX);

    expect(res.success).toBe(false);
    expect(res.error).toContain("slack_delivery_failed:");
    expect(res.error).toContain("no delivery receipt");
  });

  it("a cfpay page-capture failure reads slack_delivery_failed too", async () => {
    vi.spyOn(cfpayA2A, "cfpayPostToSlack").mockResolvedValue({
      ok: false,
      code: "cfpay_http_error",
      error: "cfpay A2A answered HTTP 503",
    });
    const service = new ETradeBrowserService(CFPAY_ENV as never);
    vi.spyOn(service, "inspectPage").mockResolvedValue({
      success: true,
      url: "https://example.com/page",
      title: "Example",
      status: 200,
      timestamp: "2026-11-10T08:28:00.000Z",
      text: "Example page",
      screenshotKind: "real",
    } as never);

    const res = await service.captureAndSendToSlack("https://example.com/page", {});
    expect(res.success).toBe(false);
    expect(res.error).toContain("slack_delivery_failed:");
    expect(res.error).toContain("503");
  });
});

// ---------------------------------------------------------------------------
// 4. The transport list is complete
// ---------------------------------------------------------------------------

describe("the not-delivered message names every transport (#3950)", () => {
  it("names the webhook, the bot token and cfpay", async () => {
    const service = new ETradeBrowserService({} as never);
    const snap = await service.sendTransactionSnapToSlack(TX);
    expect(snap.success).toBe(false);
    for (const token of ["SLACK_WEBHOOK_URL", "SLACK_BOT_TOKEN", "cfpay", "CFPAY_OUTBOUND_TOKEN"]) {
      expect(snap.error, token).toContain(token);
    }
    expect(snap.error).toContain("the snap was prepared but nothing was sent");
  });

  it("names the same three transports on the page-capture path", async () => {
    const service = new ETradeBrowserService({} as never);
    vi.spyOn(service, "inspectPage").mockResolvedValue({
      success: true,
      url: "https://example.com/page",
      title: "Example",
      status: 200,
      timestamp: "2026-11-10T08:28:00.000Z",
      text: "Example page",
      screenshotKind: "real",
    } as never);
    const res = await service.captureAndSendToSlack("https://example.com/page", {});
    expect(res.success).toBe(false);
    for (const token of ["SLACK_WEBHOOK_URL", "SLACK_BOT_TOKEN", "CFPAY_OUTBOUND_TOKEN"]) {
      expect(res.error, token).toContain(token);
    }
  });
});
