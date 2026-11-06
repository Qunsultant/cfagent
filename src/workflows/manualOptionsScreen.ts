/**
 * Issue #3186 step 3d - the manual entry's shapeReport / deliver for
 * the one options pipeline, extracted from executeOptionsScreen
 * (src/agents/routes/etradeOptionsScreen.ts). The handler's report +
 * delivery blocks move here unchanged in behavior; the pipeline runs
 * them as stages 7-8.
 *
 *   record builder: the route's pinned canonical row (title "Options
 *     contract screen — <symbols>", source "options_scanner") - the
 *     persist stage writes it, so the row IS the route's row.
 *   shapeReport: PDF (unified report pipeline) + XLSX + CSV via the
 *     agent, each its own failure domain (a failed artifact never
 *     fails the run); then the canonical row is re-recorded with the
 *     report keys + filter/result/provenance - the ORM backfills the
 *     missing body fields onto the persist row (same generationId,
 *     no second row).
 *   deliver: Slack (follow-up bridge when the host provides it, else
 *     the A2A path with bytes re-fetched by key) + email (#1336) +
 *     the inline job outcome (bridge runs record through the job-tree
 *     hook instead - recording both would double the feed).
 */
import { deliverGatedSlack } from "../services/gatedSlackDelivery";
import { screenerOutcomeFromRunResult } from "../services/screenerFollowups";
import { recordJobOutcome } from "../services/jobOutcomes";
import {
  recordUnifiedOptionsRun,
  type UnifiedOptionsRunRecord,
} from "../services/optionsServeRecord";
import { resolveTenantProviders } from "../services/tenantProviders";
import {
  resolveTenantProviderContext,
  withProviderProvenance,
} from "../services/optionsProviderContext";
import {
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
  getCfpayConfig,
} from "../services/cfpayA2A";
import {
  resolveOptionsRunEmailRecipient,
  sendOptionsRunEmail,
} from "../services/optionsRunEmail";
import type {
  OptionsDeliverFn,
  OptionsShapeReportFn,
} from "./optionsScreenPorts";
import type { OptionScreenerFilter } from "../types";

/** The ctx slice the manual delivery needs (structural - the route's ctx satisfies it). */
export interface ManualOptionsScreenCtx {
  env: unknown;
  getOrm(): {
    storeCanonicalReport: (
      input: unknown,
      env?: unknown,
    ) => { reportId: string; created: boolean } | null;
  };
  ensureTables(): unknown;
  getScreenerAgent(userLogin?: string): {
    getPdfByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
    getOptionsXlsxByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
    getOptionsCsvByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
    generateAndStoreOptionsXlsx(result: unknown): Promise<{ key: string; fileName: string }>;
    generateAndStoreOptionsCsv(result: unknown): Promise<{ key: string; fileName: string }>;
  };
  scheduleScreenerFollowups?: (
    outcome: unknown,
    userLogin: string,
  ) => Promise<void>;
}

export interface ManualOptionsScreenInput {
  ctx: ManualOptionsScreenCtx;
  screenFilter: OptionScreenerFilter;
  screenPushToSlack?: boolean;
  screenSlackChannel?: string;
  screenUniverseLabel?: string;
  screenEmailTo?: string;
  deferDelivery?: boolean;
}

function symbolsLabel(filter: OptionScreenerFilter, universeLabel?: string): string {
  return (filter.underlyingSymbols || []).join(", ") || universeLabel || "selected underlyings";
}

function countsSummary(result: Record<string, unknown>): string {
  return `${result["totalUnderlyingsScanned"] ?? 0} underlyings scanned, ${result["totalContractsEvaluated"] ?? 0} contracts evaluated, ${result["matchedCount"] ?? 0} matched.`;
}

/**
 * The route's pinned canonical record, built by the persist stage.
 * The provenance resolves fail-open (etrade/etrade) like the route's
 * slice-2 read. The filter + result + provenance ride the FIRST write:
 * the artifact-key backfill (#2602) fills only key/status/error fields,
 * so a later re-record cannot add them.
 */
