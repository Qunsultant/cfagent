/**
 * Issue #1888: enrichment routes (Durable Object side).
 *
 *   GET  /enrichment/status        dashboard surface: active provider,
 *                                   coverage, fallbacks, errors, breaker
 *                                   state, killswitch state, quality
 *   GET  /enrichment/runs           recent run records (summary fields)
 *   GET  /enrichment/runs/:id       one run record
 *   POST /enrichment/run            run enrichment for a job universe
 *   POST /enrichment/killswitch     throw/clear the dedicated loop switch
 *   GET  /enrichment/calibration    governed proposal (propose only)
 *
 * (Paths are the DO-internal spellings: src/server.ts strips the
 * /api prefix when forwarding, so externally these are
 * /api/enrichment/*. The verified login — set by src/server.ts
 * from the session — gates every path here; mutations additionally
 * refuse without it, and the login is the audit actor.)
 *
 * Providers are always named (Yahoo, Alpaca). The market-data
 * boundary adapter below is the ONLY place this slice references
 * the pre-existing provider service implementation; every other
 * module, label, event, and document in this slice uses provider
 * names or provider-neutral names.
 */

import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import type { FeatureFlagPort } from "../../features/featureFlagPorts";
import { ENRICHMENT_ALPACA_FLAG } from "../../enrichment/enrichmentPorts";
import {
  buildEnrichmentCalibrationProposal,
  enrichmentLoopStopped,
  resolveEnrichmentSelection,
  toEnrichmentKillswitchEnvelope,
  type EnrichmentKillswitchState,
} from "../../enrichment/enrichmentPorts";
import {
  runEnrichment,
  type EnrichmentMarketData,
} from "../../enrichment/enrichmentService";
import {
  SqlEnrichmentStore,
  type EnrichmentSqlExecutor,
} from "../../data/doSqliteEnrichmentAdapter";
import type { EnrichmentRunRecord } from "../../enrichment/enrichmentPorts";
import { defaultBreakerRegistry } from "../../breakers/createBreakerPorts";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { writeEnvelopeToSink } from "../../observability/observabilityPorts";
import { isAdaptationHalted } from "../../services/adaptationAudit";
import type { MessageEnvelope } from "../../messaging/messagingPorts";
// Boundary import: the pre-existing Yahoo/Alpaca provider service.
// This slice consumes it; it does not rename it (the full rename
// sweep is a recorded follow-up, not a blind find-replace here).
import { MarketDataResearchService } from "../../services/marketDataResearch";
import type { Env } from "../../types";

