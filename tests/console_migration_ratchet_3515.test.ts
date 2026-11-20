/**
 * Issue #3515 S3 — ratchet pin: no NEW unstructured `console.*` in `src/`.
 *
 * Batch 1 (this slice) migrated the peripheral server areas to the S2
 * structured logger (`src/observability/structuredLogger.ts`): actors,
 * aspects, breakers, config, enrichment, errors, features, gateway,
 * mcps, messaging, observability (scheduledJobOutcomes), outcomes,
 * patterns, payments, privacy, retrieval, telemetry, plus src/server.ts
 * — 91 call sites across 47 files, verified from code on main 3859836a
 * (raw grep said 700 lines; the stripper below counts 685 real uses:
 * 682 call expressions + 3 bare `.catch(console.warn)` refs; the other
 * 15 lines are prose mentions inside comments/strings). The 91st site
 * is `src/mcps/openaimp/meshDoorCommands.ts`: main's #3513 added one
 * `console.error` there after the batch was built (rebase to e21532a5);
 * it is in the batch-1 mcps area, so this PR migrates it rather than
 * loosening the pin — the remaining total stays 595.
 *
 * Batch 2 (this slice) migrated `src/services` — all 46 files, 175
 * real sites — to the same logger, and moved them from REMAINING_PIN
 * to MIGRATED_ZERO. One pin correction: the `src/services/aiSearch.ts`
 * ceiling of 7 was stale (base b0aa9685 held only 1 real ref), so the
 * true remaining total before batch 2 was 589, not 595; after batch 2
 * the remaining total is 414.
 *
 * Batch 4 (this slice) migrated `src/trading` — 9 files, 47 real
 * sites — to the same logger, and moved them from REMAINING_PIN to
 * MIGRATED_ZERO. Two planned files are untouched by this batch:
 * `src/trading/channels/intake.ts` already reached zero on main via
 * #5083 S4 and `src/trading/options/unifiedOptionsService.ts` holds no
 * `console.*` on main, so both stay in REMAINING_PIN at their ceilings.
 * After batch 4 the remaining total is 187.
 *
 * Batch 5 (this slice) migrated `src/workflows` — all 18 files, 44 real
 * sites — to the same logger, and moved them from REMAINING_PIN to
 * MIGRATED_ZERO; after batch 5 the remaining total is 143. Three
 * judgment calls, all following established precedent, never a new
 * scheme: the three injected `warn` defaults (`optionsScreenWorkflow`,
 * `optionsStageSeam`, `stageBoundaryEmitter`) default to
 * `structuredLog.warn("<base>.log", { message })`, exactly the batch-1
 * `gateway.log` / `retrieval.log` precedent for injected log defaults,
 * so the test seam keeps its messages and production emits structured
 * events; `screenRunAspects.logScreenRunEvent`'s hand-built JSON line
 * becomes one `screenRunAspects.screen_run_event` info event with the
 * line's fields, the trace/actor/agent riding the logger's scope
 * overrides (tenant reads null, never invented); `paymentWorkflow`'s
 * nine new events keep that file's existing camelCase suffixes
 * (`chargeJournalSkipped`, `failureCreditJournalSkipped`). Three tests
 * asserted on the raw `console.log` JSON line and were updated to the
 * structured form (spy console.info, parse the JSON event, assert on
 * operation + level + fields) — no behavior change.
 *
 * Batch 6 (this slice) migrated `src/server/routes` — all 5 files, 38 real
 * sites — to the same logger, and moved them from REMAINING_PIN to
 * MIGRATED_ZERO; after batch 6 the remaining total is 103. One pin
 * correction, the batch-2 precedent: the `src/server/routes/queue.ts`
 * ceiling of 16 was stale (current main holds 14 real refs), so the
 * true remaining total before batch 6 was 141, not 143; 141 − 38 = 103,
 * and REMAINING_PIN sums to 103. Update (Venus hold, #5587): the five
 * module loggers were built with an empty env and would have been
 * console-only — events never reach the Analytics Engine
 * `observability` dataset (the binding is construction-time). The
 * loggers are now built per handler from the request's env, so the AE
 * branch is live; the scheduled dispatcher's existing in-function
 * logger is untouched, and no event name, message, or severity
 * changed. The queue file's #3121 comment about the ceiling of 16
 * now reads migrated-to-zero. All 16 `auth.ts` warnings are the
 * repeated
 * session-rotation / granter-revocation blocks, migrated with one
 * event name per distinct message; two tests asserted on the raw
 * `console.warn` denied-dispatch line and were updated to the
 * structured form (spy console.info, parse the JSON event, assert on
 * operation + level + fields) — `cloudflare_migration_step1_queue_
 * consumer_2544` (screener-events branch) and `service_identity`
 * (fallthrough branch), both asserting the one
 * `queue.options_analysis_dispatch_denied` warn event; no behavior
 * change. The first PR CI run failed exactly those two tests
 * (shards 2/4 and 4/4), diagnosed from a local shard reproduction
 * with a completed OTel install; the fix rides with the slice.
 *
 * Batch 7 (this slice) migrated `src/data` — all 22 files, 33 real
 * sites — to the same logger, and moved them from REMAINING_PIN to
 * MIGRATED_ZERO; after batch 7 the remaining total is 70. No pin
 * correction: every data file held exactly its ceiling on current
 * main (verified from code). Logger construction follows the #5587
 * ruling (Venus 2026-11-18): no new `createObservabilitySink({})`
 * module logger anywhere in the slice. The three files whose
 * handlers already hold the request env (`createChainSchedulePorts`,
 * `createGovernancePorts`, `createScreenRunLockPorts`) build their
 * logger per function from that env, and `createGovernanceAdapter`
 * passes the env-constructed sink into `D1GovernanceAdapter`;
 * `providerCapturePorts` reuses its pre-existing module logger;
 * every other file takes an optional `sink?: ObservabilitySink`
 * (the `d1QueryLogger` precedent) and falls back to an explicit
 * `ConsoleObservabilitySink` — the composition roots outside this
 * slice that could pass the env-constructed sink
 * (`createEvidenceSatellitePorts`, `createCanonicalReportStorePorts`,
 * the `screeningActivity`/`jobOutcomes` services, the enrichment
 * route, the retention/shard-job route wiring in `privacy.ts`) are
 * not touched here; wiring them is the #5587 follow-up, recorded
 * in the §15. Three tests asserted on raw `console.error` lines
 * and were updated to the structured form (spy console.info, parse
 * the JSON event, assert on operation + level + fields) —
 * `ensure_schema_dedupe_guard_4507` and
 * `report_generation_index_scope_2398` (canonical-report dedupe
 * events) and `data_provider_capture_e1` (capture-write failure
 * events); no behavior change.
 *
 * Batch 9 (this slice) migrated `src/events` — both files, 21 real
 * sites — to the same logger, and moved them from REMAINING_PIN to
 * MIGRATED_ZERO; after batch 9 the remaining total is 20. No pin
 * correction: both files held exactly their ceilings on current
 * main (verified from code). Logger construction follows the #5587
 * ruling (Venus 2026-11-18): no new `createObservabilitySink({})`
 * module logger anywhere in the slice. Every publisher function
 * already holds the request env in `deps`, so each builds its logger
 * per function from that env (`fetchScreenerPdf`,
 * `deliverPdfToSlack`, `deliverPdfToEmail`, `publishCompleted`,
 * `publishFailed`); the `ScreenerEventBus` takes an optional
 * `sink?: ObservabilitySink` at construction and falls back to an
 * explicit `ConsoleObservabilitySink` — its two construction sites
 * (`screenerQueueConsumer`, `scheduledTasks`) are outside this slice
 * and not rewired; wiring the env-constructed sink through them is
 * the #5587 follow-up, recorded in the §15. Two tests asserted on
 * raw `console.warn`/`console.error` lines and were updated to the
 * structured form (spy console.info, parse the JSON event, assert on
 * operation + level + fields) — `screener-publishers-pdf` (PDF
 * fetch failure events) and `screener_delivery_config_1770`
 * (email-skip warnings); no behavior change.
 *
 * Batch 10 (this slice) migrated `src/client` — 9 files, 13 real
 * sites — to the same logger, and moved them from REMAINING_PIN to
 * MIGRATED_ZERO; after batch 10 the remaining total is 6. One pin
 * correction, the batch-2/batch-6 precedent: the
 * `src/client/TradeHub.tsx` ceiling of 2 was stale (current main
 * holds 1 real ref — the only `console.*` line in the file), so the
 * true remaining total before batch 10 was 19, not 20; 19 − 13 = 6,
 * and REMAINING_PIN sums to 6. Logger construction follows the #5587
 * ruling (Venus 2026-11-18): no new `createObservabilitySink({})`
 * module logger anywhere in the slice. The browser has no Cloudflare
 * env in scope, so the nine files share one new factory,
 * `src/client/clientLogger.ts`, which builds each module logger over
 * the EXPLICIT `ConsoleObservabilitySink` (the ScreenerEventBus /
 * d1QueryLogger fallback precedent) — events emit as one structured
 * JSON line on `console.info`, the same shape the server-side
 * fallback emits. The transitive import graph is browser-safe
 * (structuredLogger → observabilityPorts → resourceEventGuard, zero
 * imports; only `crypto.getRandomValues`, `TextEncoder`, `Date`,
 * `BigInt` at runtime; the one messaging import is type-only and
 * erased) and the client already imports outside `src/client/`
 * (`../trading`, `../services`, `../data`); `vite build` proves the
 * bundle. The AutopilotControlCenter doc comment that said "there is
 * no sanctioned client-side logger" is updated — the factory is the
 * sanctioned logger now. No test asserted on the migrated lines (the
 * whole-tree console-spy grep found none; `error_boundary.test.tsx`
 * asserts on state/render only); no behavior change. The neutrality
 * census does not trip: none of the new event names or `component:`
 * lines contains a census term (`slack` is not a census term).
 *
 * Paperwork batch (this slice) moves the two stale trading ceilings
 * from REMAINING_PIN to MIGRATED_ZERO with NO production code change:
 * `src/trading/channels/intake.ts` (ceiling 3) and
 * `src/trading/options/unifiedOptionsService.ts` (ceiling 1) each hold
 * 0 real `console.*` uses on current main (verified from code with a
 * port of the ratchet's stripper — comments/strings excluded; intake
 * reached zero via #5083 S4, unifiedOptionsService never held a use).
 * After this batch REMAINING_PIN sums to 2: only
 * `src/observability/observabilityPorts.ts`, the SANCTIONED_FALLBACK
 * (the structured logger's own console fallback, exactly 2 uses),
 * which stays by design. The console migration (S3) is complete at
 * that point — every remaining `console.*` in `src/` is the sanctioned
 * fallback itself.
 *
 * Batch 8 (this slice) migrated `src/security` — all 14 files, 29 real
 * sites — to the same logger, and moved them from REMAINING_PIN to
 * MIGRATED_ZERO; after batch 8 the remaining total is 41. No pin
 * correction: every security file held exactly its ceiling on current
 * main (verified from code). Logger construction follows the #5587
 * ruling (Venus 2026-11-18): no new `createObservabilitySink({})`
 * module logger anywhere in the slice. The six functions that already
 * hold the request env (`propagateBrokerTokenRejection`, `handleLogout`,
 * `completeWiredLogin`, the five `etradeOAuth` functions, the OIDC
 * `startLogin`/`handleCallback`) build their logger per function from
 * that env, and `completeWiredLogin` passes the env-constructed sink
 * into `runWiredPostLogin`; the SessionStore Durable Object builds its
 * logger from `this.env` (test instances built via `Object.create`
 * fall back to the console sink); every other file takes an optional
 * `sink?: ObservabilitySink` (the `d1QueryLogger` precedent) and falls
 * back to an explicit `ConsoleObservabilitySink`. The `storeMetrics`
 * default sink now emits the record as the fields of one
 * `storeMetrics.store_op` info event (the batch-5 `screenRunAspects`
 * precedent for a hand-built JSON line); the T1/T2 aggregation
 * queries in docs/OBSERVABILITY.md (§4) read the fields under
 * `fields`. One test asserted on the old default-sink JSON line and
 * was updated to the structured form (spy console.info, parse the
 * JSON event, assert on operation + level + fields) — no behavior
 * change. The neutrality census trips on exactly one row: the
 * `etradeOAuth` event names and `component:` lines name the provider
 * whose adapter this file is, so its baseline row is raised 124 -> 131
 * with an INTEGRATION disposition, per the gitops §7 pin rule — the event
 * names are not renamed to dodge it.
 *
 * Batch 3 (this slice) migrated `src/agents` — all 42 files, 180
 * real sites — to the same logger, and moved them from REMAINING_PIN
 * to MIGRATED_ZERO; after batch 3 the remaining total is 234. One
 * judgment call: `src/agents/routes/paymentAssuranceLive.ts` `logError`
 * was `console.log` in a catch handler — re-pinned to error severity,
 * since the call's purpose is error logging. One follow-up: the
 * migration pushed `src/agents/routes/etradeBroker.ts` to 50,533 B,
 * over the #359 50,000 B dispatcher ceiling (pinned by
 * tests/etrade_broker_portfolio_risk_split_2943.test.ts), so the
 * autopilot execution-verdict gate moved to the new
 * `src/agents/routes/etradeBrokerAutopilot.ts` (no route condition,
 * no ETradeService construction — the #2943 pins are untouched);
 * the new file is at zero and listed in MIGRATED_ZERO below.
 * Seven tests asserted on raw `console.*` spies and were updated to
 * the structured form (spy console.info, parse the JSON event lines,
 * assert on operation + level + fields) — no behavior change.
 *
 * The pin is a ratchet, not a ban: files the migration has not reached
 * yet keep their counted uses as a ceiling (REMAINING_PIN — a file may
 * only go DOWN, never up, and a file absent from the table must be at
 * zero, so a brand-new file cannot introduce `console.*` at all).
 * When a later batch migrates an area, it moves that area's files from
 * REMAINING_PIN to MIGRATED_ZERO in the same PR.
 *
 * Counting rule: comments and string/template literals are stripped
 * before matching, so prose that merely MENTIONS `console.warn` (doc
 * comments, string content) never trips the pin — the bespoke-ceiling
 * lesson (#2786: a literal inside a comment tripped a raw-substring
 * ceiling). Only real code references count. The stripper is a
 * frame-stack scanner: template `${...}` expressions are scanned as
 * code (nested templates included), so a `console.*` hidden inside an
 * interpolation still counts. Regex literals are the one known blind
 * spot: a `console.*` inside a regex literal would be missed — none
 * exists in `src/` today.
 *
 * Sanctioned uses: `src/observability/observabilityPorts.ts` keeps
 * exactly 2 — the `ConsoleObservabilitySink` JSON console fallback
 * (`console.info`) and the `SafeObservabilitySink` degradation callback
 * default (`console.warn`). Those ARE the structured logger's own
 * fallback; banning them would ban the logger's transport.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC_ROOT = path.resolve(__dirname, "../src");
const CONSOLE_USE = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\b/g;

/**
 * Strip comments and string/template literals, keeping code (including
 * template `${...}` expressions) and line breaks. Frames: "normal" |
 * "line" | "block" | "sq" | "dq" | "tpl" | ["expr", depth].
 */
