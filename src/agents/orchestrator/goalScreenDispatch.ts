/**
 * Issue #1996 (#1972 slice 1) — the workflow child's goal
 * store/deliver doors, mirroring executeGoalScreenRun's
 * canonical seams (services/screeningRuntime.ts) for runs
 * that execute inside a workflow child instead of a route.
 *
 * The child runs inside the workflow runtime with no route
 * context, so these functions take the orchestrator's own
 * env + orm (the routes run inside the OrchestratorAgent DO,
 * so this IS the same mas_reports store the Runs surface
 * reads — not a second store). Execution lives here, not in
 * the class body, following the #992 extraction pattern:
 * the class keeps two thin delegating methods.
 *
 * Difference from the market door (deliberate): a store
 * failure THROWS here, so the flow records stored=false +
 * storeError on the shard output (honest) instead of the
 * market door's swallow-and-claim-stored. The flow never
 * fails a run on a store/deliver error either way.
 */
import type { DatabaseORM } from "../../orm";
import type { GoalDrivenScreenResult } from "../../services/goalDrivenScreen";
import { recordGoalRunOutcome } from "../../services/goalScreenReports";
import { recordScreeningActivity } from "../../services/screeningActivity";
import {
  createScreeningDeliverySenders,
  deliverScreeningContent,
  formatGoalScreenDelivery,
  type ScreeningChannel,
} from "../../services/screeningDelivery";
import { resolveTenantChannelGate } from "../../services/tenantChannelGate";

/** The orchestrator-owned context the goal doors need. */
export interface GoalScreenDispatchContext {
  env: unknown;
  getOrm: () => DatabaseORM;
}

/**
 * The child's full goal result, as the runner envelopes it
 * (task id + scenario source + trigger + result). The store
 * door unpacks it; the flow never inspects it.
 */
export interface WorkflowGoalScreenEnvelope {
  taskId: string;
  scenarioSource: "built" | "stored";
  trigger: "manual" | "scheduled";
  result: GoalDrivenScreenResult;
  /** Issue #1998: caller run id (D2) the run's captures are keyed by. */
  idempotencyKey?: string;
  /** Issue #1571: carried so the store can stamp it when the result lacks it. */
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}

/**
 * Store a completed workflow goal run on the canonical seams:
 * the mas_reports row (the serve stage verifies it) + the
 * screening activity record. Shape mirrors
 * executeGoalScreenRun exactly — same runId scheme, title,
 * summary, body (artifact keys top-level so the Runs read
 * surface finds them), and activity detail — so a workflow
 * run and a direct run are indistinguishable downstream.
 * Returns the canonical report id (the panel fetches the
 * stored run by it). Throws on persistence failure — the
 * store never throws itself (it returns null), so the null
 * check here is what makes the module docstring's
 * "store failure throws" true and lets the flow record
 * stored=false + storeError instead of claiming stored.
 * An existing generation returns its id (created: false),
 * never null, so a retried store still surfaces the id.
 */
