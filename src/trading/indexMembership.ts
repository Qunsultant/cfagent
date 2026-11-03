/**
 * #1852 — Index-membership provider port.
 *
 * The stock screener had no index-membership source: no SP100 / S&P 500 /
 * Nasdaq-100 / Russell 2000 / Dow list, no cached table, and no
 * index-membership capability in the data-provider registry (the Nasdaq
 * adapter's only capability is `screenUniverse` = all-exchange listings,
 * not index membership). This module adds ONE port with TWO adapters so
 * the screener can take an index name and get a snapshot-dated symbol
 * list as `opts.symbols` into the existing `acquireUniverse` modes
 * (live-quotes / etrade-only / yahoo) unchanged.
 *
 * Port-first (restated blueprint #1795/#1798): this module is pure —
 * no Cloudflare imports, no I/O, no network. Adapters take injected
 * fetchers, so the port, the parsers, and the conformance suite run
 * identically in tests and in production; only the composition root
 * binds real fetchers. A third adapter can be added without consumer
 * changes: it only has to satisfy `IndexMembershipPort`.
 *
 * Honesty rules, enforced by the types and the tests:
 * - No hardcoded symbol lists in code. Every list comes from a fetch.
 * - No licensed data: Wikipedia tables are CC BY-SA; ETF holdings
 *   files are the funds' own published files. Holdings-derived lists
 *   are labelled `holdings-derived`, never `official`: a fund file
 *   includes cash/derivatives/sampling differences and is dated T+1.
 * - Snapshot date on every list. Stale lists are flagged (`stale`)
 *   and `requireFresh` refuses them — never silently served.
 * - Ticker normalization happens here, before symbols reach quote
 *   providers: Wikipedia writes `BRK.B`, Yahoo wants `BRK-B`.
 * - Point-in-time historical membership is OUT of scope (follow-up):
 *   this slice serves the current list only.
 *
 * #2962 — Extended universe (follow-up to #1852/#1980).
 * New keys: `sp400` (S&P MidCap 400, Wikipedia table, same layout
 * as S&P 500), `russell3000` (holdings-adapter union of IWB +
 * IWM — Russell 3000 IS definitionally Russell 1000 + Russell
 * 2000: the top 1,000 + the next 2,000 of the 3,000 largest US
 * stocks; verified against FTSE Russell methodology summaries
 * 2026-11-03), and the 11 GICS sector universes (members of the
 * S&P 500 table filtered by its GICS Sector column — the sector
 * definition, not a second taxonomy). Sector keys are
 * `sector-<slug>`; the Select Sector SPDR ticker per sector is
 * recorded as the holdings-adapter cross-check key. Russell
 * reconstitution (annually in June historically; FTSE Russell
 * announced a move to semi-annual reconstitution from late
 * 2026) is handled by the union rule, not a special case: the
 * union's snapshot date is the OLDER leg's as-of date, so a
 * mixed-vintage union around reconstitution is refused as stale
 * once the older leg exceeds the 3-day holdings budget, and the
 * source label names both legs' as-of dates so the vintage mix
 * is visible, never silent. The Wikipedia adapter memoizes
 * fetches per instance: the 11 sector keys share the one S&P 500
 * page fetch, so the weekly refresh job fetches 5 pages for 16
 * Wikipedia-family keys, not 16.
 */
import type { NasdaqExchange, NasdaqStockListing } from "../services/nasdaqListings";
import type { ETradeQuote, StockScreenerFilter } from "../types";
import { DynamicMarketScreener } from "./screener";
import {
  acquireUniverse,
  screenUniverse,
  type QuoteScreenerDeps,
} from "./screenerPipeline";

/** The 11 GICS sectors, keyed `sector-<slug>` (#2962). */
export type SectorId =
  | "sector-energy"
  | "sector-materials"
  | "sector-industrials"
  | "sector-consumer-discretionary"
  | "sector-consumer-staples"
  | "sector-health-care"
  | "sector-financials"
  | "sector-information-technology"
  | "sector-communication-services"
  | "sector-utilities"
  | "sector-real-estate";

/** All sector keys, in GICS code order (10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60). */
export const SECTOR_IDS: SectorId[] = [
  "sector-energy",
  "sector-materials",
  "sector-industrials",
  "sector-consumer-discretionary",
  "sector-consumer-staples",
  "sector-health-care",
  "sector-financials",
  "sector-information-technology",
  "sector-communication-services",
  "sector-utilities",
  "sector-real-estate",
];