export interface EnrichmentRouteContext {
  env: Env;
  sql: EnrichmentSqlExecutor;
  userLogin: string;
  recordAudit(
    type: string,
    agent: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  marketData?: EnrichmentMarketData;
  flagPort?: FeatureFlagPort;
  breakerSnapshots?: () => Array<{ providerId: string; state: string }>;
  /** Test seam: overrides the settings-table global-halt read. */
  globalHalted?: boolean;
  /** Best-effort observability emission. Absent = the #1743 sink
   *  for this env (unbound degrades to local logging, never fails). */
  emit?: (envelope: MessageEnvelope) => void | Promise<void>;
  nowMs?: () => number;
  /** Test seam: injected store (production builds the SQL store). */
  store?: EnrichmentRouteStore;
}

export interface EnrichmentRouteStore {
  recordRun(run: EnrichmentRunRecord): Promise<void> | void;
  listRuns(limit?: number): Promise<EnrichmentRunRecord[]> | EnrichmentRunRecord[];
  getRun(id: string): Promise<EnrichmentRunRecord | null> | EnrichmentRunRecord | null;
  qualitySummary(limit?: number): import("../../enrichment/enrichmentPorts").EnrichmentQualitySummary;
  getKillswitchState(): EnrichmentKillswitchState;
  setKillswitch(state: EnrichmentKillswitchState, setBy: string, reason: string): EnrichmentKillswitchState;
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/** Boundary adapter: existing providers onto the neutral port. */
function defaultMarketData(env: Env): EnrichmentMarketData {
  const service = new MarketDataResearchService(env);
  const toProvider = (p: "yahoo" | "alpaca") =>
    p === "yahoo" ? "yfinance" : "alpaca";
  return {
    isAlpacaConfigured: () => service.getProvider("alpaca").isConfigured(env),
    getQuote: async (symbol, provider) => {
      await service.getQuote(symbol, toProvider(provider) as "yfinance" | "alpaca");
      return { ok: true };
    },
    // Fundamentals are Yahoo-only by provider capability (Alpaca has
    // no live fundamentals): always Yahoo, never faked.
    getFundamentals: async (symbol) => {
      await service.getFundamentals(symbol);
      return { ok: true };
    },
    getBars: async (symbol, provider, timeframe, limit) => {
      const bars = await service.getHistoricalBars(
        symbol,
        timeframe,
        limit,
        toProvider(provider) as "yfinance" | "alpaca",
      );
      return bars.map((b) => ({
        timestamp: String(b.timestamp),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        volume: Number(b.volume),
      }));
    },
  };
}

/** Dashboard list shape: coverage + accounting only, no per-symbol detail. */
function summarizeRun(r: EnrichmentRunRecord) {
  return {
    id: r.id,
    jobId: r.jobId,
    stage: r.stage,
    provider: r.provider,
    mode: r.mode,
    symbolsRequested: r.symbolsRequested,
    symbolsServed: r.symbolsServed,
    barsFetched: r.barsFetched,
    fallbacks: r.fallbacks,
    partial: r.partial,
    stopped: r.stopped,
    createdAt: r.createdAt,
  };
}

export async function handleEnrichmentRoutes(
  request: Request,
  url: URL,
  path: string,
  _sessionId: string,
  ctx: EnrichmentRouteContext,
): Promise<Response | null> {
  const isStatus = path === "/enrichment/status";
  const isRuns = path === "/enrichment/runs";
  const runIdMatch = path.match(/^\/enrichment\/runs\/([^/]+)$/);
  const isRun = path === "/enrichment/run";
  const isKillswitch = path === "/enrichment/killswitch";
  const isCalibration = path === "/enrichment/calibration";
  if (!isStatus && !isRuns && !runIdMatch && !isRun && !isKillswitch && !isCalibration) {
    return null;
  }
  if (!ctx.userLogin) return unauthorized();

  const store =
    ctx.store ?? new SqlEnrichmentStore(ctx.sql, ctx.recordAudit);
  const killswitchState = store.getKillswitchState();
  const globalHalted =
    ctx.globalHalted ?? isAdaptationHalted(ctx.sql as never);
  const stopped = enrichmentLoopStopped({
    killswitchThrown: killswitchState === "halted",
    globalHalted,
  });
  const emit: (envelope: MessageEnvelope) => void | Promise<void> =
    ctx.emit ??
    (async (envelope) => {
      try {
        await writeEnvelopeToSink(createObservabilitySink(ctx.env), envelope);
      } catch {
        // Best-effort: emission never fails a run or a switch change.
      }
    });
  const flagPort = ctx.flagPort ?? createFeatureFlagPort(ctx.env);
  const alpacaFlagOn = await flagPort.isEnabled(ENRICHMENT_ALPACA_FLAG);
  const marketData = ctx.marketData ?? defaultMarketData(ctx.env);
  const selection = resolveEnrichmentSelection({
    alpacaFlagOn,
    alpacaConfigured: marketData.isAlpacaConfigured(),
  });
  const breakerSnapshots =
    ctx.breakerSnapshots ??
    (() =>
      defaultBreakerRegistry()
        .snapshots()
        .filter((s) => s.providerId === "yahoo" || s.providerId === "alpaca")
        .map((s) => ({ providerId: s.providerId, state: s.state })));

  if (isStatus && request.method === "GET") {
    const recent = await store.listRuns(10);
    return Response.json({
      ok: true,
      provider: selection.primary,
      mode: selection.mode,
      selectionReason: selection.reason,
      flag: { [ENRICHMENT_ALPACA_FLAG]: alpacaFlagOn },
      alpacaConfigured: marketData.isAlpacaConfigured(),
      killswitch: killswitchState,
      globalHalt: globalHalted,
      stopped,
      breakerState: breakerSnapshots(),
      quality: store.qualitySummary(200),
      recentRuns: recent.map((r) => summarizeRun(r)),
    });
  }

  if (isRuns && request.method === "GET") {
    const limit = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("limit") || 20) || 20),
    );
    return Response.json({
      ok: true,
      runs: (await store.listRuns(limit)).map((r) => summarizeRun(r)),
    });
  }

  if (runIdMatch && request.method === "GET") {
    const found = await store.getRun(decodeURIComponent(runIdMatch[1]));
    if (!found) return Response.json({ error: "Run not found." }, { status: 404 });
    return Response.json({ ok: true, run: found });
  }

  if (isRun && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return badRequest("JSON body required.");
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId) return badRequest("jobId is required.");
    const stage = body.stage === "gather" ? "gather" : "feed";
    const symbols = Array.isArray(body.symbols)
      ? body.symbols.filter((s): s is string => typeof s === "string")
      : [];
    if (symbols.length === 0) return badRequest("symbols (non-empty array) is required.");
    if (symbols.length > 200) return badRequest("symbols is capped at 200 per run.");
    const minuteTimeframe =
      typeof body.minuteTimeframe === "string" && body.minuteTimeframe.trim()
        ? body.minuteTimeframe.trim()
        : undefined;
    try {
      const record = await runEnrichment({
        jobId,
        stage,
        symbols,
        minuteTimeframe,
        marketData,
        alpacaFlagOn,
        killswitchThrown: killswitchState === "halted",
        globalHalted,
        store,
        breakerSnapshots,
        emit,
        nowMs: ctx.nowMs,
      });
      return Response.json({ ok: true, stopped: record.stopped, run: summarizeRun(record) });
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : "Enrichment run failed.");
    }
  }

  if (isKillswitch && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return badRequest("JSON body required.");
    const state = body.state as EnrichmentKillswitchState;
    if (state !== "halted" && state !== "clear") {
      return badRequest('state must be "halted" or "clear".');
    }
    const reason = typeof body.reason === "string" ? body.reason : "";
    const next = store.setKillswitch(state, ctx.userLogin, reason);
    try {
      await emit(
        toEnrichmentKillswitchEnvelope({
          state: next,
          setBy: ctx.userLogin,
          atMs: ctx.nowMs ? ctx.nowMs() : Date.now(),
        }),
      );
    } catch {
      // Best-effort: the state change + audit already landed.
    }
    return Response.json({ ok: true, state: next, setBy: ctx.userLogin });
  }

  if (isCalibration && request.method === "GET") {
    if (stopped) {
      return Response.json(
        {
          error: "Enrichment loop stopped: calibration proposals are refused while stopped.",
          stopped: true,
          killswitch: killswitchState,
          globalHalt: globalHalted,
        },
        { status: 409 },
      );
    }
    const quality = store.qualitySummary(200);
    const proposal = buildEnrichmentCalibrationProposal(quality, {
      alpacaConfigured: marketData.isAlpacaConfigured(),
    });
    // Proposed only: application is a human flag flip by the
    // operator. This endpoint never applies anything, and the
    // stopped branch above refuses proposals while stopped.
    return Response.json({ ok: true, proposal, quality });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