export function createManualOptionsRecordBuilder(ctx: ManualOptionsScreenCtx): (
  input: {
    runId: string;
    userLogin: string;
    request: { classInput?: { request?: { filter?: unknown } } };
    screen: { result: Record<string, unknown> };
  },
) => Promise<UnifiedOptionsRunRecord> {
  return async (input) => {
    const filter = (input.request.classInput?.request?.filter ?? {}) as OptionScreenerFilter;
    const provenance = withProviderProvenance(
      {},
      resolveTenantProviderContext(await resolveTenantProviders(ctx.env as never)),
    );
    return {
      runId: input.runId,
      generationId: input.runId,
      title: `Options contract screen — ${symbolsLabel(filter)}`,
      source: "options_scanner",
      summary: countsSummary(input.screen.result),
      trigger: "manual",
      userLogin: input.userLogin,
      filter,
      result: input.screen.result,
      provenance,
    };
  };
}

export function createManualOptionsScreenDelivery(input: ManualOptionsScreenInput): {
  shapeReport: OptionsShapeReportFn;
  deliver: OptionsDeliverFn;
} {
  const { ctx, screenFilter, screenPushToSlack, screenSlackChannel, screenUniverseLabel, screenEmailTo, deferDelivery } = input;

  const shapeReport: OptionsShapeReportFn = async ({ runId, userLogin, canonical, screen }) => {
    const result = (screen as { result: Record<string, unknown> }).result;
    const title = `Options contract screen — ${symbolsLabel(screenFilter, screenUniverseLabel)}`;
    const summary = countsSummary(result);
    let pdfKey: string | undefined;
    let pdfStatus: "generated" | "failed" | undefined;
    let pdfError: string | undefined;
    let reportUrl: string | undefined;
    try {
      const { runReportPipeline } = await import("../services/unifiedReportPipeline");
      const pipelineResult = await runReportPipeline(
        ctx.env as never,
        null as never,
        {
          type: "options",
          trigger: "manual",
          result,
          userLogin,
          title,
          summary,
          timestamp: new Date().toISOString(),
        },
      );
      if (pipelineResult.pdfStatus === "generated") {
        pdfKey = pipelineResult.pdfKey;
        reportUrl = `/api/options/report.pdf?key=${encodeURIComponent(pdfKey)}`;
        pdfStatus = "generated";
      } else {
        pdfStatus = "failed";
        pdfError = pipelineResult.pdfError;
        console.warn("[Orchestrator] Manual options contract PDF generation failed:", pdfError);
      }
    } catch (pdfErr) {
      pdfStatus = "failed";
      pdfError = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      console.warn("[Orchestrator] Manual options contract PDF generation failed:", pdfError);
    }

    let xlsxKey: string | undefined;
    let xlsxStatus: "generated" | "failed" | undefined;
    let xlsxError: string | undefined;
    try {
      const agent = ctx.getScreenerAgent(userLogin);
      const stored = await agent.generateAndStoreOptionsXlsx(result);
      xlsxKey = stored.key;
      xlsxStatus = "generated";
    } catch (xlsxErr) {
      xlsxStatus = "failed";
      xlsxError = xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr);
      console.warn("[Orchestrator] Manual options XLSX generation failed:", xlsxError);
    }
    const xlsxUrl = xlsxKey ? `/api/options/report.xlsx?key=${encodeURIComponent(xlsxKey)}` : undefined;

    let csvKey: string | undefined;
    let csvStatus: "generated" | "failed" | undefined;
    let csvError: string | undefined;
    try {
      const agent = ctx.getScreenerAgent(userLogin);
      const stored = await agent.generateAndStoreOptionsCsv(result);
      csvKey = stored.key;
      csvStatus = "generated";
    } catch (csvErr) {
      csvStatus = "failed";
      csvError = csvErr instanceof Error ? csvErr.message : String(csvErr);
      console.warn("[Orchestrator] Manual options CSV generation failed:", csvError);
    }
    const csvUrl = csvKey ? `/api/options/report.csv?key=${encodeURIComponent(csvKey)}` : undefined;

    // Re-record the canonical row with the report keys. Same
    // generationId, so the ORM backfills the missing key/status/error
    // fields onto the persist row - no second row. The filter +
    // result + provenance already ride the persist row (they are not
    // backfillable, so they were written by the record builder).
    recordUnifiedOptionsRun(ctx.getOrm() as never, {
      ...canonical.record,
      pdfKey,
      pdfStatus,
      pdfError,
      xlsxKey,
      xlsxStatus,
      xlsxError,
      csvKey,
      csvStatus,
      csvError,
      reportUrl,
    }, ctx.env as never);

    // The port wraps this return as {terminal, report}: return the
    // flat report object (not a {terminal, report} envelope).
    return {
      pdfKey,
      pdfStatus,
      pdfError,
      reportUrl,
      xlsxKey,
      xlsxStatus,
      xlsxError,
      xlsxUrl,
      csvKey,
      csvStatus,
      csvError,
      csvUrl,
      title,
      summary,
      totalUnderlyingsScanned: result["totalUnderlyingsScanned"],
      totalContractsEvaluated: result["totalContractsEvaluated"],
      matchedCount: result["matchedCount"],
      filterSummary: result["filterSummary"],
    };
  };

  const deliver: OptionsDeliverFn = async ({ runId, userLogin, report }) => {
    // The deliver port hands the shapeReport stage's inner report
    // object (not the {terminal, report} artifact envelope).
    const shaped = (report ?? {}) as Record<string, unknown>;
    const shouldNotifySlack = screenPushToSlack !== false && !deferDelivery;
    let slackState: string | undefined;
    let emailState: string | undefined;
    if (shouldNotifySlack && ctx.scheduleScreenerFollowups) {
      await ctx.scheduleScreenerFollowups(
        screenerOutcomeFromRunResult("options", {
          success: true,
          thesis: screenUniverseLabel,
          totalScanned: shaped["totalUnderlyingsScanned"],
          matchedCount: shaped["matchedCount"],
          pdfKey: shaped["pdfKey"],
          pdfStatus: shaped["pdfKey"] ? "generated" : undefined,
          xlsxKey: shaped["xlsxKey"],
          xlsxStatus: shaped["xlsxStatus"],
          xlsxError: shaped["xlsxError"],
          csvKey: shaped["csvKey"],
          csvStatus: shaped["csvStatus"],
          csvError: shaped["csvError"],
          summary: `${shaped["totalUnderlyingsScanned"] ?? 0} underlyings scanned · ${shaped["totalContractsEvaluated"] ?? 0} contracts evaluated · ${shaped["matchedCount"] ?? 0} matched.`,
        }, (ctx.env as { APP_BASE_URL?: string }).APP_BASE_URL),
        userLogin,
      );
    } else if (shouldNotifySlack) {
      const slackChannel =
        screenSlackChannel ||
        (ctx.env as { SCREENER_SLACK_CHANNEL?: string }).SCREENER_SLACK_CHANNEL ||
        (ctx.env as { SLACK_CHANNEL?: string }).SLACK_CHANNEL;
      const summary = `📊 Options Contract Screen — ${symbolsLabel(screenFilter, screenUniverseLabel)}\n${shaped["totalUnderlyingsScanned"] ?? 0} underlyings scanned · ${shaped["totalContractsEvaluated"] ?? 0} contracts evaluated · ${shaped["matchedCount"] ?? 0} matched.\n${String(shaped["filterSummary"] ?? "")}`;
      try {
        const agent = ctx.getScreenerAgent(userLogin);
        const pdfData = shaped["pdfKey"] ? await agent.getPdfByKey(String(shaped["pdfKey"])) : null;
        const xlsxData = shaped["xlsxKey"] ? await agent.getOptionsXlsxByKey(String(shaped["xlsxKey"])) : null;
        const csvData = shaped["csvKey"] ? await agent.getOptionsCsvByKey(String(shaped["csvKey"])) : null;
        const sent = await deliverGatedSlack(ctx.env, {
          text: summary,
          channel: slackChannel,
          userLogin,
          ...(pdfData
            ? {
                pdf: {
                  bytes: pdfData.bytes,
                  fileName: pdfData.fileName,
                  title: `Options Contract Screen — ${new Date().toISOString().slice(0, 10)}`,
                  comment: `📄 Options contract screener PDF\n\n${summary}`,
                },
              }
            : {}),
          ...(xlsxData
            ? { files: [{ bytes: xlsxData.bytes, fileName: xlsxData.fileName, title: xlsxData.fileName }] }
            : {}),
          ...(csvData
            ? { files: [{ bytes: csvData.bytes, fileName: csvData.fileName, title: csvData.fileName }] }
            : {}),
        });
        slackState = sent.ok ? "sent" : "failed";
        if (!sent.ok) console.warn("[Orchestrator] Slack A2A options contract PDF delivery failed:", sent.error);
      } catch (slackErr) {
        console.warn("[Orchestrator] Slack A2A options delivery error:", slackErr instanceof Error ? slackErr.message : String(slackErr));
      }
    }

    if (!deferDelivery && !ctx.scheduleScreenerFollowups) {
      const emailTo = resolveOptionsRunEmailRecipient(
        screenEmailTo,
        ctx.env as unknown as Record<string, unknown>,
      );
      if (emailTo) {
        const symbols = symbolsLabel(screenFilter, screenUniverseLabel);
        const emailSummary = `📊 Options Contract Screen — ${symbols}\n${shaped["totalUnderlyingsScanned"] ?? 0} underlyings scanned · ${shaped["totalContractsEvaluated"] ?? 0} contracts evaluated · ${shaped["matchedCount"] ?? 0} matched.\n${String(shaped["filterSummary"] ?? "")}`;
        try {
          const { ETradeEmailTradingService } = await import("../trading");
          const emailService = new ETradeEmailTradingService(ctx.env as never, ctx.getOrm() as never, userLogin);
          const agent = ctx.getScreenerAgent(userLogin);
          const pdfData = shaped["pdfKey"] ? await agent.getPdfByKey(String(shaped["pdfKey"])) : null;
          const xlsxData = shaped["xlsxKey"] ? await agent.getOptionsXlsxByKey(String(shaped["xlsxKey"])) : null;
          const sent = await sendOptionsRunEmail(
            {
              cfpay: getCfpayConfig(ctx.env as never),
              sendCfpay: (config, a) => cfpaySendEmail(config, a.to, a.subject, a.body),
              sendCfpayWithAttachments: (config, a) => cfpaySendEmailWithAttachments(config, a),
              sendLocal: (to, subject, html, text, attachments) => emailService.sendOutboundEmail(to, subject, html, text, attachments),
            },
            {
              to: emailTo,
              subject: `📊 Options Contract Screen — ${symbols} — ${new Date().toISOString().slice(0, 10)}`,
              textBody: `${emailSummary}${shaped["reportUrl"] ? `\n\nPDF report: ${shaped["reportUrl"]}` : ""}`,
              htmlBody: `${emailSummary.replace(/\n/g, "<br/>")}${shaped["reportUrl"] ? `<br/><br/>PDF report: ${shaped["reportUrl"]}` : ""}`,
              ...(pdfData ? { pdf: { bytes: pdfData.bytes, fileName: pdfData.fileName } } : {}),
              ...(xlsxData ? { xlsx: { bytes: xlsxData.bytes, fileName: xlsxData.fileName } } : {}),
            },
          );
          emailState = sent.sent ? "sent" : "failed";
          if (!sent.sent) console.warn("[Orchestrator] Manual options email delivery failed for", emailTo);
        } catch (emailErr) {
          console.warn("[Orchestrator] Manual options email error:", emailErr instanceof Error ? emailErr.message : String(emailErr));
        }
      }
    }

    // The inline manual-options outcome - recorded here ONLY when the
    // bridge did not take the run (bridged runs record through the
    // job-tree hook; recording both would double the feed). Never
    // throws: a sink failure must not fail the run.
    if (!(shouldNotifySlack && ctx.scheduleScreenerFollowups)) {
      try {
        recordJobOutcome(ctx.ensureTables() as never, {
          id: `options-manual:${runId}`,
          kind: "options",
          trigger: "manual",
          status: "completed",
          scanned: shaped["totalUnderlyingsScanned"] as number | undefined,
          matched: shaped["matchedCount"] as number | undefined,
          reportUrl: shaped["reportUrl"] as string | undefined,
          pdfKey: shaped["pdfKey"] as string | undefined,
          xlsxKey: shaped["xlsxKey"] as string | undefined,
          csvKey: shaped["csvKey"] as string | undefined,
          deliveryStates: {
            ...(slackState ? { slack: slackState } : {}),
            ...(emailState ? { email: emailState } : {}),
          },
          origin: "manual-options-inline",
          createdAt: new Date().toISOString(),
        });
      } catch (outcomeErr) {
        console.warn("[Orchestrator] Manual options outcome record failed:", outcomeErr instanceof Error ? outcomeErr.message : String(outcomeErr));
      }
    }

    return {
      terminal: "completed",
      deliveryState: "delivered",
      slackState,
      emailState,
    };
  };

  return { shapeReport, deliver };
}
