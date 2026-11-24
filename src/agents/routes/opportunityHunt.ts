/**
 * Issue 6273 — Opportunity Hunt on-demand run (UX surface).
 *
 * POST /opportunity-hunt/run runs the hunt synchronously and returns the
 * full result (setups per symbol/strategy, scanned/skipped counts, asOf),
 * so the Stock Hub sub-tab can show the hunt's output instead of only
 * the one-line ledger descriptor the scheduled goal records.
 *
 * Reuse, not a new hunt: the run is `executeOpportunityHunt` over the
 * same persisted technicals bars the scheduled-agent handler reads
 * (same feed job, same stale rule, same named failures — a missing or
 * stale artifact fails as opportunity_hunt_no_bars, never an empty
 * "success"). The evaluator, the strategies, and the schedule are
 * untouched; this file only composes the existing loader blocks into a
 * run seam, exactly as the handler composes them. The loader wiring is
 * deliberately duplicated here rather than extracted: the handler is
 * frozen for this slice, so a shared loader is a follow-up, not part
 * of this change.
 *
 * Note: server.ts strips the /api prefix before forwarding, so the DO
 * sees /opportunity-hunt/run.
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { TradingPlatformRegistry, brokerSupports } from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { isFeatureEnabled } from "../../config/featureFlags";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";
import { BROKER_PANEL_CONTRACT_FLAG } from "./brokerReads";
import { createFeedDatasetAdapter } from "../../data/createFeedDatasetPorts";
import {
  buildFeedJobRegistry,
  readPersistedTechnicalsBars,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
} from "../../services/feedJobs";
import {
  executeOpportunityHunt,
  type OpportunityHuntHoldingsStatus,
  type OpportunityHuntResult,
} from "../../services/opportunityHunt";
import { getPdfAsset } from "../report-asset-agent";

/** The storage-key prefix for hunt report PDFs. The download route
 *  serves only keys with this prefix, so a hunt link can never
 *  read a screener/options/research blob (and vice versa). */
const OPPORTUNITY_HUNT_PDF_KEY_PREFIX = "report:pdf:opportunity-hunt:";

/**
 * Light shape check for a client-posted hunt result. The panel posts
 * the exact result its run returned, so the PDF renders the same
 * output the panel shows; a malformed body is refused (400) rather
 * than rendered into a report of invented data.
 */
function isOpportunityHuntResult(value: unknown): value is OpportunityHuntResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.setups) &&
    typeof r.scanned === "number" &&
    typeof r.skipped === "number" &&
    typeof r.asOf === "string" &&
    typeof r.summary === "string" &&
    !!r.holdingsStatus &&
    typeof r.holdingsStatus === "object" &&
    typeof (r.holdingsStatus as Record<string, unknown>).available === "boolean" &&
    !!r.seriesBySymbol &&
    typeof r.seriesBySymbol === "object"
  );
}

export interface OpportunityHuntRouteContext {
  /** Worker env (AGENT_DB binds the feed dataset store). */
  env: unknown;
  /** Issue 6406 — the holdings read reuses the broker-reads blocks, so the route needs the same two. */
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
}

/**
 * Issue 6406 — the tenant's holdings for the exit evaluation, from the
 * tenant's selected broker (never a named broker, never a silent fallback).
 *
 * This is the broker-reads route's own composition (`brokerReads.ts`),
 * reused verbatim: the `broker_panel_contract` flag gates the read, the
 * tenant's broker serves it, a broker without the positions capability is
 * refused by name, and a failed read is a coded reason. Any of those
 * states returns an empty holdings map with the reason attached — the
 * hunt then runs flat (entries only) and the panel states the reason,
 * instead of silently dropping exits or failing a working entry hunt.
 * Only long equity positions with a known cost basis feed the evaluator:
 * options and shorts are not the hunt's long-only universe, and an
 * unknown cost basis is not an entry price.
 */
