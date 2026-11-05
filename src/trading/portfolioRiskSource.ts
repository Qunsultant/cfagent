/**
 * Issue #3324 (programme #3292): the platform → risk-source adapter.
 *
 * `PortfolioRiskSource` (src/services/portfolioRisk.ts) is the neutral input the
 * risk model reads. This module is the only place that knows a broker platform
 * can satisfy it, so no service has to name a broker and no broker has to know
 * about risk:
 *
 *   platform.getPositions()      → the book
 *   platform.getOptionChains()   → the held contract's Greeks
 *   platform.getQuote()          → the SPY denominator
 *
 * A platform missing any of the three yields `null`: the caller answers a coded
 * refusal naming the broker instead of computing a report from partial reads.
 * There is deliberately no fallback source — a risk number that came from
 * another broker's chain would be a fabricated number wearing this broker's name.
 */
import type { PortfolioRiskSource } from "../services/portfolioRisk";
import type { ITradingPlatform } from "./interfaces";

export function platformPortfolioRiskSource(
  platform: ITradingPlatform | null | undefined,
): PortfolioRiskSource | null {
  if (!platform) return null;
  if (typeof platform.getPositions !== "function") return null;
  if (typeof platform.getOptionChains !== "function") return null;
  if (typeof platform.getQuote !== "function") return null;

  const getPositions = platform.getPositions.bind(platform);
  const getOptionChains = platform.getOptionChains.bind(platform);
  const getQuote = platform.getQuote.bind(platform);

  return {
    readBook: () => getPositions(),
    optionChain: (symbol, expiry) =>
      getOptionChains({
        symbol,
        ...(expiry ? { expiryYear: expiry.year, expiryMonth: expiry.month, expiryDay: expiry.day } : {}),
      }),
    spotPrice: async (symbol) => {
      try {
        const quote = await getQuote(symbol);
        return typeof quote?.lastPrice === "number" && Number.isFinite(quote.lastPrice) ? quote.lastPrice : null;
      } catch {
        return null;
      }
    },
  };
}
