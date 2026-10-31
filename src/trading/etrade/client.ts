/**
 * Low-level E*TRADE REST API Client
 *
 * Implements:
 * - RFC 5849 OAuth 1.0a HMAC-SHA1 Authorization.
 * - Strict URL formatting: `/v1/market/quote/{symbols}?detailFlag=ALL` (without erroneous .json suffix).
 * - Read-only sequence: `/v1/accounts/list.json` -> extracts real `accountIdKey` -> `/v1/accounts/{accountIdKey}/portfolio.json`.
 * - Sandbox URL Guard Aspect: aborts if live URL is targeted while running in TEST mode.
 */

import type {
  Env,
  ETradeQuote,
  ETradeAccount,
  ETradePosition,
  ETradeOrderExecutionResult,
  ETradeTransaction,
  ETradeTransactionDetails,
  ETradeAlert,
  ETradeAlertDetails,
  ETradeProductLookup,
  ETradeOptionChain,
  ETradeOptionExpireDate,
  ETradeRemoteOrder,
  ETradeCancelOrderResult,
  ETradePositionLot,
  ETradeWatchlist,
} from "../../types";
import { resolveEnvironmentConfig } from "../../config/environment";
import { getClientConfig, type EtapiClientConfig } from "../../config/etapiConfig";
import { generateOAuth1Header } from "../../services/cryptoUtils";
import { getValidTokens, revokeStoredTokens, revokeRemoteAccessToken, type ETradeTokenIdentity } from "../../security/etradeOAuth";
import { propagateBrokerTokenRejection } from "../../security/brokerTokenRejection";
import { assertSandboxUrlSafety } from "../../aspects/loggingAspect";
import { ETradeError, ETradeErrorCode } from "../../aspects/errorCodes";
import { AGENT_DIDS, getUserDid } from "../../agents/did";
import { RemoteMcpClient } from "../../mcps/client/mcpClient";
import { etradeOrderKind, etradePriceType, toETradeInstruments, validateTradingOrderLegs } from "./optionOrders";
import type { OptionRequestBudget, TradingOrderLeg } from "../interfaces";

function fetchOptionRequest(
  requestUrl: string,
  init: RequestInit,
  requestBudget?: OptionRequestBudget
): Promise<Response> {
  if (requestBudget && !requestBudget.tryConsume()) {
    throw new Error("Subrequest budget exhausted before E*TRADE option fetch.");
  }
  return fetch(requestUrl, init);
}
export type ETradeMarketMoverCategory = "gainers" | "losers" | "active";

function firstQuoteData(data: any): any {
  const quoteData = data?.QuoteResponse?.QuoteData;
  if (Array.isArray(quoteData)) return quoteData[0];
  // E*TRADE's single-symbol responses can serialize QuoteData as an object
  // while multi-symbol responses use an array.
  return quoteData && typeof quoteData === "object" ? quoteData : undefined;
}

/**
 * Issue #462: per-call quote outcome. The error is captured inside the
 * call that produced it — never read back from shared instance state — so
 * concurrent quote fetches on one client cannot overwrite each other's
 * failures. Scoping: the client instance is user-bound (constructed per
 * ETradeService for one userLogin); this result is call-scoped.
 */
/**
 * Issue #2441: the latest upstream token rejection recorded by this
 * client, if any. Set when a 401 (or a token_rejected 403) propagates;
 * the dropped flag says whether the dead token was actually removed
 * from the store. It is the machine-readable half of the reconnect
 * signal; the human-readable half is the appended sentence in
 * lastError. It records the latest rejection only — a later success
 * does not erase the fact that a token was dropped and a reconnect is
 * owed until a new token is stored.
 */
export interface ETradeTokenRejection {
  endpoint: string;
  dropped: boolean;
  at: number;
}

export interface ETradeQuoteResult {
  quote: ETradeQuote | null;
  error: string | null;
}

export class ETradeRestClient {
  /** Marks that option methods charge the supplied limiter per actual fetch attempt. */
  readonly supportsOptionRequestBudget = true;

  // Issue #155/#168: lastError is the failure signal for read calls.
  // Read methods clear it on entry, set it on EVERY failure return
  // (missing credentials/params, HTTP error, exception, payload-less
  // 200), and leave it unset after success or a genuine empty — so an
  // empty result WITH lastError set means "upstream failure" and an
  // empty result without one means "genuinely nothing there".
  public lastError?: string;

  /**
   * Issue #2573: structured kind of the recorded `lastError`, set at
   * the point of failure — never derived by string-matching the raw
   * error text. `generateOAuthHeader` sets `token_missing` when no
   * token could be resolved; `handleUpstreamAuthError` sets
   * `token_expired` for a 401/403 upstream rejection. Any other
   * recorded failure leaves it undefined, and the route layer then
   * uses its per-section catalog code. This is what lets the broker
   * routes answer with a coded business message while `lastError`
   * itself (raw upstream body included) stays a log-only diagnostic.
   */
  public lastErrorKind?: "token_missing" | "token_expired";

  // Issue #2441: the latest upstream token rejection, if any (see
  // ETradeTokenRejection). Read via getTokenRejection().
  public tokenRejection?: ETradeTokenRejection;

  // Issue #2441: identity pass-through, consistent with the panel seam
  // (#2386). When a caller knows the session's internalUserId (verified
  // session, or the alias record for a login the route already trusts),
  // the client reads the same token the panel sees — including tokens
  // stored only under an internal-id key. Optional so every existing
  // construction keeps today's login-only behavior; unknown logins
  // still resolve to nothing and fail closed.
  constructor(public env: Env, public userLogin: string, public overrideEnv?: string, public identity?: ETradeTokenIdentity) {
    // Issue #1185: the client keys stored tokens by login — required.
    if (!userLogin) {
      throw new Error("ETradeRestClient requires an explicit userLogin (issue #1185: no default identity).");
    }
  }

  private async handleUpstreamAuthError(status: number, endpoint: string, errorBody: string): Promise<void> {
    if (status === 401 || status === 403) {
      const envConfig = this.getEnvConfig();
      // Issue #2573: structured kind for the route layer; the raw
      // body above stays a log-only diagnostic, never a UI message.
      this.lastErrorKind = "token_expired";
      this.lastError = `E*TRADE Session Expired [HTTP ${status}]: Token rejected on ${endpoint} [${envConfig.name}]. Error: ${errorBody.slice(0, 200) || "Unauthorized"}`;
      console.warn(`[ETradeClient] Token rejected HTTP ${status} on ${endpoint}: ${errorBody}`);
      // Issue #2441: a rejection is a fact about token state, so it
      // propagates to the store that serves tokens — but only when the
      // rejection means the token is dead: every 401, or a 403
      // carrying the token_rejected marker. Any other 403 (for
      // example an endpoint permission denial) keeps exactly the
      // previous record-only behavior and never drops a live token.
      // Renewal-then-retry is deliberately NOT attempted here:
      // renewal presents the stored pair to /oauth/renew_access_token,
      // so a pair E*TRADE already rejected cannot renew itself — the
      // correct action is drop + reconnect signal, never a retry loop.
      const deadToken = status === 401 || errorBody.includes("token_rejected");
      if (!deadToken) return;
      const result = await propagateBrokerTokenRejection({
        broker: "etrade",
        env: this.env,
        userLogin: this.userLogin,
        overrideEnv: this.overrideEnv,
        identity: this.identity,
      });
      this.tokenRejection = { endpoint, dropped: result.dropped, at: Date.now() };
      if (result.dropped) {
        this.lastError += " The rejected token was dropped. Please reconnect E*TRADE.";
      }
    }
  }

  public getLastError(): string | undefined {
    return this.lastError;
  }

  /** Issue #2573: structured kind of the recorded `lastError`, if any. */
  public getLastErrorKind(): "token_missing" | "token_expired" | undefined {
    return this.lastErrorKind;
  }

  public getTokenRejection(): ETradeTokenRejection | null {
    return this.tokenRejection ?? null;
  }

  public getEnvConfig() {
    return resolveEnvironmentConfig(this.env, this.overrideEnv);
  }

  public getClientConfig(): EtapiClientConfig {
    return getClientConfig(this.env, this.overrideEnv);
  }

  private async generateOAuthHeader(method: string, url: string, extraParams?: Record<string, string>): Promise<string> {
    const envConfig = this.getEnvConfig();
    const consumerKey = envConfig.etrade.apiKey || "";
    const consumerSecret = envConfig.etrade.apiSecret || "";
    let token = "";
    let tokenSecret = "";

    if (this.userLogin) {
      try {
        const stored = await getValidTokens(this.env, this.userLogin, this.overrideEnv, this.identity);
        if (stored) {
          token = stored.accessToken;
          tokenSecret = stored.accessTokenSecret;
        }
      } catch {
        // Ignore token-store error
      }
    }

    if (!token || !tokenSecret) {
      // Issue #2573: structured kind for the route layer. The
      // `getValidTokens` result does not distinguish "no stored
      // session" from "stored session expired at midnight ET" (both
      // return null), so the route layer deliberately uses
      // FAILURE_AUTH_TOKEN_MISSING for both — never
      // FAILURE_AUTH_NO_SESSION, whose distinction is not known here.
      this.lastErrorKind = "token_missing";
      this.lastError = `E*TRADE OAuth Token Missing: No active session for user in [${envConfig.name}] mode. Please click 'Connect E*TRADE Account'.`;
    } else {
      this.lastErrorKind = undefined;
    }

    return generateOAuth1Header({
      method,
      url,
      consumerKey,
      consumerSecret,
      token,
      tokenSecret,
      extraParams,
    });
  }

  /**
   * Fetches real live quote from E*TRADE.
   *
   * Thin wrapper over fetchQuoteDetailed, kept for sequential callers that
   * read getLastError(). Concurrent callers must use fetchQuoteDetailed so
   * each call's failure is captured with its own result (issue #462).
   */
  async fetchQuote(symbol: string): Promise<ETradeQuote | null> {
    const { quote, error } = await this.fetchQuoteDetailed(symbol);
    this.lastError = error ?? undefined;
    return quote;
  }

  /**
   * Fetches real live quote from E*TRADE with per-call error capture.
   *
   * Issue #462: quote errors used to travel via the shared mutable
   * `lastError` field. One client instance serves a whole screener run
   * while quotes fetch concurrently, so concurrent calls overwrote and
   * cleared each other's errors — the screener report could not name why
   * symbols failed (everything landed in "other"). The error is now a
   * local of this call; nothing crosses calls, so user, session and run
   * scoping stay intact under concurrency.
   *
   * Issue #1133: `options.includeRawResponse` mirrors getOptionChains'
   * hook of the same name — when set, the returned quote carries the
   * parsed wire payload (the res.json() object normalization consumed)
   * as `raw` (ETradeQuote.raw). When unset — every existing caller —
   * the result is exactly as before: no `raw` field is attached.
   */
  async fetchQuoteDetailed(symbol: string, options?: { includeRawResponse?: boolean }): Promise<ETradeQuoteResult> {
    const sym = symbol.toUpperCase().trim();
    const fail = (error: string): ETradeQuoteResult => ({ quote: null, error });
    const envConfig = this.getEnvConfig();

    if (!sym) {
      return fail("E*TRADE quote request is missing a symbol.");
    }
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      return fail("E*TRADE consumer credentials are not configured for live quote requests.");
    }

    let token = "";
    let tokenSecret = "";
    if (this.userLogin) {
      try {
        const stored = await getValidTokens(this.env, this.userLogin, this.overrideEnv, this.identity);
        if (stored) {
          token = stored.accessToken;
          tokenSecret = stored.accessTokenSecret;
        }
      } catch {
        // Ignore token-store error
      }
    }

