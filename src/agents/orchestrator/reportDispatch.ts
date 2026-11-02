/**
 * Issue #992: Report dispatch (settings, HITL confirmations, canonical report delivery) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * ReportDispatchContext.
 */

import type { AgentContext } from "agents";
import { createOrchestratorTablePorts, type OrchestratorTablePorts } from "../../data/createOrchestratorTablePorts";
import { createSettingsPort } from "../../data/createSettingsPorts";
import type { SettingsPort } from "../../data/settingsReadPorts";
import type { DatabaseORM } from "../../orm";
import type { Env } from "../../types";
import { ETradeEmailTradingService } from "../../trading";
import { ETradeWebhookService } from "../../services/tradingWebhooks";
import {
  getCanonicalReport,
  isCanonicalReportOwnedBy,
  parseResearchReportBody,
  resolveCanonicalReportBodyWithBackfill,
  sha256Hex,
  storeReportAtGenerationWithR2,
} from "../../services/scheduledReports";

/**
 * Ports the report-dispatch functions receive from the class. The
 * HITL key and confirmation TTL remain the class's statics
 * (REPORT_DISPATCH_HITL_KEY / REPORT_CONFIRMATION_TTL_MS), passed by
 * value so stored keys and expiry math are unchanged.
 */
export interface ReportDispatchContext {
  env: Env;
  ensureTables: () => AgentContext["storage"]["sql"];
  getOrm: () => DatabaseORM;
  reportDispatchHitlKey: string;
  reportConfirmationTtlMs: number;
  /**
   * The two delivery legs stay class-boundary calls: the class's
   * sendReportEmail is the observed #308 delivery seam (tests spy on
   * it), so deliverStored* reach it through these bound wrappers —
   * the same dispatch the original this.* calls made. The module's
   * own sendReportEmail/sendReportWebhook functions below are what
   * the class wrappers delegate to.
   */
  sendReportEmail: (recipient: string, title: string, fileName: string, attachmentBase64: string, userLogin: string) => Promise<boolean>;
  sendReportWebhook: (title: string, query: string, sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>, userLogin: string) => Promise<{ success: boolean; status?: number; error?: string; notConfigured?: boolean }>;
}

/**
 * The settings doors delegate to the dedicated settings port
 * (#2390, step 4g — the G-7 ruling): mas_settings is owned by
 * its adapter (src/data/doSqliteOrmAdapters.ts, composed via
 * createSettingsPorts); these functions keep the ctx-shaped
 * façade the routes consume. ctx.ensureTables() still runs
 * first, exactly as before.
 */
function settingsPort(ctx: ReportDispatchContext): SettingsPort {
  return createSettingsPort(ctx.ensureTables() as never);
}

export function readSettingRaw(ctx: ReportDispatchContext, key: string): string | null {
  try {
    return settingsPort(ctx).get(key);
  } catch {
    return null;
  }
}

export function writeSetting(ctx: ReportDispatchContext, key: string, value: string): void {
  settingsPort(ctx).set(key, value);
}

/** Issue #277: true when report dispatch requires human confirmation.
 *  Default ON (owner decision 2026-10-23, #1144): an unset setting
 *  means enabled; only an explicit "0" (the settings toggle) opts out. */
export function getReportDispatchHitl(ctx: ReportDispatchContext): boolean {
  return readSettingRaw(ctx, ctx.reportDispatchHitlKey) !== "0";
}

export function setReportDispatchHitl(ctx: ReportDispatchContext, enabled: boolean): void {
  writeSetting(ctx, ctx.reportDispatchHitlKey, enabled ? "1" : "0");
}

/**
 * Stores a pending report-dispatch confirmation; returns its confirmation id.
 * Issue #308: payloadJson carries delivery metadata only (recipient /
 * fileName / title — never report bytes); the canonical report copy
 * lives once in mas_reports and is referenced by reportId.
 */
/** The family's ports over the context's sql handle (#2359).
 *  Only the confirmations port is used here; the settings pair
 *  above composes the settings port (#2390, gate G-7 ruled). */
function ports(ctx: ReportDispatchContext): OrchestratorTablePorts {
  return createOrchestratorTablePorts(ctx.ensureTables() as never);
}

