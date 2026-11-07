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
  "src/aspects/loggingAspect.ts",
  "src/aspects/transactionAspect.ts",
  "src/breakers/breakerPorts.ts",
  "src/breakers/createBreakerPorts.ts",
  "src/breakers/durableBreakerAdapter.ts",
  "src/config/agenticPaymentsModes.ts",
  "src/config/apiIngressModes.ts",
  "src/config/etapiConfig.ts",
  "src/config/etradeModes.ts",
  "src/config/goalChainModes.ts",
  "src/config/marketDataModes.ts",
  "src/config/paymentsFlowModes.ts",
  "src/config/quoteModes.ts",
  "src/config/restTwinsModes.ts",
  "src/enrichment/enrichmentPorts.ts",
  "src/enrichment/enrichmentService.ts",
  "src/errors/errorAspects.deprecated.ts",
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
];

/**
 * Unmigrated files: ceiling counts (stripper-verified on main 3859836a,
 * re-verified on e21532a5 after the rebase — the only main-side delta
 * was one new site in meshDoorCommands.ts, migrated in this PR).
 * A file may drop below its ceiling (a later batch migrating it) but
 * never exceed it; a file absent here must be at zero.
 */
const REMAINING_PIN: Readonly<Record<string, number>> = {
  "src/agents/chatErrorFallback.ts": 1,
  "src/agents/mas.ts": 2,
  "src/agents/nlq/execution.ts": 2,
  "src/agents/orchestrator.ts": 20,
  "src/agents/orchestrator/asyncJobs.ts": 13,
  "src/agents/orchestrator/autopilot.ts": 3,
  "src/agents/orchestrator/chatTurnHelpers.ts": 2,
  "src/agents/orchestrator/meshMcpClient.ts": 2,
  "src/agents/orchestrator/meshScreenDoor.ts": 1,
  "src/agents/orchestrator/nlqPorts.ts": 1,
  "src/agents/orchestrator/reportDispatch.ts": 4,
  "src/agents/orchestrator/researchPublish.ts": 12,
  "src/agents/orchestrator/scheduleMaintenance.ts": 3,
  "src/agents/orchestrator/scheduledCallbacks.ts": 10,
  "src/agents/orchestrator/settingsWebhook.ts": 5,
  "src/agents/report-asset-agent.ts": 5,
  "src/agents/research-agent.ts": 12,
  "src/agents/routes/adsRevenueReferrals.ts": 1,
  "src/agents/routes/agenticPayments.ts": 4,
  "src/agents/routes/brokerConnect.ts": 3,
  "src/agents/routes/brokerOrders.ts": 1,
  "src/agents/routes/dlq.ts": 1,
  "src/agents/routes/etradeBroker.ts": 1,
  "src/agents/routes/etradeBrokerOrders.ts": 4,
  "src/agents/routes/etradeOptions.ts": 1,
  "src/agents/routes/etradeOptionsEvaluate.ts": 2,
  "src/agents/routes/etradeOptionsScreen.ts": 9,
  "src/agents/routes/knowledgeCorpus.ts": 9,
  "src/agents/routes/mcpChatNlq.ts": 1,
  "src/agents/routes/memoryReset.ts": 1,
  "src/agents/routes/paidStockScreenSeam.ts": 1,
  "src/agents/routes/paymentAssuranceLive.ts": 3,
  "src/agents/routes/payments.ts": 7,
  "src/agents/routes/premium.ts": 1,
  "src/agents/routes/sagaEntry.ts": 1,
  "src/agents/routes/schedules.ts": 5,
  "src/agents/routes/screenerResearch.ts": 5,
  "src/agents/scheduled-agent.ts": 1,
  "src/agents/screener-agent.ts": 15,
  "src/agents/settingsWebhookNotify.ts": 1,
  "src/agents/ticker-agent.ts": 1,
  "src/agents/trading-agent.ts": 3,
  "src/client/Chat.tsx": 1,
  "src/client/ETradeTradingHub.tsx": 2,
  "src/client/ErrorBoundary.tsx": 1,
  "src/client/FirstRunScreen.tsx": 2,
  "src/client/ScheduledOptionsManager.tsx": 2,
  "src/client/chat/AgentChatTabContent.tsx": 2,
  "src/client/components/AutopilotControlCenter.tsx": 1,
  "src/client/firstRunApi.ts": 1,
  "src/client/options/StrategyDiscoveryPanel.tsx": 2,
  "src/data/chainScheduleProjection.ts": 1,
  "src/data/createChainSchedulePorts.ts": 1,
  "src/data/createGovernancePorts.ts": 1,
  "src/data/createScreenRunLockPorts.ts": 1,
  "src/data/d1GovernanceAdapter.ts": 1,
  "src/data/d1ResourceUsageAdapter.ts": 1,
  "src/data/doSqliteCanonicalReportStoreAdapter.ts": 2,
  "src/data/doSqliteEnrichmentAdapter.ts": 2,
  "src/data/doSqliteJobOutcomeAdapter.ts": 1,
  "src/data/doSqliteScreeningActivityAdapter.ts": 2,
  "src/data/durableKv.ts": 3,
  "src/data/inMemoryGovernanceAdapter.ts": 1,
  "src/data/inMemoryJobOutcomeAdapter.ts": 1,
  "src/data/inMemoryScreeningActivityAdapter.ts": 2,
  "src/data/ormFacade.ts": 1,
  "src/data/productRollout.ts": 1,
  "src/data/providerCapturePorts.ts": 4,
  "src/data/retentionPurge.ts": 1,
  "src/data/retentionRoute.ts": 1,
  "src/data/shardJobRoute.ts": 2,
  "src/data/tokenFamilyKvImpl.ts": 1,
  "src/data/traceRecordPorts.ts": 1,
  "src/events/screenerEvents.ts": 1,
  "src/events/screenerPublishers.ts": 20,
  "src/observability/observabilityPorts.ts": 2,
  "src/security/brokerTokenRejection.ts": 1,
  "src/security/etradeOAuth.ts": 10,
  "src/security/githubOAuth.ts": 1,
  "src/security/iaaaEnforcement.ts": 2,
  "src/security/iaaaGithubEndToEnd.ts": 2,
  "src/security/iaaaLogin.ts": 3,
  "src/security/kvResilience.ts": 1,
  "src/security/oidcProvider.ts": 1,
  "src/security/runRevocationGate.ts": 2,
  "src/security/sessionStore.ts": 1,
  "src/security/storageRetention.ts": 2,
  "src/security/storeMetrics.ts": 1,
  "src/security/webhookReplay.ts": 1,
  "src/security/workerErrorBoundary.ts": 1,
  "src/server/routes/auth.ts": 16,
  "src/server/routes/core.ts": 3,
  "src/server/routes/messaging.ts": 3,
  "src/server/routes/privacy.ts": 2,
  "src/server/routes/queue.ts": 16,
  "src/trading/alpaca/signIn.ts": 2,
  "src/trading/channels/intake.ts": 3,
  "src/trading/dataProviders/fetchOutcome.ts": 2,
  "src/trading/email/agent.ts": 2,
  "src/trading/etrade/client.ts": 26,
  "src/trading/etrade/platform.ts": 2,
  "src/trading/etrade/quoteTrace.ts": 1,
  "src/trading/options/unifiedOptionsService.ts": 1,
  "src/trading/platformHistory.ts": 1,
  "src/trading/screenerPipeline.ts": 4,
  "src/trading/slack/agent.ts": 7,
  "src/workflows/createWorkflowPorts.ts": 2,
  "src/workflows/manualOptionsScreen.ts": 9,
  "src/workflows/optionsScreenWorkflow.ts": 1,
  "src/workflows/optionsStageSeam.ts": 1,
  "src/workflows/paymentWorkflow.ts": 9,
  "src/workflows/paymentWorkflowFlow.ts": 4,
  "src/workflows/sagaWorkflow.ts": 2,
  "src/workflows/screenRunAspects.ts": 1,
  "src/workflows/screenerWorkflow.ts": 3,
  "src/workflows/screenerWorkflowFlow.ts": 1,
  "src/workflows/screenerWorkflowRoutes.ts": 3,
  "src/workflows/stageBoundaryEmitter.ts": 1,
  "src/workflows/stageQueueTransport.ts": 2,
  "src/workflows/stageReportConsumer.ts": 1,
  "src/workflows/stageReportProduction.ts": 2,
  "src/workflows/stageRunnerCheckpointAdapter.ts": 1,
  "src/workflows/strategyScreenPorts.ts": 1,
  "src/workflows/workflowInstanceSeam.ts": 1,
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
