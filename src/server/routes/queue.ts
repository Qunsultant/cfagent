/**
 * Queue / scheduled consumers for the Worker entry (src/server.ts).
 *
 * Slice 8 of Qunsultant/cfagent#2902 — moves only. The default export's
 * `scheduled` and `queue` handlers move here verbatim, with the
 * module-level queue state (the per-subscriber / per-envelope dedup
 * sets) and the shared options_analysis dispatch helper. Bodies keep
 * their original indentation on purpose: re-indenting would shift
 * lines inside template literals and change log bytes.
 *
 * Ownership (contract section 8, Q4, answered in this slice):
 * screener-events + screener-events-delivery route through the
 * Messaging QueuePort consumer and broadcast core; the
 * options_analysis dispatch targets Trading's schedule surface
 * (/schedules/trigger-options-analysis) and the legacy taskType
 * wrapper stays deprecated with no new producers; the analysis-done
 * (#2869 S1) and stage-boundary (#2869 S2) executors route to the
 * owning ScreenerAgent DO. The scheduled tick is cross-domain by
 * design (one trace/identity gate; each dispatch targets its own
 * domain route). Behaviour is unchanged: ack, DLQ, dedup, and
 * denied-message logging are exactly as in server.ts.
 *
 * ensureBreakerDurability lives in ./core (contract section 2.5
 * Core prelude) and is called at the top of both handlers, as in
 * the entry; the default export in server.ts stays a one-line
 * delegation per entry point.
 */

import type { Env } from "../../types";
import { getServiceUserLogin, isLoginShaped, isSharedOrchestratorAddress, SHARED_ORCHESTRATOR_INSTANCE } from "../../security/serviceIdentity";
import { backgroundDispatchHeaders } from "../../security/backgroundAttribution";
import { createDeadLetterRecord, logDeadLetter, type DeadLetterRecord } from "../../messaging/deadLetter";
import { resolveScreenerAgentName } from "../../agents/screenerAgentName";
import { isAnalysisDoneStageMessage, isStageBoundaryMessage } from "../../workflows/stageQueueTransport";
import { sessionStore } from "../../security/session";
import type { DoStubLike } from "../../data/durableKv";
import { isPlatformServiceProvisioned } from "../../security/serviceDispatch";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { consumeCfBatch, dispatchSubscriberBatch } from "../../messaging/cfQueueMessagingAdapter";
import { createMessagingPorts } from "../../messaging/createMessagingPorts";
import { createJobPipelineEventsHandler } from "../../messaging/jobPipelineEventsConsumer";
import type { JobStageEventRecord } from "../../data/jobStageEventPorts";
import { createScreenerEventsWorkHandler } from "../../messaging/screenerEventsConsumer";
import { createDeadLetterStoreAdapter, ensureDeadLetterStoreSchema } from "../../data/createDeadLetterStorePorts";
import { resolveDlqDepthAlertThreshold } from "../../config/dlqDepthAlert";
import { resolveHeartbeatWatchdogConfig } from "../../config/heartbeatWatchdog";
import { persistDeadLetterLanding } from "../../messaging/deadLetterPersist";
import { postSlackText, resourceSlackPost } from "../../agents/resourceGoals";
import type { SlackDeliveryEnv } from "../../agents/social/delivery";
import { isMessageEnvelope, type MessageEnvelope, type SubscriberHandlers } from "../../messaging/messagingPorts";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { writeEnvelopeToSink } from "../../observability/observabilityPorts";
import {
  resolveCronEntryPoint,
  runCronEntryPoint,
  type CronDispatchRecordInput,
  type CronEntryPointDeps,
} from "../../services/consolidatedCronEntries";
import { createScreenerQueueHandler } from "../../messaging/screenerQueueConsumer";
import { renewAllStoredETradeTokens } from "../../services/etradeOAuth";
import { ensureBreakerDurability } from "./core";

// Issue #1739 — per-subscriber dedup for screener-event delivery
// batches. Module-level so it survives across batches in one
// isolate; cross-isolate redelivery is possible under at-least-once
// delivery (see the messaging port docstring), and downstream
// scheduled deliveries already dedup on their own stable delivery id.
const screenerDeliverySeen = new Set<string>();

// Issue #2544 (Cloudflare migration step 1) — per-envelope dedup
// for screener-events work batches, same isolate-scoped shape as
// the delivery seen set above: the QueuePort consumer core marks
// processed/drop envelope ids seen, so an at-least-once redelivery
// never re-invokes the work handler.
const screenerEventsSeen = new Set<string>();
/** Issue #4425 — the job-pipeline-events consumer's dedup set (per isolate). */
const jobPipelineEventsSeen = new Set<string>();

/**
 * Issue #4425 — the stage actions that END a stage. A `started` (or any
 * non-terminal) publication is the live stream, never a completion.
 */
const TERMINAL_STAGE_ACTIONS = new Set(["completed", "failed", "timed_out", "cancelled"]);

