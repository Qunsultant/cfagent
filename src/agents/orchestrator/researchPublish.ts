/**
 * Issue #992: Research publish (autonomous options-research run, canonical store, delivery through the #308 seams) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * ResearchPublishContext.
 */

import type { AgentContext } from "agents";
import type { DatabaseORM } from "../../orm";
import type { Env } from "../../types";
import { ETradeEmailTradingService } from "../../trading";
import { codedMessage } from "../../outcomes/outcomeAspects";
import { storeReportAtGeneration } from "../../services/scheduledReports";
import { deliverGatedSlack } from "../../services/gatedSlackDelivery";
import {
  evaluateResearchOutcome,
  type ResearchExecutionPath,
} from "../../services/researchTaskLedger";
import type { ResearchAgent } from "../research-agent";
import type { ResearchReport } from "../../services/researchPipeline";
import type { ResearchReportArtifactOutcome, ResearchWorkbookOutcome } from "../../trading";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/researchPublish",
});

/**
 * Ports the research-publish functions receive from the class.
 * Storage, lifecycle and the report-dispatch HITL seam stay owned by
 * OrchestratorAgent (the HITL accessors bind the class wrappers the
 * bodies already called); these are bound views of the class's own
 * members. RESEARCH_TASK_HEARTBEAT_MS remains the class-scope module
 * const declared in orchestrator.ts, passed by value under its own
 * name so the dispatch body keeps referring to the named constant.
 */
export interface ResearchPublishContext {
  env: Env;
  agentCtx: AgentContext;
  ensureTables: () => AgentContext["storage"]["sql"];
  getOrm: () => DatabaseORM;
  getResearchAgent: (userLogin?: string) => ResearchAgent | null;
  runAgentTool: (
    cls: unknown,
    options: { input: { trigger: "manual" | "scheduled"; userLogin: string } }
  ) => Promise<{ status: string; error?: string }>;
  getReportDispatchHitl: () => boolean;
  createReportConfirmation: (kind: "email" | "webhook", payloadJson: string, reportId?: string | null, createdBy?: string | null) => string;
  RESEARCH_TASK_HEARTBEAT_MS: number;
}

/**
 * Issue #2167: generate the run's full document set and store the canonical
 * row that carries it.
 *
 * Parity with every other report path: PDF (via the #1641 generate stage —
 * ReportAssetAgent stays the single PDF owner), XLSX and CSV (via the
 * ResearchAgent workbook seam), each with its own status and error, all
 * recorded on one owner-scoped `options_research` row.
 *
 * The row is written AFTER generation, because the canonical store is
 * insert-only per generation id: writing it first (as before) left the row
 * permanently keyless even though a PDF was delivered.
 *
 * Never throws: a run whose documents all failed still gets its record.
 */