/** Wikipedia GICS Sector cell value per sector key (#2962). */
export const SECTOR_GICS_NAME: Record<SectorId, string> = {
  "sector-energy": "Energy",
  "sector-materials": "Materials",
  "sector-industrials": "Industrials",
  "sector-consumer-discretionary": "Consumer Discretionary",
  "sector-consumer-staples": "Consumer Staples",
  "sector-health-care": "Health Care",
  "sector-financials": "Financials",
  "sector-information-technology": "Information Technology",
  "sector-communication-services": "Communication Services",
  "sector-utilities": "Utilities",
  "sector-real-estate": "Real Estate",
};

/**
 * Wikipedia GICS Sector cell → sector key. Case-insensitive:
 * the live tables write "Information Technology" but a fixture
 * or a table edit may differ in case; the sector name is a
 * label, not an identity, so matching is normalized.
 */
export function sectorIdForGicsName(
  name: string | undefined
): SectorId | undefined {
  if (!name) return undefined;
  const norm = name.trim().toLowerCase();
  for (const id of SECTOR_IDS) {
    if (SECTOR_GICS_NAME[id].toLowerCase() === norm) return id;
  }
  return undefined;
}

export function isSectorIndex(index: string): index is SectorId {
  return (SECTOR_IDS as string[]).includes(index);
}

/** Select Sector SPDR cross-check ticker per sector (State Street). */
export const SECTOR_SPDR_ETF: Record<SectorId, string> = {
  "sector-energy": "XLE",
  "sector-materials": "XLB",
  "sector-industrials": "XLI",
  "sector-consumer-discretionary": "XLY",
  "sector-consumer-staples": "XLP",
  "sector-health-care": "XLV",
  "sector-financials": "XLF",
  "sector-information-technology": "XLK",
  "sector-communication-services": "XLC",
  "sector-utilities": "XLU",
  "sector-real-estate": "XLRE",
};

/**
 * Indexes this port serves. `sp100` is the S&P 100 (100 names).
 * #2962 adds `sp400`, `russell3000`, and the 11 `sector-*` keys.
 */
export type IndexId =
  | "dow"
  | "sp500"
  | "sp100"
  | "nasdaq100"
  | "russell2000"
  | "russell1000"
  | "sp400"
  | "russell3000"
  | SectorId;

export interface IndexMember {
  symbol: string;
  name?: string;
  sector?: string;
  exchange?: NasdaqExchange;
}

export interface IndexMembership {
  index: IndexId;
  /** YYYY-MM-DD: fetch date for Wikipedia, as-of date for holdings files. */
  snapshotDate: string;
  symbols: IndexMember[];
  /** Adapter id: "wikipedia" or the ETF ticker (lowercase, e.g. "iwm"). */
  source: string;
  /** Human label; holdings-derived results say so, never "official". */
  sourceLabel: string;
  /** True when the list came from a fund holdings file, not a table. */
  derivedFromHoldings: boolean;
  /** True when the snapshot is older than the caller's max age. */
  stale?: boolean;
}

/** The port. One interface; adapters behind it; consumers never import one. */
export interface IndexMembershipPort {
  getMembers(index: IndexId): Promise<IndexMembership>;
}

export class StaleIndexMembershipError extends Error {
  constructor(
    public readonly index: IndexId,
    public readonly snapshotDate: string,
    public readonly maxAgeDays: number
  ) {
    super(
      `Index membership for ${index} is stale: snapshot ${snapshotDate} is older than ${maxAgeDays} days. Refusing to serve it silently — refresh the source or allow stale explicitly.`
    );
    this.name = "StaleIndexMembershipError";
  }
}

export class UnknownIndexError extends Error {
  constructor(public readonly index: string) {
    super(`Unknown index id: ${index}`);
    this.name = "UnknownIndexError";
  }
}

// ---------------------------------------------------------------------------
// Ticker normalization
// ---------------------------------------------------------------------------

/**
 * Wikipedia writes `BRK.B`, Yahoo wants `BRK-B`. Class-share dots and
 * slashes map to dashes; surrounding whitespace is trimmed; letters
 * uppercased. Anything that does not look like a ticker after that is
 * rejected — a garbage symbol must fail here, not in the quote provider.
 */
export function normalizeTicker(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[./]/g, "-");
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(cleaned)) {
    throw new Error(`Cannot normalize ticker: ${JSON.stringify(raw)}`);
  }
  return cleaned;
}