export function createReportConfirmation(ctx: ReportDispatchContext,
  kind: "email" | "webhook" | "screener",
  payloadJson: string,
  reportId?: string | null,
  /** Issue #2664: the login creating the hold; null for legacy callers. */
  createdBy?: string | null
): string {
  const confirmations = ports(ctx).confirmations;
  const now = new Date().toISOString();
  // Lazy sweep: drop confirmations that expired unconfirmed.
  confirmations.sweepExpiredPending(
    new Date(Date.now() - ctx.reportConfirmationTtlMs).toISOString()
  );
  const id = `rc_${crypto.randomUUID().slice(0, 8)}`;
  confirmations.insertConfirmation({
    id,
    kind,
    payloadJson,
    status: "pending",
    createdAt: now,
    reportId: reportId ?? null,
    createdBy: createdBy ?? null,
  });
  return id;
}

export function getReportConfirmation(ctx: ReportDispatchContext, id: string): any | null {
  try {
    return ports(ctx).confirmations.getById(id);
  } catch {
    return null;
  }
}

export function decideReportConfirmation(ctx: ReportDispatchContext, id: string, status: "approved" | "rejected" | "expired", decidedBy: string | null): void {
  try {
    ports(ctx).confirmations.decide(
      id,
      status,
      new Date().toISOString(),
      decidedBy
    );
  } catch (err) {
    console.warn("[OrchestratorAgent] Failed to decide report confirmation:", err);
  }
}

/**
 * Issue #308: store the canonical report copy at generation time via the
 * single seam. The generation id is a content hash, so re-posts and
 * re-deliveries of the same report dedupe to one row. Returns the
 * mas_reports row id, or null when the store failed (dispatch routes
 * fail closed in that case — no copy is sent that search cannot see).
 */
export async function storeResearchReportCanonicalAsync(ctx: ReportDispatchContext, 
  bodyJson: string,
  meta: { title: string; summary: string; userLogin?: string }
): Promise<{ reportId: string; generationId: string } | null> {
  if (!meta.userLogin) {
    console.error(`[reportDispatch] Research report store refused: no owning userLogin (title: ${meta.title}).`);
    return null;
  }
  const generationId = await sha256Hex(bodyJson);
  // Issue #338 S2: the canonical body goes to R2 (pointer in the row)
  // when REPORTS_BUCKET is bound; the store falls back to the legacy
  // inline shape when it is not, so the seam's contract is unchanged.
  const stored = await storeReportAtGenerationWithR2(ctx.ensureTables(), ctx.env, {
    runId: generationId,
    generationId,
    title: meta.title,
    source: "research_report",
    summary: meta.summary,
    body: JSON.parse(bodyJson),
    createdAt: new Date().toISOString(),
    userLogin: meta.userLogin,
  });
  return stored ? { reportId: stored.reportId, generationId } : null;
}

/**
 * Issue #308: delivery metadata from a confirmation row. For #308 rows
 * this is exactly what was stored (no report bytes); for legacy rows
 * (pre-#308) it is parsed from the embedded full payload.
 */