    if (!token || !tokenSecret) {
      // Unauthenticated: cannot call authenticated 3-legged E*TRADE quote endpoint
      return fail(`E*TRADE OAuth access token is missing for ${sym} in ${envConfig.name} mode.`);
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/market/quote/${encodeURIComponent(sym)}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/market/quote/${encodeURIComponent(sym)}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        const error = `E*TRADE Quote API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        console.warn(`[ETradeClient] fetchQuote HTTP ${res.status}: ${errorText}`);
        await this.handleUpstreamAuthError(res.status, "quote", errorText);
        return fail(error);
      }

      let data = (await res.json().catch(() => null)) as any;
      let quoteItem = firstQuoteData(data);
      let quoteData = quoteItem?.All || quoteItem?.Product;

      // Some E*TRADE gateways return HTTP 200 for the extensionless form but
      // omit the JSON quote payload. Retry the documented JSON representation
      // before classifying a valid ticker as non-quotable.
      if (!quoteData && url === primaryUrl) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: { Authorization: authHeader, Accept: "application/json" },
        });
        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          const error = `E*TRADE Quote API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
          await this.handleUpstreamAuthError(res.status, "quote", errorText);
          return fail(error);
        }
        if (res.ok) {
          data = (await res.json().catch(() => null)) as any;
          quoteItem = firstQuoteData(data);
          quoteData = quoteItem?.All || quoteItem?.Product;
        }
      }
      if (!quoteData) {
        const messages = data?.QuoteResponse?.Messages?.Message;
        const detail = Array.isArray(messages)
          ? messages.map((message: any) => String(message?.description || message?.message || message?.code || "")).filter(Boolean).join("; ")
          : "";
        return fail(`E*TRADE returned no quote data for ${sym}${detail ? `: ${detail}` : " (HTTP 200 empty response)"}`);
      }

      const returnedSym = String(quoteItem?.Product?.symbol || quoteData?.symbol || "").toUpperCase().trim();
      const rawCompanyName = String(quoteData?.companyName || "").trim();
      // Issue #808: present E*TRADE data as-is. Do not reject quotes with zero/negative
      // prices — at 1am the market is closed and live fields are zero. The caller
      // decides how to handle zero prices, not the quote fetcher.
      const price = Number(quoteData.lastTrade || quoteData.price || quoteData.close || quoteData.previousClose || quoteData.bid || 0);

      // Detect and reject E*TRADE Sandbox's mock stub (which statically returns GOOG / GOOGLE INC CL A / 577.51 for any ticker)
      const isGoogleStub =
        price === 577.51 ||
        returnedSym === "GOOG" ||
        returnedSym === "GOOGL" ||
        rawCompanyName.toUpperCase().includes("GOOGLE INC");

      if (isGoogleStub && sym !== "GOOG" && sym !== "GOOGL") {
        // Reject sandbox dummy Google mock response for non-Google equities
        return fail(`E*TRADE returned a mismatched sandbox quote for ${sym} (GOOG mock).`);
      }

      if (!envConfig.isLive && price === 577.51) {
        // Discard 2014 legacy static sandbox price
        return fail(`E*TRADE discarded the legacy static sandbox price for ${sym}.`);
      }

      if (returnedSym && returnedSym !== sym) {
        // Symbol mismatch: E*TRADE returned a different symbol than requested
        return fail(`E*TRADE quote symbol mismatch: requested ${sym}, received ${returnedSym}.`);
      }

      const quoteStatus = String(quoteItem?.quoteStatus || quoteData?.quoteStatus || (envConfig.isLive ? "REALTIME" : "DELAYED"));
      const dateTime = String(quoteItem?.dateTime || quoteData?.dateTime || new Date().toISOString());

      let companyName = rawCompanyName;
      if (!companyName || (companyName.toUpperCase().includes("GOOGLE INC") && sym !== "GOOG" && sym !== "GOOGL")) {
        companyName = `${sym} Inc.`;
      }

      const quote: ETradeQuote = {
        symbol: sym,
        companyName,
        lastPrice: price,
        price,
        change: Number(quoteData.changeClose || (price && quoteData.previousClose ? price - Number(quoteData.previousClose) : 0)),
        changePercent: Number(quoteData.changeClosePercentage || 0),
        bid: Number(quoteData.bid || price),
        ask: Number(quoteData.ask || price),
        volume: Number(quoteData.totalVolume || 0),
        averageVolume: Number(quoteData.averageVolume || quoteData.averageDailyVolume || 0) || undefined,
        sector: String(quoteData.sector || "").trim() || undefined,
        open: Number(quoteData.open || price),
        high: Number(quoteData.high || price),
        low: Number(quoteData.low || price),
        peRatio: Number(quoteData.pe || 0),
        marketCap: Number(quoteData.marketCap || 0) / 1e9,
        week52High: Number(quoteData.high52 || 0),
        week52Low: Number(quoteData.low52 || 0),
        high52: Number(quoteData.high52 || 0),
        low52: Number(quoteData.low52 || 0),
        quoteStatus,
        dateTime,
        source: `E*TRADE REST API [${envConfig.name} / ${envConfig.label}]`,
        timestamp: dateTime,
        // Issue #1133: the opt-in raw hook — `data` here is the parsed
        // wire payload normalization consumed (post any .json retry).
        ...(options?.includeRawResponse ? { raw: data } : {}),
      };
      return { quote, error: null };
    } catch (err) {
      if (err instanceof ETradeError) throw err;
      // Surface the thrown failure as this call's error instead of a bare
      // null — the old path swallowed it (and getLastError() stayed stale),
      // which also fed "other" in the screener's failure categorization.
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Fetches batch of quotes for multiple tickers in a single authenticated E*TRADE API request
   */
  async fetchQuotes(symbols: string[], options?: { overrideSymbolCount?: boolean; trace?: import("./quoteTrace").QuoteTrace; onWireResponse?: (symbols: string[], payload: unknown) => void }): Promise<ETradeQuote[]> {
    this.lastError = undefined;
    if (!symbols.length) return [];
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for live quote requests.";
      return [];
    }
    // Issue #812: structured trace for observability.
    const { QuoteTrace } = await import("./quoteTrace");
    const trace = options?.trace || new QuoteTrace();
    trace.setNasdaqSymbols(symbols);

    let token = "";
    let tokenSecret = "";
    if (this.userLogin) {
      try {
        const stored = await getValidTokens(this.env, this.userLogin, this.overrideEnv, this.identity);
        if (stored) {
          token = stored.accessToken;
          tokenSecret = stored.accessTokenSecret;
        }
      } catch {
        // Ignore token-store error
      }
    }

    if (!token || !tokenSecret) {
      this.lastError = "E*TRADE OAuth access token is missing for live quote requests.";
      return [];
    }

    const cleanSyms = symbols.map((s) => s.toUpperCase().trim()).filter(Boolean);
    if (!cleanSyms.length) return [];

    const uniqueSyms = Array.from(new Set(cleanSyms));
    // Issue #802: batch size 10, sequential. A 50-symbol batch that fails
    // kills 50 symbols; a 10-symbol batch that fails kills 10.
    const batchSize = 10;
    const batches: string[][] = [];
    for (let i = 0; i < uniqueSyms.length; i += batchSize) {
      batches.push(uniqueSyms.slice(i, i + batchSize));
    }

    let batchFailed = false;
    const fetchBatch = async (batchSyms: string[]): Promise<ETradeQuote[]> => {
      const qs = batchSyms.length > 25 || options?.overrideSymbolCount ? "?overrideSymbolCount=true" : "";
      const symList = batchSyms.map((s) => encodeURIComponent(s)).join(",");
      const primaryUrl = `${envConfig.etrade.baseUrl}/market/quote/${symList}${qs}`;
      const fallbackUrl = `${envConfig.etrade.baseUrl}/market/quote/${symList}.json${qs}`;

      let url = primaryUrl;
      assertSandboxUrlSafety(url, envConfig.isLive);
      let authHeader = await this.generateOAuthHeader("GET", url);

      try {
        let res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });

        if (!res.ok && (res.status === 404 || res.status === 400)) {
          url = fallbackUrl;
          assertSandboxUrlSafety(url, envConfig.isLive);
          authHeader = await this.generateOAuthHeader("GET", url);
          res = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: authHeader,
              Accept: "application/json",
            },
          });
        }

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          await this.handleUpstreamAuthError(res.status, "market/quote", errorText);
          batchFailed = true;
          this.lastError = `E*TRADE quote request failed [HTTP ${res.status}]: ${errorText.slice(0, 160) || res.statusText}`;
          return [];
        }

        const data = (await res.json().catch(() => ({}))) as any;
        // Issue #1157 (E2): opt-in wire hook — the parsed sub-batch
        // payload, handed to the caller BEFORE normalization below
        // discards everything but the mapped quote fields. The data-
        // provider platform's batch capture (adapters.ts) records one
        // capture per sub-batch from this. Not supplied (every existing
        // caller), nothing changes; a throwing hook never breaks the
        // fetch (capture must never fail the retrieval it observes).
        if (options?.onWireResponse) {
          try {
            options.onWireResponse(batchSyms, data);
          } catch (hookErr) {
            console.warn("[ETradeClient] fetchQuotes onWireResponse hook failed:", hookErr);
          }
        }
        const rawQuoteData = data?.QuoteResponse?.QuoteData;
        if (rawQuoteData == null) {
          batchFailed = true;
          this.lastError = "E*TRADE Quote API returned an unexpected empty response.";
          return [];
        }
        const rawList = Array.isArray(rawQuoteData) ? rawQuoteData : [rawQuoteData];
        if (rawList.length === 0) return [];

        return rawList
          .map((item: any) => {
            const qd = item?.All || item?.Product;
            const sym = String(item?.Product?.symbol || qd?.symbol || "").toUpperCase().trim();
            const price = Number(qd?.lastTrade || qd?.price || qd?.close || qd?.previousClose || qd?.bid || 0);
            const rawCompany = String(qd?.companyName || "").trim();
            let companyName = rawCompany;
            if (!companyName || (companyName.toUpperCase().includes("GOOGLE INC") && sym !== "GOOG" && sym !== "GOOGL")) {
              companyName = `${sym} Inc.`;
            }
            const quoteStatus = String(item?.quoteStatus || qd?.quoteStatus || (envConfig.isLive ? "REALTIME" : "DELAYED"));
            const dateTime = String(item?.dateTime || qd?.dateTime || new Date().toISOString());

            return {
              symbol: sym,
              companyName,
              lastPrice: price,
              price,
              change: Number(qd?.changeClose || (price && qd?.previousClose ? price - Number(qd.previousClose) : 0)),
              changePercent: Number(qd?.changeClosePercentage || 0),
              bid: Number(qd?.bid || price),
              ask: Number(qd?.ask || price),
              volume: Number(qd?.totalVolume || 0),
              averageVolume: Number(qd?.averageVolume || qd?.averageDailyVolume || 0) || undefined,
              sector: String(qd?.sector || "").trim() || undefined,
              open: Number(qd?.open || price),
              high: Number(qd?.high || price),
              low: Number(qd?.low || price),
              peRatio: Number(qd?.pe || 0),
              marketCap: Number(qd?.marketCap || 0) / 1e9,
              week52High: Number(qd?.high52 || 0),
              week52Low: Number(qd?.low52 || 0),
              high52: Number(qd?.high52 || 0),
              low52: Number(qd?.low52 || 0),
              quoteStatus,
              dateTime,
              source: `E*TRADE REST API [${envConfig.name} / ${envConfig.label}]`,
              timestamp: dateTime,
            };
          })
          .filter((q: ETradeQuote) => {
            // Issue #808: do not filter on price. Present data as-is; the caller
            // decides how to handle zero prices (e.g. market closed at 1am).
            if (!q.symbol) return false;
            if (!batchSyms.includes(q.symbol)) return false;
            if ((q.companyName.toUpperCase().includes("GOOGLE INC") || q.lastPrice === 577.51) && q.symbol !== "GOOG" && q.symbol !== "GOOGL") {
              return false;
            }
            if (!envConfig.isLive && q.lastPrice === 577.51) {
              return false;
            }
            return true;
          });
      } catch (err) {
        batchFailed = true;
        if (!this.lastError) {
          this.lastError = `E*TRADE quote request failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        return [];
      }
    };

    const results: ETradeQuote[][] = [];
    // Issue #802: sequential loop, not Promise.all. 10 requests in flight
    // at once risks E*TRADE rate limiting; sequential with a small gap is safer.
    // Issue #812: trace each batch.
    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi];
      const handle = trace.startBatch(bi, batches.length, b);
      try {
        const batchQuotes = await fetchBatch(b);
        handle.addQuotes(batchQuotes.length);
        // Track which symbols didn't get quotes.
        const receivedSyms = new Set(batchQuotes.map((q) => q.symbol));
        for (const s of b) {
          if (!receivedSyms.has(s)) {
            const { category, detail } = QuoteTrace.categorizeError(
              this.lastError || "No quote returned for symbol"
            );
            handle.addFailure(s, category, detail);
          }
        }
        results.push(batchQuotes);
      } catch (err) {
        // Issue #812: never swallow — capture with context.
        const { category, detail } = QuoteTrace.categorizeError(err);
        handle.setError(detail);
        for (const s of b) handle.addFailure(s, category, detail);
        results.push([]);
        console.error(JSON.stringify({
          traceId: trace.traceId,
          component: "quote-pipeline",
          event: "batch_exception",
          batchIndex: bi,
          symbols: b,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
          timestamp: new Date().toISOString(),
        }));
      } finally {
        handle.complete();
      }
      // 100ms gap between batches to stay under rate limits.
      if (bi < batches.length - 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const quotes = results.flat();

    // Retry missing symbols in smaller chunks. A batch can fail entirely
    // (HTTP error, timeout, rate limit) while others succeed — without this,
    // one dead batch of 50 sinks half the universe. Smaller chunks are less
    // likely to trip E*TRADE's per-request limits, and a short delay between
    // retries keeps us under the rate ceiling.
    const quoted = new Set(quotes.map((q) => q.symbol));
    const missing = uniqueSyms.filter((s) => !quoted.has(s));
    if (missing.length > 0) {
      const retryBatchSize = 10;
      const retryDelayMs = 500;
      for (let i = 0; i < missing.length; i += retryBatchSize) {
        if (i > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
        const chunk = missing.slice(i, i + retryBatchSize);
        const retried = await fetchBatch(chunk);
        for (const q of retried) {
          if (!quoted.has(q.symbol)) {
            quoted.add(q.symbol);
            quotes.push(q);
          }
        }
      }
    }

    if (!batchFailed) this.lastError = undefined;
    // Issue #812: log the complete trace.
    trace.complete();
    return quotes;
  }

  async getMarketMovers(category: ETradeMarketMoverCategory): Promise<string[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for market-mover discovery.";
      return [];
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/market/movers/${category}`;
    const fallbackUrl = `${primaryUrl}.json`;
    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" },
      });
      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: { Authorization: authHeader, Accept: "application/json" },
        });
      }
      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        await this.handleUpstreamAuthError(res.status, `market/movers/${category}`, errorText);
        this.lastError = `E*TRADE market-movers request failed [HTTP ${res.status}]: ${errorText.slice(0, 160) || res.statusText}`;
        return [];
      }

      const data = (await res.json().catch(() => ({}))) as any;
      let movers = data?.MarketMoversResponse?.MarketMover || data?.MarketMoversResponse?.Mover || data?.MarketMover;
      if (!movers) {
        if (!data?.MarketMoversResponse && !data?.MarketMover) {
          this.lastError = "E*TRADE market-movers request returned an unexpected empty response.";
        }
        return [];
      }
      if (!Array.isArray(movers)) movers = [movers];
      return Array.from(new Set(movers
        .map((mover: any) => String(mover?.Product?.symbol || mover?.symbol || "").toUpperCase().trim())
        .filter((symbol: string) => /^[A-Z0-9.\/-]+$/.test(symbol))));
    } catch (err) {
      this.lastError = `E*TRADE market-movers request failed: ${err instanceof Error ? err.message : String(err)}`;
      return [];
    }
  }

  /**
   * Orders API: Preview Order
   * POST /v1/accounts/{accountIdKey}/orders/preview
   */
  async previewOrder(
    accountKey: string | undefined,
    params: {
      orderId: string;
      symbol: string;
      action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
      quantity: number;
      orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
      limitPrice?: number;
      stopPrice?: number;
      orderTerm?: "GOOD_FOR_DAY" | "GOOD_UNTIL_CANCEL" | "IMMEDIATE_OR_CANCEL";
      optionLegs?: TradingOrderLeg[];
      strategyNetDebit?: number;
    }
  ): Promise<{ previewId: string; estimatedTotal?: number; estimatedCommission?: number; message?: string } | null> {
    const envConfig = this.getEnvConfig();
    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) {
      key = "";
    }
    if (!key) {
      const accounts = await this.fetchAccounts();
      key = accounts[0]?.accountIdKey || accounts[0]?.accountKey || accounts[0]?.accountId || "";
    }
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret || !key) {
      this.lastError = !key
        ? "No active E*TRADE account key found. Please connect your brokerage account."
        : "E*TRADE API key or secret not configured.";
      return null;
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/preview`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/preview.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("POST", url);

    const clientOrderId = (params.orderId.replace(/[^a-zA-Z0-9]/g, "") || `ord${Date.now()}`).slice(0, 20);
    const priceType = (params.orderType || "MARKET").toUpperCase();
    const isLimit = priceType === "LIMIT" || priceType === "STOP_LIMIT";
    const limitPrice = isLimit && params.limitPrice && params.limitPrice > 0 ? Number(params.limitPrice.toFixed(2)) : undefined;
    const isStop = priceType === "STOP" || priceType === "STOP_LIMIT";
    const stopPrice = isStop && params.stopPrice && params.stopPrice > 0 ? Number(params.stopPrice.toFixed(2)) : undefined;

    const legs = params.optionLegs || [];
    const legsError = validateTradingOrderLegs(legs, params.symbol);
    if (legsError) {
      this.lastError = legsError;
      return null;
    }
    const isStrategy = legs.length > 0;
    const orderKind = isStrategy ? etradeOrderKind(legs) : "EQ";
    const body = {
      PreviewOrderRequest: {
        orderType: orderKind,
        clientOrderId,
        Order: [
          {
            allOrNone: false,
            priceType: isStrategy ? etradePriceType(legs, priceType, params.strategyNetDebit || 0) : priceType,
            ...(limitPrice !== undefined ? { limitPrice } : {}),
            ...(stopPrice !== undefined ? { stopPrice } : {}),
            orderTerm: params.orderTerm || "GOOD_FOR_DAY",
            marketSession: "REGULAR",
            Instrument: isStrategy ? toETradeInstruments(legs) : [
              {
                Product: {
                  securityType: "EQ",
                  symbol: params.symbol.toUpperCase().trim(),
                },
                orderAction: params.action,
                quantityType: "QUANTITY",
                quantity: params.quantity,
              },
            ],
          },
        ],
      },
    };

    try {
      let res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok && res.status === 404 && !url.includes(".json")) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("POST", url);
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      }

      const rawText = await res.text().catch(() => "");
      let data: any = {};
      try {
        data = JSON.parse(rawText);
      } catch {
        const pIdMatch = rawText.match(/<previewId[^>]*>\s*([^<\s]+)\s*<\/previewId>/i) ||
          rawText.match(/&lt;previewId[^&]*&gt;\s*([^&<\s]+)\s*&lt;\/previewId&gt;/i);
        const estTotalMatch = rawText.match(/<estimatedTotalAmount[^>]*>\s*([^<\s]+)\s*<\/estimatedTotalAmount>/i);
        const estCommMatch = rawText.match(/<estimatedCommission[^>]*>\s*([^<\s]+)\s*<\/estimatedCommission>/i);
        const msgMatch = rawText.match(/<description[^>]*>([^<]+)<\/description>/i) ||
          rawText.match(/<message[^>]*>([^<]+)<\/message>/i) ||
          rawText.match(/<error[^>]*>([^<]+)<\/error>/i);

        data = {
          PreviewOrderResponse: {
            PreviewIds: pIdMatch ? [{ previewId: pIdMatch[1] }] : undefined,
            Order: [{
              estimatedTotalAmount: estTotalMatch ? Number(estTotalMatch[1]) : undefined,
              estimatedCommission: estCommMatch ? Number(estCommMatch[1]) : undefined,
            }],
            messageList: msgMatch ? { Message: [{ description: msgMatch[1] }] } : undefined,
          },
          Error: msgMatch ? { message: msgMatch[1] } : undefined,
        };
      }

      if (!res.ok) {
        let errDesc = "";
        if (data?.Error?.message) {
          errDesc = data.Error.message;
        } else if (data?.PreviewOrderResponse?.messageList?.Message?.[0]?.description) {
          errDesc = data.PreviewOrderResponse.messageList.Message[0].description;
        } else {
          const xmlMsg = rawText.match(/<message[^>]*>([^<]+)<\/message>/i) || rawText.match(/<description[^>]*>([^<]+)<\/description>/i);
          if (xmlMsg) errDesc = xmlMsg[1];
        }
        const finalMsg = errDesc || rawText.slice(0, 200) || res.statusText;
        this.lastError = `E*TRADE Preview Order API Error [HTTP ${res.status}]: ${finalMsg}`;
        await this.handleUpstreamAuthError(res.status, "previewOrder", rawText);
        return null;
      }

      let rawPreviewId: any = data?.PreviewOrderResponse?.PreviewIds ??
        data?.PreviewOrderResponse?.PreviewId ??
        data?.PreviewOrderResponse?.previewIds ??
        data?.PreviewOrderResponse?.previewId ??
        data?.previewOrderResponse?.PreviewIds ??
        data?.previewOrderResponse?.previewIds ??
        data?.previewOrderResponse?.previewId ??
        data?.previewId ??
        data?.PreviewId;

      let previewIdVal: string | number | undefined;
      if (Array.isArray(rawPreviewId)) {
        if (rawPreviewId[0]?.previewId !== undefined) {
          previewIdVal = rawPreviewId[0].previewId;
        } else if (rawPreviewId[0] !== undefined) {
          previewIdVal = rawPreviewId[0];
        }
      } else if (rawPreviewId?.previewId !== undefined) {
        previewIdVal = rawPreviewId.previewId;
      } else if (typeof rawPreviewId === "string" || typeof rawPreviewId === "number") {
        previewIdVal = rawPreviewId;
      } else if (data?.PreviewOrderResponse?.Order?.[0]?.previewId) {
        previewIdVal = data.PreviewOrderResponse.Order[0].previewId;
      } else if (data?.PreviewOrderResponse?.Order?.[0]?.orderId) {
        previewIdVal = data.PreviewOrderResponse.Order[0].orderId;
      } else if (data?.PreviewOrderResponse?.orderId) {
        previewIdVal = data.PreviewOrderResponse.orderId;
      }

      if (!previewIdVal && rawText) {
        const regexMatch = rawText.match(/(?:<previewId[^>]*>|["'](?:previewId|PreviewId)["']\s*:\s*["']?)([0-9a-zA-Z_-]+)/i);
        if (regexMatch) {
          previewIdVal = regexMatch[1];
        }
      }

      const orderResp = Array.isArray(data?.PreviewOrderResponse?.Order)
        ? data?.PreviewOrderResponse?.Order?.[0]
        : data?.PreviewOrderResponse?.Order;

      const rawMsg = data?.PreviewOrderResponse?.messageList?.Message ||
        data?.PreviewOrderResponse?.messageList?.message ||
        data?.PreviewOrderResponse?.messageList?.messages ||
        data?.PreviewOrderResponse?.messages ||
        data?.PreviewOrderResponse?.message ||
        data?.messageList?.Message ||
        data?.messageList?.message;
      const message = Array.isArray(rawMsg)
        ? (rawMsg[0]?.description || rawMsg[0]?.message || rawMsg[0]?.text || String(rawMsg[0]))
        : (rawMsg?.description || rawMsg?.message || rawMsg?.text || (typeof rawMsg === "string" ? rawMsg : undefined));

      if (!previewIdVal) {
        const fallbackMsg = message ||
          data?.Error?.message ||
          "E*TRADE Preview Order succeeded with broker validation notices";
        this.lastError = fallbackMsg;
        if (orderResp?.estimatedTotalAmount !== undefined) {
          return {
            previewId: "",
            estimatedTotal: Number(orderResp.estimatedTotalAmount),
            estimatedCommission: orderResp?.estimatedCommission !== undefined ? Number(orderResp.estimatedCommission) : undefined,
            message: fallbackMsg,
          };
        }
        return null;
      }

      return {
        previewId: String(previewIdVal),
        estimatedTotal: orderResp?.estimatedTotalAmount !== undefined ? Number(orderResp.estimatedTotalAmount) : undefined,
        estimatedCommission: orderResp?.estimatedCommission !== undefined ? Number(orderResp.estimatedCommission) : undefined,
        message,
      };
    } catch (err: any) {
      console.warn("[ETradeClient] previewOrder error:", err);
      this.lastError = err.message || String(err);
      return null;
    }
  }

  /**
   * Places an equity order via E*TRADE REST API with OAuth 1.0a
   */
  async placeOrder(params: {
    orderId: string;
    symbol: string;
    action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
    quantity: number;
    orderType?: string;
    limitPrice?: number;
    previewId?: string;
    userLogin: string;
    optionLegs?: TradingOrderLeg[];
    strategyNetDebit?: number;
  }): Promise<ETradeOrderExecutionResult> {
    const userDid = params.userLogin.startsWith("did:") ? params.userLogin : getUserDid(params.userLogin);
    const now = new Date().toISOString();
    const envConfig = this.getEnvConfig();
    const accountKey = this.env.ETRADE_ACCOUNT_ID_KEY || "";
    const legs = params.optionLegs || [];
    const legsError = validateTradingOrderLegs(legs, params.symbol);
    if (legsError) {
      return {
        success: false, orderId: params.orderId, executionId: "", brokerOrderRef: "", authorizerDid: userDid,
        status: "failed", symbol: params.symbol, action: params.action, quantity: params.quantity, executionPrice: 0,
        totalSettled: 0, message: legsError, timestamp: now,
      };
    }
    const isStrategy = legs.length > 0;
    const orderKind = isStrategy ? etradeOrderKind(legs) : "EQ";

    // Strict HITL Gate: block autonomous agent execution without human authorization
    if (!userDid || userDid.startsWith("did:agent:")) {
      return {
        success: false,
        orderId: params.orderId,
        executionId: "",
        brokerOrderRef: "",
        authorizerDid: userDid || "did:user:unknown",
        status: "failed",
        symbol: params.symbol,
        action: params.action,
        quantity: params.quantity,
        executionPrice: 0,
        totalSettled: 0,
        didAttestation: {
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid: userDid || "did:user:unknown",
          signature: "",
        },
        message: "HITL Enforcement: Autonomous live order execution is blocked. Explicit human confirmation required.",
        timestamp: now,
      };
    }

    // 1. Remote MCP Tool Execution (if configured)
    if (this.env.ETRADE_MCP_SERVER_URL) {
      if (isStrategy) {
        return {
          success: false, orderId: params.orderId, executionId: "", brokerOrderRef: "", authorizerDid: userDid,
          status: "failed", symbol: params.symbol, action: params.action, quantity: params.quantity, executionPrice: 0,
          totalSettled: 0, message: "The configured E*TRADE MCP place_order tool accepts equity orders only; option strategies require the native E*TRADE complex-order API.", timestamp: now,
        };
      }
      try {
        const mcpRes = await RemoteMcpClient.callTool({
          serverUrl: this.env.ETRADE_MCP_SERVER_URL,
          toolName: "place_order",
          arguments: {
            symbol: params.symbol,
            action: params.action,
            quantity: params.quantity,
            orderType: params.orderType || "MARKET",
            limitPrice: params.limitPrice,
          },
        });
        if (mcpRes?.orderId || mcpRes?.executionId) {
          const execId = mcpRes.executionId || mcpRes.orderId;
          return {
            success: true,
            orderId: params.orderId,
            executionId: execId,
            brokerOrderRef: execId,
            authorizerDid: userDid,
            status: "executed",
            symbol: params.symbol,
            action: params.action,
            quantity: params.quantity,
            executionPrice: mcpRes.price || 0,
            totalSettled: mcpRes.total || 0,
            didAttestation: {
              proposerDid: AGENT_DIDS.TRADING,
              authorizerDid: userDid,
              signature: `sig_0x${crypto.randomUUID().slice(0, 16)}`,
            },
            message: `E*TRADE Execution Confirmed via Remote MCP Server: ${execId}`,
            timestamp: now,
          };
        }
      } catch (err: any) {
        return {
          success: false,
          orderId: params.orderId,
          executionId: "",
          brokerOrderRef: "",
          authorizerDid: userDid,
          status: "failed",
          symbol: params.symbol,
          action: params.action,
          quantity: params.quantity,
          executionPrice: 0,
          totalSettled: 0,
          didAttestation: {
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid: userDid,
            signature: "",
          },
          message: `E*TRADE MCP Order Placement Error: ${err.message || String(err)}`,
          timestamp: now,
        };
      }
    }

    // 2. Direct E*TRADE OAuth 1.0a REST API Execution
    if (envConfig.etrade.apiKey && envConfig.etrade.apiSecret) {
      try {
        let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
        if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) {
          key = "";
        }
        if (!key) {
          const accounts = await this.fetchAccounts();
          key = accounts[0]?.accountIdKey || accounts[0]?.accountKey || accounts[0]?.accountId || "";
        }

        if (!key) {
          const errMsg = this.lastError || "E*TRADE Account Not Connected: No active brokerage account found. Please connect your E*TRADE account in Settings before submitting trades.";
          return {
            success: false,
            orderId: params.orderId,
            executionId: "",
            brokerOrderRef: "",
            authorizerDid: userDid,
            status: "failed",
            symbol: params.symbol,
            action: params.action,
            quantity: params.quantity,
            executionPrice: 0,
            totalSettled: 0,
            didAttestation: {
              proposerDid: AGENT_DIDS.TRADING,
              authorizerDid: userDid,
              signature: "",
            },
            message: `E*TRADE Execution Blocked: ${errMsg}`,
            timestamp: now,
          };
        }

        const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/place`;
        const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/place.json`;
        let url = primaryUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        let authHeader = await this.generateOAuthHeader("POST", url);

        const clientOrderId = (params.orderId.replace(/[^a-zA-Z0-9]/g, "") || `ord${Date.now()}`).slice(0, 20);
        const priceType = (params.orderType || "MARKET").toUpperCase();
        const isLimit = priceType === "LIMIT" || priceType === "STOP_LIMIT";
        const limitPrice = isLimit && params.limitPrice && params.limitPrice > 0 ? Number(params.limitPrice.toFixed(2)) : undefined;

        const pId = params.previewId !== undefined && params.previewId !== null && String(params.previewId).trim() !== ""
          ? (!isNaN(Number(params.previewId)) ? Number(params.previewId) : String(params.previewId).trim())
          : undefined;

        const body = {
          PlaceOrderRequest: {
            orderType: orderKind,
            clientOrderId,
            ...(pId !== undefined ? { PreviewIds: [{ previewId: pId }] } : {}),
            Order: [
              {
                allOrNone: false,
                priceType: isStrategy ? etradePriceType(legs, priceType, params.strategyNetDebit || 0) : priceType,
                ...(limitPrice ? { limitPrice } : {}),
                orderTerm: "GOOD_FOR_DAY",
                marketSession: "REGULAR",
                Instrument: isStrategy ? toETradeInstruments(legs) : [
                  {
                    Product: {
                      securityType: "EQ",
                      symbol: params.symbol.toUpperCase().trim(),
                    },
                    orderAction: params.action,
                    quantityType: "QUANTITY",
                    quantity: params.quantity,
                  },
                ],
              },
            ],
          },
        };

        let res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok && res.status === 404 && !url.includes(".json")) {
          url = fallbackUrl;
          assertSandboxUrlSafety(url, envConfig.isLive);
          authHeader = await this.generateOAuthHeader("POST", url);
          res = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(body),
          });
        }

        const rawText = await res.text().catch(() => "");
        let data: any = {};
        try {
          data = JSON.parse(rawText);
        } catch {
          const orderIdMatch = rawText.match(/<orderId>\s*([^<\s]+)\s*<\/orderId>/i);
          if (orderIdMatch) {
            data = { PlaceOrderResponse: { OrderIds: [{ orderId: orderIdMatch[1] }] } };
          }
        }

        const orderIdVal = data?.PlaceOrderResponse?.OrderIds?.[0]?.orderId ||
          data?.PlaceOrderResponse?.OrderIds?.orderId ||
          data?.placeOrderResponse?.OrderIds?.[0]?.orderId ||
          data?.PlaceOrderResponse?.orderId;
        if (res.ok && orderIdVal) {
          const brokerId = `et_order_${orderIdVal}`;
          const executionPrice = limitPrice || params.limitPrice || 0;
          const optionContracts = legs.some((leg) => leg.securityType === "OPTN");
          const shareQuantity = legs.filter((leg) => leg.securityType === "EQ").reduce((total, leg) => total + leg.quantity, 0);
          const totalSettled = executionPrice > 0
            ? executionPrice * (optionContracts ? params.quantity * 100 : isStrategy ? shareQuantity : params.quantity)
            : 0;
          return {
            success: true,
            orderId: params.orderId,
            executionId: brokerId,
            brokerOrderRef: brokerId,
            authorizerDid: userDid,
            status: "executed",
            symbol: params.symbol,
            action: params.action,
            quantity: params.quantity,
            executionPrice,
            totalSettled,
            didAttestation: {
              proposerDid: AGENT_DIDS.TRADING,
              authorizerDid: userDid,
              signature: `sig_0x${crypto.randomUUID().slice(0, 16)}`,
            },
            message: `E*TRADE Execution Confirmed: Broker Order ID ${brokerId}`,
            timestamp: now,
          };
        }

        let parsedMsg = "";
        if (data?.Error?.message) {
          parsedMsg = data.Error.message;
        } else if (data?.PlaceOrderResponse?.messageList?.Message?.[0]?.description) {
          parsedMsg = data.PlaceOrderResponse.messageList.Message[0].description;
        } else {
          const xmlMsg = rawText.match(/<message>([^<]+)<\/message>/i) || rawText.match(/<description>([^<]+)<\/description>/i);
          if (xmlMsg) parsedMsg = xmlMsg[1];
        }

        let errMsg = parsedMsg || `HTTP ${res.status}: ${rawText.slice(0, 200) || res.statusText}`;

        // Auto-recovery: If E*TRADE rejects because preview session timed out or expired, re-preview with a fresh unique clientOrderId and retry once!
        if (
          errMsg.includes("timed out") ||
          errMsg.includes("timeout") ||
          errMsg.includes("resubmit it now") ||
          errMsg.includes("expired")
        ) {
          try {
            console.log("[ETradeClient] Upstream preview timed out; re-previewing with fresh unique clientOrderId...");
            // CRITICAL: E*TRADE requires a fresh clientOrderId for the new preview so it does not collide with the timed-out session
            const freshPreviewOrderId = `ord_pv_${crypto.randomUUID().slice(0, 8)}`;
            const refreshedPreview = await this.previewOrder(key, {
              orderId: freshPreviewOrderId,
              symbol: params.symbol,
              action: params.action,
              quantity: params.quantity,
              orderType: priceType as any,
              limitPrice,
              stopPrice: (params as any).stopPrice,
              orderTerm: "GOOD_FOR_DAY",
            });

            if (refreshedPreview?.previewId) {
              const retryPreviewId = !isNaN(Number(refreshedPreview.previewId)) ? Number(refreshedPreview.previewId) : refreshedPreview.previewId;
              // CRITICAL: PlaceOrderRequest must also use a unique clientOrderId
              const freshPlaceClientOrderId = `ord${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 20);
              const retryBody = {
                PlaceOrderRequest: {
                  orderType: "EQ",
                  clientOrderId: freshPlaceClientOrderId,
                  PreviewIds: [{ previewId: retryPreviewId }],
                  Order: [
                    {
                      allOrNone: false,
                      priceType,
                      ...(limitPrice ? { limitPrice } : {}),
                      orderTerm: "GOOD_FOR_DAY",
                      marketSession: "REGULAR",
                      Instrument: [
                        {
                          Product: {
                            securityType: "EQ",
                            symbol: params.symbol.toUpperCase().trim(),
                          },
                          orderAction: params.action,
                          quantityType: "QUANTITY",
                          quantity: params.quantity,
                        },
                      ],
                    },
                  ],
                },
              };
              let retryUrl = primaryUrl;
              let retryAuthHeader = await this.generateOAuthHeader("POST", retryUrl);
              let retryRes = await fetch(retryUrl, {
                method: "POST",
                headers: {
                  Authorization: retryAuthHeader,
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                body: JSON.stringify(retryBody),
              });
              if (!retryRes.ok && retryRes.status === 404 && !retryUrl.includes(".json")) {
                retryUrl = fallbackUrl;
                assertSandboxUrlSafety(retryUrl, envConfig.isLive);
                retryAuthHeader = await this.generateOAuthHeader("POST", retryUrl);
                retryRes = await fetch(retryUrl, {
                  method: "POST",
                  headers: {
                    Authorization: retryAuthHeader,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                  },
                  body: JSON.stringify(retryBody),
                });
              }
              const retryRawText = await retryRes.text().catch(() => "");
              let retryData: any = {};
              try {
                retryData = JSON.parse(retryRawText);
              } catch {
                const orderIdMatch = retryRawText.match(/<orderId>\s*([^<\s]+)\s*<\/orderId>/i);
                if (orderIdMatch) {
                  retryData = { PlaceOrderResponse: { OrderIds: [{ orderId: orderIdMatch[1] }] } };
                }
              }
              const retryOrderIdVal = retryData?.PlaceOrderResponse?.OrderIds?.[0]?.orderId ||
                retryData?.PlaceOrderResponse?.OrderIds?.orderId ||
                retryData?.placeOrderResponse?.OrderIds?.[0]?.orderId ||
                retryData?.PlaceOrderResponse?.orderId;
              if (retryRes.ok && retryOrderIdVal) {
                const brokerId = `et_order_${retryOrderIdVal}`;
                const executionPrice = limitPrice || params.limitPrice || 0;
                const totalSettled = executionPrice > 0 ? executionPrice * params.quantity : 0;
                return {
                  success: true,
                  orderId: params.orderId,
                  executionId: brokerId,
                  brokerOrderRef: brokerId,
                  authorizerDid: userDid,
                  status: "executed",
                  symbol: params.symbol,
                  action: params.action,
                  quantity: params.quantity,
                  executionPrice,
                  totalSettled,
                  didAttestation: {
                    proposerDid: AGENT_DIDS.TRADING,
                    authorizerDid: userDid,
                    signature: `sig_0x${crypto.randomUUID().slice(0, 16)}`,
                  },
                  message: `E*TRADE Execution Confirmed: Broker Order ID ${brokerId}`,
                  timestamp: now,
                };
              }
              if (retryData?.Error?.message) {
                errMsg = retryData.Error.message;
              } else if (retryData?.PlaceOrderResponse?.messageList?.Message?.[0]?.description) {
                errMsg = retryData.PlaceOrderResponse.messageList.Message[0].description;
              } else {
                const xmlMsg = retryRawText.match(/<message>([^<]+)<\/message>/i) || retryRawText.match(/<description>([^<]+)<\/description>/i);
                if (xmlMsg) errMsg = xmlMsg[1];
              }
            } else {
              const autoRecoveryErr = this.getLastError() || "Failed to acquire fresh preview session from E*TRADE";
              errMsg = `E*TRADE Auto-Recovery Failed: ${autoRecoveryErr}`;
            }
          } catch (retryErr: any) {
            console.warn("[ETradeClient] Auto-recovery preview retry failed:", retryErr);
            errMsg = `Auto-recovery failed: ${retryErr.message || String(retryErr)}`;
          }
        }

        return {
          success: false,
          orderId: params.orderId,
          executionId: "",
          brokerOrderRef: "",
          authorizerDid: userDid,
          status: "failed",
          symbol: params.symbol,
          action: params.action,
          quantity: params.quantity,
          executionPrice: 0,
          totalSettled: 0,
          didAttestation: {
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid: userDid,
            signature: "",
          },
          message: `E*TRADE Broker Rejected Order: ${errMsg}`,
          timestamp: now,
        };
      } catch (err: any) {
        return {
          success: false,
          orderId: params.orderId,
          executionId: "",
          brokerOrderRef: "",
          authorizerDid: userDid,
          status: "failed",
          symbol: params.symbol,
          action: params.action,
          quantity: params.quantity,
          executionPrice: 0,
          totalSettled: 0,
          didAttestation: {
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid: userDid,
            signature: "",
          },
          message: `E*TRADE Network Error: ${err.message || String(err)}`,
          timestamp: now,
        };
      }
    }

    // 3. Fallback when keys are missing: reject genuinely in EVERY
    // environment (#2389). This branch used to return a success-shaped
    // "simulated execution" — an invented et_sim_ reference and a
    // random signature — whenever the environment was not live; those
    // results were persisted and rendered in the autopilot feed as
    // real executions. No broker path produced an execution above, so
    // the only honest outcome is a failure carrying no reference and
    // no signature, exactly as the live branch always did.
    return {
      success: false,
      orderId: params.orderId,
      executionId: "",
      brokerOrderRef: "",
      authorizerDid: userDid,
      status: "failed",
      symbol: params.symbol,
      action: params.action,
      quantity: params.quantity,
      executionPrice: 0,
      totalSettled: 0,
      didAttestation: {
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: userDid,
        signature: "",
      },
      message: `E*TRADE Broker Error: ET_API_KEY and ET_API_SECRET must be configured for order execution [${envConfig.name} environment]. No order was placed.`,
      timestamp: now,
    };
  }

  /**
   * Fetches authentic accounts list
   */
  async fetchAccounts(): Promise<ETradeAccount[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for account requests.";
      return [];
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/list`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/list.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && res.status === 404) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Accounts API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        console.warn(`[ETradeClient] fetchAccounts HTTP ${res.status}: ${errorText}`);
        await this.handleUpstreamAuthError(res.status, "accounts", errorText);
        return [];
      }

      const data = (await res.json().catch(() => ({}))) as any;
      if (!data?.AccountListResponse) {
        // HTTP 200 with no payload wrapper at all: an upstream error
        // body, not a genuine zero-account response.
        this.lastError = "E*TRADE Accounts API returned an unexpected empty response.";
        return [];
      }
      let rawAccounts = data?.AccountListResponse?.Accounts?.Account;
      if (!rawAccounts) return [];
      if (!Array.isArray(rawAccounts)) rawAccounts = [rawAccounts];

      this.lastError = undefined;
      return rawAccounts.map((a: any) => ({
        accountId: String(a.accountId || ""),
        accountKey: String(a.accountIdKey || a.accountKey || a.accountId || ""),
        accountIdKey: String(a.accountIdKey || a.accountKey || a.accountId || ""),
        accountDesc: String(a.accountDesc || a.accountName || "Brokerage Account"),
        accountName: a.accountName ? String(a.accountName) : undefined,
        accountMode: a.accountMode ? String(a.accountMode) : undefined,
        accountStatus: a.accountStatus ? String(a.accountStatus) : undefined,
        institutionType: a.institutionType ? String(a.institutionType) : undefined,
        accountType: String(a.accountType || "INDIVIDUAL"),
        shareWorksAccount: a.shareWorksAccount !== undefined ? Boolean(a.shareWorksAccount) : undefined,
        fcCheckMkt: a.fcCheckMkt !== undefined ? Boolean(a.fcCheckMkt) : undefined,
        lineOfCredit: a.lineOfCredit !== undefined ? Boolean(a.lineOfCredit) : undefined,
        openDate: a.openDate ? Number(a.openDate) : undefined,
        closedDate: a.closedDate ? Number(a.closedDate) : undefined,
        netAccountValue: Number(a.netAccountValue || 0),
        totalAccountValue: Number(a.totalAccountValue || a.netAccountValue || 0),
        cashAvailableForInvestment: Number(a.cashAvailableForInvestment || 0),
        dayTraderStatus: Boolean(a.dayTraderStatus),
      }));
    } catch (err) {
      console.warn("[ETradeClient] fetchAccounts error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE accounts request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return [];
    }
  }

  /**
   * Fetches real live portfolio positions using dynamic account discovery and authentic balance
   */
  async fetchPortfolio(
    accountKey?: string,
    includeBalance: boolean = false,
    options?: { view?: "QUICK" | "COMPLETE" | "PERFORMANCE" | "FUNDAMENTAL" | "OPTIONSWATCH"; totalsRequired?: boolean; count?: number; sortBy?: string; sortOrder?: "ASC" | "DESC" }
  ): Promise<{ account: ETradeAccount; positions: ETradePosition[] } | null> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for portfolio requests.";
      return null;
    }

    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) {
      key = "";
    }

    let accountMeta: ETradeAccount | undefined;
    if (!key) {
      const accounts = await this.fetchAccounts();
      if (!accounts.length) return null;
      accountMeta = accounts[0];
      key = accountMeta.accountKey || accountMeta.accountId || "";
      if (!key) {
        this.lastError = "E*TRADE portfolio request could not resolve an account key from the account list.";
        return null;
      }
    }

    const query = new URLSearchParams();
    if (options?.view) query.set("view", options.view);
    if (options?.totalsRequired !== undefined) query.set("totalsRequired", String(options.totalsRequired));
    if (options?.count) query.set("count", String(options.count));
    if (options?.sortBy) query.set("sortBy", options.sortBy);
    if (options?.sortOrder) query.set("sortOrder", options.sortOrder);
    const qs = query.toString() ? `?${query.toString()}` : "";

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/portfolio${qs}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/portfolio.json${qs}`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && res.status === 404) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });

        if (!res.ok && res.status === 404) {
          const plainUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/portfolio`;
          const plainAuth = await this.generateOAuthHeader("GET", plainUrl);
          res = await fetch(plainUrl, {
            method: "GET",
            headers: {
              Authorization: plainAuth,
              Accept: "application/json",
            },
          });
        }
      }

      if (!res.ok && res.status !== 204) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Portfolio API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        console.warn(`[ETradeClient] fetchPortfolio HTTP ${res.status}: ${errorText}`);
        await this.handleUpstreamAuthError(res.status, "portfolio", errorText);
        return null;
      }

      let positions: ETradePosition[] = [];
      let totalsNetVal: number | undefined;
      let totalsCash: number | undefined;

      if (res.ok && res.status !== 204) {
        const data = (await res.json().catch(() => ({}))) as any;
        if (!data?.PortfolioResponse) {
          // HTTP 200 with no payload wrapper at all: an upstream error
          // body, not a genuinely empty portfolio.
          this.lastError = "E*TRADE Portfolio API returned an unexpected empty response.";
          return null;
        }
        const portfolioTotals = data?.PortfolioResponse?.Totals || data?.PortfolioResponse?.totals;
        if (portfolioTotals) {
          if (portfolioTotals.totalMarketValue !== undefined) totalsNetVal = Number(portfolioTotals.totalMarketValue);
          if (portfolioTotals.cashBalance !== undefined) totalsCash = Number(portfolioTotals.cashBalance);
        }

        let rawPositions = data?.PortfolioResponse?.AccountPortfolio?.[0]?.Position;
        if (rawPositions) {
          if (!Array.isArray(rawPositions)) rawPositions = [rawPositions];
          positions = rawPositions.map((p: any) => {
            const quick = p.Quick || p.quick || p.Complete || p.complete || {};
            const price = Number(quick.lastTrade || (p.marketValue && p.quantity ? p.marketValue / p.quantity : (p.pricePaid || 0)));
            const product = p.Product || {};
            const expiryYear = Number(product.expiryYear || 0);
            const expiryMonth = Number(product.expiryMonth || 0);
            const expiryDay = Number(product.expiryDay || 0);
            const expirationDate = expiryYear && expiryMonth && expiryDay
              ? `${expiryYear}-${String(expiryMonth).padStart(2, "0")}-${String(expiryDay).padStart(2, "0")}`
              : undefined;
            return {
              symbol: String(p.Product?.symbol || p.symbol || ""),
              securityType: product.securityType ? String(product.securityType) : undefined,
              positionType: p.positionType === "SHORT" ? "SHORT" as const : p.positionType === "LONG" ? "LONG" as const : undefined,
              optionType: product.callPut === "CALL" || product.callPut === "PUT" ? product.callPut : undefined,
              strikePrice: product.strikePrice !== undefined ? Number(product.strikePrice) : undefined,
              expirationDate,
              description: String(p.Product?.securityType || p.symbolDescription || p.description || "Common Stock"),
              quantity: Number(p.quantity || 0),
              pricePaid: Number(p.pricePaid || 0),
              costBasis: Number(p.totalCost || p.costBasis || p.pricePaid || 0),
              currentPrice: price,
              marketPrice: price,
              marketValue: Number(p.marketValue || (price * Number(p.quantity || 0))),
              totalGain: Number(p.totalGain || 0),
              unrealizedGainLoss: Number(p.totalGain || 0),
              totalGainPercent: Number(p.totalGainPct || 0),
              unrealizedGainLossPercent: Number(p.totalGainPct || 0),
              daysGain: Number(p.daysGain || quick.change || 0),
              daysGainPercent: Number(p.daysGainPct || quick.changePct || 0),
            };
          });
        }
      }

      let cashPower = totalsCash ?? accountMeta?.cashAvailableForInvestment ?? 0;
      let marginPower = accountMeta?.marginBuyingPower || 0;
      let netVal = totalsNetVal ?? positions.reduce((sum, p) => sum + p.marketValue, 0);

      if (includeBalance) {
        const balance = await this.fetchBalance(key).catch(() => null);
        if (balance) {
          if (balance.netAccountValue !== undefined && balance.netAccountValue > 0) {
            netVal = balance.netAccountValue;
          } else if (netVal === 0 && (balance.cashBuyingPower || balance.cashBalance)) {
            netVal = balance.cashBuyingPower || balance.cashBalance || 0;
          }
          if (balance.cashBuyingPower !== undefined) cashPower = balance.cashBuyingPower;
          if (balance.marginBuyingPower !== undefined) marginPower = balance.marginBuyingPower;
        }
      }

      if (netVal === 0 && accountMeta?.netAccountValue) {
        netVal = accountMeta.netAccountValue;
      }

      const account: ETradeAccount = {
        accountId: accountMeta?.accountId || key,
        accountKey: key,
        accountDesc: accountMeta?.accountDesc || `E*TRADE Brokerage Account [${envConfig.label}]`,
        accountType: accountMeta?.accountType || "MARGIN",
        netAccountValue: netVal,
        totalAccountValue: netVal,
        cashAvailableForInvestment: cashPower,
        marginBuyingPower: marginPower,
        dayTraderStatus: false,
      };

      return { account, positions };
    } catch (err) {
      console.warn("[ETradeClient] fetchPortfolio error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE portfolio request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    }
  }

  /**
   * Accounts API: View Portfolio Position Lots
   * GET /v1/accounts/{accountIdKey}/portfolio/{positionId}
   */
  async fetchPositionLots(accountKey: string, positionId: string): Promise<ETradePositionLot[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for position-lot requests.";
      return [];
    }
    if (!accountKey || !positionId) {
      this.lastError = "E*TRADE position-lots request is missing an account key or position id.";
      return [];
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(accountKey)}/portfolio/${encodeURIComponent(positionId)}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(accountKey)}/portfolio/${encodeURIComponent(positionId)}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Position Lots API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "positionLots", errorText);
        return [];
      }

      const data = (await res.json().catch(() => ({}))) as any;
      let rawLots = data?.PositionLotsResponse?.PositionLot || data?.PositionLot;
      if (!rawLots) {
        if (!data?.PositionLotsResponse && !data?.PositionLot) {
          this.lastError = "E*TRADE Position Lots API returned an unexpected empty response.";
        }
        return [];
      }
      if (!Array.isArray(rawLots)) rawLots = [rawLots];

      this.lastError = undefined;
      return rawLots.map((lot: any) => ({
        positionId: lot.positionId !== undefined ? lot.positionId : positionId,
        positionLotId: lot.positionLotId !== undefined ? lot.positionLotId : lot.lotId,
        price: Number(lot.price || 0),
        termCode: lot.termCode !== undefined ? Number(lot.termCode) : undefined,
        daysGain: lot.daysGain !== undefined ? Number(lot.daysGain) : undefined,
        daysGainPct: lot.daysGainPct !== undefined ? Number(lot.daysGainPct) : undefined,
        marketValue: lot.marketValue !== undefined ? Number(lot.marketValue) : undefined,
        totalCost: lot.totalCost !== undefined ? Number(lot.totalCost) : undefined,
        totalCostForGainPct: lot.totalCostForGainPct !== undefined ? Number(lot.totalCostForGainPct) : undefined,
        totalGain: lot.totalGain !== undefined ? Number(lot.totalGain) : undefined,
        totalGainPct: lot.totalGainPct !== undefined ? Number(lot.totalGainPct) : undefined,
        lotSourceCode: lot.lotSourceCode !== undefined ? Number(lot.lotSourceCode) : undefined,
        originalQty: lot.originalQty !== undefined ? Number(lot.originalQty) : undefined,
        remainingQty: lot.remainingQty !== undefined ? Number(lot.remainingQty) : undefined,
        availableQty: lot.availableQty !== undefined ? Number(lot.availableQty) : undefined,
        orderNo: lot.orderNo !== undefined ? Number(lot.orderNo) : undefined,
        legNo: lot.legNo !== undefined ? Number(lot.legNo) : undefined,
        acquiredDate: lot.acquiredDate !== undefined ? Number(lot.acquiredDate) : undefined,
        locationCode: lot.locationCode !== undefined ? Number(lot.locationCode) : undefined,
        exchangeRate: lot.exchangeRate !== undefined ? Number(lot.exchangeRate) : undefined,
        settlementCurrency: lot.settlementCurrency ? String(lot.settlementCurrency) : undefined,
        paymentCurrency: lot.paymentCurrency ? String(lot.paymentCurrency) : undefined,
        adjPrice: lot.adjPrice !== undefined ? Number(lot.adjPrice) : undefined,
        commPerShare: lot.commPerShare !== undefined ? Number(lot.commPerShare) : undefined,
        feesPerShare: lot.feesPerShare !== undefined ? Number(lot.feesPerShare) : undefined,
        adjustedPrice: lot.adjustedPrice !== undefined ? Number(lot.adjustedPrice) : undefined,
      }));
    } catch (err) {
      console.warn("[ETradeClient] fetchPositionLots error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE position lots request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return [];
    }
  }

  /**
   * Fetches real account balance (cash buying power, margin buying power, net account value)
   */
  async fetchBalance(accountKey: string): Promise<{ netAccountValue?: number; cashBuyingPower?: number; marginBuyingPower?: number; cashBalance?: number } | null> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for balance requests.";
      return null;
    }
    if (!accountKey) {
      this.lastError = "E*TRADE balance request is missing an account key.";
      return null;
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(accountKey)}/balance?instType=BROKERAGE&realTimeNAV=true`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(accountKey)}/balance.json?instType=BROKERAGE&realTimeNAV=true`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 400 || res.status === 404)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });

        if (!res.ok && (res.status === 400 || res.status === 404)) {
          const plainUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(accountKey)}/balance`;
          const plainAuth = await this.generateOAuthHeader("GET", plainUrl);
          res = await fetch(plainUrl, {
            method: "GET",
            headers: {
              Authorization: plainAuth,
              Accept: "application/json",
            },
          });
        }
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Balance API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        console.warn(`[ETradeClient] fetchBalance HTTP ${res.status}: ${errorText}`);
        await this.handleUpstreamAuthError(res.status, "balance", errorText);
        return null;
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const balanceResp = data?.BalanceResponse;
      if (!balanceResp) {
        this.lastError = "E*TRADE Balance API returned an unexpected empty response.";
        return null;
      }
      this.lastError = undefined;

      const computed = balanceResp.Computed;
      const cashObj = balanceResp.Cash;

      const netAccountValue = Number(
        computed?.RealTimeValues?.totalAccountValue ??
        computed?.netAccountValue ??
        computed?.RealTimeValues?.netMv ??
        balanceResp?.accountBalance ??
        balanceResp?.netAccountValue ??
        0
      );

      const cashBuyingPower = Number(
        computed?.cashBuyingPower ??
        computed?.cashAvailableForInvestment ??
        computed?.netCash ??
        computed?.cashBalance ??
        cashObj?.moneyMktBuyPower ??
        cashObj?.cashAvailableForWithdrawal ??
        balanceResp?.cashAvailableForInvestment ??
        0
      );

      const marginBuyingPower = Number(
        computed?.marginBuyingPower ??
        computed?.marginBalance ??
        0
      );

      const cashBalance = Number(
        computed?.cashBalance ??
        cashObj?.cashBalance ??
        cashObj?.fundsForOpenOrdersCash ??
        0
      );

      return {
        netAccountValue: netAccountValue > 0 ? netAccountValue : undefined,
        cashBuyingPower: cashBuyingPower > 0 ? cashBuyingPower : undefined,
        marginBuyingPower: marginBuyingPower > 0 ? marginBuyingPower : undefined,
        cashBalance: cashBalance > 0 ? cashBalance : undefined,
      };
    } catch (err) {
      console.warn("[ETradeClient] fetchBalance error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE balance request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    }
  }

  /**
   * Accounts API: List Transactions
   * GET /v1/accounts/{accountIdKey}/transactions
   */
  async fetchTransactions(
    accountKey?: string,
    params?: { startDate?: string; endDate?: string; sortOrder?: "ASC" | "DESC"; marker?: string; count?: number }
  ): Promise<ETradeTransaction[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for transaction requests.";
      return [];
    }

    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) key = "";
    if (!key) {
      const accounts = await this.fetchAccounts();
      if (!accounts.length) return [];
      key = accounts[0].accountKey || accounts[0].accountId;
      if (!key) {
        this.lastError = "E*TRADE transactions request could not resolve an account key from the account list.";
        return [];
      }
    }

    const query = new URLSearchParams();
    if (params?.startDate) query.set("startDate", params.startDate);
    if (params?.endDate) query.set("endDate", params.endDate);
    if (params?.sortOrder) query.set("sortOrder", params.sortOrder);
    if (params?.marker) query.set("marker", params.marker);
    if (params?.count) query.set("count", String(params.count));
    const qs = query.toString() ? `?${query.toString()}` : "";

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/transactions${qs}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/transactions.json${qs}`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Transactions API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "transactions", errorText);
        return [];
      }

      const data = (await res.json().catch(() => ({}))) as any;
      if (!data?.TransactionListResponse) {
        this.lastError = "E*TRADE Transactions API returned an unexpected empty response.";
        return [];
      }
      let rawList = data?.TransactionListResponse?.Transaction;
      if (!rawList) return [];
      if (!Array.isArray(rawList)) rawList = [rawList];

      this.lastError = undefined;
      return rawList.map((t: any) => ({
        transactionId: String(t.transactionId || ""),
        accountId: String(t.accountId || key),
        transactionDate: Number(t.transactionDate || 0),
        postDate: t.postDate ? Number(t.postDate) : undefined,
        amount: Number(t.amount || 0),
        description: String(t.description || ""),
        transactionType: String(t.transactionType || ""),
        memo: t.memo ? String(t.memo) : undefined,
        imageFlag: Boolean(t.imageFlag),
        instType: t.instType ? String(t.instType) : undefined,
        detailsURI: t.detailsURI ? String(t.detailsURI) : undefined,
      }));
    } catch (err) {
      console.warn("[ETradeClient] fetchTransactions error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE transactions request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return [];
    }
  }

  /**
   * Accounts API: List Transaction Details
   * GET /v1/accounts/{accountIdKey}/transactions/{transactionId}
   */
  async fetchTransactionDetails(
    accountKey: string,
    transactionId: string,
    storeId?: string
  ): Promise<ETradeTransactionDetails | null> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for transaction-detail requests.";
      return null;
    }
    if (!accountKey || !transactionId) {
      this.lastError = "E*TRADE transaction-details request is missing an account key or transaction id.";
      return null;
    }

    const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(accountKey)}/transactions/${encodeURIComponent(transactionId)}${qs}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(accountKey)}/transactions/${encodeURIComponent(transactionId)}.json${qs}`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Transaction Details API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "transactionDetails", errorText);
        return null;
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const resp = data?.TransactionDetailsResponse;
      if (!resp) {
        this.lastError = "E*TRADE Transaction Details API returned an unexpected empty response.";
        return null;
      }
      this.lastError = undefined;

      return {
        transactionId: String(resp.transactionId || transactionId),
        accountId: String(resp.accountId || accountKey),
        transactionDate: Number(resp.transactionDate || 0),
        amount: Number(resp.amount || 0),
        description: String(resp.description || ""),
        category: resp.Category ? {
          categoryId: String(resp.Category.categoryId || ""),
          categoryName: String(resp.Category.categoryName || ""),
          parentName: resp.Category.parentName ? String(resp.Category.parentName) : undefined,
        } : undefined,
        brokerage: resp.Brokerage ? {
          product: resp.Brokerage.Product ? {
            symbol: String(resp.Brokerage.Product.symbol || ""),
            securityType: String(resp.Brokerage.Product.securityType || ""),
          } : undefined,
          quantity: resp.Brokerage.quantity !== undefined ? Number(resp.Brokerage.quantity) : undefined,
          price: resp.Brokerage.price !== undefined ? Number(resp.Brokerage.price) : undefined,
          settlementDate: resp.Brokerage.settlementDate ? Number(resp.Brokerage.settlementDate) : undefined,
          fee: resp.Brokerage.fee !== undefined ? Number(resp.Brokerage.fee) : undefined,
          memo: resp.Brokerage.memo ? String(resp.Brokerage.memo) : undefined,
        } : undefined,
      };
    } catch (err) {
      console.warn("[ETradeClient] fetchTransactionDetails error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE transaction details request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    }
  }

  /**
   * Alerts API: List Alerts (Inbox)
   * GET /v1/user/alerts
   */
  async fetchAlerts(params?: {
    count?: number;
    category?: string;
    status?: "READ" | "UNREAD" | "DELETED";
    direction?: "ASC" | "DESC";
    search?: string;
    unfiltered?: boolean;
  }): Promise<ETradeAlert[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for alert requests.";
      return [];
    }

    const query = new URLSearchParams();
    if (params?.count) query.set("count", String(params.count));
    if (params?.category) query.set("category", params.category);
    if (params?.status) query.set("status", params.status);
    if (params?.direction) query.set("direction", params.direction);
    if (params?.search) query.set("search", params.search);
    if (params?.unfiltered !== undefined) query.set("unfiltered", String(params.unfiltered));
    const qs = query.toString() ? `?${query.toString()}` : "";

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/alerts${qs}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/alerts.json${qs}`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Alerts API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "alerts", errorText);
        return [];
      }

      const data = (await res.json().catch(() => ({}))) as any;
      if (!data?.AlertsResponse) {
        this.lastError = "E*TRADE Alerts API returned an unexpected empty response.";
        return [];
      }
      let rawAlerts = data?.AlertsResponse?.Alert;
      if (!rawAlerts) return [];
      if (!Array.isArray(rawAlerts)) rawAlerts = [rawAlerts];

      this.lastError = undefined;
      return rawAlerts.map((a: any) => ({
        id: a.id,
        createTime: Number(a.createTime || 0),
        subject: String(a.subject || ""),
        status: (a.status || "UNREAD") as "READ" | "UNREAD" | "DELETED",
        msgText: a.msgText ? String(a.msgText) : undefined,
        readTime: a.readTime ? Number(a.readTime) : undefined,
        deleteTime: a.deleteTime ? Number(a.deleteTime) : undefined,
      }));
    } catch (err) {
      console.warn("[ETradeClient] fetchAlerts error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE alerts request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return [];
    }
  }

  /**
   * Alerts API: List Alert Details
   * GET /v1/user/alerts/{alertId}
   */
  async fetchAlertDetails(alertId: string | number): Promise<ETradeAlertDetails | null> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for alert-detail requests.";
      return null;
    }
    if (!alertId) {
      this.lastError = "E*TRADE alert-details request is missing an alert id.";
      return null;
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/alerts/${encodeURIComponent(String(alertId))}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/alerts/${encodeURIComponent(String(alertId))}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Alert Details API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "alertDetails", errorText);
        return null;
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const resp = data?.AlertDetailsResponse;
      if (!resp) {
        this.lastError = "E*TRADE Alert Details API returned an unexpected empty response.";
        return null;
      }
      this.lastError = undefined;

      return {
        id: resp.id || alertId,
        createTime: Number(resp.createTime || 0),
        subject: String(resp.subject || ""),
        msgText: String(resp.msgText || ""),
        readTime: resp.readTime ? Number(resp.readTime) : undefined,
        deleteTime: resp.deleteTime ? Number(resp.deleteTime) : undefined,
        symbol: resp.symbol ? String(resp.symbol) : undefined,
        next: resp.next ? String(resp.next) : undefined,
        prev: resp.prev ? String(resp.prev) : undefined,
      };
    } catch (err) {
      console.warn("[ETradeClient] fetchAlertDetails error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE alert details request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    }
  }

  /**
   * Alerts API: Delete Alert(s)
   * DELETE /v1/user/alerts/{alert_id_list}
   */
  async deleteAlert(alertId: string | number | (string | number)[]): Promise<{ success: boolean; message: string }> {
    const envConfig = this.getEnvConfig();
    const idList = Array.isArray(alertId) ? alertId.join(",") : String(alertId);
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret || !idList) {
      return { success: false, message: "Missing credentials or alertId" };
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/alerts/${encodeURIComponent(idList)}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/alerts/${encodeURIComponent(idList)}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("DELETE", url);

    try {
      let res = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("DELETE", url);
        res = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Delete Alert Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "deleteAlert", errorText);
        return { success: false, message: this.lastError };
      }

      return { success: true, message: `Alert ${alertId} deleted successfully.` };
    } catch (err: any) {
      return { success: false, message: err.message || "Failed to delete alert" };
    }
  }

  /**
   * Market API: Look Up Product
   * GET /v1/market/lookup/{search}
   */
  async lookupProduct(search: string): Promise<ETradeProductLookup[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for product lookup requests.";
      return [];
    }
    if (!search.trim()) {
      this.lastError = "E*TRADE product lookup request is missing a search term.";
      return [];
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/market/lookup/${encodeURIComponent(search.trim())}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/market/lookup/${encodeURIComponent(search.trim())}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Lookup API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        console.warn(`[ETradeClient] lookupProduct HTTP ${res.status}: ${errorText}`);
        await this.handleUpstreamAuthError(res.status, "lookup", errorText);
        return [];
      }
      const data = (await res.json().catch(() => ({}))) as any;
      if (!data?.LookupResponse) {
        this.lastError = `E*TRADE Lookup API returned an unexpected empty response for ${search.trim()}.`;
        return [];
      }
      let list = data?.LookupResponse?.Data;
      if (!list) return [];
      if (!Array.isArray(list)) list = [list];

      this.lastError = undefined;
      return list.map((item: any) => ({
        symbol: String(item.symbol || ""),
        description: String(item.description || ""),
        type: String(item.type || "EQ"),
      }));
    } catch (err) {
      if (!this.lastError) {
        this.lastError = `E*TRADE product lookup request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return [];
    }
  }

  /**
   * Market API: Get Option Chains
   * GET /v1/market/optionchains
   */
  async getOptionChains(params: {
    symbol: string;
    expiryYear?: number;
    expiryMonth?: number;
    expiryDay?: number;
    strikePrice?: number;
    noOfStrikes?: number;
    includeWeekly?: boolean;
    chainType?: "CALL" | "PUT" | "CALLPUT";
    includeRawResponse?: boolean;
  }, requestBudget?: OptionRequestBudget): Promise<ETradeOptionChain | null> {
    // Issue #155: lastError is the failure signal for this call. It is
    // cleared on entry and set on EVERY failure return below, so a null
    // result with lastError set means "upstream failure" and a null
    // result without one means "genuinely no chain" — callers (routes,
    // screener, IV collector) rely on that distinction.
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!params.symbol) {
      this.lastError = "E*TRADE option chains request is missing a symbol.";
      return null;
    }
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for option chain requests.";
      return null;
    }

    const query = new URLSearchParams({ symbol: params.symbol.toUpperCase().trim() });
    if (params.expiryYear) query.set("expiryYear", String(params.expiryYear));
    if (params.expiryMonth) query.set("expiryMonth", String(params.expiryMonth));
    if (params.expiryDay) query.set("expiryDay", String(params.expiryDay));
    if (params.strikePrice) query.set("strikePrice", String(params.strikePrice));
    if (params.noOfStrikes) query.set("noOfStrikes", String(params.noOfStrikes));
    const weekly = params.includeWeekly !== undefined ? params.includeWeekly : this.getClientConfig().includeWeekly;
    query.set("includeWeekly", String(weekly));
    if (params.chainType) query.set("chainType", params.chainType);

    const primaryUrl = `${envConfig.etrade.baseUrl}/market/optionchains?${query.toString()}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/market/optionchains.json?${query.toString()}`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetchOptionRequest(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      }, requestBudget);

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetchOptionRequest(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        }, requestBudget);
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Option Chains API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "optionchains", errorText);
        return null;
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const resp = data?.OptionChainResponse;
      if (!resp) {
        // HTTP 200 but no chain payload at all: an upstream error body
        // (or unparseable response), not a genuine empty chain — a real
        // empty chain still carries the OptionChainResponse wrapper.
        this.lastError = `E*TRADE Option Chains API returned an unexpected empty response for ${params.symbol.toUpperCase()}.`;
        return null;
      }

      let rawPairs = resp.OptionPair;
      if (!rawPairs) {
        this.lastError = undefined;
        return {
          symbol: params.symbol.toUpperCase(),
          underlyingPrice: Number(resp.nearPrice || 0),
          ...(params.includeRawResponse ? { raw: resp } : {}),
          pairs: [],
        };
      }
      if (!Array.isArray(rawPairs)) rawPairs = [rawPairs];

      const mapContract = (c: any, type: "CALL" | "PUT") => {
        if (!c) return undefined;
        return {
          timeStamp: Number(c.timeStamp || 0) || undefined,
          adjustedFlag: c.adjustedFlag === true || String(c.adjustedFlag).toLowerCase() === "true",
          optionCategory: c.optionCategory ? String(c.optionCategory) : undefined,
          optionRootSymbol: c.optionRootSymbol ? String(c.optionRootSymbol) : undefined,
          displaySymbol: c.displaySymbol ? String(c.displaySymbol) : undefined,
          osiKey: c.osiKey ? String(c.osiKey) : undefined,
          optionType: type,
          strikePrice: Number(c.strikePrice || 0),
          symbol: String(c.symbol || ""),
          bid: Number(c.bid || 0),
          ask: Number(c.ask || 0),
          bidSize: c.bidSize !== undefined ? Number(c.bidSize) : undefined,
          askSize: c.askSize !== undefined ? Number(c.askSize) : undefined,
          lastPrice: Number(c.lastPrice || 0),
          volume: c.volume != null ? Number(c.volume) : undefined,
          openInterest: c.openInterest != null ? Number(c.openInterest) : undefined,
          delta: c.OptionGreeks?.delta != null ? Number(c.OptionGreeks.delta) : undefined,
          gamma: c.OptionGreeks?.gamma != null ? Number(c.OptionGreeks.gamma) : undefined,
          theta: c.OptionGreeks?.theta != null ? Number(c.OptionGreeks.theta) : undefined,
          vega: c.OptionGreeks?.vega != null ? Number(c.OptionGreeks.vega) : undefined,
          rho: c.OptionGreeks?.rho != null ? Number(c.OptionGreeks.rho) : undefined,
          impliedVolatility: c.OptionGreeks?.iv != null ? Number(c.OptionGreeks.iv) : undefined,
        };
      };

      const pairs = rawPairs.map((p: any) => ({
        call: mapContract(p.Call, "CALL"),
        put: mapContract(p.Put, "PUT"),
      }));

      this.lastError = undefined;
      return {
        symbol: params.symbol.toUpperCase(),
        underlyingPrice: Number(resp.nearPrice || 0),
        ...(params.includeRawResponse ? { raw: resp } : {}),
        selectedExpiry: resp.SelectedED ? {
          year: Number(resp.SelectedED.year || 0),
          month: Number(resp.SelectedED.month || 0),
          day: Number(resp.SelectedED.day || 0),
        } : undefined,
        pairs,
      };
    } catch (err) {
      if (!this.lastError) {
        this.lastError = `E*TRADE option chains request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      console.warn("[ETradeClient] getOptionChains error:", err);
      return null;
    }
  }

  /**
   * Market API: Get Option Expire Dates
   * GET /v1/market/optionexpiredate
   */
  async getOptionExpireDates(symbol: string, expiryType?: string, requestBudget?: OptionRequestBudget): Promise<ETradeOptionExpireDate[]> {
    // Issue #155: same lastError contract as getOptionChains — cleared
    // on entry, set on every failure return, so an empty result with
    // lastError set means "upstream failure" and an empty result
    // without one means "genuinely no expirations".
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!symbol) {
      this.lastError = "E*TRADE option expire-date request is missing a symbol.";
      return [];
    }
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for option expire-date requests.";
      return [];
    }

    const query = new URLSearchParams({ symbol: symbol.toUpperCase().trim() });
    if (expiryType) query.set("expiryType", expiryType);

    const primaryUrl = `${envConfig.etrade.baseUrl}/market/optionexpiredate?${query.toString()}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/market/optionexpiredate.json?${query.toString()}`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetchOptionRequest(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      }, requestBudget);

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetchOptionRequest(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        }, requestBudget);
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Option Expire Date API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "optionexpiredate", errorText);
        return [];
      }
      const data = (await res.json().catch(() => ({}))) as any;
      const expireResponse = data?.OptionExpireDateResponse;
      if (!expireResponse) {
        // HTTP 200 but no payload wrapper at all: an upstream error
        // body (or unparseable response), not a genuine empty — a real
        // empty still carries the OptionExpireDateResponse wrapper.
        this.lastError = `E*TRADE Option Expire Date API returned an unexpected empty response for ${symbol.toUpperCase()}.`;
        return [];
      }
      let rawDates = expireResponse.ExpirationDate;
      if (!rawDates) return [];
      if (!Array.isArray(rawDates)) rawDates = [rawDates];

      this.lastError = undefined;
      return rawDates.map((d: any) => ({
        year: Number(d.year || 0),
        month: Number(d.month || 0),
        day: Number(d.day || 0),
        expiryType: d.expiryType ? String(d.expiryType) : undefined,
      }));
    } catch (err) {
      if (!this.lastError) {
        this.lastError = err instanceof Error ? err.message : "Failed to fetch option expire dates.";
      }
      return [];
    }
  }

  /**
   * Order API: List Orders
   * GET /v1/accounts/{accountIdKey}/orders
   */
  async fetchOrders(
    accountKey?: string,
    params?: { marker?: string; count?: number; status?: string; fromDate?: string; toDate?: string; symbol?: string }
  ): Promise<ETradeRemoteOrder[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for order requests.";
      return [];
    }

    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) key = "";
    if (!key) {
      const accounts = await this.fetchAccounts();
      if (!accounts.length) return [];
      key = accounts[0].accountKey || accounts[0].accountId;
      if (!key) {
        this.lastError = "E*TRADE orders request could not resolve an account key from the account list.";
        return [];
      }
    }

    const query = new URLSearchParams();
    if (params?.marker) query.set("marker", params.marker);
    if (params?.count) query.set("count", String(params.count));
    if (params?.status) query.set("status", params.status);
    if (params?.fromDate) query.set("fromDate", params.fromDate);
    if (params?.toDate) query.set("toDate", params.toDate);
    if (params?.symbol) query.set("symbol", params.symbol);
    const qs = query.toString() ? `?${query.toString()}` : "";

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders${qs}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders.json${qs}`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Orders API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "orders", errorText);
        return [];
      }

      const data = (await res.json().catch(() => ({}))) as any;
      if (!data?.OrdersResponse) {
        this.lastError = "E*TRADE Orders API returned an unexpected empty response.";
        return [];
      }
      let rawOrders = data?.OrdersResponse?.Order;
      if (!rawOrders) return [];
      if (!Array.isArray(rawOrders)) rawOrders = [rawOrders];

      this.lastError = undefined;
      return rawOrders.map((o: any) => {
        const orderDetail = o.OrderDetail?.[0] || o.OrderDetail || {};
        const instrument = orderDetail.Instrument?.[0] || orderDetail.Instrument || {};
        return {
          orderId: o.orderId,
          details: o.details,
          orderType: String(o.orderType || orderDetail.orderType || "EQ"),
          orderValue: o.orderValue ? Number(o.orderValue) : undefined,
          status: (orderDetail.status || o.status || "OPEN") as any,
          placedTime: orderDetail.placedTime ? Number(orderDetail.placedTime) : undefined,
          executedTime: orderDetail.executedTime ? Number(orderDetail.executedTime) : undefined,
          orderTerm: orderDetail.orderTerm,
          priceType: orderDetail.priceType,
          limitPrice: orderDetail.limitPrice ? Number(orderDetail.limitPrice) : undefined,
          stopPrice: orderDetail.stopPrice ? Number(orderDetail.stopPrice) : undefined,
          orderAction: instrument.orderAction,
          quantity: instrument.orderedQuantity ? Number(instrument.orderedQuantity) : undefined,
          symbol: instrument.Product?.symbol,
        };
      });
    } catch (err) {
      console.warn("[ETradeClient] fetchOrders error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE orders request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return [];
    }
  }

  /**
   * Order API: Get Order Details
   * GET /v1/accounts/{accountIdKey}/orders/{orderId}
   */
  async fetchOrderDetails(
    accountKey: string | undefined,
    orderId: string | number
  ): Promise<ETradeRemoteOrder | null> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for order-detail requests.";
      return null;
    }
    if (!orderId) {
      this.lastError = "E*TRADE order-details request is missing an order id.";
      return null;
    }

    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) key = "";
    if (!key) {
      const accounts = await this.fetchAccounts();
      if (!accounts.length) return null;
      key = accounts[0].accountKey || accounts[0].accountId;
      if (!key) {
        this.lastError = "E*TRADE order-details request could not resolve an account key from the account list.";
        return null;
      }
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/${encodeURIComponent(String(orderId))}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/${encodeURIComponent(String(orderId))}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Order Details API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "orderDetails", errorText);
        return null;
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const orderData = data?.OrdersResponse?.Order?.[0] || data?.Order?.[0] || data?.Order;
      if (!orderData) {
        this.lastError = "E*TRADE Order Details API returned an unexpected empty response.";
        return null;
      }
      this.lastError = undefined;

      const orderDetail = orderData?.OrderDetail?.[0] || {};
      const instrument = orderDetail?.Instrument?.[0] || {};

      return {
        orderId: orderData.orderId || orderId,
        details: orderData.detailsURI,
        orderType: orderDetail.orderType || orderData.orderType,
        orderValue: orderData.orderValue ? Number(orderData.orderValue) : undefined,
        status: (orderDetail.status || orderData.status || "OPEN") as any,
        placedTime: orderDetail.placedTime ? Number(orderDetail.placedTime) : undefined,
        executedTime: orderDetail.executedTime ? Number(orderDetail.executedTime) : undefined,
        orderTerm: orderDetail.orderTerm,
        priceType: orderDetail.priceType,
        limitPrice: orderDetail.limitPrice ? Number(orderDetail.limitPrice) : undefined,
        stopPrice: orderDetail.stopPrice ? Number(orderDetail.stopPrice) : undefined,
        orderAction: instrument.orderAction,
        quantity: instrument.orderedQuantity ? Number(instrument.orderedQuantity) : undefined,
        symbol: instrument.Product?.symbol,
      };
    } catch (err) {
      console.warn("[ETradeClient] fetchOrderDetails error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE order details request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    }
  }

  /**
   * Order API: Cancel Order
   * PUT /v1/accounts/{accountIdKey}/orders/cancel
   */
  async cancelOrder(accountKey: string | undefined, orderId: string | number): Promise<ETradeCancelOrderResult> {
    const now = new Date().toISOString();
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      return { success: false, orderId: String(orderId), message: "Missing E*TRADE credentials", timestamp: now };
    }

    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) key = "";
    if (!key) {
      const accounts = await this.fetchAccounts();
      key = accounts[0]?.accountKey || accounts[0]?.accountId || "";
      if (!key) return { success: false, orderId: String(orderId), message: "Account ID key not found", timestamp: now };
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/cancel`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/cancel.json`;
    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("PUT", url);

    const body = {
      CancelOrderRequest: {
        orderId: Number(orderId) || orderId,
      },
    };

    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok) {
        return {
          success: true,
          orderId: String(orderId),
          message: data?.CancelOrderResponse?.messages?.Message?.[0]?.description || `Order ${orderId} cancelled successfully.`,
          timestamp: now,
        };
      }

      const errMsg = data?.Error?.message || `HTTP ${res.status}`;
      return {
        success: false,
        orderId: String(orderId),
        message: `Cancel rejected: ${errMsg}`,
        timestamp: now,
      };
    } catch (err: any) {
      return {
        success: false,
        orderId: String(orderId),
        message: `Cancel network error: ${err.message || String(err)}`,
        timestamp: now,
      };
    }
  }

  /**
   * Order API: Change Previewed Order
   * POST /v1/accounts/{accountIdKey}/orders/change/preview
   */
  async changeOrderPreview(
    accountKey: string | undefined,
    params: {
      orderId: string | number;
      clientOrderId?: string;
      symbol: string;
      action: string;
      quantity: number;
      orderType?: string;
      limitPrice?: number;
      stopPrice?: number;
    }
  ): Promise<any> {
    const envConfig = this.getEnvConfig();
    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) key = "";
    if (!key) {
      const accounts = await this.fetchAccounts();
      key = accounts[0]?.accountKey || accounts[0]?.accountId || "";
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/change/preview`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/change/preview.json`;
    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("POST", url);

    const body = {
      PreviewOrderRequest: {
        orderId: Number(params.orderId) || params.orderId,
        clientOrderId: params.clientOrderId || `chg_${crypto.randomUUID().slice(0, 8)}`,
        orderType: "EQ",
        Order: [
          {
            allOrNone: false,
            priceType: params.orderType || "MARKET",
            ...(params.limitPrice ? { limitPrice: params.limitPrice } : {}),
            ...(params.stopPrice ? { stopPrice: params.stopPrice } : {}),
            orderTerm: "GOOD_FOR_DAY",
            marketSession: "REGULAR",
            Instrument: [
              {
                Product: { securityType: "EQ", symbol: params.symbol.toUpperCase() },
                orderAction: params.action,
                quantityType: "QUANTITY",
                quantity: params.quantity,
              },
            ],
          },
        ],
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    return res.json().catch(() => ({}));
  }

  /**
   * Order API: Place Changed Order
   * POST /v1/accounts/{accountIdKey}/orders/change/place
   */
  async changeOrderPlace(
    accountKey: string | undefined,
    params: {
      orderId: string | number;
      previewId: string;
      clientOrderId?: string;
      symbol: string;
      action: string;
      quantity: number;
      orderType?: string;
      limitPrice?: number;
      stopPrice?: number;
    }
  ): Promise<any> {
    const envConfig = this.getEnvConfig();
    let key = accountKey || this.env.ETRADE_ACCOUNT_ID_KEY || "";
    if (key.includes("{accountIdKey}") || key.includes("%7BaccountIdKey%7D")) key = "";
    if (!key) {
      const accounts = await this.fetchAccounts();
      key = accounts[0]?.accountKey || accounts[0]?.accountId || "";
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/change/place`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/accounts/${encodeURIComponent(key)}/orders/change/place.json`;
    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("POST", url);

    const body = {
      PlaceOrderRequest: {
        orderId: Number(params.orderId) || params.orderId,
        clientOrderId: params.clientOrderId || `chg_pl_${crypto.randomUUID().slice(0, 8)}`,
        PreviewIds: [{ previewId: params.previewId }],
        Order: [
          {
            allOrNone: false,
            priceType: params.orderType || "MARKET",
            ...(params.limitPrice ? { limitPrice: params.limitPrice } : {}),
            ...(params.stopPrice ? { stopPrice: params.stopPrice } : {}),
            orderTerm: "GOOD_FOR_DAY",
            marketSession: "REGULAR",
            Instrument: [
              {
                Product: { securityType: "EQ", symbol: params.symbol.toUpperCase() },
                orderAction: params.action,
                quantityType: "QUANTITY",
                quantity: params.quantity,
              },
            ],
          },
        ],
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    return res.json().catch(() => ({}));
  }

  // =========================================================================
  // Official E*TRADE User API: Watchlist Management
  // Endpoints: GET/POST/PUT/DELETE /v1/user/watchlist
  // =========================================================================

  /**
   * Watchlist API: List User Watchlists
   * GET /v1/user/watchlist
   */
  async getWatchlists(): Promise<ETradeWatchlist[]> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for watchlist discovery.";
      return [];
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/watchlist`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/watchlist.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        await this.handleUpstreamAuthError(res.status, "user/watchlist", errorText);
        // Issue #826: use BusinessError for 404 — UI gets business message, logs get technical detail.
        if (res.status === 404) {
          const { BusinessError } = await import("../../outcomes/outcomeAspects");
          throw new BusinessError("FAILURE_WATCHLIST_UNAVAILABLE", { httpStatus: 404, errorText: errorText.slice(0, 200) });
        }
        this.lastError = `E*TRADE watchlist request failed [HTTP ${res.status}]: ${errorText.slice(0, 160) || res.statusText}`;
        return [];
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const resp = data?.WatchlistResponse || data?.WatchlistDetailResponse;
      if (!resp) {
        this.lastError = "E*TRADE watchlist request returned an unexpected empty response.";
        return [];
      }
      let rawWatchlists = resp?.watchlist || resp?.Watchlist;
      if (!rawWatchlists) return [];
      if (!Array.isArray(rawWatchlists)) rawWatchlists = [rawWatchlists];

      this.lastError = undefined;
      return rawWatchlists.map((w: any) => {
        let items = w.items?.item || w.item || [];
        if (!Array.isArray(items)) items = items ? [items] : [];
        const symbols = items.map((i: any) => (i.symbol || i.symbolDesc || "").toUpperCase()).filter(Boolean);

        return {
          watchlistId: w.watchlistId || w.id || crypto.randomUUID().slice(0, 8),
          name: String(w.name || "Default Watchlist"),
          symbols,
          source: "etrade_api" as const,
        };
      });
    } catch (err) {
      // Issue #826: BusinessError passes through (already has business message).
      // Technical errors get logged, UI gets generic message.
      const { BusinessError } = await import("../../outcomes/outcomeAspects");
      if (err instanceof BusinessError) {
        // Log technical detail, but don't set lastError to technical message.
        // The caller should use err.toJSON() for the UI.
        console.warn(`[ETradeClient] getWatchlists business error [${err.code}]:`, err.entry?.technicalDetail);
        throw err;
      }
      console.warn("[ETradeClient] getWatchlists error:", err);
      this.lastError = `E*TRADE watchlist request failed: ${err instanceof Error ? err.message : String(err)}`;
      return [];
    }
  }

  /**
   * Watchlist API: Get Watchlist Details
   * GET /v1/user/watchlist/{watchlistId}
   */
  async getWatchlistDetails(watchlistId: string | number): Promise<ETradeWatchlist | null> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for watchlist detail requests.";
      return null;
    }
    if (!watchlistId) {
      this.lastError = "E*TRADE watchlist-details request is missing a watchlist id.";
      return null;
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/watchlist/${encodeURIComponent(String(watchlistId))}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/watchlist/${encodeURIComponent(String(watchlistId))}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("GET", url);

    try {
      let res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("GET", url);
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Watchlist Details API Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        console.warn(`[ETradeClient] getWatchlistDetails HTTP ${res.status}: ${errorText}`);
        await this.handleUpstreamAuthError(res.status, "watchlistDetails", errorText);
        return null;
      }

      const data = (await res.json().catch(() => ({}))) as any;
      const resp = data?.WatchlistDetailResponse || data?.WatchlistResponse;
      const w = resp?.watchlist || resp?.Watchlist || resp;
      if (!w) {
        this.lastError = "E*TRADE watchlist detail request returned an unexpected empty response.";
        return null;
      }
      this.lastError = undefined;

      let items = w.items?.item || w.item || [];
      if (!Array.isArray(items)) items = items ? [items] : [];
      const symbols = items.map((i: any) => (i.symbol || i.symbolDesc || "").toUpperCase()).filter(Boolean);

      return {
        watchlistId: w.watchlistId || watchlistId,
        name: String(w.name || "Watchlist"),
        symbols,
        items: items.map((i: any) => ({
          symbol: String(i.symbol || "").toUpperCase(),
          price: i.price ? Number(i.price) : undefined,
          change: i.change ? Number(i.change) : undefined,
          changePercent: i.changePercent ? Number(i.changePercent) : undefined,
          volume: i.volume ? Number(i.volume) : undefined,
        })),
        source: "etrade_api",
      };
    } catch (err) {
      console.warn("[ETradeClient] getWatchlistDetails error:", err);
      if (!this.lastError) {
        this.lastError = `E*TRADE watchlist detail request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    }
  }

  /**
   * Watchlist API: Create Watchlist
   * POST /v1/user/watchlist/create
   */
  async createWatchlist(params: { name: string; symbols: string[] }): Promise<{
    success: boolean;
    watchlistId: string | number;
    name: string;
    symbols: string[];
    error?: string;
  }> {
    const envConfig = this.getEnvConfig();
    const cleanName = params.name.trim();
    const cleanSymbols = Array.from(new Set(params.symbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));

    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      return {
        success: false,
        watchlistId: "",
        name: cleanName,
        symbols: cleanSymbols,
        error: "E*TRADE API credentials not configured",
      };
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/watchlist/create`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/watchlist/create.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("POST", url);

    const payload = {
      CreateWatchlist: {
        name: cleanName,
        items: {
          item: cleanSymbols.map((sym) => ({ symbol: sym })),
        },
      },
    };

    try {
      let res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("POST", url);
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
      }

      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        const wlId =
          data?.CreateWatchlistResponse?.watchlistId ||
          data?.WatchlistResponse?.watchlistId ||
          `et_wl_${crypto.randomUUID().slice(0, 8)}`;
        return {
          success: true,
          watchlistId: wlId,
          name: cleanName,
          symbols: cleanSymbols,
        };
      }

      // If upstream rejects (e.g. sandbox limitation), return structured failure with error detail
      const errText = await res.text().catch(() => "");
      return {
        success: false,
        watchlistId: `et_wl_sim_${crypto.randomUUID().slice(0, 8)}`,
        name: cleanName,
        symbols: cleanSymbols,
        error: `Upstream HTTP ${res.status}: ${errText.slice(0, 150) || res.statusText}`,
      };
    } catch (err) {
      return {
        success: false,
        watchlistId: `et_wl_err_${crypto.randomUUID().slice(0, 8)}`,
        name: cleanName,
        symbols: cleanSymbols,
        error: err instanceof Error ? err.message : "Network error calling E*TRADE Watchlist API",
      };
    }
  }

  /**
   * Watchlist API: Add items to Watchlist
   * PUT /v1/user/watchlist/add/{watchlistId}
   */
  async addWatchlistItems(params: {
    watchlistId: string | number;
    symbols: string[];
  }): Promise<{ success: boolean; symbolsAdded: string[]; error?: string }> {
    const envConfig = this.getEnvConfig();
    const cleanSymbols = Array.from(new Set(params.symbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));

    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      return { success: false, symbolsAdded: [], error: "Missing API credentials" };
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/watchlist/add/${encodeURIComponent(String(params.watchlistId))}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/watchlist/add/${encodeURIComponent(String(params.watchlistId))}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("PUT", url);

    const payload = {
      AddWatchlist: {
        items: {
          item: cleanSymbols.map((sym) => ({ symbol: sym })),
        },
      },
    };

    try {
      let res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("PUT", url);
        res = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
      }

      return {
        success: res.ok,
        symbolsAdded: cleanSymbols,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        success: false,
        symbolsAdded: [],
        error: err instanceof Error ? err.message : "Error adding items to watchlist",
      };
    }
  }

  /**
   * Watchlist API: Delete Watchlist
   * DELETE /v1/user/watchlist/delete/{watchlistId}
   *
   * The boolean result is the caller contract and is unchanged, but the
   * method is no longer silent (issue #244): it follows the same
   * lastError discipline as the read methods (#155/#168) — cleared on
   * entry, the reason recorded on EVERY false return (missing
   * credentials, missing watchlist id, HTTP error, exception), and
   * unset after a successful delete — so getLastError() tells callers
   * WHY a delete failed instead of collapsing every cause into `false`.
   */
  async deleteWatchlist(watchlistId: string | number): Promise<boolean> {
    this.lastError = undefined;
    const envConfig = this.getEnvConfig();
    if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
      this.lastError = "E*TRADE consumer credentials are not configured for watchlist deletion.";
      return false;
    }
    if (!watchlistId) {
      this.lastError = "E*TRADE watchlist-delete request is missing a watchlist id.";
      return false;
    }

    const primaryUrl = `${envConfig.etrade.baseUrl}/user/watchlist/delete/${encodeURIComponent(String(watchlistId))}`;
    const fallbackUrl = `${envConfig.etrade.baseUrl}/user/watchlist/delete/${encodeURIComponent(String(watchlistId))}.json`;

    let url = primaryUrl;
    assertSandboxUrlSafety(url, envConfig.isLive);
    let authHeader = await this.generateOAuthHeader("DELETE", url);

    try {
      let res = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!res.ok && (res.status === 404 || res.status === 400)) {
        url = fallbackUrl;
        assertSandboxUrlSafety(url, envConfig.isLive);
        authHeader = await this.generateOAuthHeader("DELETE", url);
        res = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        });
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        this.lastError = `E*TRADE Delete Watchlist Error [HTTP ${res.status}]: ${errorText.slice(0, 200) || res.statusText}`;
        await this.handleUpstreamAuthError(res.status, "user/watchlist/delete", errorText);
        return false;
      }

      this.lastError = undefined;
      return true;
    } catch (err) {
      if (!this.lastError) {
        this.lastError = `E*TRADE watchlist delete request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return false;
    }
  }

  /**
   * Authorization API: Revoke Access Token Remote
   * GET /oauth/revoke_access_token
   */
  async revokeRemoteAccessToken(): Promise<{ success: boolean; message: string }> {
    return revokeRemoteAccessToken(this.env, this.userLogin, this.overrideEnv);
  }
}
