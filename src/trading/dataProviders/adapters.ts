/**
 * Issue #1118 (P1 of epic #1116): built-in DataProvider adapters.
 *
 * Each adapter WRAPS an existing implementation and returns its
 * results UNCHANGED — reference parity, pinned by test, in the #1103
 * adapter method. The payload inside the DataResult envelope is the
 * wrapped implementation's own result object, by reference. Adapters
 * add exactly three things: the platform's provider id, its declared
 * capability set, and the provenance envelope carrying both. They do
 * not convert, filter, enrich, or retry; any of that belongs to later
 * slices and would break parity if smuggled in here.
 *
 *   etrade — ETradeService (src/services/etrade.ts), the REFERENCE
 *            adapter: the full E*TRADE-first lifecycle of epic #1116 is
 *            built against this provider, so its mapping is the
 *            contract's worked example.
 *   yahoo  — YahooFinanceProvider (IMarketDataProvider).
 *   alpaca — AlpacaMarketDataProvider (IMarketDataProvider).
 *   nasdaq — fetchAllUsStockListings (src/services/nasdaqListings.ts),
 *            promoted from a listings helper to a provider: it serves
 *            the screenUniverse capability (universe membership).
 *   public — Public.com's hosted MCP server (src/mcps/public/publicMcp.ts
 *            + publicData.ts), added by #1247: unlike the wrappers
 *            above there is no pre-existing in-repo implementation to
 *            wrap — the adapter maps the MCP tools' payloads into the
 *            contract shapes at this boundary (fields the payloads do
 *            not carry stay absent; see publicData.ts). Its credential
 *            is the signed-in user's Public token set
 *            (src/security/publicOAuth.ts), never an app-level secret.
 *
 * E1 (issue #1133): the E*TRADE adapter optionally takes capture deps;
 * wired with them, every fetch through it writes a capture
 * (captureStore.ts) — the raw payload at the deepest seam reachable
 * (see captureStore.ts's header for the seam analysis) plus the
 * normalized digest, attributed to the caller's run context or a
 * generated collection run. Capture never changes what the fetch
 * returns and never fails it (recordCapture does not throw). Issue
 * #1317 (Yahoo slice) extends the same capture shape to the market-data
 * adapters: the market-data surface has no wire-response hook, so the
 * capture's raw payload is the provider's result itself (rawKind
 * "provider-result", the E*TRADE fallback posture) — the result still
 * travels to the capture store run-linked with its normalized digest.
 * The nasdaq adapter's capture lands with its own slice.
 *
 * E2 (issue #1157): the E*TRADE adapter grows the two methods the
 * screening cutover needs — getQuotesBatch (the stock screener's
 * batch path, capturing one provider-response record per sub-batch
 * via the client's new onWireResponse hook) and getOptionExpiryDates
 * (the options engines' expiry lookup, served under optionsChains) —
 * plus the E*TRADE adapter the stock screener consumes through
 * the platform quote seam in screenerPipeline.ts (#1356).
 *
 * E7 (issue #1248): every fetch above also records its OUTCOME via
 * the FetchOutcomeRecorder port (fetchOutcome.ts): the recorder is
 * derived from the capture deps whenever capture is wired (or
 * injected alone — verifier probes), and each fetch runs through
 * the trackFetchOutcome decorator, so a throwing fetch writes one
 * fetch_failed row and rethrows the identical error, while a
 * successful fetch's only record stays its capture row. The nasdaq
 * adapter takes the recorder by injection only — its capture seam
 * lands with its own slice. Issue #1317 wires the market-data adapters'
 * capture (and, through it, the derived recorder) the same way the
 * E*TRADE adapter derives its own.
 */

import { ETradeService } from "../../services/etrade";
import { AlpacaMarketDataProvider, YahooFinanceProvider } from "../../services/marketDataResearch";
import { PublicMcpClient } from "../../mcps/public/publicMcp";
import {
  PublicDataError,
  extractPublicQuoteRows,
  mapPublicQuoteRow,
  readPublicOptionChain,
  readPublicOptionExpirations,
  readPublicQuotes,
  expiryDateFromYmd,
  type PublicToolRead,
} from "../../services/publicData";
import {
  getPublicAccessToken,
  resolvePublicCredentialRef,
} from "../../security/publicOAuth";
import type { IMarketDataProvider } from "../../patterns/interfaces";
import type {
  Env,
  ETradeOptionChain,
  ETradeOptionExpireDate,
  ETradeQuote,
} from "../../types";
import type { SqlStorage } from "../../orm";
import type { QuoteTrace } from "../etrade/quoteTrace";
import { fetchAllUsStockListings } from "../../services/nasdaqListings";
import {
  BreakerWrappedMarketDataProvider,
  yahooQuoteCacheFallback,
} from "../../breakers/marketDataBreakerWrapper";
import type { CircuitBreaker } from "../../breakers/breakerPorts";
import type {
  DataNewsArticle,
  DataProvider,
  DataProviderCapability,
  DataResult,
  DataRunContext,
  OptionsChainRequest,
} from "./contract";
import { recordCapture, resolveRunContext } from "./captureStore";
import { createCaptureFetchOutcomeRecorder } from "./captureStore";
import {
  trackFetchOutcome,
  type FetchOutcomeMeta,
  type FetchOutcomeRecorder,
} from "./fetchOutcome";
import { runDataProviderConformance } from "./conformance";
import type {
  CaptureBlobEnv,
  CaptureBlobStorage,
  DataCaptureRawKind,
  DataCaptureRecord,
  DataCaptureRetentionClass,
  RecordCaptureInput,
} from "./captureStore";
import type { ProviderCaptureStore } from "../../data/providerCapturePorts";

/** Tag a wrapped result with its provenance envelope (payload by reference). */
function tag<T>(
  providerId: DataProvider["id"],
  capability: DataProvider["capabilities"][number],
  result: T
): DataResult<T> {
  return { providerId, capability, result };
}

/**
 * E7 (issue #1248): run one fetch through the outcome decorator
 * when a recorder is wired, or plainly when none is. The recorder
 * is created from the capture-deps seam (capture.sql) by the
 * adapter factories unless a caller injects one — verifier probes
 * inject the store recorder directly, so a failed verify records
 * fetch_failed rows without a full capture wiring.
 */
async function trackedFetch<T>(
  recorder: FetchOutcomeRecorder | undefined,
  meta: FetchOutcomeMeta,
  fetchFn: () => Promise<T>
): Promise<T> {
  return recorder ? trackFetchOutcome(recorder, meta, fetchFn) : fetchFn();
}

/**
 * The E*TRADE data surface this adapter consumes — the data-path
 * subset of ETradeService. Order/account methods are NOT part of the
 * data-provider contract and are deliberately absent.
 */