export function confirmationDeliveryMeta(row: any): { recipient?: string } {
  try {
    const payload = JSON.parse(String(row.payload_json)) as any;
    if (payload && typeof payload === "object") {
      return {
        recipient:
          typeof payload.recipient === "string" ? payload.recipient : undefined,
      };
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Issue #308: deliver the STORED canonical copy by email. Returns
 * "sent" | "missing" (stored row gone) | "failed" (email service).
 */
export async function deliverStoredReportEmail(ctx: ReportDispatchContext, 
  reportId: string,
  recipient: string,
  userLogin: string
): Promise<"sent" | "missing" | "failed"> {
  const stored = getCanonicalReport(ctx.ensureTables(), reportId);
  if (!stored) return "missing";
  // Issue #2664: the stored row's owner must equal the calling login;
  // a mismatch returns "missing" (never the row, never a leak signal —
  // the route layer refuses cross-user delivery attempts with a typed
  // 403 before this seam). Resolved through the read port, never a
  // raw storage query.
  if (!isCanonicalReportOwnedBy(ctx.ensureTables(), reportId, userLogin)) return "missing";
  // Issue #338 S2+S4: resolve the body through the pointer (inline rows
  // resolve to themselves and backfill to R2 on this read; a lost R2
  // object resolves to null = missing).
  const body = await resolveCanonicalReportBodyWithBackfill(ctx.ensureTables(), ctx.env, stored);
  if (body === null) return "missing";
  const delivery = parseResearchReportBody(body);
  if (!delivery || !delivery.attachmentBase64) return "missing";
  const sent = await ctx.sendReportEmail(
    recipient,
    delivery.title,
    delivery.fileName,
    delivery.attachmentBase64,
    userLogin
  );
  return sent ? "sent" : "failed";
}

/**
 * Issue #308: deliver the STORED canonical copy by webhook. Returns
 * "sent" | "missing" (stored row gone) | "failed" (dispatch failed).
 */
export async function deliverStoredReportWebhook(ctx: ReportDispatchContext, 
  reportId: string,
  userLogin: string
): Promise<{ outcome: "sent" | "missing" | "failed"; result?: { success: boolean; status?: number; error?: string; notConfigured?: boolean } }> {
  const stored = getCanonicalReport(ctx.ensureTables(), reportId);
  if (!stored) return { outcome: "missing" };
  // Issue #2664: same owner rule as the email leg (see above).
  if (!isCanonicalReportOwnedBy(ctx.ensureTables(), reportId, userLogin)) return { outcome: "missing" };
  // Issue #338 S2+S4: resolve the body through the pointer (see email leg).
  const body = await resolveCanonicalReportBodyWithBackfill(ctx.ensureTables(), ctx.env, stored);
  if (body === null) return { outcome: "missing" };
  const delivery = parseResearchReportBody(body);
  if (!delivery || !Array.isArray(delivery.sheets) || delivery.sheets.length === 0) {
    return { outcome: "missing" };
  }
  const result = await ctx.sendReportWebhook(
    delivery.title,
    delivery.query,
    delivery.sheets,
    userLogin
  );
  return { outcome: result.success ? "sent" : "failed", result };
}

/**
 * Issue #308: persist a screener run's canonical report copy in the
 * orchestrator instance's mas_reports (the store the AI Search read
 * path queries — issue #307). ScreenerAgent.persistRun() keeps writing
 * the delivery cache (latest/history/per-run PDFs) in the screener
 * instance's own DO storage; the SEARCHABLE copy is written once here,
 * keyed by generationId `screener:<timestamp>`, so the scheduled
 * wrapper and manual runs cannot create duplicate rows for one run.
 */
export async function persistScreenerReportCanonical(ctx: ReportDispatchContext, result: {
  timestamp: string;
  universe?: unknown;
  sector?: unknown;
  /** Issue #1007: data provider provenance (default "etrade"). */
  provider?: unknown;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  opportunities: unknown[];
  allStocks: unknown[];
  /**
   * Issue #2369: the run's narrative fields, carried so the
   * canonical body is a complete read-back source (the chat
   * workflow path reads its results back from this body).
   * Additive: older readers ignore them.
   */
  discoveryMessage?: string;
  filterSummary?: string;
  rejections?: Array<{ symbol: string; reason: string }>;
  pdfKey?: string;
  /** Issue #2062: the workbook/CSV artifacts this run recorded. */
  xlsxKey?: string;
  xlsxStatus?: unknown;
  xlsxError?: unknown;
  csvKey?: string;
  csvStatus?: unknown;
  csvError?: unknown;
  /** Issue #2062: the screener-workflow family that produced the run. */
  runSource?: unknown;
  error?: string;
  trigger?: unknown;
  userLogin?: string;
  /** Issue #2863: replay criteria/refs — recorded in the body so future replays can show them. Additive: older readers ignore. */
  criteria?: unknown;
  patternRef?: unknown;
  presetRef?: unknown;
  /** Issue #2908 (G1): spec provenance — recorded in the body when the caller carries it. Additive: older readers ignore. */
  scheduleId?: unknown;
  jobId?: unknown;
  goalId?: unknown;
  /** Issue #2773: post-screening Pareto evaluation, recorded in the body when the run computed one. Additive. */
  pareto?: unknown;
}): Promise<void> {
  if (!result.userLogin) {
    console.error(`[reportDispatch] Screen report store refused: no owning userLogin (run: ${result.timestamp}).`);
    return;
  }
  try {
    const generationId = `screener:${result.timestamp}`;
    // Issue #338 S2b: store through the R2 seam (pointer row when
    // REPORTS_BUCKET is bound, inline fallback otherwise) — the same
    // flip the research path took in S2.
    await storeReportAtGenerationWithR2(ctx.ensureTables(), ctx.env, {
      runId: generationId,
      generationId,
      title: `Market screen — ${String(result.universe ?? result.sector ?? "ALL")} (${String(result.trigger ?? "scheduled")})`,
      source: "screener",
      summary: result.success
        ? `Scanned ${result.totalScanned} symbols, ${result.matchedCount} matched, ${result.opportunities.length} opportunities.`
        : `Screen failed: ${result.error ?? "unknown error"}.`,
      userLogin: result.userLogin,
      body: {
        timestamp: result.timestamp,
        universe: result.universe,
        sector: result.sector,
        // Issue #1007: provider provenance — a Yahoo-provider run is
        // identifiable as such in Reports; E*TRADE runs record the
        // default they have always implied.
        provider: result.provider ?? "etrade",
        trigger: result.trigger,
        success: result.success,
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunities: result.opportunities,
        allStocks: result.allStocks,
        // Issue #2369: narrative fields ride the body so a
        // read-back (chat workflow path) loses nothing the
        // direct path had in hand.
        discoveryMessage: result.discoveryMessage,
        filterSummary: result.filterSummary,
        rejections: result.rejections,
        pdfKey: result.pdfKey,
        xlsxKey: result.xlsxKey,
        xlsxStatus: result.xlsxStatus,
        xlsxError: result.xlsxError,
        csvKey: result.csvKey,
        csvStatus: result.csvStatus,
        csvError: result.csvError,
        runSource: result.runSource ?? "stock",
        // Issue #2863: replay criteria/refs ride the body.
        ...(result.criteria !== undefined ? { criteria: result.criteria } : {}),
        ...(result.patternRef !== undefined ? { patternRef: result.patternRef } : {}),
        ...(result.presetRef !== undefined ? { presetRef: result.presetRef } : {}),
        // Issue #2908 (G1): spec provenance rides the body.
        ...(result.scheduleId !== undefined ? { scheduleId: result.scheduleId } : {}),
        ...(result.jobId !== undefined ? { jobId: result.jobId } : {}),
        ...(result.goalId !== undefined ? { goalId: result.goalId } : {}),
        // Issue #2773: Pareto evaluation rides the body when present.
        ...(result.pareto !== undefined ? { pareto: result.pareto } : {}),
        reportUrl: result.pdfKey
          ? `${ctx.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
          : undefined,
        error: result.error,
      },
      createdAt: result.timestamp,
    });
  } catch {
    // Non-critical: persistence failure must not break the screen.
  }
}

/** Shared send leg for POST /trading/reports/email (immediate + confirmed paths). */
export async function sendReportEmail(ctx: ReportDispatchContext, 
  recipient: string,
  title: string,
  fileName: string,
  attachmentBase64: string,
  userLogin: string
): Promise<boolean> {
  const emailService = new ETradeEmailTradingService(ctx.env, ctx.getOrm(), userLogin);
  return emailService.sendOutboundEmail(
    recipient,
    `Research report: ${title}`,
    "<p>Your requested research workbook is attached.</p><p>Research only; no trades were placed.</p>",
    "Your requested research workbook is attached.\nResearch only; no trades were placed.",
    {
      fileName,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentBase64: attachmentBase64,
    }
  );
}

/** Shared send leg for POST /trading/reports/webhook (immediate + confirmed paths). */
export async function sendReportWebhook(ctx: ReportDispatchContext, 
  title: string,
  query: string,
  sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>,
  userLogin: string
): Promise<{ success: boolean; status?: number; error?: string; notConfigured?: boolean }> {
  const reportData = JSON.stringify({ title: title || "Research report", query: query || "", sheets });
  if (reportData.length > 512_000) {
    return { success: false, error: "The recommendation report exceeds the 512 KB webhook limit." };
  }
  if (!ctx.env.OUTBOUND_WEBHOOK_URL || !ctx.env.OUTBOUND_WEBHOOK_SECRET) {
    return {
      success: false,
      notConfigured: true,
      error: "Configure OUTBOUND_WEBHOOK_URL and OUTBOUND_WEBHOOK_SECRET to publish recommendations.",
    };
  }
  const webhook = new ETradeWebhookService(ctx.getOrm(), ctx.env, userLogin);
  return webhook.dispatchOutboundWebhook("research.recommendations", JSON.parse(reportData));
}
