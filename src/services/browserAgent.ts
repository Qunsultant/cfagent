/**
 * Cloudflare Browser Agent for E*TRADE Trading Desk
 * Based on Cloudflare Agents Browser pattern:
 * https://developers.cloudflare.com/agents/examples/browser-agent/
 *
 * Capabilities:
 * - Headless browser page inspection and DOM scraping via env.BROWSER (Cloudflare Browser Rendering)
 * - Capturing high-resolution screenshots of stock charts and broker order confirmations
 * - Extracting tabular financial data from client-rendered JavaScript dashboards
 * - HTTP fetch + DOM parser fallback when Browser Rendering is unavailable.
 *   That fallback extracts real page text/tables but CANNOT capture a
 *   screenshot: any image it returns is a clearly labelled placeholder
 *   (see BrowserInspectResult.screenshotKind, issue #120).
 */

import type {
  Env,
  BrowserInspectOptions,
  BrowserInspectResult,
  TransactionSnapData,
  BrowserAgentSnapResult,
} from "../types";
import { AGENT_DIDS } from "../agents/did";
import { SERVER_PALETTE } from "../theme/serverPalette";
import { checkSlackWebhookRateLimit } from "./slackWebhookRateLimit";
import { createBrowserRenderer } from "./cloudflareBrowserRenderer";
import { getCfpayConfig, cfpayPostToSlack } from "./cfpayA2A";

// ---------------------------------------------------------------------------
// Spec-aware HTML stripping.
//
// CodeQL js/bad-tag-filter (#853) and js/incomplete-multi-character-
// sanitization (#851, #852, #850): the old chain stripped script/style
// with regexes that required a closing tag, never removed HTML comments,
// and cut every other tag at the first `>` via /<[^>]+>/ — all incomplete
// per the HTML spec:
//
// - `<!--` opens a comment that runs to `-->` OR end of input: an
//   unterminated comment is still a comment and must be removed.
// - `script` / `style` element content runs to the matching close tag OR end of
//   input: an unterminated element must still be dropped entirely,
//   otherwise script text leaks into the extracted page text.
// - A `>` inside a quoted attribute value does not close a tag.
//
// The tempered patterns below consume up to (never past) the terminator,
// mirroring the issue 854 release-notes fix. This is text extraction for LLM /
// user display, not an XSS sanitizer — but the stripping is complete, so no
// markup, comment text, or script/style content survives.
// ---------------------------------------------------------------------------

/** HTML comments: `<!--` … `-->` or end of input. */
const HTML_COMMENT_RE = /<!--(?:(?!-->)[\s\S])*?(?:-->|$)/g;

/** `<script>` … `</script>` or end of input (tempered: never past the close). */
const SCRIPT_ELEMENT_RE = /<script\b(?:(?!<\/script>)[\s\S])*(?:<\/script>|$)/gi;

/** `<style>` … `</style>` or end of input (tempered). */
const STYLE_ELEMENT_RE = /<style\b(?:(?!<\/style>)[\s\S])*(?:<\/style>|$)/gi;

/**
 * Any tag, quote-aware: a `>` inside a double- or single-quoted attribute
 * value does not terminate the match (the old /<[^>]+>/ cut there).
 */