export type ETradeDataSurface = Pick<
  ETradeService,
  | "getQuoteAsync"
  | "getOptionChains"
  | "getStatus"
  | "fetchQuotesRemote"
  | "getOptionExpireDates"
>;

/**
 * Capture wiring for the E*TRADE adapter (E1, issue #1133): the
 * capture store's SQL handle and the blob seam's two halves. Supplied
 * by whoever constructs the platform's E*TRADE provider in a context
 * that owns storage (a Durable Object); absent, the adapter is the
 * plain P1 parity wrapper and captures nothing.
 */
export interface ETradeCaptureDeps {
  sql: SqlStorage;
  blobStorage: CaptureBlobStorage;
  env: CaptureBlobEnv;
  retentionClass?: DataCaptureRetentionClass;
  /**
   * #2303 (#1976 step 1): the capture port. When the wiring
   * supplies it, capture writes and outcome recording run
   * through the port (production: the D1 capture log); the sql
   * handle remains for the legacy path and is unused for
   * captures while the port is present. Every provider's capture
   * deps alias this shape (Yahoo/Nasdaq/Public below), so the
   * port threads through all of them uniformly.
   */
  capturePort?: ProviderCaptureStore | null;
}

/**
 * #2303: one capture write through the deps — the port when
 * wired, else the legacy store function. Same input, same
 * never-throws contract either way (the flows are shared code
 * in src/data/providerCapturePorts.ts).
 */
async function recordCaptureViaDeps(
  capture: ETradeCaptureDeps,
  blobDeps: { storage: CaptureBlobStorage; env: CaptureBlobEnv },
  input: RecordCaptureInput
): Promise<DataCaptureRecord | null> {
  return capture.capturePort
    ? capture.capturePort.recordCapture(blobDeps, input)
    : recordCapture(capture.sql, blobDeps, input);
}

/** #2303: the outcome recorder for the deps — port or legacy, as above. */
function outcomeRecorderForDeps(capture: ETradeCaptureDeps): FetchOutcomeRecorder {
  return capture.capturePort
    ? capture.capturePort.createFetchOutcomeRecorder()
    : createCaptureFetchOutcomeRecorder(capture.sql);
}

export interface ETradeDataProviderOptions {
  capture?: ETradeCaptureDeps;
  /**
   * E7 (issue #1248): the fetch-outcome recorder. Absent, it is
   * derived from the capture deps (capture.sql) whenever capture
   * is wired — every capture-wired construction gets outcome
   * tracking by construction. Injected explicitly by callers that
   * record outcomes without full capture wiring (verifier probes).
   */
  outcomeRecorder?: FetchOutcomeRecorder;
  /**
   * E2 (issue #1157): the caller's per-run QuoteTrace (issue #816),
   * forwarded verbatim to fetchQuotesRemote so the screener's trace
   * plumbing survives the platform route unchanged. Fetch-shaping
   * only — it is not part of capture or of the contract's run
   * context; absent, the batch call passes no trace, exactly as a
   * direct fetchQuotesRemote(symbols) call does.
   */
  trace?: QuoteTrace;
}

/**
 * The REST client's raw-chain hook, as a surface type: ETradeService
 * .getOptionChains forwards its params object verbatim to
 * ETradeRestClient.getOptionChains (src/services/etrade.ts), whose
 * declared params include `includeRawResponse` (src/trading/etrade/
 * client.ts) — when set, the returned chain carries the parsed
 * OptionChainResponse object as `raw` (ETradeOptionChain.raw in
 * src/types.ts). The service's own declared params omit the flag, so
 * the capturing path widens the surface type here rather than
 * modifying the service.
 */
type ETradeRawChainSurface = {
  getOptionChains(
    params: OptionsChainRequest & { includeRawResponse?: boolean },
    requestBudget?: import("../interfaces").OptionRequestBudget
  ): Promise<ETradeOptionChain | null>;
};

/**
 * Reference adapter: wraps an ETradeService.
 *
 * Capability mapping:
 *   quotes       → getQuoteAsync(symbol) — the live REST quote path,
 *                  returning the service's ETradeQuote unchanged.
 *   optionsChains → getOptionChains(params) — the request object is
 *                  passed through field-for-field; the service's
 *                  ETradeOptionChain (or null) is returned unchanged.
 *
 * isConfigured defers to the service's own status (ETradeBrokerStatus
 * .configured), so the platform reports configuration exactly as the
 * service itself computes it — no second opinion.
 *
 * With capture deps (E1), the fetches additionally write captures.
 * For chains the capturing path requests the client's raw hook and
 * strips the echoed `raw` from the result the caller receives — the
 * caller gets the same normalized chain the plain path returns (the
 * pairs array by reference); the raw payload lives in the capture.
 * Quotes work the same way: the capturing path requests the client's
 * includeRawResponse hook (forwarded by ETradeService.getQuoteAsync /
 * fetchQuoteRemote to fetchQuoteDetailed) and strips the echoed `raw`
 * from the quote the caller receives. If the wrapped surface does not
 * honor the hook (no `raw` on the returned chain/quote), the result
 * passes through by reference and the capture falls back to it,
 * labeled "provider-result".
 */
