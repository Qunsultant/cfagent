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
import type { ParentScreenReportInput } from "../../workflows/workflowPorts";
import { resolveStockReportFormatStatus } from "../../services/stockReportFormatStatus";
import {
  getCanonicalReport,
  isCanonicalReportOwnedBy,
  parseResearchReportBody,
  refreshCanonicalReportPdfFields,
  resolveCanonicalReportBodyWithBackfill,
  sha256Hex,
  storeReportAtGenerationWithR2,
  type CanonicalStoreResult,
  type RefreshCanonicalPdfFieldsResult,
  type ScheduledReportInput,
} from "../../services/scheduledReports";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { projectCanonicalReportBestEffort } from "../../services/runLedgerProjectionHooks";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/reportDispatch",
});

/**
 * Ports the report-dispatch functions receive from the class. The
 * HITL key remains a class static (REPORT_DISPATCH_HITL_KEY) and the
 * confirmation TTL lives in orchestrator/reportConfirmationTtl.ts
 * (REPORT_CONFIRMATION_TTL_MS), passed by value so stored keys and
 * expiry math are unchanged.
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
    structuredLog.warn("reportDispatch.report_confirmation_decide_failed", {
      message: "[OrchestratorAgent] Failed to decide report confirmation:",
      error: err instanceof Error ? err.message : String(err),
    });
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
    structuredLog.error("reportDispatch.research_report_store_refused", {
      message: `[reportDispatch] Research report store refused: no owning userLogin (title: ${meta.title}).`,
      title: meta.title,
    });
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
  /** Issue #2909 (G2): run qualifications for unmapped pattern guardrails — recorded in the body when the caller carries them. Additive: older readers ignore. */
  patternQualifications?: unknown;
  /** Issue #2773: post-screening Pareto evaluation, recorded in the body when the run computed one. Additive. */
  pareto?: unknown;
}): Promise<void> {
  if (!result.userLogin) {
    structuredLog.error("reportDispatch.screen_report_store_refused", {
      message: `[reportDispatch] Screen report store refused: no owning userLogin (run: ${result.timestamp}).`,
      runTimestamp: result.timestamp,
    });
    return;
  }
  try {
    const generationId = `screener:${result.timestamp}`;
    // Issue #338 S2b: store through the R2 seam (pointer row when
    // REPORTS_BUCKET is bound, inline fallback otherwise) — the same
    // flip the research path took in S2.
    const stored = await storeReportAtGenerationWithR2(ctx.ensureTables(), ctx.env, {
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
        // Issue #2909 (G2): pattern qualifications ride the body.
        ...(result.patternQualifications !== undefined ? { patternQualifications: result.patternQualifications } : {}),
        // Issue #2773: Pareto evaluation rides the body when present.
        ...(result.pareto !== undefined ? { pareto: result.pareto } : {}),
        reportUrl: result.pdfKey
          ? `${ctx.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
          : undefined,
        error: result.error,
      },
      createdAt: result.timestamp,
    });
    // Issue #4116 — project the landed row into D1 (ORM + queue
    // carriers, per the tenant's config). Inside the same
    // never-fail try: the hook re-reads the stored row (the store
    // may have deduped to a pre-existing row) and never throws,
    // so a projection failure cannot fail the screen.
    if (stored) {
      await projectCanonicalReportBestEffort({
        env: ctx.env,
        sql: ctx.ensureTables(),
        reportId: stored.reportId,
        generationId,
        userLogin: result.userLogin,
      });
    }
    // Issue #2869 slice 1 — publish AFTER the canonical row
    // lands, never before: persist-then-publish ordering from
    // the stageMessage contract. Only successful runs with a
    // full analysis set publish (a failed/empty run has no
    // persisted analysis for the consumer to generate from,
    // and the consumer refuses to regenerate it). The parent
    // row (persistParentScreenReportCanonical) does NOT
    // publish: it carries no single analysis key, and its
    // children already published their own messages. A
    // publish failure never fails the run — the row is
    // durable and the in-process PDF leg already ran
    // (publishAnalysisDone reports, never throws).
    if (
      result.success &&
      Array.isArray(result.allStocks) &&
      result.allStocks.length > 0 &&
      result.userLogin
    ) {
      const { publishAnalysisDone } = await import("../../workflows/stageQueueTransport");
      await publishAnalysisDone({
        queue: ctx.env.SCREENER_EVENTS as never,
        timestamp: result.timestamp,
        userLogin: result.userLogin,
      });
    }
  } catch {
    // Non-critical: persistence failure must not break the screen.
  }
}

/**
 * Issue #3940 (#3550 precondition (a)) — store a pipeline
 * generate report's canonical copy through the one seam. The
 * J generate stage's tenant-aware leg calls this through the
 * OrchestratorAgent.recordPipelineGenerateReport door, so the
 * canonical row lands in THIS (the report-owning tenant's)
 * Orchestrator DO's mas_reports — the store the Reports read
 * path queries — in both pipeline residencies. The input
 * already carries its resolved owner (the leg resolved it
 * per job); an owner-less input is refused with null, never
 * filed under a default tenant.
 */
export async function persistPipelineGenerateReportCanonical(
  ctx: ReportDispatchContext,
  input: ScheduledReportInput,
): Promise<CanonicalStoreResult | null> {
  if (!input?.userLogin) {
    structuredLog.error("reportDispatch.pipeline_generate_report_store_refused", {
      message:
        "[reportDispatch] Pipeline generate report store refused: no owning userLogin.",
    });
    return null;
  }
  const stored = await storeReportAtGenerationWithR2(ctx.ensureTables(), ctx.env, input);
  // Issue #4116 — project the landed row into D1 (ORM + queue
  // carriers, per the tenant's config). The hook re-reads the
  // stored row and never throws; a missing generationId skips
  // it (the sweep backstops the row by id).
  if (stored && input.generationId) {
    await projectCanonicalReportBestEffort({
      env: ctx.env,
      sql: ctx.ensureTables(),
      reportId: stored.reportId,
      generationId: input.generationId,
      userLogin: input.userLogin,
    });
  }
  return stored;
}

/**
 * Issue #2910 (G3): persist a workflow parent run's ONE
 * canonical row in mas_reports. The parent row is a
 * summary + linkage record, not a second screen result:
 * it carries the collation (lifecycle, qualified partial,
 * coverage, per-shard outcomes, per-format keys/statuses)
 * and the child linkage (childRunIds / childReportIds),
 * and it carries NO opportunities, NO bulk results, NO
 * fabricated counts — the children already stored their
 * own full rows, which stay in mas_reports and stay
 * reachable by id. The Runs merge absorbs the child rows
 * into this row (see mergeRunSummaries), so one parent
 * run is one top-level Docs row.
 *
 * Keying: generationId = runId = the parent jobId, so a
 * re-execution under the same job id adopts the existing
 * parent row (the shard generation-dedupe rule) instead
 * of writing a second parent row. Per-format statuses use
 * the G4 target vocabulary in its narrow sense: generated
 * when a key exists, failed when the run failed with no
 * key, missing when no key and no failure (G4 unifies the
 * full language, including never-attempted/skipped, for
 * every format leg). Returns the stored report id, or
 * null when the row was refused (no owner) or the store
 * seam returned nothing — callers record that outcome,
 * they do not claim a store that never landed. Unlike
 * the sibling persist this function swallows nothing: the
 * store seam itself returns null (and logs) on failure,
 * and any other throw propagates to the parent flow's
 * store-parent step, which records it as a storeError —
 * a persistence failure never breaks the screen, and it
 * is never silently dropped either.
 */
/**
 * Issue #2869 slice 1 follow-up — refresh a canonical
 * mas_reports row's PDF fields after a queued consume
 * generated them. Thin wrapper over
 * scheduledReports.refreshCanonicalReportPdfFields, so
 * the one recorder owns the update: update-only (never
 * creates a row), monotonic (missing fills, failed may
 * upgrade to generated, generated never overwritten),
 * owner re-checked. Called by the OrchestratorAgent
 * door (refreshCanonicalPdfFields) from the queue
 * handler, never by the ScreenerAgent — the screener
 * keeps zero canonical-store references.
 */
export async function refreshCanonicalPdfFields(
  ctx: ReportDispatchContext,
  input: {
    generationId: string;
    userLogin: string;
    pdfKey: string;
    pdfStatus?: string;
    pdfError?: string;
  },
): Promise<RefreshCanonicalPdfFieldsResult> {
  return refreshCanonicalReportPdfFields(
    ctx.ensureTables() as never,
    ctx.env as never,
    input,
  );
}

export async function persistParentScreenReportCanonical(
  ctx: ReportDispatchContext,
  input: ParentScreenReportInput,
): Promise<{ reportId: string } | null> {
  if (!input.userLogin) {
    structuredLog.error("reportDispatch.parent_screen_report_store_refused", {
      message: `[reportDispatch] Parent screen report store refused: no owning userLogin (job: ${input.jobId}).`,
      jobId: input.jobId,
    });
    return null;
  }
  const c = input.collation;
  const done = c.shards.filter((s) => s.status === "completed").length;
  const total = c.shards.length;
  const failed = c.shards.filter((s) => s.status !== "completed");
  const success = c.lifecycle !== "Failed";
  const coverage =
    c.coverage.ratio === null
      ? "no coverage recorded"
      : `${Math.round(c.coverage.ratio * 100)}% coverage (${c.coverage.evaluated} of ${c.coverage.considered} evaluated)`;
  const summary =
    `Parent screen run: ${done}/${total} shards completed, ${coverage}` +
    (c.qualified
      ? `. Qualified partial — failed/timed out shards: ${failed.map((s) => s.shardId).join(", ") || "none"}.`
      : ".") +
    (c.lifecycle === "Failed" ? ` Run failed: ${c.error ?? "no usable shard"}.` : "") +
    ` Shard rows retained (see child linkage in the report body).`;
  // Issue #2911 (G4): per-format statuses through the one vocabulary
  // resolver — a key means generated, a failed run with no key means
  // failed, anything else requested-but-absent means missing. Same
  // mapping this writer hand-rolled before, now shared with the
  // artifact module and the client.
  const formatStatus = (keys: string[] | undefined): string =>
    resolveStockReportFormatStatus({
      key: keys && keys.length > 0 ? keys[0] : null,
      runFailed: !success,
    });
  const stored = await storeReportAtGenerationWithR2(ctx.ensureTables(), ctx.env, {
    runId: input.jobId,
    generationId: input.jobId,
    title: input.goalScreen
      ? `Goal screen (parent run) — ${input.trigger}`
      : `Market screen (parent run) — ${input.trigger}`,
    source: input.goalScreen ? "goal_screen" : "screener",
    summary,
    userLogin: input.userLogin,
    body: {
      parentJobId: input.jobId,
      jobId: input.jobId,
      trigger: input.trigger,
      success,
      lifecycle: c.lifecycle,
      qualified: c.qualified,
      coverage: c.coverage,
      shards: c.shards,
      childRunIds: input.childRunIds,
      childReportIds: input.childReportIds,
      reportKeys: c.reportKeys,
      xlsxKeys: c.xlsxKeys ?? [],
      csvKeys: c.csvKeys ?? [],
      storedShards: c.storedShards,
      deliveredShards: c.deliveredShards,
      storeErrors: c.storeErrors ?? {},
      deliverErrors: c.deliverErrors ?? {},
      runSource: input.goalScreen ? "goal" : "stock",
      pdfKey: c.reportKeys[0] ?? null,
      pdfStatus: formatStatus(c.reportKeys),
      ...(success ? {} : { pdfError: c.error ?? "Parent run failed." }),
      xlsxKey: (c.xlsxKeys ?? [])[0] ?? null,
      xlsxStatus: formatStatus(c.xlsxKeys),
      csvKey: (c.csvKeys ?? [])[0] ?? null,
      csvStatus: formatStatus(c.csvKeys),
      error: c.error,
    },
    createdAt: input.createdAt,
  });
  // Issue #4116 — project the landed parent row into D1 (ORM +
  // queue carriers, per the tenant's config). generationId =
  // runId = the parent jobId by construction, so the twin link
  // resolves to the parent job's jobRunRecord. The hook never
  // throws; a projection failure cannot fail the parent run.
  if (stored) {
    await projectCanonicalReportBestEffort({
      env: ctx.env,
      sql: ctx.ensureTables(),
      reportId: stored.reportId,
      generationId: input.jobId,
      userLogin: input.userLogin,
    });
  }
  return stored ? { reportId: stored.reportId } : null;
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
