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
  buildCalibratedOptionChains,
  createOptionsScreeningProvider,
  OPTIONS_SCREENING_PROVIDER_ID,
  parseOptionsScreenRequest,
  buildStrategyReportInput,
  strategyReportArtifactLinks,
} from "../../trading";
import { createOptionsDiscoveryPorts } from "../../data/createOptionsDiscoveryPorts";
import { isDemoCalibratedChainsEnabled } from "../../config/demoMode";
import { buildDataProviderPorts } from "../../data/buildDataProviderPorts";
import { deliverScreenerToSlackA2A } from "../../services/screenerSlackDelivery";
import { screenerOutcomeFromRunResult } from "../../services/screenerFollowups";
import { recordJobOutcome } from "../../services/jobOutcomes";
import { recordOptionsRunOutcome, storeOptionsCanonicalReport } from "../../services/optionsServeRecord";
import { resolveTenantProviders } from "../../services/tenantProviders";
import { resolveTenantProviderContext, withProviderProvenance } from "../../services/optionsProviderContext";
import {
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
  getCfpayConfig,
} from "../../services/cfpayA2A";
import {
  resolveOptionsRunEmailRecipient,
  sendOptionsRunEmail,
} from "../../services/optionsRunEmail";
import { ETradeEmailTradingService } from "../../trading";
import { getEventCalendarCoverage, toEventCalendarInfo } from "../../services/eventCalendar";
import type { EtradeOptionsRouteContext } from "./etradeOptions";

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
  // Consolidation C1 (issue #1201, epic #1151 R1): the manual options
  // screen executes through the Phase 0 ScreeningProvider (the
  // registry's options provider wrapping this same screener) — the
  // unified stack is the production path here, not a parallel one.
  // Same engine, same result object; the provider only stamps its
  // provenance id. The demo-fallback logic below is untouched.
  const provider = createOptionsScreeningProvider(OPTIONS_SCREENING_PROVIDER_ID, screener);
  const screened = await provider.screen({ assetClass: "options", filter: screenFilter });
  if (screened.assetClass !== "options") {
    throw new Error("Options screening provider returned a non-options result.");
  }
  let result = screened.result;

  // Demo-mode fallback (issue #65): generated chains may substitute for an
  // empty live screen ONLY in dev/demo deployments with the gate enabled,
  // and the result is stamped dataSource "calibrated-demo". Production is
  // live-only: an empty live screen returns empty, with its fetch errors.
  if (result.contracts.length === 0 && isDemoCalibratedChainsEnabled() && screenFilter.underlyingSymbols && screenFilter.underlyingSymbols.length > 0 && screenFilter.underlyingSymbols[0] !== "BROKEN") {
    const fallbackChains = buildCalibratedOptionChains(screenFilter.underlyingSymbols, screenFilter.minDte ?? 0, screenFilter.maxDte ?? 90);
    if (fallbackChains.length > 0) {
      const chainItems = fallbackChains.map((c) => ({ symbol: c.symbol, chain: c }));
      const fallbackResult = screener.evaluateChains(chainItems, screenFilter, screenFilter.underlyingSymbols.length, {
        warnings: ["Calibrated demo chains — generated data for development/demo, not live market data."],
      });
      if (fallbackResult.contracts.length > 0) {
        fallbackResult.dataSource = "calibrated-demo";
        result = fallbackResult;
      }
    }
  }
  if (result.dataSource === undefined) result.dataSource = "live";

  // Issue #294/#421/#423/#424 (PR #432): manual screens honor pushToSlack
  // — PDF generated, stored per-run, delivered via the Slack A2A path
  // with a reportUrl; failures notify too.
  // Issue #1023 (S4): generation goes through the ONE unified report
  // pipeline (delegates to ReportAssetAgent per #680/#914) — the same
  // idiom as the scheduled path in ScheduledTasksService. There is no
  // direct-generator fallback: on pipeline failure the run continues
  // with no pdfKey/reportUrl, exactly as a scheduled failure surfaces.
  let optionsReportUrl: string | undefined;
  let optionsPdfKey: string | undefined;
  let pdfBytes: Uint8Array | undefined;
  let fileName: string | undefined;

  try {
    const { runReportPipeline } = await import("../../services/unifiedReportPipeline");
    const pipelineResult = await runReportPipeline(
      ctx.env as any,
      null as any, // Storage handled by ReportAssetAgent internally
      {
        type: "options",
        trigger: "manual",
        result,
        userLogin,
        title: `Options contract screen — ${(screenFilter.underlyingSymbols || []).join(", ") || screenUniverseLabel || "selected underlyings"}`,
        summary: `${result.totalUnderlyingsScanned} underlyings scanned, ${result.totalContractsEvaluated} contracts evaluated, ${result.matchedCount} matched.`,
        timestamp: new Date().toISOString(),
      }
    );
    if (pipelineResult.pdfStatus === "generated") {
      optionsPdfKey = pipelineResult.pdfKey;
      // Fetch the bytes for Slack delivery (same seam the scheduled
      // path uses: ScreenerAgent storage first, ReportAssetAgent
      // fallback inside getPdfByKey).
      const screenerAgent = ctx.getScreenerAgent(userLogin);
      const pdfData = await screenerAgent.getPdfByKey(optionsPdfKey);
      if (pdfData) {
        pdfBytes = pdfData.bytes;
        fileName = pdfData.fileName;
      }
      optionsReportUrl = `/api/options/report.pdf?key=${encodeURIComponent(optionsPdfKey)}`;
    } else {
      console.warn("[Orchestrator] Manual options contract PDF generation failed:", pipelineResult.pdfError);
    }
  } catch (pdfErr) {
    console.warn("[Orchestrator] Manual options contract PDF generation failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
  }

  // Issue #1195 (#1173 R3b): options XLSX — its own failure domain,
  // mirroring the stock persistRun convention (failures recorded,
  // never fatal, never silent).
  let optionsXlsxKey: string | undefined;
  let optionsXlsxStatus: "generated" | "failed" | undefined;
  let optionsXlsxError: string | undefined;
  let optionsXlsxBytes: Uint8Array | undefined;
  let optionsXlsxFileName: string | undefined;
  try {
    const agent = ctx.getScreenerAgent(userLogin);
    const stored = await agent.generateAndStoreOptionsXlsx(result);
    optionsXlsxKey = stored.key;
    optionsXlsxFileName = stored.fileName;
    optionsXlsxStatus = "generated";
    const data = await agent.getOptionsXlsxByKey(stored.key);
    if (data) optionsXlsxBytes = data.bytes;
  } catch (xlsxErr) {
    optionsXlsxStatus = "failed";
    optionsXlsxError = xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr);
    console.warn("[Orchestrator] Manual options XLSX generation failed:", optionsXlsxError);
  }
  const optionsXlsxUrl = optionsXlsxKey
    ? `/api/options/report.xlsx?key=${encodeURIComponent(optionsXlsxKey)}`
    : undefined;

  // Issue #1346: options CSV — its own failure domain, mirroring
  // the XLSX block (failures recorded, never fatal, never silent).
  let optionsCsvKey: string | undefined;
  let optionsCsvStatus: "generated" | "failed" | undefined;
  let optionsCsvError: string | undefined;
  let optionsCsvBytes: Uint8Array | undefined;
  let optionsCsvFileName: string | undefined;
  try {
    const agent = ctx.getScreenerAgent(userLogin);
    const stored = await agent.generateAndStoreOptionsCsv(result);
    optionsCsvKey = stored.key;
    optionsCsvFileName = stored.fileName;
    optionsCsvStatus = "generated";
    const data = await agent.getOptionsCsvByKey(stored.key);
    if (data) optionsCsvBytes = data.bytes;
  } catch (csvErr) {
    optionsCsvStatus = "failed";
    optionsCsvError = csvErr instanceof Error ? csvErr.message : String(csvErr);
    console.warn("[Orchestrator] Manual options CSV generation failed:", optionsCsvError);
  }
  const optionsCsvUrl = optionsCsvKey
    ? `/api/options/report.csv?key=${encodeURIComponent(optionsCsvKey)}`
    : undefined;

  // Deliver over A2A to Slack channel unless caller explicitly opted out
  // (or the tracked follow-up pipeline owns delivery — issue #1123).
  // S5a: when the host provides the follow-up bridge, the run is
  // recorded + chained through the pipeline instead of delivering
  // inline; the A2A block remains the fallback for hosts without it.
  const shouldNotifySlack = screenPushToSlack !== false && !deferDelivery;
  // Issue #1333: delivery states for the inline outcome record below
  // (the bridged path records through the job-tree hook instead).
  let slackState: string | undefined;
  let emailState: string | undefined;
  if (shouldNotifySlack && ctx.scheduleScreenerFollowups) {
    await ctx.scheduleScreenerFollowups(
      screenerOutcomeFromRunResult("options", {
        success: true,
        thesis: screenUniverseLabel,
        totalScanned: result.totalUnderlyingsScanned,
        matchedCount: result.matchedCount,
        pdfKey: optionsPdfKey,
        pdfStatus: optionsPdfKey ? "generated" : undefined,
        xlsxKey: optionsXlsxKey,
        xlsxStatus: optionsXlsxStatus,
        xlsxError: optionsXlsxError,
        csvKey: optionsCsvKey,
        csvStatus: optionsCsvStatus,
        csvError: optionsCsvError,
        summary: `${result.totalUnderlyingsScanned} underlyings scanned · ${result.totalContractsEvaluated} contracts evaluated · ${result.matchedCount} matched.`,
      }, ctx.env.APP_BASE_URL),
      userLogin,
    );
  } else if (shouldNotifySlack) {
    const slackChannel = screenSlackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
    const summary = `📊 Options Contract Screen — ${(screenFilter.underlyingSymbols || []).join(", ") || screenUniverseLabel || "selected underlyings"}\n${result.totalUnderlyingsScanned} underlyings scanned · ${result.totalContractsEvaluated} contracts evaluated · ${result.matchedCount} matched.\n${result.filterSummary || ""}`;
    try {
      const sent = await deliverScreenerToSlackA2A(ctx.env, {
        text: summary,
        channel: slackChannel,
        ...(pdfBytes && fileName ? {
          pdf: {
            bytes: pdfBytes,
            fileName,
            title: `Options Contract Screen — ${new Date().toISOString().slice(0, 10)}`,
            comment: `📄 Options contract screener PDF\n\n${summary}`,
          },
        } : {}),
        ...(optionsXlsxBytes && optionsXlsxFileName ? {
          files: [{ bytes: optionsXlsxBytes, fileName: optionsXlsxFileName, title: optionsXlsxFileName }],
        } : {}),
        ...(optionsCsvBytes && optionsCsvFileName ? {
          files: [{ bytes: optionsCsvBytes, fileName: optionsCsvFileName, title: optionsCsvFileName }],
        } : {}),
      });
      slackState = sent.ok ? "sent" : "failed";
      if (!sent.ok) console.warn("[Orchestrator] Slack A2A options contract PDF delivery failed:", sent.error);
    } catch (slackErr) {
      console.warn("[Orchestrator] Slack A2A options delivery error:", slackErr instanceof Error ? slackErr.message : String(slackErr));
    }
  }

  // Issue #1336: manual options email — the one delivery cell the
  // manual route lacked. Only the inline path sends here: when the
  // follow-up pipeline owns delivery (bridge present, or a tracked
  // job context via deferDelivery), the bridge plans the email
  // instead — sending here too would double-deliver. Best-effort:
  // failures warn, never fail the run (same idiom as inline Slack).
  if (!deferDelivery && !ctx.scheduleScreenerFollowups) {
    const emailTo = resolveOptionsRunEmailRecipient(screenEmailTo, ctx.env as unknown as Record<string, unknown>);
    if (emailTo) {
      const symbolsLabel = (screenFilter.underlyingSymbols || []).join(", ") || screenUniverseLabel || "selected underlyings";
      const emailSummary = `📊 Options Contract Screen — ${symbolsLabel}\n${result.totalUnderlyingsScanned} underlyings scanned · ${result.totalContractsEvaluated} contracts evaluated · ${result.matchedCount} matched.\n${result.filterSummary || ""}`;
      try {
        const emailService = new ETradeEmailTradingService(ctx.env as any, ctx.getOrm(), userLogin);
        const sent = await sendOptionsRunEmail(
          {
            cfpay: getCfpayConfig(ctx.env),
            sendCfpay: (config, a) => cfpaySendEmail(config, a.to, a.subject, a.body),
            sendCfpayWithAttachments: (config, a) => cfpaySendEmailWithAttachments(config, a),
            sendLocal: (to, subject, html, text, attachments) => emailService.sendOutboundEmail(to, subject, html, text, attachments),
          },
          {
            to: emailTo,
            subject: `📊 Options Contract Screen — ${symbolsLabel} — ${new Date().toISOString().slice(0, 10)}`,
            textBody: `${emailSummary}${optionsReportUrl ? `\n\nPDF report: ${optionsReportUrl}` : ""}`,
            htmlBody: `${emailSummary.replace(/\n/g, "<br/>")}${optionsReportUrl ? `<br/><br/>PDF report: ${optionsReportUrl}` : ""}`,
            ...(pdfBytes && fileName ? { pdf: { bytes: pdfBytes, fileName } } : {}),
            ...(optionsXlsxBytes && optionsXlsxFileName ? { xlsx: { bytes: optionsXlsxBytes, fileName: optionsXlsxFileName } } : {}),
          },
        );
        emailState = sent.sent ? "sent" : "failed";
        if (!sent.sent) console.warn("[Orchestrator] Manual options email delivery failed for", emailTo);
      } catch (emailErr) {
        console.warn("[Orchestrator] Manual options email error:", emailErr instanceof Error ? emailErr.message : String(emailErr));
      }
    }
  }

  const generatedAt = new Date().toISOString();
  const generationId = `options_scanner:manual:${generatedAt}`;
  // Provider/broker slice 2 (#2598): stamp the tenant's selections into
  // body.provenance — the same two fields the unified record carries,
  // resolved fail-open (etrade/etrade) like every other slice-2 read.
  // This runs only after the feed gate passed, so the stamped provider
  // is a chain provider (or the fail-open default).
  const screenProviderProvenance = withProviderProvenance(
    {},
    resolveTenantProviderContext(await resolveTenantProviders(ctx.env)),
  );
  storeOptionsCanonicalReport(ctx.getOrm(), {
    runId: generationId,
    generationId,
    title: `Options contract screen — ${(screenFilter.underlyingSymbols || []).join(", ") || screenUniverseLabel || "selected underlyings"}`,
    source: "options_scanner",
    summary: `${result.totalUnderlyingsScanned} underlyings scanned, ${result.totalContractsEvaluated} contracts evaluated, ${result.matchedCount} matched.`,
    body: { generatedAt, provenance: screenProviderProvenance, filter: screenFilter, result, pdfKey: optionsPdfKey, pdfStatus: optionsPdfKey ? "generated" : "failed", reportUrl: optionsReportUrl, xlsxKey: optionsXlsxKey, xlsxStatus: optionsXlsxStatus, xlsxError: optionsXlsxError, xlsxUrl: optionsXlsxUrl, csvKey: optionsCsvKey, csvStatus: optionsCsvStatus, csvError: optionsCsvError, csvUrl: optionsCsvUrl },
    createdAt: generatedAt,
    // Options run-record fix: owner-scope the row — an ownerless write is invisible
    // to the owner-scoped Reports read.
    userLogin,
  },
  // Issue #1169 S4-1: thread ctx.env so the seam indexes this
  // options_scanner row at write time.
  ctx.env);

  // Issue #1333: the inline manual-options outcome — recorded here
  // ONLY when the bridge did not take the run (bridged runs record
  // through the job-tree hook; recording both would double the feed).
  // Never throws: a sink failure must not fail the run.
  if (!(shouldNotifySlack && ctx.scheduleScreenerFollowups)) {
    try {
      recordJobOutcome(ctx.ensureTables(), {
        id: `options-manual:${generationId}`,
        kind: "options",
        trigger: "manual",
        status: "completed",
        scanned: result.totalUnderlyingsScanned,
        matched: result.matchedCount,
        reportUrl: optionsReportUrl,
        pdfKey: optionsPdfKey,
        xlsxKey: optionsXlsxKey,
        csvKey: optionsCsvKey,
        deliveryStates: {
          ...(slackState ? { slack: slackState } : {}),
          ...(emailState ? { email: emailState } : {}),
        },
        origin: "manual-options-inline",
        createdAt: generatedAt,
      });
    } catch (outcomeErr) {
      console.warn("[Orchestrator] Manual options outcome record failed:", outcomeErr instanceof Error ? outcomeErr.message : String(outcomeErr));
    }
  }

  return Response.json({ ...result, pdfKey: optionsPdfKey, reportUrl: optionsReportUrl, xlsxKey: optionsXlsxKey, xlsxUrl: optionsXlsxUrl, csvKey: optionsCsvKey, csvUrl: optionsCsvUrl });
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
  const service = new UnifiedOptionsService(ctx.env, userLogin, ctx.requestedEnv, ctx.getOrm(), createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).strategyProfiles, ctx.agentCtx.storage.sql, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env }, undefined, dpPorts);
  // Issue #16: event calendars are server-side facts — strip any
  // client-supplied calendar, then fetch coverage for the
  // actions that run the strategy engine. The calendar service
  // never throws; uncovered names stay unverified.
  delete reqData.eventCalendarBySymbol;
  delete reqData.eventCalendar;
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
  const result = await service.execute(reqData);

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
        console.warn("[Orchestrator] Manual options PDF generation failed:", pipelineResult.pdfError);
      }
    } catch (pdfErr) {
      console.warn("[Orchestrator] Manual options PDF generation failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
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
        console.warn("[Orchestrator] Failed to stamp PDF key on scan run:", stampErr instanceof Error ? stampErr.message : String(stampErr));
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
      console.warn("[Orchestrator] Manual options XLSX generation failed:", xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr));
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
      console.warn("[Orchestrator] Manual options CSV generation failed:", csvErr instanceof Error ? csvErr.message : String(csvErr));
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
        console.warn("[Orchestrator] Failed to stamp XLSX/CSV keys on scan run:", stampErr instanceof Error ? stampErr.message : String(stampErr));
      }
    }

    const shouldNotifySlack = reqData.pushToSlack !== false && reqData.pushToSlack !== "false";
    if (shouldNotifySlack) {
      const slackChannel = reqData.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
      try {
        const slackPayload = result.toSlack();
        const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
        const matchCount = result.data?.opportunities?.length ?? result.data?.matchedCount ?? 0;
        const sent = await deliverScreenerToSlackA2A(ctx.env, {
          text,
          channel: slackChannel,
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
        if (!sent.ok) console.warn("[Orchestrator] Slack A2A PDF delivery (manual options) failed:", sent.error);
      } catch (slackErr) {
        console.warn("[Orchestrator] Slack notification (manual options) error:", slackErr instanceof Error ? slackErr.message : String(slackErr));
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
    const slackChannel = reqData.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
    const slackPayload = result.toSlack();
    const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
    const sent = await deliverScreenerToSlackA2A(ctx.env, { text, channel: slackChannel });
    if (!sent.ok) console.warn("[Orchestrator] Slack A2A notification (manual options failed) error:", sent.error);
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