export function createETradeDataProvider(
  service: ETradeDataSurface,
  options?: ETradeDataProviderOptions
): DataProvider {
  const capture = options?.capture;
  const outcomeRecorder =
    options?.outcomeRecorder ??
    (capture ? outcomeRecorderForDeps(capture) : undefined);
  return {
    id: "etrade",
    name: "E*TRADE",
    capabilities: ["quotes", "optionsChains"] as const,
    isConfigured: () => service.getStatus().configured,
    getQuote: async (symbol: string, runContext?: DataRunContext) => {
      if (!capture && !outcomeRecorder) {
        return tag("etrade", "quotes", await service.getQuoteAsync(symbol));
      }
      const ctx = resolveRunContext(runContext);
      const result = await trackedFetch(
        outcomeRecorder,
        {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbol },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
        },
        () =>
          capture
            ? service.getQuoteAsync(symbol, { includeRawResponse: true })
            : service.getQuoteAsync(symbol)
      );
      if (!capture) {
        return tag("etrade", "quotes", result);
      }
      let normalized: ETradeQuote = result;
      let rawPayload: unknown = result;
      let rawKind: DataCaptureRawKind = "provider-result";
      if (result.raw !== undefined) {
        const stripped: ETradeQuote = { ...result };
        delete stripped.raw;
        normalized = stripped;
        rawPayload = result.raw;
        rawKind = "provider-response";
      }
      await recordCaptureViaDeps(
        capture,
        { storage: capture.blobStorage, env: capture.env },
        {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbol },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          rawPayload,
          rawKind,
          normalizedResult: normalized,
          retentionClass: capture.retentionClass,
        }
      );
      return tag("etrade", "quotes", normalized);
    },
    getOptionsChain: async (
      request: OptionsChainRequest,
      runContext?: DataRunContext,
      requestBudget?: import("../interfaces").OptionRequestBudget
    ) => {
      const params = {
        symbol: request.symbol,
        expiryYear: request.expiryYear,
        expiryMonth: request.expiryMonth,
        expiryDay: request.expiryDay,
        strikePrice: request.strikePrice,
        noOfStrikes: request.noOfStrikes,
        includeWeekly: request.includeWeekly,
        chainType: request.chainType,
      };
      if (!capture && !outcomeRecorder) {
        return tag(
          "etrade",
          "optionsChains",
          await (requestBudget ? service.getOptionChains(params, requestBudget) : service.getOptionChains(params))
        );
      }
      const ctx = resolveRunContext(runContext);
      const chain = await trackedFetch(
        outcomeRecorder,
        {
          providerId: "etrade",
          capability: "optionsChains",
          requestParams: { ...request },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
        },
        () =>
          capture
            ? (requestBudget
                ? (service as ETradeDataSurface & ETradeRawChainSurface).getOptionChains({
                    ...params,
                    includeRawResponse: true,
                  }, requestBudget)
                : (service as ETradeDataSurface & ETradeRawChainSurface).getOptionChains({
                    ...params,
                    includeRawResponse: true,
                  }))
            : requestBudget
              ? service.getOptionChains(params, requestBudget)
              : service.getOptionChains(params)
      );
      if (!capture) {
        return tag("etrade", "optionsChains", chain);
      }
      const blobDeps = { storage: capture.blobStorage, env: capture.env };
      if (chain === null) {
        // A completed fetch with no payload: an audit row records the
        // attempt (status no_payload); no raw is fabricated for it.
        await recordCaptureViaDeps(capture, blobDeps, {
          providerId: "etrade",
          capability: "optionsChains",
          requestParams: request,
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          retentionClass: capture.retentionClass,
        });
        return tag("etrade", "optionsChains", null);
      }
      let normalized: ETradeOptionChain = chain;
      let rawPayload: unknown = chain;
      let rawKind: DataCaptureRawKind = "provider-result";
      if (chain.raw !== undefined) {
        const stripped: ETradeOptionChain = { ...chain };
        delete stripped.raw;
        normalized = stripped;
        rawPayload = chain.raw;
        rawKind = "provider-response";
      }
      await recordCaptureViaDeps(capture, blobDeps, {
        providerId: "etrade",
        capability: "optionsChains",
        requestParams: request,
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        userLogin: ctx.userLogin,
        rawPayload,
        rawKind,
        normalizedResult: normalized,
        retentionClass: capture.retentionClass,
      });
      return tag("etrade", "optionsChains", normalized);
    },
    getQuotesBatch: async (symbols: string[], runContext?: DataRunContext) => {
      if (!capture && !outcomeRecorder) {
        return tag(
          "etrade",
          "quotes",
          await service.fetchQuotesRemote(symbols, options?.trace)
        );
      }
      // E2 (issue #1157): the client's onWireResponse hook delivers
      // each sub-batch's parsed wire payload as the batch completes;
      // the adapter records ONE capture per sub-batch (rawKind
      // "provider-response", request params = that sub-batch's
      // symbols) and returns the service's normalized quotes exactly
      // as fetchQuotesRemote produced them — no raw ever rides the
      // result (the hook's payloads exist only in this closure and in
      // the captures written from it).
      const ctx = resolveRunContext(runContext);
      const wireBatches: Array<{ symbols: string[]; payload: unknown }> = [];
      const quotes = await trackedFetch(
        outcomeRecorder,
        {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbols },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
        },
        () =>
          capture
            ? service.fetchQuotesRemote(symbols, options?.trace, (batchSymbols, payload) => {
                wireBatches.push({ symbols: batchSymbols, payload });
              })
            : service.fetchQuotesRemote(symbols, options?.trace)
      );
      if (!capture) {
        return tag("etrade", "quotes", quotes);
      }
      const blobDeps = { storage: capture.blobStorage, env: capture.env };
      if (wireBatches.length === 0) {
        // No wire response reached the hook (e.g. the service's
        // sandbox path, which returns [] without a batch request):
        // the result object is the deepest payload at the seam, so
        // it is what is captured, labeled "provider-result" — the
        // run still leaves its audit row, never a fabricated wire
        // payload.
        await recordCaptureViaDeps(capture, blobDeps, {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbols },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          rawPayload: quotes,
          rawKind: "provider-result",
          normalizedResult: quotes,
          retentionClass: capture.retentionClass,
        });
        return tag("etrade", "quotes", quotes);
      }
      for (const batch of wireBatches) {
        const batchSymbols = new Set(batch.symbols);
        await recordCaptureViaDeps(capture, blobDeps, {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbols: batch.symbols },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          rawPayload: batch.payload,
          rawKind: "provider-response",
          normalizedResult: quotes.filter((q) => batchSymbols.has(q.symbol)),
          retentionClass: capture.retentionClass,
        });
      }
      return tag("etrade", "quotes", quotes);
    },
    getOptionExpiryDates: async (
      symbol: string,
      runContext?: DataRunContext,
      requestBudget?: import("../interfaces").OptionRequestBudget
    ) => {
      if (!capture && !outcomeRecorder) {
        return tag(
          "etrade",
          "optionsChains",
          await (requestBudget
            ? service.getOptionExpireDates(symbol, undefined, requestBudget)
            : service.getOptionExpireDates(symbol))
        );
      }
      const ctx = resolveRunContext(runContext);
      const dates = await trackedFetch(
        outcomeRecorder,
        {
          providerId: "etrade",
          capability: "optionsChains",
          requestParams: { symbol, kind: "expiryDates" },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
        },
        () => requestBudget
          ? service.getOptionExpireDates(symbol, undefined, requestBudget)
          : service.getOptionExpireDates(symbol)
      );
      if (!capture) {
        return tag("etrade", "optionsChains", dates);
      }
      // The expiry-dates call has no wire hook on the client, so the
      // service's result is the deepest payload at the seam
      // ("provider-result"); an empty result is a completed fetch
      // with no payload — recorded as a no_payload audit row (the
      // chain-null treatment), never dressed up as a stored payload.
      await recordCaptureViaDeps(
        capture,
        { storage: capture.blobStorage, env: capture.env },
        {
          providerId: "etrade",
          capability: "optionsChains",
          requestParams: { symbol, kind: "expiryDates" },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          ...(dates.length > 0
            ? {
                rawPayload: dates,
                rawKind: "provider-result" as const,
              }
            : {}),
          normalizedResult: dates,
          retentionClass: capture.retentionClass,
        }
      );
      return tag("etrade", "optionsChains", dates);
    },
  };
}

