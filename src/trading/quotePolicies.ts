/**
 * Quote failure policies (issue #291 quote unification).
 *
 * The platform contract carries the primitive (`getQuoteDetailed`: a live
 * fetch with the error returned alongside the result, issue #462). What
 * happens on failure is POLICY, and it belongs to the caller — this
 * module names the policies so call sites state theirs explicitly
 * instead of inheriting whichever implementation they happened to
 * construct.
 *
 * LIVE_STRICT (the historical `ETradeService.fetchQuoteRemote`
 * semantics): a good live quote wins; in the live environment any
 * failure throws with the carried error detail (a failed live request is
 * never papered over with stale cache data); outside the live
 * environment the platform default chain (`getQuote`: cache/curated
 * fallbacks with #118 provenance) applies.
 */

import type { ETradeQuote, OrderPriceSource } from "../types";
import type { ITradingPlatform } from "./interfaces";

/**
 * Issue #3782 — price-provenance codec for the stored trade record.
 * The repository binds values directly (no JSON codec), so provenance
 * persists as JSON text in `TradeRecord.priceSourceJson` (the *Json
 * idiom). Decode is total: anything unparseable, non-object, or
 * carrying an unknown kind reads back as undefined (no provenance),
 * so a corrupt or legacy value can never bless a price — placeOrder
 * then refuses the limit price, fail-closed.
 */
export function encodeOrderPriceSource(source: OrderPriceSource | undefined): string | undefined {
  if (source === undefined) return undefined;
  return JSON.stringify(source);
}

export function decodeOrderPriceSource(value: unknown): OrderPriceSource | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const kind = (parsed as Record<string, unknown>).kind;
    if (kind === "user" || kind === "live-quote" || kind === "market-data" || kind === "estimated") {
      return parsed as OrderPriceSource;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The E*TRADE stub-quote heuristic: the sandbox placeholder quote
 * (lastPrice 577.51 / "GOOGLE INC") must never be treated as a real
 * quote for any symbol except GOOG/GOOGL themselves.
 */
export function isStubQuote(quote: ETradeQuote, symbol: string): boolean {
  const cleanSym = symbol.trim().toUpperCase();
  return (
    (quote.lastPrice === 577.51 ||
      quote.companyName.toUpperCase().includes("GOOGLE INC")) &&
    cleanSym !== "GOOG" &&
    cleanSym !== "GOOGL"
  );
}

/**
 * LIVE_STRICT quote read against any platform exposing the detailed
 * primitive. Throws (with the carried detail, or a generic message for
 * stub/empty results) when `isLive` and no good live quote arrives;
 * otherwise falls back to the platform's default `getQuote` chain.
 */
export async function fetchQuoteLiveStrict(
  platform: ITradingPlatform,
  symbol: string,
  opts: { isLive: boolean },
): Promise<ETradeQuote> {
  const cleanSym = symbol.trim().toUpperCase();
  let quoteError: unknown;
  try {
    if (typeof platform.getQuoteDetailed !== "function") {
      throw new Error(
        `Provider "${platform.platformId}" does not expose detailed quote reads.`,
      );
    }
    const { quote: live, error } = await platform.getQuoteDetailed(cleanSym);
    if (live && live.lastPrice > 0 && !isStubQuote(live, cleanSym)) {
      return live;
    }
    quoteError = error ?? undefined;
  } catch (err) {
    quoteError = err;
  }
  if (opts.isLive) {
    const detail =
      quoteError instanceof Error
        ? quoteError.message
        : typeof quoteError === "string" && quoteError
          ? quoteError
          : undefined;
    throw new Error(detail || `E*TRADE returned no live quote for ${cleanSym}`);
  }
  return platform.getQuote(cleanSym);
}
