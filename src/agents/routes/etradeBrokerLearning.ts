/**
 * Issue #995: E*TRADE broker route sub-domain module, split out of
 * src/agents/routes/etradeBroker.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeBroker.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the setup catalog, learnings store, and reflection trigger (activity-handler extras)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import type { EtradeBrokerRouteContext } from "./etradeBroker";
import { resolveScheduledJobAlertThreshold } from "../../config/scheduledJobAlert";
import {
  SCHEDULED_JOB_OUTCOME_TYPE,
  buildScheduledJobOutcomePayload,
  parseScheduledJobOutcomeRow,
  recordScheduledJobOutcome,
  type ScheduledJobOutcomeInput,
  type ScheduledJobOutcomeRow,
  type ScheduledJobOutcomeStore,
} from "../../observability/scheduledJobOutcomes";
import { postSlackText, resourceSlackPost } from "../resourceGoals";
import type { SlackDeliveryEnv } from "../social/delivery";

/**
 * Issue Qunsultant/cfagent#2037 — the reflection job's outcome
 * deps: the single mas_events sink (write through the audit funnel,
 * streak read over the ORM events port) plus the existing Slack
 * route for repeat-failure alerts. Every call is guarded: a missing
 * accessor degrades to a recorded:false no-op, never to a changed
 * response — observation must never fail the job it observes.
 */
function reflectionOutcomeDeps(ctx: EtradeBrokerRouteContext): {
  store: ScheduledJobOutcomeStore;
  alert: (text: string) => Promise<void>;
  threshold: number;
} {
  const store: ScheduledJobOutcomeStore = {
    writeOutcome: async (entry) => {
      ctx.audit(
        SCHEDULED_JOB_OUTCOME_TYPE,
        "orchestrator",
        buildScheduledJobOutcomePayload(entry) as unknown as Record<
          string,
          unknown
        >,
      );
    },
    recentOutcomes: async (maxRows) => {
      const events = (ctx.getOrm() as unknown as {
        events?: {
          findMany: (options: {
            where: { type: string };
            orderBy?: string;
            limit?: number;
          }) => Array<{
            payload?: unknown;
            createdAt?: string;
            created_at?: string;
          }>;
        };
      }).events;
      if (!events || typeof events.findMany !== "function") return [];
      return events
        .findMany({
          where: { type: SCHEDULED_JOB_OUTCOME_TYPE },
          orderBy: "created_at DESC",
          limit: maxRows,
        })
        .map(parseScheduledJobOutcomeRow)
        .filter(
          (row): row is ScheduledJobOutcomeRow => row !== null,
        );
    },
  };
  return {
    store,
    alert: async (text: string) => {
      await postSlackText({
        post: resourceSlackPost,
        env: ctx.env as unknown as SlackDeliveryEnv,
        text,
      });
    },
    threshold: resolveScheduledJobAlertThreshold(
      ctx.env as unknown as Record<string, unknown>,
    ),
  };
}

async function recordReflectionOutcome(
  ctx: EtradeBrokerRouteContext,
  input: Omit<ScheduledJobOutcomeInput, "job">,
): Promise<void> {
  try {
    const deps = reflectionOutcomeDeps(ctx);
    await recordScheduledJobOutcome(deps, { job: "reflection", ...input });
  } catch {
    // Observation never fails the response.
  }
}

export async function handleTradingSetupCatalog(): Promise<Response> {
  try {
    const { listSetups } = await import("../../trading");
    return Response.json({ setups: listSetups() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load catalog" }, { status: 500 });
  }
}

export async function handleLearningsList(request: Request, url: URL, ctx: EtradeBrokerRouteContext): Promise<Response> {
  try {
    const { getActiveLearnings, getLearningHistory } = await import("../../services/learnings");
    const domain = url.searchParams.get("domain") || undefined;
    const history = url.searchParams.get("history") === "true";
    const learnings = history
      ? getLearningHistory(ctx.getOrm(), domain)
      : getActiveLearnings(ctx.getOrm(), domain);
    return Response.json({ learnings });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to list learnings" }, { status: 500 });
  }
}

export async function handleLearningsCreate(request: Request, ctx: EtradeBrokerRouteContext): Promise<Response> {
  try {
    const { recordLearning } = await import("../../services/learnings");
    const body = (await request.json().catch(() => ({}))) as any;
    if (!body.domain || !body.observation) {
      return Response.json({ error: "domain and observation required" }, { status: 400 });
    }
    const id = recordLearning(ctx.getOrm(), {
      domain: body.domain,
      observation: body.observation,
      evidenceRefs: body.evidenceRefs,
      confidence: body.confidence,
      source: "human",
    });
    return Response.json({ id, success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to record learning" }, { status: 500 });
  }
}

export async function handleReflectionRun(ctx: EtradeBrokerRouteContext): Promise<Response> {
  try {
    const { runReflection } = await import("../../services/reflection");
    const result = runReflection(ctx.getOrm(), new Date());
    // Issue Qunsultant/cfagent#2037 — every outcome leaves a record
    // in the single sink, including the Tuesday skip that used to be
    // invisible everywhere except Cloudflare logs. Response shape
    // unchanged; a failed record never changes the response.
    await recordReflectionOutcome(ctx, {
      outcome: result.skipped ? "skipped" : "ran",
      traceId: ctx.traceId ?? null,
      reason: result.skipped,
    });
    return Response.json({ success: true, ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    await recordReflectionOutcome(ctx, {
      outcome: "failed",
      traceId: ctx.traceId ?? null,
      errorCode: (err as { code?: unknown } | null)?.code as string | undefined,
    });
    return Response.json({ error: err instanceof Error ? err.message : "Reflection failed" }, { status: 500 });
  }
}
