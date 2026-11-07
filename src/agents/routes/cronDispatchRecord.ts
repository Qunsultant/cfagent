/**
 * Issue Qunsultant/cfagent#3121 Slice S5 — cron dispatch record
 * route: POST /schedules/record-cron-dispatch.
 *
 * The Worker-side `scheduled()` dispatcher cannot write
 * `job_run_records` itself — the store lives in OrchestratorAgent
 * DO SQLite — so each named cron entry point reports its dispatch
 * back through this route, which writes the row with the same store
 * the schedule-callback recorder uses. The row records the
 * DISPATCH, not downstream outcomes.
 *
 * Gate: background attribution only, mirroring
 * `handleScheduledJobOutcomeRoute`. The caller must resolve to the
 * background actor (login == configured service login); anything
 * else gets 401. With no service login configured, nothing is
 * background and the route refuses everyone — fail-closed. (That is
 * why a renewal dispatch with no service user configured gets a
 * 401 on its record POST: the Worker-side poster logs it and
 * swallows it — the row is best-effort in that state and lands
 * normally once the service user is configured.)
 *
 * Body: { cron, entryPoint, outcome, started, finished, error?,
 * detail? }. The payload validator enforces the builder's own
 * rules (a malformed shape is 400); a valid payload is stored and
 * answered 200 { success: true, jobId, scheduleId }. A store
 * failure is 500 — the Worker-side poster logs it and moves on.
 */
import { resolveActorAttribution } from "../../security/backgroundAttribution";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import type { Env } from "../../types";
import type { SqlStorage } from "../../orm";
import { parseCronDispatchRecordPayload } from "../../services/consolidatedCronEntries";
import { recordCronDispatchRun } from "../orchestrator/scheduleCallbackRunRecords";

export interface CronDispatchRecordRouteContext {
  /** Worker environment (service-login lookup). */
  env: Env;
  /** The orchestrator DO SQLite (owner: OrchestratorAgent). */
  sql: SqlStorage;
}

export async function handleCronDispatchRecordRoute(
  request: Request,
  ctx: CronDispatchRecordRouteContext,
): Promise<Response> {
  const attribution = resolveActorAttribution(
    request.headers,
    getServiceUserLogin(ctx.env),
  );
  if (attribution.actorKind !== "background") {
    return Response.json(
      { success: false, error: "Background service dispatch required." },
      { status: 401 },
    );
  }
  const parsed = parseCronDispatchRecordPayload(
    await request.json().catch(() => null),
  );
  if (!parsed) {
    return Response.json(
      { success: false, error: "Invalid cron dispatch record payload." },
      { status: 400 },
    );
  }
  try {
    recordCronDispatchRun(ctx.sql, parsed);
  } catch {
    return Response.json(
      { success: false, error: "Cron dispatch record failed." },
      { status: 500 },
    );
  }
  return Response.json({
    success: true,
    jobId: parsed.cron,
    scheduleId: parsed.cron,
  });
}
