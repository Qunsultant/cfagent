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
import { backgroundDispatchHeaders, backgroundDispatchHeadersWithTrace } from "../../security/backgroundAttribution";
import { createDeadLetterRecord, logDeadLetter, type DeadLetterRecord } from "../../messaging/deadLetter";
import { resolveScreenerAgentName } from "../../agents/screenerAgentName";
import { isAnalysisDoneStageMessage, isStageBoundaryMessage } from "../../workflows/stageQueueTransport";
import { sessionStore } from "../../security/session";
import type { DoStubLike } from "../../data/durableKv";
import { isPlatformServiceProvisioned } from "../../security/serviceDispatch";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { consumeCfBatch, dispatchSubscriberBatch } from "../../messaging/cfQueueMessagingAdapter";
import { createMessagingPorts } from "../../messaging/createMessagingPorts";
import { createScreenerEventsWorkHandler } from "../../messaging/screenerEventsConsumer";
import { createDeadLetterStoreAdapter, ensureDeadLetterStoreSchema } from "../../data/createDeadLetterStorePorts";
import { resolveDlqDepthAlertThreshold } from "../../config/dlqDepthAlert";
import { persistDeadLetterLanding } from "../../messaging/deadLetterPersist";
import { postSlackText, resourceSlackPost } from "../../agents/resourceGoals";
import type { SlackDeliveryEnv } from "../../agents/social/delivery";
import { isMessageEnvelope, type MessageEnvelope, type SubscriberHandlers } from "../../messaging/messagingPorts";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { writeEnvelopeToSink, childSpan, formatTraceparent, newTraceContext } from "../../observability/observabilityPorts";
import { observeInternalDispatch } from "../../observability/scheduledJobOutcomes";
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
    console.warn(
      `[Queue Handler] Dropping options_analysis queue message${scope}: ${denied} — dispatching it would run unattended work without a verified identity (#2331 slice 2).`
    );
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
 * Slice 8 of Qunsultant/cfagent#2902 (Queue / scheduled) — moves only.
 * The default export's `scheduled` handler, verbatim: the every-30-minutes
 * tick (ScheduledAgent onCron + research / reflection / adaptation /
 * corpus-sync / digest dispatches under one trace), the 03:00 UTC
 * E*TRADE token-renewal pass, and the 04:00 UTC retention pass.
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
    const userLogin = getServiceUserLogin(env);
    const serviceProvisioned = userLogin
      ? await isPlatformServiceProvisioned(
          createKvMembershipStore(sessionStore(env)),
          userLogin,
          Date.now(),
        )
      : false;
    const agent = actorGateway.stub<DoStubLike>(env.SEARCH_AGENT, SHARED_ORCHESTRATOR_INSTANCE);

    // PR #4 — ScheduledAgent tick: evaluate due goals, budget-check,
    // create Orchestrator jobs (issue #166).
    if (event?.cron === "*/30 * * * *") {
      if (!userLogin || !serviceProvisioned) {
        console.error(
          "[scheduled] Service user is not provisioned for the platform tier — skipping the ScheduledAgent tick and the research/reflection/adaptation dispatches rather than running unattended work without a verified identity (#2331 slice 2). Provision the platform tier via POST /api/admin/service-user/provision to resume scheduled goals."
        );
        return;
      }
      const schedAgent = actorGateway.stub<{
        onCron(): Promise<unknown>;
      }>(env.SCHEDULED_AGENT, "default");
      const tickPromise = schedAgent.onCron();
      if (ctx?.waitUntil) ctx.waitUntil(tickPromise);
      else await tickPromise;
      // Issue Qunsultant/cfagent#2037 — one trace per tick. Every
      // dispatch below carries a child span of this trace, so a
      // DO-side AE event, a mas_events outcome row, and a Slack
      // alert all correlate to the tick that sent them. The
      // traceparent rides every tick dispatch (corpus/digest
      // included — their routes ignore it today, at no cost);
      // only the three named jobs get the failure observer, per
      // the issue's scope. The observer never rejects, so
      // waitUntil/await below keep today's fire-and-forget shape.
      const tickTrace = newTraceContext();
      const observeTickDispatch = (
        job: "research" | "reflection" | "adaptation",
        promise: Promise<unknown>,
      ): Promise<void> =>
        observeInternalDispatch(promise, {
          job,
          sink: createObservabilitySink(env),
          trace: tickTrace,
          recordFailure: async (input) => {
            const recorded = (await agent.fetch(
              new Request("https://agent.internal/scheduled-job-outcome", {
                method: "POST",
                headers: backgroundDispatchHeadersWithTrace(
                  userLogin,
                  formatTraceparent(childSpan(tickTrace)),
                ),
                body: JSON.stringify(input),
              }),
            )) as unknown as { status?: unknown };
            if (
              !recorded ||
              typeof recorded.status !== "number" ||
              recorded.status >= 400
            ) {
              throw new Error("scheduled-job-outcome record failed");
            }
          },
          alertUnreachable: async (failedJob, trace) => {
            await postSlackText({
              post: resourceSlackPost,
              env: env as unknown as SlackDeliveryEnv,
              text:
                `Scheduled job ${failedJob} dispatch failed AND its outcome ` +
                `record is unreachable (trace ${trace.traceId}). The DO did ` +
                `not record this failure — investigate the dispatch layer; ` +
                `see Cloudflare logs for the tick.`,
            });
          },
        });
      // Issue #354 — the daily options-research run (after market close)
      // rides this tick: the dedicated 0 21 * * 1-5 trigger cannot exist
      // (Workers Free ceiling of 5 cron triggers/account, error 10072; it
      // was never in wrangler.jsonc, so the old branch below was dead code).
      // Fire/no-fire is decided inside the tick route (weekday, >= 21:00
      // UTC, not already fired today — durable guard in mas_settings), so
      // this dispatch is unconditional; skips are cheap and explicit.
      const researchPromise = observeTickDispatch(
        "research",
        agent.fetch(
          new Request("https://agent.internal/research/scheduled-tick", {
            method: "POST",
            headers: backgroundDispatchHeadersWithTrace(
              userLogin,
              formatTraceparent(childSpan(tickTrace)),
            ),
          }),
        ),
      );
      if (ctx?.waitUntil) ctx.waitUntil(researchPromise);
      else await researchPromise;
      // Issue #705 — the weekly reflection job rides this tick (same
      // Workers Free ceiling constraint as #354). Fire/no-fire is decided
      // inside the route (Sunday, not already fired this week — durable
      // guard in mas_settings), so this dispatch is unconditional.
      const reflectionPromise = observeTickDispatch(
        "reflection",
        agent.fetch(
          new Request("https://agent.internal/reflection/run", {
            method: "POST",
            headers: backgroundDispatchHeadersWithTrace(
              userLogin,
              formatTraceparent(childSpan(tickTrace)),
            ),
          }),
        ),
      );
      if (ctx?.waitUntil) ctx.waitUntil(reflectionPromise);
      else await reflectionPromise;
      // Issue #754 — the weekly strategy-weight adjustment rides this
      // tick (same Workers Free ceiling constraint as #354/#705).
      // Fire/no-fire is decided inside the job (ISO-week guard +
      // adaptation kill switch in mas_settings), so this dispatch is
      // unconditional; skips are cheap and explicit in the job result.
      const weightsPromise = observeTickDispatch(
        "adaptation",
        agent.fetch(
          new Request("https://agent.internal/adaptation/weights/run", {
            method: "POST",
            headers: backgroundDispatchHeadersWithTrace(
              userLogin,
              formatTraceparent(childSpan(tickTrace)),
            ),
          }),
        ),
      );
      if (ctx?.waitUntil) ctx.waitUntil(weightsPromise);
      else await weightsPromise;
      // Issue #1169 (S4-4) — the weekly corpus sync rides this tick
      // (same Workers Free ceiling constraint as #354/#705/#754).
      // Fire/no-fire is decided inside the route (weekly guard +
      // durable marker in mas_settings), so this dispatch is
      // unconditional; skips are cheap and explicit in the route
      // result.
      const corpusSyncPromise = agent.fetch(
        new Request("https://agent.internal/knowledge/corpus-sync", {
          method: "POST",
          headers: backgroundDispatchHeadersWithTrace(
            userLogin,
            formatTraceparent(childSpan(tickTrace)),
          ),
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(corpusSyncPromise);
      else await corpusSyncPromise;
      // Issue #2659 (monetization Phase 2.4) — the scheduled
      // digest pass rides this tick (same Workers Free ceiling
      // constraint as #354/#705/#754/#1169: no new cron trigger).
      // Fire/no-fire is decided inside the route (once per UTC
      // day — durable marker in agent_digest_pass_days), so this
      // dispatch is unconditional; the route returns fired:false
      // on later ticks the same day, and the tick supplies no
      // itemsByUser, so scheduled sends use the digest content
      // provider (#2981: tenant projection highlights); a
      // subscriber with no windowed reports honestly skips.
      // Dispatches as the service user
      // (backgroundDispatchHeaders), which is the only identity
      // the run-due route accepts.
      const digestPassPromise = agent.fetch(
        new Request("https://agent.internal/payments/agentic/commercial/lifecycle/digest/run-due", {
          method: "POST",
          headers: backgroundDispatchHeadersWithTrace(
            userLogin,
            formatTraceparent(childSpan(tickTrace)),
          ),
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(digestPassPromise);
      else await digestPassPromise;
      // Issue #1077 Phase 5b slice 1: the parallel social tick is gone.
      // Social posting is now a ScheduledAgent goal ("daily-social-post",
      // disabled by default) evaluated by the onCron call at the top of
      // this branch — no second scheduler, no second fire check.
      return;
    }
    // Renew all account-scoped Durable Object tokens before midnight ET.
    if (event?.cron === "0 3 * * *") {
      const renewPromise = renewAllStoredETradeTokens(env).then((counts) => {
        console.info("[scheduled] E*TRADE account-token renewal completed", counts);
      });
      if (ctx?.waitUntil) ctx.waitUntil(renewPromise);
      else await renewPromise;
      // Issue #255 — nightly mas_messages retention pass (0 4 * * * cron in
      // wrangler.jsonc). Enforces the retention window and records one
      // mas_events row per run.
    } else if (event?.cron === "0 4 * * *") {
      if (!userLogin || !serviceProvisioned) {
        console.error(
          "[scheduled] SERVICE_USER_LOGIN is not configured or the service user is not provisioned for the platform tier — skipping the retention dispatch rather than running unattended work without a verified identity (#2331 slice 2)."
        );
        return;
      }
      const retentionPromise = agent.fetch(
        new Request("https://agent.internal/schedules/trigger-retention", {
          method: "POST",
          headers: { ...backgroundDispatchHeaders(userLogin) },
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(retentionPromise);
      else await retentionPromise;
    }
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
            console.warn("[dead-letter] schema ensure failed (console record stands):", err);
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
        console.warn(
          "[observability] delivery tap failed (ignored):",
          tapErr,
        );
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
      const agent = actorGateway.stub<DoStubLike>(env.SEARCH_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
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
                    env.SEARCH_AGENT,
                    stageMsg.userLogin,
                  );
                  const first = await perUser.refreshCanonicalPdfFields(refreshInput);
                  if (first.status === "missing-row") {
                    const shared = actorGateway.stub<RefreshOrchestrator>(
                      env.SEARCH_AGENT,
                      SHARED_ORCHESTRATOR_INSTANCE,
                    );
                    const second = await shared.refreshCanonicalPdfFields(refreshInput);
                    if (second.status !== "refreshed" && second.status !== "noop") {
                      console.warn(`[Queue Handler] canonical PDF refresh unresolved: per-user ${first.status}, shared ${second.status} (run ${stageMsg.runId}).`);
                    }
                  } else if (first.status !== "refreshed" && first.status !== "noop") {
                    console.warn(`[Queue Handler] canonical PDF refresh ${first.status} (run ${stageMsg.runId}).`);
                  }
                } catch (refreshErr) {
                  console.warn(`[Queue Handler] canonical PDF refresh failed (run ${stageMsg.runId}); generated PDF remains on the persisted analysis key:`, refreshErr);
                }
              }
              if (typeof msg.ack === "function") msg.ack();
              if (outcome.status === "dead-lettered") {
                console.warn("[Queue Handler] analysis-done stage message dead-lettered:", outcome.reason ?? "unknown");
              }
            } catch (queueErr) {
              console.warn("[Queue Handler] Failed to consume analysis-done stage message; retrying:", queueErr);
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
                console.warn("[Queue Handler] stage-boundary message dead-lettered:", outcome.reason ?? "unknown");
              }
            } catch (queueErr) {
              console.warn("[Queue Handler] Failed to record stage-boundary message; retrying:", queueErr);
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
              console.warn("[Queue Handler] Failed to process queue message:", queueErr);
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
          console.warn(
            "[messaging] screener-events batch has no messaging ports — retrying envelopes into the DLQ path."
          );
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
    const agent = actorGateway.stub<DoStubLike>(env.SEARCH_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
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
          console.warn("[Queue Handler] Failed to process queue message:", queueErr);
          if (typeof msg.retry === "function") msg.retry();
        }
      }
    }
}
