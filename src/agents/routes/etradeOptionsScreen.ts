/**
 * Issue #995: E*TRADE options route sub-domain module, split out of
 * src/agents/routes/etradeOptions.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeOptions.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the manual options screen and unified options execution (post-parse tails)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import {
  DynamicOptionsScreener,
  UnifiedOptionsService,
  adaptOpportunityScanToOptionScreenResult,
  parseOptionsScreenRequest,
  buildStrategyReportInput,
  strategyReportArtifactLinks,
  buildOpportunityScanSummary,
  bodyPresentFields,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  resolveStrategyMode,
  type OpportunityScanResult,
} from "../../trading";
import {
  createScannerScreenPorts,
  type ScannerPipelineRequest,
} from "../../workflows/strategyScreenPorts";
import { createOptionsDiscoveryPorts } from "../../data/createOptionsDiscoveryPorts";
import { isDemoCalibratedChainsEnabled } from "../../config/demoMode";
import { buildDataProviderPorts } from "../../data/buildDataProviderPorts";
import { deliverGatedSlack } from "../../services/gatedSlackDelivery";
import { recordOptionsRunOutcome, storeOptionsCanonicalReport } from "../../services/optionsServeRecord";
import { resolveTenantProviders } from "../../services/tenantProviders";
import { resolveTenantProviderContext, withProviderProvenance } from "../../services/optionsProviderContext";
import { getEventCalendarCoverage, toEventCalendarInfo } from "../../services/eventCalendar";
import type { EtradeOptionsRouteContext } from "./etradeOptions";
import { createOptionsScreenPorts, optionsArtifactKey } from "../../workflows/optionsScreenPorts";
import { runOptionsScreenWorkflow } from "../../workflows/optionsScreenWorkflow";
import {
  createManualOptionsRecordBuilder,
  createManualOptionsScreenDelivery,
} from "../../workflows/manualOptionsScreen";
import { createSqlStageClaimStore } from "../../data/stageClaimsStore";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/etradeOptionsScreen",
});

type OptionsScreenValue = Extract<ReturnType<typeof parseOptionsScreenRequest>, { ok: true }>["value"];

export async function executeOptionsScreen(args: {
  ctx: EtradeOptionsRouteContext;
  userLogin: string;
  screener: DynamicOptionsScreener;
  screenFilter: OptionsScreenValue["filter"];
  screenPushToSlack: OptionsScreenValue["pushToSlack"];
  screenSlackChannel: OptionsScreenValue["slackChannel"];
  screenUniverseLabel: OptionsScreenValue["universe"];
  screenEmailTo: OptionsScreenValue["emailTo"];
  /** Issue #1123: when the screen runs as a tracked job, the follow-up
   *  pipeline owns delivery — skip the inline Slack delivery. */
  deferDelivery?: boolean;
}): Promise<Response> {
  const { ctx, userLogin, screener, screenFilter, screenPushToSlack, screenSlackChannel, screenUniverseLabel, screenEmailTo, deferDelivery } = args;
  // Issue #3186 (step 3d): the manual screen runs the one options
  // pipeline instead of the registry provider. The run id IS the
  // route's generation id (options_scanner:manual:<iso>), so the
  // pipeline's canonical row is the route's row - no duplicate.
  // The report + delivery blocks live in the manual delivery module
  // (workflows/manualOptionsScreen.ts) as the pipeline's shapeReport
  // / deliver stages; the #3072 end-of-run emitter retires for this
  // entry (the pipeline publishes per-stage messages instead - and
  // this was its only caller, so the legacy phases retire with it).
  const generationId = `options_scanner:manual:${new Date().toISOString()}`;
  const claims = createSqlStageClaimStore(() => ctx.agentCtx.storage.sql);
  const ports = createOptionsScreenPorts({
    screener,
    storage: ctx.agentCtx.storage,
    canonical: {
      storeCanonicalReport: (input, env) => ctx.getOrm().storeCanonicalReport(input, env),
    },
    ...createManualOptionsScreenDelivery({
      ctx: ctx as never,
      screenFilter,
      screenPushToSlack,
      screenSlackChannel,
      screenUniverseLabel,
      screenEmailTo,
      deferDelivery,
    }),
    record: createManualOptionsRecordBuilder(ctx as never),
    demoFallback: isDemoCalibratedChainsEnabled(),
  });
  const outcome = await runOptionsScreenWorkflow(
    {
      runId: generationId,
      userLogin,
      request: {
        assetClass: "options",
        runIdentity: { runId: generationId },
        trigger: "manual",
        classInput: {
          request: {
            filter: screenFilter,
            pushToSlack: screenPushToSlack,
            slackChannel: screenSlackChannel,
            universe: screenUniverseLabel,
            emailTo: screenEmailTo,
          },
        },
      },
    },
    {
      stages: ports,
      claims,
      queue: (ctx.env as { SCREENER_EVENTS?: { send: (body: unknown) => Promise<unknown> } }).SCREENER_EVENTS ?? null,
    },
  );
  if (outcome.outcome === "failed") {
    throw new Error(
      `options screen failed at ${outcome.failedStage}: ${outcome.reason ?? "unknown reason"}`,
    );
  }
  const screened = await ctx.agentCtx.storage.get<{ result: Record<string, unknown> }>(
    optionsArtifactKey(generationId, "screen"),
  );
  const shaped = await ctx.agentCtx.storage.get<{ report: Record<string, unknown> }>(
    optionsArtifactKey(generationId, "shapeReport"),
  );
  if (!screened || screened.result === undefined || !shaped || shaped.report === undefined) {
    throw new Error(`options screen completed but its artifacts are missing for run ${generationId}`);
  }
  const result = screened.result;
  const report = shaped.report;
  return Response.json({
    ...result,
    pdfKey: report["pdfKey"],
    reportUrl: report["reportUrl"],
    xlsxKey: report["xlsxKey"],
    xlsxUrl: report["xlsxUrl"],
    csvKey: report["csvKey"],
    csvUrl: report["csvUrl"],
  });
}