/**
 * E3 (issue #1170): construct the E*TRADE adapter straight from an
 * environment + login — the no-ORM ETradeService form the platform
 * surfaces (lifecycle API reads, servability probes) share. The
 * construction lives here, inside the trading boundary, so the
 * platform owns its provider wiring in one place.
 */
export function createETradeDataProviderFromEnv(
  env: Env,
  userLogin: string,
  options?: ETradeDataProviderOptions
): DataProvider {
  return createETradeDataProvider(
    new ETradeService(env, undefined, userLogin),
    options
  );
}

/**
 * E3 (issue #1170): the E*TRADE verification check the provisioning
 * lifecycle's verify action binds to — the adapter's own status
 * first (a service that reports itself unconfigured fails with
 * that reason, no probe attempted), then the P1 conformance kit
 * against the live adapter. Returns the lifecycle's verify-result
 * shape ({ ok, summary }); never throws — a probe error is a
 * failed verification with the reason, not a crash.
 */
export async function verifyETradeDataProvider(
  env: Env,
  userLogin: string,
  options?: { outcomeRecorder?: FetchOutcomeRecorder }
): Promise<{ ok: boolean; summary: string }> {
  const adapter = createETradeDataProviderFromEnv(env, userLogin, {
    outcomeRecorder: options?.outcomeRecorder,
  });
  if (!adapter.isConfigured(env)) {
    return {
      ok: false,
      summary:
        "E*TRADE service reports not configured (no E*TRADE API credentials or MCP endpoint in the environment).",
    };
  }
  const report = await runDataProviderConformance(adapter);
  if (!report.ok) {
    const failures = report.checks
      .flatMap((c) => c.failures.map((f) => `${c.capability}: ${f}`))
      .join("; ");
    return { ok: false, summary: `E*TRADE adapter conformance failed — ${failures}` };
  }
  return {
    ok: true,
    summary: `E*TRADE adapter status configured; conformance passed for ${report.checks
      .map((c) => c.capability)
      .join(", ")}.`,
  };
}

/**
 * Issue #1356 deleted bindETradeScreenerDeps (the E2 LiveScreenerDeps
 * binding): the stock screener now binds its platform quote seam in
 * screenerPipeline.ts (bindEtradeQuoteDeps /
 * bindLiveQuotesQuoteDeps), which must stay unit-pinnable outside
 * screener-agent.ts (that module extends the real `agents` Durable
 * Object base and cannot be imported under the repo's vitest
 * setup). Callers construct the adapter with
 * createETradeDataProvider (capture + QuoteTrace via its options)
 * and bind it in the pipeline module.
 */

/**
 * Shared market-data adapter: YahooFinanceProvider and AlpacaMarketDataProvider
 * both implement IMarketDataProvider, whose quote/bars/fundamentals
 * surface maps one-for-one onto the contract. Results pass through by
 * reference.
 *
 * E7 (issue #1248): these adapters have no capture seam yet — their
 * capture lands with their add-provider slices (the E1 note) — but
 * the outcome wrapper is construction-level: supply an
 * outcomeRecorder and every fetch is tracked through the same
 * decorator; omit it and the adapter is the plain parity wrapper,
 * exactly as before.
 *
 * Issue #1317 (Yahoo slice): the market-data adapters take the E1 capture
 * seam (options.capture), derived-recorder included, exactly like the
 * E*TRADE adapter. The market-data surface exposes no wire-response hook,
 * so the capture's raw payload is the provider's result itself
 * (rawKind "provider-result"); the normalized digest is computed over
 * the same result. A throwing fetch writes fetch_failed via the
 * decorator and rethrows unchanged; a capture-write failure writes
 * the capture_failed marker via recordCapture and never fails the
 * fetch. The batch method exists only when the wrapped provider
 * offers getQuotes (YahooFinanceProvider does; the interface does
 * not declare it) — one capture per batch call, mirroring the
 * E*TRADE batch's one-record-per-sub-batch posture.
 */
export interface MarketDataProviderOptions {
  capture?: ETradeCaptureDeps;
  /**
   * E7 (issue #1248): the fetch-outcome recorder. Absent, it is
   * derived from the capture deps (capture.sql) whenever capture
   * is wired — every capture-wired construction gets outcome
   * tracking by construction. Injected explicitly by callers that
   * record outcomes without full capture wiring (verifier probes).
   */
  outcomeRecorder?: FetchOutcomeRecorder;
  /**
   * Issue #1745: opt-in breaker. When supplied, the provider is
   * wrapped in the breaker Decorator (Yahoo quotes fall back to the
   * stamped cache; everything else surfaces business errors).
   * Absent, the raw provider is used — verifiers and conformance
   * tests pass no breaker and are unaffected.
   */
  breaker?: CircuitBreaker;
  /**
   * #3932 — the news fetcher, when this adapter serves the news
   * capability. Supplied, the adapter declares "news" and serves
   * getNews through it (tracked + captured like every other
   * capability); absent, the capability is not declared (ISP —
   * the Alpaca adapter passes none). The Yahoo adapter defaults
   * this to fetchYahooNewsArticles below.
   */
  news?: (
    symbol: string,
    runContext?: DataRunContext,
  ) => Promise<DataNewsArticle[]>;
}

