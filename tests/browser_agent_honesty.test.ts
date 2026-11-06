import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

import { ETradeBrowserService } from "../src/services/browserAgent";
import { BrowserScreenshotCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { TransactionSnapData } from "../src/types";

/**
 * Issue #120 — Browser Agent honesty:
 *  - the inspectPage HTTP fallback must never present a locally drawn
 *    placeholder as a screenshot of a real page (flag + in-image label,
 *    no fabricated figures);
 *  - the transaction receipt may print "Human-in-the-Loop Verified" only
 *    when a human approval was recorded;
 *  - Slack snap methods may report success only when Slack actually
 *    accepted a delivery; no configuration = honest failure, and the
 *    /snap handlers must tell the user nothing was delivered.
 */

const PAGE_HTML = `<html><head><title>NVDA Quote Page</title></head><body>
<table><tr><td>Symbol</td><td>Price</td></tr><tr><td>NVDA</td><td>131.20</td></tr></table>
<p>Extracted page body text for the quote page.</p></body></html>`;

function htmlResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => PAGE_HTML,
    json: async () => ({}),
  } as any;
}

function okResponse() {
  return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true }) } as any;
}

const sampleTx: TransactionSnapData = {
  transactionId: "TX_HONESTY_1",
  symbol: "AAPL",
  action: "BUY",
  quantity: 3,
  price: 200.0,
  orderType: "LIMIT",
  status: "EXECUTED",
  totalValue: 600.0,
  environment: "sandbox",
};