/**
 * Issue #3186 step 3e - the unified handler's opportunities action
 * through the one scanner pipeline. Mirrors
 * UnifiedOptionsService.execute()'s opportunities case field for
 * field: template, scan options (profile merge included), request
 * record (caller-sent fields only, targetDate resolved), platform
 * run id via classInput. A failed profile resolution returns the
 * same error RESPONSE execute() returns (never a throw, never a
 * profile-less run). A failed pipeline outcome throws, exactly as
 * an execute() throw surfaces on this route. Deliberate difference:
 * MEMORY_CACHE is bypassed (60s chain TTL; a rapid re-click
 * re-scans instead of re-serving - the honest behavior for a manual
 * trigger-now).
 */
async function runUnifiedOpportunitiesViaPipeline(args: {
  ctx: EtradeOptionsRouteContext;
  service: UnifiedOptionsService;
  reqData: any;
  userLogin: string;
  discoveryPorts: ReturnType<typeof createOptionsDiscoveryPorts>;
}) {
  const { ctx, service, reqData, userLogin, discoveryPorts } = args;
  const symbols =
    reqData.symbols && reqData.symbols.length > 0
      ? reqData.symbols
      : reqData.symbol
        ? [reqData.symbol.toUpperCase()]
        : [];
  if (symbols.length === 0) {
    throw new Error("Provide explicit symbols or a live universe for options screening; no static symbols are substituted.");
  }
  const targetDate =
    reqData.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
  const { profile: strategyProfile, error: profileError } =
    await service.resolveStrategyProfile(reqData);
  if (profileError) {
    return service.formatResponse(reqData, { error: profileError }, profileError, false);
  }
  const { engineClient, platformRunId } = await service.resolveEngineClient();
  const runId = `options_scanner:unified:${new Date().toISOString()}:${reqData.thesis || "mixed"}`;
  const outcome = await runOptionsScreenWorkflow(
    {
      runId,
      userLogin,
      request: {
        assetClass: "options",
        runIdentity: { runId },
        trigger: "manual",
        classInput: {
          scan: {
            symbols,
            template: {
              thesis: reqData.thesis || "bullish",
              targetDate,
              expectedIvDirection: reqData.expectedIvDirection || "unchanged",
              maxPlannedLoss: reqData.maxPlannedLoss || 1000,
              minRewardRisk: reqData.minRewardRisk || 1.5,
              allowedStrategies:
                reqData.allowedStrategies && reqData.allowedStrategies.length > 0
                  ? reqData.allowedStrategies
                  : ["all"],
              optimizationBias: reqData.optimizationBias,
              ...(reqData.perSymbol ? { perSymbol: reqData.perSymbol } : {}),
              ...(reqData.statedTarget ? { statedTarget: reqData.statedTarget } : {}),
              ...(reqData.minDte !== undefined ? { minDte: reqData.minDte } : {}),
              ...(reqData.maxDte !== undefined ? { maxDte: reqData.maxDte } : {}),
              strategyMode: resolveStrategyMode(reqData),
              ...(resolveStrategyMode(reqData) === "all" ? { evaluateAllStrategies: true } : {}),
              ...(reqData.farDated !== undefined ? { farDated: reqData.farDated } : {}),
            },
            options: {
              riskProfile: reqData.riskProfile || "balanced",
              ...(reqData.mode ? { mode: reqData.mode } : {}),
              ...(reqData.limit !== undefined ? { limit: reqData.limit } : {}),
              ...(reqData.candidateLimit !== undefined ? { candidateLimit: reqData.candidateLimit } : {}),
              ...(reqData.maxSymbols !== undefined ? { maxSymbols: reqData.maxSymbols } : {}),
              ...(reqData.eventCalendarBySymbol ? { eventCalendarBySymbol: reqData.eventCalendarBySymbol } : {}),
              ...(reqData.offset !== undefined ? { offset: reqData.offset } : {}),
              ...(strategyProfile
                ? { profile: strategyProfile, explicitFields: bodyPresentFields(reqData, true) }
                : {}),
            },
          },
          // Issue #103: the caller's original request, recorded
          // BEFORE the save - only fields the caller sent, with
          // symbols/targetDate the resolved values the scan ran
          // under - exactly as execute() built it.
          requestRecord: {
            symbols,
            targetDate,
            ...(reqData.thesis !== undefined ? { thesis: reqData.thesis } : {}),
            ...(reqData.riskProfile !== undefined ? { riskProfile: reqData.riskProfile } : {}),
            ...(reqData.mode !== undefined ? { mode: reqData.mode } : {}),
            ...(reqData.profileId !== undefined ? { profileId: reqData.profileId } : {}),
            ...(reqData.profileName !== undefined ? { profileName: reqData.profileName } : {}),
            ...(reqData.limit !== undefined ? { limit: reqData.limit } : {}),
            ...(reqData.offset !== undefined ? { offset: reqData.offset } : {}),
            ...(reqData.expectedIvDirection !== undefined ? { expectedIvDirection: reqData.expectedIvDirection } : {}),
            ...(reqData.optimizationBias !== undefined ? { optimizationBias: reqData.optimizationBias } : {}),
            ...(reqData.maxPlannedLoss !== undefined ? { maxPlannedLoss: reqData.maxPlannedLoss } : {}),
            ...(reqData.minRewardRisk !== undefined ? { minRewardRisk: reqData.minRewardRisk } : {}),
            ...(reqData.allowedStrategies !== undefined ? { allowedStrategies: reqData.allowedStrategies } : {}),
            ...(reqData.perSymbol !== undefined ? { perSymbol: reqData.perSymbol } : {}),
            ...(reqData.statedTarget !== undefined ? { statedTarget: reqData.statedTarget } : {}),
            ...(reqData.minDte !== undefined ? { minDte: reqData.minDte } : {}),
            ...(reqData.maxDte !== undefined ? { maxDte: reqData.maxDte } : {}),
            ...(reqData.strategyMode !== undefined || reqData.evaluateAllStrategies !== undefined
              ? { strategyMode: resolveStrategyMode(reqData) }
              : {}),
            ...(reqData.farDated !== undefined ? { farDated: reqData.farDated } : {}),
            ...(reqData.candidateLimit !== undefined ? { candidateLimit: reqData.candidateLimit } : {}),
          },
          ...(platformRunId ? { platformRunId } : {}),
        },
      } as ScannerPipelineRequest,
    },
    {
      stages: createScannerScreenPorts({
        agents: {
          data: new OptionsDataAgent(new DynamicOptionsScreener(engineClient)),
          risk: new StrategyRiskAgent(),
          recommender: new RecommendationAgent(),
        },
        storage: ctx.agentCtx.storage,
        scanRunStore: discoveryPorts.scanRuns,
      }),
      claims: createSqlStageClaimStore(() => ctx.agentCtx.storage.sql),
      queue: (ctx.env as { SCREENER_EVENTS?: { send: (body: unknown) => Promise<unknown> } }).SCREENER_EVENTS ?? null,
    },
  );
  if (outcome.outcome !== "completed") {
    throw new Error(`Unified options scan failed at ${outcome.failedStage}: ${outcome.reason}`);
  }
  const shaped = await ctx.agentCtx.storage.get<OpportunityScanResult & { scanRunId?: string; persisted?: boolean }>(
    optionsArtifactKey(runId, "shapeReport"),
  );
  if (!shaped) {
    throw new Error("Unified options scan completed without a report artifact; refusing to answer from nothing.");
  }
  // The shaped result already carries its save receipt (scanRunId /
  // persisted) from the persist stage; the summary is the shared
  // opportunities-case summary.
  return service.formatResponse(reqData, shaped, buildOpportunityScanSummary(shaped), false);
}