/** Map a source exchange string to the listing exchange enum, if known. */
export function mapExchange(raw: string | undefined): NasdaqExchange | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toUpperCase();
  if (v === "NASDAQ") return "nasdaq";
  if (v === "NYSE" || v === "NEW YORK STOCK EXCHANGE") return "nyse";
  if (
    v === "AMEX" ||
    v === "NYSE AMERICAN" ||
    v === "AMERICAN STOCK EXCHANGE"
  ) {
    return "amex";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Staleness: labelled or refused, never silently served
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  const ms =
    Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

/** True when the snapshot is older than `maxAgeDays` at `now` (UTC date). */
export function isStaleSnapshot(
  snapshotDate: string,
  maxAgeDays: number,
  now: string = new Date().toISOString().slice(0, 10)
): boolean {
  return daysBetween(snapshotDate, now) > maxAgeDays;
}

/** Default freshness budgets: ETF files refresh daily, Wikipedia weekly. */
export const DEFAULT_MAX_AGE_DAYS: Record<"wikipedia" | "holdings", number> = {
  wikipedia: 10,
  holdings: 3,
};

// ---------------------------------------------------------------------------
// HTML table parsing (Wikipedia adapter)
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

/**
 * Plain-text extraction for table cells. CodeQL-pinned (#1852, 2 high
 * alerts on the first version): tag stripping loops until stable, so
 * a nested `<<script>` cannot survive one pass and leave a live tag
 * behind; entity decoding is a SINGLE regex pass with a lookup, so
 * `&amp;nbsp;` decodes once to `&nbsp;` instead of twice to a space;
 * any residual angle brackets are removed, since cell text (names,
 * sectors, tickers) never legitimately contains them.
 */
export function stripTags(cell: string): string {
  let text = cell;
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  text = text.replace(
    /&(amp|lt|gt|quot|nbsp|#39|#x27);/g,
    (match) => HTML_ENTITIES[match.slice(1, -1)] ?? match
  );
  return text
    .replace(/[<>]/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHtmlRows(html: string): string[][] {
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  for (const [, body] of tables) {
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(
      ([, row]) =>
        [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(([, c]) =>
          stripTags(c)
        )
    );
    const header = rows[0] ?? [];
    const hasSymbol = header.some(
      (h) => h.toLowerCase() === "symbol" || h.toLowerCase() === "ticker"
    );
    if (hasSymbol && rows.length > 1) return rows;
  }
  throw new Error("No Wikipedia component table found in fetched HTML");
}

interface WikipediaLayout {
  page: string;
  symbolCol: number;
  nameCol: number;
  sectorCol: number;
  exchangeCol: number | null;
}

/**
 * Verified against the live pages 2026-10-27 (column layouts, not
 * guessed): Dow's table is Company | Exchange | Symbol | ISIN |
 * Sector; S&P 500 is Symbol | Security | GICS Sector | …; S&P 100 is
 * Symbol | Name | Sector; Nasdaq-100 lives on its own list page as
 * Ticker | Company | ISIN | ICB Industry | …. No exchange column
 * exists on the S&P 500 / S&P 100 / Nasdaq-100 tables.
 * #2962, verified 2026-11-03: S&P 400 is Symbol | Security | GICS
 * Sector | GICS Sub-Industry | Headquarters Location | SEC
 * filings — the S&P 500 layout, so it shares its columns.
 */
const WIKIPEDIA_LAYOUTS: Record<
  "dow" | "sp500" | "sp100" | "nasdaq100" | "sp400",
  WikipediaLayout
> = {
  dow: {
    page: "List_of_Dow_Jones_Industrial_Average_companies",
    symbolCol: 2,
    nameCol: 0,
    sectorCol: 4,
    exchangeCol: 1,
  },
  sp500: {
    page: "List_of_S%26P_500_companies",
    symbolCol: 0,
    nameCol: 1,
    sectorCol: 2,
    exchangeCol: null,
  },
  sp100: {
    page: "S%26P_100",
    symbolCol: 0,
    nameCol: 1,
    sectorCol: 2,
    exchangeCol: null,
  },
  nasdaq100: {
    page: "List_of_NASDAQ-100_companies",
    symbolCol: 0,
    nameCol: 1,
    sectorCol: 3,
    exchangeCol: null,
  },
  sp400: {
    page: "List_of_S%26P_400_companies",
    symbolCol: 0,
    nameCol: 1,
    sectorCol: 2,
    exchangeCol: null,
  },
};

export type WikipediaFetcher = (url: string) => Promise<string>;

/** Shared row → member conversion for table layouts (sector filter optional). */
function rowsToMembers(
  rows: string[][],
  symbolCol: number,
  nameCol: number,
  sectorCol: number,
  exchangeCol: number | null,
  sectorFilter?: (sector: string | undefined) => boolean
): IndexMember[] {
  const symbols: IndexMember[] = [];
  for (const row of rows.slice(1)) {
    const raw = row[symbolCol];
    if (!raw) continue;
    const sector = row[sectorCol] || undefined;
    if (sectorFilter && !sectorFilter(sector)) continue;
    let symbol: string;
    try {
      symbol = normalizeTicker(raw);
    } catch {
      continue;
    }
    symbols.push({
      symbol,
      name: row[nameCol] || undefined,
      sector,
      exchange:
        exchangeCol !== null ? mapExchange(row[exchangeCol]) : undefined,
    });
  }
  return symbols;
}

/** Adapter 1 — Wikipedia component tables (CC BY-SA). */
export function createWikipediaIndexMembershipAdapter(
  fetchHtml: WikipediaFetcher,
  today: string = new Date().toISOString().slice(0, 10)
): IndexMembershipPort {
  // Per-instance memo, keyed by URL: the 11 sector keys share
  // the one S&P 500 page fetch, so a weekly refresh of all
  // sector keys costs one fetch of that page, not eleven.
  // Failures are not memoized (a retry re-fetches); instances
  // are short-lived (one tick / one request), so `today` never
  // goes stale inside the cache.
  const htmlCache = new Map<string, Promise<string>>();
  const fetchCached = (url: string): Promise<string> => {
    const hit = htmlCache.get(url);
    if (hit) return hit;
    const pending = fetchHtml(url);
    htmlCache.set(url, pending);
    pending.catch(() => {
      if (htmlCache.get(url) === pending) htmlCache.delete(url);
    });
    return pending;
  };
  return {
    async getMembers(index: IndexId): Promise<IndexMembership> {
      // #2962 sector keys: the S&P 500 table filtered by its
      // GICS Sector column. The sector definition IS this
      // column — no second taxonomy, no invented list.
      if (isSectorIndex(index)) {
        const layout = WIKIPEDIA_LAYOUTS.sp500;
        const html = await fetchCached(
          `https://en.wikipedia.org/wiki/${layout.page}`
        );
        const rows = parseHtmlRows(html);
        const symbols = rowsToMembers(
          rows,
          layout.symbolCol,
          layout.nameCol,
          layout.sectorCol,
          layout.exchangeCol,
          (sector) => sectorIdForGicsName(sector) === index
        );
        if (symbols.length === 0) {
          throw new Error(
            `Wikipedia table for ${index} yielded no members — refusing an empty list`
          );
        }
        return {
          index,
          snapshotDate: today,
          symbols,
          source: "wikipedia",
          sourceLabel: `Wikipedia S&P 500 GICS Sector column (CC BY-SA), sector ${SECTOR_GICS_NAME[index]}, fetched ${today}`,
          derivedFromHoldings: false,
        };
      }
      const layout =
        WIKIPEDIA_LAYOUTS[index as keyof typeof WIKIPEDIA_LAYOUTS];
      if (!layout) {
        throw new UnknownIndexError(
          `${index} is not served by the Wikipedia adapter (use the holdings adapter)`
        );
      }
      const html = await fetchCached(
        `https://en.wikipedia.org/wiki/${layout.page}`
      );
      const rows = parseHtmlRows(html);
      const symbols = rowsToMembers(
        rows,
        layout.symbolCol,
        layout.nameCol,
        layout.sectorCol,
        layout.exchangeCol
      );
      if (symbols.length === 0) {
        throw new Error(
          `Wikipedia table for ${index} yielded no members — refusing an empty list`
        );
      }
      return {
        index,
        // Wikipedia tables carry no snapshot date; the fetch date IS
        // the snapshot, and it is stamped as such on every result.
        snapshotDate: today,
        symbols,
        source: "wikipedia",
        sourceLabel: `Wikipedia component table (CC BY-SA), fetched ${today}`,
        derivedFromHoldings: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CSV parsing (ETF holdings adapter)
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** iShares files carry an "as of" date in metadata rows; parse it if present. */
export function parseHoldingsAsOfDate(
  text: string,
  fallback: string
): string {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const long = text.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/i
  );
  if (long) {
    const month = MONTHS[long[1].toLowerCase()];
    const day = long[2].padStart(2, "0");
    return `${long[3]}-${month}-${day}`;
  }
  return fallback;
}

export type HoldingsFetcher = (etf: string) => Promise<string>;

/**
 * ETF ticker per index for the holdings adapter (primary + cross-checks).
 * `russell3000` is deliberately absent: it is not a single fund but
 * the IWB + IWM union (see the adapter below), and mapping it to
 * IWV would mislabel the cross-check as the primary.
 */
export const HOLDINGS_ETF_BY_INDEX: Record<
  Exclude<IndexId, "russell3000">,
  string
> = {
  dow: "DIA",
  sp500: "SPY",
  sp100: "OEF",
  nasdaq100: "QQQ",
  russell2000: "IWM",
  russell1000: "IWB",
  sp400: "MDY",
  "sector-energy": "XLE",
  "sector-materials": "XLB",
  "sector-industrials": "XLI",
  "sector-consumer-discretionary": "XLY",
  "sector-consumer-staples": "XLP",
  "sector-health-care": "XLV",
  "sector-financials": "XLF",
  "sector-information-technology": "XLK",
  "sector-communication-services": "XLC",
  "sector-utilities": "XLU",
  "sector-real-estate": "XLRE",
};

/**
 * Parse one holdings file into its as-of date + equity members.
 * Shared by the single-ETF path, the Russell 3000 union legs, and
 * the IWV cross-check, so all three agree on what a row means.
 * Non-equity rows (cash, money-market, derivatives) are filtered
 * out when the file says what each row is; a file without an
 * "Asset Class" column keeps every row with a parsable ticker.
 */
function parseHoldingsFile(
  text: string,
  fallbackDate: string,
  label: string
): { snapshotDate: string; members: IndexMember[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex(
    (l) => parseCsvLine(l)[0]?.toLowerCase() === "ticker"
  );
  if (headerIdx === -1) {
    throw new Error(
      `Holdings file for ${label} has no Ticker header row — refusing to guess columns`
    );
  }
  const header = parseCsvLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const tickerCol = col("ticker");
  const nameCol = col("name");
  const assetCol = col("asset class");
  const sectorCol = col("sector");
  const exchangeCol = col("exchange");
  const snapshotDate = parseHoldingsAsOfDate(
    lines.slice(0, headerIdx).join("\n"),
    fallbackDate
  );
  const members: IndexMember[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const row = parseCsvLine(line);
    const raw = row[tickerCol];
    if (!raw) continue;
    // Fund files include cash/derivatives/sampling rows: keep only
    // equities when the file says what each row is.
    if (assetCol !== -1) {
      const asset = (row[assetCol] ?? "").toLowerCase();
      if (!asset.includes("equit")) continue;
    }
    let symbol: string;
    try {
      symbol = normalizeTicker(raw);
    } catch {
      continue;
    }
    members.push({
      symbol,
      name: nameCol !== -1 ? row[nameCol] || undefined : undefined,
      sector: sectorCol !== -1 ? row[sectorCol] || undefined : undefined,
      exchange:
        exchangeCol !== -1 ? mapExchange(row[exchangeCol]) : undefined,
    });
  }
  return { snapshotDate, members };
}

/**
 * Adapter 2 — ETF holdings files. PRIMARY for Russell 2000 (IWM) and
 * Russell 1000 (IWB): no usable full Wikipedia list exists for ~2,000
 * small-caps. SPY / QQQ / DIA / OEF serve as cross-checks elsewhere.
 * Non-equity rows (cash, money-market, derivatives) are filtered out;
 * results are labelled holdings-derived, never official.
 * #2962: sp400 via MDY, sector keys via their Select Sector SPDR
 * tickers, and russell3000 as the IWB + IWM union (see below).
 */
export function createEtfHoldingsIndexMembershipAdapter(
  fetchCsv: HoldingsFetcher,
  today: string = new Date().toISOString().slice(0, 10)
): IndexMembershipPort {
  return {
    async getMembers(index: IndexId): Promise<IndexMembership> {
      // #2962 Russell 3000 union: Russell 3000 IS Russell 1000 +
      // Russell 2000 (top 1,000 + next 2,000 of the 3,000 largest
      // US stocks). Both legs are fetched; a failing leg fails
      // the whole union — a partial union is never served. The
      // union's snapshot date is the OLDER leg's as-of date, so
      // staleness is governed by the stalest leg (this is the
      // reconstitution guard: around a June — now moving to
      // semi-annual — reconstitution, the legs update on
      // different days, and the label names both legs' dates so
      // any vintage mix is visible). On an overlap, the Russell
      // 1000 (IWB) record wins; the legs are disjoint by
      // construction, so an overlap is a data anomaly, not a
      // second member.
      if (index === "russell3000") {
        const [iwbText, iwmText] = await Promise.all([
          fetchCsv("IWB"),
          fetchCsv("IWM"),
        ]);
        const iwb = parseHoldingsFile(iwbText, today, "IWB");
        const iwm = parseHoldingsFile(iwmText, today, "IWM");
        const bySymbol = new Map<string, IndexMember>();
        for (const m of iwb.members) bySymbol.set(m.symbol, m);
        for (const m of iwm.members) {
          if (!bySymbol.has(m.symbol)) bySymbol.set(m.symbol, m);
        }
        const symbols = [...bySymbol.values()];
        if (symbols.length === 0) {
          throw new Error(
            "Russell 3000 union yielded no equity members — refusing an empty list"
          );
        }
        const snapshotDate =
          iwb.snapshotDate < iwm.snapshotDate
            ? iwb.snapshotDate
            : iwm.snapshotDate;
        return {
          index,
          snapshotDate,
          symbols,
          source: "iwb+iwm",
          sourceLabel: `IWB+IWM holdings-derived union (IWB as of ${iwb.snapshotDate}, IWM as of ${iwm.snapshotDate}) — NOT the official index list`,
          derivedFromHoldings: true,
        };
      }
      const etf = HOLDINGS_ETF_BY_INDEX[index];
      if (!etf) throw new UnknownIndexError(index);
      const text = await fetchCsv(etf);
      const { snapshotDate, members: symbols } = parseHoldingsFile(
        text,
        today,
        etf
      );
      if (symbols.length === 0) {
        throw new Error(
          `Holdings file for ${etf} yielded no equity members — refusing an empty list`
        );
      }
      return {
        index,
        snapshotDate,
        symbols,
        source: etf.toLowerCase(),
        sourceLabel: `${etf} holdings-derived list (fund file, as of ${snapshotDate}) — NOT the official index list`,
        derivedFromHoldings: true,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Service: routing, staleness, cross-check, screener wiring
// ---------------------------------------------------------------------------

export interface IndexMembershipServiceDeps {
  wikipedia: IndexMembershipPort;
  holdings: IndexMembershipPort;
}

export interface IndexCrossCheck {
  index: IndexId;
  wikipediaCount: number;
  holdingsCount: number;
  onlyInWikipedia: string[];
  onlyInHoldings: string[];
}

export interface Russell3000CrossCheck {
  index: "russell3000";
  unionCount: number;
  iwvCount: number;
  onlyInUnion: string[];
  onlyInIwv: string[];
}

export function createIndexMembershipService(deps: IndexMembershipServiceDeps) {
  const route = (index: IndexId): IndexMembershipPort => {
    switch (index) {
      case "dow":
      case "sp500":
      case "sp100":
      case "nasdaq100":
      case "sp400":
        return deps.wikipedia;
      case "russell2000":
      case "russell1000":
      case "russell3000":
        return deps.holdings;
      default:
        if (isSectorIndex(index)) return deps.wikipedia;
        throw new UnknownIndexError(index);
    }
  };
  return {
    /** Primary path: one adapter per index, per the issue routing. */
    getMembers(index: IndexId): Promise<IndexMembership> {
      return route(index).getMembers(index);
    },
    isStale(membership: IndexMembership, maxAgeDays: number): boolean {
      return isStaleSnapshot(membership.snapshotDate, maxAgeDays);
    },
    /** Refuse a stale list loudly instead of serving it silently. */
    requireFresh(
      membership: IndexMembership,
      maxAgeDays: number
    ): IndexMembership {
      if (isStaleSnapshot(membership.snapshotDate, maxAgeDays)) {
        throw new StaleIndexMembershipError(
          membership.index,
          membership.snapshotDate,
          maxAgeDays
        );
      }
      return { ...membership, stale: false };
    },
    /** Flag a stale list without refusing it (labelled, never silent). */
    withStalenessFlag(
      membership: IndexMembership,
      maxAgeDays: number
    ): IndexMembership {
      return {
        ...membership,
        stale: isStaleSnapshot(membership.snapshotDate, maxAgeDays),
      };
    },
    /**
     * Cross-check: Wikipedia table vs ETF holdings file for the
     * indexes that have both (#2962: sp400 via MDY, sector keys
     * via their SPDR tickers). Reports set differences (capped
     * samples); it does not pick a winner — the primary route
     * above stays authoritative for screening. russell3000 has
     * no Wikipedia table, so it uses crossCheckRussell3000Union
     * instead — calling this with russell3000 throws from the
     * Wikipedia side, loudly, rather than comparing against
     * nothing.
     */
    async crossCheck(index: IndexId): Promise<IndexCrossCheck> {
      const [wiki, hold] = await Promise.all([
        deps.wikipedia.getMembers(index),
        deps.holdings.getMembers(index),
      ]);
      const w = new Set(wiki.symbols.map((s) => s.symbol));
      const h = new Set(hold.symbols.map((s) => s.symbol));
      return {
        index,
        wikipediaCount: w.size,
        holdingsCount: h.size,
        onlyInWikipedia: [...w].filter((s) => !h.has(s)).slice(0, 20),
        onlyInHoldings: [...h].filter((s) => !w.has(s)).slice(0, 20),
      };
    },
    /**
     * #2962 Russell 3000 cross-check: the IWB + IWM union vs an
     * IWV (iShares Russell 3000) holdings file supplied by the
     * caller ("where fetchable" — the file text is injected,
     * like every other fetcher in this module). Reports set
     * differences (capped samples); it does not pick a winner
     * — the union route above stays authoritative.
     */
    async crossCheckRussell3000Union(
      iwvCsvText: string
    ): Promise<Russell3000CrossCheck> {
      const union = await deps.holdings.getMembers("russell3000");
      const iwv = parseHoldingsFile(iwvCsvText, union.snapshotDate, "IWV");
      const u = new Set(union.symbols.map((s) => s.symbol));
      const v = new Set(iwv.members.map((s) => s.symbol));
      return {
        index: "russell3000",
        unionCount: u.size,
        iwvCount: v.size,
        onlyInUnion: [...u].filter((s) => !v.has(s)).slice(0, 20),
        onlyInIwv: [...v].filter((s) => !u.has(s)).slice(0, 20),
      };
    },
  };
}

/**
 * Convert members to screener listings. Exchange is metadata here, not
 * a price input: quotes are keyed by symbol, and index screens do not
 * filter by exchange. Unknown exchanges fall back to "nasdaq" solely
 * to satisfy the listing shape; the member record itself keeps the
 * honest absence.
 */
export function membersToListings(
  membership: IndexMembership
): NasdaqStockListing[] {
  return membership.symbols.map((m) => ({
    symbol: m.symbol,
    companyName: m.name ?? m.symbol,
    exchange: m.exchange ?? "nasdaq",
    change: 0,
    changePercent: 0,
    sector: m.sector,
  }));
}

/**
 * Consumer path (acceptance 2): resolve an index to members, feed them
 * as `opts.symbols` into the existing `acquireUniverse` live-quotes
 * mode, and screen with the existing pipeline — unchanged. No
 * screener, quote, or provider behavior changes beyond accepting the
 * membership list as input.
 */
export async function screenIndexMembers(
  port: IndexMembershipPort,
  index: IndexId,
  filter: StockScreenerFilter = {},
  quoteDeps: QuoteScreenerDeps,
  maxSymbols?: number
) {
  const membership = await port.getMembers(index);
  const acquired = await acquireUniverse({
    mode: "live-quotes",
    symbols: membersToListings(membership),
    maxSymbols,
    quoteDeps,
  });
  return screenUniverse(new DynamicMarketScreener(), acquired, filter);
}

/** Live wiring shape (composition root binds real fetchers). */
export function createLiveIndexMembershipService(
  fetchHtml: WikipediaFetcher,
  fetchCsv: HoldingsFetcher
) {
  return createIndexMembershipService({
    wikipedia: createWikipediaIndexMembershipAdapter(fetchHtml),
    holdings: createEtfHoldingsIndexMembershipAdapter(fetchCsv),
  });
}

// Re-exported for tests/consumers that need the quote shape.
export type { ETradeQuote };