export async function loadHuntHoldings(
  request: Request,
  ctx: OpportunityHuntRouteContext,
): Promise<{
  holdings: ReadonlyMap<string, number>;
  status: OpportunityHuntHoldingsStatus;
}> {
  const unavailable = (
    reason: string,
    broker?: string,
  ): {
    holdings: ReadonlyMap<string, number>;
    status: OpportunityHuntHoldingsStatus;
  } => ({
    holdings: new Map<string, number>(),
    status: {
      available: false,
      ...(broker ? { broker } : {}),
      reason,
    },
  });
  try {
    if (!(await isFeatureEnabled(ctx.env as Env, BROKER_PANEL_CONTRACT_FLAG))) {
      return unavailable(
        "FEATURE_DISABLED: the broker positions read is disabled",
      );
    }
    const broker = await resolveTenantBroker(ctx.env);
    if (!brokerSupports(broker, "positions")) {
      return unavailable(
        `provider_unsupported: ${broker} does not expose positions`,
        broker,
      );
    }
    const userLogin = request.headers.get("x-user-login") || "";
    const environment = resolveBrokerEnvironmentFromSettings(
      (key) => ctx.readSettingRaw(key) ?? null,
      ctx.env as Partial<Env>,
    );
    const platform = TradingPlatformRegistry.getPlatform(
      broker,
      ctx.env as Env,
      ctx.getOrm(),
      userLogin,
      environment,
    );
    if (typeof platform.getPositions !== "function") {
      return unavailable(
        `BROKER_CAPABILITY_NOT_IMPLEMENTED: ${broker} positions`,
        broker,
      );
    }
    const { positions } = await platform.getPositions();
    const holdings = new Map<string, number>();
    for (const position of positions ?? []) {
      if (position.securityType === "OPTN") continue;
      if (position.positionType === "SHORT") continue;
      if (position.costBasisKnown === false) continue;
      const entry = Number(position.pricePaid);
      if (!Number.isFinite(entry) || entry <= 0) continue;
      holdings.set(String(position.symbol).toUpperCase(), entry);
    }
    return { holdings, status: { available: true, broker } };
  } catch (err) {
    return unavailable(
      `BROKER_POSITIONS_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Load the hunt's closes from the persisted technicals bars — the same
 * loader the scheduled-agent hunt handler uses, composed from the same
 * blocks. An unbound store is a configuration state, not an empty
 * universe; a missing or stale artifact yields no closes, and the
 * execute step names that failure (opportunity_hunt_no_bars).
 */
async function loadHuntCloses(
  env: unknown,
  now: Date,
): Promise<ReadonlyMap<string, readonly number[]>> {
  const envStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    env as unknown as Record<string, unknown>,
  )) {
    if (typeof value === "string") envStrings[key] = value;
  }
  const technicalsDef = buildFeedJobRegistry(envStrings).get(
    YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
  );
  const store = createFeedDatasetAdapter(env as { AGENT_DB?: unknown });
  if (!store) {
    throw new Error(
      "opportunity_hunt_store_unbound: AGENT_DB is not bound on this host",
    );
  }
  const persisted = await readPersistedTechnicalsBars(store, {
    ...(technicalsDef
      ? { maxAgeSeconds: technicalsDef.staleAfterMinutes * 60 }
      : {}),
    nowMs: now.getTime(),
  });
  const closes = new Map<string, number[]>();
  if (!persisted || persisted.stale) return closes;
  for (const [symbol, bars] of persisted.barsBySymbol) {
    const series = bars
      .map((bar) => bar.close)
      .filter((close) => Number.isFinite(close));
    if (series.length > 0) closes.set(symbol, series);
  }
  return closes;
}

export async function handleOpportunityHuntRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: OpportunityHuntRouteContext,
): Promise<Response | null> {
  // Issue 6273: on-demand hunt run for the Stock Hub sub-tab.
  if (path.endsWith("/opportunity-hunt/run") && request.method === "POST") {
    try {
      const now = new Date();
      // Issue 6406 — the tenant's holdings ride into the evaluation so exit
      // signals can fire; an unavailable holdings read degrades to entries
      // only with the reason attached, never a silent drop or a failed hunt.
      const { holdings, status: holdingsStatus } = await loadHuntHoldings(
        request,
        ctx,
      );
      const result = await executeOpportunityHunt({
        now: () => now,
        loadCloses: () => loadHuntCloses(ctx.env, now),
        holdings,
        holdingsStatus,
      });
      return Response.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.split(":")[0] || "opportunity_hunt_failed";
      return Response.json({ ok: false, code, error: message }, { status: 500 });
    }
  }

  // Issue 6403: generate the hunt's downloadable report (PDF) from
  // the panel's current result, through the unified report pipeline.
  // The result rides in the request body — the PDF renders the exact
  // result the panel shows, so the two cannot drift apart (a fresh
  // server-side re-run could differ if the bars moved). The pipeline
  // stores the PDF via the ReportAssetAgent; the canonical row is
  // written through the shared storeReportStage seam. A generation
  // failure is a 502 with the error, never a fabricated link.
  if (path.endsWith("/opportunity-hunt/report") && request.method === "POST") {
    try {
      const userLogin = request.headers.get("x-user-login") || "";
      if (!userLogin) {
        return Response.json(
          { ok: false, code: "unauthenticated", error: "A user login is required to generate a hunt report." },
          { status: 401 },
        );
      }
      const body = (await request.json().catch(() => null)) as { result?: unknown } | null;
      const result = body?.result;
      if (!isOpportunityHuntResult(result)) {
        return Response.json(
          { ok: false, code: "invalid_hunt_result", error: "The request body must carry a hunt result (OpportunityHuntResult)." },
          { status: 400 },
        );
      }
      const { runReportPipeline, storeReportStage } = await import(
        "../../services/unifiedReportPipeline"
      );
      const timestamp = result.asOf;
      const pipelineResult = await runReportPipeline(
        ctx.env as { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
        null as unknown as {
          put: (key: string, value: unknown) => Promise<void>;
          get: (key: string) => Promise<unknown>;
        },
        {
          type: "opportunity-hunt",
          trigger: "manual",
          result,
          userLogin,
          title: `Opportunity Hunt report — ${result.asOf.slice(0, 10)}`,
          summary: result.summary,
          timestamp,
        },
      );
      if (pipelineResult.pdfStatus !== "generated") {
        return Response.json(
          {
            ok: false,
            code: "report_generation_failed",
            error: pipelineResult.pdfError || "The hunt report could not be generated.",
          },
          { status: 502 },
        );
      }
      const generationId = pipelineResult.generationId;
      const stored = storeReportStage(ctx.getOrm() as never, {
        runId: `opportunity-hunt:manual:${result.asOf}`,
        generationId,
        title: `Opportunity Hunt report — ${result.asOf.slice(0, 10)}`,
        source: "opportunity-hunt",
        summary: result.summary,
        body: result,
        createdAt: new Date().toISOString(),
        userLogin,
      });
      void stored; // A missing canonical row never fails a report that already generated.
      return Response.json({
        ok: true,
        pdfKey: pipelineResult.pdfKey,
        generationId,
        reportUrl: `/api/opportunity-hunt/report.pdf?key=${encodeURIComponent(pipelineResult.pdfKey)}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, code: "opportunity_hunt_report_failed", error: message }, { status: 500 });
    }
  }

  // Issue 6403: download a generated hunt report PDF. Serves only
  // hunt-namespaced keys, through the ReportAssetAgent blob store.
  if (path.endsWith("/opportunity-hunt/report.pdf") && request.method === "GET") {
    try {
      const key = url.searchParams.get("key");
      if (!key) {
        return Response.json({ ok: false, code: "missing_key", error: "A report key is required." }, { status: 400 });
      }
      if (!key.startsWith(OPPORTUNITY_HUNT_PDF_KEY_PREFIX)) {
        return Response.json({ ok: false, code: "invalid_key", error: "This endpoint serves Opportunity Hunt reports only." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || "";
      if (!userLogin) {
        return Response.json({ ok: false, code: "unauthenticated", error: "A user login is required to download a hunt report." }, { status: 401 });
      }
      const pdf = await getPdfAsset(
        ctx.env as { REPORT_ASSET_AGENT?: unknown },
        userLogin,
        key,
      );
      if (!pdf) {
        return Response.json({ ok: false, code: "report_not_found", error: "No Opportunity Hunt report found for this key." }, { status: 404 });
      }
      return new Response(pdf.bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
          "Content-Length": String(pdf.bytes.length),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, code: "opportunity_hunt_report_download_failed", error: message }, { status: 500 });
    }
  }

  return null;
}
