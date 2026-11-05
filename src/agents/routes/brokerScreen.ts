/**
 * Issue #3272 (S2, programme #3216): the broker-neutral stock screen.
 *
 *   POST /broker/screen  { symbols: string[], filter?: StockScreenerFilter }
 *
 * Why a new route: `/etrade/screen` lives in the E*TRADE broker module, needs
 * an E*TRADE login, and gathers its universe through the E*TRADE client. That
 * is fine for E*TRADE and impossible for anyone else. Screening is declared
 * provider-side (#2144) and `Alpaca.marketScreening` is `false` — no broker-side
 * screener API is expected — so the platform does the math and only the quotes
 * come from the selected broker.
 *
 * Honesty rules, identical to `/broker/options/*`:
 *   - a broker without a quote read answers `501 provider_unsupported` naming
 *     it, before any platform is constructed;
 *   - every symbol that could not be read is reported under its own name in
 *     `failures`; nothing is filled in from another source;
 *   - an empty universe is a `400` naming what is missing, never a silent
 *     "no matches".
 *
 * Scope: synchronous only, with a hard cap on symbols (`MAX_SCREEN_SYMBOLS`)
 * because every quote is one upstream subrequest. The async workflow screen and
 * the E*TRADE listings branch are deliberately out of scope — they are separate
 * data paths, not quote gathers.
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import {
  TradingPlatformRegistry,
  brokerSupports,
  gatherQuotes,
  platformQuoteSource,
  screenSymbolsWithSource,
} from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";

export interface BrokerScreenRouteContext {
  env: Env;
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
}

/** Hard cap: every symbol is one upstream quote read. */
export const MAX_SCREEN_SYMBOLS = 25;

export async function handleBrokerScreenRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerScreenRouteContext,
): Promise<Response | null> {
  if (!path.endsWith("/broker/screen")) return null;
  if (request.method !== "POST") return null;

  const body = ((await request.json().catch(() => ({}))) as any) ?? {};
  const rawSymbols = Array.isArray(body.symbols) ? body.symbols : [];
  // Issue #3272 (stock UI): a named universe resolves through the LIVE listings
  // feed. No curated substitution: if the feed fails the answer is coded, not
  // a plausible-looking table (the rule #1554 set for listings).
  const requestedUniverse = typeof body.universe === "string" && body.universe.trim() ? body.universe.trim().toUpperCase() : null;
  const symbols: string[] = Array.from(
    new Set<string>(
      rawSymbols
        .filter((s: unknown): s is string => typeof s === "string")
        .map((s: string) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  let universe: string | null = null;
  let universeSize = 0;
  let truncated = false;
  if (symbols.length === 0) {
    const id = requestedUniverse ?? "NASDAQ100";
    try {
      const { fetchAllUsStockListings } = await import("../../services/nasdaqListings");
      const { resolveUniverse } = await import("../../trading/universes");
      const listings = await fetchAllUsStockListings();
      const resolved = resolveUniverse(id as never, listings);
      universeSize = resolved.length;
      for (const listing of resolved) {
        if (symbols.length >= MAX_SCREEN_SYMBOLS) break;
        symbols.push(String(listing.symbol).toUpperCase());
      }
      truncated = universeSize > symbols.length;
      universe = id;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the listings feed failed";
      return Response.json(
        {
          code: "LISTINGS_UNAVAILABLE",
          message: `The ${id} universe could not be resolved (${reason}). No curated table is substituted.`,
          retryable: true,
        },
        { status: 503 },
      );
    }
  }
  if (symbols.length === 0) {
    return Response.json(
      { code: "invalid_request", message: "No symbols resolved for this universe." },
      { status: 400 },
    );
  }
  if (symbols.length > MAX_SCREEN_SYMBOLS) {
    return Response.json(
      {
        code: "invalid_request",
        message: `At most ${MAX_SCREEN_SYMBOLS} symbols per neutral screen (${symbols.length} given); each symbol is one upstream quote read.`,
      },
      { status: 400 },
    );
  }

  const broker = await resolveTenantBroker(ctx.env);
  const readSetting = (key: string) => ctx.readSettingRaw(key) ?? null;
  const environment = resolveBrokerEnvironmentFromSettings(readSetting, ctx.env);

  if (!brokerSupports(broker, "quote")) {
    return Response.json(
      {
        code: "provider_unsupported",
        broker,
        message: `Stock screening needs a quote read, which the selected broker (${broker}) does not provide; no other broker's data is used in its place.`,
        retryable: false,
      },
      { status: 501 },
    );
  }

  const platform = TradingPlatformRegistry.getPlatform(
    broker,
    ctx.env,
    ctx.getOrm(),
    request.headers.get("x-user-login") || "",
    environment,
  );
  const source = platformQuoteSource(platform);
  if (!source) {
    return Response.json(
      {
        code: "provider_unsupported",
        broker,
        message: `Stock screening needs a quote read, which the selected broker (${broker}) does not provide; no other broker's data is used in its place.`,
        retryable: false,
      },
      { status: 501 },
    );
  }

  const { result, quotes } = await screenSymbolsWithSource(source, symbols, body.filter ?? {}, 6);
  return Response.json({
    ...result,
    broker,
    environment,
    universe,
    universeSize,
    truncated,
    requested: symbols,
    quotesRead: quotes.quotes.length,
    failures: quotes.failures,
    result,
  });
}

/** Re-exported so tests and callers can exercise the gather without a route. */
export { gatherQuotes };