describe("Issue #120: Browser Agent honesty", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => htmlResponse());
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // F4 — screenshot placeholder
  // =========================================================================
  describe("inspectPage fallback screenshot is a flagged placeholder, not a capture", () => {
    it("flags the fallback image as placeholder and labels it inside the image", async () => {
      const service = new ETradeBrowserService({} as any);
      const res = await service.inspectPage({ url: "https://example.com/quote/NVDA", screenshot: true });

      // The page inspection itself really succeeded (text/tables extracted).
      expect(res.success).toBe(true);
      expect(res.text).toContain("Extracted page body text");
      expect(res.screenshotBase64).toBeDefined();
      expect(res.screenshotKind).toBe("placeholder");

      const svg = Buffer.from(res.screenshotBase64!, "base64").toString("utf-8");
      expect(svg).toContain("PLACEHOLDER — NOT A SCREENSHOT");
      expect(svg).toContain("No image of this page was captured");
      // No fabricated market data or fake-capture captions anywhere.
      expect(svg).not.toContain("+14.2%");
      expect(svg).not.toContain("<polyline");
      expect(svg).not.toContain("Browser Snapshot");
      expect(svg).not.toContain("Captured via");
    });

    it("captureScreenshot propagates the placeholder kind", async () => {
      const service = new ETradeBrowserService({} as any);
      const res = await service.captureScreenshot("https://example.com/chart");
      expect(res.success).toBe(true);
      expect(res.screenshotKind).toBe("placeholder");
    });

    it("marks a real Browser Rendering image as a capture", async () => {
      const env = {
        BROWSER: {
          fetch: async () => ({
            ok: true,
            json: async () => ({ title: "Real Page", text: "body", tables: [], screenshotBase64: "REAL_CAPTURE_B64" }),
          }),
        },
      } as any;
      const service = new ETradeBrowserService(env);
      const res = await service.inspectPage({ url: "https://example.com/x", screenshot: true });
      expect(res.success).toBe(true);
      expect(res.screenshotBase64).toBe("REAL_CAPTURE_B64");
      expect(res.screenshotKind).toBe("capture");
    });

    it("MCP browser_screenshot returns the placeholder kind so clients cannot present it as a capture", async () => {
      const cmd = new BrowserScreenshotCommand();
      const audit = vi.fn();
      const result: any = await cmd.execute(
        { url: "https://example.com/chart" },
        { env: {}, audit } as any
      );
      expect(result.screenshotKind).toBe("placeholder");
      expect(audit).toHaveBeenCalledWith(
        "browser.screenshot",
        "browser",
        expect.objectContaining({ screenshotKind: "placeholder" })
      );
      expect(cmd.description).toContain("placeholder");
    });
  });

  // =========================================================================
  // F4 — receipt HITL claim gating
  // =========================================================================
  describe("transaction receipt HITL claim", () => {
    it("omits 'Human-in-the-Loop Verified' when no approval was recorded", () => {
      const service = new ETradeBrowserService({} as any);
      const svg = Buffer.from(service.generateTransactionReceiptSvgBase64(sampleTx), "base64").toString("utf-8");
      expect(svg).not.toContain("Human-in-the-Loop Verified");
      expect(svg).toContain("Human approval not recorded for this transaction");
    });

    it("prints 'Human-in-the-Loop Verified' only with a recorded approval", () => {
      const service = new ETradeBrowserService({} as any);
      const svg = Buffer.from(
        service.generateTransactionReceiptSvgBase64({ ...sampleTx, humanApproved: true }),
        "base64"
      ).toString("utf-8");
      expect(svg).toContain("Human-in-the-Loop Verified");
    });
  });

  // =========================================================================
  // F5 — Slack delivery honesty
  // =========================================================================
  describe("captureAndSendToSlack", () => {
    it("fails honestly when no Slack delivery is configured — nothing is sent", async () => {
      const service = new ETradeBrowserService({} as any);
      const res = await service.captureAndSendToSlack("https://example.com/quote/NVDA");

      expect(res.success).toBe(false);
      expect(res.error).toContain("Not delivered");
      expect(res.error).toContain("SLACK_WEBHOOK_URL");

      // The only fetch performed was the page fetch — no Slack endpoint hit.
      const urls = fetchSpy.mock.calls.map((c: any) => String(c[0]));
      expect(urls.some((u) => u.includes("slack.com") || u.includes("hooks.slack"))).toBe(false);
    });

    it("succeeds only when the webhook accepts, and discloses the placeholder in the payload", async () => {
      fetchSpy.mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes("hooks.slack.com")) return okResponse();
        return htmlResponse();
      });

      const service = new ETradeBrowserService({} as any);
      const res = await service.captureAndSendToSlack("https://example.com/quote/NVDA", {
        webhookUrl: "https://hooks.slack.com/services/T/B/X",
      });
      expect(res.success).toBe(true);

      const webhookCall = fetchSpy.mock.calls.find((c: any) => String(c[0]).includes("hooks.slack.com"));
      expect(webhookCall).toBeDefined();
      const payload = JSON.parse((webhookCall![1] as any).body as string);
      const allText = JSON.stringify(payload.blocks);
      // Placeholder honesty must ride into the delivered message itself.
      expect(allText).toContain("no screenshot captured");
      expect(allText).toContain("no screenshot of this page was captured");
      expect(payload.text).not.toContain("Browser Snapshot:");
    });

    it("treats a Slack Bot API ok:false response (HTTP 200) as not delivered", async () => {
      fetchSpy.mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes("slack.com/api")) {
          return { ok: true, status: 200, json: async () => ({ ok: false, error: "channel_not_found" }) } as any;
        }
        return htmlResponse();
      });

      const service = new ETradeBrowserService({ SLACK_BOT_TOKEN: "xoxb-test" } as any);
      const res = await service.captureAndSendToSlack("https://example.com/quote/NVDA");
      expect(res.success).toBe(false);
      expect(res.error).toContain("channel_not_found");
    });
  });

  describe("sendTransactionSnapToSlack", () => {
    it("fails honestly when no Slack delivery is configured", async () => {
      const service = new ETradeBrowserService({} as any);
      const res = await service.sendTransactionSnapToSlack(sampleTx);

      expect(res.success).toBe(false);
      expect(res.error).toContain("Not delivered");
      expect(res.error).toContain("SLACK_WEBHOOK_URL");
      // The receipt graphic itself was still generated and is returned.
      expect(res.screenshotBase64).toBeDefined();
      // No fetch of any kind was attempted.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("succeeds when the webhook accepts the delivery", async () => {
      fetchSpy.mockResolvedValue(okResponse());
      const service = new ETradeBrowserService({} as any);
      const res = await service.sendTransactionSnapToSlack(sampleTx, {
        webhookUrl: "https://hooks.slack.com/services/T/B/X",
      });
      expect(res.success).toBe(true);
      expect(res.error).toBeUndefined();
    });

    it("treats a Slack Bot API ok:false response (HTTP 200) as not delivered", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: "invalid_auth" }),
      } as any);
      const service = new ETradeBrowserService({ SLACK_BOT_TOKEN: "xoxb-bad" } as any);
      const res = await service.sendTransactionSnapToSlack(sampleTx);
      expect(res.success).toBe(false);
      expect(res.error).toContain("invalid_auth");
    });
  });

  describe("/snap handler user-facing message", () => {
    it("tells the user nothing was delivered when Slack is not configured", async () => {
      const sql = new MockSqlStorage();
      const envNoSlack = {
        APP_BASE_URL: "https://agent.openaimp.com",
        ETRADE_ENVIRONMENT: "sandbox",
        SLACK_SIGNING_SECRET: "test_secret",
        ORCHESTRATOR_AGENT: {} as any,
      } as any;

      // Issue #1262 Phase 2: the retired SlackAgent.handleSlashCommand
      // is gone; /snap runs through the single service.
      const slackService = new ETradeSlackTradingService(envNoSlack, new DatabaseORM(sql), "T0123456789", undefined);
      const formData = new FormData();
      formData.append("command", "/snap");
      formData.append("text", "SPY");
      formData.append("user_id", "U_SNAP");
      formData.append("channel_id", "C_SNAP");

      const response = await slackService.processSlackCommand(formData);
      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.text).toContain("Not delivered");
      expect(json.text).not.toContain("Delivered to Slack");
    });
  });

  // =========================================================================
  // Source pins — the fabricated artefacts must not return
  // =========================================================================
  describe("source pins", () => {
    const source = readFileSync(resolve(process.cwd(), "src/services/browserAgent.ts"), "utf-8");

    it("contains no fabricated performance figure or dishonest success wording", () => {
      expect(source).not.toContain("+14.2%");
      expect(source).not.toContain("payload prepared successfully");
      expect(source).not.toContain("snap prepared successfully");
    });

    it("keeps the placeholder labelling and honest failure wording", () => {
      expect(source).toContain("PLACEHOLDER — NOT A SCREENSHOT");
      expect(source).toContain("Not delivered:");
      // Issue #1778 (Adapter S4): the capture-kind gate moved with the
      // render call into the BrowserRenderer port — the variable is
      // now `rendered`, not the pre-S4 inline `data`; the gate itself
      // (capture only when a real render produced a screenshot) is
      // unchanged, and the port's mapping is pinned in adapter-s4-1778.
      expect(source).toContain('screenshotKind: rendered.screenshotBase64 ? "capture" : undefined');
    });
  });
});