export function stripCode(src: string): string {
  const out: string[] = [];
  const stack: Array<string | ["expr", number]> = ["normal"];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const nxt = i + 1 < src.length ? src[i + 1] : "";
    const top = stack[stack.length - 1];
    const kind = Array.isArray(top) ? top[0] : top;
    if (kind === "normal" || kind === "expr") {
      if (c === "/" && nxt === "/") {
        stack.push("line");
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "/" && nxt === "*") {
        stack.push("block");
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "'") {
        stack.push("sq");
        out.push(" ");
        i += 1;
        continue;
      }
      if (c === '"') {
        stack.push("dq");
        out.push(" ");
        i += 1;
        continue;
      }
      if (c === "`") {
        stack.push("tpl");
        out.push(" ");
        i += 1;
        continue;
      }
      if (kind === "expr" && c === "{") {
        (top as ["expr", number])[1] += 1;
        out.push(c);
        i += 1;
        continue;
      }
      if (kind === "expr" && c === "}") {
        (top as ["expr", number])[1] -= 1;
        if ((top as ["expr", number])[1] === 0) {
          stack.pop();
          out.push(" ");
          i += 1;
          continue;
        }
        out.push(c);
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (kind === "line") {
      if (c === "\n") {
        stack.pop();
        out.push("\n");
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }
    if (kind === "block") {
      if (c === "*" && nxt === "/") {
        stack.pop();
        out.push("  ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    if (kind === "sq" || kind === "dq") {
      if (c === "\\") {
        out.push("  ");
        i += 2;
        continue;
      }
      if ((kind === "sq" && c === "'") || (kind === "dq" && c === '"')) {
        stack.pop();
        out.push(" ");
        i += 1;
        continue;
      }
      if (c === "\n") {
        stack.pop();
        out.push("\n");
        i += 1;
        continue;
      }
      out.push(" ");
      i += 1;
      continue;
    }
    // kind === "tpl"
    if (c === "\\") {
      out.push("  ");
      i += 2;
      continue;
    }
    if (c === "`") {
      stack.pop();
      out.push(" ");
      i += 1;
      continue;
    }
    if (c === "$" && nxt === "{") {
      stack.push(["expr", 1]);
      out.push("  ");
      i += 2;
      continue;
    }
    out.push(c === "\n" ? "\n" : " ");
    i += 1;
  }
  return out.join("");
}

function countConsoleUses(src: string): number {
  return (stripCode(src).match(CONSOLE_USE) ?? []).length;
}

/** Batch-1 migrated files: zero unstructured `console.*` allowed. */
const MIGRATED_ZERO: readonly string[] = [
  "src/actors/thinkAdapter.ts",
  "src/agents/chatErrorFallback.ts",
  "src/agents/mas.ts",
  "src/agents/nlq/execution.ts",
  "src/agents/orchestrator.ts",
  "src/agents/orchestrator/asyncJobs.ts",
  "src/agents/orchestrator/autopilot.ts",
  "src/agents/orchestrator/chatTurnHelpers.ts",
  "src/agents/orchestrator/meshMcpClient.ts",
  "src/agents/orchestrator/meshScreenDoor.ts",
  "src/agents/orchestrator/nlqPorts.ts",
  "src/agents/orchestrator/reportDispatch.ts",
  "src/agents/orchestrator/researchPublish.ts",
  "src/agents/orchestrator/scheduleMaintenance.ts",
  "src/agents/orchestrator/scheduledCallbacks.ts",
  "src/agents/orchestrator/settingsWebhook.ts",
  "src/agents/report-asset-agent.ts",
  "src/agents/research-agent.ts",
  "src/agents/routes/adsRevenueReferrals.ts",
  "src/agents/routes/agenticPayments.ts",
  "src/agents/routes/brokerConnect.ts",
  "src/agents/routes/brokerOrders.ts",
  "src/agents/routes/dlq.ts",
  "src/agents/routes/etradeBroker.ts",
  "src/agents/routes/etradeBrokerAutopilot.ts",
  "src/agents/routes/etradeBrokerOrders.ts",
  "src/agents/routes/etradeOptions.ts",
  "src/agents/routes/etradeOptionsEvaluate.ts",
  "src/agents/routes/etradeOptionsScreen.ts",
  "src/agents/routes/knowledgeCorpus.ts",
  "src/agents/routes/mcpChatNlq.ts",
  "src/agents/routes/memoryReset.ts",
  "src/agents/routes/paidStockScreenSeam.ts",
  "src/agents/routes/paymentAssuranceLive.ts",
  "src/agents/routes/payments.ts",
  "src/agents/routes/premium.ts",
  "src/agents/routes/sagaEntry.ts",
  "src/agents/routes/schedules.ts",
  "src/agents/routes/screenerResearch.ts",
  "src/agents/scheduled-agent.ts",
  "src/agents/screener-agent.ts",
  "src/agents/settingsWebhookNotify.ts",
  "src/agents/ticker-agent.ts",
  "src/agents/trading-agent.ts",
  "src/aspects/loggingAspect.ts",
  "src/aspects/transactionAspect.ts",
  "src/breakers/breakerPorts.ts",
  "src/breakers/createBreakerPorts.ts",
  "src/breakers/durableBreakerAdapter.ts",
  "src/client/Chat.tsx",
  "src/client/ErrorBoundary.tsx",
  "src/client/FirstRunScreen.tsx",
  "src/client/ScheduledOptionsManager.tsx",
  "src/client/TradeHub.tsx",
  "src/client/chat/AgentChatTabContent.tsx",
  "src/client/components/AutopilotControlCenter.tsx",
  "src/client/firstRunApi.ts",
  "src/client/options/StrategyDiscoveryPanel.tsx",
  "src/config/agenticPaymentsModes.ts",
  "src/config/apiIngressModes.ts",
  "src/config/etapiConfig.ts",
  "src/config/etradeModes.ts",
  "src/config/goalChainModes.ts",
  "src/config/marketDataModes.ts",
  "src/config/paymentsFlowModes.ts",
  "src/config/quoteModes.ts",
  "src/data/chainScheduleProjection.ts",
  "src/data/createChainSchedulePorts.ts",
  "src/data/createGovernancePorts.ts",
  "src/data/createScreenRunLockPorts.ts",
  "src/data/d1GovernanceAdapter.ts",
  "src/data/d1ResourceUsageAdapter.ts",
  "src/data/doSqliteCanonicalReportStoreAdapter.ts",
  "src/data/doSqliteEnrichmentAdapter.ts",
  "src/data/doSqliteJobOutcomeAdapter.ts",
  "src/data/doSqliteScreeningActivityAdapter.ts",
  "src/data/durableKv.ts",
  "src/data/inMemoryGovernanceAdapter.ts",
  "src/data/inMemoryJobOutcomeAdapter.ts",
  "src/data/inMemoryScreeningActivityAdapter.ts",
  "src/data/ormFacade.ts",
  "src/data/productRollout.ts",
  "src/data/providerCapturePorts.ts",
  "src/data/retentionPurge.ts",
  "src/data/retentionRoute.ts",
  "src/data/shardJobRoute.ts",
  "src/data/tokenFamilyKvImpl.ts",
  "src/data/traceRecordPorts.ts",
  "src/config/restTwinsModes.ts",
  "src/enrichment/enrichmentPorts.ts",
  "src/enrichment/enrichmentService.ts",
  "src/errors/errorAspects.deprecated.ts",
  "src/events/screenerEvents.ts",
  "src/events/screenerPublishers.ts",
  "src/features/cfFlagshipAdapter.ts",
  "src/gateway/gatewayPorts.ts",
  "src/mcps/openaimp/agenticPaymentCommands.ts",
  "src/mcps/openaimp/commands.ts",
  "src/mcps/openaimp/etradeCommands.ts",
  "src/mcps/openaimp/goalChainCommands.ts",
  "src/mcps/openaimp/handler.ts",
  "src/mcps/openaimp/index.ts",
  "src/mcps/openaimp/meshDoorCommands.ts",
  "src/mcps/scanner/cloudflareWalletsScanner.ts",
  "src/messaging/createJobPipelineMessaging.ts",
  "src/messaging/createMessagingPorts.ts",
  "src/messaging/deadLetter.ts",
  "src/messaging/deadLetterPersist.ts",
  "src/messaging/dlqDepthAlert.ts",
  "src/messaging/messagingPorts.ts",
  "src/messaging/screenerQueueConsumer.ts",
  "src/observability/scheduledJobOutcomes.ts",
  "src/outcomes/outcomeAspects.ts",
  "src/patterns/observer.ts",
  "src/patterns/paymentStrategies.ts",
  "src/payments/draftOwners.ts",
  "src/privacy/privacyRoutes.ts",
  "src/retrieval/hybridRetrieval.ts",
  "src/server.ts",
  "src/server/routes/auth.ts",
  "src/server/routes/core.ts",
  "src/server/routes/messaging.ts",
  "src/server/routes/privacy.ts",
  "src/server/routes/queue.ts",
  "src/security/brokerTokenRejection.ts",
  "src/security/etradeOAuth.ts",
  "src/security/githubOAuth.ts",
  "src/security/iaaaEnforcement.ts",
  "src/security/iaaaGithubEndToEnd.ts",
  "src/security/iaaaLogin.ts",
  "src/security/kvResilience.ts",
  "src/security/oidcProvider.ts",
  "src/security/runRevocationGate.ts",
  "src/security/sessionStore.ts",
  "src/security/storageRetention.ts",
  "src/security/storeMetrics.ts",
  "src/security/webhookReplay.ts",
  "src/security/workerErrorBoundary.ts",
  "src/services/adaptationAudit.ts",
  "src/services/agenticPayments.ts",
  "src/services/aiSearch.ts",
  "src/services/auditGate.ts",
  "src/services/auditTamperAlert.ts",
  "src/services/cfpayLedger.ts",
  "src/services/cloudflareEmailSender.ts",
  "src/services/corpusAiSearchIndex.ts",
  "src/services/corpusSync.ts",
  "src/services/createBillingCheckoutPorts.ts",
  "src/services/createBillingPorts.ts",
  "src/services/createCheckoutPorts.ts",
  "src/services/discoveryReportPublish.ts",
  "src/services/etrade.ts",
  "src/services/etradeAuthPreflight.ts",
  "src/services/feedJobs.ts",
  "src/services/fitDiscoveryRunner.ts",
  "src/services/goalScreenReports.ts",
  "src/services/goalScreenWorkflowSubmission.ts",
  "src/services/jobPipelineEvents.ts",
  "src/services/journalPosting.ts",
  "src/services/journalRecognition.ts",
  "src/services/knowledgeCorpus.ts",
  "src/services/lifecycleEmail.ts",
  "src/services/optionsAuthFreshness.ts",
  "src/services/optionsRunEmail.ts",
  "src/services/optionsServeRecord.ts",
  "src/services/pipelinePolicy.ts",
  "src/services/reflection.ts",
  "src/services/refundService.ts",
  "src/services/reportAiSearchIndex.ts",
  "src/services/reportBlobStore.ts",
  "src/services/reportSemanticIndex.ts",
  "src/services/researchProviders.ts",
  "src/services/resilience.ts",
  "src/services/scheduledReports.ts",
  "src/services/scheduledTasks.ts",
  "src/services/screenerFollowupDelivery.ts",
  "src/services/screenerSlackDelivery.ts",
  "src/services/screeningActivity.ts",
  "src/services/screeningFlags.ts",
  "src/services/shardExecutors.ts",
  "src/services/stockReportArtifacts.ts",
  "src/services/tradingWebhooks.ts",
  "src/services/unifiedReportPipeline.ts",
  "src/services/userEmailDestination.ts",
  "src/telemetry/calibratedPromptPlug.ts",
  "src/telemetry/fanOutResourceUsageAdapter.ts",
  "src/telemetry/resourceUsageObservabilityAdapter.ts",
  "src/telemetry/telemetryPorts.ts",
  "src/trading/alpaca/signIn.ts",
  "src/trading/channels/intake.ts",
  "src/trading/dataProviders/fetchOutcome.ts",
  "src/trading/email/agent.ts",
  "src/trading/etrade/client.ts",
  "src/trading/etrade/platform.ts",
  "src/trading/etrade/quoteTrace.ts",
  "src/trading/options/unifiedOptionsService.ts",
  "src/trading/platformHistory.ts",
  "src/trading/screenerPipeline.ts",
  "src/trading/slack/agent.ts",
  "src/workflows/createWorkflowPorts.ts",
  "src/workflows/manualOptionsScreen.ts",
  "src/workflows/optionsScreenWorkflow.ts",
  "src/workflows/optionsStageSeam.ts",
  "src/workflows/paymentWorkflow.ts",
  "src/workflows/paymentWorkflowFlow.ts",
  "src/workflows/sagaWorkflow.ts",
  "src/workflows/screenRunAspects.ts",
  "src/workflows/screenerWorkflow.ts",
  "src/workflows/screenerWorkflowFlow.deprecated.ts",
  "src/workflows/screenerWorkflowRoutes.ts",
  "src/workflows/stageBoundaryEmitter.ts",
  "src/workflows/stageQueueTransport.ts",
  "src/workflows/stageReportConsumer.ts",
  "src/workflows/stageReportProduction.ts",
  "src/workflows/stageRunnerCheckpointAdapter.ts",
  "src/workflows/strategyScreenPorts.ts",
  "src/workflows/workflowInstanceSeam.ts",
]

/**
 * Unmigrated files: ceiling counts (stripper-verified on main 3859836a,
 * re-verified on e21532a5 after the rebase — the only main-side delta
 * was one new site in meshDoorCommands.ts, migrated in this PR).
 * A file may drop below its ceiling (a later batch migrating it) but
 * never exceed it; a file absent here must be at zero.
 */
const REMAINING_PIN: Readonly<Record<string, number>> = {
  "src/observability/observabilityPorts.ts": 2,
};

/** The structured logger's own console fallback — exactly 2 uses. */
const SANCTIONED_FALLBACK = "src/observability/observabilityPorts.ts";

function walkSrc(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(full, acc);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc.sort();
}

describe("console.* migration ratchet (#3515 S3)", () => {
  it("migrated areas emit no unstructured console.*", () => {
    const violations: string[] = [];
    for (const rel of MIGRATED_ZERO) {
      const count = countConsoleUses(
        fs.readFileSync(path.join(SRC_ROOT, rel.replace(/^src\//, "")), "utf8"),
      );
      if (count !== 0) violations.push(`${rel}: ${count}`);
    }
    expect(violations).toEqual([]);
  });

  it("no file exceeds its pinned ceiling; new files must be at zero", () => {
    const violations: string[] = [];
    let total = 0;
    for (const full of walkSrc(SRC_ROOT)) {
      const rel = path.relative(path.resolve(__dirname, ".."), full);
      const count = countConsoleUses(fs.readFileSync(full, "utf8"));
      total += count;
      if (rel === SANCTIONED_FALLBACK) {
        if (count !== 2) {
          violations.push(`${rel}: ${count} (sanctioned fallback must be exactly 2)`);
        }
        continue;
      }
      const ceiling = REMAINING_PIN[rel] ?? 0;
      if (count > ceiling) violations.push(`${rel}: ${count} > pinned ${ceiling}`);
    }
    expect(
      violations,
      `total unstructured console.* uses in src/: ${total}`,
    ).toEqual([]);
  });

  it("the sanctioned fallback is exactly the observability sink's", () => {
    const raw = fs.readFileSync(path.join(SRC_ROOT, "observability/observabilityPorts.ts"), "utf8");
    expect(raw).toContain("class ConsoleObservabilitySink");
    expect(raw).toContain("class SafeObservabilitySink");
    expect(countConsoleUses(raw)).toBe(2);
  });
});