const HTML_TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/** Strip HTML to plain text with whitespace collapsed. */
export function stripHtmlToText(html: string): string {
  return html
    .replace(HTML_COMMENT_RE, " ")
    .replace(SCRIPT_ELEMENT_RE, " ")
    .replace(STYLE_ELEMENT_RE, " ")
    .replace(HTML_TAG_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The receipt a snap's Slack leg must carry when the transport sends
 * TEXT (the cfpay A2A leg) instead of Block Kit. The webhook and
 * bot-token legs post the block payload; posting the one-line headline
 * through the text leg and reporting success would overstate what
 * Slack actually received, so the text leg carries the same fields.
 */
function transactionSnapReceiptText(
  tx: TransactionSnapData,
  parts: {
    actionUpper: string;
    statusUpper: string;
    priceFormatted: string;
    totalFormatted: string;
    routing: string;
    timestamp: string;
  },
): string {
  const lines = [
    `🧾 Transaction Receipt: ${parts.actionUpper} ${tx.quantity} ${tx.symbol} (${parts.statusUpper})`,
    `• Status: ${parts.statusUpper}`,
    `• Price / Order Type: ${parts.priceFormatted} (${(tx.orderType || "MARKET").toUpperCase()})`,
    `• Total Consideration: ${parts.totalFormatted}`,
    `• Broker Routing: ${parts.routing}`,
  ];
  if (tx.legs && tx.legs.length > 0) {
    lines.push(
      `• Legs: ${tx.legs
        .map(
          (leg, idx) =>
            `L${idx + 1} ${leg.action} ${leg.symbol}${leg.strike ? ` @ $${leg.strike}` : ""}${
              leg.expiry ? ` exp ${leg.expiry}` : ""
            }`,
        )
        .join("; ")}`,
    );
  }
  lines.push(`• TxID: ${tx.transactionId} • Timestamp: ${parts.timestamp}`);
  return lines.join("\n");
}

export class ETradeBrowserService {
  constructor(private env?: Env) {}

  /**
   * Inspects a webpage and extracts rendered text, title, and HTML structure
   */
  async inspectPage(options: BrowserInspectOptions): Promise<BrowserInspectResult> {
    const timestamp = new Date().toISOString();
    const url = options.url;

    // 1. If Cloudflare Browser Rendering binding is configured, use it.
    // Issue #1778 (Adapter S4, program #1717): renders go through the
    // one BrowserRenderer port; the Cloudflare BROWSER implementation
    // lives in cloudflareBrowserRenderer.ts. Fail-soft contract
    // preserved: a null render (unbound binding, non-OK response,
    // throw) falls through to the HTTP-fetch + DOM-parsing fallback
    // below, exactly as the pre-S4 direct call did.
    const renderer = createBrowserRenderer(this.env);
    if (renderer) {
      const rendered = await renderer.render({
        url,
        selector: options.selector,
        waitForTimeoutMs: options.waitForTimeoutMs,
        screenshot: options.screenshot,
      });
      if (rendered) {
        return {
          success: true,
          url,
          title: rendered.title || "E*TRADE Financial Portal",
          text: rendered.text || "",
          tables: rendered.tables || [],
          screenshotBase64: rendered.screenshotBase64,
          // Only the real Browser Rendering path produces an actual capture.
          screenshotKind: rendered.screenshotBase64 ? "capture" : undefined,
          timestamp,
        };
      }
    }

    // 2. Fetch page directly and extract semantic content
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CloudflareAgents/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!res.ok) {
        return {
          success: false,
          url,
          error: `HTTP ${res.status}: ${res.statusText}`,
          timestamp,
        };
      }

      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "Rendered Web Page";

      // Extract tables
      const tables = this.extractTablesFromHtml(html);

      // Clean HTML to text — spec-aware stripping (#851, #852, #853).
      let text = stripHtmlToText(html);

      if (text.length > 5000) {
        text = text.slice(0, 5000) + "... [truncated]";
      }

      // No browser capture is possible on this fallback path. If a
      // screenshot was requested, attach a clearly labelled placeholder
      // illustration (issue #120) — never present it as a page capture.
      let screenshotBase64: string | undefined = undefined;
      if (options.screenshot) {
        screenshotBase64 = this.generateScreenshotPlaceholderBase64(url);
      }

      return {
        success: true,
        url,
        title,
        text,
        tables,
        screenshotBase64,
        screenshotKind: screenshotBase64 ? "placeholder" : undefined,
        timestamp,
      };
    } catch (err: any) {
      return {
        success: false,
        url,
        error: err.message || "Failed to inspect page",
        timestamp,
      };
    }
  }

  /**
   * Captures a screenshot of a trading dashboard or chart
   */
  async captureScreenshot(url: string, selector?: string): Promise<{ success: boolean; screenshotBase64?: string; screenshotKind?: "capture" | "placeholder"; error?: string; timestamp: string }> {
    const res = await this.inspectPage({ url, selector, screenshot: true });
    return {
      success: res.success,
      screenshotBase64: res.screenshotBase64,
      screenshotKind: res.screenshotKind,
      error: res.error,
      timestamp: res.timestamp,
    };
  }

  /**
   * Scrapes structured financial tables from rendered DOM
   */
  async scrapeFinancialTables(url: string): Promise<{ success: boolean; tables: Array<Array<string>>; rowCount: number; timestamp: string }> {
    const res = await this.inspectPage({ url });
    return {
      success: res.success,
      tables: res.tables || [],
      rowCount: res.tables ? res.tables.reduce((acc, t) => acc + t.length, 0) : 0,
      timestamp: res.timestamp,
    };
  }

  /**
   * Captures a rendered page snapshot and delivers it to Slack via an incoming webhook or Bot API
   */
  async captureAndSendToSlack(
    url: string,
    options: {
      webhookUrl?: string;
      caption?: string;
      channel?: string;
    } = {}
  ): Promise<{ success: boolean; url: string; error?: string; timestamp: string }> {
    const timestamp = new Date().toISOString();
    const inspectRes = await this.inspectPage({ url, screenshot: true });
    if (!inspectRes.success) {
      return { success: false, url, error: inspectRes.error, timestamp };
    }

    const webhookUrl = options.webhookUrl || this.env?.SLACK_WEBHOOK_URL;
    const pageTitle = inspectRes.title || "Web Page";
    // Issue #120: only a real Browser Rendering capture may be called a
    // snapshot. A placeholder means no image of the page exists — say so.
    const isPlaceholder = inspectRes.screenshotKind === "placeholder";
    const headerLine = isPlaceholder
      ? `📄 Page Summary (no screenshot captured): ${pageTitle.slice(0, 80)}`
      : `📸 Browser Snapshot: ${pageTitle.slice(0, 80)}`;
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: headerLine,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Target URL:* <${url}>\n*Caption:* ${options.caption || (isPlaceholder ? "Page content extracted via Cloudflare Browser Agent (Browser Rendering unavailable, so no screenshot was captured)." : "Autonomous page snapshot captured via Cloudflare Browser Agent.")}\n*Captured At:* \`${timestamp}\``,
        },
      },
    ];

    if (isPlaceholder) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "⚠️ Placeholder only: Browser Rendering was unavailable, so no screenshot of this page was captured. This message contains extracted page text only.",
          },
        ],
      });
    }

    if (inspectRes.text) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Extracted Content Summary:*\n> ${inspectRes.text.slice(0, 300).replace(/\n/g, " ")}...`,
        },
      });
    }

    const payload = {
      channel: options.channel,
      text: `${headerLine} (${url})`,
      blocks,
    };

    if (webhookUrl) {
      // Issue #411: per-destination Slack webhook rate limit (~1/sec, burst 5).
      const rl = checkSlackWebhookRateLimit(webhookUrl);
      if (!rl.allowed) {
        return { success: false, url, error: `Rate limited: Slack webhook calls to this destination are capped at ~1/second; delivery skipped (retry after ${rl.retryAfterMs}ms).`, timestamp };
      }
      try {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
        });
        return { success: resp.ok, url, error: resp.ok ? undefined : `HTTP ${resp.status}`, timestamp };
      } catch (err: any) {
        return { success: false, url, error: err.message, timestamp };
      }
    } else if (this.env?.SLACK_BOT_TOKEN) {
      try {
        const resp = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        });
        const verdict = await this.slackBotApiAccepted(resp);
        return { success: verdict.accepted, url, error: verdict.error, timestamp };
      } catch (err: any) {
        return { success: false, url, error: err.message, timestamp };
      }
    } else if (getCfpayConfig(this.env)) {
      try {
        const config = getCfpayConfig(this.env)!;
        const res = await cfpayPostToSlack(config, payload.text, options.channel);
        return {
          success: res.ok,
          url,
          error: res.ok
            ? undefined
            : `slack_delivery_failed: ${
                res.error ?? "the cfpay Slack agent did not confirm delivery"
              }`,
          timestamp,
        };
      } catch (err: any) {
        return { success: false, url, error: err.message, timestamp };
      }
    }

    // Issue #120: nothing was delivered — report failure, not success.
    return {
      success: false,
      url,
      timestamp,
      error:
        "Not delivered: no Slack transport is configured — none of SLACK_WEBHOOK_URL, SLACK_BOT_TOKEN, " +
        "or cfpay (CFPAY_OUTBOUND_TOKEN / CFPAY_A2A_TOKEN) is set, so nothing was sent to Slack. " +
        "Set one of those to enable Slack delivery.",
    };
  }

  /**
   * Interprets a Slack Bot API (chat.postMessage) response. Slack returns
   * HTTP 200 with { ok: false, error } for many rejections, so HTTP status
   * alone does not prove acceptance (issue #120).
   */
  private async slackBotApiAccepted(resp: Response): Promise<{ accepted: boolean; error?: string }> {
    if (!resp.ok) {
      return { accepted: false, error: `HTTP ${resp.status}` };
    }
    try {
      if (typeof resp.json === "function") {
        const data = (await resp.json()) as any;
        if (data && typeof data.ok === "boolean") {
          return data.ok
            ? { accepted: true }
            : { accepted: false, error: `Slack API error: ${data.error || "unknown_error"}` };
        }
      }
    } catch {
      // Non-JSON body — fall back to the HTTP status verdict.
    }
    return { accepted: true };
  }

  /**
   * Helper to parse table rows from raw HTML
   */
  private extractTablesFromHtml(html: string): Array<Array<string>> {
    const tables: Array<Array<string>> = [];
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let match: RegExpExecArray | null;

    while ((match = tableRegex.exec(html)) !== null && tables.length < 5) {
      const tableContent = match[1];
      const rows: string[] = [];
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch: RegExpExecArray | null;

      while ((rowMatch = rowRegex.exec(tableContent)) !== null && rows.length < 25) {
        const rowContent = rowMatch[1];
        // Tempered cell match (CodeQL js/incomplete-multi-character-
        // sanitization, #850): an unterminated <td>/<th> runs to the end of
        // the row instead of being skipped, the open tag is matched
        // quote-aware, and the inner HTML is stripped with the spec-aware
        // stripHtmlToText instead of the incomplete /<[^>]+>/.
        const cellTexts: string[] = [];
        const cellRe = /<t[hd]\b(?:[^>"']|"[^"]*"|'[^']*')*>((?:(?!<\/t[hd]>)[\s\S])*)(?:<\/t[hd]>|$)/gi;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellRe.exec(rowContent)) !== null) {
          const text = stripHtmlToText(cellMatch[1]);
          if (text) cellTexts.push(text);
        }
        if (cellTexts.length > 0) rows.push(cellTexts.join(" | "));
      }

      if (rows.length > 0) tables.push(rows);
    }

    return tables;
  }

  /**
   * Generates a base64 encoded SVG placeholder used when no real browser
   * screenshot could be captured (issue #120). The placeholder is labelled
   * as a placeholder INSIDE the image itself, so any surface that displays
   * it displays the disclaimer with it. It deliberately contains no chart,
   * no prices, and no performance figures — nothing that could be mistaken
   * for page content or market data.
   */
  private generateScreenshotPlaceholderBase64(url: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <rect width="100%" height="100%" fill="${SERVER_PALETTE.placeholderBackground}"/>
  <rect x="16" y="16" width="768" height="418" fill="none" stroke="${SERVER_PALETTE.warning}" stroke-width="2" stroke-dasharray="10 6"/>
  <text x="400" y="150" fill="${SERVER_PALETTE.warning}" font-family="monospace" font-size="26" font-weight="bold" text-anchor="middle">PLACEHOLDER — NOT A SCREENSHOT</text>
  <text x="400" y="195" fill="${SERVER_PALETTE.slate200}" font-family="monospace" font-size="14" text-anchor="middle">No image of this page was captured.</text>
  <text x="400" y="225" fill="${SERVER_PALETTE.textMuted}" font-family="monospace" font-size="12" text-anchor="middle">Cloudflare Browser Rendering was unavailable, so this illustration was</text>
  <text x="400" y="245" fill="${SERVER_PALETTE.textMuted}" font-family="monospace" font-size="12" text-anchor="middle">generated locally. It shows no page content and no market data.</text>
  <text x="400" y="300" fill="${SERVER_PALETTE.accent}" font-family="monospace" font-size="12" text-anchor="middle">${url}</text>
  <text x="400" y="410" fill="${SERVER_PALETTE.slate500}" font-family="monospace" font-size="11" text-anchor="middle">Generated placeholder • Cloudflare Browser Agent</text>
</svg>`;
    return Buffer.from(svg).toString("base64");
  }

  /**
   * Generates an official base64 encoded SVG visual card receipt for a transaction
   */
  generateTransactionReceiptSvgBase64(tx: TransactionSnapData): string {
    const isBuy = (tx.action || "BUY").toUpperCase().includes("BUY");
    const statusUpper = (tx.status || "EXECUTED").toUpperCase();
    const statusColor = statusUpper === "EXECUTED" || statusUpper === "FILLED"
      ? SERVER_PALETTE.green500
      : statusUpper === "PREVIEWED"
      ? SERVER_PALETTE.accent
      : statusUpper === "REJECTED" || statusUpper === "CANCELLED"
      ? SERVER_PALETTE.sentimentVeryBearish
      : SERVER_PALETTE.warning;

    const badgeFill = isBuy ? SERVER_PALETTE.green700 : SERVER_PALETTE.red700;
    const totalFormatted = tx.totalValue !== undefined
      ? `$${Math.abs(tx.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "N/A";
    const priceFormatted = tx.price !== undefined ? `$${tx.price.toFixed(2)}` : "Market";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="380" viewBox="0 0 700 380">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${SERVER_PALETTE.receiptGradientStart}" />
      <stop offset="100%" stop-color="${SERVER_PALETTE.backgroundEnd}" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bgGrad)" rx="12" />
  <rect x="2" y="2" width="696" height="376" fill="none" stroke="${SERVER_PALETTE.slate800}" stroke-width="2" rx="10" />

  <!-- Top Banner -->
  <text x="35" y="45" fill="${SERVER_PALETTE.accent}" font-family="-apple-system, BlinkMacSystemFont, monospace" font-size="16" font-weight="bold">E*TRADE TRADING DESK | OFFICIAL TRANSACTION RECEIPT</text>
  <rect x="540" y="28" width="125" height="26" rx="13" fill="${badgeFill}" />
  <text x="602" y="45" fill="${SERVER_PALETTE.onGradient}" font-family="-apple-system, sans-serif" font-size="12" font-weight="bold" text-anchor="middle">${(tx.action || "BUY").toUpperCase()}</text>

  <line x1="35" y1="65" x2="665" y2="65" stroke="${SERVER_PALETTE.slate800}" stroke-width="1" />

  <!-- Primary Ticker & Status -->
  <text x="35" y="115" fill="${SERVER_PALETTE.textPrimary}" font-family="-apple-system, sans-serif" font-size="34" font-weight="900">${tx.symbol.toUpperCase()}</text>
  <circle cx="210" cy="105" r="7" fill="${statusColor}" />
  <text x="225" y="110" fill="${statusColor}" font-family="-apple-system, sans-serif" font-size="15" font-weight="bold">${statusUpper}</text>

  <!-- Key Metrics Grid -->
  <rect x="35" y="140" width="195" height="75" fill="${SERVER_PALETTE.card}" rx="8" stroke="${SERVER_PALETTE.slate700}" stroke-width="1" />
  <text x="50" y="165" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">ORDER QUANTITY</text>
  <text x="50" y="198" fill="${SERVER_PALETTE.textPrimary}" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">${tx.quantity.toLocaleString()} units</text>

  <rect x="250" y="140" width="195" height="75" fill="${SERVER_PALETTE.card}" rx="8" stroke="${SERVER_PALETTE.slate700}" stroke-width="1" />
  <text x="265" y="165" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">EXECUTION / LIMIT</text>
  <text x="265" y="198" fill="${SERVER_PALETTE.textPrimary}" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">${priceFormatted}</text>

  <rect x="465" y="140" width="200" height="75" fill="${SERVER_PALETTE.card}" rx="8" stroke="${SERVER_PALETTE.slate700}" stroke-width="1" />
  <text x="480" y="165" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">TOTAL CONSIDERATION</text>
  <text x="480" y="198" fill="${SERVER_PALETTE.accent}" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">${totalFormatted}</text>

  <!-- Transaction Details & Routing -->
  <text x="35" y="245" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">Order Type: <tspan fill="${SERVER_PALETTE.slate100}" font-weight="bold">${tx.orderType || "MARKET"}</tspan></text>
  <text x="250" y="245" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">Environment: <tspan fill="${SERVER_PALETTE.slate100}" font-weight="bold">${tx.environment || "TEST / Sandbox"}</tspan></text>
  <text x="465" y="245" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">Commission: <tspan fill="${SERVER_PALETTE.slate100}" font-weight="bold">$${(tx.commission ?? 0).toFixed(2)}</tspan></text>

  <text x="35" y="275" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">Transaction ID: <tspan fill="${SERVER_PALETTE.textSecondary}" font-family="monospace">${tx.transactionId}</tspan></text>
  <text x="35" y="300" fill="${SERVER_PALETTE.textMuted}" font-family="-apple-system, sans-serif" font-size="12">Executed At: <tspan fill="${SERVER_PALETTE.textSecondary}" font-family="monospace">${tx.timestamp || new Date().toISOString()}</tspan></text>

  <!-- Footer Attestation -->
  <line x1="35" y1="330" x2="665" y2="330" stroke="${SERVER_PALETTE.slate800}" stroke-width="1" />
  <text x="35" y="355" fill="${SERVER_PALETTE.slate500}" font-family="-apple-system, sans-serif" font-size="11">Attested by Cloudflare Browser Agent (${AGENT_DIDS.BROWSER || "did:agent:openaimp:browser"}) • ${tx.humanApproved ? "Human-in-the-Loop Verified" : "Human approval not recorded for this transaction"}</text>
</svg>`;

    return Buffer.from(svg).toString("base64");
  }

  /**
   * Generates a high-fidelity visual receipt of a transaction and sends it to Slack via Webhook or Bot API
   */
  async sendTransactionSnapToSlack(
    tx: TransactionSnapData,
    options: {
      webhookUrl?: string;
      channel?: string;
      caption?: string;
    } = {}
  ): Promise<BrowserAgentSnapResult> {
    const timestamp = tx.timestamp || new Date().toISOString();
    const webhookUrl = options.webhookUrl || this.env?.SLACK_WEBHOOK_URL;
    const isLive = tx.environment === "live" || tx.environment === "PROD";
    const statusUpper = (tx.status || "EXECUTED").toUpperCase();
    const actionUpper = (tx.action || "BUY").toUpperCase();
    const routingLabel = isLive ? "E*TRADE Live [PROD]" : "E*TRADE Sandbox [TEST]";
    const totalFormatted = tx.totalValue !== undefined
      ? `$${Math.abs(tx.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "N/A";
    const priceFormatted = tx.price !== undefined ? `$${tx.price.toFixed(2)}` : "Market";

    // 1. Generate base64 visual receipt graphic
    const screenshotBase64 = this.generateTransactionReceiptSvgBase64(tx);

    // 2. Build Slack Block Kit Message
    const statusEmoji = statusUpper === "EXECUTED" || statusUpper === "FILLED"
      ? "🟢"
      : statusUpper === "PREVIEWED"
      ? "🔵"
      : statusUpper === "REJECTED" || statusUpper === "CANCELLED"
      ? "🔴"
      : "🟡";

    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🧾 Transaction Receipt: ${actionUpper} ${tx.quantity} ${tx.symbol} (${statusUpper})`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Symbol / Asset:*\n*${tx.symbol}*` },
          { type: "mrkdwn", text: `*Order Action:*\n*${actionUpper}* (${tx.quantity} shares/contracts)` },
          { type: "mrkdwn", text: `*Status:*\n${statusEmoji} *${statusUpper}*` },
          { type: "mrkdwn", text: `*Price / Order Type:*\n${priceFormatted} (${tx.orderType || "MARKET"})` },
          { type: "mrkdwn", text: `*Total Consideration:*\n*${totalFormatted}*` },
          { type: "mrkdwn", text: `*Broker Routing:*\n${routingLabel}` },
        ],
      },
    ];

    if (tx.legs && tx.legs.length > 0) {
      const legsText = tx.legs
        .map((leg, idx) => `• *Leg ${idx + 1}:* ${leg.action} ${leg.symbol} ${leg.strike ? `@ $${leg.strike}` : ""} ${leg.expiry ? `exp ${leg.expiry}` : ""}`)
        .join("\n");
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Multi-Leg Strategy Structure:*\n${legsText}`,
        },
      });
    }

    if (tx.notes || options.caption) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `> ${options.caption || tx.notes}`,
        },
      });
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📸 Snap by Browser Agent (\`${AGENT_DIDS.BROWSER || "did:agent:openaimp:browser"}\`) • TxID: \`${tx.transactionId}\` • Timestamp: \`${timestamp}\``,
        },
      ],
    });

    const payload = {
      channel: options.channel,
      text: `🧾 Transaction Snap: ${actionUpper} ${tx.quantity} ${tx.symbol} - ${statusUpper} (${totalFormatted})`,
      blocks,
    };

    // 3. Deliver to Slack
    if (webhookUrl) {
      // Issue #411: per-destination Slack webhook rate limit (~1/sec, burst 5).
      const rl = checkSlackWebhookRateLimit(webhookUrl);
      if (!rl.allowed) {
        return { success: false, transactionId: tx.transactionId, symbol: tx.symbol, error: `Rate limited: Slack webhook calls to this destination are capped at ~1/second; delivery skipped (retry after ${rl.retryAfterMs}ms).`, timestamp };
      }
      try {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
        });

        return {
          success: resp.ok,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          slackWebhookUrl: webhookUrl.replace(/services\/[^\/]+\/[^\/]+/, "services/***/***"),
          channel: options.channel,
          screenshotBase64,
          error: resp.ok ? undefined : `HTTP ${resp.status}: Failed to deliver snap to Slack webhook`,
          timestamp,
        };
      } catch (err: any) {
        return {
          success: false,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          error: err.message || "Network error posting to Slack webhook",
          timestamp,
        };
      }
    } else if (this.env?.SLACK_BOT_TOKEN) {
      try {
        const resp = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        });

        const verdict = await this.slackBotApiAccepted(resp);
        return {
          success: verdict.accepted,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          channel: options.channel,
          screenshotBase64,
          error: verdict.error,
          timestamp,
        };
      } catch (err: any) {
        return {
          success: false,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          error: err.message,
          timestamp,
        };
      }
    } else if (getCfpayConfig(this.env)) {
      try {
        const config = getCfpayConfig(this.env)!;
        // The cfpay leg sends TEXT, so it carries the receipt the block
        // legs carry — not the one-line headline.
        const res = await cfpayPostToSlack(
          config,
          transactionSnapReceiptText(tx, {
            actionUpper,
            statusUpper,
            priceFormatted,
            totalFormatted,
            routing: routingLabel,
            timestamp,
          }),
          options.channel,
        );
        return {
          success: res.ok,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          channel: options.channel,
          screenshotBase64,
          error: res.ok
            ? undefined
            : `slack_delivery_failed: ${
                res.error ?? "the cfpay Slack agent did not confirm delivery"
              }`,
          timestamp,
        };
      } catch (err: any) {
        return {
          success: false,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          error: err.message,
          timestamp,
        };
      }
    }

    // Issue #120: the snap graphic was generated but nothing was delivered —
    // report failure, not success.
    return {
      success: false,
      transactionId: tx.transactionId,
      symbol: tx.symbol,
      screenshotBase64,
      error:
        "Not delivered: no Slack transport is configured — none of SLACK_WEBHOOK_URL, SLACK_BOT_TOKEN, " +
        "or cfpay (CFPAY_OUTBOUND_TOKEN / CFPAY_A2A_TOKEN) is set, so the snap was prepared but " +
        "nothing was sent to Slack. Set one of those to enable Slack delivery.",
      timestamp,
    };
  }
}