/**
 * Issue #4425 — the completion state a terminal stage action names to a
 * binding. A timeout IS a failure for a chained schedule; naming it
 * "timed_out" would match no binding and silently strand the chain.
 */
function stageActionState(action: string): string {
  return action === "timed_out" ? "failed" : action;
}

/**
 * Issue #4425 — the ScheduledAgent RPCs the job-pipeline-events consumer
 * needs: the completion record (the claim-check hand-off downstream stages
 * read), the stage-event store (#4360), and the completion-trigger firing
 * (#4425). Declared once here, beside the queue that calls it, like the cron
 * entry point's own door above.
 */
interface JobPipelineEventsDoor {
  recordPipelineCompletion(note: {
    jobId: string;
    runId: string;
    state: string;
    artifactKeys: string[];
    at: string;
  }): Promise<void>;
  recordStageEvent(event: JobStageEventRecord): Promise<boolean>;
  fireCompletionSchedules(event: {
    jobId: string;
    runId?: string | null;
    state: string;
    stage?: string | null;
  }): Promise<{
    fired: string[];
    skipped: Array<{ jobId: string; reason: string }>;
    invalid: Array<{ jobId: string; reason: string }>;
  }>;
}

/**
 * Issue #2544 — the single options_analysis queue dispatch, shared
 * by the revived screener-events consumer and the legacy fallthrough
 * below. Identity rules (#1185/#1066, #2331 slice 2): queue work
 * runs under the message payload's stored owner when it carries
 * one, else the explicit service identity. With neither, this
 * THROWS (the caller retries) rather than dispatching under a
 * fabricated identity. A service dispatch additionally requires a
 * live platform-tier member binding, and the shared-orchestrator
 * address is never an identity. Denied messages return "denied"
 * (the caller acks/drops them, never retries: a re-dispatch
 * would deny again, and options analysis is time-sensitive).
 *
 * @param awaitDispatch — true routes the trigger fetch through
 * await (a fetch failure throws → the QueuePort core retries
 * into the DLQ); false preserves the legacy fallthrough shape
 * (waitUntil when available, else await).
 */
async function dispatchOptionsAnalysisQueueWork(opts: {
  env: Env;
  ctx?: any;
  agent: { fetch: (request: Request) => Promise<unknown> };
  payload: Record<string, unknown> | null | undefined;
  serviceUserLogin: string | null;
  getServiceProvisioned: () => Promise<boolean>;
  awaitDispatch: boolean;
  runId?: string;
  unitId?: string;
}): Promise<"dispatched" | "denied"> {
  // Issue #3515 S3 batch 6, #5587 — env-wired logger: the sink is built
  // from opts.env so the event reaches the Analytics Engine
  // `observability` dataset; a module-level logger built with an empty
  // env is console-only (the binding is construction-time).
  const structuredLog = createStructuredLogger(createObservabilitySink(opts.env), {
    component: "server/routes/queue",
  });
  // Matches the pre-#2544 fallthrough exactly: a falsy payload
  // dispatches as an empty object, never as a falsy body.
  const payload = opts.payload || {};
  const payloadOwner = isLoginShaped(
    (payload as { userLogin?: unknown }).userLogin
  )
    ? (payload as { userLogin: string }).userLogin
    : null;
  const userLogin = payloadOwner ?? opts.serviceUserLogin;
  if (!userLogin) {
    throw new Error(
      "options_analysis queue message has no payload owner and SERVICE_USER_LOGIN is not configured — refusing to dispatch under a fabricated identity (#1185)."
    );
  }
  let denied: string | null = null;
  if (isSharedOrchestratorAddress(userLogin)) {
    denied = "the payload names the shared-orchestrator address as its owner";
  } else if (userLogin === opts.serviceUserLogin) {
    if (!(await opts.getServiceProvisioned())) {
      denied = "the service user is not provisioned for the platform tier";
    }
  }
  if (denied) {
    const scope =
      opts.runId !== undefined
        ? ` (run ${opts.runId}, unit ${opts.unitId ?? opts.runId})`
        : "";
    structuredLog.warn("queue.options_analysis_dispatch_denied", {
      message: `[Queue Handler] Dropping options_analysis queue message${scope}: ${denied} — dispatching it would run unattended work without a verified identity (#2331 slice 2).`,
    });
    return "denied";
  }
  const queuePromise = opts.agent.fetch(
    new Request("https://agent.internal/schedules/trigger-options-analysis", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Issue #1764 — background attribution: the unattended
        // dispatch carries x-actor-kind: background alongside
        // x-user-login, so downstream audit no longer has to know
        // the service login value to tell background from user work.
        ...backgroundDispatchHeaders(userLogin),
      },
      body: JSON.stringify(payload),
    })
  );
  if (!opts.awaitDispatch && opts.ctx?.waitUntil) opts.ctx.waitUntil(queuePromise);
  else await queuePromise;
  return "dispatched";
}

