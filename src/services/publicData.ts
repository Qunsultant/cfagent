/**
 * Issue #1247 (add-provider slice of epic #1116): Public.com market
 * data reads over the hosted MCP server (publicMcp.ts), plus the
 * mapping from tool payloads into the data-provider contract's
 * normalized shapes.
 *
 * The tools' parameter names are NOT hardcoded here. Public does not
 * publish the MCP tools' schemas, so — exactly as the proven cfpay
 * implementation does (OpenAIMP/cfpay src/public-data.ts) — each read
 * fetches the tool's LIVE inputSchema via tools/list and maps the
 * read's semantic parameters onto property names the schema actually
 * declares (pickArgs/matchProp). A name is used only when the schema
 * offers it; a REQUIRED parameter that cannot be mapped is reported
 * by name in a PublicDataError rather than guessed.
 *
 * Payload shapes are likewise unpublished, so extraction is liberal
 * in cfpay's manner (candidate field lists, best-array walks) — and
 * strict about honesty: a field the payload does not carry stays
 * ABSENT in the mapped result. Nothing is zero-filled, estimated, or
 * defaulted; the one exception is a quote's timestamp, which falls
 * back to the fetch instant when the payload carries none — the
 * adapter's own observation time, labelled as such, because the
 * contract's quote shape (and the conformance kit) requires a
 * timestamp string and a quote without one cannot be freshness-judged
 * at all.
 *
 * Production-verified behaviour inherited from cfpay: the option
 * tools REQUIRE an account id (get_option_expirations rejects a
 * symbol-only call with "account_id: Field required"), so option
 * reads resolve the account id from get_accounts first and map it on
 * only where the tool's schema declares an account parameter.
 */

import type {
  ETradeOptionChain,
  ETradeOptionChainContract,
  ETradeQuote,
} from "../types";
import type { PublicMcpClient, PublicMcpTool } from "../mcps/public/publicMcp";
import { withBreaker } from "../breakers/breakerDecorator";
import { defaultBreakerRegistry } from "../breakers/createBreakerPorts";
import type { CircuitBreaker } from "../breakers/breakerPorts";

export class PublicDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicDataError";
  }
}

/** What one tool read produced: the wire text, its parsed form, and the exact args sent. */
export interface PublicToolRead {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  payload: unknown;
}

/* ------------------------- schema mapping ------------------------- */

