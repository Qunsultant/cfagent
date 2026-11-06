/**
 * Cloudflare Wallets - Native x402 Pay-Per-Use Options Scanner MCP Server
 *
 * Implements the Cloudflare Wallets / x402 paidTool pattern:
 * https://blog.cloudflare.com/wallets/
 * https://developers.cloudflare.com/agents/tools/payments/x402/charge-for-mcp-tools/
 *
 * How it works:
 * 1. An MCP client (Claude Desktop, Cursor, VS Code) calls `screen_options`.
 * 2. withX402 intercepts the call and returns HTTP 402 + PAYMENT-REQUIRED header
 *    containing price ($0.05 USDC), recipient wallet, and network.
 * 3. The client auto-pays via its Cloudflare Wallet and retries with PAYMENT-SIGNATURE.
 * 4. withX402 verifies payment via x402.org facilitator then invokes the handler.
 * 5. The handler queues the shared async options capability and returns its job ID.
 *
 * Environment variables (wrangler.jsonc vars / secrets):
 *   CF_WALLET_RECIPIENT   - 0x... USDC recipient (your Cloudflare Wallet address)
 *   CF_WALLET_NETWORK     - "base-sepolia" (testing) | "base" (production)
 *   CF_WALLET_FACILITATOR - https://x402.org/facilitator (default)
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";
import { optionScreenerFilterFields } from "../../trading";
import type { Env } from "../../types";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import { AGENT_DIDS } from "../../agents/did";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "mcps/scanner/cloudflareWalletsScanner",
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANNER_PRICE_USD = 0.05; // $0.05 USDC per scan

// ---------------------------------------------------------------------------
// Durable Object: OptionsScannerMCP
// ---------------------------------------------------------------------------

export class OptionsScannerMCP extends McpAgent<Env> {
  private get x402Config(): X402Config {
    return {
      network: (this.env?.CF_WALLET_NETWORK ?? "base-sepolia") as string,
      recipient: (this.env?.CF_WALLET_RECIPIENT ??
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
      facilitator: {
        url: this.env?.CF_WALLET_FACILITATOR ?? "https://x402.org/facilitator",
      },
    };
  }

  server = withX402(
    new McpServer({ name: "cfagent-options-scanner", version: "1.0.0" }),
    // Config is resolved lazily via getter so env is available by init time.
    // We pass a stable proxy that reads from the getter on each access.
    new Proxy({} as X402Config, {
      get: (_t, prop: keyof X402Config) => this.x402Config[prop],
    }),
  );

  async init() {
    // ------------------------------------------------------------------
    // PAID TOOL: screen_options  ($0.05 USDC per call via Cloudflare Wallets)
    // ------------------------------------------------------------------
    this.server.paidTool(
      "screen_options",
      "Institutional options screener with Delta, Gamma, Theta, IV percentile, " +
        "volume, and open-interest flow analysis. " +
        `$${SCANNER_PRICE_USD.toFixed(2)} USDC per call via Cloudflare Wallets (x402).`,
      SCANNER_PRICE_USD,
      {
        underlying: z
          .string()
          .optional()
          .describe("Optional underlying ticker; omit to dynamically discover current U.S. stock listings"),
        // Issue #959: the filter constraints are composed from the ONE
        // shared options-filter definition (optionScreenerFilterFields
        // in src/trading/screeningSchemas.ts) — this tool no longer
        // carries a private copy. The public argument names are
        // unchanged (maxDTE/minDTE map onto the shared maxDte/minDte
        // fields in the forwarded body); the tool's own 0..1 delta
        // bounds are layered on the shared field schemas.
        maxUnderlyings: optionScreenerFilterFields.maxUnderlyings.describe("Maximum underlying symbols for a broad scan"),
        contractType: optionScreenerFilterFields.contractType.describe("Option contract type; omitted screens calls and puts"),
        minDelta: optionScreenerFilterFields.minDelta.unwrap().min(0).max(1).optional().describe("Minimum absolute delta"),
        maxDelta: optionScreenerFilterFields.maxDelta.unwrap().min(0).max(1).optional().describe("Maximum absolute delta"),
        minOpenInterest: optionScreenerFilterFields.minOpenInterest.describe("Minimum open interest"),
        maxDTE: optionScreenerFilterFields.maxDte.describe("Maximum days-to-expiry"),
        minDTE: optionScreenerFilterFields.minDte.describe("Minimum days-to-expiry"),
        minVolume: optionScreenerFilterFields.minVolume.describe("Minimum daily contract volume"),
        maxSpreadPct: optionScreenerFilterFields.maxSpreadPct.describe("Maximum bid/ask spread as percent of midpoint"),
        maxQuoteAgeSeconds: optionScreenerFilterFields.maxQuoteAgeSeconds.describe("Quote-age freshness reference; stale rows remain labeled, not excluded"),
        limit: optionScreenerFilterFields.limit.describe("Maximum contracts to return"),
      },
      { readOnlyHint: true, title: "Options Screener (Pay-Per-Use via Cloudflare Wallets)" },
      async ({ underlying, maxUnderlyings, contractType, minDelta, maxDelta, minOpenInterest, maxDTE, minDTE, minVolume, maxSpreadPct, maxQuoteAgeSeconds, limit }) => {
        const input = {
          underlyingSymbols: underlying ? [underlying.toUpperCase().trim()] : undefined,
          maxUnderlyings,
          contractType,
          minDelta,
          maxDelta,
          minDte: minDTE,
          maxDte: maxDTE,
          minOpenInterest,
          minVolume,
          maxSpreadPct,
          maxQuoteAgeSeconds,
          limit,
        };
        const queued = await this.forwardToOrchestrator(
          "/api/trading/options/screen",
          "POST",
          input
        ) as { jobId: string; status: "queued"; statusUrl: string };
        if (!queued.jobId || queued.status !== "queued") {
          throw new Error("Paid screening request was not accepted as a background job.");
        }

        const normalizedUnderlying = underlying?.toUpperCase().trim() || "all_exchange_listings";
        // Issue #700 (point 2): the paid-scan audit event is persisted in
        // the orchestrator's mas_events (see persistAudit). Registered
        // with waitUntil so the write can complete without blocking the
        // tool response; persistAudit never rejects.
        const auditWrite = this.persistAudit(normalizedUnderlying, undefined, queued.jobId);
        if (typeof this.ctx?.waitUntil === "function") {
          this.ctx.waitUntil(auditWrite);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  pricePaid: `$${SCANNER_PRICE_USD.toFixed(2)} USDC`,
                  paymentProtocol: "x402 / Cloudflare Wallets",
                  network: this.env?.CF_WALLET_NETWORK ?? "base-sepolia",
                  proposerDid: AGENT_DIDS.PAYMENTS,
                  underlying: normalizedUnderlying,
                  jobId: queued.jobId,
                  status: queued.status,
                  statusTool: "get_scan_job",
                  message: "Payment was accepted and the scan is running asynchronously. Retrieve the result with get_scan_job.",
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // ------------------------------------------------------------------
    // FREE TOOL: scanner_status  (no payment required)
    // ------------------------------------------------------------------
    this.server.tool(
      "scanner_status",
      "Check options scanner availability, pricing, and wallet config.",
      {},
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "available",
                tool: "screen_options",
                pricePerCall: `$${SCANNER_PRICE_USD.toFixed(2)} USDC`,
                paymentProtocol: "x402 (Cloudflare Wallets)",
                network: this.env?.CF_WALLET_NETWORK ?? "base-sepolia",
                recipient: this.env?.CF_WALLET_RECIPIENT ?? "(not configured - set CF_WALLET_RECIPIENT)",
                underlyingDiscovery: "Dynamic current Nasdaq, NYSE, and AMEX stock listings; specify an explicit maximum for broad scans.",
                supportedContractTypes: ["CALL", "PUT", "BOTH"],
                agentDid: AGENT_DIDS.PAYMENTS,
                docs: "https://developers.cloudflare.com/agents/tools/payments/x402/charge-for-mcp-tools/",
              },
              null,
              2,
            ),
          },
        ],
      }),
    );

    this.server.tool(
      "get_scan_job",
      "Get the status or completed result of a paid asynchronous options scan.",
      { jobId: z.string().uuid().describe("Job ID returned by screen_options") },
      async ({ jobId }) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(await this.forwardToOrchestrator(`/api/jobs/${jobId}`, "GET"), null, 2),
        }],
      }),
    );

    this.server.tool(
      "list_scan_jobs",
      "List recent paid options scans submitted by this scanner session.",
      {},
      async () => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(await this.forwardToOrchestrator("/api/jobs?limit=30", "GET"), null, 2),
        }],
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async forwardToOrchestrator(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const headers = new Headers();
    // Issue #1185 / #700: the scanner asserts no identity of its own.
    // It forwards under the configured service identity when one
    // exists and asserts none otherwise — never a synthetic login.
    const serviceLogin = getServiceUserLogin(this.env);
    if (serviceLogin) headers.set("x-user-login", serviceLogin);
    if (body) headers.set("Content-Type", "application/json");
    const response = await actorGateway.dispatch(
      this.env.SEARCH_AGENT,
      this.ctx.id.toString(),
      new Request(new URL(path, "https://agent.internal"), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Async options service returned HTTP ${response.status}.`);
    }
    return data;
  }

  /**
   * Persists the paid-scan audit event in the ORCHESTRATOR's mas_events —
   * the store GET /api/audit reads — via POST /api/audit/event, which
   * funnels into recordAudit(), the single owner of mas_events inserts
   * (issue #270). The write travels the same SEARCH_AGENT channel (and to
   * the same orchestrator instance) as the scan job it belongs to.
   *
   * Issue #700 (point 2): the previous implementation wrote to this DO's
   * own storage through the ORM, passing `this.ctx.storage` where its
   * constructor expects ctx.storage.sql, and this DO never ran
   * initializeSchema — so it threw on every paid scan and a bare catch
   * swallowed the failure.
   * No CF_WALLET_SCANNER_PAID record was ever written.
   *
   * The event is an intent record: it fires when the paid scan is QUEUED,
   * so matchedCount is included only when a caller actually knows it —
   * never fabricated. recordAudit assigns the stored row's id (a full
   * UUID) and timestamp; the scanner-generated eventId below travels in
   * the payload as the correlation id and is what failure logs cite.
   *
   * Failure contract: a failed audit write never fails the paid scan
   * (this method never rejects), but it is always logged explicitly with
   * the event id — no silent swallow.
   */
  private async persistAudit(underlying: string, matchedCount?: number, jobId?: string): Promise<void> {
    const eventId = crypto.randomUUID();
    const payload: Record<string, unknown> = {
      eventId,
      source: "cf_wallet_scanner",
      underlying,
      jobId,
      pricePaid: SCANNER_PRICE_USD,
      protocol: "x402",
      proposerDid: AGENT_DIDS.PAYMENTS,
    };
    if (typeof matchedCount === "number") {
      payload.matchedCount = matchedCount;
    }
    try {
      await this.forwardToOrchestrator(
        "/api/audit/event",
        "POST",
        {
          type: "CF_WALLET_SCANNER_PAID",
          agent: "payments",
          payload,
        }
      );
    } catch (err) {
      structuredLog.error("options_scanner.audit_persist_failed", {
        message: `[OptionsScannerMCP] Failed to persist CF_WALLET_SCANNER_PAID audit event ${eventId} (jobId: ${jobId ?? "unknown"})`,
        eventId,
        jobId: jobId ?? "unknown",
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
      });
    }
  }
}
