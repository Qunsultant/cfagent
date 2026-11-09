import { getCuratedStockBySymbol } from "../../config/curatedStockUniverse";
import { z } from "zod";
export const STOP_WORDS_REGEX = /\b(questions?|messages?|chats?|history|transcript|conversations?|asked|queries|all|results?|references?|containing|contains|with|for|about|find|show|list|get|any|where|me)\b/gi;

export function extractOrderParameters(question: string): {
  orderAction: "BUY" | "SELL" | "SELL_SHORT" | "BUY_TO_COVER";
  quantity: number;
  symbol: string;
  orderType: "MARKET" | "LIMIT";
  limitPrice?: number;
  relativePriceOffsetPercent?: number;
  relativePriceDescription?: string;
  takeProfitPercent?: number;
  stopLossPercent?: number;
} | null {
  const isOrderIntent = /\b(buy|purchase|sell|short|cover|order\s+to\s+buy|order\s+to\s+sell|place\s+(?:an?\s+)?order|draft\s+(?:an?\s+)?order)\b/i.test(question);
  if (!isOrderIntent || /\b(messages?|categories|tables?)\b/i.test(question)) {
    return null;
  }

  // 1. Action
  let orderAction: "BUY" | "SELL" | "SELL_SHORT" | "BUY_TO_COVER" = "BUY";
  if (/\b(sell\s*short|short)\b/i.test(question)) {
    orderAction = "SELL_SHORT";
  } else if (/\b(buy\s*to\s*cover|cover)\b/i.test(question)) {
    orderAction = "BUY_TO_COVER";
  } else if (/\bsell\b/i.test(question)) {
    orderAction = "SELL";
  } else {
    orderAction = "BUY";
  }

  // 2. Quantity
  let quantity = 1;
  const wordToNumber: Record<string, number> = {
    one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    fifteen: 15, twenty: 20, twentyfive: 25, fifty: 50, hundred: 100,
  };

  const qtyMatch = question.match(
    /\b(?:buy|sell|short|purchase|cover)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|a|an)\b/i
  ) || question.match(/\b(\d+)\s*(?:shares?|contracts?|lots?|units?|orders?|stocks?)\b/i);

  if (qtyMatch) {
    const rawQty = qtyMatch[1].toLowerCase();
    if (/^\d+$/.test(rawQty)) {
      quantity = parseInt(rawQty, 10);
    } else if (wordToNumber[rawQty] !== undefined) {
      quantity = wordToNumber[rawQty];
    }
  } else {
    if (/\b(?:a|an)\s+(?:share|order|lot|contract|unit|stock)\b/i.test(question)) {
      quantity = 1;
    } else {
      quantity = 10;
    }
  }

  // 3. Symbol Extraction
  const NON_TICKER_WORDS = new Set([
    "BUY", "SELL", "SHORT", "PURCHASE", "COVER",
    "ORDER", "ORDERS", "SHARE", "SHARES", "STOCK", "STOCKS",
    "CONTRACT", "CONTRACTS", "LOT", "LOTS", "UNIT", "UNITS",
    "POSITION", "POSITIONS",
    "OF", "AT", "FOR", "IN", "ON", "TO", "FROM", "WITH", "BY",
    "A", "AN", "THE", "SOME", "ALL",
    "MARKET", "LIMIT", "PRICE", "PRICED", "SPOT", "QUOTE",
    "PERCENT", "PCT", "DISCOUNT", "PREMIUM", "BELOW", "UNDER", "ABOVE", "OVER",
    "LESS", "MORE", "THAN", "OFF",
    "DOLLAR", "DOLLARS", "CENT", "CENTS", "USD",
    "PLEASE", "WANT", "LIKE", "DRAFT", "PLACE", "SUBMIT", "CONFIRM", "EXECUTE",
    "TODAY", "NOW", "CURRENT", "LIVE",
  ]);

  let symbol = "";

  // Pattern A: "buy 1 order of nvda" / "buy 10 shares of aapl" / "buy 10 nvda"
  const structuredSymbolMatch = question.match(
    /\b(?:buy|sell|short|purchase|cover)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|a|an)?\s*(?:(?:shares?|orders?|contracts?|lots?|units?|stocks?)\s*(?:of\s*)?|of\s+)?([A-Za-z]{1,5})\b/i
  );

  if (structuredSymbolMatch && !NON_TICKER_WORDS.has(structuredSymbolMatch[1].toUpperCase())) {
    symbol = structuredSymbolMatch[1].toUpperCase();
  }

  // Pattern B: Look for "... of <ticker>" e.g. "order of nvda", "shares of nvda"
  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    const ofMatch = question.match(/\b(?:order|orders|share|shares|stock|stocks|contract|contracts|lot|lots|unit|units)\s+of\s+([A-Za-z]{1,5})\b/i);
    if (ofMatch && !NON_TICKER_WORDS.has(ofMatch[1].toUpperCase())) {
      symbol = ofMatch[1].toUpperCase();
    }
  }

  // Pattern C: Check known curated stock universe tickers in question
  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    const tokens = question.split(/[^A-Za-z0-9]+/).map(t => t.toUpperCase()).filter(t => t.length >= 1 && t.length <= 5);
    for (const token of tokens) {
      if (!NON_TICKER_WORDS.has(token)) {
        const curated = getCuratedStockBySymbol(token);
        if (curated) {
          symbol = token;
          break;
        }
      }
    }
  }

  // Pattern D: Fallback to first non-blacklisted token
  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    const tokens = question.split(/[^A-Za-z0-9]+/).map(t => t.toUpperCase()).filter(t => t.length >= 1 && t.length <= 5);
    for (const token of tokens) {
      if (!NON_TICKER_WORDS.has(token)) {
        symbol = token;
        break;
      }
    }
  }

  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    return null;
  }

  // 4. Pricing / Limit Price / Relative Offset
  let orderType: "MARKET" | "LIMIT" = "MARKET";
  let limitPrice: number | undefined = undefined;
  let relativePriceOffsetPercent: number | undefined = undefined;
  let relativePriceDescription: string | undefined = undefined;
  let takeProfitPercent: number | undefined = undefined;
  let stopLossPercent: number | undefined = undefined;

  // Issue #3839: bracket exits as percentages — "+4% take-profit" and
  // "-2% stop-loss". The adapter converts them from the same entry it
  // prices the draft from, so no arithmetic happens in the parser.
  const takeProfitMatch = question.match(
    /\+?\s*(\d+(?:\.\d+)?)\s*%\s*(?:take[\s-]?profit|tp)\b/i,
  ) || question.match(/(?:take[\s-]?profit|tp)\s*(?:at|of|:)?\s*\+?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (takeProfitMatch) takeProfitPercent = parseFloat(takeProfitMatch[1]);
  const stopLossMatch = question.match(
    /-\s*(\d+(?:\.\d+)?)\s*%\s*(?:stop[\s-]?loss|sl)\b/i,
  ) || question.match(/(?:stop[\s-]?loss|sl)\s*(?:at|of|:)?\s*-?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (stopLossMatch) stopLossPercent = parseFloat(stopLossMatch[1]);

  // Relative Discount (below market)
  const discountMatch = question.match(
    /(?:at|with)?\s*(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:below|under|discount(?:\s+(?:to|from))?|less\s+than|off)\s*(?:market(?:\s+price)?|spot|current\s+price|price)?/i
  );
  if (discountMatch) {
    const pct = parseFloat(discountMatch[1]);
    relativePriceOffsetPercent = -pct;
    relativePriceDescription = `${pct}% below market price`;
    orderType = "LIMIT";
  }

  // Relative Premium (above market)
  const premiumMatch = question.match(
    /(?:at|with)?\s*(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:above|over|premium(?:\s+(?:to|from))?|more\s+than)\s*(?:market(?:\s+price)?|spot|current\s+price|price)?/i
  );
  if (premiumMatch) {
    const pct = parseFloat(premiumMatch[1]);
    relativePriceOffsetPercent = pct;
    relativePriceDescription = `${pct}% above market price`;
    orderType = "LIMIT";
  }

  // Explicit Dollar Limit
  const explicitLimitMatch = question.match(
    /(?:limit\s*(?:at|of|price)?\s*\$?|at\s+\$|for\s+\$)(\d+(?:\.\d+)?)\b/i
  );
  if (explicitLimitMatch && relativePriceOffsetPercent === undefined) {
    limitPrice = parseFloat(explicitLimitMatch[1]);
    orderType = "LIMIT";
  }

  // #913/#920: a relative offset is NEVER priced here. The limit price is
  // derived at execution time from a LIVE E*TRADE quote, and execution
  // refuses the order when no live quote is available. (This block used to
  // derive the price from the static curated `defaultPrice` table — an
  // unlabeled static price on a production order path.)

  return {
    orderAction,
    quantity,
    symbol,
    orderType,
    limitPrice,
    relativePriceOffsetPercent,
    relativePriceDescription,
    ...(takeProfitPercent !== undefined ? { takeProfitPercent } : {}),
    ...(stopLossPercent !== undefined ? { stopLossPercent } : {}),
  };
}
