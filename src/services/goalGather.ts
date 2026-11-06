/**
 * Issue #1998 (Phase 3): the persisted gather for the goal stock leg.
 *
 * The goal stock leg screens the listing feed, whose quotes carry no
 * technical fields — so thesis filters (RSI, momentum) refuse with a
 * validationError. The gather enriches the acquired universe before
 * evaluation:
 *
 *   live quotes + Yahoo quotes, intersected on symbols → technicals
 *   batch (Yahoo history) for real RSI/MACD → persist one
 *   mas_data_captures row per intersected symbol (capability
 *   "quotes", runId = the caller run id per D2) → read the rows
 *   BACK and evaluate those, never the in-memory join.
 *
 * Issue #2056 dataset rule (refined by the owner 2026-10-27,
 * superseding the intersection wording for the row dimension):
 * when a live real-time source (E*TRADE) is present, Yahoo has NO
 * row effect — it neither adds rows (gap-fill, retired) nor vetoes
 * them (intersection, superseded). Rows come from the live source
 * alone; Yahoo complements COLUMNS on those rows (live wins on a
 * shared column, Yahoo fills live gaps) where present. A live-only
 * symbol is still stored, with live columns; a Yahoo-only symbol is
 * never stored. Provenance is by construction — each side is
 * fetched through its own deps object, so no source-label parsing
 * is needed (the #1998 label rule is superseded for this path;
 * the combined seam's labels still serve other paths).
 *
 * No new store, no new capability value, no gather.ts schema. A
 * symbol with no valid stored row is missing, never zero-filled:
 * per-symbol missingness is recorded, and the screen ledger-rejects
 * it with the honest reason.
 */

import type { ETradeQuote } from "../types";
import type { SqlStorage } from "../orm";
import {
  canonicalJson,
  fetchPlatformTechnicalsBatch,
  listCapabilityRoutes,
  listCapturesByRun,
  readCaptureRaw,
  recordCapture,
  sha256Hex,
  type CapabilityRouteRecord,
  type CaptureBlobDeps,
  type CaptureBlobStorage,
  type DataProviderId,
  type QuoteScreenerDeps,
  type RecordCaptureInput,
  type ScreenLiveEnrichment,
  type ScreenLiveEnrichmentResult,
  type YahooHistoryDeps,
} from "../trading";
import type { ObservabilitySink } from "../observability/observabilityPorts";
import { timestampIsoFor } from "../observability/observabilityPorts";
import { gatherMissText } from "../observability/alertingList";
import type { ProviderConfigStore } from "../data/providerConfigPorts";
import type { ProviderCaptureStore } from "../data/providerCapturePorts";

export const GATHER_REQUEST_MARKER = "goal-gather-1998";

function missingFieldsFor(enriched: Partial<ETradeQuote>): string[] {
  const missing: string[] = [];
  if (enriched.week52High == null && enriched.high52 == null) missing.push("week52High");
  if (enriched.averageVolume == null) missing.push("averageVolume");
  if (enriched.rsi == null) missing.push("rsi");
  return missing;
}

/** First non-null value wins (live-first column union). */
function pick<T>(...values: (T | null | undefined)[]): T | undefined {
  for (const v of values) if (v != null) return v;
  return undefined;
}

export interface GoalGatherInput {
  sql: SqlStorage;
  blobStorage: CaptureBlobStorage;
  blobEnv: { REPORTS_BUCKET?: R2Bucket };
  tenantId: string;
  userLogin?: string;
  /** Caller run id (D2: the idempotency key) — the rows' runId. */
  runId: string;
  /** Live-source quote seam (the route's primary provider, no gap-fill). */
  liveQuoteDeps: QuoteScreenerDeps;
  /**
   * Yahoo quote seam. Complements columns on live rows where
   * present; absent (or failing) degrades to live-only rows, never
   * to an empty dataset — Yahoo has no row effect.
   */
  yahooQuoteDeps?: QuoteScreenerDeps;
  /** History deps; absent = technicals degrade to null per symbol. */
  historyDeps?: YahooHistoryDeps;
  /**
   * Capability routes override (test seam). Absent = read from sql
   * at enrich time, so the snapshot is the run-time route table.
   */
  routes?: CapabilityRouteRecord[];
  /** #1743 sink; absent = no emission, never a failure. */
  sink?: ObservabilitySink;
  /**
   * Phase 5 slice 7 (#2000): total-miss alert channel; absent =
   * event-only, never a failure. The caller supplies the
   * operator surface (postSlackText); the gather itself never
   * imports a delivery channel, so a missing channel degrades
   * to the miss event alone.
   */
  alertText?: (text: string) => Promise<void>;
  /**
   * #2303 (#1976 step 1): the data-layer ports. When the host
   * supplies them, the gather's capture writes + read-back run
   * through the capture port (the D1 capture log the adapters
   * wrote under the same run id) and the route snapshot reads
   * through the config port; otherwise the sql reads/writes run
   * unchanged. Consistency rule: a gather must read back from
   * the same store its adapters wrote to.
   */
  capturePort?: ProviderCaptureStore | null;
  configPort?: ProviderConfigStore | null;
}

