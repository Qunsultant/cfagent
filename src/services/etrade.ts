/**
 * E*TRADE Brokerage & Trading Capability Facade
 *
 * Implements:
 * - GoF Facade Pattern: Unified, simplified API to the pluggable trading subsystem.
 * - Single Responsibility Principle (SRP): Delegates to specialized micro-components (Screener, RestClient, Platform).
 * - Open/Closed Principle (OCP): Works seamlessly with any registered platform via TradingPlatformRegistry.
 * - Aspect-Oriented Security: Enforces Sandbox Guard and error aspects.
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import { withBreaker } from "../breakers/breakerDecorator";
import { defaultBreakerRegistry } from "../breakers/createBreakerPorts";
import type { BreakerRegistry } from "../breakers/breakerPorts";
import type { ETradeTokenIdentity } from "../security/etradeOAuth";
import type {
  ETradeQuote,
  StockScreenerFilter,
  StockScreenResult,
  ScreenedStockItem,
  ETradeOrderDraft,
  ETradeOrderExecutionResult,
  ETradePosition,
  ETradeAccount,
  ETradeBrokerStatus,
  ETradeTransaction,
  ETradeTransactionDetails,
  ETradeAlert,
  ETradeAlertDetails,
  ETradeProductLookup,
  ETradeOptionChain,
  ETradeOptionExpireDate,
  ETradeRemoteOrder,
  ETradeCancelOrderResult,
  ETradeWatchlist,
  SaveWatchlistResult,
} from "../types";
import {
  DynamicMarketScreener,
  ETradeTradingPlatform,
  ETradeRestClient,
  isStubQuote,
  OrderPreviewParams,
  STATIC_FALLBACK_QUOTE_STATUS,
  STATIC_CURATED_QUOTE_SOURCE,
  CACHED_UNIVERSE_QUOTE_SOURCE,
  isNonLivePricingQuoteStatus,
  nonLivePricingNotice,
  nasdaqUniverseSeamFromSql,
  nasdaqUniverseProviderFromRoute,
  bindNasdaqUniverseDeps,
  type NasdaqUniverseDeps,
  type NasdaqUniverseSeam,
} from "../trading";
import type { DataProviderPorts } from "../data/buildDataProviderPorts";
import { buildRegisteredDataProviderPorts } from "../data/dataProviderPortsProvider";
import { getCuratedStockBySymbol } from "../config/curatedStockUniverse";
import { resolveEnvironmentConfig } from "../config/environment";
import {
  levelsForQuoteSwitch,
  resolveQuoteEtradeUnknownMode,
  type QuoteScopedModes,
} from "../config/quoteModes";

export class ETradeService {
  private platform: ETradeTradingPlatform;
  private screener: DynamicMarketScreener;
  public client: ETradeRestClient;
  private orm?: DatabaseORM;
  private env: Env;
  private userLogin: string;
  private overrideEnv?: string;
  private breakerRegistry: BreakerRegistry;
  private storage?: Parameters<typeof nasdaqUniverseSeamFromSql>[3];

  /**
   * #2303 (#1976 step 1): the data-provider platform ports for
   * the internally built universe seam — built lazily from env
   * (AGENT_DB) via the shared production build, memoized per
   * service instance; unbound → the seam keeps its sql path.
   */
  private dataProviderPortsPromise?: Promise<DataProviderPorts>;

  private dataProviderPorts(): Promise<DataProviderPorts> {
    if (!this.dataProviderPortsPromise) {
      // The ports builder is resolved through the registered
      // provider (src/data/dataProviderPortsProvider): this
      // module is reachable from the client bundle through the
      // trading barrel, and the builder's graph (D1 adapters
      // → transaction aspect → node:async_hooks) is
      // server-only, so it cannot be imported here, statically
      // or dynamically. The worker entry registers the real
      // builder; unregistered contexts resolve to null ports
      // and the seam keeps its legacy path.
      this.dataProviderPortsPromise =
        buildRegisteredDataProviderPorts(this.env);
    }
    return this.dataProviderPortsPromise;
  }

  setScreenerUniverse(universe: ScreenedStockItem[]): void {
    this.screener.setUniverse(universe);
  }

  constructor(
    ormOrEnv?: DatabaseORM | Env,
    env?: Env,
    userLogin?: string,
    overrideEnv?: string,
    storage?: Parameters<typeof nasdaqUniverseSeamFromSql>[3],
    // Issue #1745: breaker registry (tests inject an isolated one;
    // production shares the per-isolate default so the etrade
    // breaker has memory across requests).
    // Issue #2441: identity (verified session, or the alias record for
    // a login the route already trusts) — forwarded to the client so
    // service reads see the same token the panel seam sees. Optional;
    // unset keeps exactly today's login-only behavior.
    opts?: { breakerRegistry?: BreakerRegistry; identity?: ETradeTokenIdentity }
  ) {
    // Issue #1185: the service resolves the caller's stored per-user
    // token — an explicit login is required; there is no default
    // identity to fall back to.
    if (!userLogin) {
      throw new Error("ETradeService requires an explicit userLogin (issue #1185: no default identity).");
    }
    if (ormOrEnv && "trades" in (ormOrEnv as any)) {
      this.orm = ormOrEnv as DatabaseORM;
      this.env = env || ({} as Env);
      this.userLogin = userLogin;
      this.overrideEnv = overrideEnv;
    } else {
      this.env = (ormOrEnv as Env) || ({} as Env);
      this.userLogin = userLogin;
      this.overrideEnv = overrideEnv;
    }
    // Issue #1686: optional DO blob handle for full capture on the
    // internal listings-seam build below. Unset → outcome-only, as before.
    this.storage = storage;

    this.breakerRegistry = opts?.breakerRegistry ?? defaultBreakerRegistry();
    this.client = new ETradeRestClient(this.env, this.userLogin, this.overrideEnv, opts?.identity);
    this.platform = new ETradeTradingPlatform(this.env, this.orm, this.userLogin, this.overrideEnv, this.client);
    this.screener = new DynamicMarketScreener();
  }

  /**
   * Synchronous broker connectivity status
   */
  getStatus(): ETradeBrokerStatus {
    const envConfig = resolveEnvironmentConfig(this.env, this.overrideEnv);
    const isMcp = Boolean(this.env.ETRADE_MCP_SERVER_URL);
    const hasApiKey = Boolean(envConfig.etrade.apiKey && envConfig.etrade.apiSecret);

    return {
      broker: "etrade",
      name: "E*TRADE by Morgan Stanley Brokerage",
      configured: isMcp || hasApiKey,
      mode: isMcp ? "mcp_remote" : hasApiKey ? (envConfig.isLive ? "live_oauth" : "sandbox_api") : "simulated_engine",
      protocol: isMcp ? "mcp_json_rpc" : hasApiKey ? "etrade_oauth_rest" : "sandbox_simulated",
      mcpServerUrl: this.env.ETRADE_MCP_SERVER_URL,
      environment: envConfig.isLive ? "live" : "sandbox",
      activeEnvironment: envConfig.name,
      apiUrl: envConfig.etrade.baseUrl,
      hasApiKey,
      oauthAuthenticated: false,
      capabilities: [
        "Natural Language Market Screener (NLQ)",
        "Dynamic All-Exchange Stock Listings (Nasdaq, NYSE, AMEX)",
        "Listing-Based Stock Screening with Explicit Price/Cap/Change Filters",
        "Real-Time Level 1 Quotes & Order Depth",
        "Agent DID Attestation Order Stamping",
        "Human-in-the-Loop (HITL) Execution Safety Guarantee",
        "Portfolio Positions & Purchasing Power",
        "Pluggable Multi-Broker Capability Architecture",
      ],
    };
  }

  /**
   * Async broker status that includes live token validity (SessionStore) & midnight ET expiry check
   */
  async getStatusAsync(): Promise<ETradeBrokerStatus> {
    return this.platform.getStatus();
  }

  /**
   * Screen & scan market equities based on fundamental and technical filters
   */
  screenStocks(filter: StockScreenerFilter = {}): StockScreenResult {
    return this.screener.screenStocks(filter);
  }

  /**
  * Dynamic all-exchange stock listing screening with explicit listing-data filters.
   */
  async screenMarkets(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    return this.screenMarketsAsync(filter);
  }

  /**
   * Issue #1378: threads the universe seam to screenLive. A
   * caller-supplied seam wins; otherwise the service builds one
   * internally from its ORM. Issue #1686: when the service was
   * constructed with a DO blob handle, the internal build captures
   * fully; without one the #1378 outcome-only contract is preserved.
   * Without an ORM there is no bundle to build, and screenLive returns
   * the missing-seam error result (never a direct fetch).
   */
  async screenMarketsAsync(
    filter: StockScreenerFilter = {},
    seam?: NasdaqUniverseSeam
  ): Promise<StockScreenResult> {
    const resolved =
      seam ??
      (await nasdaqUniverseSeamFromSql(this.orm?.getSql?.(), this.env, this.userLogin, this.storage, await this.dataProviderPorts()));
    return this.screener.screenLive(filter, resolved);
  }

  /**
   * Issue #1378: the route-bound universe deps for options
   * discovery, for callers that cannot import trading internals
   * (route handlers). Issue #1661: when the caller threads a DO
   * blob handle, fetches capture fully; without one the #1378
   * outcome-only contract is preserved. Undefined when the
   * service has no ORM or the bundle cannot be built; the
   * caller then degrades per its contract (resolveUnderlyings
   * throws naming the seam).
   */
  async getUniverseDeps(
    storage?: Parameters<typeof nasdaqUniverseSeamFromSql>[3]
  ): Promise<NasdaqUniverseDeps | undefined> {
    // Degrade-to-undefined is this method's contract (route
    // handlers run with mock orms in tests and real orms in
    // production; either way a bundle failure must surface as the
    // missing-seam throw at discovery time, never as a 500 here).
    try {
      const seam = await nasdaqUniverseSeamFromSql(
        this.orm?.getSql?.(),
        this.env,
        this.userLogin,
        storage,
        await this.dataProviderPorts()
      );
      if (!seam?.universeRoute) return undefined;
      const provider = nasdaqUniverseProviderFromRoute(
        seam.universeRoute.registry,
        seam.universeRoute.configs,
        seam.universeRoute.routes
      );
      return bindNasdaqUniverseDeps(provider, seam.universeRoute.runContext);
    } catch (err) {
      console.warn(
        `[etrade] universe deps unavailable, options discovery degrades to the missing-seam throw: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  /**
   * Real-time dynamic equity quote with live feed enrichment
   *
   * Issue #1133: `options.includeRawResponse` is forwarded verbatim to
   * the REST client's hook of the same name (via fetchQuoteRemote) —
   * when set, the returned quote carries the parsed wire payload as
   * `raw`. Unset (every existing caller), behaviour is unchanged.
   */
  async getQuoteAsync(
    symbol: string,
    options?: { includeRawResponse?: boolean }
  ): Promise<ETradeQuote> {
    return this.fetchQuoteRemote(symbol, options);
  }

  /**
   * Fetch quote for a specific ticker symbol (synchronous or cached)
   */
  getQuote(
    symbol: string,
    // #1725 (M7): QUOTE_ETRADE_UNKNOWN_MODE, default "zero-object"
    // (the sync legacy: AUTH_REQUIRED zero-price object). Under
    // "throw", the unknown tail throws the #294-style error (the
    // platform legacy) instead. The #922 curated-live throw above
    // precedes this tail and stands in every mode. Method opts carry
    // the run level + session/user carriers; the global env level
    // reads from this.env.
    opts?: { unknownMode?: unknown; scoped?: QuoteScopedModes },
  ): ETradeQuote {
    const cleanSym = symbol.trim().toUpperCase();
    // Issue #118 (audit F12): this synchronous path never fetches live data,
    // so its quotes must carry truthful provenance — in the live environment
    // a cached/static quote is stamped STATIC_FALLBACK with a source naming
    // where the price actually came from, never a live-feed label.
    const envConfig = resolveEnvironmentConfig(this.env, this.overrideEnv);
    const found = this.screener.getUniverse().find((s) => s.symbol === cleanSym);
    if (found) {
      return {
        ...found,
        price: found.lastPrice,
        high52: found.week52High,
        low52: found.week52Low,
        quoteStatus: found.quoteStatus ?? (envConfig.isLive ? STATIC_FALLBACK_QUOTE_STATUS : "SIMULATED_LEVEL1"),
        source: envConfig.isLive ? (found.source ?? CACHED_UNIVERSE_QUOTE_SOURCE) : "E*TRADE Market Data Feed",
      };
    }
    const curated = getCuratedStockBySymbol(cleanSym);
    if (curated) {
      // Issue #922 ([#913 S4]): in the live environment a curated-table
      // hit is NOT served as a STATIC_FALLBACK quote — the sync quote path
      // fails explicit instead, so no curated static price, no fresh
      // timestamp over static data, and no substitute numbers are served.
      // Non-live environments keep the labeled simulated path below.
      if (envConfig.isLive) {
        throw new Error(
          `E*TRADE live quote unavailable for ${cleanSym}: no live quote was returned and the curated static price is not served in the live environment (issue #922)`
        );
      }
      const price = curated.defaultPrice ?? 100.0;
      return {
        symbol: cleanSym,
        companyName: curated.companyName,
        lastPrice: price,
        price,
        change: 0,
        changePercent: 0,
        bid: 0,
        ask: 0,
        volume: 0,
        open: price,
        high: price,
        low: price,
        week52High: 0,
        week52Low: 0,
        marketCap: curated.marketCap,
        quoteStatus: envConfig.isLive ? STATIC_FALLBACK_QUOTE_STATUS : "SIMULATED_LEVEL1",
        timestamp: new Date().toISOString(),
        source: envConfig.isLive ? STATIC_CURATED_QUOTE_SOURCE : "E*TRADE Market Data Feed",
      };
    }
    // #1725: under QUOTE_ETRADE_UNKNOWN_MODE "throw", fail fast
    // like the platform (#294) instead of returning the zero-price
    // object below. Default "zero-object" preserves this path.
    const unknownMode = resolveQuoteEtradeUnknownMode(
      levelsForQuoteSwitch(opts?.scoped, opts?.unknownMode, this.env?.QUOTE_ETRADE_UNKNOWN_MODE),
      "zero-object"
    ).mode;
    if (unknownMode === "throw") {
      const throwEnvConfig = resolveEnvironmentConfig(this.env, this.overrideEnv);
      throw new Error(
        `E*TRADE auth required for ${cleanSym}: no valid OAuth tokens available ` +
        `(quoteStatus=AUTH_REQUIRED, env=${throwEnvConfig.name})`
      );
    }
    return {
      symbol: cleanSym,
      companyName: `${cleanSym} Inc.`,
      lastPrice: 0.0,
      price: 0.0,
      change: 0,
      changePercent: 0,
      bid: 0.0,
      ask: 0.0,
      volume: 0,
      open: 0.0,
      high: 0.0,
      low: 0.0,
      week52High: 0.0,
      week52Low: 0.0,
      quoteStatus: "AUTH_REQUIRED",
      timestamp: new Date().toISOString(),
      source: "E*TRADE Market Data Feed",
    };
  }

  /**
   * Preview a proposed trade order and generate cryptographic Agent DID attestation
   */
  previewOrder(params: OrderPreviewParams): ETradeOrderDraft {
    const symbol = params.symbol.trim().toUpperCase();
    const action = (params.action || params.orderAction || "BUY") as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
    const quote = this.getQuote(symbol);
    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = params.sessionId || this.userLogin;
    const userDid = `did:user:github:${sessionId}`;
    const orderType = params.orderType || "MARKET";

    const executionPrice = orderType === "LIMIT" && params.limitPrice ? params.limitPrice : quote.lastPrice;
    const estimatedTotal = Number((executionPrice * params.quantity).toFixed(2));

    // Issue #118: disclose when the pricing quote is a static fallback (or
    // unavailable) instead of presenting the preview as live-priced.
    const pricingQuoteStatus = quote.quoteStatus;
    const previewMessage = `E*TRADE Order Preview: ${action} ${params.quantity} ${symbol} @ ${orderType === "MARKET" ? "MKT (~$" + quote.lastPrice.toFixed(2) + ")" : "$" + executionPrice.toFixed(2)}. Estimated Total: $${estimatedTotal.toLocaleString()} USD. NO SHARES HAVE BEEN BOUGHT. Awaiting explicit Human-in-the-Loop authorization.${isNonLivePricingQuoteStatus(pricingQuoteStatus) ? ` ${nonLivePricingNotice(pricingQuoteStatus)}` : ""}`;

    const draft: ETradeOrderDraft = {
      orderId,
      symbol,
      action,
      orderAction: action,
      orderType,
      quantity: params.quantity,
      estimatedPrice: executionPrice,
      limitPrice: params.limitPrice,
      stopPrice: params.stopPrice,
      term: "GOOD_FOR_DAY",
      estimatedCommission: 0.0,
      estimatedTotal,
      pricingQuoteStatus,
      status: "previewed",
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: userDid,
      proofSignature: `sig_0x${crypto.randomUUID().slice(0, 16)}`,
      previewMessage,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      placedAt: new Date().toISOString(),
    };

    if (this.orm?.trades) {
      try {
        this.orm.trades.create({
          id: orderId,
          sessionId,
          symbol,
          action,
          orderType,
          quantity: params.quantity,
          price: executionPrice,
          totalValue: estimatedTotal,
          status: "previewed",
          orderRef: undefined,
          proposerDid: draft.proposerDid,
          authorizerDid: userDid,
          proofSignature: draft.proofSignature,
          previewNotes: previewMessage,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn("Failed to persist trade draft to ORM:", err);
      }
    }

    return draft;
  }

  /**
   * Execute an authorized trade order after explicit human confirmation (HITL enforcement)
   */
  async executeOrder(
    orderOrDraft: string | ETradeOrderDraft,
    userLogin: string,
    decision: "approved" | "rejected" = "approved"
  ): Promise<ETradeOrderExecutionResult> {
    const orderId = typeof orderOrDraft === "string" ? orderOrDraft : orderOrDraft.orderId;
    const authorizerDid = userLogin.startsWith("did:") ? userLogin : `did:user:github:${userLogin}`;

    if (authorizerDid.startsWith("did:agent:")) {
      throw new Error(`HITL Violation: Autonomous trade execution is strictly forbidden. Orders require human authorization.`);
    }

    // #2389: the platform's executeOrder is async now that approval
    // places through the real broker client.
    return this.platform.executeOrder(orderId, authorizerDid, decision);
  }

  /**
   * Retrieve active positions and portfolio balances (dynamic, data-driven from executed trades or broker)
   */
  getPositions(): { account: ETradeAccount; positions: ETradePosition[] } {
    const envConfig = resolveEnvironmentConfig(this.env);

    // If trades exist in ORM, aggregate open positions dynamically from confirmed executions
    if (this.orm?.trades) {
      const records = this.orm.trades.findMany({ where: { status: "executed" } });
      if (records.length > 0) {
        const positionsMap = new Map<string, { quantity: number; costBasis: number; symbol: string }>();
        for (const r of records) {
          const sym = r.symbol.toUpperCase();
          const current = positionsMap.get(sym) || { quantity: 0, costBasis: 0, symbol: sym };
          const qty = r.action === "BUY" || r.action === "BUY_TO_COVER" ? r.quantity : -r.quantity;
          const cost = r.totalValue;
          current.quantity += qty;
          current.costBasis += r.action === "BUY" ? cost : -cost;
          if (current.quantity > 0) {
            positionsMap.set(sym, current);
          } else {
            positionsMap.delete(sym);
          }
        }

        const positions: ETradePosition[] = [];
        let totalMarketVal = 0;
        for (const [sym, data] of positionsMap.entries()) {
          const q = this.screener.getUniverse().find((s) => s.symbol === sym);
          const price = q?.lastPrice || (data.quantity > 0 ? Number((data.costBasis / data.quantity).toFixed(2)) : 0);
          const marketValue = Number((price * data.quantity).toFixed(2));
          const totalGain = Number((marketValue - data.costBasis).toFixed(2));
          const totalGainPercent = data.costBasis > 0 ? Number(((totalGain / data.costBasis) * 100).toFixed(2)) : 0;
          totalMarketVal += marketValue;
          positions.push({
            symbol: sym,
            description: q?.companyName || `${sym} Equity`,
            quantity: data.quantity,
            pricePaid: Number((data.costBasis / data.quantity).toFixed(2)),
            costBasis: Number(data.costBasis.toFixed(2)),
            currentPrice: price,
            marketPrice: price,
            marketValue,
            totalGain,
            unrealizedGainLoss: totalGain,
            totalGainPercent,
            unrealizedGainLossPercent: totalGainPercent,
            daysGain: 0,
            daysGainPercent: 0,
          });
        }

        const cash = 25000.0;
        const total = Number((totalMarketVal + cash).toFixed(2));
        return {
          account: {
            accountId: "et_acc_session",
            accountKey: "et_key_session",
            accountDesc: `E*TRADE Active Portfolio [${envConfig.label}]`,
            accountType: "MARGIN",
            netAccountValue: total,
            totalAccountValue: total,
            cashAvailableForInvestment: cash,
            dayTraderStatus: false,
          },
          positions,
        };
      }
    }

    return {
      account: {
        accountId: "unconnected",
        accountKey: "unconnected",
        accountDesc: `E*TRADE Brokerage Account [${envConfig.label} - No Active Live Positions]`,
        accountType: "CASH",
        netAccountValue: 0,
        totalAccountValue: 0,
        cashAvailableForInvestment: 0,
        dayTraderStatus: false,
      },
      positions: [],
    };
  }

  /**
   * Retrieve broker accounts list
   */
  getAccounts(): ETradeAccount[] {
    return [this.getPositions().account];
  }

  /**
   * Real E*TRADE REST API: Fetch live accounts list with OAuth 1.0a
   */
  async fetchAccountsRemote(): Promise<ETradeAccount[]> {
    const accounts = await this.client.fetchAccounts();
    return accounts.length > 0 ? accounts : [];
  }

  /**
   * Real E*TRADE REST API: Fetch live market quote with OAuth 1.0a
   *
   * Issue #1133: `options.includeRawResponse` is forwarded to
   * fetchQuoteDetailed; when set, a live quote carries the parsed wire
   * payload as `raw`. The sandbox fallback path (platform.getQuote)
   * has no wire payload and never carries `raw`.
   */
  async fetchQuoteRemote(
    symbol: string,
    options?: { includeRawResponse?: boolean }
  ): Promise<ETradeQuote> {
    const cleanSym = symbol.trim().toUpperCase();
    const envConfig = this.client.getEnvConfig();
    let quoteError: unknown;
    try {
      // Issue #462: per-call error capture — this method runs concurrently
      // (5 at a time per screener run) on ONE client instance, so reading
      // the shared getLastError() after the await attributed one symbol's
      // failure to another. fetchQuoteDetailed returns the error with the
      // result; nothing is read from shared instance state.
      // Issue #1745: the live client call runs behind the etrade
      // breaker (no fallback: a live failure stays explicit below,
      // never stale cache. No budget here: the client charges its
      // own SubrequestBudget per fetch — charging again would
      // double-count against the run's remaining budget).
      const { quote: live, error } = (
        await withBreaker(
          this.breakerRegistry.breakerFor("etrade"),
          () => this.client.fetchQuoteDetailed(cleanSym, options)
        )
      ).value;
      if (live && live.lastPrice > 0) {
        // #1725 (M7): the inline stub-heuristic copy is replaced by
        // the shared isStubQuote helper (quotePolicies.ts) already
        // used by the platform and fetchQuoteLiveStrict — identical
        // predicate (577.51 / "GOOGLE INC", exempting GOOG/GOOGL),
        // one implementation instead of two. No behavior change.
        if (!isStubQuote(live, cleanSym)) return live;
      }
      quoteError = error ?? undefined;
    } catch (err) {
      quoteError = err;
    }
    if (envConfig.isLive) {
      // Do not turn a failed live request into a stale screener-cache or
      // curated-table price. That was hiding upstream quote errors and made
      // the E*TRADE-only screener report misleading symbol-not-quotable data.
      const detail = quoteError instanceof Error
        ? quoteError.message
        : typeof quoteError === "string" && quoteError
          ? quoteError
          : undefined;
      throw new Error(detail || `E*TRADE returned no live quote for ${cleanSym}`);
    }
    // Sandbox retains its explicit mock/cache behavior for development.
    return this.platform.getQuote(cleanSym);
  }

  /**
   * Real E*TRADE REST API: Fetch live market quotes for many symbols with
   * one authenticated request per broker batch (issue #495).
   *
   * The screener quotes an entire universe (NASDAQ100 = 100 symbols). One
   * HTTP request per symbol exhausts the Worker subrequest budget and trips
   * E*TRADE's quote rate limit — that is how a 100-symbol screen ended up
   * with 47 quotes. The documented quote endpoint takes a comma-separated
   * symbol list, so a universe goes out in a handful of requests.
   *
   * Returns the quotes E*TRADE actually returned; callers diff against the
   * request to find symbols the broker omitted (no substitute data).
   */
  async fetchQuotesRemote(symbols: string[], trace?: any, onWireResponse?: (symbols: string[], payload: unknown) => void): Promise<ETradeQuote[]> {
    const clean = Array.from(
      new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))
    );
    if (clean.length === 0) return [];
    // Sandbox keeps its explicit per-symbol mock behaviour: the batch
    // endpoint has no sandbox fixture, so do not pretend it quoted anything.
    if (!this.client.getEnvConfig().isLive) return [];
    // Issue #816: pass trace only when provided (keeps #495 test pin stable).
    // Issue #1157 (E2): the client's onWireResponse hook is forwarded
    // the same way — options are passed only when at least one is
    // actually supplied, so existing callers see the exact call
    // shapes they always have.
    // Issue #1745: batch quote calls run behind the etrade breaker
    // as one budgeted execution per batch (the #495 shape is kept:
    // one call per batch, not per symbol). No fallback, same rule
    // as fetchQuoteRemote above.
    const etradeBreaker = this.breakerRegistry.breakerFor("etrade");
    if (trace || onWireResponse) {
      return (
        await withBreaker(etradeBreaker, () =>
          this.client.fetchQuotes(clean, {
            ...(trace ? { trace } : {}),
            ...(onWireResponse ? { onWireResponse } : {}),
          })
        )
      ).value;
    }
    return (await withBreaker(etradeBreaker, () => this.client.fetchQuotes(clean))).value;
  }

  /**
   * Real E*TRADE REST API: Remote Preview Order with OAuth 1.0a
   */
  async previewOrderRemote(params: OrderPreviewParams): Promise<ETradeOrderDraft> {
    return this.platform.previewOrder(params);
  }

  /**
   * Real E*TRADE REST API: Place Live Order with OAuth 1.0a
   */
  async placeOrderRemote(params: any): Promise<ETradeOrderExecutionResult> {
    return this.platform.placeOrderRemote!(params);
  }


  /**
   * Real E*TRADE REST API: Fetch live portfolio positions with OAuth 1.0a
   */
  async fetchPortfolioRemote(accountKey?: string, includeBalance: boolean = false): Promise<{ account: ETradeAccount; positions: ETradePosition[] }> {
    const res = await this.platform.getPositions(accountKey, includeBalance);
    if (res && res.account && res.account.accountId !== "unconnected") {
      return res;
    }
    return this.getPositions();
  }

  /**
   * Real E*TRADE REST API: Fetch live transactions list with OAuth 1.0a
   */
  async fetchTransactions(
    accountKey?: string,
    params?: { startDate?: string; endDate?: string; sortOrder?: "ASC" | "DESC"; marker?: string; count?: number }
  ): Promise<ETradeTransaction[]> {
    return this.client.fetchTransactions(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Fetch transaction details with OAuth 1.0a
   */
  async fetchTransactionDetails(
    transactionId: string,
    accountKey?: string,
    storeId?: string
  ): Promise<ETradeTransactionDetails | null> {
    const key = accountKey || (await this.fetchAccountsRemote())[0]?.accountKey || "";
    return this.client.fetchTransactionDetails(key, transactionId, storeId);
  }

  /**
   * Real E*TRADE REST API: Fetch user alerts inbox with OAuth 1.0a
   */
  async fetchAlerts(params?: {
    count?: number;
    category?: string;
    status?: "READ" | "UNREAD" | "DELETED";
    direction?: "ASC" | "DESC";
    search?: string;
    unfiltered?: boolean;
  }): Promise<ETradeAlert[]> {
    return this.client.fetchAlerts(params);
  }

  /**
   * Real E*TRADE REST API: Fetch alert details with OAuth 1.0a
   */
  async fetchAlertDetails(alertId: string | number): Promise<ETradeAlertDetails | null> {
    return this.client.fetchAlertDetails(alertId);
  }

  /**
   * Real E*TRADE REST API: Delete alert with OAuth 1.0a
   */
  async deleteAlert(alertId: string | number): Promise<{ success: boolean; message: string }> {
    return this.client.deleteAlert(alertId);
  }

  /**
   * Real E*TRADE REST API: Product Lookup with OAuth 1.0a
   */
  async lookupProduct(search: string): Promise<ETradeProductLookup[]> {
    return this.client.lookupProduct(search);
  }

  /**
   * Real E*TRADE REST API: Get Option Chains with OAuth 1.0a
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
  }, requestBudget?: import("../trading").OptionRequestBudget): Promise<ETradeOptionChain | null> {
    return requestBudget ? this.client.getOptionChains(params, requestBudget) : this.client.getOptionChains(params);
  }

  /**
   * Real E*TRADE REST API: Get Option Expire Dates with OAuth 1.0a
   */
  async getOptionExpireDates(symbol: string, expiryType?: string, requestBudget?: import("../trading").OptionRequestBudget): Promise<ETradeOptionExpireDate[]> {
    return requestBudget
      ? this.client.getOptionExpireDates(symbol, expiryType, requestBudget)
      : this.client.getOptionExpireDates(symbol, expiryType);
  }

  // Issue #155 note: this class's existing getLastError() (below)
  // already forwards the client's error via the platform — the routes
  // for the two methods above now read it to distinguish upstream
  // failures from genuine empties.

  /**
   * Real E*TRADE REST API: Fetch live orders from exchange with OAuth 1.0a
   */
  async fetchOrdersRemote(
    accountKey?: string,
    params?: { marker?: string; count?: number; status?: string; fromDate?: string; toDate?: string; symbol?: string }
  ): Promise<ETradeRemoteOrder[]> {
    return this.client.fetchOrders(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Cancel order on exchange with OAuth 1.0a
   */
  async cancelOrderRemote(orderId: string | number, accountKey?: string): Promise<ETradeCancelOrderResult> {
    return this.client.cancelOrder(accountKey, orderId);
  }

  /**
   * Real E*TRADE REST API: Preview Changed Order with OAuth 1.0a
   */
  async changeOrderPreviewRemote(
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
    return this.client.changeOrderPreview(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Place Changed Order with OAuth 1.0a
   */
  async changeOrderPlaceRemote(
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
    return this.client.changeOrderPlace(accountKey, params);
  }

  /**
   * Real E*TRADE REST API: Revoke Access Token Remote
   */
  async revokeRemoteAccessToken(): Promise<{ success: boolean; message: string }> {
    return this.client.revokeRemoteAccessToken();
  }

  // =========================================================================
  // Watchlist Management & Screener Results Persistence
  // =========================================================================

  /**
   * Retrieve watchlists from E*TRADE API and local durable SQLite store
   */
  async getWatchlists(): Promise<ETradeWatchlist[]> {
    const remoteList = await this.client.getWatchlists().catch(() => []);
    const localList = this.orm ? this.orm.getWatchlists(this.userLogin) : [];

    const mergedMap = new Map<string, ETradeWatchlist>();

    // Add local SQLite watchlists first
    for (const lw of localList) {
      let symbols: string[] = [];
      try {
        symbols = JSON.parse(lw.symbolsJson);
      } catch {
        symbols = [];
      }

      mergedMap.set(lw.name.toLowerCase(), {
        watchlistId: lw.id,
        name: lw.name,
        symbols,
        createdTimestamp: new Date(lw.createdAt).getTime(),
        updatedTimestamp: new Date(lw.updatedAt).getTime(),
        source: "local_durable_sqlite",
      });
    }

    // Merge upstream E*TRADE API watchlists (upstream takes precedence if name matches)
    for (const rw of remoteList) {
      mergedMap.set(rw.name.toLowerCase(), rw);
    }

    return Array.from(mergedMap.values());
  }

  /**
   * Get details and quotes for a specific watchlist
   */
  async getWatchlistDetails(idOrName: string | number): Promise<ETradeWatchlist | null> {
    const isNumericOrApiId = typeof idOrName === "number" || (!String(idOrName).startsWith("wl_") && !isNaN(Number(idOrName)));

    if (isNumericOrApiId) {
      const remote = await this.client.getWatchlistDetails(idOrName);
      if (remote) return remote;
    }

    // Check local store
    const local = this.orm
      ? (this.orm.getWatchlistById(String(idOrName)) || this.orm.getWatchlistByName(String(idOrName), this.userLogin))
      : null;

    if (local) {
      let symbols: string[] = [];
      let items: any[] = [];
      try {
        symbols = JSON.parse(local.symbolsJson);
      } catch {}
      try {
        items = local.itemsJson ? JSON.parse(local.itemsJson) : [];
      } catch {}

      return {
        watchlistId: local.id,
        name: local.name,
        symbols,
        items,
        source: "local_durable_sqlite",
      };
    }

    return null;
  }

  /**
   * Create a new watchlist across E*TRADE API and local SQLite
   */
  async createWatchlist(params: { name: string; symbols: string[] }): Promise<{
    success: boolean;
    watchlistId: string | number;
    name: string;
    symbols: string[];
    source: "etrade_api" | "local_durable_sqlite";
  }> {
    const cleanSymbols = Array.from(new Set(params.symbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    const cleanName = params.name.trim();

    // 1. Try remote E*TRADE API
    const remoteRes = await this.client.createWatchlist({ name: cleanName, symbols: cleanSymbols });

    const source = remoteRes.success ? ("etrade_api" as const) : ("local_durable_sqlite" as const);
    const watchlistId = remoteRes.success && remoteRes.watchlistId ? remoteRes.watchlistId : `wl_${crypto.randomUUID().slice(0, 10)}`;

    // 2. Persist in durable SQLite
    if (this.orm) {
      this.orm.saveWatchlist({
        id: String(watchlistId),
        name: cleanName,
        userLogin: this.userLogin,
        symbols: cleanSymbols,
        source,
      });
    }

    return {
      success: true,
      watchlistId,
      name: cleanName,
      symbols: cleanSymbols,
      source,
    };
  }

  /**
   * Save screened stocks or options directly into an E*TRADE or local watchlist
   */
  async saveScanAsWatchlist(
    name: string,
    symbols: string[],
    screenItems?: any[]
  ): Promise<SaveWatchlistResult> {
    const cleanSymbols = Array.from(new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    const cleanName = name.trim();

    if (cleanSymbols.length === 0) {
      throw new Error("Cannot save empty watchlist: no valid symbols provided.");
    }

    // Check if watchlist with this name already exists in local SQLite
    const existing = this.orm ? this.orm.getWatchlistByName(cleanName, this.userLogin) : null;

    let watchlistId = existing?.id;
    let source: "etrade_api" | "local_durable_sqlite" = "local_durable_sqlite";

    // Attempt upstream creation or update
    const remoteRes = await this.client.createWatchlist({ name: cleanName, symbols: cleanSymbols });
    if (remoteRes.success && remoteRes.watchlistId) {
      watchlistId = String(remoteRes.watchlistId);
      source = "etrade_api";
    } else if (existing) {
      // Add items upstream if existing
      await this.client.addWatchlistItems({ watchlistId: existing.id, symbols: cleanSymbols }).catch(() => {});
    }

    const mergedSymbols = existing
      ? Array.from(new Set([...JSON.parse(existing.symbolsJson || "[]"), ...cleanSymbols]))
      : cleanSymbols;

    const savedId = watchlistId || `wl_${crypto.randomUUID().slice(0, 10)}`;
    const savedRecord = this.orm
      ? this.orm.saveWatchlist({
          id: savedId,
          name: cleanName,
          userLogin: this.userLogin,
          symbols: mergedSymbols,
          items: screenItems,
          source,
        })
      : { id: savedId };

    // Record audit event
    if (this.orm?.events) {
      this.orm.events.create({
        id: `evt_wl_${crypto.randomUUID().slice(0, 10)}`,
        sessionId: this.userLogin,
        type: "WATCHLIST_SAVED",
        agent: "orchestrator",
        payload: {
          watchlistId: savedRecord.id,
          name: cleanName,
          symbolCount: mergedSymbols.length,
          symbols: mergedSymbols,
          source,
        },
        createdAt: new Date().toISOString(),
      });
    }

    return {
      success: true,
      watchlistId: savedRecord.id,
      name: cleanName,
      symbolCount: mergedSymbols.length,
      symbols: mergedSymbols,
      source,
      message: `Successfully saved ${cleanSymbols.length} screened symbols into watchlist "${cleanName}" (${source === "etrade_api" ? "E*TRADE Live Watchlist" : "Local Durable SQLite"}).`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Delete watchlist by id
   */
  async deleteWatchlist(watchlistId: string | number): Promise<boolean> {
    await this.client.deleteWatchlist(watchlistId).catch(() => {});
    return this.orm ? this.orm.deleteWatchlist(String(watchlistId)) : true;
  }

  getLastError(): string | undefined {
    return this.platform.getLastError?.() || this.client.getLastError();
  }

  /**
   * Issue #2573: structured kind of the recorded `lastError`
   * (see `ETradeRestClient.getLastErrorKind`). The platform delegates
   * to the same client instance, so the client's kind is the source.
   */
  getLastErrorKind(): "token_missing" | "token_expired" | undefined {
    return this.client.getLastErrorKind();
  }
}