function createMarketDataProvider(
  id: "yahoo" | "alpaca",
  name: string,
  provider: IMarketDataProvider,
  env?: Env,
  options?: MarketDataProviderOptions
): DataProvider {
  const capture = options?.capture;
  const outcomeRecorder =
    options?.outcomeRecorder ??
    (capture ? outcomeRecorderForDeps(capture) : undefined);
  const meta = (
    capability: DataProvider["capabilities"][number],
    requestParams: Record<string, unknown>,
    runContext?: DataRunContext
  ): FetchOutcomeMeta => {
    const ctx = resolveRunContext(runContext);
    return {
      providerId: id,
      capability,
      requestParams,
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      userLogin: ctx.userLogin,
    };
  };
  const captureFetch = async (
    capability: DataProvider["capabilities"][number],
    requestParams: Record<string, unknown>,
    result: unknown,
    runContext?: DataRunContext
  ): Promise<void> => {
    if (!capture) return;
    const ctx = resolveRunContext(runContext);
    await recordCaptureViaDeps(
      capture,
      { storage: capture.blobStorage, env: capture.env },
      {
        providerId: id,
        capability,
        requestParams,
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        userLogin: ctx.userLogin,
        rawPayload: result,
        rawKind: "provider-result",
        normalizedResult: result,
        retentionClass: capture.retentionClass,
      }
    );
  };
  // Issue #1745: breaker decoration is opt-in (see the breaker field
  // on MarketDataProviderOptions). The wrapped provider preserves the
  // optional getQuotes shape, so the batch dep below still appears
  // exactly when the inner provider offers it.
  const effectiveProvider = options?.breaker
    ? new BreakerWrappedMarketDataProvider(
        provider,
        options.breaker,
        id === "yahoo"
          ? { getQuote: (symbol) => Promise.resolve(yahooQuoteCacheFallback(symbol)) }
          : {}
      )
    : provider;
  const batchProvider = effectiveProvider as IMarketDataProvider & {
    getQuotes?: (symbols: string[]) => Promise<import("../../types").MarketDataResearchQuote[]>;
  };
  const newsFetcher = options?.news;
  // #3932: "news" is declared exactly when a news fetcher is
  // supplied (ISP — the Yahoo adapter supplies one, Alpaca none).
  const capabilities: readonly DataProviderCapability[] = newsFetcher
    ? ["quotes", "historicalBars", "fundamentals", "news"]
    : ["quotes", "historicalBars", "fundamentals"];
  return {
    id,
    name,
    capabilities,
    isConfigured: () => effectiveProvider.isConfigured(env),
    getQuote: async (symbol: string, runContext?: DataRunContext) => {
      const result = await trackedFetch(outcomeRecorder, meta("quotes", { symbol }, runContext), () =>
        effectiveProvider.getQuote(symbol)
      );
      await captureFetch("quotes", { symbol }, result, runContext);
      return tag(id, "quotes", result);
    },
    getHistoricalBars: async (symbol: string, timeframe?: string, limit?: number, runContext?: DataRunContext) => {
      const result = await trackedFetch(
        outcomeRecorder,
        meta("historicalBars", { symbol, timeframe: timeframe ?? null, limit: limit ?? null }, runContext),
        () => effectiveProvider.getHistoricalBars(symbol, timeframe, limit)
      );
      await captureFetch(
        "historicalBars",
        { symbol, timeframe: timeframe ?? null, limit: limit ?? null },
        result,
        runContext
      );
      return tag(id, "historicalBars", result);
    },
    getFundamentals: async (symbol: string, runContext?: DataRunContext) => {
      const result = await trackedFetch(outcomeRecorder, meta("fundamentals", { symbol }, runContext), () =>
        effectiveProvider.getFundamentals(symbol)
      );
      await captureFetch("fundamentals", { symbol }, result, runContext);
      return tag(id, "fundamentals", result);
    },
    // #3932 — news, served through the injected fetcher (the
    // Yahoo adapter defaults it to fetchYahooNewsArticles). The
    // method exists exactly when the capability is declared.
    ...(newsFetcher
      ? {
          getNews: async (symbol: string, runContext?: DataRunContext) => {
            const result = await trackedFetch(
              outcomeRecorder,
              meta("news", { symbol }, runContext),
              () => newsFetcher(symbol, runContext),
            );
            await captureFetch("news", { symbol }, result, runContext);
            return tag(id, "news", result);
          },
        }
      : {}),
    ...(typeof batchProvider.getQuotes === "function"
      ? {
          getQuotesBatch: async (symbols: string[], runContext?: DataRunContext) => {
            const result = await trackedFetch(
              outcomeRecorder,
              meta("quotes", { symbols }, runContext),
              () => batchProvider.getQuotes!(symbols)
            );
            await captureFetch("quotes", { symbols }, result, runContext);
            return tag(id, "quotes", result);
          },
        }
      : {}),
  };
}

/** Capture wiring for the Yahoo adapter: identical shape to E*TRADE's (E1). */
export type YahooCaptureDeps = ETradeCaptureDeps;

export interface YahooDataProviderOptions {
  capture?: YahooCaptureDeps;
  /**
   * E7 (issue #1248): the fetch-outcome recorder — derived from the
   * capture deps whenever capture is wired, injectable on its own
   * for verifier probes (see ETradeDataProviderOptions).
   */
  outcomeRecorder?: FetchOutcomeRecorder;
  /**
   * Issue #1745: opt-in breaker, forwarded to createMarketDataProvider
   * (same semantics as MarketDataProviderOptions.breaker).
   */
  breaker?: CircuitBreaker;
  /**
   * #3932 — the news fetcher, injectable for tests (a stub
   * returning fixture articles). Absent, the Yahoo News search
   * fetch below serves the capability.
   */
  news?: (
    symbol: string,
    runContext?: DataRunContext,
  ) => Promise<DataNewsArticle[]>;
}

/**
 * #3932 (sub-issue of #3929) — the Yahoo News fetch behind the
 * adapter's news capability: the Yahoo Finance search endpoint's
 * news items for one symbol, normalized to DataNewsArticle. The
 * call mirrors #132's fetchRealMarketNews proven shape (the same
 * endpoint, the same User-Agent, quotesCount=1) — the live-UI
 * fetch in flowService.ts stays untouched; this is the
 * provider-port fetch the sentiment feed job runs through.
 * A failed Yahoo response THROWS (the job records it as a
 * per-symbol failure, never as an empty feed); a 200 with no
 * news returns [] (no news for the symbol is a named gap, not
 * an error). Items without a headline are skipped — an article
 * without a headline is not a conformant article.
 */