/** The two halves of a JSON-Schema object this module reasons about. */
export function schemaProps(schema: unknown): {
  properties: Record<string, unknown>;
  required: string[];
} {
  if (!schema || typeof schema !== "object") return { properties: {}, required: [] };
  const s = schema as Record<string, unknown>;
  const properties =
    s.properties && typeof s.properties === "object"
      ? (s.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(s.required)
    ? s.required.filter((r): r is string => typeof r === "string")
    : [];
  return { properties, required };
}

/** First candidate the schema declares — exact match, then case-insensitive. */
export function matchProp(
  properties: Record<string, unknown>,
  names: string[]
): string | undefined {
  for (const n of names) if (n in properties) return n;
  const lower = new Map(Object.keys(properties).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Map semantic parameters onto a tool's declared properties. `spec`
 * maps a concept name to its candidate property names (in preference
 * order) and the value to send. Returns the args to call with and, per
 * concept, the property name that matched (undefined when the schema
 * offers none).
 */
export function pickArgs(
  schema: unknown,
  spec: Record<string, { names: string[]; value: unknown }>
): { args: Record<string, unknown>; matched: Record<string, string | undefined> } {
  const { properties } = schemaProps(schema);
  const args: Record<string, unknown> = {};
  const matched: Record<string, string | undefined> = {};
  for (const [concept, { names, value }] of Object.entries(spec)) {
    const prop = matchProp(properties, names);
    matched[concept] = prop;
    if (prop) args[prop] = value;
  }
  return { args, matched };
}

/** Required schema properties the args do not cover. */
export function missingRequired(
  schema: unknown,
  args: Record<string, unknown>
): string[] {
  return schemaProps(schema).required.filter((r) => !(r in args));
}

/* ------------------------- payload reading ------------------------ */

/** Parse a tool's text result as JSON; undefined when it is not JSON. */
export function parseToolJson(text: string): unknown {
  try {
    const parsed = JSON.parse(text);
    // Some MCP wrappers double-encode: the text parses to a string
    // that is itself JSON. Unwrap one level so shape extraction can
    // work on it.
    if (typeof parsed === "string") {
      try {
        const inner = JSON.parse(parsed);
        if (inner && typeof inner === "object") return inner;
      } catch {
        /* keep the string */
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numValue(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function strValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

const ACCOUNT_ID_FIELDS = ["accountId", "account_id", "accountNumber", "id", "uuid"];

/**
 * The first account id in a get_accounts result, across the shapes
 * such tools return: an array of account objects, an object with an
 * accounts array, or a single account object.
 */
export function extractAccountId(result: unknown): string | undefined {
  const fromObject = (o: unknown): string | undefined => {
    if (!isRecord(o)) return undefined;
    for (const f of ACCOUNT_ID_FIELDS) {
      if (typeof o[f] === "string" && o[f]) return o[f] as string;
    }
    return undefined;
  };
  if (Array.isArray(result)) {
    for (const el of result) {
      const id = fromObject(el);
      if (id) return id;
    }
    return undefined;
  }
  if (isRecord(result)) {
    const direct = fromObject(result);
    if (direct) return direct;
    for (const k of Object.keys(result)) {
      if (Array.isArray(result[k])) {
        const id = extractAccountId(result[k]);
        if (id) return id;
      }
    }
  }
  return undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const EXPIRY_FIELDS = ["expiration", "expirationDate", "expiry", "date", "expiration_date"];

/**
 * Expiration dates from a get_option_expirations result: a string
 * array, an array of objects carrying a date field, or an object
 * wrapping either. Returned in the order the tool gave them (nearest
 * first, as listed).
 */
export function extractExpirations(result: unknown): string[] {
  const firstDate = (v: unknown): string => {
    if (typeof v !== "string") return "";
    const m = v.match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : "";
  };
  const fromArray = (arr: unknown[]): string[] => {
    const out: string[] = [];
    for (const el of arr) {
      const direct = firstDate(el);
      if (direct) {
        out.push(direct);
      } else if (isRecord(el)) {
        let found = "";
        for (const f of EXPIRY_FIELDS) {
          found = firstDate(el[f]);
          if (found) break;
        }
        if (!found) {
          for (const v of Object.values(el)) {
            found = firstDate(v);
            if (found) break;
          }
        }
        if (found) out.push(found);
      }
    }
    return out;
  };
  if (Array.isArray(result)) return fromArray(result);
  if (isRecord(result)) {
    let best: string[] = [];
    for (const k of Object.keys(result)) {
      if (Array.isArray(result[k])) {
        const dates = fromArray(result[k] as unknown[]);
        if (dates.length > best.length) best = dates;
      } else if (typeof result[k] === "string" && DATE_RE.test(result[k] as string)) {
        return [(result[k] as string).slice(0, 10)];
      }
    }
    return best;
  }
  return [];
}

/* --------------------------- tool plumbing ------------------------ */

const ACCOUNT_PROP_NAMES = ["account_id", "accountId", "account", "accountNumber"];
const SYMBOL_PROP_NAMES = ["symbol", "ticker", "underlying", "underlyingSymbol", "underlying_symbol"];
const EXPIRY_PROP_NAMES = ["expiration", "expirationDate", "expiry", "expiration_date", "date"];

function offerTool(tools: PublicMcpTool[], name: string): PublicMcpTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new PublicDataError(`Public.com did not offer ${name} for this account.`);
  }
  return tool;
}

/**
 * Resolve the account id the option tools require, via get_accounts.
 * Returns undefined when the tool is not offered or no id is readable
 * — the caller's missingRequired check then names the unmet required
 * parameter instead of the call being sent to fail opaquely.
 */
async function resolveAccountId(
  client: PublicMcpClient,
  tools: PublicMcpTool[]
): Promise<string | undefined> {
  if (!tools.some((t) => t.name === "get_accounts")) return undefined;
  const text = await client.callToolText("get_accounts", {});
  return extractAccountId(parseToolJson(text));
}

function accountSpec(
  accountId: string | undefined
): Record<string, { names: string[]; value: unknown }> {
  return accountId ? { account: { names: ACCOUNT_PROP_NAMES, value: accountId } } : {};
}

/* ------------------------------ quotes ---------------------------- */

const QUOTE_CONTAINER_KEYS = ["quotes", "results", "data", "items"];

function rowSymbol(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  const inst = row.instrument;
  if (isRecord(inst)) {
    const s = strValue(inst.symbol) ?? strValue(inst.ticker);
    if (s) return s;
  }
  return strValue(row.symbol) ?? strValue(row.ticker);
}

function rowPrice(row: unknown): number | undefined {
  if (!isRecord(row)) return undefined;
  return numValue(row.last) ?? numValue(row.lastPrice) ?? numValue(row.price);
}

/** The quote rows in a get_quotes payload, across its plausible wrappings. */
export function extractPublicQuoteRows(payload: unknown): Record<string, unknown>[] {
  const asRows = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter(isRecord) : [];
  if (Array.isArray(payload)) return asRows(payload);
  if (isRecord(payload)) {
    for (const key of QUOTE_CONTAINER_KEYS) {
      const rows = asRows(payload[key]);
      if (rows.length) return rows;
    }
    // Any array property whose rows carry a symbol + price.
    let best: Record<string, unknown>[] = [];
    for (const v of Object.values(payload)) {
      const rows = asRows(v).filter((r) => rowSymbol(r) !== undefined && rowPrice(r) !== undefined);
      if (rows.length > best.length) best = rows;
    }
    if (best.length) return best;
    if (rowSymbol(payload) !== undefined) return [payload];
  }
  return [];
}

/**
 * Map one payload row into the contract's quote shape (ETradeQuote).
 * Only fields the row carries are set — see the module header. The
 * cast marks the mapping boundary: ETradeQuote's required fields are
 * the E*TRADE feed's guarantee, not this provider's, and an absent
 * field here means Public did not report it, never that it is zero.
 */
export function mapPublicQuoteRow(row: unknown, fetchedAtIso: string): ETradeQuote | null {
  if (!isRecord(row)) return null;
  const symbol = rowSymbol(row);
  const lastPrice = rowPrice(row);
  if (!symbol || lastPrice === undefined) return null;

  const out: Partial<ETradeQuote> & { symbol: string; lastPrice: number; timestamp: string } = {
    symbol,
    lastPrice,
    timestamp:
      strValue(row.timestamp) ??
      strValue(row.time) ??
      strValue(row.dateTime) ??
      strValue(row.asOf) ??
      fetchedAtIso,
  };
  const bid = numValue(row.bid);
  if (bid !== undefined) out.bid = bid;
  const ask = numValue(row.ask);
  if (ask !== undefined) out.ask = ask;
  const volume = numValue(row.volume);
  if (volume !== undefined) out.volume = volume;
  const open = numValue(row.open);
  if (open !== undefined) out.open = open;
  const high = numValue(row.high);
  if (high !== undefined) out.high = high;
  const low = numValue(row.low);
  if (low !== undefined) out.low = low;
  const previousClose = numValue(row.previous_close) ?? numValue(row.previousClose);
  if (previousClose !== undefined) out.previousClose = previousClose;

  // One-day change: a nested breakdown (the SDK's shape) or flat fields.
  const odc = isRecord(row.one_day_change) ? row.one_day_change : undefined;
  const change = (odc ? numValue(odc.change) : undefined) ?? numValue(row.change);
  if (change !== undefined) out.change = change;
  const changePercent =
    (odc ? numValue(odc.percent_change) ?? numValue(odc.percentChange) : undefined) ??
    numValue(row.change_percent) ??
    numValue(row.changePercent);
  if (changePercent !== undefined) out.changePercent = changePercent;

  const companyName = strValue(row.companyName) ?? strValue(row.name);
  if (companyName !== undefined) out.companyName = companyName;

  return out as ETradeQuote;
}

/**
 * Batch quotes read. The arg NAME comes from the tool's live schema:
 * a batch property (symbols/tickers) when declared, else one
 * per-symbol call per symbol (cfpay's quotes-endpoint pattern).
 */
/**
 * Issue #1745: public quotes read behind the public breaker (no
 * fallback — an MCP tool-surface failure surfaces as the business
 * error, never a fabricated quote). Tests inject an isolated
 * breaker; production shares the per-isolate default.
 */
export async function readPublicQuotes(
  client: PublicMcpClient,
  symbols: string[],
  opts?: { breaker?: CircuitBreaker }
): Promise<PublicToolRead> {
  const breaker = opts?.breaker ?? defaultBreakerRegistry().breakerFor("public");
  return (await withBreaker(breaker, () => readPublicQuotesInner(client, symbols))).value;
}

async function readPublicQuotesInner(
  client: PublicMcpClient,
  symbols: string[]
): Promise<PublicToolRead> {
  const tools = await client.listTools();
  const tool = offerTool(tools, "get_quotes");
  const batch = pickArgs(tool.inputSchema, {
    symbols: { names: ["symbols", "tickers"], value: symbols },
  });
  if (batch.matched.symbols) {
    const missing = missingRequired(tool.inputSchema, batch.args);
    if (missing.length) {
      throw new PublicDataError(
        `get_quotes requires ${missing.join(", ")}, which could not be mapped from its declared schema.`
      );
    }
    const text = await client.callToolText("get_quotes", batch.args);
    return { tool: "get_quotes", args: batch.args, text, payload: parseToolJson(text) };
  }
  const probe = pickArgs(tool.inputSchema, {
    symbol: { names: ["symbol", "ticker"], value: symbols[0] },
  });
  if (!probe.matched.symbol) {
    const declared = Object.keys(schemaProps(tool.inputSchema).properties).join(", ");
    throw new PublicDataError(
      `get_quotes declares no symbols/symbol parameter (it declares: ${declared}).`
    );
  }
  const rows: Record<string, unknown>[] = [];
  let lastArgs: Record<string, unknown> = {};
  let lastText = "";
  for (const s of symbols) {
    const one = pickArgs(tool.inputSchema, {
      symbol: { names: ["symbol", "ticker"], value: s },
    });
    lastArgs = one.args;
    lastText = await client.callToolText("get_quotes", one.args);
    rows.push(...extractPublicQuoteRows(parseToolJson(lastText)));
  }
  return { tool: "get_quotes", args: lastArgs, text: lastText, payload: rows };
}

/* ---------------------------- expirations -------------------------- */

async function fetchExpirations(
  client: PublicMcpClient,
  tools: PublicMcpTool[],
  symbol: string,
  accountId: string | undefined
): Promise<PublicToolRead & { expirations: string[] }> {
  const tool = offerTool(tools, "get_option_expirations");
  const picked = pickArgs(tool.inputSchema, {
    symbol: { names: SYMBOL_PROP_NAMES, value: symbol },
    ...accountSpec(accountId),
  });
  if (!picked.matched.symbol) {
    const declared = Object.keys(schemaProps(tool.inputSchema).properties).join(", ");
    throw new PublicDataError(
      `get_option_expirations declares no symbol parameter (it declares: ${declared}).`
    );
  }
  const missing = missingRequired(tool.inputSchema, picked.args);
  if (missing.length) {
    throw new PublicDataError(
      `get_option_expirations requires ${missing.join(", ")}` +
        (missing.some((m) => ACCOUNT_PROP_NAMES.includes(m)) && !accountId
          ? ", and no account id could be read from get_accounts."
          : ".")
    );
  }
  const text = await client.callToolText("get_option_expirations", picked.args);
  const payload = parseToolJson(text);
  return {
    tool: "get_option_expirations",
    args: picked.args,
    text,
    payload,
    expirations: extractExpirations(payload),
  };
}

export async function readPublicOptionExpirations(
  client: PublicMcpClient,
  symbol: string
): Promise<PublicToolRead & { expirations: string[] }> {
  const tools = await client.listTools();
  const accountId = await resolveAccountId(client, tools);
  return fetchExpirations(client, tools, symbol, accountId);
}

/* ------------------------------ chains ----------------------------- */

function parseYmd(ymd: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** One YYYY-MM-DD expiration as the contract's expiry-date shape; null when unparseable. */
export function expiryDateFromYmd(
  ymd: string
): { year: number; month: number; day: number } | null {
  return parseYmd(ymd);
}

function contractGreeks(row: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(row.greeks)) return row.greeks;
  const details = isRecord(row.option_details) ? row.option_details : undefined;
  if (details && isRecord(details.greeks)) return details.greeks;
  return undefined;
}

function mapChainContract(
  row: unknown,
  side: "CALL" | "PUT"
): ETradeOptionChainContract | null {
  if (!isRecord(row)) return null;
  const symbol = rowSymbol(row);
  const details = isRecord(row.option_details) ? row.option_details : undefined;
  const strike =
    numValue(row.strike_price) ??
    numValue(row.strikePrice) ??
    numValue(row.strike) ??
    (details ? numValue(details.strike_price) ?? numValue(details.strikePrice) : undefined);
  if (!symbol || strike === undefined) return null;
  const bid = numValue(row.bid);
  const ask = numValue(row.ask);
  const lastPrice = numValue(row.last) ?? numValue(row.lastPrice);
  // #4036 parity rule: a contract needs a TWO-SIDED quote to enter the
  // chain. Alpaca omits anything without bid AND ask (its adapter says so
  // in optionsData.ts); a last trade alone cannot be priced or traded, so
  // Public keeps the same rule instead of shipping a one-sided row.
  if (bid === undefined || ask === undefined) return null;

  const out: Partial<ETradeOptionChainContract> & {
    optionType: "CALL" | "PUT";
    strikePrice: number;
    symbol: string;
  } = { optionType: side, strikePrice: strike, symbol };
  if (bid !== undefined) out.bid = bid;
  if (ask !== undefined) out.ask = ask;
  out.lastPrice = lastPrice ?? Math.round(((bid + ask) / 2) * 100) / 100;
  const volume = numValue(row.volume);
  if (volume !== undefined) out.volume = volume;
  const openInterest = numValue(row.open_interest) ?? numValue(row.openInterest);
  if (openInterest !== undefined) out.openInterest = openInterest;

  const greeks = contractGreeks(row);
  if (greeks) {
    const delta = numValue(greeks.delta);
    if (delta !== undefined) out.delta = delta;
    const gamma = numValue(greeks.gamma);
    if (gamma !== undefined) out.gamma = gamma;
    const theta = numValue(greeks.theta);
    if (theta !== undefined) out.theta = theta;
    const vega = numValue(greeks.vega);
    if (vega !== undefined) out.vega = vega;
    const rho = numValue(greeks.rho);
    if (rho !== undefined) out.rho = rho;
    const iv = numValue(greeks.implied_volatility) ?? numValue(greeks.impliedVolatility);
    if (iv !== undefined) out.impliedVolatility = iv;
  }
  return out as ETradeOptionChainContract;
}

function chainSides(payload: unknown): { calls: unknown[]; puts: unknown[] } {
  const fromRecord = (rec: Record<string, unknown>) => ({
    calls: Array.isArray(rec.calls) ? rec.calls : [],
    puts: Array.isArray(rec.puts) ? rec.puts : [],
  });
  if (isRecord(payload)) {
    const direct = fromRecord(payload);
    if (direct.calls.length || direct.puts.length) return direct;
    for (const v of Object.values(payload)) {
      if (isRecord(v)) {
        const nested = fromRecord(v);
        if (nested.calls.length || nested.puts.length) return nested;
      }
    }
    // Flat contract list: split by the row's own type field.
    for (const key of ["contracts", "options", "chain", "results", "data"]) {
      const arr = payload[key];
      if (Array.isArray(arr)) {
        const calls: unknown[] = [];
        const puts: unknown[] = [];
        for (const row of arr) {
          if (!isRecord(row)) continue;
          const t = String(row.optionType ?? row.option_type ?? row.type ?? "").toLowerCase();
          if (t.includes("call")) calls.push(row);
          else if (t.includes("put")) puts.push(row);
        }
        if (calls.length || puts.length) return { calls, puts };
      }
    }
  }
  return { calls: [], puts: [] };
}

function payloadUnderlyingPrice(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  return (
    numValue(payload.underlying_price) ??
    numValue(payload.underlyingPrice) ??
    numValue(payload.underlying_last) ??
    numValue(payload.underlyingLastPrice)
  );
}

/**
 * Map a chain payload into the contract's chain shape: contracts
 * paired by strike, strikes ascending. Null when no contract row
 * parses (the provider has no chain for the request — a conformant
 * answer, not an error).
 */
export function mapPublicChainPayload(
  payload: unknown,
  symbol: string,
  expiryYmd: string,
  underlyingPrice: number | undefined
): ETradeOptionChain | null {
  const { calls, puts } = chainSides(payload);
  const byStrike = new Map<number, { call?: ETradeOptionChainContract; put?: ETradeOptionChainContract }>();
  for (const row of calls) {
    const c = mapChainContract(row, "CALL");
    if (c) byStrike.set(c.strikePrice, { ...byStrike.get(c.strikePrice), call: c });
  }
  for (const row of puts) {
    const p = mapChainContract(row, "PUT");
    if (p) byStrike.set(p.strikePrice, { ...byStrike.get(p.strikePrice), put: p });
  }
  if (byStrike.size === 0) return null;
  if (underlyingPrice === undefined) {
    throw new PublicDataError(
      `get_option_chain answered for ${symbol} with contracts but no underlying price could be read from the payload or a quote.`
    );
  }
  const pairs = [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, pair]) => pair);
  const expiry = parseYmd(expiryYmd);
  return {
    symbol,
    underlyingPrice,
    ...(expiry ? { selectedExpiry: expiry } : {}),
    pairs,
  };
}

/**
 * Option chain read. With no expiry given, the nearest listed
 * expiration is resolved first (cfpay's chain-endpoint pattern);
 * every failure mode is named in the thrown error rather than
 * guessed around.
 */
export async function readPublicOptionChain(
  client: PublicMcpClient,
  symbol: string,
  expiry: string | null
): Promise<PublicToolRead & { chain: ETradeOptionChain | null }> {
  const tools = await client.listTools();
  const chainTool = offerTool(tools, "get_option_chain");
  const accountId = await resolveAccountId(client, tools);

  let resolvedExpiry = expiry;
  let resolutionNote = "";
  if (!resolvedExpiry) {
    try {
      const exp = await fetchExpirations(client, tools, symbol, accountId);
      if (exp.expirations.length) {
        resolvedExpiry = exp.expirations[0];
      } else {
        resolutionNote = "get_option_expirations answered with no readable dates";
      }
    } catch (err) {
      resolutionNote = err instanceof Error ? err.message : String(err);
    }
  }

  const picked = pickArgs(chainTool.inputSchema, {
    symbol: { names: SYMBOL_PROP_NAMES, value: symbol },
    ...accountSpec(accountId),
    ...(resolvedExpiry
      ? { expiration: { names: EXPIRY_PROP_NAMES, value: resolvedExpiry } }
      : {}),
  });
  if (!picked.matched.symbol) {
    const declared = Object.keys(schemaProps(chainTool.inputSchema).properties).join(", ");
    throw new PublicDataError(
      `get_option_chain declares no symbol parameter (it declares: ${declared}).`
    );
  }
  const missing = missingRequired(chainTool.inputSchema, picked.args);
  if (missing.length) {
    throw new PublicDataError(
      `get_option_chain requires ${missing.join(", ")}` +
        (resolvedExpiry
          ? "."
          : `, and no expiration could be resolved for ${symbol}` +
            (resolutionNote ? ` (${resolutionNote})` : "") +
            (!accountId && missing.some((m) => ACCOUNT_PROP_NAMES.includes(m))
              ? " No account id could be read from get_accounts."
              : "") +
            ".")
    );
  }

  const text = await client.callToolText("get_option_chain", picked.args);
  const payload = parseToolJson(text);
  let underlyingPrice = payloadUnderlyingPrice(payload);
  const { calls, puts } = chainSides(payload);
  if (underlyingPrice === undefined && (calls.length > 0 || puts.length > 0)) {
    // The chain payload carries no underlying price: read it from
    // the provider's own quote for the underlying (same provenance),
    // never from another source and never invented.
    try {
      const quoteRead = await readPublicQuotes(client, [symbol]);
      const row = extractPublicQuoteRows(quoteRead.payload).find(
        (r) => (rowSymbol(r) ?? "").toUpperCase() === symbol.toUpperCase()
      );
      underlyingPrice = row ? rowPrice(row) : undefined;
    } catch {
      underlyingPrice = undefined;
    }
  }
  const chain = mapPublicChainPayload(
    payload,
    symbol,
    resolvedExpiry ?? "",
    underlyingPrice
  );
  return { tool: "get_option_chain", args: picked.args, text, payload, chain };
}
