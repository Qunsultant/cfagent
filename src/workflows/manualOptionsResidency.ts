/**
 * Issue #4450 — the manual delivery builders rebuilt for workflow
 * residency: shapeReport/deliver as pure functions of (env, the
 * stage storage, the stored request envelope, the canonical leg),
 * with no agent handle. The workflow residency binds no agent, so
 * the builders the manual route uses (manualOptionsScreen.ts, via
 * getScreenerAgent) cannot run there; this module rebuilds their
 * semantics from seams the residency does bind, mirroring the
 * route's builders field for field:
 *
 *   shapeReport: PDF through the unified report pipeline (env-only,
 *     storage null — the same call the route makes) + XLSX/CSV
 *     through the pure generators, written through the blob store
 *     (putReportPdf) under the same key shapes the agent twins use
 *     — which is what makes them servable through the established
 *     endpoints (getReportPdf's direct-R2 fallback, on a pointer
 *     miss in the serving store). Each format is its own failure
 *     domain; the canonical row is re-recorded through the leg.
 *   deliver: the A2A path only (no follow-up bridge exists in the
 *     residency) — Slack via deliverGatedSlack with bytes re-fetched
 *     through the blob store + email via the outbound email service
 *     (ORM-free send) — through the ONE suppressor module. No
 *     inline job-outcome record: the engine's run record IS the
 *     outcome record in the residency, and writing a second one
 *     would double the feed.
 *
 * Residency limits, named rather than silent:
 * - No environment bound ⇒ the builders refuse at INVOCATION with
 *   stage_port_unavailable (the ports still build, so the other
 *   six stages run — the same shape as the goal leg's refusal).
 * - Blob store unbound (no REPORTS_BUCKET) ⇒ XLSX/CSV record a
 *   named failure each (the terminal goes partial, the run
 *   completes): bytes written only to the artifact store would be
 *   unservable through the download endpoints, so they are never
 *   written as if generated.
 * - The suppressor is the in-memory fallback idiom (the
 *   DeliverySuppressionStore interface is synchronous, so no
 *   durable store can back it): claims hold for the deliver fn's
 *   lifetime. The workflow journal protects replays (a journaled
 *   deliver is not re-executed), but an explicit control rerun of
 *   deliver in the residency is not duplicate-suppressed across
 *   processes. A durable residency suppressor needs an async store
 *   interface — a follow-up, not this slice.
 *
 * The report pipeline and the trading barrel stay dynamic imports.
 * This module is imported only by server-side callers (the
 * resolving steps in optionsPipelineJobs.ts, which inject the
 * factory into the shared rebuild) — never by the shared rebuild
 * itself: the report pipeline's graph reaches workerd-only modules
 * that the client bundle the rebuild is reachable from cannot hold
 * (#4066).
 */
import { deliverGatedSlack } from "../services/gatedSlackDelivery";
import {
  createDeliverySuppressor,
  deliveryDestinationFor,
  type DeliverySuppressor,
} from "./screenDeliverySuppression";
import { recordUnifiedOptionsRunThroughLeg } from "./optionsCanonicalLeg";
import {
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
  getCfpayConfig,
} from "../services/cfpayA2A";
import {
  resolveOptionsRunEmailRecipient,
  sendOptionsRunEmail,
} from "../services/optionsRunEmail";
import { JobPipelineError } from "../services/jobPipelineConfig";
import type { CanonicalReportStoreSeam } from "../services/generateJobs";
import type { Env, OptionScreenerFilter } from "../types";
import type {
  OptionsDeliverFn,
  OptionsShapeReportFn,
  OptionsStageStorage,
} from "./optionsScreenPorts";
import { countsSummary, symbolsLabel } from "./manualOptionsRecordBuilder";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam (new files must carry zero console.* uses). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/manualOptionsResidency",
});

// The agent twins (src/agents/screener-agent.ts) own the canonical
// key shapes; the residency restates the literals — workflows code
// must not import the agent module (the wrong dependency direction).
const OPTIONS_XLSX_KEY_PREFIX = "options:xlsx:";
const OPTIONS_XLSX_LATEST_KEY = "options:latest.xlsx";
const OPTIONS_CSV_KEY_PREFIX = "options:csv:";
const OPTIONS_CSV_LATEST_KEY = "options:latest.csv";

/** The stored classInput.request envelope, read defensively (the stored request is untyped JSON). */
export interface ManualOptionsResidencyEnvelope {
  filter?: OptionScreenerFilter;
  pushToSlack?: boolean;
  slackChannel?: string;
  universe?: string;
  emailTo?: string;
  deferDelivery?: boolean;
}