export async function generateAndStoreResearchReport(
  ctx: Pick<ResearchPublishContext, "env" | "ensureTables">,
  agent: { generateAndStoreResearchArtifacts: (report: ResearchReport) => Promise<ResearchWorkbookOutcome> },
  report: ResearchReport,
  opts: { trigger: "manual" | "scheduled"; userLogin: string },
): Promise<{ reportId: string | null; created: boolean; artifacts: ResearchReportArtifactOutcome }> {
  const artifacts: ResearchReportArtifactOutcome = {
    pdfStatus: "failed",
    xlsxStatus: "failed",
    csvStatus: "failed",
  };

  try {
    const { generateReportStage } = await import("../../services/unifiedReportPipeline");
    const staged = await generateReportStage(ctx.env as any, {
      type: "research",
      trigger: opts.trigger === "scheduled" ? "scheduled" : "manual",
      result: report,
      userLogin: opts.userLogin,
      title: `Options research — ${report.createdAt.slice(0, 10)} (${report.trigger})`,
      summary: report.summary,
      timestamp: report.createdAt,
    });
    if (staged.pdfStatus === "generated" && staged.pdfKey) {
      artifacts.pdfKey = staged.pdfKey;
      artifacts.pdfStatus = "generated";
    } else {
      artifacts.pdfError = staged.pdfError ?? codedMessage("FAILURE_REPORT_PDF_GENERATION");
      structuredLog.warn("researchPublish.research_pdf_stage_failed", {
        message: "[OrchestratorAgent] Research PDF generation failed:",
        error: artifacts.pdfError,
      });
    }
  } catch (err) {
    artifacts.pdfError = codedMessage("FAILURE_REPORT_PDF_GENERATION", err instanceof Error ? err.message : String(err));
    structuredLog.warn("researchPublish.research_pdf_generation_failed", {
      message: "[OrchestratorAgent] Research PDF generation failed:",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    Object.assign(artifacts, await agent.generateAndStoreResearchArtifacts(report));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    artifacts.xlsxStatus = "failed";
    artifacts.xlsxError = codedMessage("FAILURE_REPORT_XLSX_GENERATION", message);
    artifacts.csvStatus = "failed";
    artifacts.csvError = codedMessage("FAILURE_REPORT_CSV_GENERATION", message);
    structuredLog.warn("researchPublish.research_workbook_generation_failed", {
      message: "[OrchestratorAgent] Research workbook generation failed:",
      error: message,
    });
  }

  const stored = storeReportAtGeneration(
    ctx.ensureTables(),
    {
      runId: report.runId,
      generationId: report.generationId,
      title: `Options research — ${report.createdAt.slice(0, 10)} (${report.trigger})`,
      source: "options_research",
      summary: report.summary,
      userLogin: opts.userLogin,
      body: {
        ...(report as unknown as Record<string, unknown>),
        ...Object.fromEntries(Object.entries(artifacts).filter(([, value]) => value !== undefined)),
      },
    },
    ctx.env as { AI?: any; VECTOR_MEMORY?: any },
  );

  const reportId = stored?.reportId ?? null;
  const created = stored?.created ?? false;
  return { reportId, created, artifacts };
}

/**
 * Issue #319: THE single publish entry for autonomous options research.
 * The manual route and the scheduled tick are thin triggers over this
 * method (amendment 2). The ResearchAgent runs the pipeline; the
 * canonical copy is stored here via the #308 seam on the orchestrator's
 * mas_reports — the table the Reports tab (#318) and AI Search read.
 */
export async function runResearchAndPublish(ctx: ResearchPublishContext, 
  trigger: "manual" | "scheduled",
  userLogin?: string
): Promise<{
  success: boolean;
  error?: string;
  reportId?: string | null;
  created?: boolean;
  emailed?: boolean;
  /** Issue #2167: the run's recorded document set (keys + per-format status). */
  artifacts?: ResearchReportArtifactOutcome;
  report?: unknown;
  taskId?: string | null;
  executionPath?: ResearchExecutionPath;
}> {
  // Issue #2327 (Agent Mesh S3): the publish entry names its actor
  // or refuses. Callers arrive with an identity — the manual route
  // with the session login, the scheduled tick with the configured
  // service identity (server.ts skips that dispatch entirely when
  // none is configured, #1185) — so an absent, blank, or
  // retired-literal login here means the run has no actor, and it
  // fails closed rather than publishing under a synthetic
  // "default" identity.
  const trimmedLogin = typeof userLogin === "string" ? userLogin.trim() : "";
  if (!trimmedLogin || trimmedLogin === "default") {
    return {
      success: false,
      error:
        "Research run requires an explicit userLogin — runs are never attributed to a default identity (issue #2327).",
    };
  }
  const login = userLogin as string;
  const agent = ctx.getResearchAgent(login);
  if (!agent) {
    return { success: false, error: "ResearchAgent binding not configured." };
  }
  // Dispatch discovery through the SDK agent-tool run. The child
  // invokes its deterministic, read-only pipeline tool and persists the
  // typed report before returning its summary.
  const { ResearchAgent } = await import("../research-agent");
  const previousRunId = (await agent.getLatest())?.runId;
  // Issue #577: durable task record for this delegated run (mandate §6;
  // design in docs/agents/agentic-architecture.md §5/§7). The ledger
  // dedups the *record* for duplicate dispatches after the same
  // predecessor report; execution suppression is deliberately not
  // implied. Ledger failures never break research — warn, continue.
  let taskId: string | null = null;
  try {
    const created = await agent.createResearchTask({
      trigger,
      userLogin: login,
      idempotencyKey: `research:${trigger}:${login}:${previousRunId ?? "none"}`,
    });
    taskId = created.task.id;
    if (created.task.status === "queued") {
      await agent.beginResearchTask(taskId);
    }
  } catch (err) {
    structuredLog.warn("researchPublish.research_task_ledger_create_failed", {
      message: `[OrchestratorAgent] Research task ledger unavailable (create/begin): ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
    taskId = null;
  }
  // Issue #624: heartbeat the task while dispatch is in flight —
  // both the agent-tool run and the fallback run below are awaited here,
  // so one timer bounds the heartbeat gap for either path. Cleared
  // in the finally on every exit; the ledger rejects heartbeats
  // from terminal states, so a stray tick would be harmless anyway.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (taskId) {
    const id = taskId;
    heartbeatTimer = setInterval(() => {
      void agent.heartbeatResearchTask(id).catch(() => undefined);
    }, ctx.RESEARCH_TASK_HEARTBEAT_MS);
  }
  try {
    // Issue #1738: the primary dispatch is the SDK's runAgentTool
    // on an Agents SDK actor — the "think" label died with the
    // Think base class. The fallback (direct pipeline) is unchanged.
    let executionPath: ResearchExecutionPath = "agent";
    // Issue #1387: a THROWN agent dispatch (e.g. the sub-agent bootstrap
    // error when the root namespace is missing) must degrade to the
    // direct pipeline like a non-completed status — the #543 fallback
    // below triggers on status, never on a throw, so without this the
    // throw fails the whole run instead of degrading it.
    let child: { status: string; error?: string };
    try {
      child = await ctx.runAgentTool(ResearchAgent, {
        input: { trigger, userLogin: login },
      });
    } catch (err) {
      child = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    let report = await agent.getLatest();
    if (child.status !== "completed" || !report || report.runId === previousRunId || report.trigger !== trigger || report.userLogin !== login) {
      // Keep scheduled discovery dependable if a provider cannot complete
      // the agent-tool run. The same read-only deterministic pipeline remains
      // the recovery path and persists through the same ResearchAgent.
      // Issue #543: the fallback must not silently mask which execution
      // path ran — emit a structured warning carrying the identifiers an
      // operator needs to correlate the bypass in Workers Logs.
      structuredLog.warn("researchPublish.research_agent_turn_bypassed", {
        message: `[OrchestratorAgent] Agent research turn bypassed — falling back to direct pipeline: trigger=${trigger} userLogin=${login} childStatus=${child.status} childError=${child.error ?? "none"} previousRunId=${previousRunId ?? "none"} latestRunId=${report?.runId ?? "none"}`,
        trigger,
        userLogin: login,
        childStatus: child.status,
        childError: child.error ?? "none",
        previousRunId: previousRunId ?? "none",
        latestRunId: report?.runId ?? "none",
      });
      const fallback = await agent.runResearch({ trigger, userLogin: login });
      if (!fallback.success || !fallback.report) {
        const failure = fallback.error || child.error || `Research agent finished with status ${child.status}.`;
        // Issue #577: a total failure escalates the task for a human
        // instead of vanishing into this error return.
        if (taskId) {
          try {
            await agent.failResearchTask(taskId, failure, true);
          } catch {
            // Ledger is best-effort; the error return stands either way.
          }
        }
        return { success: false, error: failure, taskId };
      }
      executionPath = "fallback";
      report = fallback.report;
    }
    // Issue #2167: generate the full document set BEFORE the canonical write,
    // so the row carries the artifact keys. Previously the row was written
    // first and never updated — the PDF was delivered but the record could
    // not prove or serve it.
    const publication = await generateAndStoreResearchReport(ctx, agent, report, {
      trigger,
      userLogin: login,
    });
    const pdfKey = publication.artifacts.pdfKey ?? null;
    // #336: full delivery through the #308 seams (Slack, email, webhook),
    // delivering the canonical stored copy. Best-effort; never fails the run.
    let emailed = false;
    try {
      const delivery = await deliverResearchReport(ctx, 
        agent,
        report,
        {
          reportId: publication.reportId,
          pdfKey,
          trigger,
          userLogin: login,
        }
      );
      emailed = delivery.emailed;
    } catch (err) {
      structuredLog.warn("researchPublish.research_delivery_failed", {
        message: "[OrchestratorAgent] Research delivery failed:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Issue #577: complete the task with the path actually taken and a
    // deterministic evaluation of the outcome (never a model grading
    // itself). Best-effort — the published result stands either way.
    if (taskId) {
      try {
        const evaluation = evaluateResearchOutcome(
          {
            reportRunId: report.runId,
            previousRunId: previousRunId ?? null,
            expectedTrigger: trigger,
            expectedUserLogin: login,
            reportTrigger: report.trigger,
            reportUserLogin: report.userLogin,
            summary: report.summary,
            ideas: report.ideas.length,
            watchlist: report.watchlist.length,
            rejected: report.rejected.length,
          },
          new Date().toISOString()
        );
        await agent.completeResearchTask(taskId, {
          path: executionPath,
          reportRunId: report.runId,
          evaluation,
        });
      } catch (err) {
        structuredLog.warn("researchPublish.research_task_ledger_complete_failed", {
          message: `[OrchestratorAgent] Research task ledger unavailable (complete): ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // #584 EP-009: meter the research run — attribute compute to tenant + task.
    // Best-effort and never throws; metering must not break the run.
    try {
      const { recordUsageEvent } = await import("../../services/scheduledReports");
      recordUsageEvent(ctx.agentCtx.storage.sql, {
        userLogin: login,
        runId: report.runId,
        category: "research_run",
        detail: { trigger, ideas: report.ideas.length, taskId },
      });
    } catch {
      // Metering is advisory; the published result stands either way.
    }
    return {
      success: true,
      reportId: publication.reportId,
      created: publication.created,
      emailed,
      artifacts: publication.artifacts,
      report,
      taskId,
      executionPath,
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

/**
 * #336: dispatch a research run's report through the #308 delivery seams
 * (Slack, email, webhook), delivering the canonical stored copy — never a
 * regenerated one. Respects the #277 HITL setting; attaches the run PDF
 * where the channel supports files; flags pre-entry-refresh outcomes.
 * Best-effort: delivery never fails the run.
 */
export async function deliverResearchReport(ctx: ResearchPublishContext, 
  agent: { getResearchPdfByKey(k: string): Promise<{ bytes: Uint8Array; fileName: string } | null>; refreshIdeaQuotes(r: unknown, u?: string): Promise<Array<{ symbol: string; status: string; detail: string }>>; getResearchConfig(): Promise<{ autoEmail?: boolean; emailTo?: string }> },
  report: {
    runId: string;
    trigger: string;
    createdAt: string;
    summary: string;
    ideas: Array<{ rank: number; symbol: string; outlook: string; structure: string; score: number; thesis: string }>;
    watchlist: Array<{ symbol: string }>;
    rejected: Array<unknown>;
    userLogin?: string;
  },
  opts: { reportId: string | null; pdfKey: string | null; trigger: string; userLogin: string }
): Promise<{ emailed: boolean; slack: boolean; webhook: boolean; held: boolean }> {
  const result = { emailed: false, slack: false, webhook: false, held: false };

  // Pre-entry refresh: flag ideas that moved or went stale.
  const refreshFlags = await agent.refreshIdeaQuotes(report as never, opts.userLogin);
  const flagLines = refreshFlags.map(
    (f) => `⚠ ${f.symbol}: ${f.detail}`
  );

  // Delivery text from the canonical report.
  const ideaLines = report.ideas.slice(0, 5).map(
    (i) => `• #${i.rank} ${i.symbol} (${i.outlook}, ${i.structure}, score ${i.score.toFixed(1)})`
  );
  const text = [
    `🔬 Options research — ${report.trigger} run ${report.runId}`,
    report.summary,
    "",
    `Qualified ideas (${report.ideas.length}):`,
    ...ideaLines,
    ...(report.watchlist.length > 0 ? ["", `Watchlist: ${report.watchlist.map((w) => w.symbol).join(", ")}`] : []),
    ...(flagLines.length > 0 ? ["", "Pre-entry refresh:", ...flagLines] : []),
    "",
    "Research only; no trades were placed.",
  ].join("\n");

  // #277 HITL: hold for approval instead of delivering.
  if (ctx.getReportDispatchHitl()) {
    try {
      ctx.createReportConfirmation(
        "email",
        JSON.stringify({
          kind: "research",
          runId: report.runId,
          reportId: opts.reportId,
          pdfKey: opts.pdfKey,
          trigger: opts.trigger,
          userLogin: opts.userLogin,
        }),
        opts.reportId,
        opts.userLogin
      );
      result.held = true;
    } catch (err) {
      structuredLog.warn("researchPublish.research_hitl_hold_failed", {
        message: "[OrchestratorAgent] HITL hold failed:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return result;
  }

  const pdf = opts.pdfKey
    ? await agent.getResearchPdfByKey(opts.pdfKey).catch(() => null)
    : null;
  const reportUrl = `${ctx.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/research/report.pdf${opts.pdfKey ? `?key=${encodeURIComponent(opts.pdfKey)}` : ""}`;

  // 1. Slack via the gated dispatch (#3177): the tenant gate refuses a
  // disabled Slack before any sender is attempted; otherwise the master
  // sender tries A2A first and falls back to direct (previously nothing
  // was sent at all when cfpay was unconfigured).
  try {
    const delivery = await deliverGatedSlack(ctx.env, {
      userLogin: opts.userLogin,
      text,
      ...(pdf
        ? {
            pdf: {
              ...pdf,
              title: `Options research — ${report.trigger} ${report.createdAt.slice(0, 10)}`,
              comment: text,
            },
          }
        : {}),
    });
    result.slack = delivery.ok;
    if (!delivery.ok) structuredLog.warn("researchPublish.research_slack_delivery_failed", {
      message: "[OrchestratorAgent] Research Slack delivery failed:",
      error: delivery.error,
    });
  } catch (err) {
    structuredLog.warn("researchPublish.research_slack_delivery_failed", {
      message: "[OrchestratorAgent] Research Slack delivery failed:",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Email (opt-in via research config), with PDF attachment.
  try {
    const cfg = await agent.getResearchConfig();
    if (cfg.autoEmail && cfg.emailTo) {
      const { validateEmailRecipient } = await import("../../security/webhookReplay");
      const check = validateEmailRecipient(cfg.emailTo, ctx.env.EMAIL_TO_ALLOWED_DOMAINS);
      if (check.ok) {
        const { getCfpayConfig, cfpaySendEmail, cfpaySendEmailWithAttachments } = await import("../../services/cfpayA2A");
        const cfpay = getCfpayConfig(ctx.env);
        const subject = `🔬 Options research — ${report.ideas.length} qualified idea(s)${flagLines.length > 0 ? " (⚠ refresh flags)" : ""}`;
        let sent = false;
        if (cfpay) {
          let r;
          if (pdf) {
            let binary = "";
            for (let i = 0; i < pdf.bytes.length; i += 8192)
              binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
            r = await cfpaySendEmailWithAttachments(cfpay, {
              to: cfg.emailTo,
              subject,
              body: `${text}\n\nPDF report: ${reportUrl}`,
              attachments: [{ filename: pdf.fileName, contentB64: btoa(binary), contentType: "application/pdf" }],
            });
          } else {
            r = await cfpaySendEmail(cfpay, cfg.emailTo, subject, `${text}\n\nPDF report: ${reportUrl}`);
          }
          sent = r.ok;
        }
        if (!sent) {
          const emailService = new ETradeEmailTradingService(ctx.env, ctx.getOrm(), opts.userLogin);
          sent = await emailService.sendOutboundEmail(
            cfg.emailTo,
            subject,
            `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</p>`,
            `${text}\n\nPDF report: ${reportUrl}`,
            pdf
              ? (() => {
                  let binary = "";
                  for (let i = 0; i < pdf.bytes.length; i += 8192)
                    binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
                  return { fileName: pdf.fileName, contentType: "application/pdf", contentBase64: btoa(binary) };
                })()
              : undefined
          );
        }
        result.emailed = sent;
      }
    }
  } catch (err) {
    structuredLog.warn("researchPublish.research_email_delivery_failed", {
      message: "[OrchestratorAgent] Research email delivery failed:",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Webhook.
  try {
    const webhookUrl = (ctx.env as any).OUTBOUND_WEBHOOK_URL;
    if (webhookUrl) {
      const { ETradeWebhookService } = await import("../../services/tradingWebhooks");
      const webhook = new ETradeWebhookService(ctx.getOrm(), ctx.env, opts.userLogin);
      await webhook.dispatchOutboundWebhook("research.completed", {
        runId: report.runId,
        trigger: report.trigger,
        qualified: report.ideas.length,
        watchlist: report.watchlist.length,
        rejected: report.rejected.length,
        refreshFlags,
        reportUrl,
        reportId: opts.reportId,
      });
      result.webhook = true;
    }
  } catch (err) {
    structuredLog.warn("researchPublish.research_webhook_delivery_failed", {
      message: "[OrchestratorAgent] Research webhook delivery failed:",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/** Issue #319: opt-in email delivery of the stored research summary. */
export async function sendResearchSummaryEmail(ctx: ResearchPublishContext, 
  recipient: string,
  summary: string,
  ideaCount: number,
  reportId: string | null,
  userLogin: string
): Promise<boolean> {
  const { validateEmailRecipient } = await import("../../security/webhookReplay");
  const check = validateEmailRecipient(recipient, ctx.env.EMAIL_TO_ALLOWED_DOMAINS);
  if (!check.ok) return false;
  try {
    const emailService = new ETradeEmailTradingService(ctx.env, ctx.getOrm(), userLogin);
    return await emailService.sendOutboundEmail(
      recipient,
      `Options research report — ${ideaCount} qualified idea(s)`,
      `<p>${summary.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p><p>Full report${reportId ? ` (id ${reportId})` : ""} is available in the dashboard Reports tab. Research only; no trades were placed.</p>`,
      `${summary}\n\nFull report${reportId ? ` (id ${reportId})` : ""} is available in the dashboard Reports tab.\nResearch only; no trades were placed.`
    );
  } catch {
    return false;
  }
}
