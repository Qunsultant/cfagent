/**
 * Issue Qunsultant/cfagent#2037 — internal scheduled-job outcome
 * route: POST /scheduled-job-outcome.
 *
 * The Worker-side dispatch observer (scheduled() catch path) cannot
 * write mas_events itself — the audit store lives in OrchestratorAgent
 * DO SQLite — so a dispatch-layer failure is reported back through
 * this route, which funnels into the SAME single sink (mas_events
 * type scheduled_job.outcome) and the SAME streak/alert logic as the
 * in-DO handler audits. No second audit system, no second counter.
 *
 * Gate: background attribution only. The caller must resolve to the
 * background actor (login == configured service login); anything
 * else gets 401. With no service login configured, nothing is
 * background and the route refuses everyone — fail-closed.
 *
 * Body: { job, outcome, traceId?, errorCode?, reason? }. Codes only:
 * a malformed traceId degrades to null (the #1743 ingress rule),
 * an invalid job/outcome is 400, and no message field is ever
 * accepted or stored.
 */
import { resolveActorAttribution } from "../../security/backgroundAttribution";
import { resolveScheduledJobAlertThreshold } from "../../config/scheduledJobAlert";
import { postSlackText, resourceSlackPost } from "../resourceGoals";
import type { SlackDeliveryEnv } from "../social/delivery";
import {
  SCHEDULED_JOB_OUTCOME_TYPE,
  buildScheduledJobOutcomePayload,
  isScheduledJobId,
  parseScheduledJobOutcomeRow,
  recordScheduledJobOutcome,
  type ScheduledJobOutcomeInput,
  type ScheduledJobOutcomeStore,
} from "../../observability/scheduledJobOutcomes";

export interface ScheduledJobOutcomeRouteContext {
  /** Configured service login (null = unconfigured, route refuses all). */
  serviceLogin: string | null;
  /** Audit writer (owner: OrchestratorAgent — funnels to mas_events). */
  audit: (
    type: string,
    agent: string,
    payload: Record<string, unknown>,
  ) => void | Promise<void>;
  /** ORM accessor for the streak read over mas_events. */
  getOrm: () => {
    events: {
      findMany: (options: {
        where: { type: string };
        orderBy?: string;
        limit?: number;
      }) => Array<{
        payload?: unknown;
        createdAt?: string;
        created_at?: string;
      }> | Promise<
        Array<{
          payload?: unknown;
          createdAt?: string;
          created_at?: string;
        }>
      >;
    };
  };
  /** Worker environment (threshold var + Slack delivery vars). */
  env: Record<string, unknown>;
  /** Test seam: production posts through the existing Slack route. */
  sendAlert?: (text: string) => void | Promise<void>;
}

function parseOutcomePayload(
  raw: unknown,
): { job: string; outcome: string; traceId: string | null; errorCode?: string; reason?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const job = body.job;
  const outcome = body.outcome;
  if (typeof job !== "string" || typeof outcome !== "string") return null;
  const traceId =
    typeof body.traceId === "string" && /^[0-9a-f]{32}$/.test(body.traceId)
      ? body.traceId
      : null;
  return {
    job,
    outcome,
    traceId,
    errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  };
}

export async function handleScheduledJobOutcomeRoute(
  request: Request,
  ctx: ScheduledJobOutcomeRouteContext,
): Promise<Response> {
  const attribution = resolveActorAttribution(request.headers, ctx.serviceLogin);
  if (attribution.actorKind !== "background") {
    return Response.json(
      { success: false, error: "Background service dispatch required." },
      { status: 401 },
    );
  }
  const parsed = parseOutcomePayload(
    await request.json().catch(() => null),
  );
  if (
    !parsed ||
    !isScheduledJobId(parsed.job) ||
    (parsed.outcome !== "ran" &&
      parsed.outcome !== "skipped" &&
      parsed.outcome !== "failed")
  ) {
    return Response.json(
      { success: false, error: "Unknown job or outcome." },
      { status: 400 },
    );
  }
  const input: ScheduledJobOutcomeInput = {
    job: parsed.job,
    outcome: parsed.outcome as ScheduledJobOutcomeInput["outcome"],
    traceId: parsed.traceId,
    errorCode: parsed.errorCode,
    reason: parsed.reason,
  };
  const store: ScheduledJobOutcomeStore = {
    writeOutcome: async (entry) => {
      await ctx.audit(
        SCHEDULED_JOB_OUTCOME_TYPE,
        "orchestrator",
        buildScheduledJobOutcomePayload(entry) as unknown as Record<
          string,
          unknown
        >,
      );
    },
    recentOutcomes: async (maxRows) => {
      try {
        const rows = await ctx.getOrm().events.findMany({
          where: { type: SCHEDULED_JOB_OUTCOME_TYPE },
          orderBy: "created_at DESC",
          limit: maxRows,
        });
        return rows
          .map(parseScheduledJobOutcomeRow)
          .filter(
            (row): row is { job: string; outcome: string; createdAt: string } =>
              row !== null,
          );
      } catch {
        return [];
      }
    },
  };
  const sendAlert =
    ctx.sendAlert ??
    (async (text: string) => {
      await postSlackText({
        post: resourceSlackPost,
        env: ctx.env as unknown as SlackDeliveryEnv,
        text,
      });
    });
  const result = await recordScheduledJobOutcome(
    {
      store,
      alert: sendAlert,
      threshold: resolveScheduledJobAlertThreshold(ctx.env),
    },
    input,
  );
  if (!result.recorded) {
    return Response.json(
      { success: false, error: "Outcome record failed." },
      { status: 500 },
    );
  }
  return Response.json({
    success: true,
    job: input.job,
    outcome: input.outcome,
    streak: result.streak,
    alerted: result.alerted,
  });
}