export interface ManualOptionsResidencyInput {
  /** The Worker env — the report pipeline, the blob store, the gates, and the email service all read it. Absent ⇒ the builders refuse at invocation. */
  env?: Env;
  /** The stage storage the stages read/write artifacts through (the host's artifact-store adapter). */
  storage: OptionsStageStorage;
  /** The stored classInput.request envelope (filter + delivery prefs + deferDelivery). */
  request: unknown;
  /** The engine's tenant-aware canonical leg, when bound — the shapeReport re-record rides it. Absent ⇒ no re-record (the report artifact carries the keys). */
  canonicalLeg?: CanonicalReportStoreSeam;
  /** The duplicate-delivery suppressor. Absent ⇒ a fresh in-memory suppressor (the runDeliverJob fallback idiom). */
  suppressor?: DeliverySuppressor;
}

function readEnvelope(request: unknown): ManualOptionsResidencyEnvelope {
  const envelope = (request ?? {}) as Record<string, unknown>;
  return {
    filter: envelope["filter"] as OptionScreenerFilter | undefined,
    pushToSlack: envelope["pushToSlack"] as boolean | undefined,
    slackChannel: envelope["slackChannel"] as string | undefined,
    universe: envelope["universe"] as string | undefined,
    emailTo: envelope["emailTo"] as string | undefined,
    deferDelivery: envelope["deferDelivery"] as boolean | undefined,
  };
}

function requireResidencyEnv(env: Env | undefined, runId: string, stageId: string): Env {
  if (!env) {
    throw new JobPipelineError(
      "stage_port_unavailable",
      `options run ${runId}: stage ${stageId} of a manual-shape run needs the residency environment (the report pipeline, the blob store, and the delivery gates read it), and none is bound on this rebuild — dispatch through the manual route instead`,
    );
  }
  return env;
}

function blobStoreUnboundReason(format: "XLSX" | "CSV"): string {
  return `options delivery blob store unbound: the REPORTS_BUCKET binding is not configured in this residency, so the ${format} bytes have no servable home — the download endpoints cannot serve an artifact-store-only blob`;
}