export async function executeUnifiedOptions(args: {
  request: Request;
  sessionId: string;
  ctx: EtradeOptionsRouteContext;
  reqData: any;
}): Promise<Response> {
  const { request, sessionId, ctx, reqData } = args;
  const userLogin = request.headers.get("x-user-login");
  if (!userLogin) return unauthenticatedResponse();
  // Provider/broker slice 2 (#2598): stamp the tenant's selections into
  // body.provenance on both canonical writes below — the same two
  // fields the unified record carries, resolved fail-open
  // (etrade/etrade). This runs only after the feed gate passed.
  const unifiedProviderProvenance = withProviderProvenance(
    {},
    resolveTenantProviderContext(await resolveTenantProviders(ctx.env)),
  );
  // #2303: the platform ports for the service's platform block
  // (built from env; nulls when AGENT_DB is unbound).
  const dpPorts = await buildDataProviderPorts(ctx.env);
  const discoveryPorts = createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage });
  const service = new UnifiedOptionsService(ctx.env, userLogin, ctx.requestedEnv, ctx.getOrm(), discoveryPorts.scanRuns, discoveryPorts.strategyProfiles, ctx.agentCtx.storage.sql, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env }, undefined, dpPorts);
  // Issue #16: event calendars are server-side facts — strip any
  // client-supplied calendar, then fetch coverage for the
  // actions that run the strategy engine. The calendar service
  // never throws; uncovered names stay unverified.
  delete reqData.eventCalendarBySymbol;
  delete reqData.eventCalendar;
  // Issue #3264: the run trigger is a server-side fact — a manual
  // client must never stamp its own run "scheduled". This route is
  // the manual entry point (manual runs + user-initiated
  // regenerations of a stored plan), so the trigger is "manual"
  // here; only the scheduled caller passes "scheduled" to the
  // service. Overwrite, never trust a client-supplied value.
  reqData.trigger = "manual";
  if (reqData.action === "opportunities" || reqData.action === "strategies" || reqData.action === "best_trade" || reqData.action === "compare" || reqData.action === "llm_ideas" || reqData.action === "llm_evaluate") {
    const calSymbols = reqData.action === "opportunities"
      ? (Array.isArray(reqData.symbols) && reqData.symbols.length > 0 ? reqData.symbols : (reqData.symbol ? [reqData.symbol] : []))
      : [reqData.symbol || (reqData.action === "llm_ideas" || reqData.action === "llm_evaluate" ? "NVDA" : "SPY")];
    if (calSymbols.length > 0) {
      const calendarCoverage = await getEventCalendarCoverage(calSymbols);
      reqData.eventCalendarBySymbol = Object.fromEntries(
        Array.from(calendarCoverage.bySymbol, ([sym, cal]) => [sym, toEventCalendarInfo(cal)])
      );
    }
  }
  // Issue #3186 step 3e - the unified opportunities action runs
  // the one scanner pipeline instead of service.execute() (same
  // engine, staged). Every other action keeps execute() exactly as
  // before; the pipeline's formatted response is the same shape
  // execute() returns, so the report/delivery/response code below
  // reads it unchanged.
  const result =
    reqData.action === "opportunities"
      ? await runUnifiedOpportunitiesViaPipeline({ ctx, service, reqData, userLogin, discoveryPorts })
      : await service.execute(reqData);

  let reportUrl: string | undefined;
  let pdfKey: string | undefined;
  let scannerPdfBytes: Uint8Array | undefined;
  let scannerPdfFileName: string | undefined;
  // Issue #1195 (#1173 R3b): options XLSX for this flow.
  let scannerXlsxKey: string | undefined;
  let scannerXlsxBytes: Uint8Array | undefined;
  let scannerXlsxFileName: string | undefined;
  let scannerXlsxUrl: string | undefined;
  let scannerCsvKey: string | undefined;
  let scannerCsvBytes: Uint8Array | undefined;
  let scannerCsvFileName: string | undefined;
  let scannerCsvUrl: string | undefined;

  if (reqData.action === "opportunities" && result.success) {
    const timestamp = new Date().toISOString();
    // Issue #1023 (S4): the ONE unified report pipeline (delegates
    // to ReportAssetAgent per #680/#914), same idiom as the
    // scheduled path in ScheduledTasksService — no direct-generator
    // fallback; on failure pdfKey/reportUrl stay undefined.
    try {
      const { runReportPipeline } = await import("../../services/unifiedReportPipeline");
      const pipelineResult = await runReportPipeline(
        ctx.env as any,
        null as any, // Storage handled by ReportAssetAgent internally
        {
          type: "options",
          trigger: "manual",
          result: result.data,
          userLogin,
          title: `Options scanner — ${reqData.thesis || "mixed"} (${timestamp.slice(0, 10)})`,
          summary: result.summary,
          timestamp,
        }
      );
      if (pipelineResult.pdfStatus === "generated") {
        pdfKey = pipelineResult.pdfKey;
        const screenerAgent = ctx.getScreenerAgent(userLogin);
        const pdfData = await screenerAgent.getPdfByKey(pdfKey);
        if (pdfData) {
          scannerPdfBytes = pdfData.bytes;
          scannerPdfFileName = pdfData.fileName;
        }
        reportUrl = `/api/options/report.pdf?key=${encodeURIComponent(pdfKey)}`;
      } else {
        structuredLog.warn("etradeOptionsScreen.execute_unified_options_pdf_generation_failed", {
          message: "[Orchestrator] Manual options PDF generation failed:",
          error: pipelineResult.pdfError,
        });
      }
    } catch (pdfErr) {
      structuredLog.warn("etradeOptionsScreen.execute_unified_options_pdf_generation_failed", {
        message: "[Orchestrator] Manual options PDF generation failed:",
        error: pdfErr instanceof Error ? pdfErr.message : String(pdfErr),
      });
    }

    // Issue #1209 (F3 follow-up): the scan row was saved BEFORE this
    // PDF existed (UnifiedOptionsService persists during execute),
    // so its pdfKey is null and the runs-list badge stays dark.
    // Stamp the generated key back onto the saved row; a failed
    // backfill never fails the response — the badge simply stays
    // dark until the next run, exactly as a failed save behaves.
    if (pdfKey) {
      try {
        const scanRunId = (result.data as { scanRunId?: unknown } | null)?.scanRunId;
        if (typeof scanRunId === "string" && scanRunId) {
          const scanStore = createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns;
          await scanStore.updatePdfKey(scanRunId, pdfKey, { userLogin });
        }
      } catch (stampErr) {
        structuredLog.warn("etradeOptionsScreen.execute_unified_options_stamp_pdf_key_failed", {
          message: "[Orchestrator] Failed to stamp PDF key on scan run:",
          error: stampErr instanceof Error ? stampErr.message : String(stampErr),
        });
      }
    }

    // Issue #1195 (#1173 R3b): XLSX from the same result payload.
    // Issue #1570: the unified opportunities payload is an
    // OpportunityScanResult, not the OptionScreenResult the workbook
    // generator reads — adapt at this seam with the #1291 adapter
    // (XLSX only; the CSV call below is untouched by this slice).
    try {
      const agent = ctx.getScreenerAgent(userLogin);
      const stored = await agent.generateAndStoreOptionsXlsx(adaptOpportunityScanToOptionScreenResult(result.data));
      scannerXlsxKey = stored.key;
      scannerXlsxFileName = stored.fileName;
      scannerXlsxUrl = `/api/options/report.xlsx?key=${encodeURIComponent(stored.key)}`;
      const data = await agent.getOptionsXlsxByKey(stored.key);
      if (data) scannerXlsxBytes = data.bytes;
    } catch (xlsxErr) {
      structuredLog.warn("etradeOptionsScreen.execute_unified_options_xlsx_generation_failed", {
        message: "[Orchestrator] Manual options XLSX generation failed:",
        error: xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr),
      });
    }

    // Issue #1346: CSV from the same result payload (own failure
    // domain; recorded in the log, never fatal).
    // Issue #1587: the unified opportunities payload is an
    // OpportunityScanResult, not the OptionScreenResult the CSV
    // generator reads — adapt at this seam with the #1291 adapter
    // (same as the :409 XLSX seam fixed by #1570).
    try {
      const agent = ctx.getScreenerAgent(userLogin);
      const stored = await agent.generateAndStoreOptionsCsv(adaptOpportunityScanToOptionScreenResult(result.data));
      scannerCsvKey = stored.key;
      scannerCsvFileName = stored.fileName;
      scannerCsvUrl = `/api/options/report.csv?key=${encodeURIComponent(stored.key)}`;
      const data = await agent.getOptionsCsvByKey(stored.key);
      if (data) scannerCsvBytes = data.bytes;
    } catch (csvErr) {
      structuredLog.warn("etradeOptionsScreen.execute_unified_options_csv_generation_failed", {
        message: "[Orchestrator] Manual options CSV generation failed:",
        error: csvErr instanceof Error ? csvErr.message : String(csvErr),
      });
    }

    // XLSX/CSV twin of the PDF backfill above: the scan row was
    // saved before these artifacts existed, so stamp their keys
    // back onto it now (same non-fatal discipline — a failed stamp
    // never fails the response, the badge simply stays dark).
    if (scannerXlsxKey || scannerCsvKey) {
      try {
        const scanRunId = (result.data as { scanRunId?: unknown } | null)?.scanRunId;
        if (typeof scanRunId === "string" && scanRunId) {
          const scanStore = createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns;
          if (scannerXlsxKey) await scanStore.updateXlsxKey(scanRunId, scannerXlsxKey, { userLogin });
          if (scannerCsvKey) await scanStore.updateCsvKey(scanRunId, scannerCsvKey, { userLogin });
        }
      } catch (stampErr) {
        structuredLog.warn("etradeOptionsScreen.execute_unified_options_stamp_xlsx_csv_keys_failed", {
          message: "[Orchestrator] Failed to stamp XLSX/CSV keys on scan run:",
          error: stampErr instanceof Error ? stampErr.message : String(stampErr),
        });
      }
    }

    const shouldNotifySlack = reqData.pushToSlack !== false && reqData.pushToSlack !== "false";
    if (shouldNotifySlack) {
      try {
        const slackPayload = result.toSlack();
        const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
        const matchCount = result.data?.opportunities?.length ?? result.data?.matchedCount ?? 0;
        const sent = await deliverGatedSlack(ctx.env, {
          userLogin,
          text,
          channel: reqData.slackChannel,
          ...(scannerPdfBytes && scannerPdfFileName ? {
            pdf: {
              bytes: scannerPdfBytes,
              fileName: scannerPdfFileName,
              title: `Options Scanner Report — manual ${timestamp.slice(0, 10)}`,
              comment: `📄 Manual options scan PDF — ${matchCount} matches\n\n${text}`,
            },
          } : {}),
          ...(scannerXlsxBytes && scannerXlsxFileName ? {
            files: [{ bytes: scannerXlsxBytes, fileName: scannerXlsxFileName, title: scannerXlsxFileName }],
          } : {}),
          ...(scannerCsvBytes && scannerCsvFileName ? {
            files: [{ bytes: scannerCsvBytes, fileName: scannerCsvFileName, title: scannerCsvFileName }],
          } : {}),
        });
        if (!sent.ok) structuredLog.warn("etradeOptionsScreen.execute_unified_options_slack_pdf_delivery_failed", {
          message: "[Orchestrator] Slack PDF delivery (manual options) failed:",
          error: sent.error,
        });
      } catch (slackErr) {
        structuredLog.warn("etradeOptionsScreen.execute_unified_options_slack_notification_failed", {
          message: "[Orchestrator] Slack notification (manual options) error:",
          error: slackErr instanceof Error ? slackErr.message : String(slackErr),
        });
      }
    }

    const generatedAt = timestamp;
    const generationId = `options_scanner:${generatedAt}:${reqData.thesis || "mixed"}`;
    const orm = ctx.getOrm();
    storeOptionsCanonicalReport(orm, {
      runId: generationId,
      generationId,
      title: `Options scanner — ${reqData.thesis || "mixed"} (${generatedAt.slice(0, 10)})`,
      source: "options_scanner",
      summary: result.summary,
      body: { generatedAt, provenance: unifiedProviderProvenance, request: reqData, report: result.toWebhook(), pdfKey, pdfStatus: pdfKey ? "generated" : "failed", reportUrl, xlsxKey: scannerXlsxKey, xlsxUrl: scannerXlsxUrl, csvKey: scannerCsvKey, csvUrl: scannerCsvUrl },
      createdAt: generatedAt,
      // Options run-record fix: owner-scope the row (ownerless rows are invisible to
      // the owner-scoped Reports read).
      userLogin,
    },
    // Issue #1169 S4-1: thread ctx.env so the seam indexes this
    // options_scanner row at write time.
    ctx.env);
    // Options run-record fix: this path has no follow-up bridge, so it owns its run
    // record. Without it the run never appears in Workflow Runs and its
    // artifacts (PDF/XLSX/CSV) have nothing to attach to.
    recordOptionsRunOutcome(
      typeof (orm as { getSql?: () => unknown }).getSql === "function"
        ? ((orm as { getSql: () => unknown }).getSql() as any)
        : undefined,
      {
        id: `options-unified:${generationId}`,
        trigger: "manual",
        status: "completed",
        scanned: typeof result.data?.scanned === "number" ? result.data.scanned : result.data?.totalScanned,
        matched: typeof result.data?.matchedCount === "number"
          ? result.data.matchedCount
          : Array.isArray(result.data?.opportunities) ? result.data.opportunities.length : undefined,
        reportUrl,
        pdfKey,
        xlsxKey: scannerXlsxKey,
        csvKey: scannerCsvKey,
        origin: "manual-options-unified",
        createdAt: generatedAt,
      },
    );
  } else if (result.success) {
    // Strategy screener / AI actions (strategies, best-trade, compare,
    // llm_ideas, llm_evaluate) produce strategy-level results, not a
    // contract screen. Record the run too — both fit directions ("names
    // that fit my strategy", "strategies that fit my name") and the AI
    // evaluation must appear on the Reports tab and in Workflow Runs.
    const generatedAt = new Date().toISOString();
    const action = String(reqData.action || "strategies");
    const symbol = String(reqData.symbol || reqData.symbols?.[0] || "universe").toUpperCase();
    const generationId = `options_strategy:${action}:${symbol}:${generatedAt}`;
    const data = result.data as Record<string, any> | undefined;
    const ranked = Array.isArray(data?.ranked)
      ? data.ranked
      : Array.isArray(data?.quant?.ranked) ? data.quant.ranked : undefined;
    const matched = ranked?.length ?? (data?.bestTrade ? 1 : undefined);
    const reportInput = buildStrategyReportInput({
      action,
      request: reqData,
      data,
      summary: result.summary,
      generatedAt,
      symbol,
    });
    const artifacts = await ctx.getScreenerAgent(userLogin).generateAndStoreStrategyReport(reportInput);
    // Issue #2162: the response carries the same downloads the run records,
    // so the panel can open the report it just generated. A failed leg has
    // no key, so it contributes no link.
    const artifactLinks = strategyReportArtifactLinks(artifacts);
    reportUrl = artifactLinks.reportUrl;
    scannerXlsxKey = artifactLinks.xlsxKey;
    scannerXlsxUrl = artifactLinks.xlsxUrl;
    scannerCsvKey = artifactLinks.csvKey;
    scannerCsvUrl = artifactLinks.csvUrl;
    const orm = ctx.getOrm();
    storeOptionsCanonicalReport(orm, {
      runId: generationId,
      generationId,
      title: `Options strategy ${action === "llm_ideas" || action === "llm_evaluate" ? "AI" : "screener"} — ${symbol} (${action})`,
      source: "options_strategy",
      summary: result.summary,
      body: {
        generatedAt,
        provenance: unifiedProviderProvenance,
        action,
        symbol,
        request: reqData,
        success: true,
        withTrades: matched,
        report: result.toWebhook(),
        ...(artifacts.pdfKey ? { pdfKey: artifacts.pdfKey } : {}),
        ...(artifacts.pdfStatus ? { pdfStatus: artifacts.pdfStatus } : {}),
        ...(artifacts.pdfError ? { pdfError: artifacts.pdfError } : {}),
        ...(artifacts.xlsxKey ? { xlsxKey: artifacts.xlsxKey } : {}),
        ...(artifacts.xlsxStatus ? { xlsxStatus: artifacts.xlsxStatus } : {}),
        ...(artifacts.xlsxError ? { xlsxError: artifacts.xlsxError } : {}),
        ...(artifacts.csvKey ? { csvKey: artifacts.csvKey } : {}),
        ...(artifacts.csvStatus ? { csvStatus: artifacts.csvStatus } : {}),
        ...(artifacts.csvError ? { csvError: artifacts.csvError } : {}),
      },
      createdAt: generatedAt,
      userLogin,
    });
    recordOptionsRunOutcome(
      typeof (orm as { getSql?: () => unknown }).getSql === "function"
        ? ((orm as { getSql: () => unknown }).getSql() as any)
        : undefined,
      {
        id: ctx.asyncJobId ?? generationId,
        trigger: "manual",
        status: "completed",
        matched,
        pdfKey: artifacts.pdfKey,
        xlsxKey: artifacts.xlsxKey,
        csvKey: artifacts.csvKey,
        origin: "options-strategy-ai",
        createdAt: generatedAt,
      },
    );
  } else if (!result.success && reqData.pushToSlack !== false && reqData.pushToSlack !== "false") {
    const slackPayload = result.toSlack();
    const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
    const sent = await deliverGatedSlack(ctx.env, { userLogin, text, channel: reqData.slackChannel });
    if (!sent.ok) structuredLog.warn("etradeOptionsScreen.execute_unified_options_failed_run_slack_notification_failed", {
      message: "[Orchestrator] Slack notification (manual options failed) error:",
      error: sent.error,
    });
  }

  const channel = reqData.channel || "ui";
  if (channel === "slack") {
    return Response.json(result.toSlack());
  }
  if (channel === "email") {
    return Response.json({ html: result.toEmailHtml(), text: result.toEmailText(), summary: result.summary });
  }
  if (channel === "voice") {
    return Response.json(result.toVoice());
  }
  if (channel === "webhook") {
    return Response.json({ ...result.toWebhook(), reportUrl, xlsxUrl: scannerXlsxUrl, csvKey: scannerCsvKey, csvUrl: scannerCsvUrl });
  }
  if (channel === "mcp") {
    return Response.json(result.toMcp());
  }
  return Response.json({ ...result.toUi(), reportUrl, xlsxUrl: scannerXlsxUrl, csvKey: scannerCsvKey, csvUrl: scannerCsvUrl });
}