/**
 * Issue #3121 S5 — adapt the entry points' variadic log args to the
 * structured logger (#3515 S2 seam): the first arg is the message,
 * the rest serialize as detail. The production log adapters below go
 * through this logger so the slice adds zero NEW unstructured
 * `console.*` uses to this file (ratchet #3515 S3: batch 6 migrated this file to zero).
 */
function formatCronLogArgs(args: readonly unknown[]): Record<string, unknown> {
  const [first, ...rest] = args;
  const fields: Record<string, unknown> = {
    message: typeof first === "string" ? first : String(first),
  };
  if (rest.length > 0) {
    fields.detail = rest
      .map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg) ?? String(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  }
  return fields;
}

/**
 * Slice 8 of Qunsultant/cfagent#2902 (Queue / scheduled) — moves only.
 * The default export's `scheduled` handler, now a thin dispatch
 * (issue Qunsultant/cfagent#3121 Slice S5): the gate evaluation and
 * the shared Orchestrator stub stay here, exactly as before, and
 * the three cron branches moved — verbatim — into the named entry
 * points in `src/services/consolidatedCronEntries.ts` (`tick`,
 * `renewTokens`, `retention`). `event.cron` resolves through
 * `resolveCronEntryPoint`; an unmatched cron logs and returns, with
 * no ledger row and no dispatch. The entry points record one ledger
 * row per dispatch through the background-gated record route.
 * Service identity (SERVICE_USER_LOGIN) + platform-tier provisioning
 * gate (#1185, #2331) — fail closed, never a fabricated identity.
 */