function routeSnapshotHash(routes: CapabilityRouteRecord[]): Promise<string> {
  const snapshot = routes
    .filter((r) => r.capability === "quotes" || r.capability === "historicalBars")
    .map((r) => ({
      capability: r.capability,
      primaryProviderId: r.primaryProviderId,
      gapFillProviderId: r.gapFillProviderId,
      minTier: r.minTier,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => a.capability.localeCompare(b.capability));
  return sha256Hex(canonicalJson(snapshot));
}

/**
 * Fetch one side's quotes. Batch preferred, per-symbol fallback.
 * A side carries a symbol iff it returns a positive-price row for it.
 * Per-symbol failure → missing on this side; whole-batch failure →
 * this side is empty. Never throws.
 */
async function fetchSide(
  deps: QuoteScreenerDeps | undefined,
  symbols: string[]
): Promise<Map<string, ETradeQuote>> {
  const out = new Map<string, ETradeQuote>();
  if (!deps) return out;
  try {
    if (deps.fetchQuotes) {
      for (const row of await deps.fetchQuotes(symbols)) {
        if (row && row.lastPrice > 0) out.set(row.symbol.toUpperCase(), row);
      }
    } else {
      for (const symbol of symbols) {
        try {
          const row = await deps.fetchQuote(symbol);
          if (row && row.lastPrice > 0) out.set(symbol, row);
        } catch {
          // Per-symbol failure → honest null on this side, never fabricated.
        }
      }
    }
  } catch {
    // Whole-batch failure: this side stays empty below.
  }
  return out;
}

export function createGoalGatherEnrichment(input: GoalGatherInput): ScreenLiveEnrichment {
  const blobDeps: CaptureBlobDeps = { storage: input.blobStorage, env: input.blobEnv };
  // #2303: the gather's capture writes run through the capture
  // port when the host wired one — the same store the gather's
  // adapters wrote to (see the input's consistency rule).
  const recordGatherCapture = (recInput: RecordCaptureInput) =>
    input.capturePort
      ? input.capturePort.recordCapture(blobDeps, recInput)
      : recordCapture(input.sql, blobDeps, recInput);
  return {
    async enrich(quotes: ETradeQuote[]): Promise<ScreenLiveEnrichmentResult> {
      const listingsBySymbol = new Map<string, ETradeQuote>();
      for (const q of quotes) listingsBySymbol.set(q.symbol.toUpperCase(), q);
      const symbols = [...listingsBySymbol.keys()];

      // 1. Fetch both sides separately; rows come from the live
      // side alone, Yahoo complements columns where present.
      const live = await fetchSide(input.liveQuoteDeps, symbols);
      const yahoo = await fetchSide(input.yahooQuoteDeps, symbols);
      const kept: string[] = [];
      const missingFields: Record<string, string[]> = {};
      for (const symbol of symbols) {
        if (live.has(symbol)) {
          kept.push(symbol);
        } else if (yahoo.has(symbol)) {
          // Yahoo-only: never a row (no gap-fill rows).
          missingFields[symbol] = ["quote:live"];
        } else {
          missingFields[symbol] = ["quote"];
        }
      }
      const yahooComplemented = kept.filter((s) => yahoo.has(s)).length;

      // 2. Technicals batch over the live rows only.
      const technicals = input.historyDeps
        ? await fetchPlatformTechnicalsBatch(input.historyDeps, kept)
        : new Map();

      // 3. Route snapshot at run time = the version. The stored row's
      // provider is the route's quotes primary (the live source the
      // run chose); without a quotes route there is no live provider
      // to attribute, so kept symbols go missing instead of riding
      // an invented provider.
      const routes =
        input.routes ??
        (input.configPort
          ? await input.configPort.listCapabilityRoutes()
          : listCapabilityRoutes(input.sql));
      const routeVersionHash = await routeSnapshotHash(routes);
      const quotesRoute = routes.find((r) => r.capability === "quotes");
      const providerId: DataProviderId | null =
        (quotesRoute?.primaryProviderId as DataProviderId | undefined) ?? null;

      // 4. Persist one row per live symbol, columns unioned
      // live-first (Yahoo fills live gaps where it served the
      // symbol; a live-only symbol stores with live columns).
      // A row is stored even when some fields are missing:
      // the row IS the audit trail for partial coverage, and the screen
      // rejects on the missing fields honestly (see step 5 note).
      for (const symbol of kept) {
        if (!providerId) {
          missingFields[symbol] = ["provider"];
          continue;
        }
        const base = listingsBySymbol.get(symbol)!;
        const liveQuote = live.get(symbol)!;
        const yahooQuote = yahoo.get(symbol);
        const t = technicals.get(symbol);
        const enriched: ETradeQuote = {
          ...base,
          lastPrice: liveQuote.lastPrice,
          price: liveQuote.lastPrice,
          change: pick(liveQuote.change, yahooQuote?.change) ?? base.change,
          changePercent: pick(liveQuote.changePercent, yahooQuote?.changePercent) ?? base.changePercent,
          bid: pick(liveQuote.bid, yahooQuote?.bid) ?? base.bid,
          ask: pick(liveQuote.ask, yahooQuote?.ask) ?? base.ask,
          volume: pick(liveQuote.volume, yahooQuote?.volume) ?? base.volume,
          open: pick(liveQuote.open, yahooQuote?.open) ?? base.open,
          high: pick(liveQuote.high, yahooQuote?.high) ?? base.high,
          low: pick(liveQuote.low, yahooQuote?.low) ?? base.low,
          previousClose: pick(liveQuote.previousClose, yahooQuote?.previousClose, base.previousClose),
          week52High: pick(liveQuote.week52High, yahooQuote?.week52High),
          week52Low: pick(liveQuote.week52Low, yahooQuote?.week52Low),
          high52: pick(liveQuote.high52, liveQuote.week52High, yahooQuote?.high52, yahooQuote?.week52High),
          low52: pick(liveQuote.low52, liveQuote.week52Low, yahooQuote?.low52, yahooQuote?.week52Low),
          averageVolume: pick(liveQuote.averageVolume, yahooQuote?.averageVolume),
          source: pick(liveQuote.source, yahooQuote?.source),
          quoteStatus: pick(liveQuote.quoteStatus, yahooQuote?.quoteStatus, base.quoteStatus),
          timestamp: pick(liveQuote.timestamp, yahooQuote?.timestamp, base.timestamp) ?? base.timestamp,
          ...(t?.rsi14 != null ? { rsi: t.rsi14 } : {}),
          ...(t?.macdSignal != null ? { macdSignal: t.macdSignal } : {}),
        };
        const missing = missingFieldsFor(enriched);
        missingFields[symbol] = missing;
        await recordGatherCapture({
          providerId,
          capability: "quotes",
          requestParams: {
            gather: GATHER_REQUEST_MARKER,
            runId: input.runId,
            symbol,
            routeVersionHash,
            gapFilled: false,
            liveProviderId: providerId,
            yahooPresent: yahoo.has(symbol),
            routeSnapshot: routes
              .filter((r) => r.capability === "quotes" || r.capability === "historicalBars")
              .map((r) => ({
                capability: r.capability,
                primaryProviderId: r.primaryProviderId,
                gapFillProviderId: r.gapFillProviderId,
                minTier: r.minTier,
                updatedAt: r.updatedAt,
              })),
          },
          runId: input.runId,
          tenantId: input.tenantId,
          ...(input.userLogin ? { userLogin: input.userLogin } : {}),
          rawPayload: enriched,
          normalizedResult: enriched,
        });
      }

      // 5. Read back: the gate evaluates STORED rows, never the join.
      // Duplicate rows for a symbol (retries) dedup to the latest
      // write; a corrupt latest row fails closed to missing, never
      // silently back to a stale row.
      const rows = (input.capturePort
        ? await input.capturePort.listCapturesByRun(input.tenantId, input.runId)
        : listCapturesByRun(input.sql, input.tenantId, input.runId))
        .filter(
          (r) =>
            r.capability === "quotes" &&
            (r.requestParams as Record<string, unknown> | undefined)?.gather === GATHER_REQUEST_MARKER
        )
        .sort((a, b) => (b.fetchedAt ?? "").localeCompare(a.fetchedAt ?? ""));
      const seen = new Set<string>();
      const enrichedBySymbol = new Map<string, ETradeQuote>();
      // #2056: gap-filled members are retired — Yahoo never adds
      // rows, so this count stays 0. The field remains on the
      // result for seam stability.
      const gapFilledCount = 0;
      for (const row of rows) {
        const params = row.requestParams as Record<string, unknown>;
        const symbol = String(params.symbol ?? "");
        if (!symbol || seen.has(symbol)) continue;
        seen.add(symbol);
        try {
          const read = input.capturePort
            ? await input.capturePort.readCaptureRaw(blobDeps, input.tenantId, row.id)
            : await readCaptureRaw(input.sql, blobDeps, input.tenantId, row.id);
          if (!read || !read.rawBytes) continue;
          const parsed = JSON.parse(new TextDecoder().decode(read.rawBytes)) as ETradeQuote;
          if (row.normalizedDigest) {
            const digest = await sha256Hex(canonicalJson(parsed));
            if (digest !== row.normalizedDigest) continue;
          }
          enrichedBySymbol.set(symbol, parsed);
        } catch {
          continue;
        }
      }
      const enrichedQuotes = quotes
        .map((q) => q.symbol.toUpperCase())
        .filter((s) => enrichedBySymbol.has(s))
        .map((s) => enrichedBySymbol.get(s)!);
      const missingSymbols = symbols.filter((s) => !enrichedBySymbol.has(s));
      for (const s of missingSymbols) {
        if (!missingFields[s]) missingFields[s] = ["quote"];
      }

      // 6. #1743 stage event, best-effort (never fails the run).
      if (input.sink) {
        try {
          const now = Date.now();
          await input.sink.write({
            type: "goal.gather.stored",
            level: "info",
            operation: "goal.gather.stored",
            tenantId: input.tenantId,
            actorId: null,
            agentId: null,
            component: "goal-gather",
            runId: input.runId,
            sessionRef: null,
            traceId: crypto.randomUUID(),
            timestampMs: now,
            timestampIso: timestampIsoFor(now),
            count: enrichedQuotes.length,
            fields: {
              stored: enrichedQuotes.length,
              missing: missingSymbols.length,
              gapFilled: gapFilledCount,
              yahooComplemented,
              routeVersionHash,
            },
          });
        } catch {
          // Best-effort only.
        }
      }

      // 7. Phase 5 slice 7 (#2000): gather-miss event + total-miss
      // alert, best-effort (never fails the run). Miss = any
      // requested symbol without a stored row (per #2056: live
      // alone supplies rows, Yahoo-only never stores, so a
      // Yahoo-only symbol IS a miss — its live side failed).
      // Counts only: symbol lists never ride the event or the
      // alert. A partial miss is event-visible, not paged; only
      // a total miss (requested > 0, stored === 0 — the run has
      // no dataset) pages the operator. An empty universe
      // (requested 0) is neither event nor alert.
      if (missingSymbols.length > 0 && input.sink) {
        try {
          const now = Date.now();
          await input.sink.write({
            type: "goal.gather.missed",
            level: "warn",
            operation: "goal.gather",
            tenantId: input.tenantId,
            actorId: null,
            agentId: null,
            component: "goal-gather",
            runId: input.runId,
            sessionRef: null,
            traceId: crypto.randomUUID(),
            timestampMs: now,
            timestampIso: timestampIsoFor(now),
            count: missingSymbols.length,
            fields: {
              requested: symbols.length,
              stored: enrichedQuotes.length,
              missing: missingSymbols.length,
            },
          });
        } catch {
          // Best-effort only.
        }
      }
      if (
        symbols.length > 0 &&
        enrichedQuotes.length === 0 &&
        input.alertText
      ) {
        try {
          await input.alertText(
            gatherMissText({
              runId: input.runId,
              requested: symbols.length,
              stored: 0,
              missing: missingSymbols.length,
            }),
          );
        } catch {
          // Best-effort only: a failed page never fails the run.
        }
      }

      return {
        runId: input.runId,
        enrichedQuotes,
        missingSymbols,
        missingFields,
        gapFilledCount,
        routeVersionHash,
      };
    },
  };
}