export function createManualOptionsResidencyDelivery(input: ManualOptionsResidencyInput): {
  shapeReport: OptionsShapeReportFn;
  deliver: OptionsDeliverFn;
} {
  const envelope = readEnvelope(input.request);
  const screenFilter = envelope.filter ?? ({} as OptionScreenerFilter);
  const screenUniverseLabel = envelope.universe;
  const deferDelivery = envelope.deferDelivery;
  // Issue #4064: the duplicate-delivery suppressor for this entry
  // — the ONE module, injected store. Absent ⇒ a fresh in-memory
  // suppressor (the runDeliverJob fallback idiom); see the module
  // header for the residency limit this carries.
  const suppressor = input.suppressor ?? createDeliverySuppressor();

  const shapeReport: OptionsShapeReportFn = async ({ runId, userLogin, canonical, screen }) => {
    const env = requireResidencyEnv(input.env, runId, "shapeReport");
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
        env as never,
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
        structuredLog.warn("manualOptionsResidency.pdf_generation_failed", {
          message: "Manual options contract PDF generation failed",
          runId,
          error: pdfError,
        });
      }
    } catch (pdfErr) {
      pdfStatus = "failed";
      pdfError = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      structuredLog.warn("manualOptionsResidency.pdf_generation_failed", {
          message: "Manual options contract PDF generation failed",
          runId,
          error: pdfError,
        });
    }

    // XLSX/CSV mirror the agent twins' generate-and-store exactly
    // (key shape, latest pointer, retry policy) — except the blob
    // store check first: with no bucket bound the format records a
    // named failure instead of writing unservable bytes.
    const { createBlobStore } = await import("../services/blobStoreR2Adapter");
    const blobStoreBound = createBlobStore(env) !== null;

    let xlsxKey: string | undefined;
    let xlsxStatus: "generated" | "failed" | undefined;
    let xlsxError: string | undefined;
    if (!blobStoreBound) {
      xlsxStatus = "failed";
      xlsxError = blobStoreUnboundReason("XLSX");
    } else {
      try {
        const { withRetry } = await import("../services/resilience");
        const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
        const reportRetry = resolvePipelinePolicy(env as unknown as Record<string, unknown>).retry.report;
        const key = `${OPTIONS_XLSX_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
        await withRetry(async () => {
          const { generateOptionsXlsx, optionsXlsxFileName } = await import("../trading");
          const { putReportPdf } = await import("../services/reportBlobStore");
          const bytes = generateOptionsXlsx(result as never);
          const fileName = optionsXlsxFileName(result as never);
          await putReportPdf(env, input.storage as never, key, fileName, bytes);
          await putReportPdf(env, input.storage as never, OPTIONS_XLSX_LATEST_KEY, fileName, bytes);
        }, reportRetry, { label: "options-xlsx" });
        xlsxKey = key;
        xlsxStatus = "generated";
      } catch (xlsxErr) {
        xlsxStatus = "failed";
        xlsxError = xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr);
        structuredLog.warn("manualOptionsResidency.xlsx_generation_failed", {
          message: "Manual options XLSX generation failed",
          runId,
          error: xlsxError,
        });
      }
    }
    const xlsxUrl = xlsxKey ? `/api/options/report.xlsx?key=${encodeURIComponent(xlsxKey)}` : undefined;

    let csvKey: string | undefined;
    let csvStatus: "generated" | "failed" | undefined;
    let csvError: string | undefined;
    if (!blobStoreBound) {
      csvStatus = "failed";
      csvError = blobStoreUnboundReason("CSV");
    } else {
      try {
        const { withRetry } = await import("../services/resilience");
        const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
        const reportRetry = resolvePipelinePolicy(env as unknown as Record<string, unknown>).retry.report;
        const key = `${OPTIONS_CSV_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
        await withRetry(async () => {
          const { generateOptionsCsv, optionsCsvFileName } = await import("../trading");
          const { putReportPdf } = await import("../services/reportBlobStore");
          const bytes = new TextEncoder().encode(generateOptionsCsv(result as never));
          const fileName = optionsCsvFileName(result as never);
          await putReportPdf(env, input.storage as never, key, fileName, bytes, "text/csv");
          await putReportPdf(env, input.storage as never, OPTIONS_CSV_LATEST_KEY, fileName, bytes, "text/csv");
        }, reportRetry, { label: "options-csv" });
        csvKey = key;
        csvStatus = "generated";
      } catch (csvErr) {
        csvStatus = "failed";
        csvError = csvErr instanceof Error ? csvErr.message : String(csvErr);
        structuredLog.warn("manualOptionsResidency.csv_generation_failed", {
          message: "Manual options CSV generation failed",
          runId,
          error: csvError,
        });
      }
    }
    const csvUrl = csvKey ? `/api/options/report.csv?key=${encodeURIComponent(csvKey)}` : undefined;

    // Re-record the canonical row with the report keys, through the
    // leg the persist stage used (one transport for the row). No
    // leg ⇒ no re-record: the residency has no direct store, and
    // the report artifact carries the keys. Either way the
    // re-record never fails the run.
    if (input.canonicalLeg) {
      await recordUnifiedOptionsRunThroughLeg(input.canonicalLeg, {
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
      });
    }

    // A failed format is partial + marked (issue #4067, #3072's
    // per-format rule): the stage records "partial" when any format
    // failed, so the failure is visible as the stage outcome instead
    // of a whole-run failure; the formats that generated are never
    // stranded (each format above is its own failure domain). The
    // port reads the terminal off this flat report object and wraps
    // it as {terminal, report}; the run outcome stays "completed"
    // (partial is a non-failing terminal).
    const anyFormatFailed =
      pdfStatus === "failed" || xlsxStatus === "failed" || csvStatus === "failed";
    return {
      terminal: anyFormatFailed ? "partial" : "completed",
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
    const env = requireResidencyEnv(input.env, runId, "deliver");
    // The deliver port hands the shapeReport stage's inner report
    // object (not the {terminal, report} artifact envelope).
    const shaped = (report ?? {}) as Record<string, unknown>;
    const shouldNotifySlack = envelope.pushToSlack !== false && !deferDelivery;
    let slackState: string | undefined;
    let emailState: string | undefined;
    if (shouldNotifySlack) {
      // Issue #4064: claim (runId, slack) before the direct send;
      // a held claim skips the send as already_delivered. A failed
      // send releases the claim so a retry may send (the recipient
      // holds nothing). The claim is taken only here, after the
      // can-attempt checks above, so a Slack-disabled run never
      // claims. No follow-up bridge exists in the residency, so
      // this is always the A2A path.
      if (!suppressor.tryClaim(runId, "slack")) {
        slackState = "already_delivered";
      } else {
        const slackChannel =
          envelope.slackChannel ||
          (env as { SCREENER_SLACK_CHANNEL?: string }).SCREENER_SLACK_CHANNEL ||
          (env as { SLACK_CHANNEL?: string }).SLACK_CHANNEL;
        const summary = `📊 Options Contract Screen — ${symbolsLabel(screenFilter, screenUniverseLabel)}\n${shaped["totalUnderlyingsScanned"] ?? 0} underlyings scanned · ${shaped["totalContractsEvaluated"] ?? 0} contracts evaluated · ${shaped["matchedCount"] ?? 0} matched.\n${String(shaped["filterSummary"] ?? "")}`;
        try {
          const { getReportPdf } = await import("../services/reportBlobStore");
          const pdfData = shaped["pdfKey"] ? await getReportPdf(env, input.storage as never, String(shaped["pdfKey"])) : null;
          const xlsxData = shaped["xlsxKey"] ? await getReportPdf(env, input.storage as never, String(shaped["xlsxKey"])) : null;
          const csvData = shaped["csvKey"] ? await getReportPdf(env, input.storage as never, String(shaped["csvKey"])) : null;
          const sent = await deliverGatedSlack(env, {
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
          if (!sent.ok) {
            suppressor.release(runId, "slack");
            structuredLog.warn("manualOptionsResidency.slack_delivery_failed", {
              message: "Slack A2A options contract delivery failed",
              runId,
              error: sent.error,
            });
          }
        } catch (slackErr) {
          suppressor.release(runId, "slack");
          structuredLog.warn("manualOptionsResidency.slack_delivery_error", {
            message: "Slack A2A options delivery error",
            runId,
            error: slackErr instanceof Error ? slackErr.message : String(slackErr),
          });
        }
      }
    }

    // Email runs whenever delivery is not deferred — no bridge
    // exists in the residency to own it instead.
    if (!deferDelivery) {
      const emailTo = resolveOptionsRunEmailRecipient(
        envelope.emailTo,
        env as unknown as Record<string, unknown>,
      );
      if (emailTo) {
        // Issue #4064: claim (runId, email:<recipient>) before the
        // send; a held claim skips the send as already_delivered.
        // A failed send releases the claim so a retry may send.
        // The claim is taken only here, after the recipient
        // resolved — a pair that cannot be attempted never claims.
        const emailDestination = deliveryDestinationFor("email", emailTo);
        if (!suppressor.tryClaim(runId, emailDestination)) {
          emailState = "already_delivered";
        } else {
          const symbols = symbolsLabel(screenFilter, screenUniverseLabel);
          const emailSummary = `📊 Options Contract Screen — ${symbols}\n${shaped["totalUnderlyingsScanned"] ?? 0} underlyings scanned · ${shaped["totalContractsEvaluated"] ?? 0} contracts evaluated · ${shaped["matchedCount"] ?? 0} matched.\n${String(shaped["filterSummary"] ?? "")}`;
          try {
            const { ETradeEmailTradingService } = await import("../trading");
            const emailService = new ETradeEmailTradingService(env as never, undefined, userLogin);
            const { getReportPdf } = await import("../services/reportBlobStore");
            const pdfData = shaped["pdfKey"] ? await getReportPdf(env, input.storage as never, String(shaped["pdfKey"])) : null;
            const xlsxData = shaped["xlsxKey"] ? await getReportPdf(env, input.storage as never, String(shaped["xlsxKey"])) : null;
            const sent = await sendOptionsRunEmail(
              {
                cfpay: getCfpayConfig(env as never),
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
            if (!sent.sent) {
              suppressor.release(runId, emailDestination);
              structuredLog.warn("manualOptionsResidency.email_delivery_failed", {
                message: "Manual options email delivery failed",
                runId,
                emailTo,
              });
            }
          } catch (emailErr) {
            suppressor.release(runId, emailDestination);
            structuredLog.warn("manualOptionsResidency.email_error", {
              message: "Manual options email error",
              runId,
              error: emailErr instanceof Error ? emailErr.message : String(emailErr),
            });
          }
        }
      }
    }

    // No inline job-outcome record: the engine's run record IS the
    // outcome record in the residency (the D1 run recorder; the
    // Workflow Runs surface reads it), and writing a second record
    // would double the feed. The route's inline record stays with
    // the sync path, which has no engine record of its own.
    return {
      terminal: "completed",
      deliveryState: "delivered",
      slackState,
      emailState,
    };
  };

  return { shapeReport, deliver };
}
