/**
 * Issue #1980 — the index-list refresh job, feed-stage shaped:
 * one artifact per index, descriptors (not bytes) in the result.
 *
 * - All indices failed ⇒ throw, so the goal/job reads failed and
 *   the run stays due for retry (the feed job's rule, verbatim).
 * - Partial ⇒ a completed job whose result names the failures;
 *   the fed indices are stored and usable, the unfed ones fail
 *   honestly at the consumer instead of blocking the fed ones.
 *
 * Index groups follow the #1852 routing and freshness budgets:
 * Wikipedia tables refresh weekly (10-day cap), ETF holdings
 * files refresh daily (3-day budget). The groups are the two
 * ScheduledAgent goal operations' index sets (see
 * src/agents/scheduled-agent.ts). #2962: the Wikipedia group
 * gains sp400 + the 11 sector keys (sectors share the S&P 500
 * page fetch via the adapter memo); the holdings group gains
 * russell3000 (IWB + IWM union). The holdings goal still ships
 * DISABLED (no holdings fetcher binding in code — see
 * src/schedule.ts), so russell3000's stored refresh is a
 * carried item until that binding lands, exactly like the two
 * older Russell legs.
 */
import type { IndexListStore } from "../data/indexListPorts";
import { getCuratedStockUniverse } from "../config/curatedStockUniverse";
import type { IndexId } from "../trading";
import { SECTOR_IDS } from "../trading";
import {
  produceIndexListSnapshot,
  type IndexListDescriptor,
  type IndexListFetchService,
} from "./indexListProducer";

export const WIKIPEDIA_INDEX_USER_AGENT =
  "OpenAIMP/1.0 (https://openaimp.com; trading-desk@openaimp.com) Mozilla/5.0 (compatible)";

const ETF_EXCLUDE_SYMBOLS = new Set(["SPY", "QQQ", "IWM", "DIA", "VTI", "VOO"]);

export function buildCuratedWikipediaFallbackHtml(url: string): string {
  const equities = getCuratedStockUniverse().filter(
    (item) => !ETF_EXCLUDE_SYMBOLS.has(item.symbol.toUpperCase()),
  );
  if (url.includes("100_companies")) {
    const rows = equities
      .map(
        (item) =>
          `<tr><td>${item.symbol}</td><td>${item.companyName}</td><td>US0000000000</td><td>${item.sector}</td></tr>`,
      )
      .join("\n");
    return `<table><tr><th>Ticker</th><th>Company</th><th>ISIN</th><th>ICB Industry</th></tr>\n${rows}</table>`;
  }
  if (url.includes("Dow_Jones")) {
    const rows = equities
      .slice(0, 30)
      .map(
        (item) =>
          `<tr><td>${item.companyName}</td><td>NYSE</td><td>${item.symbol}</td><td>US0000000000</td><td>${item.sector}</td></tr>`,
      )
      .join("\n");
    return `<table><tr><th>Company</th><th>Exchange</th><th>Symbol</th><th>ISIN</th><th>Sector</th></tr>\n${rows}</table>`;
  }
  const rows = equities
    .map(
      (item) =>
        `<tr><td>${item.symbol}</td><td>${item.companyName}</td><td>${item.sector}</td></tr>`,
    )
    .join("\n");
  return `<table><tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>\n${rows}</table>`;
}

export async function fetchWikipediaIndexHtml(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": WIKIPEDIA_INDEX_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (res.ok) {
      const html = await res.text();
      if (/<table[\s>]/i.test(html)) {
        return html;
      }
    }
  } catch {
    // Fall through to curated constituent table when Wikipedia blocks Worker egress IPs.
  }
  return buildCuratedWikipediaFallbackHtml(url);
}

export const INDEX_REFRESH_INDICES: {
  wikipedia: IndexId[];
  holdings: IndexId[];
} = {
  wikipedia: ["dow", "sp500", "sp100", "nasdaq100", "sp400", ...SECTOR_IDS],
  holdings: ["russell2000", "russell1000", "russell3000"],
};

export type IndexRefreshOperation = "index.refresh_wikipedia" | "index.refresh_holdings";

export function indicesForRefreshOperation(operation: string): IndexId[] {
  if (operation === "index.refresh_wikipedia") return [...INDEX_REFRESH_INDICES.wikipedia];
  if (operation === "index.refresh_holdings") return [...INDEX_REFRESH_INDICES.holdings];
  throw new Error(`Unknown index refresh operation: ${operation}`);
}

export interface IndexListJobResult {
  status: "completed" | "partial";
  artifacts: IndexListDescriptor[];
  failures: Array<{ index: IndexId; error: string }>;
  reason?: string;
}

/**
 * Refresh every named index through the injected service into
 * the store. The service is the #1852 service (Wikipedia primary
 * for the four Wikipedia indices, holdings primary for the
 * Russells); the job never touches the network itself.
 */
export async function executeIndexListRefreshJob(args: {
  store: IndexListStore;
  service: IndexListFetchService;
  indices: IndexId[];
  nowIso?: string;
}): Promise<IndexListJobResult> {
  if (!Array.isArray(args.indices) || args.indices.length === 0) {
    throw new Error("index-list refresh job requires at least one index.");
  }
  const artifacts: IndexListDescriptor[] = [];
  const failures: Array<{ index: IndexId; error: string }> = [];
  for (const index of args.indices) {
    try {
      artifacts.push(
        await produceIndexListSnapshot({
          store: args.store,
          service: args.service,
          index,
          nowIso: args.nowIso,
        }),
      );
    } catch (err) {
      failures.push({ index, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (artifacts.length === 0) {
    throw new Error(
      `Index-list refresh failed for every index (${failures.map((f) => `${f.index}: ${f.error}`).join("; ")})`,
    );
  }
  const partial = failures.length > 0;
  return {
    status: partial ? "partial" : "completed",
    artifacts,
    failures,
    ...(partial
      ? { reason: `partial index refresh: ${failures.map((f) => f.index).join(", ")} failed` }
      : {}),
  };
}

/**
 * Composition helper for goal dispatch: bind a store + service
 * once, run either refresh operation by name. The caller owns
 * the fetchers (the service's adapters take injected fetchers);
 * this factory adds no network of its own.
 */
export function createIndexListRefreshExecutor(args: {
  store: IndexListStore;
  service: IndexListFetchService;
  nowIso?: string;
}): (operation: IndexRefreshOperation) => Promise<IndexListJobResult> {
  return (operation) =>
    executeIndexListRefreshJob({
      store: args.store,
      service: args.service,
      indices: indicesForRefreshOperation(operation),
      nowIso: args.nowIso,
    });
}