export async function fetchYahooNewsArticles(
  symbol: string,
  newsCount = 5,
): Promise<DataNewsArticle[]> {
  const clean = symbol.toUpperCase().trim();
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(clean)}&quotesCount=1&newsCount=${newsCount}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Yahoo news search failed for "${clean}" (HTTP ${res.status})`,
    );
  }
  const data: unknown = await res.json();
  const rawNews: unknown[] = Array.isArray(
    (data as { news?: unknown } | null)?.news,
  )
    ? (data as { news: unknown[] }).news
    : [];
  const now = Date.now();
  const articles: DataNewsArticle[] = [];
  for (const [idx, raw] of rawNews.entries()) {
    const item = raw as Record<string, unknown>;
    const headline = typeof item.title === "string" ? item.title.trim() : "";
    if (!headline) continue;
    const pubSeconds =
      typeof item.providerPublishTime === "number" &&
      item.providerPublishTime > 0
        ? item.providerPublishTime
        : null;
    const article: DataNewsArticle = {
      headline,
      source:
        typeof item.publisher === "string" && item.publisher.trim() !== ""
          ? item.publisher
          : "Yahoo News",
      publishedAt:
        pubSeconds !== null
          ? new Date(pubSeconds * 1000).toISOString()
          : new Date(now - idx * 180000).toISOString(),
      symbol: clean,
      ...(typeof item.link === "string" && item.link !== ""
        ? { url: item.link }
        : {}),
      ...(typeof item.summary === "string" && item.summary !== ""
        ? { summary: item.summary }
        : {}),
    };
    articles.push(article);
  }
  return articles;
}

/** Yahoo adapter — wraps YahooFinanceProvider (the market-data "yfinance" impl). */
export function createYahooDataProvider(
  provider: IMarketDataProvider,
  env?: Env,
  options?: YahooDataProviderOptions
): DataProvider {
  return createMarketDataProvider("yahoo", "Yahoo Finance", provider, env, {
    ...options,
    // #3932 — the Yahoo adapter declares news by default, served
    // by the Yahoo News search fetch (default 5 articles per
    // symbol); tests inject a stub. The wrapper adapts the
    // fetcher's (symbol, count) shape to the options' (symbol,
    // runContext) shape — the adapter's tracking/capture wraps
    // the call, so the fetcher itself takes no run context.
    news: options?.news ?? ((symbol: string) => fetchYahooNewsArticles(symbol)),
  });
}

/** Alpaca adapter — wraps AlpacaMarketDataProvider. */
export function createAlpacaDataProvider(
  provider: IMarketDataProvider,
  env?: Env,
  options?: MarketDataProviderOptions
): DataProvider {
  return createMarketDataProvider("alpaca", "Alpaca Markets", provider, env, options);
}

/**
 * Issue #1317: the Yahoo lifecycle verifier, mirroring
 * verifyETradeDataProvider — configuration from the market-data provider's
 * own isConfigured, then the conformance kit over the adapter. The
 * provider is injectable for tests; production constructs the real
 * YahooFinanceProvider from env. A failed conformance fails
 * verification (never a silent pass).
 */
export async function verifyYahooDataProvider(
  env?: Env,
  options?: {
    provider?: IMarketDataProvider;
    outcomeRecorder?: FetchOutcomeRecorder;
    /** #3932 — injectable news fetcher (tests stub it; production
     *  uses the Yahoo News search fetch by default). */
    news?: (
      symbol: string,
      runContext?: DataRunContext,
    ) => Promise<DataNewsArticle[]>;
  }
): Promise<{ ok: boolean; summary: string }> {
  const adapter = createYahooDataProvider(
    options?.provider ?? new YahooFinanceProvider(env),
    env,
    {
      outcomeRecorder: options?.outcomeRecorder,
      ...(options?.news ? { news: options.news } : {}),
    }
  );
  if (!adapter.isConfigured(env)) {
    return {
      ok: false,
      summary:
        "Yahoo Finance provider reports not configured.",
    };
  }
  const report = await runDataProviderConformance(adapter);
  if (!report.ok) {
    const failures = report.checks
      .flatMap((c) => c.failures.map((f) => `${c.capability}: ${f}`))
      .join("; ");
    return { ok: false, summary: `Yahoo adapter conformance failed — ${failures}` };
  }
  return {
    ok: true,
    summary: `Yahoo adapter status configured; conformance passed for ${report.checks
      .map((c) => c.capability)
      .join(", ")}.`,
  };
}

/**
 * Issue #1385: the Alpaca lifecycle verifier, mirroring
 * verifyYahooDataProvider — configuration from the market-data provider's
 * own isConfigured (key AND secret required — NOT
 * configured-by-construction, unlike nasdaq's public feed), then
 * the conformance kit over the adapter. The provider is injectable
 * for tests; production constructs the real AlpacaMarketDataProvider
 * from env. A failed conformance fails verification (never a
 * silent pass).
 */
export async function verifyAlpacaDataProvider(
  env?: Env,
  options?: {
    provider?: IMarketDataProvider;
    outcomeRecorder?: FetchOutcomeRecorder;
  }
): Promise<{ ok: boolean; summary: string }> {
  const adapter = createAlpacaDataProvider(
    options?.provider ?? new AlpacaMarketDataProvider(env),
    env,
    { outcomeRecorder: options?.outcomeRecorder }
  );
  if (!adapter.isConfigured(env)) {
    return {
      ok: false,
      summary: "Alpaca provider reports not configured.",
    };
  }
  const report = await runDataProviderConformance(adapter);
  if (!report.ok) {
    const failures = report.checks
      .flatMap((c) => c.failures.map((f) => `${c.capability}: ${f}`))
      .join("; ");
    return { ok: false, summary: `Alpaca adapter conformance failed — ${failures}` };
  }
  return {
    ok: true,
    summary: `Alpaca adapter status configured; conformance passed for ${report.checks
      .map((c) => c.capability)
      .join(", ")}.`,
  };
}

/** Capture wiring for the Nasdaq adapter: identical shape to E*TRADE's (E1). */
export type NasdaqCaptureDeps = ETradeCaptureDeps;

export interface NasdaqDataProviderOptions {
  capture?: NasdaqCaptureDeps;
  /**
   * E7 (issue #1248): the fetch-outcome recorder — derived from the
   * capture deps whenever capture is wired, injectable on its own
   * for verifier probes (see ETradeDataProviderOptions).
   */
  outcomeRecorder?: FetchOutcomeRecorder;
}

/**
 * Nasdaq adapter — wraps the listings fetch. The fetcher is injectable
 * (nasdaqListings' own seam: fetchAllUsStockListings already accepts a
 * fetch implementation) so tests and later slices can substitute the
 * transport without touching the adapter.
 *
 * Issue #1368 (Nasdaq slice): the adapter takes the E1 capture seam
 * (options.capture), derived-recorder included, exactly like the
 * market-data adapters. The listings surface exposes no wire-response hook,
 * so the capture's raw payload is the provider's result itself
 * (rawKind "provider-result"); the normalized digest is computed over
 * the same result. A throwing fetch writes fetch_failed via the
 * decorator and rethrows unchanged; a capture-write failure writes
 * the capture_failed marker via recordCapture and never fails the
 * fetch. The listings module stays the adapter's fetcher — call sites
 * move to the adapter, the module is not duplicated.
 */
export function createNasdaqDataProvider(
  fetchListings: typeof fetchAllUsStockListings = fetchAllUsStockListings,
  options?: NasdaqDataProviderOptions
): DataProvider {
  const capture = options?.capture;
  const outcomeRecorder =
    options?.outcomeRecorder ??
    (capture ? outcomeRecorderForDeps(capture) : undefined);
  return {
    id: "nasdaq",
    name: "Nasdaq Listings",
    capabilities: ["screenUniverse"] as const,
    // Public listings feed, no credentials — configured by construction,
    // matching the market-data provider-status semantics for Yahoo.
    isConfigured: () => true,
    getScreenUniverse: async (runContext?: DataRunContext) => {
      const ctx = resolveRunContext(runContext);
      const result = await trackedFetch(
        outcomeRecorder,
        {
          providerId: "nasdaq",
          capability: "screenUniverse",
          requestParams: {},
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
        },
        () => fetchListings()
      );
      if (capture) {
        await recordCaptureViaDeps(
          capture,
          { storage: capture.blobStorage, env: capture.env },
          {
            providerId: "nasdaq",
            capability: "screenUniverse",
            requestParams: {},
            runId: ctx.runId,
            tenantId: ctx.tenantId,
            userLogin: ctx.userLogin,
            rawPayload: result,
            rawKind: "provider-result",
            normalizedResult: result,
            retentionClass: capture.retentionClass,
          }
        );
      }
      return tag("nasdaq", "screenUniverse", result);
    },
  };
}

/**
 * Issue #1368: the Nasdaq lifecycle verifier, mirroring
 * verifyYahooDataProvider — configuration by construction (the public
 * listings feed carries no credentials), then the conformance kit
 * over the adapter. The listings fetcher is injectable for tests;
 * production uses the module default. A failed conformance fails
 * verification (never a silent pass).
 */
export async function verifyNasdaqDataProvider(
  options?: {
    fetchListings?: typeof fetchAllUsStockListings;
    outcomeRecorder?: FetchOutcomeRecorder;
  }
): Promise<{ ok: boolean; summary: string }> {
  const adapter = createNasdaqDataProvider(options?.fetchListings, {
    outcomeRecorder: options?.outcomeRecorder,
  });
  if (!adapter.isConfigured()) {
    return {
      ok: false,
      summary: "Nasdaq provider reports not configured.",
    };
  }
  const report = await runDataProviderConformance(adapter);
  if (!report.ok) {
    const failures = report.checks
      .flatMap((c) => c.failures.map((f) => `${c.capability}: ${f}`))
      .join("; ");
    return { ok: false, summary: `Nasdaq adapter conformance failed — ${failures}` };
  }
  return {
    ok: true,
    summary: `Nasdaq adapter status configured; conformance passed for ${report.checks
      .map((c) => c.capability)
      .join(", ")}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Public.com (issue #1247)                                            */
/* ------------------------------------------------------------------ */

/** Capture wiring for the Public adapter: identical shape to E*TRADE's (E1). */
export type PublicCaptureDeps = ETradeCaptureDeps;

export interface PublicDataProviderOptions {
  capture?: PublicCaptureDeps;
  /**
   * E7 (issue #1248): the fetch-outcome recorder — derived from the
   * capture deps whenever capture is wired, injectable on its own
   * for verifier probes (see ETradeDataProviderOptions).
   */
  outcomeRecorder?: FetchOutcomeRecorder;
  /** Transport seam (tests); production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Public adapter — the platform's first MCP-backed provider.
 *
 * Unlike the wrappers above, there is no pre-existing implementation
 * whose results pass through by reference: the wrapped surface is
 * Public's hosted MCP server, whose tool payloads are unpublished.
 * The reads (src/services/publicData.ts) map those payloads into the
 * contract shapes at this boundary — liberally in field naming (the
 * shapes are not published), strictly in honesty (a field the payload
 * does not carry stays absent; Greeks map only where the payload
 * carries them). Provenance rides the same envelope as every adapter.
 *
 * Declared capabilities are exactly the grounded ones: quotes and
 * optionsChains (expirations + chain). News and historical bars are
 * NOT declared — the MCP tool surface this slice is grounded on
 * (cfpay, verified live) covers the three data tools only.
 *
 * With capture deps (E1), every fetch writes a capture whose raw
 * payload is the tool call's wire payload (the parsed tool result;
 * the raw text when it does not parse), rawKind "provider-response",
 * with the exact schema-mapped args in the request params — the same
 * audit posture as the E*TRADE adapter.
 *
 * isConfigured reports construction wiring only: the credential lives
 * behind the async SessionStore, so the REAL configuration check is
 * verifyPublicDataProvider (token resolution + tools/list +
 * conformance), which the lifecycle's verify action binds.
 */
export function createPublicDataProvider(
  client: PublicMcpClient,
  options?: PublicDataProviderOptions
): DataProvider {
  const capture = options?.capture;
  const outcomeRecorder =
    options?.outcomeRecorder ??
    (capture ? outcomeRecorderForDeps(capture) : undefined);

  /**
   * E7: run one read (the MCP fetch + its interpretation — for
   * this adapter the read IS the fetch boundary) through the
   * outcome decorator when a recorder is wired. Callers pass the
   * pre-resolved run context (see effectiveRunContext in the
   * methods below) so the failure row and the success capture for
   * one call share one attribution.
   */
  async function trackedRead<T>(
    capability: "quotes" | "optionsChains",
    requestParams: Record<string, unknown>,
    runContext: DataRunContext | undefined,
    readFn: () => Promise<T>
  ): Promise<T> {
    if (!outcomeRecorder) return readFn();
    const ctx = resolveRunContext(runContext);
    return trackFetchOutcome(
      outcomeRecorder,
      {
        providerId: "public",
        capability,
        requestParams,
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        userLogin: ctx.userLogin,
      },
      readFn
    );
  }

  /** The run context the methods below thread through: pre-resolved when recording (see trackedRead). */
  function effectiveRunContext(runContext?: DataRunContext): DataRunContext | undefined {
    if (!outcomeRecorder) return runContext;
    const ctx = resolveRunContext(runContext);
    return {
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      ...(ctx.userLogin ? { userLogin: ctx.userLogin } : {}),
    };
  }

  async function captureRead(
    capability: "quotes" | "optionsChains",
    read: PublicToolRead,
    normalizedResult: unknown,
    runContext?: DataRunContext
  ): Promise<void> {
    if (!capture) return;
    const ctx = resolveRunContext(runContext);
    await recordCaptureViaDeps(
      capture,
      { storage: capture.blobStorage, env: capture.env },
      {
        providerId: "public",
        capability,
        requestParams: { tool: read.tool, args: read.args },
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        userLogin: ctx.userLogin,
        rawPayload: read.payload !== undefined ? read.payload : read.text,
        rawKind: "provider-response" as DataCaptureRawKind,
        normalizedResult,
        retentionClass: capture.retentionClass,
      }
    );
  }

  async function captureNoPayload(
    capability: "quotes" | "optionsChains",
    requestParams: Record<string, unknown>,
    normalizedResult: unknown,
    runContext?: DataRunContext
  ): Promise<void> {
    if (!capture) return;
    const ctx = resolveRunContext(runContext);
    // A completed fetch with no payload: an audit row records the
    // attempt (status no_payload); no raw is fabricated for it — the
    // E*TRADE adapter's null-chain treatment.
    await recordCaptureViaDeps(
      capture,
      { storage: capture.blobStorage, env: capture.env },
      {
        providerId: "public",
        capability,
        requestParams,
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        userLogin: ctx.userLogin,
        normalizedResult,
        retentionClass: capture.retentionClass,
      }
    );
  }

  return {
    id: "public",
    name: "Public.com",
    capabilities: ["quotes", "optionsChains"] as const,
    isConfigured: () => true,
    getQuote: async (symbol: string, runContext?: DataRunContext) => {
      const ctx = effectiveRunContext(runContext);
      const { read, quote } = await trackedRead(
        "quotes",
        { tool: "get_quotes", symbols: [symbol] },
        ctx,
        async () => {
          const read = await readPublicQuotes(client, [symbol]);
          const fetchedAt = new Date().toISOString();
          const wanted = symbol.toUpperCase();
          const row = extractPublicQuoteRows(read.payload).find((r) => {
            const direct = typeof r.symbol === "string" ? r.symbol : undefined;
            const nested =
              r.instrument && typeof r.instrument === "object"
                ? (r.instrument as { symbol?: unknown }).symbol
                : undefined;
            return (
              (typeof direct === "string" && direct.toUpperCase() === wanted) ||
              (typeof nested === "string" && nested.toUpperCase() === wanted)
            );
          });
          const quote = row ? mapPublicQuoteRow(row, fetchedAt) : null;
          if (!quote) {
            throw new PublicDataError(
              `Public.com get_quotes returned no usable quote for ${symbol}.`
            );
          }
          return { read, quote };
        }
      );
      await captureRead("quotes", read, quote, ctx);
      return tag("public", "quotes", quote);
    },
    getQuotesBatch: async (symbols: string[], runContext?: DataRunContext) => {
      const ctx = effectiveRunContext(runContext);
      const { read, quotes } = await trackedRead(
        "quotes",
        { tool: "get_quotes", symbols },
        ctx,
        async () => {
          const read = await readPublicQuotes(client, symbols);
          const fetchedAt = new Date().toISOString();
          const quotes = extractPublicQuoteRows(read.payload)
            .map((r) => mapPublicQuoteRow(r, fetchedAt))
            .filter((q): q is ETradeQuote => q !== null);
          return { read, quotes };
        }
      );
      await captureRead("quotes", read, quotes, ctx);
      return tag("public", "quotes", quotes);
    },
    getOptionExpiryDates: async (symbol: string, runContext?: DataRunContext) => {
      const ctx = effectiveRunContext(runContext);
      const { read, dates } = await trackedRead(
        "optionsChains",
        { tool: "get_option_expirations", symbol },
        ctx,
        async () => {
          const read = await readPublicOptionExpirations(client, symbol);
          const dates = read.expirations
            .map((ymd) => expiryDateFromYmd(ymd))
            .filter((d): d is ETradeOptionExpireDate => d !== null);
          return { read, dates };
        }
      );
      if (dates.length > 0) {
        await captureRead("optionsChains", read, dates, ctx);
      } else {
        await captureNoPayload(
          "optionsChains",
          { tool: read.tool, args: read.args },
          dates,
          ctx
        );
      }
      return tag("public", "optionsChains", dates);
    },
    getOptionsChain: async (
      request: OptionsChainRequest,
      runContext?: DataRunContext
    ) => {
      const ctx = effectiveRunContext(runContext);
      const expiry =
        request.expiryYear && request.expiryMonth && request.expiryDay
          ? `${request.expiryYear}-${String(request.expiryMonth).padStart(2, "0")}-${String(
              request.expiryDay
            ).padStart(2, "0")}`
          : null;
      const { read, chain } = await trackedRead(
        "optionsChains",
        { tool: "get_option_chain", symbol: request.symbol },
        ctx,
        async () => {
          const read = await readPublicOptionChain(client, request.symbol, expiry);
          let chain = read.chain;
          if (chain && request.chainType && request.chainType !== "CALLPUT") {
            const keep = request.chainType === "CALL" ? "call" : "put";
            chain = {
              ...chain,
              pairs: chain.pairs.map((p) => ({ [keep]: p[keep] })),
            };
          }
          return { read, chain };
        }
      );
      if (chain === null) {
        await captureNoPayload(
          "optionsChains",
          { tool: read.tool, args: read.args },
          null,
          ctx
        );
      } else {
        await captureRead("optionsChains", read, chain, ctx);
      }
      return tag("public", "optionsChains", chain);
    },
  };
}

/**
 * Construct the Public adapter straight from an environment + login —
 * the from-env factory the platform surfaces share, mirroring
 * createETradeDataProviderFromEnv. The token source is the user's
 * stored Public token set (src/security/publicOAuth.ts), read for
 * EXACTLY this login: a missing login resolves to no token (an honest
 * refusal downstream), never to another identity's credential.
 */
export function createPublicDataProviderFromEnv(
  env: Env,
  userLogin: string,
  options?: PublicDataProviderOptions
): DataProvider {
  const fetchImpl = options?.fetchImpl;
  const client = new PublicMcpClient({
    accessTokenProvider: () => getPublicAccessToken(env, userLogin, fetchImpl),
    fetchImpl,
  });
  return createPublicDataProvider(client, options);
}

/**
 * The Public verification check the provisioning lifecycle's verify
 * action binds to — verifyETradeDataProvider's shape: resolve the
 * configured credential REFERENCE first (no reference, or a reference
 * with nothing usable behind it, fails with that reason and no probe
 * is attempted), then run the P1 conformance kit against the live
 * adapter. Returns { ok, summary }; never throws.
 */
export async function verifyPublicDataProvider(
  env: Env,
  userLogin: string,
  credentialRef: string | null,
  options?: { fetchImpl?: typeof fetch; outcomeRecorder?: FetchOutcomeRecorder }
): Promise<{ ok: boolean; summary: string }> {
  const resolution = await resolvePublicCredentialRef(
    env,
    userLogin,
    credentialRef,
    options?.fetchImpl
  );
  if (!resolution.ok) {
    return { ok: false, summary: resolution.error };
  }
  const client = new PublicMcpClient({
    accessTokenProvider: async () => resolution.accessToken,
    fetchImpl: options?.fetchImpl,
  });
  const adapter = createPublicDataProvider(client, {
    outcomeRecorder: options?.outcomeRecorder,
  });
  const report = await runDataProviderConformance(adapter);
  if (!report.ok) {
    const failures = report.checks
      .flatMap((c) => c.failures.map((f) => `${c.capability}: ${f}`))
      .join("; ");
    return { ok: false, summary: `Public adapter conformance failed — ${failures}` };
  }
  return {
    ok: true,
    summary: `Public credential resolved via its configured reference; conformance passed for ${report.checks
      .map((c) => c.capability)
      .join(", ")}.`,
  };
}