export async function persistWorkflowGoalScreenReport(
  ctx: GoalScreenDispatchContext,
  envelope: WorkflowGoalScreenEnvelope,
  userLogin: string,
): Promise<string> {
  const result = envelope.result;
  // Issue #1571: the recorded result carries the fallback
  // marker even if the agent did not stamp it — the canonical
  // report body embeds `result`, so this is what the Runs
  // read surface and the PDF generator see. Caller-side
  // guarantee, not a second source of truth (mirrors the
  // direct path).
  if (envelope.providerFallback && !result.providerFallback) {
    result.providerFallback = envelope.providerFallback;
  }
  if (envelope.provider && !result.provider) {
    result.provider = envelope.provider;
  }
  const summary =
    `Goal screen (${result.goalKind}/${result.outlook}) ${result.status}: ` +
    `${result.counts.hits} hit(s) from ${result.counts.stocksScanned} stocks + ` +
    `${result.counts.optionsUnderlyingsScanned} option underlyings.`;
  const orm = ctx.getOrm();
  const stored = orm.storeCanonicalReport({
    runId: `goal-screen:${envelope.taskId}`,
    generationId: `goal-screen:${envelope.taskId}`,
    title: `Goal screen — ${result.goalKind} (${result.outlook})`,
    source: "goal_screen",
    summary,
    body: {
      trigger: envelope.trigger,
      scenarioSource: envelope.scenarioSource,
      taskId: envelope.taskId,
      // Issue #1998: the caller run id (D2) the run's data captures
      // are keyed by — mirrors the direct path's body field, so a
      // staged run's provenance resolves from this record alone.
      ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
      result,
      // Issue #1335: artifact keys ride top-level so the Runs
      // read surface (runSummaryFromReport) finds them — the
      // result object alone is not in its lookup chain.
      ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
      ...(result.pdfStatus ? { pdfStatus: result.pdfStatus } : {}),
      ...(result.pdfError ? { pdfError: result.pdfError } : {}),
      ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
      ...(result.xlsxStatus ? { xlsxStatus: result.xlsxStatus } : {}),
      ...(result.xlsxError ? { xlsxError: result.xlsxError } : {}),
      ...(result.csvKey ? { csvKey: result.csvKey } : {}),
      ...(result.csvStatus ? { csvStatus: result.csvStatus } : {}),
      ...(result.csvError ? { csvError: result.csvError } : {}),
    },
    createdAt: result.completedAt,
    userLogin,
  },
  // Issue #1169 S4-1: thread the dispatch env so the seam indexes this
  // goal_screen row at write time (ctx.env is unknown-typed here).
  ctx.env as { AI?: any; VECTOR_MEMORY?: any });
  if (!stored) {
    throw new Error(
      `Goal screen report could not be stored for run goal-screen:${envelope.taskId} (canonical store returned null).`,
    );
  }
  recordGoalRunOutcome(
    typeof (orm as { getSql?: () => unknown }).getSql === "function"
      ? ((orm as { getSql: () => unknown }).getSql() as any)
      : undefined,
    {
      id: `goal-screen:${envelope.taskId}`,
      trigger: envelope.trigger,
      status: result.status === "failed" ? "failed" : result.status === "partial" ? "partial" : "completed",
      scanned: result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
      matched: result.counts.hits,
      pdfKey: result.pdfKey,
      xlsxKey: result.xlsxKey,
      csvKey: result.csvKey,
      reportUrl: result.pdfKey
        ? `/api/screening/goal-screen/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
        : undefined,
      origin: "goal-screen-workflow",
      createdAt: result.completedAt,
    },
  );
  recordScreeningActivity(orm as any, {
    userLogin,
    kind: "screen_run",
    summary: `Goal screen ${result.goalKind} (${result.outlook}) — ${result.status}, ${result.counts.hits} hit(s).`,
    detail: {
      taskId: envelope.taskId,
      status: result.status,
      counts: result.counts,
      trigger: envelope.trigger,
      scenarioSource: envelope.scenarioSource,
    },
    refId: envelope.taskId,
  });
  return stored.reportId;
}

/**
 * Deliver a completed workflow goal run through the goal
 * delivery seam (same event, subject, text, and data as the
 * direct path). Channels with no configured sender, and an
 * email channel without a recipient, record per-channel
 * failures in the returned results — they never throw the
 * deliver step (the flow records deliverError only when the
 * seam itself throws).
 */
export async function deliverWorkflowGoalScreenOutcome(
  ctx: GoalScreenDispatchContext,
  envelope: WorkflowGoalScreenEnvelope,
  userLogin: string,
  channels: ScreeningChannel[],
  emailTo?: string,
): Promise<void> {
  const result = envelope.result;
  const formatted = formatGoalScreenDelivery(result);
  const orm = ctx.getOrm();
  // Issue #3169: the tenant channel gate, resolved best-effort
  // (null = ungated, prior behavior — see tenantChannelGate).
  const channelGate = await resolveTenantChannelGate(ctx.env, userLogin);
  await deliverScreeningContent({
    channels,
    subject: formatted.subject,
    text: formatted.text,
    event: "screening.goal_screen",
    data: {
      taskId: envelope.taskId,
      goalKind: result.goalKind,
      outlook: result.outlook,
      status: result.status,
      hits: result.counts.hits,
    },
    ...(emailTo ? { emailTo } : {}),
    senders: createScreeningDeliverySenders(ctx.env, orm, userLogin),
    sql: orm as any,
    userLogin,
    ...(channelGate ? { channelGate } : {}),
  });
}