export async function handleScheduledEvent(event: any, env: Env, ctx?: any): Promise<void> {
    // Phase 5 Slice 2 (#2000) — durable breaker production path (see ensureBreakerDurability).
    ensureBreakerDurability(env);
    // #1185 / #1066 — unattended work runs under the explicit service
    // identity (SERVICE_USER_LOGIN), never a hardcoded synthetic login.
    // The shared Orchestrator instance is addressed by its established
    // address (an address, not an identity). When no service identity is
    // configured, the identity-bearing dispatches below are skipped and
    // logged — failing closed instead of fabricating an identity. The
    // 03:00 UTC token-renewal pass asserts no identity (it enumerates
    // every stored token) and runs either way.
    // #2331 slice 2: configuration alone is not enough — the tick and
    // the identity-bearing dispatches below run only while the service
    // user holds a live platform-tier member binding. Worker-level
    // denials are logged here (no funnel is available in the Worker
    // entry); in-agent denials are funnel-audited. LOUD CONSEQUENCE:
    // after this deploys, scheduled goals pause until a platform admin
    // provisions the platform tier via POST
    // /api/admin/service-user/provision (nothing is provisioned today).
    // That is the fail-closed intent, not a surprise outage.
    // The gate is evaluated EAGERLY for every scheduled() invocation,
    // including renewal — the renewal entry point ignores it by
    // design, but the evaluation itself stays here, before any
    // dispatch, exactly as before.
    const userLogin = getServiceUserLogin(env);
    const serviceProvisioned = userLogin
      ? await isPlatformServiceProvisioned(
          createKvMembershipStore(sessionStore(env)),
          userLogin,
          Date.now(),
        )
      : false;
    const agent = actorGateway.stub<DoStubLike>(env.ORCHESTRATOR_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
    // Issue #3121 S5 — the structured logger for this dispatcher's
    // own logs (unknown cron, record failures) and for the entry
    // points' logError/logInfo adapters below (#3515 S2 seam; the
    // sink is the same observability sink the tick observer uses).
    // Construction is pure (no I/O); a failing sink degrades to
    // local logging and never throws to the caller.
    const structuredLog = createStructuredLogger(
      createObservabilitySink(env),
      { component: "server/routes/queue", actorId: userLogin ?? null },
    );

    const entryPoint = resolveCronEntryPoint(event?.cron);
    if (!entryPoint) {
      structuredLog.info("scheduled.unknown-cron", {
        cron: String(event?.cron),
        message: "no entry point; ignoring (no dispatch, no ledger row)",
      });
      return;
    }
    // Issue #3121 S5 — the ledger-row poster. Production wiring for
    // the entry points' `recordDispatch` dep: POST the record route
    // via the shared Orchestrator stub, under the background headers.
    // NEVER throws — a record failure is logged and resolved, so it
    // can never fail the dispatch it records. When no service user
    // is configured the route answers 401 (nothing is background
    // without one); that is expected for the renewal row in that
    // state — the row is best-effort until the service user is
    // configured, and lands normally once it is.
    const recordDispatch = async (
      input: CronDispatchRecordInput,
    ): Promise<void> => {
      try {
        const response = (await agent.fetch(
          new Request("https://agent.internal/schedules/record-cron-dispatch", {
            method: "POST",
            headers: backgroundDispatchHeaders(userLogin ?? ""),
            body: JSON.stringify(input),
          }),
        )) as unknown as { status?: unknown };
        if (
          !response ||
          typeof response.status !== "number" ||
          response.status >= 400
        ) {
          structuredLog.error("scheduled.cron-dispatch-record-failed", {
            entryPoint: input.entryPoint,
            status:
              typeof response?.status === "number"
                ? response.status
                : "unknown",
            message: "the dispatch stands, the row is missing",
          });
        }
      } catch (err) {
        structuredLog.error("scheduled.cron-dispatch-record-failed", {
          entryPoint: input.entryPoint,
          error: err instanceof Error ? err.message : String(err),
          message:
            "record fetch failed; the dispatch stands, the row is missing",
        });
      }
    };
    const deps: CronEntryPointDeps = {
      cron: event.cron,
      entryPoint,
      serviceUserLogin: userLogin,
      serviceProvisioned,
      heartbeatWatchdog: resolveHeartbeatWatchdogConfig(
        env as unknown as Record<string, unknown>,
      ),
      orchestrator: agent,
      scheduledAgent: actorGateway.stub<{
        onCron(): Promise<unknown>;
        /** Issue #6503 step 12 — the outer observation's run-history read (ScheduledAgent.listJobRuns). */
        listJobRuns(
          jobId?: string,
          limit?: number,
        ): Promise<
          Array<{ jobId: string; operation: string; started: string }>
        >;
      }>(env.SCHEDULED_AGENT, "default"),
      // The renewal call lives in the entry point; this only binds
      // the environment (the S5-P08 thinness pin keeps the call
      // itself out of this dispatcher).
      renewTokens: renewAllStoredETradeTokens.bind(null, env),
      createSink: () => createObservabilitySink(env),
      slackPoster: async (text: string) => {
        await postSlackText({
          post: resourceSlackPost,
          env: env as unknown as SlackDeliveryEnv,
          text,
        });
      },
      dispatchAndAwait: async (promise: Promise<unknown>) => {
        if (ctx?.waitUntil) ctx.waitUntil(promise);
        else await promise;
      },
      recordDispatch,
      now: () => new Date(),
      logError: (...args: unknown[]) => {
        structuredLog.error(
          "scheduled.cron-entry-point-error",
          formatCronLogArgs(args),
        );
      },
      logInfo: (...args: unknown[]) => {
        structuredLog.info(
          "scheduled.cron-entry-point-info",
          formatCronLogArgs(args),
        );
      },
    };
    await runCronEntryPoint(entryPoint, deps);
}

/**
 * Slice 8 of Qunsultant/cfagent#2902 (Queue / scheduled) — moves only.
 * The default export's `queue` handler, verbatim: the shared
 * dead-letter persistence closure, the screener-events-delivery
 * branch (per-subscriber dedup + observability tap), the
 * screener-events branch (analysis-done / stage-boundary executors,
 * CloudEvents envelopes via the QueuePort consumer, legacy
 * options_analysis wrapper, undecodable drop), and the
 * options_analysis fallthrough.
 */
export async function handleQueueBatch(batch: any, env: Env, ctx?: any): Promise<void> {
    // Issue #3515 S3 batch 6, #5587 — env-wired logger: the sink is built
    // from the request's env so events reach the Analytics Engine
    // `observability` dataset; a module-level logger built with an empty
    // env is console-only (the binding is construction-time).
    const structuredLog = createStructuredLogger(createObservabilitySink(env), {
      component: "server/routes/queue",
    });
    // Phase 5 Slice 2 (#2000) — durable breaker production path (see ensureBreakerDurability).
    ensureBreakerDurability(env);
    // Issue #1739 — durable screener-event delivery. The delivery
    // subscriber queue is dispatched through the broadcast core with
    // per-subscriber dedup; screener-events batches take the step-1
    // branch below, and every other batch falls through to the
    // existing path untouched (options_analysis + ack-all behavior
    // preserved).
    // Phase 5 Slice 1 (issue #2000) — dead-letter persistence
    // closure, shared by all three queue branches below. The
    // console dead-letter record is always emitted first by the
    // caller; this closure only adds the store row + depth
    // check. It never throws by construction (schema-ensure
    // failures return early, the persist helper catches the
    // rest), so awaiting it can never change an ack/retry
    // disposition. Unbound AGENT_DB yields undefined: drops
    // stay console-only, exactly today's behavior.
    const dlqStore = createDeadLetterStoreAdapter(env);
    const persistDeadLetter = dlqStore
      ? async (record: DeadLetterRecord, envelope: MessageEnvelope | null): Promise<void> => {
          try {
            await ensureDeadLetterStoreSchema(dlqStore.db);
          } catch (err) {
            structuredLog.warn("queue.dead_letter_schema_ensure_failed", { message: "[dead-letter] schema ensure failed (console record stands):", error: err instanceof Error ? err.message : String(err) });
            return;
          }
          await persistDeadLetterLanding(
            {
              store: dlqStore,
              threshold: resolveDlqDepthAlertThreshold(env as unknown as Record<string, unknown>),
              sendAlert: async (text) => {
                // Env carries the Slack delivery vars postSlackText
                // reads; the cast bridges the index-signature gap
                // between the Env interface and SlackDeliveryEnv.
                await postSlackText({ post: resourceSlackPost, env: env as unknown as SlackDeliveryEnv, text });
              },
            },
            record,
            envelope,
          );
        }
      : undefined;
    // Issue #4425 — the job-pipeline-events consumer. It was defined at
    // #3543 and never instantiated (the RCA's Gap 1), so a terminal job
    // event reached no host and no chained schedule could exist. This is
    // its first wiring: the completion is recorded on the ScheduledAgent
    // (the claim-check hand-off downstream stages read) and then matched
    // against every target job's `completionTrigger`; a stage terminal
    // event is persisted (#4360) and matched the same way, so a
    // stage-scoped binding fires from the stage it names.
    if (batch?.queue === "job-pipeline-events") {
      const ports = createMessagingPorts(env, { seenIds: jobPipelineEventsSeen });
      if (!ports) {
        // No messaging ports (no binding): the worker cannot claim QueuePort
        // routing, so the batch is retried into the DLQ path visibly rather
        // than acked into silence — the same rule as screener-events.
        structuredLog.warn("queue.job_pipeline_events_no_messaging_ports", { message: "[job-pipeline-events] no messaging ports — retrying envelopes into the DLQ path." });
        for (const msg of batch.messages ?? []) {
          if (typeof msg.retry === "function") msg.retry();
        }
        return;
      }
      const door = actorGateway.stub<JobPipelineEventsDoor>(env.SCHEDULED_AGENT, "default");
      const pipelineLog = createStructuredLogger(createObservabilitySink(env), {
        component: "server/routes/queue",
      });
      const logFiring = (source: string, result: {
        fired: string[];
        skipped: Array<{ jobId: string; reason: string }>;
        invalid: Array<{ jobId: string; reason: string }>;
      }): void => {
        if (result.fired.length === 0 && result.skipped.length === 0 && result.invalid.length === 0) {
          return;
        }
        pipelineLog.info("job_pipeline.completion_triggers", {
          message: `[job-pipeline] completion from ${source} fired ${result.fired.length} schedule(s); ${result.skipped.length} skipped, ${result.invalid.length} invalid binding(s).`,
          fired: result.fired,
          skipped: result.skipped,
          invalid: result.invalid,
        });
      };
      const handler = createJobPipelineEventsHandler({
        routeCompletion: async (completion) => {
          await door.recordPipelineCompletion({
            jobId: completion.jobId,
            runId: completion.runId,
            state: completion.state,
            artifactKeys: completion.artifactKeys,
            at: completion.at,
          });
          logFiring(
            `job ${completion.jobId}`,
            await door.fireCompletionSchedules({
              jobId: completion.jobId,
              runId: completion.runId,
              state: completion.state,
            }),
          );
        },
        recordStageEvent: async (event) => {
          const recorded = await door.recordStageEvent(event);
          // Only a terminal stage action can fire a stage-scoped binding; a
          // "started" publication is the live stream, not a completion.
          if (TERMINAL_STAGE_ACTIONS.has(event.action)) {
            logFiring(
              `stage ${event.jobId}/${event.stageId}`,
              await door.fireCompletionSchedules({
                jobId: event.jobId,
                runId: event.runId,
                state: stageActionState(event.action),
                stage: event.stageId,
              }),
            );
          }
          return recorded;
        },
        persistDeadLetter,
      });
      await consumeCfBatch(batch, ports.consumer, handler, persistDeadLetter);
      return;
    }
    if (batch?.queue === "screener-events-delivery") {
      const deliveryHandler = createScreenerQueueHandler({ env });
      const handlers: SubscriberHandlers = new Map([
        [
          "delivery",
          new Map([
            ["screener.completed", deliveryHandler],
            ["screener.failed", deliveryHandler],
          ]),
        ],
      ]);
      await dispatchSubscriberBatch(
        batch,
        "delivery",
        handlers,
        screenerDeliverySeen,
        persistDeadLetter
      );
      // Issue #1743 — passive observability tap: fold the same
      // delivery envelopes into the Analytics Engine stream.
      // This tap NEVER owns ack/retry (delivery above does) and
      // NEVER fails the batch — a tap failure is warned, and
      // the delivery outcome stands.
      try {
        const sink = createObservabilitySink(env);
        for (const msg of batch.messages ?? []) {
          if (isMessageEnvelope(msg.body)) {
            await writeEnvelopeToSink(sink, msg.body);
          }
        }
      } catch (tapErr) {
        structuredLog.warn("queue.observability_delivery_tap_failed", { message: "[observability] delivery tap failed (ignored):", error: tapErr instanceof Error ? tapErr.message : String(tapErr) });
      }
      return;
    }
    // Issue #2544 (Cloudflare migration step 1) — the screener-events
    // work queue finally has a consumer. Envelopes route through
    // the QueuePort consumer contract (consumeCfBatch over the
    // messaging ports, deduped on the envelope id): at-least-once
    // delivery, a handler throw becomes a retry (the platform
    // re-delivers up to max_retries, then the DLQ —
    // screener-events-dlq — with run/unit ids intact in the
    // message body), and the options_analysis work item is REVIVED
    // here (decided in #2544) via the QueuePort work handler.
    // Legacy non-envelope taskType messages take the deprecated
    // wrapper below; anything else can never decode and is acked
    // + logged, never retried (a poison-loop guard).
    if (batch?.queue === "screener-events") {
      const serviceUserLogin = getServiceUserLogin(env);
      const agent = actorGateway.stub<DoStubLike>(env.ORCHESTRATOR_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
      let serviceProvisioned: boolean | null = null;
      const getServiceProvisioned = async (): Promise<boolean> => {
        if (serviceProvisioned === null) {
          serviceProvisioned = await isPlatformServiceProvisioned(
            createKvMembershipStore(sessionStore(env)),
            serviceUserLogin,
            Date.now(),
          );
        }
        return serviceProvisioned;
      };
      const dispatchWork = (
        payload: Record<string, unknown> | null | undefined,
        awaitDispatch: boolean,
        runId?: string,
        unitId?: string
      ) =>
        dispatchOptionsAnalysisQueueWork({
          env,
          ctx,
          agent,
          payload,
          serviceUserLogin,
          getServiceProvisioned,
          awaitDispatch,
          runId,
          unitId,
        });
      // Issue #1764 — the work handler's terminal drops (no
      // handler, denied dispatch) go through its default console
      // dead-letter sink: one parseable `[dead-letter]` record
      // per drop, ack/retry semantics unchanged.
      const workHandler = createScreenerEventsWorkHandler({
        dispatchOptionsAnalysis: (payload, runId, unitId) =>
          dispatchWork(payload, true, runId, unitId),
        persistDeadLetter,
      });
      const envelopeMessages: any[] = [];
      if (batch?.messages && Array.isArray(batch.messages)) {
        for (const msg of batch.messages) {
          if (isAnalysisDoneStageMessage(msg.body)) {
            // Issue #2869 slice 1 — the analysis-done queue
            // executor. The message routes to the OWNING
            // ScreenerAgent DO (per-owner instance, so the
            // durable stage claims are the in-process leg's
            // claims: a normal-path redelivery is
            // duplicate-suppressed, never regenerated).
            // Ack on generated / duplicate-suppressed /
            // dead-lettered; retry (to max_retries, then
            // the screener-events-dlq) only when the
            // consumer throws — a missing persisted
            // analysis, which the consumer refuses to
            // fabricate. A poison body can never reach
            // here: the guard above only passes
            // well-shaped analysis-done messages.
            try {
              const stageMsg = msg.body;
              const agentId = env.SCREENER_AGENT.idFromName(
                resolveScreenerAgentName(env, stageMsg.userLogin),
              );
              const agent = env.SCREENER_AGENT.get(agentId) as unknown as {
                consumeQueuedAnalysisDone: (
                  message: unknown,
                  attempt?: number,
                ) => Promise<{ status: string; reason?: string; pdfKey?: string; pdfStatus?: string; pdfError?: string }>;
              };
              const outcome = await agent.consumeQueuedAnalysisDone(
                stageMsg,
                typeof (msg as { attempts?: unknown }).attempts === "number"
                  ? ((msg as { attempts: number }).attempts as number)
                  : 1,
              );
              // Issue #2869 slice 1 follow-up: on a queued
              // generation (in-process leg failed, claim
              // released, queued consume generated), refresh
              // the canonical row's PDF fields through the
              // one recorder — otherwise the Reports tab
              // keeps showing no PDF for a run that now has
              // one. Refresh is update-only, monotonic, and
              // owner-scoped, so a duplicate-suppressed
              // consume (no pdfKey carried) refreshes
              // nothing, and a refresh failure never fails
              // the queue ack: the generated PDF is already
              // durable on the persisted analysis key.
              // Addressing, stated plainly: the recorder
              // instance that wrote the row is the REST
              // path's per-user orchestrator instance for
              // manual runs, and the shared orchestrator
              // instance for workflow runs — so the
              // handler tries the per-user instance first
              // and the shared instance when that reports
              // no row. Both attempts are update-only and
              // owner-scoped, so a miss refreshes nothing.
              if (outcome.status === "generated" && outcome.pdfKey) {
                try {
                  const refreshInput = {
                    generationId: stageMsg.runId,
                    userLogin: stageMsg.userLogin,
                    pdfKey: outcome.pdfKey,
                    ...(outcome.pdfStatus ? { pdfStatus: outcome.pdfStatus } : {}),
                    ...(outcome.pdfError ? { pdfError: outcome.pdfError } : {}),
                  };
                  type RefreshOrchestrator = {
                    refreshCanonicalPdfFields: (
                      input: typeof refreshInput,
                    ) => Promise<{ status: string; reportId?: string }>;
                  };
                  const perUser = actorGateway.stub<RefreshOrchestrator>(
                    env.ORCHESTRATOR_AGENT,
                    stageMsg.userLogin,
                  );
                  const first = await perUser.refreshCanonicalPdfFields(refreshInput);
                  if (first.status === "missing-row") {
                    const shared = actorGateway.stub<RefreshOrchestrator>(
                      env.ORCHESTRATOR_AGENT,
                      SHARED_ORCHESTRATOR_INSTANCE,
                    );
                    const second = await shared.refreshCanonicalPdfFields(refreshInput);
                    if (second.status !== "refreshed" && second.status !== "noop") {
                      structuredLog.warn("queue.canonical_pdf_refresh_unresolved", { message: `[Queue Handler] canonical PDF refresh unresolved: per-user ${first.status}, shared ${second.status} (run ${stageMsg.runId}).`, runId: stageMsg.runId });
                    }
                  } else if (first.status !== "refreshed" && first.status !== "noop") {
                    structuredLog.warn("queue.canonical_pdf_refresh_status", { message: `[Queue Handler] canonical PDF refresh ${first.status} (run ${stageMsg.runId}).`, runId: stageMsg.runId, status: first.status });
                  }
                } catch (refreshErr) {
                  structuredLog.warn("queue.canonical_pdf_refresh_failed", { message: `[Queue Handler] canonical PDF refresh failed (run ${stageMsg.runId}); generated PDF remains on the persisted analysis key:`, runId: stageMsg.runId, error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr) });
                }
              }
              if (typeof msg.ack === "function") msg.ack();
              if (outcome.status === "dead-lettered") {
                structuredLog.warn("queue.analysis_done_stage_message_dead_lettered", { message: "[Queue Handler] analysis-done stage message dead-lettered:", reason: outcome.reason ?? "unknown" });
              }
            } catch (queueErr) {
              structuredLog.warn("queue.analysis_done_stage_message_consume_failed", { message: "[Queue Handler] Failed to consume analysis-done stage message; retrying:", error: queueErr instanceof Error ? queueErr.message : String(queueErr) });
              if (typeof msg.retry === "function") msg.retry();
            }
          } else if (isStageBoundaryMessage(msg.body)) {
            // Issue #2869 slice 2 — the stage-boundary queue
            // executor. The message routes to the OWNING
            // ScreenerAgent DO (per-owner instance, so the
            // durable stage claims are the in-process leg's
            // claims): the recorder claims the idempotencyKey
            // and verifies the boundary artifact exists, then
            // acks on recorded / duplicate-suppressed /
            // dead-lettered; it throws (retry to max_retries,
            // then the screener-events-dlq) only on a missing
            // persisted artifact, which the recorder refuses
            // to fabricate. Without this branch these messages
            // would fall through to the undecodable drop below.
            try {
              const stageMsg = msg.body;
              const agentId = env.SCREENER_AGENT.idFromName(
                resolveScreenerAgentName(env, stageMsg.userLogin),
              );
              const agent = env.SCREENER_AGENT.get(agentId) as unknown as {
                recordQueuedStageBoundary: (
                  message: unknown,
                  attempt?: number,
                ) => Promise<{ status: string; reason?: string }>;
              };
              const outcome = await agent.recordQueuedStageBoundary(
                stageMsg,
                typeof (msg as { attempts?: unknown }).attempts === "number"
                  ? ((msg as { attempts: number }).attempts as number)
                  : 1,
              );
              if (typeof msg.ack === "function") msg.ack();
              if (outcome.status === "dead-lettered") {
                structuredLog.warn("queue.stage_boundary_message_dead_lettered", { message: "[Queue Handler] stage-boundary message dead-lettered:", reason: outcome.reason ?? "unknown" });
              }
            } catch (queueErr) {
              structuredLog.warn("queue.stage_boundary_message_record_failed", { message: "[Queue Handler] Failed to record stage-boundary message; retrying:", error: queueErr instanceof Error ? queueErr.message : String(queueErr) });
              if (typeof msg.retry === "function") msg.retry();
            }
          } else if (isMessageEnvelope(msg.body)) {
            envelopeMessages.push(msg);
          } else if (msg.body?.taskType === "options_analysis") {
            // @deprecated Legacy taskType queue shape — superseded by CloudEvents envelope work items routed through the QueuePort screener-events consumer (src/messaging/screenerEventsConsumer.ts). Kept as a thin wrapper; do not add new producers.
            try {
              const legacyOutcome = await dispatchWork(msg.body?.payload, false);
              if (legacyOutcome === "denied") {
                // Issue #1764 — a denied legacy message is dropped
                // (acked below), now with a structured dead-letter
                // record instead of only the dispatch warning.
                const legacyDeniedRecord = createDeadLetterRecord({
                  queue: batch.queue,
                  reason: "denied",
                  detail:
                    "Legacy options_analysis dispatch denied by the identity rules — dropping; a re-dispatch would deny again (#1764).",
                });
                logDeadLetter(legacyDeniedRecord);
                // Slice 1 (#2000): persist the drop (no envelope;
                // a denied dispatch is never replayable).
                await persistDeadLetter?.(legacyDeniedRecord, null);
              }
              if (typeof msg.ack === "function") msg.ack();
            } catch (queueErr) {
              structuredLog.warn("queue.queue_message_process_failed", { message: "[Queue Handler] Failed to process queue message:", error: queueErr instanceof Error ? queueErr.message : String(queueErr) });
              if (typeof msg.retry === "function") msg.retry();
            }
          } else {
            // Issue #1764 — acked as before (undecodable bytes can
            // never decode), now with a structured dead-letter record.
            const undecodableRecord = createDeadLetterRecord({
              queue: batch.queue,
              reason: "undecodable",
              detail:
                "Dropping undecodable screener-events queue message (no valid envelope, no legacy taskType) (#1764).",
            });
            logDeadLetter(undecodableRecord);
            // Slice 1 (#2000): persist the drop (no envelope).
            await persistDeadLetter?.(undecodableRecord, null);
            if (typeof msg.ack === "function") msg.ack();
          }
        }
      }
      if (envelopeMessages.length > 0) {
        const ports = createMessagingPorts(env, {
          seenIds: screenerEventsSeen,
        });
        if (ports) {
          await consumeCfBatch(
            { queue: batch.queue, messages: envelopeMessages },
            ports.consumer,
            workHandler,
            persistDeadLetter
          );
        } else {
          // No messaging ports (no SCREENER_EVENTS binding): the
          // worker cannot honestly claim QueuePort routing, so the
          // envelopes are retried into the DLQ path visibly rather
          // than acked into silence.
          structuredLog.warn("queue.screener_events_no_messaging_ports", { message: "[messaging] screener-events batch has no messaging ports — retrying envelopes into the DLQ path." });
          for (const msg of envelopeMessages) {
            if (typeof msg.retry === "function") msg.retry();
          }
        }
      }
      return;
    }
    // #1185 / #1066 — queue work runs under the message payload's stored
    // owner when it carries one, else the explicit service identity. With
    // neither, the message is retried (the existing catch path) rather
    // than dispatched under a fabricated identity.
    // #2331 slice 2: a service dispatch additionally requires a live
    // platform-tier member binding, and the shared-orchestrator address
    // is never an identity. Denied messages are logged and acked
    // (dropped, not retried: a re-dispatch would deny again, and
    // options analysis is time-sensitive).
    const serviceUserLogin = getServiceUserLogin(env);
    const agent = actorGateway.stub<DoStubLike>(env.ORCHESTRATOR_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
    let serviceProvisioned: boolean | null = null;

    if (batch?.messages && Array.isArray(batch.messages)) {
      for (const msg of batch.messages) {
        try {
          const body = msg.body;
          if (body?.taskType === "options_analysis") {
            // @deprecated Legacy taskType queue shape — superseded by CloudEvents envelope work items routed through the QueuePort screener-events consumer (src/messaging/screenerEventsConsumer.ts). Kept as a thin wrapper; do not add new producers.
            const fallthroughOutcome = await dispatchOptionsAnalysisQueueWork({
              env,
              ctx,
              agent,
              payload: body?.payload,
              serviceUserLogin,
              getServiceProvisioned: async () => {
                if (serviceProvisioned === null) {
                  serviceProvisioned = await isPlatformServiceProvisioned(
                    createKvMembershipStore(sessionStore(env)),
                    serviceUserLogin,
                    Date.now(),
                  );
                }
                return serviceProvisioned;
              },
              awaitDispatch: false,
            });
            if (fallthroughOutcome === "denied") {
              // Issue #1764 — dropped (acked below) with a
              // structured dead-letter record, as in the
              // screener-events legacy branch above.
              const fallthroughDeniedRecord = createDeadLetterRecord({
                queue: batch.queue,
                reason: "denied",
                detail:
                  "Legacy options_analysis dispatch denied by the identity rules — dropping; a re-dispatch would deny again (#1764).",
              });
              logDeadLetter(fallthroughDeniedRecord);
              // Slice 1 (#2000): persist the drop (no envelope).
              await persistDeadLetter?.(fallthroughDeniedRecord, null);
            }
          }
          if (typeof msg.ack === "function") msg.ack();
        } catch (queueErr) {
          structuredLog.warn("queue.queue_message_process_failed", { message: "[Queue Handler] Failed to process queue message:", error: queueErr instanceof Error ? queueErr.message : String(queueErr) });
          if (typeof msg.retry === "function") msg.retry();
        }
      }
    }
}
