/**
 * Issue #359-17: Cloudflare Agentic Payments routes (x402 & MPP) extracted
 * from OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure
 * move - no behavior change. Slice #359-07 deliberately left this block
 * inline; this FINAL slice of the #359 orchestrator breakup extracts it,
 * leaving routeRequest a thin ordered dispatcher over
 * src/agents/routes/.
 *
 * Owns the agentic-payments block (invoked at the EXACT original position
 * in routeRequest's sequential matching sequence, between the payments
 * delegation and the premium delegation):
 *   GET      /payments/agentic/wallet             (wallet status & metrics)
 *   GET|POST /payments/agentic/auto-approve-limit (HITL threshold)
 *   POST     /payments/agentic/ledger/record      (issue #896: PaymentsAgent
 *                                                  write-through to the ledger
 *                                                  of record, mas_transactions)
 *   GET      /payments/agentic/ledger/budget-state (issue #896: BudgetGuard
 *                                                  state derived from the ledger)
 *   GET      /payments/agentic/ledger/payments    (issue #896: PaymentsAgent-
 *                                                  origin rows read back)
 *   POST     /payments/agentic/ledger/record-cfpay (issue #2019: cfpay
 *                                                  write-through — charge and
 *                                                  one-time credit rows, session
 *                                                  screener-payment:<runId>)
 *   POST     /payments/agentic/ledger/record-native (issue #2192: native
 *                                                  write-through — charge and
 *                                                  one-time credit rows in D1,
 *                                                  session screener-payment-native:
 *                                                  <runId>, same 409 dedupe
 *                                                  contract as record-cfpay)
 *   GET      /payments/agentic/ledger/cfpay       (issue #2019: cfpay-origin
 *                                                  rows for one run, for
 *                                                  reconciliation)
 *   GET      /payments/agentic/ledger/cfpay-revenue (issue #2022: cfpay
 *                                                  revenue report — ledger
 *                                                  totals, audit-joined
 *                                                  family/coverage
 *                                                  attribution)
 *   GET|POST /payments/agentic/commercial/*       (issues #2015/#2020/#2022:
 *                                                  minimal commercial account
 *                                                  store, tenant settings,
 *                                                  credit redemption, and the
 *                                                  dedicated paid-submission
 *                                                  route)
 *   GET|POST /payments/agentic/commercial/plans   (issues #2020/#2127:
 *                                                  subscription plans as
 *                                                  operator data)
 *   GET|POST /payments/agentic/commercial/subscription/*
 *                                                  (issues #2020/#2127:
 *                                                  subscription checkout,
 *                                                  purchase, cancel, status;
 *                                                  issue #3244: operator
 *                                                  subscription grant)
 *
 * Each route constructs the ETradeAgenticPaymentService per request,
 * exactly as the inline block did. The handler ends with an explicit
 * `return null` - never undefined (a non-GET/POST method on the
 * auto-approve-limit path still falls through, as before).
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * AgenticPaymentsRouteContext parameter; there are no new globals and no
 * back-references into the class. The limit-update audit event stays
 * funneled through the single-owner audit() via the context.
 */

import { ETradeAgenticPaymentService } from "../../services/agenticPayments";
import { recordTraceHopBestEffort } from "../../data/createMeshTracePorts";
import { deterministicSpanId } from "../../observability/meshTrace";
import {
  aggregateCfpayRevenue,
  buildCfpayChargeTransaction,
  buildCfpayCreditTransaction,
  cfpayLedgerSessionId,
  isCfpayLedgerRow,
} from "../../services/cfpayLedger";
import {
  buildLedgerTransaction,
  deriveBudgetGuardState,
  findPaymentsAgentRowByKey,
  isPaymentsAgentRow,
  toPaymentRecord,
} from "../../payments/ledger";
import { AGENT_DIDS } from "../did";
import type { DatabaseORM } from "../../orm";
import type { AgentName, Env } from "../../types";
import {
  paymentsConfigErrorEvent,
  resolvePaymentsSwitchByKey,
  type PaymentsModeValues,
  type PaymentsScopedModes,
  type PaymentsSurfaceMode,
} from "../../config/agenticPaymentsModes";
import {
  buildPaymentWorkflowParams,
  deliverPaymentVerifiedViaHost,
  startPaymentWorkflowViaBinding,
  type PaymentWorkflowBinding,
  type PaymentWorkflowHost,
} from "../../services/paymentWorkflowSubmission";
import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import { cfpayA2AOperation, cfpaySendEmail, getCfpayConfig } from "../../services/cfpayA2A";
import { NATIVE_PAYMENT_DISCLOSURE } from "../../services/nativeMonetization";
import {
  deriveNetworkMarker,
  resolveBrowserPaymentScope,
  type StripeDisplayMode,
} from "../../services/checkoutDisplay";
import { createCheckoutPorts, type CheckoutEnv } from "../../services/createCheckoutPorts";
import { isCheckoutPortGuardError } from "../../services/checkoutPortErrors";
import { createBillingCheckoutPorts, type BillingCheckoutEnv } from "../../services/createBillingCheckoutPorts";
import { createBillingPorts, type BillingEnv } from "../../services/createBillingPorts";
import { StripePaymentStrategy } from "../../patterns/paymentStrategies";

import { PRICE_FAMILIES, PROPOSED_SEED_PRICES, assertPriceFamily, type PriceEntry, type PriceFamily } from "../../data/priceCataloguePorts";
import {
  createPriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../../data/createPriceCataloguePorts";
import {
  createStoreOperatorsAdapter,
  ensureStoreOperatorsSchema,
} from "../../data/createStoreOperatorsPorts";
import {
  createFreeRunCounterAdapter,
  ensureFreeRunCounterSchema,
} from "../../data/createFreeRunCounterPorts";
import { FREE_RUN_FAMILIES } from "../../data/freeRunCounterPorts";
import {
  createFreeAccessGrantAdapter,
  ensureFreeAccessGrantSchema,
} from "../../data/createFreeAccessGrantPorts";
import { assertFreeAccessGrantInput } from "../../data/freeAccessGrantPorts";
import {
  createReferralCodeAdapters,
  ensureReferralCodeSchema,
  type ReferralCodeAdapters,
} from "../../data/createReferralCodePorts";
import {
  assertReferralCodeIssuer,
  assertReferralCodeKind,
  isTenantAdminForTenant,
  type ReferralCodeIssuer,
} from "../../data/referralCodePorts";
import { createApprovedFreeQuotaAdapter } from "../../data/createApprovedFreeQuotaPorts";
import {
  APPROVED_FREE_QUOTA_FAMILIES,
  ApprovedFreeQuotaError,
  approvedFreeQuotaPeriodKey,
} from "../../data/approvedFreeQuotaPorts";
// logAspectEvent is imported once below (main's #3572 claim-before-credit
// block) — the slice's duplicate import here was removed in the rebase
// onto 33f741a4 to avoid TS2300.
import {
  assertOperatorLogin,
  type EffectiveOperatorEntry,
} from "../../data/storeOperatorsPorts";
import { buildScenario, GOAL_TAXONOMY } from "../../services/goalScenarioEngine";
import { buildGoalScreenCommand } from "../../services/goalScreenWorkflowSubmission";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../../data/createCommercialPorts";
import {
  createJournalAdapter,
  ensureJournalSchema,
} from "../../data/createJournalPorts";
import {
  createNativeLedgerAdapter,
  ensureNativeLedgerSchema,
} from "../../data/createNativeLedgerPorts";
import { parseNativeRail } from "../../data/nativeLedgerPorts";
import {
  mapChargeToJournalEntries,
  mapRedemptionToJournalEntries,
  mapSubscriptionPurchaseToJournalEntries,
  mapTopUpToJournalEntries,
} from "../../data/journalPorts";
import { postJournalBestEffort } from "../../services/journalPosting";
import type { D1CommercialAdapter } from "../../data/d1CommercialAdapter";
import {
  assertUnlimitedFreeGrant,
  isUnlimitedFreeGrantActive,
  toCommercialAccount,
  type StoreTier,
} from "../../data/commercialPorts";
import {
  createSubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../../data/createSubscriptionPorts";
import {
  createBillingPolicyAdapter,
  ensureBillingPolicySchema,
} from "../../data/createBillingPolicyPorts";
import type { D1BillingPolicyAdapter } from "../../data/d1BillingPolicyAdapter";
import {
  createBillingCustomerAdapter,
  ensureBillingCustomerSchema,
} from "../../data/createBillingCustomerPorts";
import type { D1BillingCustomerAdapter } from "../../data/d1BillingCustomerAdapter";
import { annualPriceUSD, assertBillingPolicyPartial } from "../../data/billingPolicyPorts";
import {
  applyBillingWebhookEvent,
  cancelBillingAtPeriodEnd,
  cancelBillingImmediately,
  changeBillingPlanPrice,
  isBillingManaged,
  recordBillingSubscription,
  type BillingWebhookEvent,
} from "../../services/billingService";
import {
  createRefundPorts,
  ensureRefundSchema,
  type RefundPorts,
} from "../../data/createRefundPorts";
import { REFUND_POLICY_COPY } from "../../data/refundPorts";
import {
  createSubscriptionPaymentResolver,
  decideRefund,
  executeRefund,
  requestRefund,
} from "../../services/refundService";
import { createPayPerRunPaymentResolver } from "../../services/refundPaymentIntent";
import { PaymentGatewayService } from "../../services/payments";
import {
  codedMessage,
  resolveOutcome,
  BusinessError,
} from "../../outcomes/outcomeAspects";
import {
  confirmChannelPurchase,
  mintChannelPurchase,
  reconcileChannel,
  type CfpayChannelClient,
} from "../../services/cfpayChannel";
import {
  createTopUpDraftAdapter,
  ensureTopUpSchema,
} from "../../data/createTopUpPorts";
import type { D1TopUpAdapter } from "../../data/d1TopUpAdapter";
import {
  assertTopUpAmountUSD,
  assertTopUpRail,
  TopUpClaimRefusedError,
} from "../../data/topUpPorts";
import { logAspectEvent } from "../../aspects/loggingAspect";
import {
  createChannelDraftAdapter,
  ensureChannelSchema,
} from "../../data/createCfpayChannelPorts";
import type { ChannelDraft } from "../../data/cfpayChannelPorts";
import type { D1SubscriptionAdapter } from "../../data/d1SubscriptionAdapter";
import { isPlanPriceApproved, resolveEffectiveTier, resolveTierTransition, type SubscriptionPlanRecord } from "../../data/subscriptionPorts";
import {
  NO_ACCOUNT_PAID_MESSAGE,
  resolvePlatformIdentity,
  toPlatformIdentityView,
} from "../../services/platformIdentity";
import {
  readUsageBilling,
  USAGE_BILLING_DEFAULT_LIMIT,
} from "../../services/usageBillingSurface";
import { ensureUsageEventsTable } from "../../services/scheduledReports";
import { activateSubscription, grantSubscription, assertPlanEffectiveAndApprovedForSegment } from "../../services/subscriptionActivation";
import { activateTrialSubscription, trialStartedMessage } from "../../services/trialSubscriptionActivation";
import {
  createProductAdapter,
  ensureProductSchema,
} from "../../data/createProductPorts";
import type { D1ProductAdapter } from "../../data/d1ProductAdapter";
import { FREE_PRODUCT_ID, assertProductRank, perRunProductId, resolveEffectiveVersion } from "../../data/productPorts";
import { moveSubscriptionToVersion, runBulkMove, setAccountSegment } from "../../services/versionMoves";
import {
  createOfferSuppressionAdapter,
  ensureOfferSuppressionSchema,
} from "../../data/createOfferSuppressionPorts";
import { assertOfferTrigger, type OfferTrigger } from "../../data/offerSuppressionPorts";
import { parseOfferContext, resolveOffer } from "../../services/upgradeOffers";
import {
  createRunsPackAdapters,
  ensureRunsPackSchema,
  type RunsPackAdapters,
} from "../../data/createRunsPackPorts";
import {
  assertRunsPackPriceUSD,
  assertRunsPackRail,
  assertRunsPackRuns,
  RunsPackClaimRefusedError,
  type RunsPackVersion,
} from "../../data/runsPackPorts";
import { activateRunsPack } from "../../services/runsPackActivation";
import {
  createLifecycleAdapter,
  ensureLifecycleSchema,
} from "../../data/createLifecyclePorts";
import type { D1LifecycleAdapter } from "../../data/d1LifecycleAdapter";
import {
  applyUnsubscribe,
  sendDailyDigest,
  sendWelcomeBestEffort,
  signUnsubscribeToken,
  type EmailSender,
} from "../../services/lifecycleEmail";
import { sendDueDigests } from "../../services/lifecycleDigestPass";
import { createDigestContentProvider } from "../../services/digestContentProvider";
import { readReports } from "../../data/createAuditReportPorts";
import { digestDayKey } from "../../data/lifecyclePorts";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { sessionStore } from "../../security/session";
import type { MembershipStore } from "../../security/authorization";
import type { KvLike } from "../../security/kvResilience";
import {
  issueReferralCode,
  publicCodeView,
  redeemReferralCode,
  ReferralCodeCapExceededError,
  ReferralCodeCreditStuckError,
  ReferralCodeInvalidError,
  ReferralCodeRuleUnavailableError,
  ReferralCodeScopeRefusedError,
} from "../../services/referralCodes";
import {
  convertReferralCreditsForRun,
  recordFirstPaidRunEarning,
} from "../../services/referralCredits";
import { createWorkflowPorts, type WorkflowEnv } from "../../workflows/createWorkflowPorts";
import { tryStartScreenerWorkflow } from "../../workflows/screenerWorkflowRoutes";
import type { WorkflowJobCommand } from "../../workflows/workflowPorts";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/agenticPayments",
});

/** The subset of OrchestratorAgent surface the agentic-payments handlers need. */
export interface AgenticPaymentsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /**
   * Issue #3922: optional per-login settings reader (owner:
   * OrchestratorAgent — the readSettingRaw idiom), forwarded
   * to the workflow-start backstop: a redeemed command can
   * carry the non-deterministic mode, so its gate resolves
   * through the stored layer here too. Absent → env-only.
   */
  readSettingRaw?: ((key: string) => string | null) | undefined;
  /**
   * Issue #3307: test seams for the referral-code tenant-admin
   * path (the adminTenantQueues.ts precedent). Production reads
   * the SessionStore KV; tests inject an in-memory KV + store.
   * Absent → sessionStore(ctx.env). Any failure building or
   * reading them fails the tenant-admin check closed (403).
   */
  referralCodeAliasKv?: KvLike;
  /** Test seam: use this store instead of the SessionStore KV membership store. */
  referralCodeMembershipStore?: MembershipStore;
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Audit funnel (owner: OrchestratorAgent.audit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /**
   * #1728: optional session/user carriers for the wallet switch
   * (run comes from the per-request `mode` / `?mode=`, global env
   * from `env`). Populated by the execution-context owner; unset
   * carriers fall through to env. See
   * src/config/agenticPaymentsModes.ts.
   */
  scopedPaymentsModes?: PaymentsScopedModes;
}

/**
 * #1728: resolves the wallet switch for a route in run > session >
 * user > env > builtin order. An invalid winning value fails closed
 * to the route legacy and is logged + audited as payment.config_error
 * (agent "payments").
 */
function resolveAgenticRouteMode(
  ctx: AgenticPaymentsRouteContext,
  key: keyof PaymentsModeValues,
  run: unknown,
  legacy: PaymentsSurfaceMode
): PaymentsSurfaceMode {
  const envRecord = ctx.env as unknown as Record<string, unknown> | undefined;
  const { resolved, switchName } = resolvePaymentsSwitchByKey(
    ctx.scopedPaymentsModes,
    key,
    run,
    envRecord?.[AGENTIC_ROUTE_SWITCH_NAMES[key]],
    legacy
  );
  if (resolved.invalid) {
    structuredLog.error("agenticPayments.payments_mode_config_invalid", {
      message: `[payments] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`,
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
    ctx.audit(paymentsConfigErrorEvent(), "payments", {
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/** Env var name per switch key (for the env level lookup above). */
const AGENTIC_ROUTE_SWITCH_NAMES: Record<keyof PaymentsModeValues, string> = {
  create: "PAYMENTS_CREATE_MODE",
  confirm: "PAYMENTS_CONFIRM_MODE",
  transactions: "PAYMENTS_TRANSACTIONS_MODE",
  wallet: "AGENTIC_WALLET_MODE",
  screener: "PREMIUM_SCREENER_MODE",
  research: "PREMIUM_RESEARCH_MODE",
};

/**
 * Issue #3357: the one coded-outcome response shape for plan / annual /
 * discount outcomes — {code, message, retryable} with the catalog
 * httpStatus. The message is resolved from the outcome catalog, never
 * hand-written per call site; unknown codes pass through unresolved
 * (the resolver never invents a code).
 */
function codedOutcomeResponse(code: string): Response {
  const resolved = resolveOutcome(code);
  return Response.json(
    { code: resolved.code, message: resolved.businessMessage, retryable: resolved.entry?.retryable ?? false },
    { status: resolved.entry?.httpStatus ?? 500 },
  );
}

/**
 * Issue #2667: the coded-error body for the usage/billing reader —
 * {code, message} with the catalog httpStatus. The message is the
 * catalog business message via codedMessage ([CODE] message), never
 * raw store text.
 */
function usageBillingCoded(code: string): Response {
  const resolved = resolveOutcome(code);
  return Response.json(
    { code, message: codedMessage(code) },
    { status: resolved.entry?.httpStatus ?? 500 },
  );
}

/**
 * Handles the Cloudflare Agentic Payments routes. Returns a Response on
 * match, null when neither agentic path matches (the orchestrator then
 * continues its sequential matching).
 */
export async function handleAgenticPaymentsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AgenticPaymentsRouteContext
): Promise<Response | null> {
  // ==========================================
  // Cloudflare Agentic Payments (x402 & MPP)
  // ==========================================

  // Agentic Wallet Status & Micropayment Metrics
  if ((path.endsWith("/payments/agentic/wallet") || path.includes("/payments/agentic/wallet")) && request.method === "GET") {
    try {
      // #1728: mode "mcp" adopts the MCP status shape
      // ({success: true, ...status}); mode "rest" (legacy) keeps
      // the raw status.
      const walletMode = resolveAgenticRouteMode(ctx, "wallet", url.searchParams.get("mode"), "rest");
      const paymentService = new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId);
      const status = await paymentService.getWalletStatus();
      return Response.json(walletMode === "mcp" ? { success: true, ...status } : status);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to fetch wallet status" }, { status: 500 });
    }
  }

  // Issue #896: PaymentsAgent ledger write-through. mas_transactions in
  // THIS instance's store is the single payment ledger of record; the
  // PaymentsAgent Durable Object no longer keeps its own blob ledger.
  // The duplicate check and the insert below are deliberately
  // synchronous with no await between them: this Durable Object is
  // single-threaded, so check+insert is atomic here — two concurrent
  // verified payments with distinct keys both persist, and a replayed
  // key can never slip a second row past the facilitator-await window
  // that broke the old read-modify-write blob ledger (#785).
  if (path.endsWith("/payments/agentic/ledger/record") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        agentId?: unknown;
        operation?: unknown;
        amountCents?: unknown;
        idempotencyKey?: unknown;
        payer?: unknown;
        proofSignature?: unknown;
        caller?: unknown;
        traceId?: unknown;
        createdAt?: unknown;
      };
      const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
      const operation = typeof body.operation === "string" ? body.operation.trim() : "";
      const idempotencyKey =
        typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
      const amountCents = Number(body.amountCents);
      if (!agentId || !operation || !idempotencyKey || !Number.isFinite(amountCents) || amountCents <= 0) {
        return Response.json(
          { error: "agentId, operation, idempotencyKey and a positive amountCents are required" },
          { status: 400 }
        );
      }
      const orm = ctx.getOrm();
      const existing = findPaymentsAgentRowByKey(orm.transactions.findMany(), idempotencyKey);
      if (existing) {
        return Response.json({ duplicate: true, record: toPaymentRecord(existing) }, { status: 409 });
      }
      const tx = buildLedgerTransaction(
        {
          agentId,
          operation,
          amountCents: Math.floor(amountCents),
          idempotencyKey,
          payer: typeof body.payer === "string" ? body.payer : undefined,
          proofSignature: typeof body.proofSignature === "string" ? body.proofSignature : undefined,
          createdAt: typeof body.createdAt === "string" ? body.createdAt : undefined,
        },
        AGENT_DIDS.PAYMENTS
      );
      orm.transactions.create(tx);
      ctx.audit("payments_agent.recorded", "payments", {
        transactionId: tx.id,
        agentId,
        operation,
        amountCents: Math.floor(amountCents),
        idempotencyKey,
        // Two-part attribution (issue #2426): beside the spending
        // agentId (part 1 — the identity the caller named, required
        // since #2327), the caller the A2A edge authenticated
        // (part 2), when the payment arrived over that door. The
        // caller value reaches this handler only through the
        // PaymentsAgent ledger forward: the dispatch builds it from
        // the edge attribution, never from the external request
        // body, so it cannot be asserted by the caller.
        ...(typeof body.caller === "string" && body.caller.length > 0
          ? { caller: body.caller }
          : {}),
        // Mesh trace (issue #2428): beside the caller, the W3C
        // trace id the payment's dispatch threaded from the
        // edge traceparent — same provenance discipline as the
        // caller (it reaches this handler only through the
        // PaymentsAgent ledger forward, never asserted by the
        // external caller), and shape-checked as a trace id.
        ...(typeof body.traceId === "string" && /^[0-9a-f]{32}$/.test(body.traceId)
          ? { traceId: body.traceId }
          : {}),
      });
      // Issue #2428: the ledger hop on the payment's trace —
      // the write above is the hop's evidence. Best-effort,
      // recorded only when the forward carried a valid trace
      // id; the span is deterministic on the idempotency key
      // so a replayed record converges instead of duplicating.
      if (typeof body.traceId === "string" && /^[0-9a-f]{32}$/.test(body.traceId)) {
        await recordTraceHopBestEffort(ctx.env, {
          traceId: body.traceId,
          spanId: deterministicSpanId(`ledger:${idempotencyKey}`),
          kind: "ledger",
          operation: "payments_agent.recorded",
          timestampMs: Date.now(),
          caller: typeof body.caller === "string" ? body.caller : undefined,
          agent: "PaymentsAgent",
          note: operation,
        });
      }
      return Response.json({ duplicate: false, record: toPaymentRecord(tx) });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to record payment in ledger" }, { status: 500 });
    }
  }

  // Issue #2019: cfpay ledger write-through. mas_transactions in THIS
  // instance's store is the single payment ledger of record; the
  // PaymentWorkflow (via the ORCHESTRATOR_AGENT channel) records cfpay
  // charge and credit rows here. Deliberately separate from the #896
  // record endpoint: that endpoint builds PaymentsAgent-origin x402
  // rows only, and reusing it for cfpay would mislabel gateway and
  // session. Dedupe mirrors #896 and is atomic for the same reason
  // (this Durable Object is single-threaded): one charge row and one
  // credit row per run — a replayed write returns 409 with the
  // existing row instead of a second row.
  if (path.endsWith("/payments/agentic/ledger/record-cfpay") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        kind?: unknown;
        runRequestId?: unknown;
        userId?: unknown;
        family?: unknown;
        priceUSD?: unknown;
        checkoutId?: unknown;
        claimTxHash?: unknown;
        paymentIntentId?: unknown;
      };
      const kind = body.kind === "credit" ? "credit" : body.kind === "charge" ? "charge" : "";
      const runRequestId = typeof body.runRequestId === "string" ? body.runRequestId.trim() : "";
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const family = typeof body.family === "string" ? body.family.trim() : "";
      const priceUSD = Number(body.priceUSD);
      if (!kind || !runRequestId || !userId || !family || !Number.isFinite(priceUSD) || priceUSD <= 0) {
        return Response.json(
          { error: "kind (charge|credit), runRequestId, userId, family and a positive priceUSD are required" },
          { status: 400 },
        );
      }
      const orm = ctx.getOrm();
      const sessionId = cfpayLedgerSessionId(runRequestId);
      const existing = orm
        .transactions.findMany()
        .find((t) => t.sessionId === sessionId && t.action === kind);
      if (existing) {
        return Response.json({ duplicate: true, record: existing }, { status: 409 });
      }
      const tx =
        kind === "charge"
          ? buildCfpayChargeTransaction({
              runRequestId,
              userId,
              family,
              priceUSD,
              checkoutId: typeof body.checkoutId === "string" ? body.checkoutId : undefined,
              claimTxHash: typeof body.claimTxHash === "string" ? body.claimTxHash : undefined,
              paymentIntentId:
                typeof body.paymentIntentId === "string" ? body.paymentIntentId : undefined,
            })
          : buildCfpayCreditTransaction({ runRequestId, userId, family, priceUSD });
      orm.transactions.create(tx);
      ctx.audit("payments_cfpay.recorded", "payments", {
        transactionId: tx.id,
        runRequestId,
        kind,
        priceUSD,
      });
      return Response.json({ duplicate: false, record: tx });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to record cfpay payment in ledger" }, { status: 500 });
    }
  }

  // Issue #2192: native-origin rows for one run, written to
  // D1 (not mas_transactions) via the NativeLedgerPort. The
  // dedupe contract is IDENTICAL to record-cfpay above: one
  // charge row and one credit row per run — a replayed write
  // returns 409 with the existing row instead of a second
  // row. Differences from record-cfpay, all deliberate: the
  // gateway is truthful per rail (body `rail`, defaulting by
  // reference — a claim tx hash means x402, otherwise card),
  // the session prefix is screener-payment-native:, and
  // tenantId is required (native rows are tenant-scoped from
  // day one; the cfpay endpoint predates tenant scoping).
  // This endpoint RECORDS ONLY: no gate reads these rows
  // until slice 1, and no payment behavior changes here.
  // An unbound AGENT_DB fails closed with 503 — the store
  // cannot be verified, so no row is claimed recorded.
  if (path.endsWith("/payments/agentic/ledger/record-native") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        kind?: unknown;
        runRequestId?: unknown;
        tenantId?: unknown;
        userId?: unknown;
        family?: unknown;
        priceUSD?: unknown;
        rail?: unknown;
        sessionId?: unknown;
        paymentIntentId?: unknown;
        claimTxHash?: unknown;
      };
      const kind = body.kind === "credit" ? "credit" : body.kind === "charge" ? "charge" : "";
      const runRequestId = typeof body.runRequestId === "string" ? body.runRequestId.trim() : "";
      const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const family = typeof body.family === "string" ? body.family.trim() : "";
      const priceUSD = Number(body.priceUSD);
      const rail =
        parseNativeRail(body.rail) ??
        (typeof body.claimTxHash === "string" && body.claimTxHash.trim() ? "x402" : "stripe");
      if (
        !kind ||
        !runRequestId ||
        !tenantId ||
        !userId ||
        !family ||
        !Number.isFinite(priceUSD) ||
        priceUSD <= 0
      ) {
        return Response.json(
          { error: "kind (charge|credit), runRequestId, tenantId, userId, family and a positive priceUSD are required" },
          { status: 400 },
        );
      }
      if (body.rail !== undefined && parseNativeRail(body.rail) === null) {
        return Response.json(
          { error: 'rail must be "stripe" or "x402" when supplied' },
          { status: 400 },
        );
      }
      const adapter = createNativeLedgerAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!adapter) {
        return Response.json(
          { error: "native ledger unavailable: AGENT_DB is not bound" },
          { status: 503 },
        );
      }
      await ensureNativeLedgerSchema(adapter.db);
      const { row, duplicate } = await adapter.recordRow({
        kind,
        runRequestId,
        tenantId,
        userId,
        family,
        priceUSD,
        rail,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        paymentIntentId:
          typeof body.paymentIntentId === "string" ? body.paymentIntentId : undefined,
        claimTxHash: typeof body.claimTxHash === "string" ? body.claimTxHash : undefined,
      });
      if (duplicate) {
        return Response.json({ duplicate: true, record: row }, { status: 409 });
      }
      ctx.audit("payments_native.recorded", "payments", {
        transactionId: row.id,
        runRequestId,
        kind,
        priceUSD,
      });
      return Response.json({ duplicate: false, record: row });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to record native payment in ledger" }, { status: 500 });
    }
  }

  // Issue #2019: cfpay-origin rows for one run, read back for
  // reconciliation (cfpay checkout.status vs mas_transactions on
  // run-request id + checkout id + tx hash / payment intent id).
  if (path.endsWith("/payments/agentic/ledger/cfpay") && request.method === "GET") {
    try {
      const runRequestId = (url.searchParams.get("runRequestId") ?? "").trim();
      if (!runRequestId) {
        return Response.json({ error: "runRequestId is required" }, { status: 400 });
      }
      const sessionId = cfpayLedgerSessionId(runRequestId);
      const rows = ctx
        .getOrm()
        .transactions.findMany()
        .filter((t) => t.sessionId === sessionId);
      return Response.json({ runRequestId, count: rows.length, rows });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list cfpay ledger rows" }, { status: 500 });
    }
  }

  // Issue #2022: cfpay revenue report. Money is authoritative from
  // the mas_transactions charge/credit rows; family and coverage
  // attribution come from the mas_events payment payloads joined on
  // run id, with explicit "unknown" buckets where an audit row is
  // missing (audit writes are best-effort, so attribution can lag
  // the ledger — totals never do). Cost-per-run is NOT reported
  // here: no per-run cost accounting exists yet to report against.
  if (path.endsWith("/payments/agentic/ledger/cfpay-revenue") && request.method === "GET") {
    try {
      const orm = ctx.getOrm();
      const cfpayRows = orm.transactions.findMany().filter(isCfpayLedgerRow);
      const charges = cfpayRows.filter((t) => t.action === "charge");
      const credits = cfpayRows.filter((t) => t.action === "credit");
      const payloadsOf = (type: string): Array<Record<string, unknown>> =>
        orm.events.findMany({ where: { type } }).map((e) => {
          const raw = (e as { payload?: unknown }).payload;
          if (raw && typeof raw === "object") return raw as Record<string, unknown>;
          try {
            return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
          } catch {
            return {};
          }
        });
      const report = aggregateCfpayRevenue(
        charges,
        credits,
        payloadsOf("payment.confirmed"),
        payloadsOf("payment.covered"),
        payloadsOf("payment.failure_credit_issued"),
      );
      return Response.json(report);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to build cfpay revenue report" }, { status: 500 });
    }
  }

  // ================================================================
  // Issues #2015/#2020/#2022: commercial account store on Drizzle
  // D1, tenant settings, credit redemption (#2019), and the
  // dedicated paid-submission route (no CTO collision: this route
  // never touches ScheduledTasksService or the #1997-2000 unified
  // run-request path; CTO wires into it later).
  //
  // Trust model, stated once for the whole block:
  // - x-user-login reaching this handler is session-verified
  //   (server.ts sets it from the session for /api/*, 401 without
  //   a session). Identity is that login; nothing here trusts a
  //   body-supplied userId.
  // - D1 is SHARED across instances, so there is no canonical-
  //   instance hop: the handler builds the store adapter straight
  //   from env.AGENT_DB. An unbound AGENT_DB fails closed on money
  //   paths (503) — the store cannot be verified, so no run starts
  //   and no balance is read as Free.
  // - Operator writes require effective operator status: env
  //   COMMERCIAL_STORE_OPERATORS UNION the store list (#2680;
  //   empty = deny all). The consume/redeem/unredeemed-credit HTTP endpoints
  //   from the earlier DO-store draft are gone: with D1, the
  //   payment adapter and the submit route call the port directly,
  //   so no hop-only endpoint needs to exist.
  // ================================================================
  const commercialLogin = (): string | null => {
    const login = request.headers.get("x-user-login");
    return login && login.trim() ? login.trim() : null;
  };
  // Issue #2680: effective operators = env list UNION store
  // list. The env list is parsed once per request; the store
  // list is preloaded once per request (one indexed SELECT) so
  // every isStoreOperator call site below stays synchronous.
  // When AGENT_DB is unbound, or the store read fails (e.g. the
  // 0032 table is not yet migrated), the store set is empty and
  // the check degrades to env-only — exactly today's behavior,
  // never a 500, never a lockout. Env operators are the
  // bootstrap fallback; store operators are the managed list.
  const envOperatorLogins = (): Set<string> => {
    const raw = (ctx.env as unknown as Record<string, unknown>)["COMMERCIAL_STORE_OPERATORS"];
    if (typeof raw !== "string" || !raw.trim()) return new Set();
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  };
  const envOperators = envOperatorLogins();
  let storeOperatorLogins = new Set<string>();
  try {
    const operatorsAdapter = createStoreOperatorsAdapter(ctx.env as { AGENT_DB?: unknown });
    if (operatorsAdapter) {
      const entries = await operatorsAdapter.listOperators();
      storeOperatorLogins = new Set(entries.map((entry) => entry.login));
    }
  } catch {
    storeOperatorLogins = new Set();
  }
  const isStoreOperator = (login: string | null): boolean => {
    if (!login) return false;
    return envOperators.has(login) || storeOperatorLogins.has(login);
  };
  // Merged effective-operator list for the management routes:
  // env rows first-class (source "env", no added-by record),
  // store rows from the adapter. A login in both lists shows
  // once as env-managed; its store row is still removable, and
  // the login stays effective via env either way. Unbound store
  // yields the env rows alone — the env list is meaningful
  // without a store. Callers handle ensure failures (503).
  const listEffectiveOperators = async (): Promise<EffectiveOperatorEntry[]> => {
    const storeAdapter = createStoreOperatorsAdapter(ctx.env as { AGENT_DB?: unknown });
    const byLogin = new Map<string, EffectiveOperatorEntry>();
    for (const login of [...envOperators].sort()) {
      byLogin.set(login, { login, source: "env", addedBy: null, addedAtMs: null });
    }
    if (storeAdapter) {
      await ensureStoreOperatorsSchema(storeAdapter.db);
      for (const entry of await storeAdapter.listOperators()) {
        if (!byLogin.has(entry.login)) {
          byLogin.set(entry.login, {
            login: entry.login,
            source: "store",
            addedBy: entry.addedBy,
            addedAtMs: entry.addedAtMs,
          });
        }
      }
    }
    return [...byLogin.values()].sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
  };
  const canAccessAccount = (login: string | null, userId: string): boolean =>
    login !== null && (login === userId || isStoreOperator(login));
  const requireStore = (): D1CommercialAdapter | Response => {
    const adapter = createCommercialAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Commercial store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };
  const requireSubs = (): D1SubscriptionAdapter | Response => {
    const adapter = createSubscriptionAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Subscription store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };
  // Issue #3289: product store, same fail-closed shape as the
  // commercial/subscription stores: unbound AGENT_DB is a 503,
  // never a silent fallback.
  const requireProducts = (): D1ProductAdapter | Response => {
    const adapter = createProductAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Product store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };
  // Issue #2656 (Phase 2.1): Billing stores, same fail-closed shape
  // as the commercial/subscription stores: unbound AGENT_DB is a
  // 503, never a silent fallback.
  const requireBillingPolicy = (): D1BillingPolicyAdapter | Response => {
    const adapter = createBillingPolicyAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Billing policy store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };
  const requireBillingCustomers = (): D1BillingCustomerAdapter | Response => {
    const adapter = createBillingCustomerAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Billing customer store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };
  const ensureBillingStores = async (
    policy: D1BillingPolicyAdapter,
    customers: D1BillingCustomerAdapter,
  ): Promise<Response | null> => {
    try {
      await ensureBillingPolicySchema(policy.db);
      await ensureBillingCustomerSchema(customers.db);
    } catch (err: any) {
      return Response.json({ error: `Billing store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
    }
    return null;
  };
  // Issue #2522: email content selection resolves the effective
  // tier the same way the premium gate does (src/agents/routes/
  // premium.ts resolvePremiumTier) — two indexed D1 point reads,
  // on send routes only, never on a hot path. The premium resolver
  // is deliberately NOT refactored here: slice 2's tested path
  // stays untouched, and the duplicated 8 lines are the cheaper
  // risk. Fail direction: unbound → Free (no rows can exist
  // without a store); present-but-failing → THROW, and the caller
  // refuses with a typed 503 — mail must never go out on an
  // unknown tier.
  const resolveEmailTier = async (userId: string): Promise<StoreTier> => {
    const store = createCommercialAdapter(ctx.env as { AGENT_DB?: unknown });
    const subs = createSubscriptionAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!store || !subs) return "Free";
    // A fresh DB may hold lifecycle tables but no commercial
    // tables yet (the welcome is a provisioning trigger and can
    // precede any account route): ensure first, so "no rows"
    // reads as Free instead of a missing-table throw. An ensure
    // failure throws, and the caller maps it to the typed 503 —
    // the same fail direction as a read failure.
    await ensureCommercialSchema(store.db);
    await ensureSubscriptionSchema(subs.db);
    const account = await store.getAccount(userId);
    const subscriptions = await subs.listSubscriptions(userId);
    return resolveEffectiveTier(account, subscriptions, Date.now());
  };
  // Issue #2208: lifecycle store (referral credits, notification
  // preferences, digest guard). Same fail-closed shape as the
  // commercial store: unbound AGENT_DB is a 503, never a silent
  // fallback — except the welcome send, which is best-effort by
  // design (see sendWelcomeBestEffort).
  const requireLifecycle = (): D1LifecycleAdapter | Response => {
    const adapter = createLifecycleAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Lifecycle store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };
  const ensureLifecycle = async (
    lifecycle: D1LifecycleAdapter,
  ): Promise<Response | null> => {
    try {
      await ensureLifecycleSchema(lifecycle.db);
    } catch (err: any) {
      return Response.json({ error: `Lifecycle store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
    }
    return null;
  };
  // Issue #2208: lifecycle mail sender, reusing the existing
  // delivery paths (cfpay A2A email first, env.EMAIL fallback —
  // the research-delivery pattern). No new mail transport.
  const lifecycleSender = (): EmailSender | null => {
    const cfpay = getCfpayConfig(ctx.env);
    if (cfpay) {
      return {
        send: async ({ to, subject, body }) => {
          const r = await cfpaySendEmail(cfpay, to, subject, body);
          return r.ok ? { ok: true } : { ok: false, error: r.error ?? "cfpay email failed" };
        },
      };
    }
    const emailBinding = (ctx.env as unknown as Record<string, unknown>)["EMAIL"] as
      | { send?: (input: { from: string; to: string; subject: string; text: string }) => Promise<unknown> }
      | undefined;
    if (emailBinding && typeof emailBinding.send === "function") {
      const localSend = emailBinding.send;
      return {
        send: async ({ to, subject, body }) => {
          try {
            await localSend({
              from: "noreply@agent.openaimp.com",
              to,
              subject,
              text: body,
            });
            return { ok: true };
          } catch (err: any) {
            return { ok: false, error: err?.message ?? "local email send failed" };
          }
        },
      };
    }
    return null;
  };
  // Issue #2208: unsubscribe-token secret (NAME only — the value
  // is a worker secret, never in code). Unbound means digests go
  // out without an unsubscribe link, and the unsubscribe route
  // fails closed (503).
  const unsubscribeSecret = (): string | null => {
    const raw = (ctx.env as unknown as Record<string, unknown>)["LIFECYCLE_UNSUBSCRIBE_SECRET"];
    return typeof raw === "string" && raw ? raw : null;
  };
  // Money paths fail CLOSED when the monetization flag is OFF:
  // no checkout is minted and no purchase activates. This mirrors
  // the live-assurance guard (flag OFF → 403).
  const requireMonetization = async (): Promise<Response | null> => {
    const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
    if (!flagOn) {
      return Response.json({ error: "monetization flag is OFF; subscription purchase is disabled." }, { status: 403 });
    }
    return null;
  };
  // Refund routes share the same flag gate with a refund-specific
  // message. Policy reads/writes below are NOT flag-gated:
  // operators configure policy before activation.
  const requireRefundFlag = async (): Promise<Response | null> => {
    const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
    if (!flagOn) {
      return Response.json({ error: "monetization flag is OFF; refunds are disabled." }, { status: 403 });
    }
    return null;
  };
  const requireRefunds = (): RefundPorts | Response => {
    const ports = createRefundPorts(ctx.env as { AGENT_DB?: unknown });
    if (!ports) {
      return Response.json({ error: "Refund store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return ports;
  };
  // Both stores, schema ensured. Money routes call this before
  // any read or write: the account upsert writes tier_source
  // (migration 0008), so the commercial write path needs 0008
  // applied too, not just 0007.
  const ensureStores = async (
    store: D1CommercialAdapter,
    subs: D1SubscriptionAdapter,
  ): Promise<Response | null> => {
    try {
      await ensureCommercialSchema(store.db);
      await ensureSubscriptionSchema(subs.db);
    } catch (err: any) {
      return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
    }
    return null;
  };

  // GET /payments/agentic/commercial/account?userId=
  if (path.endsWith("/payments/agentic/commercial/account") && request.method === "GET") {
    try {
      const login = commercialLogin();
      const userId = url.searchParams.get("userId") ?? "";
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) {
        return Response.json({ error: "Forbidden: only the account owner or a store operator may read an account." }, { status: 403 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const record = await store.getAccount(userId);
      // Effective tier, not just the stored baseline: a lapsed
      // subscription stops conferring Subscribed, while an
      // operator grant survives. A subscription-read failure
      // degrades to the stored tier (display value only — the
      // money paths below fail closed instead).
      let subscriptions: Array<{ periodEndMs: number }> = [];
      try {
        subscriptions = await subs.listSubscriptions(userId);
      } catch {
        subscriptions = [];
      }
      const effectiveTier = resolveEffectiveTier(record, subscriptions, Date.now());
      return Response.json({ record, effectiveTier });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read commercial account" }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/identity (#2219, program
  // #2218 slice 1) — SELF-ONLY read of the caller's platform
  // identity for the payment screen's read-only display. The
  // subject is always the verified session login: there is no
  // userId parameter, so no other user's data can be requested
  // through this endpoint. Returns tenantId (null when no store
  // row exists), userLogin, the effective tier, and a coverage
  // summary (credits, included runs). A missing row is not an
  // error here — hasAccount false is the display truth.
  // Callers decide separately: pay-per-run submit fails closed
  // on it, while subscription checkout/purchase auto-provision
  // at activation (see those routes).
  if (path.endsWith("/payments/agentic/commercial/identity") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const identity = await resolvePlatformIdentity(
        { commercial: store, subscriptions: subs },
        { userId: login, nowMs: Date.now() },
      );
      return Response.json(toPlatformIdentityView(identity));
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read platform identity" }, { status: 503 });
    }
  }

  // GET /payments/agentic/commercial/usage-billing (issue #2667,
  // Phase 2.12) — ONE read-only, session-bound usage/billing reader:
  // the caller's metered calls (readReceipts, slice 4), included-run
  // + credit balances (platform identity, #2219), subscriptions
  // (2.1), refunds (2.7), and referral balance (2.2) together.
  // Self-only: the subject is always commercialLogin(); there is no
  // userId parameter. No new tables, no new writes; per-row
  // provenance is derived by the service, never asserted. No money
  // totals across mixed provenance. Failures are coded catalog
  // bodies, never raw store text; reads are aspect-logged, not
  // audit-trailed (a read is not a state change).
  if (path.endsWith("/payments/agentic/commercial/usage-billing") && request.method === "GET") {
    const login = commercialLogin();
    if (!login) {
      logAspectEvent({
        aspect: "UsageBilling",
        operationName: "usage-billing.read",
        code: "FAILURE_USAGE_BILLING_NOT_SIGNED_IN",
        level: "warn",
        message: "usage/billing read without a signed-in session",
      });
      return usageBillingCoded("FAILURE_USAGE_BILLING_NOT_SIGNED_IN");
    }
    const rawLimit = url.searchParams.get("limit");
    let limit = USAGE_BILLING_DEFAULT_LIMIT;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        logAspectEvent({
          aspect: "UsageBilling",
          operationName: "usage-billing.read",
          code: "FAILURE_USAGE_BILLING_INVALID_LIMIT",
          level: "warn",
          message: "usage/billing read with an invalid limit",
          metadata: { userLogin: login, limit: rawLimit },
        });
        return usageBillingCoded("FAILURE_USAGE_BILLING_INVALID_LIMIT");
      }
      limit = parsed;
    }
    try {
      const store = requireStore();
      if (store instanceof Response) return usageBillingCoded("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
      const subs = requireSubs();
      if (subs instanceof Response) return usageBillingCoded("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
      const refunds = requireRefunds();
      if (refunds instanceof Response) return usageBillingCoded("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return usageBillingCoded("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
      const ensured = await ensureStores(store, subs);
      if (ensured) return usageBillingCoded("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
      const ensuredLifecycle = await ensureLifecycle(lifecycle);
      if (ensuredLifecycle) return usageBillingCoded("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
      await ensureRefundSchema(refunds.store.db);
      const orm = ctx.getOrm();
      // #2779: ensure usage_events before the read — a zero-receipt
      // account must read empty, never 500 on a missing table.
      ensureUsageEventsTable(orm.getSql());
      const view = await readUsageBilling(
        { sql: orm.getSql(), orm, store, subs, refunds, lifecycle },
        login,
        { limit },
      );
      logAspectEvent({
        aspect: "UsageBilling",
        operationName: "usage-billing.read",
        code: "SUCCESS_USAGE_BILLING_READ",
        level: "info",
        message: "usage/billing read",
        metadata: {
          userLogin: login,
          receipts: view.usage.receipts.length,
          subscriptions: view.billing.subscriptions.length,
          refunds: view.billing.refunds.length,
        },
      });
      return Response.json(view);
    } catch (err: any) {
      logAspectEvent({
        aspect: "UsageBilling",
        operationName: "usage-billing.read",
        code: "FAILURE_USAGE_BILLING_STORE_UNAVAILABLE",
        level: "error",
        message: "usage/billing read failed",
        error: err instanceof Error ? err.message : String(err),
        metadata: { userLogin: login },
      });
      return usageBillingCoded("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
    }
  }

  // POST /payments/agentic/commercial/account (operator only)
  if (path.endsWith("/payments/agentic/commercial/account") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        userId?: unknown; tenantId?: unknown; tier?: unknown; creditsUSD?: unknown; includedRuns?: unknown;
        unlimitedFreeGrant?: unknown;
      };
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      // Issue #2522: tier-change audit — read the before rows so
      // the audit can state previous → new effective tier. The
      // upsert changes no subscription rows, so the after side
      // reuses the same subscription list.
      const upsertUserId = typeof body.userId === "string" ? body.userId : "";
      const previousAccount = await store.getAccount(upsertUserId);
      const previousSubscriptions = await subs.listSubscriptions(upsertUserId);
      // Issue #3245: an unlimited-free grant write on this route.
      // The grant target is the operator-action subject (userId in
      // the body, same pattern as the credits-adjust route); the
      // tenant for the grant comes from the TARGET's account row,
      // never from a client-supplied tenantId — a grant write on
      // an existing row keeps that row's tenant even when the body
      // names another. grantedBy is the session-verified operator
      // login, never a client-supplied value. Absent
      // unlimitedFreeGrant preserves the stored grant; explicit
      // null revokes it. A grant object is validated before any
      // write, so a bad grant is 400 and grants nothing.
      const grantUpdate =
        body.unlimitedFreeGrant === undefined
          ? undefined
          : body.unlimitedFreeGrant === null
            ? null
            : assertUnlimitedFreeGrant({
                ...(typeof body.unlimitedFreeGrant === "object" && body.unlimitedFreeGrant !== null
                  ? (body.unlimitedFreeGrant as Record<string, unknown>)
                  : {}),
                grantedBy: login,
              });
      const record = await store.upsertAccount({
        userId: upsertUserId,
        tenantId:
          grantUpdate !== undefined && previousAccount
            ? previousAccount.tenantId
            : typeof body.tenantId === "string"
              ? body.tenantId
              : "",
        tier: body.tier,
        // An operator write is an operator grant: it survives a
        // lapsed subscription (see resolveEffectiveTier).
        tierSource: "operator",
        creditsUSD: body.creditsUSD,
        includedRuns: body.includedRuns,
        unlimitedFreeGrant: grantUpdate,
      });
      const transition = resolveTierTransition(previousAccount, previousSubscriptions, record, previousSubscriptions, Date.now());
      ctx.audit("commercial.account.upserted", "payments", {
        userId: record.id,
        tenantId: record.tenantId,
        tier: record.tier,
        previousEffectiveTier: transition.previousEffectiveTier,
        newEffectiveTier: transition.newEffectiveTier,
      });
      if (grantUpdate !== undefined) {
        ctx.audit(
          grantUpdate === null
            ? "commercial.account.unlimited_free_revoked"
            : "commercial.account.unlimited_free_granted",
          "payments",
          {
            userId: record.id,
            tenantId: record.tenantId,
            grantedBy: login,
            ...(grantUpdate === null
              ? {}
              : { reason: grantUpdate.reason, expiresAtMs: grantUpdate.expiresAtMs }),
          },
        );
      }
      return Response.json({ record });
    } catch (err: any) {
      const message = err.message || "Failed to upsert commercial account";
      return Response.json({ error: message }, { status: /requires|Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // POST /payments/agentic/commercial/account/credits (operator only)
  if (path.endsWith("/payments/agentic/commercial/account/credits") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { userId?: unknown; deltaUSD?: unknown };
      const userId = typeof body.userId === "string" ? body.userId : "";
      const deltaUSD = Number(body.deltaUSD);
      if (!userId || !Number.isFinite(deltaUSD)) {
        return Response.json({ error: "userId and a finite deltaUSD are required." }, { status: 400 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const record = await store.adjustCredits(userId, deltaUSD);
      ctx.audit("commercial.account.credits_adjusted", "payments", { userId, deltaUSD });
      return Response.json({ record });
    } catch (err: any) {
      const message = err.message || "Failed to adjust credits";
      return Response.json({ error: message }, { status: /No commercial account|below zero/.test(message) ? 400 : 500 });
    }
  }

  // Issue #3315 (sub-issue of #3241) — free-run allowance
  // routes (operator only). The allowance is platform-wide
  // operator data, one row per family in
  // agent_free_run_allowances (migration 0043, seeded by
  // migration 0044): it is read and written ONLY through the
  // free-run counter port (getAllowance / setAllowance) — no
  // second allowance source, no code constant anywhere. A
  // family with no stored row reads as null and the gate
  // treats it as "no free runs for that family" (fail-closed);
  // the GET therefore returns nulls honestly instead of
  // inventing a value. The counter is composed straight from
  // env.AGENT_DB (D1 is shared, no canonical-instance hop);
  // unbound AGENT_DB fails closed with 503, like the other
  // money paths. The ensure applies migrations 0043+0044
  // idempotently (INSERT OR IGNORE seeding, so an operator
  // edit survives).
  const requireFreeRunCounter = async () => {
    const counter = createFreeRunCounterAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!counter) {
      return Response.json({ error: "Free-run counter unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    await ensureFreeRunCounterSchema(counter.db);
    return counter;
  };

  // GET /payments/agentic/commercial/free-run-allowance (operator only)
  if (path.endsWith("/payments/agentic/commercial/free-run-allowance") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: only a store operator may read the free-run allowance." }, { status: 403 });
      }
      const counter = await requireFreeRunCounter();
      if (counter instanceof Response) return counter;
      const allowances = [];
      for (const family of FREE_RUN_FAMILIES) {
        allowances.push({ family, runs: await counter.getAllowance(family) });
      }
      return Response.json({ allowances });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read the free-run allowance" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/free-run-allowance (operator only)
  if (path.endsWith("/payments/agentic/commercial/free-run-allowance") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { family?: unknown; runs?: unknown };
      const counter = await requireFreeRunCounter();
      if (counter instanceof Response) return counter;
      // setAllowance validates: unknown family → "Invalid price
      // family", non-integer or negative runs → "must be a
      // non-negative integer" — both surface as 400 below.
      const runs = await counter.setAllowance({ family: body.family, runs: body.runs });
      const family = typeof body.family === "string" ? body.family : "";
      ctx.audit("commercial.free_run_allowance.set", "payments", { family, runs, operator: login });
      return Response.json({ family, runs });
    } catch (err: any) {
      const message = err.message || "Failed to set the free-run allowance";
      return Response.json({ error: message }, { status: /requires|Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // Issue #3263 (sub-issue of #3256) — approved-free per-service
  // quota routes. The quota bounds the operator-granted
  // unlimited-free entitlement (#3245) with a per-service cap per
  // period plus the grant's limited-time window. All values are
  // operator data in D1 (migrations 0054 tables + 0055 seeds: 10
  // runs per service per month, monthly window, upgrade-or-buy-
  // credits at the limit — PROPOSED defaults); no quota number,
  // window, or at-limit action lives in code. Reads and writes go
  // ONLY through the quota port — no second quota source. The
  // tenant is server-resolved from the account row; no
  // client-supplied tenantId parameter exists. Unbound AGENT_DB
  // fails closed with 503, like the other money paths. The ensure
  // applies migrations 0054+0055 idempotently (INSERT OR IGNORE
  // seeding, so an operator edit survives).
  //
  // AOP (#2381): every quota failure is a catalog-coded body
  // {error: businessMessage, code, retryable} — the failure kind
  // is recorded structurally at the point of failure (the port
  // assert / adapter read throws ApprovedFreeQuotaError with its
  // kind), the route maps kind to code, the panel renders the
  // catalog businessMessage (#2573 precedent). No raw error text
  // reaches a client from these routes. The 401/403 plain bodies
  // keep the file-wide convention shared by all commercial routes
  // (not quota-specific outcomes; coding them is a file-wide
  // change, out of this slice's scope).
  const quotaErrorBody = (code: string): Response => {
    const outcome = resolveOutcome(code);
    return Response.json(
      {
        error: outcome.businessMessage ?? code,
        code: outcome.code,
        retryable: outcome.entry?.retryable ?? false,
      },
      { status: outcome.entry?.httpStatus ?? 500 },
    );
  };

  const requireApprovedFreeQuota = async () => {
    const quota = createApprovedFreeQuotaAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!quota) {
      return quotaErrorBody("FAILURE_APPROVED_FREE_QUOTA_UNAVAILABLE");
    }
    // Port method, not a store handle: the adapter ensures its own
    // schema (Hexagonal, standards §7.1).
    await quota.ensureSchema();
    return quota;
  };

  // GET /payments/agentic/commercial/approved-free-quota?userId= — own or operator.
  if (path.endsWith("/payments/agentic/commercial/approved-free-quota") && request.method === "GET") {
    // Issue #3263 (CI fix): userId is declared outside the try so the
    // catch block can name it in the aspect log — a const declared
    // inside try is out of scope in catch (tsc: no value in scope).
    let userId = "";
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      userId = url.searchParams.get("userId") || login;
      if (!canAccessAccount(login, userId)) {
        return Response.json({ error: "Forbidden: only the account owner or a store operator may read the approved-free quota." }, { status: 403 });
      }
      const quota = await requireApprovedFreeQuota();
      if (quota instanceof Response) return quota;
      const store = requireStore();
      if (store instanceof Response) return store;
      // The account read selects tier_source, which migration 0008
      // adds — that migration rides with the subscription schema,
      // so ensure both stores like GET /subscription does. Without
      // the subscription ensure, a never-provisioned account reads
      // 500 ("no such column: tier_source").
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const account = await store.getAccount(userId);
      const settings = await quota.getSettings();
      const grant = account?.unlimitedFreeGrant ?? null;
      const grantActive = isUnlimitedFreeGrantActive(grant, Date.now());
      const tenantId = account?.tenantId ?? null;
      const period = settings ? approvedFreeQuotaPeriodKey(Date.now(), settings.windowKind) : null;
      const families = [];
      for (const family of APPROVED_FREE_QUOTA_FAMILIES) {
        const cap = await quota.getCap(family);
        const used = tenantId && period ? await quota.getUsed({ tenantId, login: userId, family, period }) : 0;
        families.push({ family, cap, used, remaining: cap === null ? null : Math.max(0, cap - used), period });
      }
      return Response.json({
        userId,
        tenantId,
        settings,
        period,
        families,
        grant: { active: grantActive, expiresAtMs: grant?.expiresAtMs ?? null },
      });
    } catch (err: any) {
      if (err instanceof ApprovedFreeQuotaError) return quotaErrorBody(err.code);
      logAspectEvent({
        aspect: "ApprovedFreeQuota",
        operationName: "read-quota",
        code: "FAILURE_UNEXPECTED_ERROR",
        level: "error",
        message: "Approved-free quota read failed.",
        error: err instanceof Error ? err.message : String(err),
        metadata: { userId },
      });
      return quotaErrorBody("FAILURE_UNEXPECTED_ERROR");
    }
  }

  // POST /payments/agentic/commercial/approved-free-quota (operator only)
  if (path.endsWith("/payments/agentic/commercial/approved-free-quota") && request.method === "POST") {
    // Issue #3263 (CI fix): login is declared outside the try so the
    // catch block can name it in the aspect log — a const declared
    // inside try is out of scope in catch (tsc: cannot find name).
    let login: string | null = null;
    try {
      login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { family?: unknown; capRuns?: unknown; windowKind?: unknown; atLimitAction?: unknown };
      const quota = await requireApprovedFreeQuota();
      if (quota instanceof Response) return quota;
      // One thing per call: a cap, the window, or the at-limit action.
      // Both writes are idempotent upserts keyed by family / the
      // single settings row: a replay with identical values returns
      // the same 200 with the same state (safe retry); a replay
      // with different values is a new operator intent and wins
      // (last-write-wins, with updatedAtMs/updatedBy on the row and
      // an audit record). The POST never claims exactly-once from
      // an id — the upsert itself is the dedup (tech-standards §7.2).
      if (body.family !== undefined || body.capRuns !== undefined) {
        const capRuns = await quota.setCap({ family: body.family, capRuns: body.capRuns, updatedBy: login });
        const family = typeof body.family === "string" ? body.family : "";
        const code = "SUCCESS_APPROVED_FREE_QUOTA_UPDATED";
        const message = resolveOutcome(code).businessMessage ?? code;
        ctx.audit("commercial.approved_free_quota.set", "payments", {
          family,
          capRuns,
          operator: login,
          outcomeCode: code,
          message,
        });
        return Response.json({ family, capRuns, code, message });
      }
      if (body.windowKind !== undefined || body.atLimitAction !== undefined) {
        const settings = await quota.setSettings({ windowKind: body.windowKind, atLimitAction: body.atLimitAction, updatedBy: login });
        const code = "SUCCESS_APPROVED_FREE_QUOTA_UPDATED";
        const message = resolveOutcome(code).businessMessage ?? code;
        ctx.audit("commercial.approved_free_quota_settings.set", "payments", {
          ...settings,
          operator: login,
          outcomeCode: code,
          message,
        });
        return Response.json({ settings, code, message });
      }
      return quotaErrorBody("FAILURE_APPROVED_FREE_QUOTA_MISSING_UPDATE");
    } catch (err: any) {
      if (err instanceof ApprovedFreeQuotaError) return quotaErrorBody(err.code);
      logAspectEvent({
        aspect: "ApprovedFreeQuota",
        operationName: "set-quota",
        code: "FAILURE_UNEXPECTED_ERROR",
        level: "error",
        message: "Approved-free quota write failed.",
        error: err instanceof Error ? err.message : String(err),
        metadata: { operator: login ?? "" },
      });
      return quotaErrorBody("FAILURE_UNEXPECTED_ERROR");
    }
  }

  // GET /payments/agentic/commercial/tenant-settings?tenantId= (operator only)
  if (path.endsWith("/payments/agentic/commercial/tenant-settings") && request.method === "GET") {
    try {
      const login = commercialLogin();
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!tenantId) return Response.json({ error: "tenantId is required." }, { status: 400 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: only a store operator may read tenant settings." }, { status: 403 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      return Response.json({ tenantId, adsEnabled: await store.getTenantAdsEnabled(tenantId) });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read tenant settings" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/tenant-settings (operator only)
  if (path.endsWith("/payments/agentic/commercial/tenant-settings") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { tenantId?: unknown; adsEnabled?: unknown };
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      if (!tenantId || typeof body.adsEnabled !== "boolean") {
        return Response.json({ error: "tenantId and a boolean adsEnabled are required." }, { status: 400 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const record = await store.setTenantAdsEnabled(tenantId, body.adsEnabled);
      ctx.audit("commercial.tenant_settings.set", "payments", { tenantId, adsEnabled: body.adsEnabled });
      return Response.json({ record });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to set tenant settings" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/submit — the dedicated
  // paid-submission route. One-off runs only: scheduleKind
  // "recurring" is refused (recurring schedules are created via
  // the schedule service, not here — no CTO collision). The route
  // never starts a screener for free: a new run goes through the
  // payment workflow (which enforces the gate), and a redeemed run
  // starts only after its credit claim is atomically redeemed.
  // Email is the caller's checkout contact, supplied by the caller
  // — it is NOT an identity proof. Identity is the verified
  // x-user-login; no verified email exists in the session.
  if (path.endsWith("/payments/agentic/commercial/submit") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        family?: unknown; trigger?: unknown; scheduleKind?: unknown; authorizedAtSubmission?: unknown;
        tenantId?: unknown; screenerCommand?: unknown; email?: unknown;
      };
      const family = body.family;
      // #2219 fix (session scoped always): a client-supplied
      // tenantId is untrusted input, never identity — it is not
      // read anywhere in this route. The run's tenant comes from
      // the resolved identity (the stored account row for the
      // verified login) or, on the flag-OFF free path with no
      // account, from the verified session login itself.
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const trigger = body.trigger === undefined ? "manual" : body.trigger;
      const screenerCommand = body.screenerCommand as { jobId?: unknown } | undefined;
      if (family !== "stock" && family !== "goal" && family !== "options" && family !== "strategy") {
        return Response.json({ error: "family must be stock, goal, options, or strategy." }, { status: 400 });
      }
      if (!email) return Response.json({ error: "email (checkout contact) is required." }, { status: 400 });
      if (trigger !== "manual" && trigger !== "scheduled") {
        return Response.json({ error: "trigger must be manual or scheduled." }, { status: 400 });
      }
      if (body.scheduleKind === "recurring") {
        return Response.json({ error: "Recurring schedules are created via the schedule service, not this route." }, { status: 400 });
      }
      if (body.scheduleKind !== undefined && body.scheduleKind !== "one_off") {
        return Response.json({ error: "scheduleKind must be one_off when given." }, { status: 400 });
      }
      if (!screenerCommand || typeof screenerCommand.jobId !== "string") {
        return Response.json({ error: "screenerCommand with a jobId is required." }, { status: 400 });
      }
      const runRequestId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

      // D1 store, schema ensured. A store failure fails closed:
      // without the account, coverage cannot be verified, so no
      // run starts — and without the claims table, a credit cannot
      // be checked, so no run is charged either.
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      // #2219: tenant derivation. The resolved identity wins over
      // any client-supplied tenantId, even on mismatch — there is
      // no mismatch refusal anymore because the client value is
      // never trusted in the first place. Resolution failure fails
      // CLOSED (no run starts on unverified coverage).
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      let monetizationOn: boolean;
      try {
        monetizationOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      } catch {
        return Response.json({ error: "Monetization state unavailable; no run starts." }, { status: 503 });
      }
      let tenantId: string;
      if (identity.hasAccount) {
        // Resolved identity wins, unconditionally.
        tenantId = identity.tenantId as string;
      } else if (monetizationOn) {
        // PROPOSED no-account behavior (#2219): a paid path with
        // no resolved account fails closed, directing the user to
        // account setup — never an invented account or tenant.
        return Response.json({ error: NO_ACCOUNT_PAID_MESSAGE }, { status: 403 });
      } else {
        // Free path (flag OFF), session scoped always: the scope
        // label is the verified session login. A client-supplied
        // tenantId is never read here, in any path — no anonymous
        // tenant is invented, and no account row is created.
        tenantId = login;
      }
      const account = { ...toCommercialAccount(login, identity.stored, email, tenantId), tier: identity.tier };
      // #2219 fix (session scoped always): the screener command's
      // tenant is stamped from the session-derived tenant above,
      // exactly like userLogin — a client-supplied tenantId inside
      // screenerCommand (e.g. via the goal-command route, which
      // only builds a draft command and starts nothing) must never
      // survive into a run, because the screener workflow projects
      // under command.tenantId. This stamped command is used by
      // both the credit-redemption start and the payment workflow
      // below, so no path starts a run under a caller-chosen tenant.
      const verifiedCommand = {
        ...(screenerCommand as Record<string, unknown>),
        userLogin: login,
        tenantId,
      } as WorkflowJobCommand;

      // Failure-credit redemption, if one exists for this family.
      const credit = await store.findUnredeemedCredit(login, family);
      if (credit) {
        // Pre-check the screener port before claiming: claiming
        // first and then failing to start would burn the credit.
        // The claim itself (primary-key insert) is the atomic guard
        // against two concurrent submissions spending one credit;
        // a lost race falls through to the payment path below.
        if (!createWorkflowPorts(ctx.env as unknown as WorkflowEnv)) {
          return Response.json({ error: "Screener workflow port unavailable; credit not redeemed, retry later." }, { status: 503 });
        }
        let redeemed = false;
        try {
          await store.redeemCredit(credit.creditRunId, runRequestId);
          redeemed = true;
        } catch (err: any) {
          if (!/already redeemed/.test(err.message || "")) {
            return Response.json({ error: `Credit redemption failed: ${err.message || "unknown error"}` }, { status: 503 });
          }
        }
        if (redeemed) {
          const handle = await tryStartScreenerWorkflow(ctx.env, verifiedCommand, { readSettingRaw: ctx.readSettingRaw });
          if (!handle) {
            // Residual gap, stated plainly: the credit is claimed
            // but no run started. The audit row below is the
            // operator's re-issue signal; there is no operator
            // credit-issue route yet.
            ctx.audit("commercial.redeem.start_failed", "payments", { runRequestId, creditRunId: credit.creditRunId, userId: login });
            return Response.json({ error: "Credit redeemed but the screener could not start; an operator must re-issue.", runRequestId, creditRedeemed: true }, { status: 503 });
          }
          ctx.audit("commercial.credit.redeemed", "payments", { runRequestId, creditRunId: credit.creditRunId, family, userId: login });
          // Issue #2137 follow-ups: record the submission owner
          // (verified session login) so submission-status can
          // enforce owner-only reads. BEST-EFFORT here, like the
          // journal post below: the run already started and the
          // credit is already spent, so a record failure must not
          // fail a delivered run — it is a loud log + audit row,
          // and the status read then fails closed (404) for it.
          try {
            await store.recordPaidSubmission({ workflowId: handle.workflowId, userId: login, runRequestId });
          } catch (err: any) {
            structuredLog.error("agenticPayments.paid_submission_record_failed", {
              message: `[payments] paid-submission record failed for ${handle.workflowId}: ${err?.message || "unknown error"}`,
              workflowId: handle.workflowId,
              runRequestId,
              error: err?.message || "unknown error",
            });
            ctx.audit("commercial.submission.record_failed", "payments", { runRequestId, workflowId: handle.workflowId, userId: login });
          }
          // Issue #2155: project the redemption into the D1 journal
          // (Dr 2000 / Cr 4000 — the replacement run is delivered).
          // BEST-EFFORT, never thrown: the run already started and
          // the credit is already claimed; a journal failure is a
          // loud log + a reconcile flag. Posted only on start
          // success, never on the start_failed path above.
          // Issue #3289: the redemption records the product/version
          // of the charge the credit replaces (§3.9). A legacy
          // claim (pre-0058, no product/version) skips the journal
          // entry with a loud log — the run already started and
          // the credit is already spent, so a journal failure
          // must not fail a delivered run.
          if (credit.productId && credit.versionId) {
            await postJournalBestEffort(async () => {
              const adapter = createJournalAdapter(ctx.env as { AGENT_DB?: unknown });
              if (!adapter) return null;
              await ensureJournalSchema(adapter.db);
              return adapter;
            }, mapRedemptionToJournalEntries({
              transactionRef: runRequestId,
              tenantId,
              runRequestId,
              family,
              amountUSD: credit.amountUSD,
              productId: credit.productId,
              versionId: credit.versionId,
            }));
          } else {
            structuredLog.error("agenticPayments.redemptionJournalSkipped", {
              message: `[payments] redemption journal entry skipped for run=${runRequestId} (claim ${credit.creditRunId} has no product/version — pre-0058 claim); credit already redeemed.`,
              runRequestId,
              creditRunId: credit.creditRunId,
            });
          }
          return Response.json({ runRequestId, status: "redeemed_started", creditRunId: credit.creditRunId, workflowId: handle.workflowId });
        }
      }

      // Issue #2208: referral-credit conversion, AFTER the
      // failure-credit block and BEFORE the payment workflow.
      // Ordering (deliberate): existing coverage wins first —
      // a Subscribed included run, or a commercial credit
      // balance that already covers the price, spends before
      // any referral credit is touched. Only when commercial
      // coverage is short AND the vested referral balance covers
      // the FULL price does conversion happen: exactly priceUSD
      // of referral credit is redeemed and topped up into the
      // commercial account, and the refreshed account is what
      // the gate below sees — so the run still goes through the
      // EXISTING gate + consumeCoverage path (paidVia
      // "credits"), with zero gate changes and no parallel
      // bypass. A partial referral balance stays untouched (a
      // partial discount needs gate work, deferred). Flag OFF
      // skips conversion entirely: with the flag off the run
      // is free anyway, and converting would burn referral
      // credit for a free run. A conversion failure fails
      // CLOSED (503, no payment workflow, no run); the redeem
      // already happened by the fail-safe ordering in
      // convertReferralCreditsForRun, and its error names the
      // earning rows as the operator reconcile signal.
      // Price source (rebuild adaptation): the run price now
      // lives in the operator price catalogue (migration 0011),
      // not the removed FAMILY_PRICES map — so the price is
      // read from the catalogue here. An unknown price skips
      // conversion and lets the gate below (which reads the
      // same catalogue) fail closed itself; it never guesses
      // a price and never falls back to a code constant.
      if (identity.tier !== "Subscribed" || (identity.stored?.includedRuns ?? 0) <= 0) {
        let priceUSD: number | null = null;
        try {
          const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
          if (catalogue) priceUSD = await catalogue.getPrice(family);
        } catch {
          priceUSD = null;
        }
        if (priceUSD !== null) {
          const commercialCovered = (identity.stored?.creditsUSD ?? 0) >= priceUSD;
          if (!commercialCovered) {
            const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
            if (flagOn) {
              const lifecycle = requireLifecycle();
              if (lifecycle instanceof Response) return lifecycle;
              const lifecycleEnsured = await ensureLifecycle(lifecycle);
              if (lifecycleEnsured) return lifecycleEnsured;
              const referralBalance = await lifecycle.redeemableBalance(login);
              if (referralBalance >= priceUSD) {
                try {
                  const converted = await convertReferralCreditsForRun({
                    lifecycle,
                    commercial: store,
                    userId: login,
                    tenantId,
                    amountUSD: priceUSD,
                    runRequestId,
                  });
                  // The gate reads the caller-built account, not a
                  // fresh store read — refresh it from the topped-up
                  // store row, or the gate would miss the conversion.
                  const refreshed = await store.getAccount(login);
                  if (refreshed) account.creditsUSD = refreshed.creditsUSD;
                  ctx.audit("commercial.referral.converted", "payments", {
                    runRequestId,
                    userId: login,
                    redeemedUSD: converted.redeemedUSD,
                    family,
                  });
                } catch (err: any) {
                  return Response.json({ error: `Referral conversion failed: ${err.message || "unknown error"}` }, { status: 503 });
                }
              }
            }
          }
        }
      }

      const params = buildPaymentWorkflowParams({
        runRequestId,
        family,
        trigger,
        scheduleKind: body.scheduleKind as "one_off" | undefined,
        authorizedAtSubmission: body.authorizedAtSubmission === true,
        tenantId,
        userId: login,
        email,
        account,
        // Issue #2137 + #2219 fix: the command's owner AND tenant
        // are stamped from the verified session (see
        // verifiedCommand above) — a caller-supplied owner or
        // tenant must not survive into the workflow.
        screenerCommand: verifiedCommand,
      });
      // Issue #2137 follow-ups: record the submission owner
      // BEFORE starting the workflow, so a record failure fails
      // closed (503) with nothing started — never an orphaned
      // workflow whose status no owner can read. The binding
      // creates the instance with id = runRequestId, so the
      // workflowId is known here; if the binding ever returns a
      // different id, that id is recorded too, below.
      try {
        await store.recordPaidSubmission({ workflowId: runRequestId, userId: login, runRequestId });
      } catch (err: any) {
        return Response.json({ error: `Submission could not be recorded: ${err.message || "unknown error"}` }, { status: 503 });
      }
      try {
        const binding = ctx.env.PAYMENT_WORKFLOW as unknown as PaymentWorkflowBinding | undefined;
        const started = await startPaymentWorkflowViaBinding(binding, params);
        if (started.workflowId !== runRequestId) {
          // Binding broke the id = runRequestId contract: record
          // the returned id best-effort (the workflow already
          // started, so this must not fail the submission).
          try {
            await store.recordPaidSubmission({ workflowId: started.workflowId, userId: login, runRequestId });
          } catch (recordErr: any) {
            structuredLog.error("agenticPayments.paid_submission_record_failed", {
              message: `[payments] paid-submission record failed for ${started.workflowId}: ${recordErr?.message || "unknown error"}`,
              workflowId: started.workflowId,
              runRequestId,
              error: recordErr?.message || "unknown error",
            });
            ctx.audit("commercial.submission.record_failed", "payments", { runRequestId, workflowId: started.workflowId, userId: login });
          }
        }
        // Issue #2657: automatic referral earn, AFTER the payment
        // workflow started. The earn event is the referred user's first
        // PAID run: the monetization flag must be ON (a flag-OFF free
        // run is not a paid run — the workflow start alone does not
        // prove payment), and the failure-credit early return above
        // already excludes replacement runs (compensation, not
        // payment). BEST-EFFORT by design: the run already started,
        // so an earn failure must never fail it — a loud log + an
        // earn_failed audit row is the operator's reconcile signal,
        // the same pattern as recordPaidSubmission above. The port's
        // recordEarning is idempotent per referred user, so repeat
        // submits no-op; the earned audit fires only when the row
        // is new (earnedAtMs at or after this trigger's start),
        // never as a replay claim.
        if (monetizationOn) {
          try {
            const earnLifecycle = requireLifecycle();
            if (!(earnLifecycle instanceof Response)) {
              const earnEnsured = await ensureLifecycle(earnLifecycle);
              if (!earnEnsured) {
                const attribution = await earnLifecycle.getAttribution(login);
                if (attribution) {
                  if (attribution.tenantId !== tenantId) {
                    ctx.audit("commercial.referral.earn_failed", "payments", {
                      runRequestId,
                      referredUserId: login,
                      reason: "attribution tenant mismatch: referral credits never cross tenants",
                    });
                  } else {
                    const triggerStartMs = Date.now();
                    const earning = await recordFirstPaidRunEarning(earnLifecycle, {
                      referrerUserId: attribution.referrerUserId,
                      referredUserId: login,
                      tenantId,
                    });
                    if (earning.earnedAtMs >= triggerStartMs) {
                      ctx.audit("commercial.referral.earned", "payments", {
                        referrerUserId: earning.referrerUserId,
                        referredUserId: earning.referredUserId,
                        amountUSD: earning.amountUSD,
                        trigger: "auto",
                        runRequestId,
                      });
                    }
                  }
                }
              }
            }
          } catch (err: any) {
            structuredLog.error("agenticPayments.referral_auto_earn_failed", {
              message: `[payments] referral auto-earn failed for ${login}: ${err?.message ?? "unknown error"}`,
              referredUserId: login,
              runRequestId,
              error: err?.message ?? "unknown error",
            });
            ctx.audit("commercial.referral.earn_failed", "payments", {
              runRequestId,
              referredUserId: login,
              reason: err?.message ?? "unknown error",
            });
          }
        }
        return Response.json({ runRequestId, workflowId: started.workflowId, status: "payment_started" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Payment workflow could not start; no screener started." }, { status: 503 });
      }
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to submit paid run" }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/submission-status?workflowId=
  // Issue #2137 follow-ups: ownership is enforced, not assumed.
  // A workflowId is no longer proof of anything — any verified
  // caller could guess or replay one — so the read first checks
  // the paid-submission record the submit route wrote at submit
  // time: unknown submission → 404, another user's submission →
  // 403, store unavailable → 503. Only the recorded owner reaches
  // the workflow binding. The binding read itself is unchanged.
  if (path.endsWith("/payments/agentic/commercial/submission-status") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const workflowId = url.searchParams.get("workflowId") ?? "";
      if (!workflowId) return Response.json({ error: "workflowId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      try {
        await ensureCommercialSchema(store.db);
      } catch (err: any) {
        return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      let submission;
      try {
        submission = await store.getPaidSubmission(workflowId);
      } catch (err: any) {
        return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      if (!submission) return Response.json({ error: "Submission not found." }, { status: 404 });
      if (submission.userId !== login) {
        return Response.json({ error: "Forbidden: this submission belongs to another user." }, { status: 403 });
      }
      const binding = ctx.env.PAYMENT_WORKFLOW as unknown as { get(id: string): Promise<unknown> } | undefined;
      if (!binding || typeof binding.get !== "function") {
        return Response.json({ error: "Payment workflow binding is not configured." }, { status: 503 });
      }
      let status = "unknown";
      let outcome: string | undefined;
      let outcomeCode: string | undefined;
      try {
        const instance = await binding.get(workflowId);
        const statusFn = (instance as { status?: unknown }).status;
        if (typeof statusFn === "function") {
          const result = (await (statusFn as () => Promise<unknown>).call(instance)) as { status?: unknown; output?: unknown } | string | null;
          status =
            typeof result === "string"
              ? result
              : result && typeof result === "object" && typeof result.status === "string"
                ? result.status
                : "unknown";
          // Issue #3263: surface the completed workflow output when
          // the binding status carries one (same output-object
          // convention as sagaStatus.ts) — the poller maps
          // outcome === "quota_exhausted" to the catalog message.
          // Existing {workflowId, status} is unchanged otherwise.
          if (result && typeof result === "object" && result.output && typeof result.output === "object") {
            const output = result.output as Record<string, unknown>;
            if (typeof output.status === "string") outcome = output.status;
            if (typeof output.outcomeCode === "string") outcomeCode = output.outcomeCode;
          }
        }
      } catch {
        status = "unknown";
      }
      return Response.json({
        workflowId,
        status,
        ...(outcome ? { outcome } : {}),
        ...(outcomeCode ? { outcomeCode } : {}),
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read submission status" }, { status: 500 });
    }
  }

  // ================================================================
  // Subscriptions (#2020/#2127, native checkout #2198 slice 2 of
  // #2146): plans as operator data, a route-owned native Stripe
  // checkout, purchase activation on verified payment, cancel-at-
  // period-end, and the effective-tier status read. No provider
  // auto-renewal exists here: Stripe Checkout is one-time-only,
  // so renewal is repurchase before expiry (stacked from the
  // latest periodEnd). No cash refunds in this slice (deferred
  // #2024, designed #2147). Money paths fail closed; the
  // monetization flag must be ON for checkout and purchase.
  // ================================================================

  // GET /payments/agentic/commercial/plans — the effective version for the caller's segment only.
  // Issue #3289: a buyer sees ONE version per product — the effective version for THEIR
  // segment — never a superseded, future, expired, or deactivated one, and never another
  // segment's version. Approval is NOT filtered here: a PROPOSED effective version stays
  // visible (the checkout refuses it); hiding it would hide the price the operator is about
  // to approve. The segment is the verified account's segment, "default" when no account
  // exists yet. A product with no effective version for the segment is absent, never shown
  // with a stale price.
  if (path.endsWith("/payments/agentic/commercial/plans") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const segment = (await store.getAccount(login))?.segment ?? "default";
      const active = await subs.listPlans(true);
      const byProduct = new Map<string, typeof active>();
      for (const plan of active) {
        const list = byProduct.get(plan.productId) ?? [];
        list.push(plan);
        byProduct.set(plan.productId, list);
      }
      const plans: typeof active = [];
      for (const versions of byProduct.values()) {
        const effective = resolveEffectiveVersion(versions, segment, Date.now());
        if (effective) plans.push(effective);
      }
      plans.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return Response.json({ plans });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list plans" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/plans (operator only) — plans are data, never code: no price is hardcoded anywhere.
  // Issue #3357: a plan may also be created by DERIVATION from a monthly plan — pass monthlyPlanId
  // with no priceUSD and periodDays 365, and the price is derived from the monthly plan price and
  // the operator-managed annual discount (monthly x 12 x (1 - discount)). An explicit priceUSD
  // overrides the derivation. Every new plan lands PROPOSED until an operator approves it
  // through POST /plans/approve; only an APPROVED plan price may be charged.
  if (path.endsWith("/payments/agentic/commercial/plans") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        id?: unknown; name?: unknown; priceUSD?: unknown; periodDays?: unknown; includedRuns?: unknown; trialDays?: unknown; monthlyPlanId?: unknown;
        /** Issue #3289: optional version fields — productId, segment, effectiveFromMs, effectiveToMs, billingPeriod, featuresJson, stripePriceId. The version NUMBER is always server-assigned, never client-supplied. */
        productId?: unknown; segment?: unknown; effectiveFromMs?: unknown; effectiveToMs?: unknown; billingPeriod?: unknown; featuresJson?: unknown; stripePriceId?: unknown;
      };
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const monthlyPlanId = typeof body.monthlyPlanId === "string" && body.monthlyPlanId.trim() ? body.monthlyPlanId.trim() : "";
      const hasExplicitPrice = body.priceUSD !== undefined && body.priceUSD !== null;
      let priceUSD = body.priceUSD;
      let annualDiscountPct: number | null = null;
      let derivedPriceUSD: number | null = null;
      if (monthlyPlanId && !hasExplicitPrice) {
        // Derive the annual price: the derived plan must be an annual plan (365 days).
        // Failure classification is structural (#2573): the kind is recorded
        // here and mapped to a catalog code, never a hand-written string.
        const periodDays = Number(body.periodDays);
        if (periodDays !== 365) {
          return codedOutcomeResponse("FAILURE_ANNUAL_PLAN_PERIOD_INVALID");
        }
        const monthly = await subs.getPlan(monthlyPlanId);
        if (!monthly) return codedOutcomeResponse("FAILURE_PLAN_NOT_FOUND");
        const billingPolicyAdapter = requireBillingPolicy();
        if (billingPolicyAdapter instanceof Response) return billingPolicyAdapter;
        await ensureBillingPolicySchema(billingPolicyAdapter.db);
        const policy = await billingPolicyAdapter.getPolicy();
        annualDiscountPct = policy.annualDiscountPct;
        derivedPriceUSD = annualPriceUSD(monthly.priceUSD, annualDiscountPct);
        priceUSD = derivedPriceUSD;
      }
      const plan = await subs.createPlan({
        id: body.id,
        name: body.name,
        priceUSD,
        periodDays: body.periodDays,
        includedRuns: body.includedRuns,
        trialDays: body.trialDays,
        // Issue #3289: a plan is a version of a product — the
        // version fields ride through; the version NUMBER is
        // server-assigned by the adapter (max+1), never the
        // body's. The adapter derives the productId from the
        // name when absent; the product row itself is ensured
        // by the route below.
        productId: body.productId,
        segment: body.segment,
        effectiveFromMs: body.effectiveFromMs,
        effectiveToMs: body.effectiveToMs,
        billingPeriod: body.billingPeriod,
        featuresJson: body.featuresJson,
        stripePriceId: body.stripePriceId,
      });
      // Issue #3289: the product row for the version's product
      // always exists after a plan create — the Products listing
      // (slice 2) reads products, not plan rows. The product is
      // name-derived (the adapter derived the same productId
      // above); a duplicate name for a different billing
      // cadence is a different product by design (monthly and
      // annual of one name are separate products, each with its
      // own version chain — the effective-version resolution is
      // per product, so one chain cannot sell both cadences).
      const products = requireProducts();
      if (products instanceof Response) return products;
      try {
        await ensureProductSchema(products.db);
        await products.getOrCreateProduct({ name: plan.name, kind: "subscription" });
      } catch (err: any) {
        // The plan is created; a product-row failure must not
        // fail the create — it is a loud log, and the next plan
        // create (or the slice-2 backfill) repairs it.
        structuredLog.error("agenticPayments.productRowEnsureFailed", {
          message: `[payments] product row ensure failed for plan ${plan.id}: ${err?.message || "unknown error"}`,
          planId: plan.id,
          error: err?.message || "unknown error",
        });
      }
      // Audit (#1969 acceptance): the record alone answers which code, what
      // happened, for which login — code + message + login + structured fields.
      const created = resolveOutcome("SUCCESS_PLAN_CREATED");
      ctx.audit("commercial.plan.created", "payments", {
        code: created.code,
        message: created.businessMessage,
        login,
        planId: plan.id,
        priceUSD: plan.priceUSD,
        periodDays: plan.periodDays,
        includedRuns: plan.includedRuns,
        trialDays: plan.trialDays ?? null,
        ...(monthlyPlanId ? { monthlyPlanId } : {}),
        ...(derivedPriceUSD !== null ? { annualDiscountPct, derivedPriceUSD } : {}),
      });
      return Response.json({ plan, code: created.code, message: created.businessMessage, retryable: created.entry?.retryable ?? false });
    } catch (err: any) {
      // A catalog-coded failure renders from the catalog; pre-existing
      // assertPlan failures keep their regex-mapped raw shape (out of
      // scope for #3357 — the route existed before this slice).
      if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
      const message = err.message || "Failed to create plan";
      return Response.json(
        { error: message },
        // Idempotent Receiver (tech-standards §7): a replay of a create
        // (same plan id) is a 409, not a 400 — the id is the unique key.
        { status: /No plan/.test(message) ? 404 : /already exists/.test(message) ? 409 : /required|must be/.test(message) ? 400 : 500 },
      );
    }
  }

  // POST /payments/agentic/commercial/plans/approve (operator only) — Issue #3357: approve a
  // plan's price, recording the approving operator. New plans land PROPOSED; only an APPROVED
  // plan price may be charged. Approving a deactivated plan is allowed (approval is about the
  // price, not about whether the plan is sold); deactivation never un-approves.
  if (path.endsWith("/payments/agentic/commercial/plans/approve") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.approvePlan(planId, login);
      const approved = resolveOutcome("SUCCESS_PLAN_APPROVED");
      ctx.audit("commercial.plan.approved", "payments", {
        code: approved.code,
        message: approved.businessMessage,
        login,
        planId: plan.id,
        approvedBy: login,
      });
      return Response.json({ plan, code: approved.code, message: approved.businessMessage, retryable: approved.entry?.retryable ?? false });
    } catch (err: any) {
      if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
      const message = err.message || "Failed to approve plan";
      return Response.json({ error: message }, { status: /No plan/.test(message) ? 404 : 500 });
    }
  }

  // POST /payments/agentic/commercial/plans/deactivate (operator only) — stops new purchases; existing subscriptions run to periodEnd.
  if (path.endsWith("/payments/agentic/commercial/plans/deactivate") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.deactivatePlan(planId);
      ctx.audit("commercial.plan.deactivated", "payments", { planId: plan.id });
      return Response.json({ plan });
    } catch (err: any) {
      const message = err.message || "Failed to deactivate plan";
      return Response.json({ error: message }, { status: /No plan/.test(message) ? 404 : 500 });
    }
  }

  // POST /payments/agentic/commercial/subscription/checkout — route-owned NATIVE Stripe checkout for a plan
  // (#2198, slice 2 of #2146; supersedes the cfpay checkout this route minted before — the cfpay
  // /a2a/payments call is gone here, and the shared cfpay helpers stay only for the slice-3 UI
  // check-payment route, which still reads cfpay until its own slice lands).
  // The route mints the checkout (draft id prefixed "sub-") through the CheckoutPort so purchase can
  // bind fulfillment to a checkout WE created for this plan, at this plan's price. The response
  // returns a real checkoutUrl for card (Stripe always provides one — this closes the no-URL gap
  // the cfpay checkout had). Email is the checkout contact, supplied by the caller — it is NOT an
  // identity proof. Identity is the verified x-user-login.
  if (path.endsWith("/payments/agentic/commercial/subscription/checkout") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown; tenantId?: unknown; email?: unknown; offerContext?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      if (!email) return Response.json({ error: "email (checkout contact) is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      // Issue #3357: only an APPROVED plan price may be charged — refuse before any provider call.
      // Fail-closed with a catalog-coded message, never a raw error string.
      if (!isPlanPriceApproved(plan)) {
        return codedOutcomeResponse("FAILURE_PLAN_PRICE_NOT_APPROVED");
      }
      // #2219 fix: the checkout tenant is the resolved identity's
      // tenant when an account exists, else the verified session
      // login itself (personal scope label). A client-supplied
      // tenantId is ignored, even on mismatch. No row is created
      // here — checkout only mints; the account row is created at
      // purchase activation, after verified payment, so a first
      // purchase needs no operator step.
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      // #2219 (rebased onto #2198's native card checkout): the tenant
      // comes from the resolved identity, never the request body; the
      // mint itself stays the native Stripe checkout.
      const tenantId = identity.tenantId ?? login;
      // Issue #3289: the buyer buys the effective, approved version
      // for THEIR segment — never a superseded, future, expired, or
      // unapproved version. Fail-closed before any provider call.
      // The segment is the verified account's segment ("default"
      // when no account exists yet).
      try {
        await assertPlanEffectiveAndApprovedForSegment(
          subs,
          plan,
          identity.stored?.segment ?? "default",
          Date.now(),
        );
      } catch (err: any) {
        return Response.json(
          { error: err.message || "Plan is not the effective approved version for your segment." },
          { status: 409 },
        );
      }
      const ports = createCheckoutPorts(ctx.env as unknown as {
        STRIPE_SECRET_KEY?: string;
        STRIPE_TEST_SECRET_KEY?: string;
        STRIPE_LIVE_SECRET_KEY?: string;
        STRIPE_MCP_SERVER_URL?: string;
        APP_BASE_URL?: string;
        X402_RECIPIENT_ADDRESS?: string;
        X402_NETWORK?: string;
        X402_FACILITATOR_URL?: string;
      });
      const card = ports?.card ?? null;
      if (!card) {
        return Response.json({ error: "Native card checkout is not configured." }, { status: 503 });
      }
      const checkoutRequestId = `sub-${crypto.randomUUID()}`;
      const created = await card.createCheckout({
        runRequestId: checkoutRequestId,
        priceUSD: plan.priceUSD,
        email,
        userId: login,
      });
      if (!created.checkoutUrl || !created.checkoutId) {
        return Response.json({ error: "Stripe checkout could not be created." }, { status: 503 });
      }
      ctx.audit("commercial.subscription.checkout_created", "payments", { userId: login, tenantId, planId: plan.id, checkoutRequestId, checkoutSessionId: created.checkoutId });
      // Issue #3246: an offer acceptance is audit-only metadata on
      // the existing mint — ignored when absent, audited when the
      // client passes a well-formed offerContext. It authorizes
      // nothing and changes no price.
      const offerContext = parseOfferContext(body.offerContext);
      if (offerContext) {
        ctx.audit("commercial.offer.accepted", "payments", {
          login,
          tenantId,
          trigger: offerContext.trigger,
          targetPlanId: plan.id,
          action: "subscribe",
          checkoutId: created.checkoutId,
          ...(offerContext.shownAtMs !== undefined ? { shownAtMs: offerContext.shownAtMs } : {}),
        });
      }
      return Response.json({
        checkoutRequestId,
        checkoutUrl: created.checkoutUrl,
        checkoutSessionId: created.checkoutId,
        plan: { id: plan.id, name: plan.name, priceUSD: plan.priceUSD, periodDays: plan.periodDays, includedRuns: plan.includedRuns },
      });
    } catch (err: any) {
      // #3573: a guard failure (timeout / breaker open) maps to its
      // catalog-coded 503; any other mint failure keeps the legacy
      // raw-error 500 behavior (unchanged).
      if (isCheckoutPortGuardError(err)) {
        return codedOutcomeResponse(err.outcomeCode);
      }
      return Response.json({ error: err.message || "Failed to create subscription checkout" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/subscription/purchase — fulfill a native subscription-mode Stripe

  // POST /payments/agentic/commercial/subscription/purchase — activate on VERIFIED payment only.
  // Fulfillment is re-read from Stripe (session retrieve), never a return page, exactly like the
  // native gate's confirm step. The caller passes BOTH the route-minted draft id (checkoutRequestId,
  // "sub-" prefix, the replay-guard key) and the Stripe session id the checkout route returned
  // (checkoutSessionId). Activation requires ALL of: session status complete, payment_status paid,
  // amount_total == plan price x 100 (the MANDATORY amount re-check the cfpay path could not do),
  // client_reference_id == checkoutRequestId, and a payment-intent id present (both ids are stored
  // on the subscription row — refunds need the payment-intent id). Any failure refuses with 402
  // and activates nothing. The checkout reference activates at most one subscription (replay → 409).
  if (path.endsWith("/payments/agentic/commercial/subscription/purchase") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown; tenantId?: unknown; checkoutRequestId?: unknown; checkoutSessionId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      const checkoutRequestId = typeof body.checkoutRequestId === "string" ? body.checkoutRequestId : "";
      const checkoutSessionId = typeof body.checkoutSessionId === "string" ? body.checkoutSessionId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      if (!checkoutRequestId) return Response.json({ error: "checkoutRequestId is required." }, { status: 400 });
      if (!checkoutRequestId.startsWith("sub-")) {
        return Response.json({ error: "checkoutRequestId must come from the subscription checkout route." }, { status: 400 });
      }
      if (!checkoutSessionId) return Response.json({ error: "checkoutSessionId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      // Issue #3357: only an APPROVED plan price may be charged — refuse before any provider call.
      // Fail-closed with a catalog-coded message, never a raw error string.
      if (!isPlanPriceApproved(plan)) {
        return codedOutcomeResponse("FAILURE_PLAN_PRICE_NOT_APPROVED");
      }
      // #2219 fix: same derivation as checkout — resolved identity
      // wins, client tenantId ignored. A missing account does NOT
      // fail closed here: after payment verification,
      // activateSubscription creates the account row in the
      // session-derived tenant (the verified login itself when no
      // row exists), restoring the pre-slice-1 auto-create
      // behavior. A first purchase therefore succeeds end-to-end
      // with no operator step, and a later identity resolution
      // finds the row. (Pay-per-run submit still fails closed on
      // no account — that path does not auto-create.) The
      // verification + activation below stay the native Stripe path
      // (#2198): the session is re-read and judged paid here.
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      const tenantId = identity.tenantId ?? login;
      const ports = createCheckoutPorts(ctx.env as unknown as {
        STRIPE_SECRET_KEY?: string;
        STRIPE_TEST_SECRET_KEY?: string;
        STRIPE_LIVE_SECRET_KEY?: string;
        STRIPE_MCP_SERVER_URL?: string;
        APP_BASE_URL?: string;
        X402_RECIPIENT_ADDRESS?: string;
        X402_NETWORK?: string;
        X402_FACILITATOR_URL?: string;
      });
      const card = ports?.card ?? null;
      if (!card) {
        return Response.json({ error: "Native card checkout is not configured." }, { status: 503 });
      }
      let evidence;
      try {
        evidence = await card.retrieveCardSession({ sessionId: checkoutSessionId });
      } catch (err) {
        // #3573: a guard failure (timeout / breaker open) maps to its
        // catalog-coded 503; any other retrieve failure keeps the
        // fixed "Payment verification unavailable." 503 (unchanged).
        if (isCheckoutPortGuardError(err)) {
          return codedOutcomeResponse(err.outcomeCode);
        }
        return Response.json({ error: "Payment verification unavailable." }, { status: 503 });
      }
      const expectedCents = Math.round(plan.priceUSD * 100);
      if (
        evidence.status !== "complete" ||
        evidence.paymentStatus !== "paid" ||
        evidence.amountTotalCents !== expectedCents ||
        evidence.clientReferenceId !== checkoutRequestId
      ) {
        return Response.json({ error: "Checkout is not paid for this plan; no subscription activated." }, { status: 402 });
      }
      if (!evidence.paymentIntentId) {
        return Response.json({ error: "Paid checkout carries no payment intent; no subscription activated." }, { status: 402 });
      }
      // Issue #2522: tier-change audit — capture the before rows
      // (identity.stored is the pre-activation account row) so
      // the audit can state previous → new effective tier.
      const previousSubscriptions = await subs.listSubscriptions(login);
      const { subscription, account } = await activateSubscription({
        subs,
        store,
        userId: login,
        tenantId,
        plan,
        provider: "stripe",
        providerPaymentRef: checkoutRequestId,
        stripeSessionId: evidence.sessionId,
        stripePaymentIntentId: evidence.paymentIntentId,
      });
      // The activation creates the row that flips the effective
      // tier, so the new side is computed from the returned
      // account + a fresh subscription read, BEFORE this audit
      // (the route previously computed effectiveTier only after it).
      const activatedSubscriptions = await subs.listSubscriptions(login);
      const activationTransition = resolveTierTransition(
        identity.stored,
        previousSubscriptions,
        account,
        activatedSubscriptions,
        Date.now(),
      );
      ctx.audit("commercial.subscription.activated", "payments", {
        userId: login,
        tenantId,
        planId: plan.id,
        subscriptionId: subscription.id,
        providerPaymentRef: checkoutRequestId,
        stripeSessionId: evidence.sessionId,
        stripePaymentIntentId: evidence.paymentIntentId,
        periodEndMs: subscription.periodEndMs,
        previousEffectiveTier: activationTransition.previousEffectiveTier,
        newEffectiveTier: activationTransition.newEffectiveTier,
      });
      // Issue #2155 follow-up: project the purchase into the D1
      // journal (Dr 1000 / Cr 2100 — the purchase is deferred
      // revenue, NOT immediate revenue). BEST-EFFORT, never
      // thrown: activation already succeeded, so a journal
      // failure is a loud log + a reconcile flag, never a
      // failed purchase. Posted only after activation success,
      // never on any refusal path above (402/403/404/409/503
      // all return before this point). The RECOGNITION schedule
      // (deferred → earned over the period) is a follow-up slice
      // and is deliberately not posted here.
      await postJournalBestEffort(async () => {
        const adapter = createJournalAdapter(ctx.env as { AGENT_DB?: unknown });
        if (!adapter) return null;
        await ensureJournalSchema(adapter.db);
        return adapter;
      }, mapSubscriptionPurchaseToJournalEntries({
        transactionRef: checkoutRequestId,
        tenantId,
        subscriptionId: subscription.id,
        amountUSD: plan.priceUSD,
        // Issue #3289: per-charge recording (§3.9) — the product
        // and version purchased (planId IS the version id).
        productId: plan.productId,
        versionId: plan.id,
      }));
      const effectiveTier = resolveEffectiveTier(account, [subscription], Date.now());
      return Response.json({ subscription, account, effectiveTier });
    } catch (err: any) {
      const message = err.message || "Failed to activate subscription";
      const status = /Tenant mismatch/.test(message)
        ? 403
        : /already activated/.test(message)
          ? 409
          : /required|must be|not active/.test(message)
            ? 400
            : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // ================================================================
  // Self-service top-up (#3262): a user funds their own credit
  // balance ahead of time — mint a native checkout for a chosen
  // amount, pay, then confirm. The confirm re-reads provider
  // evidence and judges it, exactly like the subscription purchase
  // (#2198): credit lands ONLY on verified payment, never on an
  // unconfirmed checkout. The draft (bound at mint) is the replay
  // guard and the amount binding; the server-resolved (user,
  // tenant) from the session identity is the credit target (#1069
  // §8) — a client-supplied tenantId is ignored, and no
  // client-supplied account is ever credited. Single currency
  // (USD) only, native Stripe/x402 rails only (#1069 §9).
  // ================================================================

  const requireTopUpDrafts = (): D1TopUpAdapter | Response => {
    const adapter = createTopUpDraftAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Top-up store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };

  // Issue #3246 slice 3: the runs-pack stores (versions, balances,
  // drafts) — one bundle from one binding, mirroring the top-up
  // drafts' require helper. The pack checkout/confirm routes and
  // the pack-version routes all read through this helper.
  const requireRunsPack = (): RunsPackAdapters | Response => {
    const adapters = createRunsPackAdapters(ctx.env as { AGENT_DB?: unknown });
    if (!adapters) {
      return Response.json({ error: "Runs-pack store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapters;
  };

  const runsPackErrorResponse = (err: unknown): Response => {
    if (err instanceof BusinessError) {
      const outcome = resolveOutcome(err.code);
      return new Response(JSON.stringify({ error: codedMessage(err.code), code: err.code }), {
        status: outcome.entry?.httpStatus ?? 500,
        headers: { "content-type": "application/json" },
      });
    }
    const message = err instanceof Error ? err.message : "Runs-pack purchase failed.";
    const status = /already credited/.test(message)
      ? 409
      : /required|must be|Unknown runs-pack draft/.test(message)
        ? 400
        : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  const topUpErrorResponse = (err: unknown): Response => {
    if (err instanceof BusinessError) {
      const outcome = resolveOutcome(err.code);
      return new Response(JSON.stringify({ error: codedMessage(err.code), code: err.code }), {
        status: outcome.entry?.httpStatus ?? 500,
        headers: { "content-type": "application/json" },
      });
    }
    const message = err instanceof Error ? err.message : "Top-up failed.";
    const status = /already credited/.test(message)
      ? 409
      : /required|must be|Unknown top-up draft/.test(message)
        ? 400
        : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  // POST /payments/agentic/commercial/top-up/checkout — mint a native checkout for a chosen amount.
  // The amount is validated against the operator-set billing-policy bounds (PROPOSED seeds
  // $1–$500, owner-decided 2026-11-06) before any checkout is minted. The draft id
  // (`topup-<uuid>`) is the Stripe client_reference_id / x402 checkout id, so the confirm
  // can bind the payment back to this draft and this amount. No credit is created here —
  // mint only mints; the account is credited at confirm, after verified payment.
  if (path.endsWith("/payments/agentic/commercial/top-up/checkout") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as {
        amountUSD?: unknown;
        rail?: unknown;
        email?: unknown;
        offerContext?: unknown;
      };
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email) return Response.json({ error: "email (checkout contact) is required." }, { status: 400 });
      let rail: "card" | "x402" = "card";
      if (body.rail !== undefined) {
        try {
          rail = assertTopUpRail(body.rail);
        } catch {
          return Response.json({ error: "rail must be \"card\" or \"x402\"." }, { status: 400 });
        }
      }
      let amountUSD: number;
      try {
        amountUSD = assertTopUpAmountUSD(body.amountUSD);
      } catch {
        throw new BusinessError("FAILURE_TOP_UP_AMOUNT_INVALID");
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const policy = requireBillingPolicy();
      if (policy instanceof Response) return policy;
      let policyValue;
      try {
        await ensureBillingPolicySchema(policy.db);
        policyValue = await policy.getPolicy();
      } catch (err: any) {
        return Response.json({ error: `Billing policy unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      if (amountUSD < policyValue.topUpMinUSD || amountUSD > policyValue.topUpMaxUSD) {
        throw new BusinessError("FAILURE_TOP_UP_AMOUNT_INVALID");
      }
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      // #2219: the tenant comes from the resolved identity, never the request body.
      const tenantId = identity.tenantId ?? login;
      const drafts = requireTopUpDrafts();
      if (drafts instanceof Response) return drafts;
      try {
        await ensureTopUpSchema(drafts.db);
      } catch (err: any) {
        return Response.json({ error: `Top-up store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const ports = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      const port = ports?.[rail] ?? null;
      if (!port) {
        throw new BusinessError("FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE");
      }
      const topUpRequestId = `topup-${crypto.randomUUID()}`;
      let created;
      try {
        created = await port.createCheckout({
          runRequestId: topUpRequestId,
          priceUSD: amountUSD,
          email,
          userId: login,
        });
      } catch {
        throw new BusinessError("FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE");
      }
      try {
        await drafts.createDraft({
          id: topUpRequestId,
          userLogin: login,
          tenantId,
          email,
          amountUSD,
          rail,
          status: "minted",
          createdAtMs: Date.now(),
          creditedAtMs: null,
          paymentIntentId: null,
          checkoutSessionId: rail === "card" ? created.checkoutId : null,
          challengeNonce: rail === "x402" ? (created.challenge?.nonce ?? null) : null,
        });
      } catch (err: any) {
        return Response.json({ error: "Failed to record the top-up draft." }, { status: 500 });
      }
      ctx.audit("commercial.top_up.checkout_created", "payments", {
        userId: login,
        tenantId,
        topUpRequestId,
        rail,
        amountUSD,
      });
      // Issue #3246: offer acceptance, audit-only — see the
      // subscription checkout mint above.
      const offerContext = parseOfferContext(body.offerContext);
      if (offerContext) {
        ctx.audit("commercial.offer.accepted", "payments", {
          login,
          tenantId,
          trigger: offerContext.trigger,
          action: "topup",
          checkoutId: created.checkoutId,
          ...(offerContext.shownAtMs !== undefined ? { shownAtMs: offerContext.shownAtMs } : {}),
        });
      }
      if (rail === "card") {
        return Response.json({
          topUpRequestId,
          rail,
          amountUSD,
          checkoutUrl: created.checkoutUrl ?? null,
          checkoutSessionId: created.checkoutId,
        });
      }
      return Response.json({
        topUpRequestId,
        rail,
        amountUSD,
        checkoutId: created.checkoutId,
        challenge: created.challenge ?? null,
      });
    } catch (err: any) {
      if (err instanceof BusinessError) return topUpErrorResponse(err);
      const message = err.message || "Failed to create top-up checkout";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/top-up/confirm — credit on VERIFIED payment only.
  // Fulfillment is re-read from the provider, never a return page, exactly like the
  // subscription purchase. Card requires ALL of: session status complete, payment_status
  // paid, amount_total == draft amount x 100 (the MANDATORY amount re-check), client_reference_id
  // == the draft id, and a payment-intent id present. x402 requires: facilitator verdict
  // verified for the draft amount, payer match when the caller names one, and the
  // challenge-nonce binding to the nonce minted for this draft. Any failure refuses
  // with 402 and credits nothing. A credited draft refuses a second confirm with 409.
  // The account row is created on verified payment when missing (purchase-activation
  // precedent), so a first top-up needs no operator step; the credit target is always
  // the server-resolved (user, tenant), never a client-supplied account (#1069 §8).
  if (path.endsWith("/payments/agentic/commercial/top-up/confirm") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as {
        topUpRequestId?: unknown;
        checkoutSessionId?: unknown;
        paymentProof?: unknown;
        payer?: unknown;
      };
      const topUpRequestId = typeof body.topUpRequestId === "string" ? body.topUpRequestId : "";
      if (!topUpRequestId) return Response.json({ error: "topUpRequestId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const drafts = requireTopUpDrafts();
      if (drafts instanceof Response) return drafts;
      try {
        await ensureTopUpSchema(drafts.db);
      } catch (err: any) {
        return Response.json({ error: `Top-up store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const draft = await drafts.getDraft(topUpRequestId);
      if (!draft) return Response.json({ error: "Unknown top-up." }, { status: 404 });
      if (draft.userLogin !== login) {
        return Response.json({ error: "Forbidden: only the top-up owner may confirm it." }, { status: 403 });
      }
      if (draft.status !== "minted") {
        throw new BusinessError("FAILURE_TOP_UP_REPLAY");
      }
      const ports = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      const port = ports?.[draft.rail] ?? null;
      if (!port) {
        throw new BusinessError("FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE");
      }
      let paymentIntentId: string | null = null;
      let checkoutSessionId: string | null = null;
      if (draft.rail === "card") {
        const sessionId =
          typeof body.checkoutSessionId === "string" && body.checkoutSessionId
            ? body.checkoutSessionId
            : draft.checkoutSessionId;
        if (!sessionId) return Response.json({ error: "checkoutSessionId is required." }, { status: 400 });
        checkoutSessionId = sessionId;
        let evidence;
        try {
          evidence = await port.retrieveCardSession({ sessionId });
        } catch {
          throw new BusinessError("FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE");
        }
        const expectedCents = Math.round(draft.amountUSD * 100);
        if (
          evidence.status !== "complete" ||
          evidence.paymentStatus !== "paid" ||
          evidence.amountTotalCents !== expectedCents ||
          evidence.clientReferenceId !== draft.id
        ) {
          throw new BusinessError("FAILURE_TOP_UP_NOT_PAID");
        }
        if (!evidence.paymentIntentId) {
          throw new BusinessError("FAILURE_TOP_UP_NOT_PAID");
        }
        paymentIntentId = evidence.paymentIntentId;
      } else {
        const paymentProof = typeof body.paymentProof === "string" ? body.paymentProof : "";
        if (!paymentProof) return Response.json({ error: "paymentProof is required." }, { status: 400 });
        let verdict;
        try {
          verdict = await port.verifyCryptoPayment({ paymentProof, expectedAmountUSD: draft.amountUSD });
        } catch {
          throw new BusinessError("FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE");
        }
        if (!verdict.verified || !verdict.payer) {
          throw new BusinessError("FAILURE_TOP_UP_NOT_PAID");
        }
        const claimedPayer = typeof body.payer === "string" ? body.payer : "";
        if (claimedPayer && claimedPayer.toLowerCase() !== verdict.payer.toLowerCase()) {
          throw new BusinessError("FAILURE_TOP_UP_NOT_PAID");
        }
        if (draft.challengeNonce && verdict.nonce && draft.challengeNonce !== verdict.nonce) {
          throw new BusinessError("FAILURE_TOP_UP_NOT_PAID");
        }
      }
      // Verified: claim the draft for crediting BEFORE the credit lands
      // (#3572). The claim is a single conditional transition
      // (minted → crediting), so exactly one confirmer can own the
      // credit: a retry or concurrent confirm sees a non-minted draft
      // and refuses 409 instead of crediting again. A claim refusal
      // here means another confirmer already claimed it (the status
      // check above passed before the race) — map it to the replay
      // outcome, never to a store failure.
      try {
        await drafts.claimForCredit(draft.id);
      } catch (err: any) {
        if (err instanceof TopUpClaimRefusedError) {
          throw new BusinessError("FAILURE_TOP_UP_REPLAY");
        }
        throw err;
      }
      ctx.audit("commercial.top_up.claimed", "payments", {
        userId: login,
        tenantId: draft.tenantId,
        topUpRequestId: draft.id,
        amountUSD: draft.amountUSD,
        rail: draft.rail,
      });
      // Verified: ensure the account row exists (created on verified payment when
      // missing), then credit exactly the draft amount — never the evidence amount,
      // never a client-supplied amount.
      let account = await store.getAccount(login);
      if (!account) {
        account = await store.upsertAccount({ userId: login, tenantId: draft.tenantId, tier: "Free" });
      }
      let credited;
      try {
        credited = await store.adjustCredits(login, draft.amountUSD);
      } catch (err: any) {
        // The credit never landed, so release the claim and let a retry
        // proceed. If the release itself fails the draft stays
        // `crediting` with no credit landed: a loud catalog-coded 500
        // with the draft id, so an operator can reconcile (the stuck
        // claim is visible via the claim audit + the 409s, never
        // silent). That path needs two consecutive store failures.
        try {
          await drafts.releaseClaim(draft.id);
        } catch (releaseErr: any) {
          ctx.audit("commercial.top_up.claim_stuck", "payments", {
            userId: login,
            tenantId: draft.tenantId,
            topUpRequestId: draft.id,
            amountUSD: draft.amountUSD,
            rail: draft.rail,
          });
          logAspectEvent({
            aspect: "TopUp",
            operationName: "top-up.confirm.claim-release",
            code: "FAILURE_TOP_UP_RECONCILE_REQUIRED",
            level: "error",
            message: "top-up claim release failed after credit failure; draft stuck crediting",
            metadata: { userLogin: login, topUpRequestId: draft.id },
          });
          throw new BusinessError("FAILURE_TOP_UP_RECONCILE_REQUIRED");
        }
        throw err;
      }
      let marked;
      try {
        marked = await drafts.markCredited(draft.id, {
          creditedAtMs: Date.now(),
          paymentIntentId,
          checkoutSessionId,
        });
      } catch (err: any) {
        // The credit landed but the draft could not be marked: a loud
        // 500 with the draft id, so an operator can reconcile from the
        // Stripe evidence. The draft is `crediting` (claimed above), so
        // a retry refuses 409 and cannot credit again — no double
        // credit, but the draft never reaches `credited` and no
        // `commercial.top_up.credited` audit fires for it; the operator
        // reconciles from the claim audit + Stripe evidence. Never
        // silently swallow this.
        return Response.json({ error: `Top-up credited but the draft could not be marked: ${draft.id}.` }, { status: 500 });
      }
      void marked;
      ctx.audit("commercial.top_up.credited", "payments", {
        userId: login,
        tenantId: draft.tenantId,
        topUpRequestId: draft.id,
        amountUSD: draft.amountUSD,
        rail: draft.rail,
        creditsUSD: credited.creditsUSD,
        paymentIntentId,
      });
      // Issue #2155 follow-up: project the top-up into the D1 journal
      // (Dr 1000 / Cr 2100 — prepaid credit is deferred revenue, NOT
      // immediate revenue). BEST-EFFORT, never thrown: the credit already
      // landed, so a journal failure is a loud log + a reconcile flag,
      // never a failed top-up. Posted only after crediting success, never
      // on any refusal path above (402/403/404/409/503 all return before
      // this point).
      await postJournalBestEffort(async () => {
        const adapter = createJournalAdapter(ctx.env as { AGENT_DB?: unknown });
        if (!adapter) return null;
        await ensureJournalSchema(adapter.db);
        return adapter;
      }, mapTopUpToJournalEntries({
        transactionRef: draft.id,
        tenantId: draft.tenantId,
        amountUSD: draft.amountUSD,
      }));
      return Response.json({
        account: credited,
        topUpRequestId: draft.id,
        creditedUSD: draft.amountUSD,
        rail: draft.rail,
      });
    } catch (err: any) {
      return topUpErrorResponse(err);
    }
  }

  // ================================================================
  // Runs packs (#3246 slice 3, sub-issue of #3241) — the pack
  // checkout/confirm pair, mirroring the top-up routes exactly
  // (verified payment only; confirm idempotent on replay). A pack
  // purchase credits a dedicated per-login runs balance — NO tier,
  // NO subscription row, NO expiry in v1. The draft id
  // (`pack-<uuid>`) is the Stripe client_reference_id / x402
  // checkout id and the replay guard.
  // ================================================================

  // POST /payments/agentic/commercial/runs-packs/checkout — mint a native checkout for a chosen pack version.
  // The version is validated before any checkout is minted: it must exist, be approved (only an
  // operator approval makes a pack price buyable), and be active. The draft binds the version's
  // (runs, price) terms at mint — confirm credits exactly those terms, never a client-supplied
  // amount. No runs are created here — mint only mints; the balance is credited at confirm, after
  // verified payment.
  if (path.endsWith("/payments/agentic/commercial/runs-packs/checkout") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as {
        versionId?: unknown;
        rail?: unknown;
        email?: unknown;
        offerContext?: unknown;
      };
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email) return Response.json({ error: "email (checkout contact) is required." }, { status: 400 });
      const versionId = typeof body.versionId === "string" ? body.versionId.trim() : "";
      if (!versionId) return Response.json({ error: "versionId is required." }, { status: 400 });
      let rail: "card" | "x402" = "card";
      if (body.rail !== undefined) {
        try {
          rail = assertRunsPackRail(body.rail);
        } catch {
          return Response.json({ error: "rail must be \"card\" or \"x402\"." }, { status: 400 });
        }
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const packs = requireRunsPack();
      if (packs instanceof Response) return packs;
      try {
        await ensureRunsPackSchema(packs.versions.db);
      } catch (err: any) {
        return Response.json({ error: `Runs-pack store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const version = await packs.versions.getVersion(versionId);
      if (!version) return Response.json({ error: `No runs-pack version ${versionId}.` }, { status: 404 });
      if (version.approvalStatus !== "approved") {
        throw new BusinessError("FAILURE_RUNS_PACK_NO_APPROVED_PRICE");
      }
      if (!version.active) {
        return Response.json({ error: `Runs-pack version ${versionId} is not active.` }, { status: 409 });
      }
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      // #2219: the tenant comes from the resolved identity, never the request body.
      const tenantId = identity.tenantId ?? login;
      const ports = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      const port = ports?.[rail] ?? null;
      if (!port) {
        throw new BusinessError("FAILURE_RUNS_PACK_UNAVAILABLE");
      }
      const packRequestId = `pack-${crypto.randomUUID()}`;
      let created;
      try {
        created = await port.createCheckout({
          runRequestId: packRequestId,
          priceUSD: version.priceUSD,
          email,
          userId: login,
        });
      } catch {
        throw new BusinessError("FAILURE_RUNS_PACK_UNAVAILABLE");
      }
      try {
        await packs.drafts.createDraft({
          id: packRequestId,
          userLogin: login,
          tenantId,
          email,
          versionId: version.id,
          productId: version.productId,
          runs: version.runs,
          priceUSD: version.priceUSD,
          rail,
          status: "minted",
          createdAtMs: Date.now(),
          creditedAtMs: null,
          paymentIntentId: null,
          checkoutSessionId: rail === "card" ? created.checkoutId : null,
          challengeNonce: rail === "x402" ? (created.challenge?.nonce ?? null) : null,
        });
      } catch (err: any) {
        return Response.json({ error: "Failed to record the runs-pack draft." }, { status: 500 });
      }
      ctx.audit("commercial.runs_pack.checkout_created", "payments", {
        userId: login,
        tenantId,
        packRequestId,
        versionId: version.id,
        productId: version.productId,
        runs: version.runs,
        priceUSD: version.priceUSD,
        rail,
      });
      // Issue #3246: offer acceptance, audit-only — see the
      // subscription checkout mint. The action names the pack
      // purchase (not the plan or the top-up).
      const offerContext = parseOfferContext(body.offerContext);
      if (offerContext) {
        ctx.audit("commercial.offer.accepted", "payments", {
          login,
          tenantId,
          trigger: offerContext.trigger,
          action: "runs_pack",
          checkoutId: created.checkoutId,
          ...(offerContext.shownAtMs !== undefined ? { shownAtMs: offerContext.shownAtMs } : {}),
        });
      }
      if (rail === "card") {
        return Response.json({
          packRequestId,
          rail,
          runs: version.runs,
          priceUSD: version.priceUSD,
          checkoutUrl: created.checkoutUrl ?? null,
          checkoutSessionId: created.checkoutId,
        });
      }
      return Response.json({
        packRequestId,
        rail,
        runs: version.runs,
        priceUSD: version.priceUSD,
        checkoutId: created.checkoutId,
        challenge: created.challenge ?? null,
      });
    } catch (err: any) {
      if (err instanceof BusinessError) return runsPackErrorResponse(err);
      const message = err.message || "Failed to create runs-pack checkout";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/runs-packs/confirm — credit on VERIFIED payment only.
  // Fulfillment is re-read from the provider, never a return page, exactly like the
  // top-up confirm. Card requires ALL of: session status complete, payment_status
  // paid, amount_total == draft price x 100 (the MANDATORY amount re-check), client_reference_id
  // == the draft id, and a payment-intent id present. x402 requires: facilitator verdict
  // verified for the draft price, payer match when the caller names one, and the
  // challenge-nonce binding to the nonce minted for this draft. Any failure refuses
  // with 402 and credits nothing. A credited draft returns the SAME 200 success
  // payload on replay (literal idempotency, design §9.3) — no second credit, ever.
  // The version is re-checked after payment verification and before the claim
  // (the plan-purchase precedent): a version deactivated after mint refuses
  // here, and the verified payment is reconciled by an operator from the
  // draft + provider evidence. The account row is created on verified payment
  // when missing (purchase-activation precedent), so a first pack needs no
  // operator step; the credit target is always the server-resolved (user,
  // tenant), never a client-supplied account (#1069 §8). Purchase confers NO
  // tier and creates NO subscription row — activation touches the pack
  // balance only.
  if (path.endsWith("/payments/agentic/commercial/runs-packs/confirm") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as {
        packRequestId?: unknown;
        checkoutSessionId?: unknown;
        paymentProof?: unknown;
        payer?: unknown;
      };
      const packRequestId = typeof body.packRequestId === "string" ? body.packRequestId : "";
      if (!packRequestId) return Response.json({ error: "packRequestId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const packs = requireRunsPack();
      if (packs instanceof Response) return packs;
      try {
        await ensureRunsPackSchema(packs.drafts.db);
      } catch (err: any) {
        return Response.json({ error: `Runs-pack store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const draft = await packs.drafts.getDraft(packRequestId);
      if (!draft) return Response.json({ error: "Unknown runs pack." }, { status: 404 });
      if (draft.userLogin !== login) {
        return Response.json({ error: "Forbidden: only the runs-pack owner may confirm it." }, { status: 403 });
      }
      const purchased = resolveOutcome("SUCCESS_RUNS_PACK_PURCHASED");
      if (draft.status === "credited") {
        // Idempotent replay: the same checkout id returns the same
        // success — the draft's bound runs, the current account row,
        // and the current balance. The balance is a fresh read: runs
        // spent after purchase read as spent, which is the truth,
        // not a different result.
        let account = await store.getAccount(login);
        if (!account) {
          account = await store.upsertAccount({ userId: login, tenantId: draft.tenantId, tier: "Free" });
        }
        const packRunsRemaining = await packs.balance.getBalance(login);
        return Response.json({
          account,
          packRequestId: draft.id,
          creditedRuns: draft.runs,
          rail: draft.rail,
          packRunsRemaining,
          code: purchased.code,
          message: purchased.businessMessage,
        });
      }
      if (draft.status !== "minted") {
        throw new BusinessError("FAILURE_RUNS_PACK_REPLAY");
      }
      const ports = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      const port = ports?.[draft.rail] ?? null;
      if (!port) {
        throw new BusinessError("FAILURE_RUNS_PACK_UNAVAILABLE");
      }
      let paymentIntentId: string | null = null;
      let checkoutSessionId: string | null = null;
      if (draft.rail === "card") {
        const sessionId =
          typeof body.checkoutSessionId === "string" && body.checkoutSessionId
            ? body.checkoutSessionId
            : draft.checkoutSessionId;
        if (!sessionId) return Response.json({ error: "checkoutSessionId is required." }, { status: 400 });
        checkoutSessionId = sessionId;
        let evidence;
        try {
          evidence = await port.retrieveCardSession({ sessionId });
        } catch {
          throw new BusinessError("FAILURE_RUNS_PACK_UNAVAILABLE");
        }
        const expectedCents = Math.round(draft.priceUSD * 100);
        if (
          evidence.status !== "complete" ||
          evidence.paymentStatus !== "paid" ||
          evidence.amountTotalCents !== expectedCents ||
          evidence.clientReferenceId !== draft.id
        ) {
          throw new BusinessError("FAILURE_RUNS_PACK_NOT_PAID");
        }
        if (!evidence.paymentIntentId) {
          throw new BusinessError("FAILURE_RUNS_PACK_NOT_PAID");
        }
        paymentIntentId = evidence.paymentIntentId;
      } else {
        const paymentProof = typeof body.paymentProof === "string" ? body.paymentProof : "";
        if (!paymentProof) return Response.json({ error: "paymentProof is required." }, { status: 400 });
        let verdict;
        try {
          verdict = await port.verifyCryptoPayment({ paymentProof, expectedAmountUSD: draft.priceUSD });
        } catch {
          throw new BusinessError("FAILURE_RUNS_PACK_UNAVAILABLE");
        }
        if (!verdict.verified || !verdict.payer) {
          throw new BusinessError("FAILURE_RUNS_PACK_NOT_PAID");
        }
        const claimedPayer = typeof body.payer === "string" ? body.payer : "";
        if (claimedPayer && claimedPayer.toLowerCase() !== verdict.payer.toLowerCase()) {
          throw new BusinessError("FAILURE_RUNS_PACK_NOT_PAID");
        }
        if (draft.challengeNonce && verdict.nonce && draft.challengeNonce !== verdict.nonce) {
          throw new BusinessError("FAILURE_RUNS_PACK_NOT_PAID");
        }
      }
      // Verified: the version must still be buyable — approved and
      // active — before the claim (the plan-purchase precedent).
      const version = await packs.versions.getVersion(draft.versionId);
      if (!version || version.approvalStatus !== "approved") {
        throw new BusinessError("FAILURE_RUNS_PACK_NO_APPROVED_PRICE");
      }
      if (!version.active) {
        return Response.json({ error: `Runs-pack version ${draft.versionId} is not active.` }, { status: 409 });
      }
      // Verified: claim the draft for crediting BEFORE the credit lands
      // (#3572, the top-up precedent). The claim is a single conditional
      // transition (minted → crediting), so exactly one confirmer can own
      // the credit: a retry or concurrent confirm sees a non-minted draft
      // and refuses 409 instead of crediting again. A claim refusal
      // here means another confirmer already claimed it (the status
      // check above passed before the race) — map it to the replay
      // outcome, never to a store failure.
      try {
        await packs.drafts.claimForCredit(draft.id);
      } catch (err: any) {
        if (err instanceof RunsPackClaimRefusedError) {
          throw new BusinessError("FAILURE_RUNS_PACK_REPLAY");
        }
        throw err;
      }
      ctx.audit("commercial.runs_pack.claimed", "payments", {
        userId: login,
        tenantId: draft.tenantId,
        packRequestId: draft.id,
        versionId: draft.versionId,
        productId: draft.productId,
        runs: draft.runs,
        priceUSD: draft.priceUSD,
        rail: draft.rail,
      });
      // Verified: ensure the account row exists (created on verified payment when
      // missing), then credit exactly the draft runs — never a client-supplied count.
      let account = await store.getAccount(login);
      if (!account) {
        account = await store.upsertAccount({ userId: login, tenantId: draft.tenantId, tier: "Free" });
      }
      let activation;
      try {
        activation = await activateRunsPack({
          balance: packs.balance,
          login,
          runs: draft.runs,
        });
      } catch (err: any) {
        // The credit never landed, so release the claim and let a retry
        // proceed. If the release itself fails the draft stays
        // `crediting` with no credit landed: a loud 500 with the draft
        // id, so an operator can reconcile (the stuck claim is visible
        // via the claim audit + the 409s, never silent). That path needs
        // two consecutive store failures.
        try {
          await packs.drafts.releaseClaim(draft.id);
        } catch (releaseErr: any) {
          ctx.audit("commercial.runs_pack.claim_stuck", "payments", {
            userId: login,
            tenantId: draft.tenantId,
            packRequestId: draft.id,
            versionId: draft.versionId,
            productId: draft.productId,
            runs: draft.runs,
            priceUSD: draft.priceUSD,
            rail: draft.rail,
          });
          logAspectEvent({
            aspect: "RunsPack",
            operationName: "runs-pack.confirm.claim-release",
            level: "error",
            message: "runs-pack claim release failed after credit failure; draft stuck crediting",
            error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
            metadata: { userLogin: login, packRequestId: draft.id },
          });
          return Response.json({
            error: `Runs pack claimed but the credit failed and the claim could not be released: ${draft.id}.`,
          }, { status: 500 });
        }
        throw err;
      }
      let marked;
      try {
        marked = await packs.drafts.markCredited(draft.id, {
          creditedAtMs: Date.now(),
          paymentIntentId,
          checkoutSessionId,
        });
      } catch (err: any) {
        // The credit landed but the draft could not be marked: a loud
        // 500 with the draft id, so an operator can reconcile from the
        // Stripe evidence. The draft is `crediting` (claimed above), so
        // a retry refuses 409 and cannot credit again — no double
        // credit, but the draft never reaches `credited` and no
        // `commercial.runs_pack.purchased` audit fires for it; the operator
        // reconciles from the claim audit + Stripe evidence. Never
        // silently swallow this.
        return Response.json({ error: `Runs pack credited but the draft could not be marked: ${draft.id}.` }, { status: 500 });
      }
      void marked;
      ctx.audit("commercial.runs_pack.purchased", "payments", {
        userId: login,
        tenantId: draft.tenantId,
        packRequestId: draft.id,
        versionId: draft.versionId,
        productId: draft.productId,
        runs: draft.runs,
        priceUSD: draft.priceUSD,
        rail: draft.rail,
        packRunsRemaining: activation.packRunsRemaining,
        paymentIntentId,
      });
      // Project the purchase into the D1 journal (Dr 1000 / Cr 4000 —
      // a pack is immediate revenue, like a subscription purchase:
      // the runs are the product, not prepaid credit). BEST-EFFORT,
      // never thrown: the runs already landed, so a journal failure
      // is a loud log + a reconcile flag, never a failed purchase.
      // Posted only after crediting success, never on any refusal
      // path above (402/403/404/409/503 all return before this point).
      await postJournalBestEffort(async () => {
        const adapter = createJournalAdapter(ctx.env as { AGENT_DB?: unknown });
        if (!adapter) return null;
        await ensureJournalSchema(adapter.db);
        return adapter;
      }, mapChargeToJournalEntries({
        transactionRef: draft.id,
        tenantId: draft.tenantId,
        runRequestId: draft.id,
        family: "runs_pack",
        productId: draft.productId,
        versionId: draft.versionId,
        amountUSD: draft.priceUSD,
      }));
      return Response.json({
        account,
        packRequestId: draft.id,
        creditedRuns: draft.runs,
        rail: draft.rail,
        packRunsRemaining: activation.packRunsRemaining,
        code: purchased.code,
        message: purchased.businessMessage,
      });
    } catch (err: any) {
      return runsPackErrorResponse(err);
    }
  }

  // Issue #3307 (sub-issue of #3241), slice 1 — referral / invite
  // code routes (server surface only). A code is a bearer token
  // that, redeemed by a verified login, credits RUNS to that
  // login's code-runs balance. Codes confer runs only — never
  // tier, never credits, never a price, never access. The code
  // VALUE is never stored (SHA-256 hash + display prefix only)
  // and the plaintext is returned once, at issuance.
  //
  // Rules are the ONLY source of terms, keyed by (productId,
  // issuer); a missing or inactive rule disables codes for that
  // (product, issuer) entirely (fail-closed). Terms are
  // snapshotted onto the code row at issuance; caps are read
  // live from the rule at redemption. Balances accrue here;
  // nothing spends them until slice 2 (the gate step), so this
  // slice has NO gate touch, NO UI, and NO #3247 dependency.
  //
  // Issuers: platform_admin (isStoreOperator), tenant_admin
  // (server-enforced via the KV membership seam — a tenant
  // admin may issue only tenant-scoped codes for their own
  // tenant), user (self-service; kind forced to referral,
  // referrer forced to the caller). Tenant admins do NOT edit
  // rules — rules are platform-wide operator data.
  const requireReferralCodes = async (): Promise<ReferralCodeAdapters | Response> => {
    const adapters = createReferralCodeAdapters(ctx.env as { AGENT_DB?: unknown });
    if (!adapters) {
      return Response.json({ error: "Referral-code store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    try {
      await ensureReferralCodeSchema(adapters.rules.db);
    } catch (err: any) {
      return Response.json({ error: `Referral-code store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
    }
    return adapters;
  };

  const referralCodeErrorResponse = (err: unknown): Response => {
    const catalogCode =
      err instanceof ReferralCodeInvalidError || err instanceof ReferralCodeScopeRefusedError
        ? "FAILURE_REFERRAL_CODE_INVALID"
        : err instanceof ReferralCodeCapExceededError
          ? "FAILURE_REFERRAL_CODE_CAP_EXCEEDED"
          : err instanceof ReferralCodeRuleUnavailableError
            ? "FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE"
            : null;
    if (catalogCode) {
      const outcome = resolveOutcome(catalogCode);
      // A tenant-scope refusal answers 403 with the GENERIC
      // invalid message — it must not leak whether the code
      // exists or which tenant it belongs to.
      const status =
        err instanceof ReferralCodeScopeRefusedError
          ? 403
          : outcome.entry?.httpStatus ?? 500;
      return new Response(JSON.stringify({ error: codedMessage(catalogCode), code: catalogCode }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    const message = err instanceof Error ? err.message : "Referral-code request failed.";
    const status = /required|must be|Unknown referral/.test(message) ? 400 : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  /**
   * Tenant-admin check for code issuance (the adminTenantQueues
   * resolveCaller pattern): the caller's verified login resolves
   * through the wired-login alias record to an internalUserId,
   * which must hold a live tenant-admin membership in the named
   * tenant. Reads only — IAAA writes stay CISO-owned. Any
   * failure building or reading the seam fails closed (false).
   */
  const isTenantAdminForReferralCode = async (
    login: string,
    tenantId: string,
  ): Promise<boolean> => {
    try {
      const kv = ctx.referralCodeAliasKv ?? sessionStore(ctx.env);
      const internalUserId = await lookupInternalUserIdByLogin(kv, login);
      if (!internalUserId) return false;
      const store =
        ctx.referralCodeMembershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
      const memberships = await store.getMembershipsByUser(internalUserId);
      return isTenantAdminForTenant(memberships, tenantId, Date.now());
    } catch {
      return false;
    }
  };

  // GET /payments/agentic/commercial/referral-code-rules?productId=... (operator only).
  if (path.endsWith("/payments/agentic/commercial/referral-code-rules") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) return Response.json({ error: "Forbidden: operator only." }, { status: 403 });
      const productId = url.searchParams.get("productId") ?? "";
      if (!productId) return Response.json({ error: "productId is required." }, { status: 400 });
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const rules = await codes.rules.listRules(productId);
      return Response.json({ productId, rules });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/referral-code-rules (operator only).
  // Upsert one rule for (productId, issuer). Rules are created
  // inactive — the operator activates them in the UI; nothing is
  // live until then. A rule edit affects only codes issued AFTER
  // the edit; outstanding codes keep their snapshot.
  if (path.endsWith("/payments/agentic/commercial/referral-code-rules") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) return Response.json({ error: "Forbidden: operator only." }, { status: 403 });
      const body = (await request.json().catch(() => ({}))) as {
        productId: unknown; issuer?: unknown; runsPerCode?: unknown; reusable?: unknown;
        expiryDays?: unknown; attributionMode?: unknown; maxRedemptionsPerCode?: unknown;
        maxRedemptionsPerLogin?: unknown; globalCap?: unknown; active?: unknown;
      };
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const rule = await codes.rules.upsertRule(body);
      ctx.audit("commercial.referral_code.rule_upserted", "payments", {
        productId: rule.productId,
        issuer: rule.issuer,
        active: rule.active,
        operatorLogin: login,
      });
      return Response.json({ rule });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/referral-codes/issue (operator / tenant admin).
  // Issues one code under (productId, issuer)'s rule. The
  // plaintext is returned ONCE — it is never stored, never
  // logged, never rendered again, and never appears in the audit
  // record. A tenant admin may issue only tenant-scoped codes
  // for their own tenant; a user may not call this route (their
  // self-service issuance is POST /referral-codes/mine).
  if (path.endsWith("/payments/agentic/commercial/referral-codes/issue") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        productId?: unknown; kind?: unknown; issuer?: unknown;
        referrerUserId?: unknown; tenantScope?: unknown;
      };
      const productId = typeof body.productId === "string" ? body.productId.trim() : "";
      if (!productId) return Response.json({ error: "productId is required." }, { status: 400 });
      const kind = assertReferralCodeKind(body.kind);
      const issuer: ReferralCodeIssuer =
        body.issuer === undefined || body.issuer === null
          ? "platform_admin"
          : assertReferralCodeIssuer(body.issuer);
      const requestedTenantScope =
        typeof body.tenantScope === "string" && body.tenantScope.trim()
          ? body.tenantScope.trim()
          : null;
      let tenantScope: string | null = null;
      let referrerUserId: string | null = null;
      if (issuer === "platform_admin") {
        if (!isStoreOperator(login)) return Response.json({ error: "Forbidden: operator only." }, { status: 403 });
        tenantScope = requestedTenantScope;
        referrerUserId =
          typeof body.referrerUserId === "string" && body.referrerUserId.trim()
            ? body.referrerUserId.trim()
            : null;
      } else if (issuer === "tenant_admin") {
        if (!requestedTenantScope) {
          return Response.json({ error: "tenantScope is required for tenant-admin issuance." }, { status: 400 });
        }
        if (!(await isTenantAdminForReferralCode(login, requestedTenantScope))) {
          return Response.json({ error: "Forbidden: tenant-admin membership required for this tenant." }, { status: 403 });
        }
        tenantScope = requestedTenantScope;
        referrerUserId =
          typeof body.referrerUserId === "string" && body.referrerUserId.trim()
            ? body.referrerUserId.trim()
            : null;
      } else {
        // The user issuer is self-service only — it never goes
        // through this route (see POST /referral-codes/mine).
        return Response.json({ error: "Forbidden: user issuance uses POST /referral-codes/mine." }, { status: 403 });
      }
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const issued = await issueReferralCode(
        {
          rules: codes.rules,
          codes: codes.codes,
          redemptions: codes.redemptions,
          balances: codes.balances,
          lifecycle: null,
        },
        {
          productId,
          kind,
          issuerLogin: login,
          issuerKind: issuer,
          referrerUserId,
          tenantScope,
          nowMs: Date.now(),
        },
      );
      ctx.audit("commercial.referral_code.issued", "payments", {
        codeId: issued.code.id,
        productId,
        kind,
        issuerKind: issuer,
        issuerLogin: login,
        tenantScope,
        referrerUserId,
      });
      return Response.json({ code: issued.code, plaintext: issued.plaintext });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // GET /payments/agentic/commercial/referral-codes?productId=... (operator only).
  // Operator list: display prefixes only — hashes and plaintext
  // values never leave the store.
  if (path.endsWith("/payments/agentic/commercial/referral-codes") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) return Response.json({ error: "Forbidden: operator only." }, { status: 403 });
      const productId = url.searchParams.get("productId") ?? "";
      if (!productId) return Response.json({ error: "productId is required." }, { status: 400 });
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const rows = await codes.codes.listCodes(productId);
      return Response.json({ productId, codes: rows.map(publicCodeView) });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/referral-codes/revoke (operator only).
  // Idempotent: revoking an already-revoked code returns it
  // as-is. The audit fires only on an actual transition.
  if (path.endsWith("/payments/agentic/commercial/referral-codes/revoke") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) return Response.json({ error: "Forbidden: operator only." }, { status: 403 });
      const body = (await request.json().catch(() => ({}))) as { codeId?: unknown };
      const codeId = typeof body.codeId === "string" ? body.codeId.trim() : "";
      if (!codeId) return Response.json({ error: "codeId is required." }, { status: 400 });
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const before = await codes.codes.getCode(codeId);
      if (!before) return Response.json({ error: `Unknown referral code ${codeId}.` }, { status: 404 });
      const revoked = await codes.codes.revokeCode(codeId, Date.now());
      if (!revoked) return Response.json({ error: `Unknown referral code ${codeId}.` }, { status: 404 });
      if (before.revokedAtMs === null) {
        ctx.audit("commercial.referral_code.revoked", "payments", {
          codeId,
          productId: revoked.productId,
          issuerLogin: revoked.issuerLogin,
          actorLogin: login,
        });
      }
      return Response.json({ code: publicCodeView(revoked) });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/referral-codes/redeem (any verified login).
  // Redeems a code value for the caller: credits the code's runs
  // to the caller's code-runs balance. Unknown / expired /
  // revoked / self / disabled-rule all share ONE generic 400;
  // cap exhaustion is the only specific failure (409); a
  // tenant-scope refusal is 403 with the generic message. A
  // one-time code redeemed twice by the same login replays the
  // earlier redemption (never double-credits). Attribution is
  // best-effort: the lifecycle port being unbound (or its
  // ensure failing) skips attribution, never the redemption.
  if (path.endsWith("/payments/agentic/commercial/referral-codes/redeem") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { code?: unknown };
      const codeValue = typeof body.code === "string" ? body.code : "";
      if (!codeValue) return Response.json({ error: "code is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      // The redeemer's tenant comes from the resolved identity,
      // never from the request body (session-scoped always).
      const identity = await resolvePlatformIdentity(
        { commercial: store, subscriptions: subs },
        { userId: login, nowMs: Date.now() },
      );
      const redeemerTenantId = identity.tenantId ?? login;
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      // Attribution is best-effort: an unbound lifecycle port (or
      // a failed ensure) skips attribution — it never fails the
      // redemption (design D8).
      let lifecycle: D1LifecycleAdapter | null = null;
      const lifecycleAdapter = createLifecycleAdapter(ctx.env as { AGENT_DB?: unknown });
      if (lifecycleAdapter) {
        const lifecycleEnsured = await ensureLifecycle(lifecycleAdapter);
        lifecycle = lifecycleEnsured ? null : lifecycleAdapter;
      }
      const result = await redeemReferralCode(
        {
          rules: codes.rules,
          codes: codes.codes,
          redemptions: codes.redemptions,
          balances: codes.balances,
          lifecycle,
        },
        {
          codeValue,
          redeemerLogin: login,
          redeemerTenantId,
          nowMs: Date.now(),
        },
      );
      ctx.audit("commercial.referral_code.redeemed", "payments", {
        codeId: result.redemption.codeId,
        productId: result.redemption.productId,
        redeemerLogin: login,
        redeemerTenantId,
        runsGranted: result.runsGranted,
        attributionWritten: result.attributionWritten,
        replayed: result.replayed,
      });
      const codeRunsBalance = await codes.balances.getBalance(login);
      return Response.json({
        redemption: result.redemption,
        runsGranted: result.runsGranted,
        attributionWritten: result.attributionWritten,
        replayed: result.replayed,
        codeRunsBalance,
      });
    } catch (err: any) {
      // Credit-stuck: the redemption row was recorded but the
      // balance credit failed. Audit loudly (the code id +
      // redeemer + runs let an operator reconcile) and answer
      // 500 — never a silent success, never a silent retry.
      if (err instanceof ReferralCodeCreditStuckError) {
        ctx.audit("commercial.referral_code.credit_stuck", "payments", {
          codeId: err.codeId,
          redeemerLogin: err.redeemerLogin,
          runsGranted: err.runsGranted,
        });
        return Response.json({ error: err.message }, { status: 500 });
      }
      return referralCodeErrorResponse(err);
    }
  }

  // GET /payments/agentic/commercial/referral-codes/mine (self).
  // The caller's own issued codes, across products (display
  // prefixes only — the plaintext is never re-rendered).
  if (path.endsWith("/payments/agentic/commercial/referral-codes/mine") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const rows = await codes.codes.listCodesByIssuerLogin(login);
      return Response.json({ codes: rows.map(publicCodeView) });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/referral-codes/mine (self).
  // Self-service issuance: mints a FRESH code each time (the
  // plaintext is never stored, so re-display is impossible).
  // Kind is forced to referral, the referrer is forced to the
  // caller, and the code is unscoped (any tenant may redeem it
  // — referrals are inherently cross-tenant). Disabled until an
  // operator creates and activates a user-issuer rule for the
  // product (fail-closed: 409).
  if (path.endsWith("/payments/agentic/commercial/referral-codes/mine") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { productId?: unknown };
      const productId = typeof body.productId === "string" ? body.productId.trim() : "";
      if (!productId) return Response.json({ error: "productId is required." }, { status: 400 });
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const issued = await issueReferralCode(
        {
          rules: codes.rules,
          codes: codes.codes,
          redemptions: codes.redemptions,
          balances: codes.balances,
          lifecycle: null,
        },
        {
          productId,
          kind: "referral",
          issuerLogin: login,
          issuerKind: "user",
          referrerUserId: login,
          tenantScope: null,
          nowMs: Date.now(),
        },
      );
      ctx.audit("commercial.referral_code.issued", "payments", {
        codeId: issued.code.id,
        productId,
        kind: "referral",
        issuerKind: "user",
        issuerLogin: login,
        tenantScope: null,
        referrerUserId: login,
      });
      return Response.json({ code: issued.code, plaintext: issued.plaintext });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/referral-codes/mine/revoke (self).
  // Revokes one of the caller's own codes. A code issued by
  // anyone else answers 403 (never 404 — the existence of
  // another login's code must not leak through this route).
  if (path.endsWith("/payments/agentic/commercial/referral-codes/mine/revoke") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { codeId?: unknown };
      const codeId = typeof body.codeId === "string" ? body.codeId.trim() : "";
      if (!codeId) return Response.json({ error: "codeId is required." }, { status: 400 });
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const before = await codes.codes.getCode(codeId);
      if (!before) return Response.json({ error: `Unknown referral code ${codeId}.` }, { status: 404 });
      if (before.issuerLogin !== login) {
        return Response.json({ error: "Forbidden: only the issuing login may revoke this code." }, { status: 403 });
      }
      const revoked = await codes.codes.revokeCode(codeId, Date.now());
      if (!revoked) return Response.json({ error: `Unknown referral code ${codeId}.` }, { status: 404 });
      if (before.revokedAtMs === null) {
        ctx.audit("commercial.referral_code.revoked", "payments", {
          codeId,
          productId: revoked.productId,
          issuerLogin: revoked.issuerLogin,
          actorLogin: login,
        });
      }
      return Response.json({ code: publicCodeView(revoked) });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // GET /payments/agentic/commercial/referral-codes/balance?userId=... (own-or-operator).
  // The caller's code-runs balance: one number, family-agnostic,
  // kept visibly separate from the USD referral-credit balance
  // (which lives on /referral/balance).
  if (path.endsWith("/payments/agentic/commercial/referral-codes/balance") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const userId = url.searchParams.get("userId") ?? "";
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) return Response.json({ error: "Forbidden." }, { status: 403 });
      const codes = await requireReferralCodes();
      if (codes instanceof Response) return codes;
      const codeRunsAvailable = await codes.balances.getBalance(userId);
      return Response.json({ userId, codeRunsAvailable });
    } catch (err: any) {
      return referralCodeErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/subscription/grant (issue
  // #3244, slice 2 of #3241) — operator grants a plan to a user.
  // No checkout is involved and no Stripe record is created: the
  // grant is operator data, like an operator tier grant (the
  // account upsert route above), so this route is NOT gated on
  // the monetization flag. The grant mirrors purchase activation
  // exactly (grantSubscription): the subscription row AND the
  // account's included-runs bump, because the gate reads included
  // runs from the account row only. The row's tenantId comes
  // from the target account row resolved server-side; a
  // client-supplied tenantId is ignored, and a target with no
  // account row fails closed (400) — the operator creates the
  // account first through the existing Accounts UI flow.
  if (path.endsWith("/payments/agentic/commercial/subscription/grant") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login || !isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { userId?: unknown; planId?: unknown; tenantId?: unknown };
      const userId = typeof body.userId === "string" ? body.userId : "";
      const planId = typeof body.planId === "string" ? body.planId : "";
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      // Issue #2522: tier-change audit — capture the before rows
      // so the audit can state previous → new effective tier.
      const previousAccount = await store.getAccount(userId);
      const previousSubscriptions = await subs.listSubscriptions(userId);
      const { subscription, account } = await grantSubscription({
        subs,
        store,
        userId,
        plan,
        grantedBy: login,
      });
      const grantedSubscriptions = await subs.listSubscriptions(userId);
      const grantTransition = resolveTierTransition(
        previousAccount,
        previousSubscriptions,
        account,
        grantedSubscriptions,
        Date.now(),
      );
      ctx.audit("commercial.subscription.granted", "payments", {
        userId,
        tenantId: subscription.tenantId,
        planId: plan.id,
        subscriptionId: subscription.id,
        grantedBy: login,
        providerPaymentRef: subscription.providerPaymentRef,
        periodEndMs: subscription.periodEndMs,
        previousEffectiveTier: grantTransition.previousEffectiveTier,
        newEffectiveTier: grantTransition.newEffectiveTier,
      });
      const effectiveTier = resolveEffectiveTier(account, [subscription], Date.now());
      return Response.json({ subscription, account, effectiveTier });
    } catch (err: any) {
      const message = err.message || "Failed to grant subscription";
      const status = /No commercial account|required|must be|not active/.test(message) ? 400 : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // POST /payments/agentic/commercial/subscription/trial — $0 / no-payment trial checkout (#3243,
  // slice 3 of #3241). Creates a TRIALING subscription for the user on our own path: there is no
  // Stripe trial parameter in-repo, so no Stripe session is minted and no payment is taken — the
  // row is provider "trial" with providerStatus "trialing" and no Stripe ids. The trial GRANTS
  // the plan's included runs to the account (mirroring the one-time purchase activation): tier
  // alone enables nothing, because the gate reads included runs from the account row only and
  // the Billing purchase route confers tier only. One trial per user per plan; a plan with no
  // trialDays refuses with 409. Trial-end: the row lapses at periodEnd via the existing
  // unexpired-row reads (resolveEffectiveTier) and the response carries the outcome-encoded
  // trial message, never a raw error code. No journal entry: $0, no money moved.
  if (path.endsWith("/payments/agentic/commercial/subscription/trial") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown; tenantId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      if (plan.trialDays === null || plan.trialDays === undefined) {
        return Response.json({ error: `Plan ${planId} offers no trial.` }, { status: 409 });
      }
      // #2219 fix, same as purchase: the tenant comes from the
      // resolved identity, never the request body. A missing
      // account does NOT fail closed here: activation creates
      // the account row in the session-derived tenant, so a
      // first trial succeeds end-to-end with no operator step.
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      const tenantId = identity.tenantId ?? login;
      const previousSubscriptions = await subs.listSubscriptions(login);
      const { subscription, account, trialEndsAtMs } = await activateTrialSubscription({
        subs,
        store,
        userId: login,
        tenantId,
        plan,
      });
      const activatedSubscriptions = await subs.listSubscriptions(login);
      const activationTransition = resolveTierTransition(
        identity.stored,
        previousSubscriptions,
        account,
        activatedSubscriptions,
        Date.now(),
      );
      ctx.audit("commercial.subscription.trial_activated", "payments", {
        userId: login,
        tenantId,
        planId: plan.id,
        subscriptionId: subscription.id,
        providerPaymentRef: subscription.providerPaymentRef,
        trialDays: plan.trialDays,
        trialEndsAtMs,
        previousEffectiveTier: activationTransition.previousEffectiveTier,
        newEffectiveTier: activationTransition.newEffectiveTier,
      });
      const effectiveTier = resolveEffectiveTier(account, [subscription], Date.now());
      const message = trialStartedMessage({
        planName: plan.name,
        trialDays: plan.trialDays,
        includedRuns: plan.includedRuns,
        trialEndsAtMs,
      });
      return Response.json({ subscription, account, effectiveTier, trialEndsAtMs, message });
    } catch (err: any) {
      const message = err.message || "Failed to start trial";
      const status = /Tenant mismatch/.test(message)
        ? 403
        : /already used|offers no trial|not active|not approved|not the effective version/.test(message)
          ? 409
          : /required|must be/.test(message)
            ? 400
            : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // POST /payments/agentic/commercial/subscription/billing-checkout — mint a subscription-mode Stripe
  // Checkout Session (Phase 2.1, #2656). MINT ONLY: no subscription row is created here; the
  // billing-purchase route fulfills from a retrieved session. The price is the OPERATOR-MAPPED
  // provider price id from the billing policy (stripePriceByPlan) — never a catalogue price, never
  // a code constant. A missing mapping refuses with 503 (operator configuration gap, not a client
  // error). The session carries fulfillment keys (userId/planId/tenantId) in session + provider
  // subscription metadata; the tenant comes from the resolved identity, never the request body
  // (same rule as the one-time checkout, #2219). An existing customer mapping is passed through
  // so a second checkout reuses the provider customer instead of fragmenting customers.
  if (path.endsWith("/payments/agentic/commercial/subscription/billing-checkout") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const policy = requireBillingPolicy();
      if (policy instanceof Response) return policy;
      const customers = requireBillingCustomers();
      if (customers instanceof Response) return customers;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const ensuredBilling = await ensureBillingStores(policy, customers);
      if (ensuredBilling) return ensuredBilling;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      // Issue #3357: only an APPROVED plan price may be charged — refuse before any provider call.
      // Fail-closed with a catalog-coded message, never a raw error string.
      if (!isPlanPriceApproved(plan)) {
        return codedOutcomeResponse("FAILURE_PLAN_PRICE_NOT_APPROVED");
      }
      const policyValue = await policy.getPolicy();
      const priceId = policyValue.stripePriceByPlan[plan.id];
      if (!priceId) {
        return Response.json(
          { error: `No operator-mapped Stripe Price id for plan ${plan.id}: Billing checkout is not configured.` },
          { status: 503 },
        );
      }
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      const tenantId = identity.tenantId ?? login;
      // Issue #3289: same effective+approved-for-segment check as
      // the one-time checkout mint — the buyer buys the effective
      // version for THEIR segment. Fail-closed before any provider
      // call.
      try {
        await assertPlanEffectiveAndApprovedForSegment(
          subs,
          plan,
          identity.stored?.segment ?? "default",
          Date.now(),
        );
      } catch (err: any) {
        return Response.json(
          { error: err.message || "Plan is not the effective approved version for your segment." },
          { status: 409 },
        );
      }
      const ports = createBillingCheckoutPorts(ctx.env as unknown as BillingCheckoutEnv);
      if (!ports) {
        return Response.json({ error: "Billing checkout is not configured (Stripe)." }, { status: 503 });
      }
      const existingCustomer = await customers.getCustomer(login);
      const draftId = `bill-${crypto.randomUUID()}`;
      let created;
      try {
        created = await ports.createSubscriptionCheckout({
          draftId,
          priceId,
          customerId: existingCustomer?.stripeCustomerId ?? null,
          metadata: { userId: login, planId: plan.id, tenantId },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Stripe subscription checkout could not be created." }, { status: 503 });
      }
      if (!created.url || !created.id) {
        return Response.json({ error: "Stripe subscription checkout could not be created." }, { status: 503 });
      }
      ctx.audit("commercial.subscription.billing_checkout_created", "payments", {
        userId: login,
        tenantId,
        planId: plan.id,
        checkoutRequestId: draftId,
        checkoutSessionId: created.id,
        stripeCustomerId: existingCustomer?.stripeCustomerId ?? null,
      });
      return Response.json({
        checkoutRequestId: draftId,
        checkoutUrl: created.url,
        checkoutSessionId: created.id,
        plan: { id: plan.id, name: plan.name, priceUSD: plan.priceUSD, periodDays: plan.periodDays, includedRuns: plan.includedRuns },
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to create Billing checkout" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/subscription/billing-purchase — fulfill a Billing checkout on
  // VERIFIED evidence only (Phase 2.1, #2656). The caller passes BOTH the route-minted draft id
  // (checkoutRequestId, "bill-" prefix) and the Stripe session id (checkoutSessionId). Activation
  // requires ALL of: session status complete, payment_status paid, client_reference_id ==
  // checkoutRequestId, metadata userId == login and planId == plan, a provider subscription id and
  // customer id present, the retrieved provider subscription's price id == the operator-mapped
  // price id, and provider status active/trialing. The tenant is NOT checked against metadata:
  // account creation between mint and fulfill legitimately changes the resolved tenant, and
  // activation uses the resolved tenant (same rule as one-time). Any failure refuses (402) and
  // activates nothing. A replay (existing provider row) refuses with 409; a customer-mapping
  // mismatch refuses with 409 (possible account confusion, operator resolves). Included-run
  // bypass stays OFF: this confers tier only, never included runs.
  if (path.endsWith("/payments/agentic/commercial/subscription/billing-purchase") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown; checkoutRequestId?: unknown; checkoutSessionId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      const checkoutRequestId = typeof body.checkoutRequestId === "string" ? body.checkoutRequestId : "";
      const checkoutSessionId = typeof body.checkoutSessionId === "string" ? body.checkoutSessionId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      if (!checkoutRequestId) return Response.json({ error: "checkoutRequestId is required." }, { status: 400 });
      if (!checkoutRequestId.startsWith("bill-")) {
        return Response.json({ error: "checkoutRequestId must come from the Billing checkout route." }, { status: 400 });
      }
      if (!checkoutSessionId) return Response.json({ error: "checkoutSessionId is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const policy = requireBillingPolicy();
      if (policy instanceof Response) return policy;
      const customers = requireBillingCustomers();
      if (customers instanceof Response) return customers;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const ensuredBilling = await ensureBillingStores(policy, customers);
      if (ensuredBilling) return ensuredBilling;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      // Issue #3357: only an APPROVED plan price may be charged — refuse before any provider call.
      // Fail-closed with a catalog-coded message, never a raw error string.
      if (!isPlanPriceApproved(plan)) {
        return codedOutcomeResponse("FAILURE_PLAN_PRICE_NOT_APPROVED");
      }
      const policyValue = await policy.getPolicy();
      const priceId = policyValue.stripePriceByPlan[plan.id];
      if (!priceId) {
        return Response.json(
          { error: `No operator-mapped Stripe Price id for plan ${plan.id}: Billing purchase is not configured.` },
          { status: 503 },
        );
      }
      let identity;
      try {
        identity = await resolvePlatformIdentity(
          { commercial: store, subscriptions: subs },
          { userId: login, nowMs: Date.now() },
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resolve platform identity" }, { status: 503 });
      }
      const tenantId = identity.tenantId ?? login;
      const ports = createBillingCheckoutPorts(ctx.env as unknown as BillingCheckoutEnv);
      if (!ports) {
        return Response.json({ error: "Billing checkout is not configured (Stripe)." }, { status: 503 });
      }
      const billing = createBillingPorts(ctx.env as unknown as BillingEnv, true);
      if (!billing) {
        return Response.json({ error: "Billing is not configured (Stripe)." }, { status: 503 });
      }
      let evidence;
      try {
        evidence = await ports.retrieveSubscriptionSession(checkoutSessionId);
      } catch {
        return Response.json({ error: "Payment verification unavailable." }, { status: 503 });
      }
      if (
        evidence.status !== "complete" ||
        evidence.paymentStatus !== "paid" ||
        evidence.clientReferenceId !== checkoutRequestId ||
        !evidence.subscriptionId ||
        !evidence.customerId ||
        evidence.metadata?.userId !== login ||
        evidence.metadata?.planId !== plan.id
      ) {
        return Response.json({ error: "Billing checkout is not paid for this plan and user; no subscription activated." }, { status: 402 });
      }
      let provider;
      try {
        provider = await billing.retrieveProviderSubscription(evidence.subscriptionId);
      } catch {
        return Response.json({ error: "Billing subscription verification unavailable." }, { status: 503 });
      }
      if (provider.priceId !== priceId) {
        return Response.json({ error: "Billing subscription price does not match the operator-mapped price for this plan; no subscription activated." }, { status: 402 });
      }
      if (provider.status !== "active" && provider.status !== "trialing") {
        return Response.json({ error: "Billing subscription is not active; no subscription activated." }, { status: 402 });
      }
      const existingMapping = await customers.getCustomer(login);
      if (existingMapping && existingMapping.stripeCustomerId !== evidence.customerId) {
        return Response.json(
          { error: `Billing customer mismatch: mapped to ${existingMapping.stripeCustomerId}, session names ${evidence.customerId} (operator resolves; no subscription activated).` },
          { status: 409 },
        );
      }
      const existingRow = await subs.findByProviderSubscriptionId(evidence.subscriptionId);
      if (existingRow) {
        return Response.json({ error: `Billing subscription ${evidence.subscriptionId} already activated subscription ${existingRow.id}.` }, { status: 409 });
      }
      const beforeAccount = await store.getAccount(login);
      const previousSubscriptions = await subs.listSubscriptions(login);
      await customers.recordCustomer({ userId: login, tenantId, stripeCustomerId: evidence.customerId });
      const subscription = await recordBillingSubscription({
        subs,
        provider,
        userId: login,
        tenantId,
        planId: plan.id,
      });
      const afterAccount = await store.getAccount(login);
      const activatedSubscriptions = await subs.listSubscriptions(login);
      const activationTransition = resolveTierTransition(
        beforeAccount,
        previousSubscriptions,
        afterAccount,
        activatedSubscriptions,
        Date.now(),
      );
      ctx.audit("commercial.subscription.billing_activated", "payments", {
        userId: login,
        tenantId,
        planId: plan.id,
        subscriptionId: subscription.id,
        providerSubscriptionId: evidence.subscriptionId,
        stripeCustomerId: evidence.customerId,
        checkoutRequestId,
        checkoutSessionId,
        periodEndMs: subscription.periodEndMs,
        previousEffectiveTier: activationTransition.previousEffectiveTier,
        newEffectiveTier: activationTransition.newEffectiveTier,
      });
      // Same deferred-revenue journal projection as the one-time
      // purchase (Dr 1000 / Cr 2100), best-effort, never thrown.
      // The RECOGNITION schedule (deferred → earned over the
      // period) is a follow-up slice and is not posted here.
      await postJournalBestEffort(async () => {
        const adapter = createJournalAdapter(ctx.env as { AGENT_DB?: unknown });
        if (!adapter) return null;
        await ensureJournalSchema(adapter.db);
        return adapter;
      }, mapSubscriptionPurchaseToJournalEntries({
        transactionRef: checkoutRequestId,
        tenantId,
        subscriptionId: subscription.id,
        amountUSD: plan.priceUSD,
        // Issue #3289: per-charge recording (§3.9) — the product
        // and version purchased (planId IS the version id).
        productId: plan.productId,
        versionId: plan.id,
      }));
      const effectiveTier = resolveEffectiveTier(afterAccount, [subscription], Date.now());
      return Response.json({ subscription, account: afterAccount, effectiveTier });
    } catch (err: any) {
      const message = err.message || "Failed to activate Billing subscription";
      const status = /Tenant mismatch/.test(message)
        ? 403
        : /already activated|already belongs|mismatch/.test(message)
          ? 409
          : /required|must be|not active/.test(message)
            ? 400
            : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // POST /payments/agentic/commercial/billing/webhook — apply a verified Stripe Billing webhook
  // event (Phase 2.1, #2656). No login: Stripe calls this, so the ONLY authentication is the
  // Stripe signature (HMAC over the RAW body — the body is read as text, never re-serialized).
  // Unverified → 401, nothing applied. Flag OFF → 200 flag_off, nothing applied (webhooks must
  // not activate while purchases are disabled). Unknown provider ids and unknown event types →
  // 200 not-applied (Stripe must not retry a well-formed but unmatchable event forever). A
  // provider retrieve 404 → provider null (the service then reports unknown/missing, still 200);
  // any other retrieve failure → 503 so Stripe retries. D1 is shared, so there is no
  // canonical-instance hop: the handler builds the store adapters straight from ctx.env.AGENT_DB.
  // Dunning-notice SENDING is out of scope here: a failed renewal marks past_due, and the notice
  // schedule (policy) is applied by a later slice.
  if (path.endsWith("/payments/agentic/commercial/billing/webhook") && request.method === "POST") {
    try {
      const rawBody = await request.text();
      let verification;
      try {
        verification = await new PaymentGatewayService(ctx.env).verifyWebhookSignature("stripe", rawBody, request.headers);
      } catch {
        return Response.json({ error: "Webhook verification unavailable." }, { status: 503 });
      }
      if (!verification.isValid) {
        return Response.json({ error: "Invalid webhook signature: nothing applied." }, { status: 401 });
      }
      let eventPayload: any;
      try {
        eventPayload = JSON.parse(rawBody);
      } catch {
        return Response.json({ error: "Malformed webhook payload." }, { status: 400 });
      }
      const eventType = typeof eventPayload?.type === "string" ? eventPayload.type : "";
      const eventObject = eventPayload?.data?.object ?? {};
      const isInvoiceEvent = eventType.startsWith("invoice.");
      const providerSubscriptionId = isInvoiceEvent
        ? (typeof eventObject.subscription === "string" ? eventObject.subscription : "")
        : (typeof eventObject.id === "string" ? eventObject.id : "");
      const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      if (!flagOn) {
        ctx.audit("commercial.billing.webhook", "payments", {
          type: eventType,
          providerSubscriptionId,
          applied: false,
          reason: "billing_flag_off",
        });
        return Response.json({ applied: false, reason: "billing_flag_off" });
      }
      const billing = createBillingPorts(ctx.env as unknown as BillingEnv, true);
      if (!billing) {
        return Response.json({ error: "Billing is not configured (Stripe)." }, { status: 503 });
      }
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const policy = requireBillingPolicy();
      if (policy instanceof Response) return policy;
      try {
        await ensureSubscriptionSchema(subs.db);
        await ensureBillingPolicySchema(policy.db);
      } catch (err: any) {
        return Response.json({ error: `Billing store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      let policyValue;
      try {
        policyValue = await policy.getPolicy();
      } catch (err: any) {
        return Response.json({ error: `Billing policy unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const KNOWN_TYPES = new Set([
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "invoice.paid",
        "invoice.payment_failed",
      ]);
      let provider = null;
      if (KNOWN_TYPES.has(eventType) && providerSubscriptionId) {
        try {
          provider = await billing.retrieveProviderSubscription(providerSubscriptionId);
        } catch (err: any) {
          if (/HTTP 404/.test(err.message || "")) {
            provider = null;
          } else {
            return Response.json({ error: "Billing subscription verification unavailable." }, { status: 503 });
          }
        }
      }
      const webhookEvent: BillingWebhookEvent = { type: eventType, providerSubscriptionId, provider };
      const result = await applyBillingWebhookEvent({
        verified: true,
        event: webhookEvent,
        subs,
        policy: policyValue,
        nowMs: Date.now(),
      });
      ctx.audit("commercial.billing.webhook", "payments", {
        type: eventType,
        providerSubscriptionId,
        applied: result.applied,
        reason: result.reason,
        subscriptionId: result.subscription?.id ?? null,
      });
      return Response.json({
        applied: result.applied,
        reason: result.reason,
        subscriptionId: result.subscription?.id ?? null,
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to apply Billing webhook" }, { status: 500 });
    }
  }

  // GET/POST /payments/agentic/commercial/billing-policy — operator-only billing-policy read/write
  // (Phase 2.1, #2656). NOT flag-gated: operators configure policy before activation (same rule
  // as the refund policy routes). POST validates a partial update (invalid → 400) and audits.
  // Values not yet edited by an operator are the PROPOSED seed values pending owner approval —
  // the GET response says so rather than claiming approval.
  if (path.endsWith("/payments/agentic/commercial/billing-policy") && (request.method === "GET" || request.method === "POST")) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: only a store operator may read or set billing policy." }, { status: 403 });
      }
      const policy = requireBillingPolicy();
      if (policy instanceof Response) return policy;
      try {
        await ensureBillingPolicySchema(policy.db);
      } catch (err: any) {
        return Response.json({ error: `Billing policy store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      if (request.method === "GET") {
        const policyValue = await policy.getPolicy();
        return Response.json({
          policy: policyValue,
          seedNote: "Values not yet edited by an operator are PROPOSED seed values pending owner approval.",
        });
      }
      const body = (await request.json().catch(() => ({}))) as unknown;
      let partial;
      try {
        partial = assertBillingPolicyPartial(body);
      } catch (err: any) {
        // Issue #3357: a catalog-coded discount failure renders from the catalog.
        if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
        return Response.json({ error: err.message || "Invalid billing policy update." }, { status: 400 });
      }
      const updated = await policy.updatePolicy(partial);
      // Issue #3357: the discount change is audited with code + message + login
      // (#1969 acceptance). Other policy fields keep the pre-existing audit shape.
      if (partial.annualDiscountPct !== undefined) {
        const discountUpdated = resolveOutcome("SUCCESS_ANNUAL_DISCOUNT_UPDATED");
        ctx.audit("commercial.billing.policy_set", "payments", {
          code: discountUpdated.code,
          message: discountUpdated.businessMessage,
          login,
          userId: login,
          annualDiscountPct: updated.annualDiscountPct,
          policy: updated,
        });
      } else if (partial.offerRules !== undefined) {
        // Issue #3246: the offer-rules change is audited the same way.
        const rulesUpdated = resolveOutcome("SUCCESS_OFFER_RULES_UPDATED");
        ctx.audit("commercial.billing.policy_set", "payments", {
          code: rulesUpdated.code,
          message: rulesUpdated.businessMessage,
          login,
          userId: login,
          offerRules: updated.offerRules,
          policy: updated,
        });
      } else {
        ctx.audit("commercial.billing.policy_set", "payments", { userId: login, policy: updated });
      }
      return Response.json({ policy: updated });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to handle billing policy" }, { status: 500 });
    }
  }

  // ================================================================
  // cfpay channel (#2945, Phase 2.17): pay-per-use runs through the
  // cfpay payments agent, offered through the catalog entry only
  // (Phase 5 single-entry rule) — never a competing purchase path.
  // The card takes no amount input, so the channel sells ONLY listed
  // catalogue products whose APPROVED price exactly equals the
  // operator-attested channel fixed price (billing policy; null =
  // unconfigured). Mint creates no entitlement; confirm (the HITL
  // step, mirroring 2.1 Billing's "I have paid") verifies by
  // retrieve and only then tops up commercial credits + records the
  // ledger row. No subscription via the channel (no subscription
  // operation exists). Refunds go through the 2.7 machinery with
  // rail cfpay-channel: the request path needs no source, and
  // execution refuses with the existing not-resolvable 422 while no
  // payment intent is resolvable for the run — the draft's stored
  // paymentIntentId is the wiring point for that resolver, and no
  // refund operation is invented (the card cannot move funds).
  // Channel messages are outcome-catalog codes.
  // ================================================================
  const channelErrorResponse = (err: unknown): Response => {
    if (err instanceof BusinessError) {
      const outcome = resolveOutcome(err.code);
      return new Response(JSON.stringify({ error: codedMessage(err.code), code: err.code }), {
        status: outcome.entry?.httpStatus ?? 500,
        headers: { "content-type": "application/json" },
      });
    }
    const message = err instanceof Error ? err.message : "Channel operation failed.";
    const status = /email is required|Invalid price family|channel request id|must be a string|No commercial account/.test(
      message,
    )
      ? 400
      : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  const channelClientFor = (
    config: NonNullable<ReturnType<typeof getCfpayConfig>>,
  ): CfpayChannelClient => ({
    createCheckout: (input) => cfpayA2AOperation(config, "/a2a/payments", "checkout.create", input),
    getStatus: (requestId) => cfpayA2AOperation(config, "/a2a/payments", "checkout.status", { requestId }),
    fulfil: (requestId, paymentIntentId) =>
      cfpayA2AOperation(config, "/a2a/payments", "checkout.fulfil", { requestId, paymentIntentId }),
    listPayments: (limit) => cfpayA2AOperation(config, "/a2a/payments", "payments.list", { limit }),
    paymentsTotals: () => cfpayA2AOperation(config, "/a2a/payments", "payments.totals", {}),
  });

  const requireChannelConfig = (): NonNullable<ReturnType<typeof getCfpayConfig>> | Response => {
    const config = getCfpayConfig(ctx.env);
    if (!config) {
      return new Response(
        JSON.stringify({
          error: codedMessage("FAILURE_CHANNEL_NOT_CONFIGURED", "cfpay A2A token is not configured"),
          code: "FAILURE_CHANNEL_NOT_CONFIGURED",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    return config;
  };

  /**
   * The ledger row for a fulfilled channel purchase, written through
   * the ORM so the existing receipts route surfaces it (bounded
   * customer query, no gateway filter). Best-effort by the journal
   * precedent: a projection failure is loud + audited, never a
   * failed purchase — the draft (fulfilled) + audit trail remain the
   * record, and the purchases list still shows the payment.
   */
  const recordChannelTransactionBestEffort = async (draft: ChannelDraft): Promise<void> => {
    try {
      const orm = ctx.getOrm();
      const nowIso = new Date().toISOString();
      await orm.transactions.create({
        id: `tx_${draft.id}`,
        sessionId: draft.userLogin,
        action: "agentic_payment",
        amount: draft.expectedPriceUSD,
        currency: "USD",
        customer: draft.userLogin,
        gateway: "cfpay-channel",
        gatewayRef: draft.id,
        status: "completed",
        proposerDid: `did:key:${draft.userLogin}`,
        proofSignature: draft.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } catch (err) {
      ctx.audit("commercial.channel.receipt_row_failed", "payments", {
        userLogin: draft.userLogin,
        draftId: draft.id,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  };

const requireChannelMonetization = async (): Promise<Response | null> => {
    const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
    if (!flagOn) {
      return Response.json({ error: "monetization flag is OFF; cfpay channel purchases are disabled." }, { status: 403 });
    }
    return null;
  };

  // POST /payments/agentic/commercial/channel/checkout — mint.
  if (path.endsWith("/commercial/channel/checkout") && request.method === "POST") {
    const login = request.headers.get("x-user-login");
    if (!login) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: { "content-type": "application/json" } });
    const flagError = await requireChannelMonetization();
    if (flagError) return flagError;
    const configOrError = requireChannelConfig();
    if (configOrError instanceof Response) return configOrError;
    try {
      const body = (await request.json().catch(() => null)) as { family?: unknown; email?: unknown } | null;
      const store = createCommercialAdapter(ctx.env as { AGENT_DB?: unknown });
      const subs = createSubscriptionAdapter(ctx.env as { AGENT_DB?: unknown });
      const policyAdapter = createBillingPolicyAdapter(ctx.env as { AGENT_DB?: unknown });
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      const drafts = createChannelDraftAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!store || !subs || !policyAdapter || !catalogue || !drafts) {
        return new Response(JSON.stringify({ error: "Store is not available." }), { status: 503, headers: { "content-type": "application/json" } });
      }
      await ensureCommercialSchema(store.db);
      await ensureSubscriptionSchema(subs.db);
      await ensureBillingPolicySchema(policyAdapter.db);
      await ensurePriceCatalogueSchema(catalogue.db);
      await ensureChannelSchema(drafts.db);
      const identity = await resolvePlatformIdentity(
        { commercial: store, subscriptions: subs },
        { userId: login, nowMs: Date.now() },
      );
      const policy = await policyAdapter.getPolicy();
      const result = await mintChannelPurchase(
        {
          drafts,
          catalogue,
          channelFixedPriceUSD: policy.cfpayChannelFixedPriceUSD,
          cfpay: channelClientFor(configOrError),
          nowMs: Date.now(),
        },
        {
          userLogin: login,
          tenantId: identity.tenantId ?? login,
          email: body?.email,
          family: body?.family,
        },
      );
      ctx.audit("commercial.channel.checkout_created", "payments", {
        userLogin: login,
        draftId: result.draft.id,
        family: result.draft.family,
        expectedPriceUSD: result.draft.expectedPriceUSD,
      });
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return channelErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/channel/purchase — confirm (HITL).
  if (path.endsWith("/commercial/channel/purchase") && request.method === "POST") {
    const login = request.headers.get("x-user-login");
    if (!login) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: { "content-type": "application/json" } });
    const flagError = await requireChannelMonetization();
    if (flagError) return flagError;
    const configOrError = requireChannelConfig();
    if (configOrError instanceof Response) return configOrError;
    try {
      const body = (await request.json().catch(() => null)) as { channelRequestId?: unknown } | null;
      const channelRequestId =
        typeof body?.channelRequestId === "string" && body.channelRequestId.trim()
          ? body.channelRequestId.trim()
          : (() => {
              throw new Error("channel request id is required.");
            })();
      const store = createCommercialAdapter(ctx.env as { AGENT_DB?: unknown });
      const subs = createSubscriptionAdapter(ctx.env as { AGENT_DB?: unknown });
      const drafts = createChannelDraftAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!store || !subs || !drafts) {
        return new Response(JSON.stringify({ error: "Store is not available." }), { status: 503, headers: { "content-type": "application/json" } });
      }
      await ensureCommercialSchema(store.db);
      await ensureSubscriptionSchema(subs.db);
      await ensureChannelSchema(drafts.db);
      // A first-time buyer has no commercial account yet: create it
      // (Free tier). Tenant falls back to the login, the same
      // fallback the billing-purchase route uses
      // (identity.tenantId ?? login).
      const identity = await resolvePlatformIdentity(
        { commercial: store, subscriptions: subs },
        { userId: login, nowMs: Date.now() },
      );
      const existing = await store.getAccount(login);
      if (!existing) {
        await store.upsertAccount({ userId: login, tenantId: identity.tenantId ?? login, tier: "Free" });
      }
      const result = await confirmChannelPurchase(
        {
          drafts,
          cfpay: channelClientFor(configOrError),
          adjustCredits: async (userId, deltaUSD) => {
            const record = await store.adjustCredits(userId, deltaUSD);
            return { userId, creditsUSD: record.creditsUSD };
          },
          recordTransaction: recordChannelTransactionBestEffort,
          audit: (type, payload) => ctx.audit(type, "payments", payload),
          nowMs: Date.now(),
        },
        { userLogin: login, channelRequestId },
      );
      ctx.audit("commercial.channel.fulfilled", "payments", {
        userLogin: login,
        draftId: result.draft.id,
        family: result.draft.family,
        creditedUSD: result.account.creditsUSD,
        fulfilSkippedReason: result.draft.fulfilSkippedReason,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return channelErrorResponse(err);
    }
  }

  // GET /payments/agentic/commercial/channel/purchases?userId= — read, not flag-gated.
  if (path.endsWith("/commercial/channel/purchases") && request.method === "GET") {
    const login = request.headers.get("x-user-login");
    if (!login) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: { "content-type": "application/json" } });
    const targetUser = url.searchParams.get("userId") ?? login;
    if (!canAccessAccount(login, targetUser)) {
      return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "content-type": "application/json" } });
    }
    try {
      const drafts = createChannelDraftAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!drafts) {
        return new Response(JSON.stringify({ error: "Store is not available." }), { status: 503, headers: { "content-type": "application/json" } });
      }
      await ensureChannelSchema(drafts.db);
      const purchases = await drafts.listByUser(targetUser);
      return new Response(JSON.stringify({ purchases }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return channelErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/channel/reconcile — operator-only, not flag-gated.
  if (path.endsWith("/commercial/channel/reconcile") && request.method === "POST") {
    const login = request.headers.get("x-user-login");
    if (!login) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: { "content-type": "application/json" } });
    if (!isStoreOperator(login)) {
      return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const configOrError = requireChannelConfig();
    if (configOrError instanceof Response) return configOrError;
    try {
      const drafts = createChannelDraftAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!drafts) {
        return new Response(JSON.stringify({ error: "Store is not available." }), { status: 503, headers: { "content-type": "application/json" } });
      }
      await ensureChannelSchema(drafts.db);
      const result = await reconcileChannel({ drafts, cfpay: channelClientFor(configOrError) });
      ctx.audit("commercial.channel.reconciled", "payments", {
        userLogin: login,
        verdict: result.verdict,
        localFulfilledCount: result.local.count,
        localTotalUSD: result.local.totalUSD,
        reason: result.reason,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return channelErrorResponse(err);
    }
  }

  // POST /payments/agentic/commercial/subscription/cancel — cancel.
  // Issue #2662 (Phase 2.7): the timing follows the OPERATOR billing
  // policy's downgradeTiming. period_end (the default) = existing
  // cancel-at-period-end: access continues to periodEnd, then stops.
  // immediate = provider DELETE + local truncation: Billing rows via
  // cancelBillingImmediately, repurchase rows via revokeSubscription
  // (status canceled AND periodEnd moves to now — plain
  // cancelSubscription keeps periodEnd, and resolveEffectiveTier
  // confers Subscribed on periodEndMs alone, so it would NOT stop
  // access). The policy read is read-only and fail-safe: an
  // unavailable policy store (or a read throw) falls back to
  // period_end — access is never truncated without an explicit
  // operator choice. No cash refund (deferred #2024; refunds go
  // through the #2204 request → approve → execute routes).
  // Self-service, or an operator on a user's behalf (body.userId).
  // Issue #2656 (Phase 2.1): Billing-aware. A locally-only cancel of
  // a Billing-managed row would leave Stripe charging while access
  // shows canceled — so Billing rows are provider-canceled FIRST
  // (provider + local), and repurchase rows are canceled per-row
  // after. Any provider failure refuses with 503 before the
  // repurchase rows run (row-by-row provider semantics, same as the
  // at-period-end path — no stronger atomicity is claimed).
  // Cancel uses the Billing port regardless of flag state: cancel
  // STOPS money, never starts it, so the monetization flag (which
  // gates money-starting actions) must never block a user from
  // stopping charges.
  // Issue #3523 (2.14 follow-up): outcomes are outcome-catalog coded (SUCCESS_SUBSCRIPTION_
  // CANCELED_PERIOD_END / _IMMEDIATE on success; FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE 409 on
  // replay; FAILURE_SUBSCRIPTION_CANCEL_NOT_CONFIGURED / _FAILED 503 on provider failure — no raw
  // provider text in any body). The cancel is tenant-scoped to the server-resolved account tenant
  // (resolvePlatformIdentity, #2219 mechanism), rechecked by id before execution, and the audit
  // carries code + message + login + tenant. Repurchase rows cancel per-row over the verified set
  // (not the bulk user-keyed call), so out-of-scope tenant rows are never touched.
  if (path.endsWith("/payments/agentic/commercial/subscription/cancel") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
      const targetUser = typeof body.userId === "string" && body.userId ? body.userId : login;
      if (targetUser !== login && !isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: only the subscriber or a store operator may cancel." }, { status: 403 });
      }
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const nowMs = Date.now();
      // Issue #3523: resolve the target user's platform identity first (#2219 mechanism).
      // The cancel is tenant-scoped to the resolved account tenant; a client-supplied tenantId
      // is never read (the body carries no identifiers — POST {}). When no account row resolves,
      // the cancel stays user-scoped: cancel stops money and must never be blocked by a missing
      // account row; the audit records the unresolved scope.
      const identity = await resolvePlatformIdentity(
        { commercial: store, subscriptions: subs },
        { userId: targetUser, nowMs },
      );
      const tenantId = identity.tenantId;
      const tenantScope = identity.hasAccount ? "resolved" : "unresolved";
      const unexpired = (await subs.listSubscriptions(targetUser)).filter(
        (s) => s.status === "active" && s.periodEndMs > nowMs,
      );
      const inScope = tenantScope === "resolved" ? unexpired.filter((s) => s.tenantId === tenantId) : unexpired;
      // Issue #2662: read-only policy read; any failure falls back to
      // period_end (fail-safe toward preserving access).
      let downgradeTiming: "period_end" | "immediate" = "period_end";
      try {
        const policyAdapter = createBillingPolicyAdapter(ctx.env as { AGENT_DB?: unknown });
        if (policyAdapter) {
          const billingPolicy = await policyAdapter.getPolicy();
          if (billingPolicy.downgradeTiming === "immediate") downgradeTiming = "immediate";
        }
      } catch {
        downgradeTiming = "period_end";
      }
      // Issue #3523 (tech-standards §6): recheck authorization before the consequential
      // execution — re-read each in-scope row by id and verify it still belongs to the target
      // user, is still active + unexpired, and is still in the resolved tenant scope.
      const verified = [];
      for (const row of inScope) {
        const fresh = await subs.getSubscription(row.id);
        if (
          fresh &&
          fresh.userId === targetUser &&
          fresh.status === "active" &&
          fresh.periodEndMs > nowMs &&
          (tenantScope === "unresolved" || fresh.tenantId === tenantId)
        ) {
          verified.push(fresh);
        }
      }
      // Remaining = still-active rows this request did not cancel (out-of-scope tenant rows,
      // rows failing the recheck, rows not yet attempted on failure). Computed from a fresh
      // re-list so the response always reports the verified state, never a claimed one.
      const remainingAfter = async (canceledIds: string[]) => {
        const current = await subs.listSubscriptions(targetUser);
        return current.filter(
          (s) => s.status === "active" && s.periodEndMs > nowMs && !canceledIds.includes(s.id),
        );
      };
      if (verified.length === 0) {
        // Issue #3523 (standards §7.2 Idempotent Receiver): the dedup key is the set of
        // unexpired in-scope rows — a replay finds none and returns 409, never a 200 that
        // claims a cancel happened.
        const remaining = await remainingAfter([]);
        return Response.json(
          {
            code: "FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE",
            message: resolveOutcome("FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE").entry!.businessMessage,
            retryable: false,
            canceled: [],
            remaining,
          },
          { status: 409 },
        );
      }
      const billingRows = verified.filter((s) => isBillingManaged(s));
      const repurchaseRows = verified.filter((s) => !isBillingManaged(s));
      let canceled: Array<{ id: string; periodEndMs: number; createdAtMs: number }> = [];
      let billingCanceledIds: string[] = [];
      if (billingRows.length === 0) {
        // Issue #3523: repurchase rows cancel per-row over the verified set (not the bulk
        // user-keyed call), so out-of-scope tenant rows are never touched.
        for (const row of repurchaseRows) {
          const one =
            downgradeTiming === "immediate"
              ? await subs.revokeSubscription(row.id, nowMs)
              : await subs.cancelSubscription(row.id, nowMs);
          if (one) canceled.push(one);
        }
        canceled.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      } else {
        const billing = createBillingPorts(ctx.env as unknown as BillingEnv, true);
        if (!billing) {
          const remaining = await remainingAfter([]);
          return Response.json(
            {
              code: "FAILURE_SUBSCRIPTION_CANCEL_NOT_CONFIGURED",
              message: resolveOutcome("FAILURE_SUBSCRIPTION_CANCEL_NOT_CONFIGURED").entry!.businessMessage,
              retryable: false,
              canceled: [],
              remaining,
            },
            { status: 503 },
          );
        }
        const billingCanceled = [];
        try {
          for (const row of billingRows) {
            billingCanceled.push(
              downgradeTiming === "immediate"
                ? await cancelBillingImmediately({ billing, subs, subscriptionId: row.id })
                : await cancelBillingAtPeriodEnd({ billing, subs, subscriptionId: row.id }),
            );
          }
        } catch {
          // Issue #3523: fail closed with the coded failure — no raw provider text in the
          // body. Rows canceled before the failure stay canceled; the response + audit report
          // the verified partial state (canceled vs remaining), never an all-or-nothing claim.
          const partialIds = billingCanceled.map((s) => s.id);
          const remaining = await remainingAfter(partialIds);
          ctx.audit("commercial.subscription.cancel_failed", "payments", {
            userId: targetUser,
            tenantId,
            tenantScope,
            code: "FAILURE_SUBSCRIPTION_CANCEL_FAILED",
            message: resolveOutcome("FAILURE_SUBSCRIPTION_CANCEL_FAILED").entry!.businessMessage,
            subscriptionIds: billingRows.map((s) => s.id),
            canceledIds: partialIds,
          });
          return Response.json(
            {
              code: "FAILURE_SUBSCRIPTION_CANCEL_FAILED",
              message: resolveOutcome("FAILURE_SUBSCRIPTION_CANCEL_FAILED").entry!.businessMessage,
              retryable: true,
              canceled: billingCanceled,
              remaining,
            },
            { status: 503 },
          );
        }
        billingCanceledIds = billingCanceled.map((s) => s.id);
        const repurchaseCanceled = [];
        for (const row of repurchaseRows) {
          const one =
            downgradeTiming === "immediate"
              ? await subs.revokeSubscription(row.id, nowMs)
              : await subs.cancelSubscription(row.id, nowMs);
          if (one) repurchaseCanceled.push(one);
        }
        canceled = [...billingCanceled, ...repurchaseCanceled].sort(
          (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      }
      const accessThroughMs = canceled.length > 0 ? Math.max(...canceled.map((s) => s.periodEndMs)) : null;
      const cancelCode =
        downgradeTiming === "immediate"
          ? "SUCCESS_SUBSCRIPTION_CANCELED_IMMEDIATE"
          : "SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END";
      const cancelMessage = resolveOutcome(cancelCode).entry!.businessMessage;
      const remaining = await remainingAfter(canceled.map((s) => s.id));
      // Issue #2522: cancel-at-period-end changes no periodEndMs,
      // so the effective tier is unchanged — the audit states the
      // tier at cancel time (access continues to periodEnd),
      // never a claimed change. Immediate cancel truncates access,
      // so the after rows state the truncated tier.
      const cancelSubscriptions = await subs.listSubscriptions(targetUser);
      ctx.audit("commercial.subscription.canceled", "payments", {
        userId: targetUser,
        tenantId,
        tenantScope,
        code: cancelCode,
        message: cancelMessage,
        subscriptionIds: canceled.map((s) => s.id),
        billingCanceledIds,
        remainingIds: remaining.map((s) => s.id),
        accessThroughMs,
        downgradeTiming,
        effectiveTier: resolveEffectiveTier(identity.stored, cancelSubscriptions, Date.now()),
      });
      return Response.json({
        userId: targetUser,
        code: cancelCode,
        message: cancelMessage,
        canceled,
        remaining,
        accessThroughMs,
        downgradeTiming,
      });
    } catch {
      return Response.json(
        {
          code: "FAILURE_UNEXPECTED_ERROR",
          message: codedMessage("FAILURE_UNEXPECTED_ERROR"),
        },
        { status: 500 },
      );
    }
  }

  // POST /payments/agentic/commercial/subscription/billing-change-plan —
  // Issue #2662: operator-only plan change on a Billing-managed row.
  // This is the FIRST provider subscription update path in the codebase,
  // and the reason prorationBehavior is no longer decorative policy:
  // the update sends the OPERATOR billing policy's proration_behavior
  // (none / create_prorations / always_invoice) to Stripe. FLAG-GATED
  // (a plan change alters what the provider charges — a money
  // path, unlike cancel, which stops money and is never flag-blocked).
  // Operator-only: the operator's explicit invocation IS the HITL;
  // self-service plan changes go through billing-purchase checkout.
  // Fail-closed chain (service): row exists, Billing-managed, active,
  // unexpired; plan exists and is active; price operator-mapped;
  // provider price differs. Provider failure changes nothing locally
  // (provider update runs before the local write).
  if (path.endsWith("/payments/agentic/commercial/subscription/billing-change-plan") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      if (!flagOn) {
        return Response.json({ error: "monetization flag is OFF; plan changes are disabled." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { subscriptionId?: unknown; planId?: unknown };
      const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId : "";
      const planId = typeof body.planId === "string" ? body.planId : "";
      if (!subscriptionId) return Response.json({ error: "subscriptionId is required." }, { status: 400 });
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const billingPolicyAdapter = requireBillingPolicy();
      if (billingPolicyAdapter instanceof Response) return billingPolicyAdapter;
      try {
        await ensureBillingPolicySchema(billingPolicyAdapter.db);
      } catch (err: any) {
        return Response.json({ error: `Billing policy store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const billingPolicy = await billingPolicyAdapter.getPolicy();
      const billing = createBillingPorts(ctx.env as unknown as BillingEnv, true);
      if (!billing) {
        return Response.json({ error: "Billing plan change is not configured (Stripe)." }, { status: 503 });
      }
      const existingRow = await subs.getSubscription(subscriptionId);
      if (!existingRow) return Response.json({ error: `No subscription ${subscriptionId}.` }, { status: 404 });
      const beforeAccount = await store.getAccount(existingRow.userId);
      const beforeSubscriptions = await subs.listSubscriptions(existingRow.userId);
      let changed;
      try {
        changed = await changeBillingPlanPrice({ billing, subs, policy: billingPolicy, subscriptionId, planId });
      } catch (err: any) {
        // Issue #3357: a catalog-coded refusal (unapproved target plan)
        // renders from the catalog with its catalog status (402).
        if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
        const message = err.message || "Failed to change plan";
        const status = /No subscription|No plan/.test(message)
          ? 404
          : /already on price/.test(message)
            ? 409
            : /not active|repurchase|not active and unexpired/.test(message)
              ? 400
              : /no operator-mapped|not configured|Billing policy/.test(message)
                ? 503
                : /Stripe Billing request failed/.test(message)
                  ? 502
                  : 500;
        return Response.json({ error: message }, { status });
      }
      const afterAccount = await store.getAccount(changed.record.userId);
      const afterSubscriptions = await subs.listSubscriptions(changed.record.userId);
      const transition = resolveTierTransition(beforeAccount, beforeSubscriptions, afterAccount, afterSubscriptions, Date.now());
      ctx.audit("commercial.subscription.plan_changed", "payments", {
        subscriptionId: changed.record.id,
        userId: changed.record.userId,
        fromPlanId: changed.fromPlanId,
        toPlanId: changed.record.planId,
        prorationBehavior: changed.prorationBehavior,
        providerSubscriptionId: changed.record.providerSubscriptionId,
        previousEffectiveTier: transition.previousEffectiveTier,
        newEffectiveTier: transition.newEffectiveTier,
      });
      return Response.json({
        subscription: changed.record,
        fromPlanId: changed.fromPlanId,
        prorationBehavior: changed.prorationBehavior,
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to change plan" }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/subscription?userId= — self or operator. Effective tier included:
  // the stored account tier alone does not say whether the user is Subscribed right now.
  if (path.endsWith("/payments/agentic/commercial/subscription") && request.method === "GET") {
    try {
      const login = commercialLogin();
      const userId = url.searchParams.get("userId") ?? "";
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) {
        return Response.json({ error: "Forbidden: only the subscriber or a store operator may read a subscription." }, { status: 403 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const account = await store.getAccount(userId);
      const subscriptions = await subs.listSubscriptions(userId);
      const effectiveTier = resolveEffectiveTier(account, subscriptions, Date.now());
      const current =
        subscriptions.length > 0
          ? subscriptions.reduce((a, b) => (b.periodEndMs > a.periodEndMs ? b : a))
          : null;
      return Response.json({ userId, effectiveTier, current, subscriptions });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read subscription" }, { status: 500 });
    }
  }

  // Issue #2137: checkout UI support routes (commercial block, read-only
  // pricing + payment verification + goal-command builder). The UI never
  // hardcodes prices and never decides charging — the gate does. These
  // routes only expose server truth to the verified caller.
  //
  // GET /payments/agentic/commercial/pricing — server-truth family prices
  // (PROPOSED until owner approval), the monetization flag state, the
  // server-derived network marker, the externalized browser payment
  // scope, and the native gate's failure policy, all from one source
  // so UI copy can never drift from the gate. Prices come from the
  // operator catalogue (#2185) when the store is bound; the display
  // fallback to the proposed seeds below is DISPLAY ONLY — the gate
  // never reads it and never charges from it, so a store outage
  // shows proposed prices instead of failing the panel, but can
  // never mint a charge. This GET never ensures the schema (no
  // writes on a read path).
  //
  // Issue #2196 (slice 3, #2146): the network marker is DERIVED, never
  // hardcoded — Stripe test-vs-live mode from
  // StripePaymentStrategy.resolveApiKey plus the x402 network, but
  // only when the x402 checkout port actually exists (an unconfigured
  // rail contributes no network). The old hardcoded testnetOnly: true
  // is gone; the panel renders network.acceptsMainnet instead. The
  // browser scope defaults to card-only and is served here so it can
  // be widened by operator configuration (COMMERCIAL_BROWSER_PAYMENT_SCOPE)
  // without a client deploy. The failure policy is the native gate's
  // disclosure: a one-time replacement-run credit, never a cash
  // refund promise — refund copy lands with the refunds slice (#2147).
  if (path.endsWith("/payments/agentic/commercial/pricing") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const monetizationEnabled = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      let prices: Record<string, number> = { ...PROPOSED_SEED_PRICES };
      try {
        const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
        if (catalogue) {
          const entries = await catalogue.getAllPrices();
          if (entries.length > 0) {
            prices = Object.fromEntries(entries.map((e) => [e.family, e.priceUSD]));
          }
        }
      } catch {
        // Display fallback only (see above): keep the proposed seeds.
      }
      const envRecord = ctx.env as unknown as Record<string, unknown>;
      const ports = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      let stripeMode: StripeDisplayMode = "unconfigured";
      try {
        const { apiKey, mode } = new StripePaymentStrategy().resolveApiKey(ctx.env);
        // The MCP-remote path is not a screener card configuration, so
        // a mode without a direct REST key still counts as unconfigured.
        stripeMode = apiKey ? mode : "unconfigured";
      } catch {
        stripeMode = "unconfigured";
      }
      const x402Network = ports?.x402
        ? typeof envRecord.X402_NETWORK === "string" && envRecord.X402_NETWORK.trim().length > 0
          ? (envRecord.X402_NETWORK as string)
          : "base-sepolia"
        : null;
      // Issue #3262: top-up bounds for the Top up tab — read-only
      // policy read, no ensure on a read path; null when the policy
      // store is unavailable (the UI then shows the limits as
      // unavailable; mint still validates server-side).
      let topUpLimits: { minUSD: number; maxUSD: number } | null = null;
      try {
        const policy = requireBillingPolicy();
        if (!(policy instanceof Response)) {
          const policyValue = await policy.getPolicy();
          topUpLimits = { minUSD: policyValue.topUpMinUSD, maxUSD: policyValue.topUpMaxUSD };
        }
      } catch {
        // Unavailable: keep null (see above).
      }
      return Response.json({
        monetizationEnabled,
        prices,
        topUpLimits,
        network: deriveNetworkMarker({ stripeMode, x402Network }),
        browserPaymentScope: resolveBrowserPaymentScope(envRecord.COMMERCIAL_BROWSER_PAYMENT_SCOPE),
        failurePolicy: NATIVE_PAYMENT_DISCLOSURE,
      });
    } catch {
      return Response.json({ error: "Failed to read pricing." }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/prices (operator only, issue 2739)
  // — the operator price-entries read: the full catalogue entries
  // (family, price, updated time, approval status, approver, approval
  // time) for the price management UI. The pricing GET returns price
  // values only, so this read is what lets the UI show real approval
  // state instead of Unknown. Operator gating mirrors the POST route
  // (COMMERCIAL_STORE_OPERATORS, empty = deny all); a missing login
  // is 401 like the pricing GET. This GET never ensures the schema
  // (no writes on a read path, mirroring the pricing GET); an
  // unbound store is 503, never a silent no-op.
  if (path.endsWith("/payments/agentic/commercial/prices") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) {
        return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      }
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!catalogue) {
        return Response.json({ error: "Price catalogue unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      const entries = await catalogue.getAllPrices();
      return Response.json({ entries });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read prices." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/prices (operator only, #2185)
  // — the operator price upsert: changing a per-run price needs no
  // code deploy, because the gate reads the catalogue, not code.
  // Operator gating follows the commercial pattern above
  // (COMMERCIAL_STORE_OPERATORS, empty = deny all). A money write
  // path, so the schema is ensured first (migration 0011 seeds
  // the proposed defaults on a fresh store; the upsert then
  // overwrites exactly the family named). Invalid family or price
  // is 400; an unbound store is 503, never a silent no-op.
  if (path.endsWith("/payments/agentic/commercial/prices") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        family?: unknown;
        priceUSD?: unknown;
        approvalStatus?: unknown;
      };
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!catalogue) {
        return Response.json({ error: "Price catalogue unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      try {
        await ensurePriceCatalogueSchema(catalogue.db);
      } catch (err: any) {
        return Response.json({ error: `Price catalogue unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      // #2547: a price write lands as PROPOSED (setPrice clears
      // any prior approval). Approval is a separate, explicit
      // operator action on this same route: approvalStatus
      // "approved" records THIS verified operator login as the
      // approver — the body cannot name a different approver.
      if (body.approvalStatus !== undefined && body.approvalStatus !== "approved") {
        return Response.json(
          { error: 'approvalStatus must be "approved" when present: use a price write to return an entry to proposed.' },
          { status: 400 },
        );
      }
      let entry = null;
      if (body.priceUSD !== undefined) {
        entry = await catalogue.setPrice({ family: body.family, priceUSD: body.priceUSD });
        ctx.audit("commercial.price.set", "payments", { family: entry.family, priceUSD: entry.priceUSD });
      }
      if (body.approvalStatus === "approved") {
        entry = await catalogue.approvePrice({ family: body.family, approverId: login });
        ctx.audit("commercial.price.approved", "payments", {
          family: entry.family,
          priceUSD: entry.priceUSD,
          approvedBy: entry.approvedBy,
          approvedAtMs: entry.approvedAtMs,
        });
      }
      if (!entry) {
        return Response.json(
          { error: "Nothing to do: provide priceUSD to set a price or approvalStatus approved to approve one." },
          { status: 400 },
        );
      }
      return Response.json({ entry });
    } catch (err: any) {
      const message = err.message || "Failed to set price";
      return Response.json({ error: message }, { status: /Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // Issue #3289 — per-customer version move + segment assignment (slice 1 primitives, operator only).
  // No UI, no bulk job: these are the move primitives the slice-2 Products UI will call.
  // POST /payments/agentic/commercial/subscriptions/:subscriptionId/move — move ONE subscription
  // to another version of the SAME product. The target must be the effective, approved version
  // for the holder's segment; a move onto a superseded, future, expired, deactivated, or
  // unapproved version refuses (409), as does a move across products. A move onto the version
  // already held is a no-op success ({ moved: false }). Runs and credits are untouched.
  if (
    path.includes("/payments/agentic/commercial/subscriptions/") &&
    path.endsWith("/move") &&
    request.method === "POST"
  ) {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      const rawId = parts[parts.indexOf("subscriptions") + 1] ?? "";
      let subscriptionId = rawId;
      try {
        subscriptionId = decodeURIComponent(rawId);
      } catch {
        subscriptionId = rawId;
      }
      const body = (await request.json().catch(() => ({}))) as { toVersionId?: unknown; reason?: unknown };
      const toVersionId = typeof body.toVersionId === "string" ? body.toVersionId.trim() : "";
      if (!subscriptionId) return Response.json({ error: "subscriptionId is required." }, { status: 400 });
      if (!toVersionId) return Response.json({ error: "toVersionId is required." }, { status: 400 });
      const reason = typeof body.reason === "string" ? body.reason : null;
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const products = requireProducts();
      if (products instanceof Response) return products;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      try {
        await ensureProductSchema(products.db);
      } catch (err: any) {
        return Response.json({ error: `Product store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const result = await moveSubscriptionToVersion({
        subs,
        store,
        products,
        subscriptionId,
        toVersionId,
        movedBy: login as string,
        reason,
      });
      ctx.audit("commercial.product.move", "payments", {
        userId: result.subscription.userId,
        subscriptionId: result.subscription.id,
        fromVersionId: result.fromVersionId,
        toVersionId: result.toVersionId,
        movedBy: login,
        moved: result.moved,
        ...(reason ? { reason } : {}),
      });
      return Response.json({
        subscription: result.subscription,
        moved: result.moved,
        fromVersionId: result.fromVersionId,
        toVersionId: result.toVersionId,
      });
    } catch (err: any) {
      const message = err.message || "Failed to move subscription";
      const status = /No subscription|No plan version/.test(message)
        ? 404
        : /Cannot move|not the effective version|not approved|not active/.test(message)
          ? 409
          : /required|must be/.test(message)
            ? 400
            : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // POST /payments/agentic/commercial/accounts/:userId/segment — assign an account's segment
  // (operator only). The segment changes what the NEXT per-run charge resolves to (and what a
  // future move may target); it changes nothing about held versions, runs, or credits. The
  // move audit records the held version when one exists.
  if (
    path.includes("/payments/agentic/commercial/accounts/") &&
    path.endsWith("/segment") &&
    request.method === "POST"
  ) {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      const rawId = parts[parts.indexOf("accounts") + 1] ?? "";
      let userId = rawId;
      try {
        userId = decodeURIComponent(rawId);
      } catch {
        userId = rawId;
      }
      const body = (await request.json().catch(() => ({}))) as { segment?: unknown; reason?: unknown };
      const segment = typeof body.segment === "string" ? body.segment.trim() : "";
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!segment) return Response.json({ error: "segment is required." }, { status: 400 });
      const reason = typeof body.reason === "string" ? body.reason : null;
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const products = requireProducts();
      if (products instanceof Response) return products;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      try {
        await ensureProductSchema(products.db);
      } catch (err: any) {
        return Response.json({ error: `Product store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const result = await setAccountSegment({
        store,
        subs,
        products,
        userId,
        segment,
        movedBy: login as string,
        reason,
      });
      ctx.audit("commercial.account.segment.set", "payments", {
        userId,
        previousSegment: result.previousSegment,
        segment: result.segment,
        movedBy: login,
        ...(reason ? { reason } : {}),
      });
      return Response.json({
        account: result.account,
        previousSegment: result.previousSegment,
        segment: result.segment,
      });
    } catch (err: any) {
      const message = err.message || "Failed to set account segment";
      const status = /No commercial account/.test(message)
        ? 404
        : /required|must be|Invalid segment/.test(message)
          ? 400
          : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // Issue #3289 slice 2 — Products admin routes (operator only).
  // The Products section's reads and writes: product identity,
  // version chains, version approve/deactivate, catalogue
  // version chains + creation, and the bulk-move job. All
  // operator-only, all audited (commercial.product.* for the
  // new actions; the approve/deactivate actions reuse the
  // existing commercial.plan.* audit events — a version
  // approve IS a plan approve, addressed by version id).
  // Reads never ensure the schema (no writes on a read path);
  // writes ensure first. Same-start version ties are allowed
  // (design §13 deviation 20): no route rejects a duplicate
  // effectiveFromMs — the resolver tiebreaks by version.
  const familyForProductId = (productId: string): (typeof PRICE_FAMILIES)[number] | null =>
    PRICE_FAMILIES.find((family) => perRunProductId(family) === productId) ?? null;
  const loadProductVersions = async (
    product: { id: string; kind: string },
    subs: D1SubscriptionAdapter,
    catalogue: ReturnType<typeof createPriceCatalogueAdapter>,
    packs: RunsPackAdapters | null,
    segment?: string,
  ): Promise<SubscriptionPlanRecord[] | PriceEntry[] | RunsPackVersion[]> => {
    if (product.kind === "subscription") {
      return subs.listVersions(product.id, segment);
    }
    // Issue #3246 slice 3: a runs_pack product's chain is its pack
    // versions. Reads never ensure the schema (the write paths do):
    // deploys migrate first, so the table exists whenever the code
    // serves traffic; a store without it fails closed here.
    if (product.kind === "runs_pack") {
      if (!packs) return [];
      return packs.versions.listVersions(product.id, segment);
    }
    const family = familyForProductId(product.id);
    if (!family || !catalogue) return [];
    return catalogue.listVersions(family, segment);
  };

  // GET /payments/agentic/commercial/products (operator only) —
  // the Products section's data source: every product with its
  // full version chain embedded (all segments; the UI groups
  // by segment and marks the effective version per segment
  // with the one resolver). Free (prod-free) rides along as
  // the read-only baseline row with no versions.
  if (path.endsWith("/payments/agentic/commercial/products") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      const packs = createRunsPackAdapters(ctx.env as { AGENT_DB?: unknown });
      const listed = await products.listProducts();
      const withVersions = [];
      for (const product of listed) {
        withVersions.push({
          product,
          versions: await loadProductVersions(product, subs, catalogue, packs),
        });
      }
      return Response.json({ products: withVersions });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list products." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/products (operator only) —
  // create a product (identity only; versions are created
  // separately). The id is server-generated unless the caller
  // supplies one; the name + kind are operator data.
  if (path.endsWith("/payments/agentic/commercial/products") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        id?: unknown;
        name?: unknown;
        kind?: unknown;
        description?: unknown;
        rank?: unknown;
      };
      const products = requireProducts();
      if (products instanceof Response) return products;
      try {
        await ensureProductSchema(products.db);
      } catch (err: any) {
        return Response.json({ error: `Product store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const product = await products.createProduct(body);
      ctx.audit("commercial.product.created", "payments", {
        productId: product.id,
        name: product.name,
        kind: product.kind,
        createdBy: login,
      });
      return Response.json({ product });
    } catch (err: any) {
      const message = err.message || "Failed to create product.";
      const status = /required|Invalid|must be/.test(message) ? 400 : /already exists/.test(message) ? 409 : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // ================================================================
  // Upgrade offers (#3246, sub-issue of #3241) — the server-computed
  // offer derivation (§5.1): one pure service (resolveOffer), three
  // thin offer routes, and the set-rank route. The routes bind
  // ports, validate the thin HTTP contract, and audit; all
  // eligibility, ladder, and payload logic lives in the service.
  // ================================================================

  // Bind every port the offer derivation reads. Required ports read
  // as null when AGENT_DB is unbound — resolveOffer fails closed
  // with FAILURE_OFFER_UNAVAILABLE rather than deriving on a
  // partial store. Optional ports (counter, quota, referral) read
  // as null and the derivation treats them as unconfigured. Schema
  // ensures run for every bound adapter, so a fresh DB derives
  // instead of throwing on missing tables.
  const bindOfferPorts = async () => {
    const env = ctx.env as { AGENT_DB?: unknown };
    const store = createCommercialAdapter(env);
    const subs = createSubscriptionAdapter(env);
    const products = createProductAdapter(env);
    const catalogue = createPriceCatalogueAdapter(env);
    const policy = createBillingPolicyAdapter(env);
    const suppressions = createOfferSuppressionAdapter(env);
    const freeRunCounter = createFreeRunCounterAdapter(env);
    const quota = createApprovedFreeQuotaAdapter(env);
    const referral = createLifecycleAdapter(env);
    const runsPackAdapters = createRunsPackAdapters(env);
    const freeAccess = createFreeAccessGrantAdapter(env);
    if (store) await ensureCommercialSchema(store.db);
    if (subs) await ensureSubscriptionSchema(subs.db);
    if (catalogue) await ensurePriceCatalogueSchema(catalogue.db);
    if (products) await ensureProductSchema(products.db);
    if (policy) await ensureBillingPolicySchema(policy.db);
    if (freeRunCounter) await ensureFreeRunCounterSchema(freeRunCounter.db);
    if (quota) await quota.ensureSchema();
    if (referral) await ensureLifecycleSchema(referral.db);
    if (runsPackAdapters) await ensureRunsPackSchema(runsPackAdapters.balance.db);
    if (freeAccess) await ensureFreeAccessGrantSchema(freeAccess.db);
    return {
      store,
      subs,
      products,
      catalogue,
      policy,
      suppressions,
      freeRunCounter,
      quota,
      referral,
      freeAccess,
      runsPack: runsPackAdapters
        ? { versions: runsPackAdapters.versions, balance: runsPackAdapters.balance }
        : null,
    };
  };

  // POST /payments/agentic/commercial/offer — the triggered offer
  // endpoint. Body: { trigger, family?, runRequestId? }. Self-only:
  // the caller reads only their own offer; there is no userId
  // parameter. Client-supplied tenantId/segment/price are IGNORED
  // (never read — the segment and tenant come from the account
  // row, prices from the stores). A 400 answers an unknown
  // trigger, the ambient trigger (served by GET compare), a
  // missing family on an interruptive trigger, or an unknown
  // family. Every eligible response is audited
  // commercial.offer.shown BEFORE returning — an audit failure is
  // a 503, never a silent unaudited offer. Ineligible responses
  // are HTTP 200 with the reason code in the payload (the client
  // renders the fixed copy only). Unbound or failing stores are a
  // catalog-coded 503 (FAILURE_OFFER_UNAVAILABLE).
  if (path.endsWith("/payments/agentic/commercial/offer") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        trigger?: unknown;
        family?: unknown;
        runRequestId?: unknown;
      };
      let trigger: OfferTrigger;
      try {
        trigger = assertOfferTrigger(body.trigger);
      } catch {
        return Response.json({ error: "Unknown offer trigger." }, { status: 400 });
      }
      if (trigger === "ambient") {
        return Response.json(
          { error: "The ambient trigger is served by GET /payments/agentic/commercial/offer/compare." },
          { status: 400 },
        );
      }
      if (typeof body.family !== "string" || !body.family) {
        return Response.json({ error: `family is required for trigger ${trigger}.` }, { status: 400 });
      }
      let family: PriceFamily;
      try {
        family = assertPriceFamily(body.family);
      } catch {
        return Response.json({ error: `Invalid price family: ${String(body.family)}.` }, { status: 400 });
      }
      const runRequestId =
        typeof body.runRequestId === "string" && body.runRequestId ? body.runRequestId : undefined;
      const ports = await bindOfferPorts();
      const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      const checkoutPorts = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      const topUpAvailable =
        checkoutPorts !== null && (checkoutPorts.card !== null || checkoutPorts.x402 !== null);
      const payload = await resolveOffer({
        login,
        trigger,
        family,
        nowMs: Date.now(),
        monetizationEnabled: flagOn,
        topUpAvailable,
        ports,
      });
      if (payload.eligible) {
        const account = ports.store ? await ports.store.getAccount(login) : null;
        const shown = resolveOutcome("SUCCESS_OFFER_RESOLVED");
        ctx.audit("commercial.offer.shown", "payments", {
          login,
          tenantId: account?.tenantId ?? login,
          trigger,
          family,
          targetPlanIds: payload.targets.map((t) => t.versionId),
          segment: payload.current.segment,
          ...(runRequestId ? { runRequestId } : {}),
          code: shown.code,
          message: shown.businessMessage,
        });
      }
      return Response.json(payload);
    } catch (err: any) {
      if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
      return codedOutcomeResponse("FAILURE_OFFER_UNAVAILABLE");
    }
  }

  // GET /payments/agentic/commercial/offer/compare — the ambient
  // compare surface. Query: ?family= optional. Same payload shape,
  // trigger "ambient": populates downgradeTargets, ignores
  // suppressions, renders regardless of coverage. A pure read: NO
  // shown audit — ambient views are not offers, and auditing
  // every compare view would flood the log with non-decision reads.
  if (path.endsWith("/payments/agentic/commercial/offer/compare") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const familyParam = url.searchParams.get("family") ?? undefined;
      let family: PriceFamily | undefined;
      if (familyParam !== undefined) {
        try {
          family = assertPriceFamily(familyParam);
        } catch {
          return Response.json({ error: `Invalid price family: ${familyParam}.` }, { status: 400 });
        }
      }
      const ports = await bindOfferPorts();
      const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      const checkoutPorts = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      const topUpAvailable =
        checkoutPorts !== null && (checkoutPorts.card !== null || checkoutPorts.x402 !== null);
      const payload = await resolveOffer({
        login,
        trigger: "ambient",
        family,
        nowMs: Date.now(),
        monetizationEnabled: flagOn,
        topUpAvailable,
        ports,
      });
      return Response.json(payload);
    } catch (err: any) {
      if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
      return codedOutcomeResponse("FAILURE_OFFER_UNAVAILABLE");
    }
  }

  // POST /payments/agentic/commercial/offer/dismiss — record a
  // dismissal (§4.4). Body: { trigger, family? }. Dismissing
  // suppresses THAT trigger for THAT login until the operator
  // cooldown expires; re-dismissing re-arms from now. The ambient
  // trigger is never dismissible (400, catalog-coded, as is any
  // other validation failure on this route). The route audits
  // commercial.offer.dismissed BEFORE writing the suppression row:
  // an audit failure is a 503 and nothing is written, so a
  // dismissal is never silently unrecorded. Response 200 carries
  // { suppressedUntilMs }.
  if (path.endsWith("/payments/agentic/commercial/offer/dismiss") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { trigger?: unknown; family?: unknown };
      let trigger: OfferTrigger;
      try {
        trigger = assertOfferTrigger(body.trigger);
      } catch {
        return codedOutcomeResponse("FAILURE_OFFER_DISMISS_INVALID");
      }
      if (trigger === "ambient") {
        return codedOutcomeResponse("FAILURE_OFFER_DISMISS_INVALID");
      }
      let family: PriceFamily | undefined;
      if (body.family !== undefined) {
        try {
          family = assertPriceFamily(body.family);
        } catch {
          return codedOutcomeResponse("FAILURE_OFFER_DISMISS_INVALID");
        }
      }
      const env = ctx.env as { AGENT_DB?: unknown };
      const store = createCommercialAdapter(env);
      const policy = createBillingPolicyAdapter(env);
      const suppressions = createOfferSuppressionAdapter(env);
      if (!store || !policy || !suppressions) {
        return codedOutcomeResponse("FAILURE_OFFER_UNAVAILABLE");
      }
      await ensureCommercialSchema(store.db);
      await ensureBillingPolicySchema(policy.db);
      await ensureOfferSuppressionSchema(suppressions.db);
      const rules = (await policy.getPolicy()).offerRules;
      const nowMs = Date.now();
      const suppressedUntilMs = nowMs + rules.dismissCooldownDays * 86400000;
      const account = await store.getAccount(login);
      const dismissed = resolveOutcome("SUCCESS_OFFER_DISMISSED");
      ctx.audit("commercial.offer.dismissed", "payments", {
        login,
        tenantId: account?.tenantId ?? login,
        trigger,
        ...(family ? { family } : {}),
        suppressedUntilMs,
        cooldownDays: rules.dismissCooldownDays,
        code: dismissed.code,
        message: dismissed.businessMessage,
      });
      await suppressions.setSuppression({ login, trigger, suppressedUntilMs, dismissedAtMs: nowMs });
      return Response.json({ suppressedUntilMs });
    } catch (err: any) {
      if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
      return codedOutcomeResponse("FAILURE_OFFER_UNAVAILABLE");
    }
  }

  // POST /payments/agentic/commercial/products/:productId/rank
  // (operator only) — set (or clear, with explicit null) a
  // product's ladder rank. Rank is a positive whole number or
  // null; anything else is a catalog-coded 400. The Free baseline
  // (prod-free) carries the definitional ladder floor, rank 1,
  // and refuses with the same code at 409. Audited
  // commercial.product.rank.set with the old and new rank.
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.endsWith("/rank") &&
    request.method === "POST"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
      } catch {
        // Keep the raw segment; the lookup below 404s on it.
      }
      const rawBody: unknown = await request.json().catch(() => ({}));
      const body = (
        typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody) ? rawBody : {}
      ) as { rank?: unknown };
      if (body.rank === undefined) {
        return codedOutcomeResponse("FAILURE_PRODUCT_RANK_INVALID");
      }
      let rank: number | null;
      try {
        rank = assertProductRank(body.rank);
      } catch {
        return codedOutcomeResponse("FAILURE_PRODUCT_RANK_INVALID");
      }
      if (productId === FREE_PRODUCT_ID) {
        const resolved = resolveOutcome("FAILURE_PRODUCT_RANK_INVALID");
        return Response.json(
          {
            code: resolved.code,
            message: resolved.businessMessage,
            retryable: resolved.entry?.retryable ?? false,
          },
          { status: 409 },
        );
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      try {
        await ensureProductSchema(products.db);
      } catch (err: any) {
        return Response.json({ error: `Product store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const existing = await products.getProduct(productId);
      if (!existing) return Response.json({ error: `No product ${productId}.` }, { status: 404 });
      const oldRank = existing.rank;
      const updated = await products.setProductRank(productId, rank);
      const ranked = resolveOutcome("SUCCESS_PRODUCT_RANK_UPDATED");
      ctx.audit("commercial.product.rank.set", "payments", {
        productId,
        oldRank,
        newRank: rank,
        operator: login,
        code: ranked.code,
        message: ranked.businessMessage,
      });
      return Response.json({ product: updated });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to set product rank." }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/products/:productId/versions
  // (operator only) — the full version chain for one product,
  // optionally narrowed to one segment (?segment=). The admin
  // chain read; buyers never see it (GET /plans stays the
  // effective-only per-segment buyer read).
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.endsWith("/versions") &&
    request.method === "GET"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
      } catch {
        // Keep the raw segment; the lookup below 404s on it.
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      const packs = createRunsPackAdapters(ctx.env as { AGENT_DB?: unknown });
      const product = await products.getProduct(productId);
      if (!product) return Response.json({ error: `No product ${productId}.` }, { status: 404 });
      const segment = url.searchParams.get("segment") ?? undefined;
      const versions = await loadProductVersions(product, subs, catalogue, packs, segment);
      return Response.json({ product, versions });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read version chain." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/products/:productId/versions
  // (operator only) — create a version of a subscription product
  // or a runs-pack version of a runs_pack product. The version
  // lands PROPOSED with a server-assigned number (max + 1 for the
  // product+segment); approval is the separate approve action. A
  // price change is never an in-place edit: it is always a new
  // version. The Free baseline (prod-free) carries no versions
  // and refuses. A pack version's terms are (runs, price) —
  // never derived from a per-run price.
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.endsWith("/versions") &&
    request.method === "POST"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
      } catch {
        // Keep the raw segment; the lookup below 404s on it.
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const priceUSD = body.priceUSD;
      if (typeof priceUSD !== "number" || !Number.isFinite(priceUSD) || priceUSD < 0) {
        return Response.json({ error: "priceUSD must be a finite non-negative number." }, { status: 400 });
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      try {
        await ensureProductSchema(products.db);
      } catch (err: any) {
        return Response.json({ error: `Product store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const product = await products.getProduct(productId);
      if (!product) return Response.json({ error: `No product ${productId}.` }, { status: 404 });
      if (product.id === FREE_PRODUCT_ID) {
        return Response.json(
          { error: "The Free baseline carries no versions: it is a read-only baseline, never purchasable." },
          { status: 409 },
        );
      }
      // Issue #3246 slice 3: a runs_pack product versions through
      // the pack store — (runs, price) terms, validated by the
      // pack adapter (a bad field is a 400 through the catch
      // below). The segment normalizes exactly like the plan path.
      if (product.kind === "runs_pack") {
        const packs = requireRunsPack();
        if (packs instanceof Response) return packs;
        try {
          await ensureRunsPackSchema(packs.versions.db);
        } catch (err: any) {
          return Response.json({ error: `Runs-pack store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
        }
        const segment = typeof body.segment === "string" && body.segment.trim() ? body.segment.trim() : "default";
        const version = await packs.versions.createVersion({
          productId: product.id,
          segment,
          runs: body.runs,
          priceUSD,
          effectiveFromMs: body.effectiveFromMs,
          effectiveToMs: body.effectiveToMs,
        });
        ctx.audit("commercial.runs_pack.version.created", "payments", {
          productId: product.id,
          versionId: version.id,
          version: version.version,
          segment: version.segment,
          runs: version.runs,
          priceUSD: version.priceUSD,
          createdBy: login,
        });
        return Response.json({ version });
      }
      const periodDays = body.periodDays;
      if (typeof periodDays !== "number" || !Number.isInteger(periodDays) || periodDays <= 0) {
        return Response.json({ error: "periodDays must be a positive integer." }, { status: 400 });
      }
      const includedRuns = body.includedRuns;
      if (typeof includedRuns !== "number" || !Number.isInteger(includedRuns) || includedRuns < 0) {
        return Response.json({ error: "includedRuns must be a non-negative integer." }, { status: 400 });
      }
      const trialDays = body.trialDays ?? null;
      if (trialDays !== null && (typeof trialDays !== "number" || !Number.isInteger(trialDays) || trialDays < 0)) {
        return Response.json({ error: "trialDays must be null or a non-negative integer." }, { status: 400 });
      }
      const segment = typeof body.segment === "string" && body.segment.trim() ? body.segment.trim() : "default";
      const effectiveFromMs =
        body.effectiveFromMs === undefined || body.effectiveFromMs === null ? Date.now() : body.effectiveFromMs;
      if (typeof effectiveFromMs !== "number" || !Number.isFinite(effectiveFromMs) || effectiveFromMs < 0) {
        return Response.json({ error: "effectiveFromMs must be a non-negative epoch-ms number." }, { status: 400 });
      }
      const effectiveToMs = body.effectiveToMs ?? null;
      if (
        effectiveToMs !== null &&
        (typeof effectiveToMs !== "number" || !Number.isFinite(effectiveToMs) || effectiveToMs <= effectiveFromMs)
      ) {
        return Response.json(
          { error: "effectiveToMs must be an epoch-ms number after effectiveFromMs when present." },
          { status: 400 },
        );
      }
      const billingPeriod = body.billingPeriod ?? null;
      if (billingPeriod !== null && billingPeriod !== "monthly" && billingPeriod !== "annual") {
        return Response.json({ error: 'billingPeriod must be "monthly" or "annual" when present.' }, { status: 400 });
      }
      let featuresJson: string | null = null;
      if (body.features !== undefined && body.features !== null) {
        if (!Array.isArray(body.features) || body.features.some((f) => typeof f !== "string")) {
          return Response.json({ error: "features must be an array of strings when present." }, { status: 400 });
        }
        featuresJson = JSON.stringify(body.features);
      }
      const stripePriceId =
        body.stripePriceId === undefined || body.stripePriceId === null
          ? null
          : typeof body.stripePriceId === "string" && body.stripePriceId.trim()
            ? body.stripePriceId.trim()
            : null;
      if (body.stripePriceId !== undefined && body.stripePriceId !== null && typeof body.stripePriceId !== "string") {
        return Response.json({ error: "stripePriceId must be a string when present." }, { status: 400 });
      }
      if (product.kind !== "subscription") {
        return Response.json(
          { error: "Per-run product versions are catalogue versions: create them via the catalogue versions route." },
          { status: 400 },
        );
      }
      const plan = await subs.createPlan({
        name: product.name,
        priceUSD,
        periodDays,
        includedRuns,
        trialDays,
        productId: product.id,
        segment,
        effectiveFromMs,
        effectiveToMs,
        billingPeriod,
        featuresJson,
        stripePriceId,
      });
      ctx.audit("commercial.product.version.created", "payments", {
        productId: product.id,
        versionId: plan.id,
        version: plan.version,
        segment: plan.segment,
        priceUSD: plan.priceUSD,
        createdBy: login,
      });
      return Response.json({ plan });
    } catch (err: any) {
      const message = err.message || "Failed to create version.";
      const status = /required|must be|Invalid/.test(message) ? 400 : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // POST /payments/agentic/commercial/products/:productId/versions/:versionId/approve
  // (operator only) — approve a plan version: the FIRST UI for
  // the existing approve action, addressed by version id. The
  // audit event and outcome shape match POST /plans/approve
  // exactly — one approval action, not a second one.
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.endsWith("/approve") &&
    request.method === "POST"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      let versionId = parts[parts.indexOf("versions") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
        versionId = decodeURIComponent(versionId);
      } catch {
        // Keep the raw segments; the lookups below 404 on them.
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const product = await products.getProduct(productId);
      if (!product) return Response.json({ error: `No product ${productId}.` }, { status: 404 });
      // Issue #3246 slice 3: a runs_pack version approves through
      // the pack store — the same addressed-by-id shape, its own
      // audit event, and no plan outcome code (there is no pack
      // approval-success code; the UI reads the version from its
      // own row, not this response).
      if (product.kind === "runs_pack") {
        const packs = requireRunsPack();
        if (packs instanceof Response) return packs;
        try {
          await ensureRunsPackSchema(packs.versions.db);
        } catch (err: any) {
          return Response.json({ error: `Runs-pack store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
        }
        const existing = await packs.versions.getVersion(versionId);
        if (!existing || existing.productId !== productId) {
          return Response.json({ error: `No version ${versionId} for product ${productId}.` }, { status: 404 });
        }
        const version = await packs.versions.approveVersion(versionId, login);
        ctx.audit("commercial.runs_pack.version.approved", "payments", {
          login,
          versionId: version.id,
          productId: version.productId,
          approvedBy: login,
        });
        return Response.json({ version });
      }
      const existing = await subs.getPlan(versionId);
      if (!existing || existing.productId !== productId) {
        return Response.json({ error: `No version ${versionId} for product ${productId}.` }, { status: 404 });
      }
      const plan = await subs.approvePlan(versionId, login);
      const approved = resolveOutcome("SUCCESS_PLAN_APPROVED");
      ctx.audit("commercial.plan.approved", "payments", {
        code: approved.code,
        message: approved.businessMessage,
        login,
        planId: plan.id,
        approvedBy: login,
      });
      return Response.json({ plan, code: approved.code, message: approved.businessMessage, retryable: approved.entry?.retryable ?? false });
    } catch (err: any) {
      if (err instanceof BusinessError) return codedOutcomeResponse(err.code);
      const message = err.message || "Failed to approve version.";
      return Response.json({ error: message }, { status: /No plan/.test(message) ? 404 : 500 });
    }
  }

  // POST /payments/agentic/commercial/products/:productId/versions/:versionId/deactivate
  // (operator only) — deactivate a version: blocks NEW
  // purchases only; holders ride to period end or plan change.
  // Mirrors POST /plans/deactivate exactly.
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.endsWith("/deactivate") &&
    request.method === "POST"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      let versionId = parts[parts.indexOf("versions") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
        versionId = decodeURIComponent(versionId);
      } catch {
        // Keep the raw segments; the lookups below 404 on them.
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const product = await products.getProduct(productId);
      if (!product) return Response.json({ error: `No product ${productId}.` }, { status: 404 });
      // Issue #3246 slice 3: a runs_pack version deactivates
      // through the pack store — blocks NEW purchases only; pack
      // balances already bought are untouched.
      if (product.kind === "runs_pack") {
        const packs = requireRunsPack();
        if (packs instanceof Response) return packs;
        try {
          await ensureRunsPackSchema(packs.versions.db);
        } catch (err: any) {
          return Response.json({ error: `Runs-pack store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
        }
        const existing = await packs.versions.getVersion(versionId);
        if (!existing || existing.productId !== productId) {
          return Response.json({ error: `No version ${versionId} for product ${productId}.` }, { status: 404 });
        }
        const version = await packs.versions.deactivateVersion(versionId);
        ctx.audit("commercial.runs_pack.version.deactivated", "payments", {
          versionId: version.id,
          productId: version.productId,
        });
        return Response.json({ version });
      }
      const existing = await subs.getPlan(versionId);
      if (!existing || existing.productId !== productId) {
        return Response.json({ error: `No version ${versionId} for product ${productId}.` }, { status: 404 });
      }
      const plan = await subs.deactivatePlan(versionId);
      ctx.audit("commercial.plan.deactivated", "payments", { planId: plan.id });
      return Response.json({ plan });
    } catch (err: any) {
      const message = err.message || "Failed to deactivate version.";
      return Response.json({ error: message }, { status: /No plan/.test(message) ? 404 : 500 });
    }
  }

  // GET /payments/agentic/commercial/catalogue/versions?productId=
  // (operator only) — the catalogue version chain for one
  // per-run product, optionally narrowed to one segment
  // (?segment=). Catalogue approval stays in #2739's UI: this
  // read shows approval status, never approves.
  if (path.endsWith("/payments/agentic/commercial/catalogue/versions") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const productId = url.searchParams.get("productId") ?? "";
      if (!productId) return Response.json({ error: "productId is required." }, { status: 400 });
      const products = requireProducts();
      if (products instanceof Response) return products;
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!catalogue) {
        return Response.json({ error: "Price catalogue unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      const product = await products.getProduct(productId);
      if (!product) return Response.json({ error: `No product ${productId}.` }, { status: 404 });
      if (product.kind !== "per_run") {
        return Response.json({ error: "Catalogue versions exist for per-run products only." }, { status: 400 });
      }
      const family = familyForProductId(product.id);
      const segment = url.searchParams.get("segment") ?? undefined;
      const versions = family ? await catalogue.listVersions(family, segment) : [];
      return Response.json({ product, versions });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read catalogue versions." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/catalogue/versions
  // (operator only) — create a catalogue version for a
  // family+segment. The version lands PROPOSED; approval is
  // #2739's action on the POST /prices route. This is the
  // versioned write path setPrice delegates to; the audit
  // event matches setPrice (commercial.price.set) — one price
  // vocabulary, not a second one.
  if (path.endsWith("/payments/agentic/commercial/catalogue/versions") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      let family;
      try {
        family = assertPriceFamily(body.family);
      } catch (err: any) {
        return Response.json({ error: err.message || "Invalid family." }, { status: 400 });
      }
      const priceUSD = body.priceUSD;
      if (typeof priceUSD !== "number" || !Number.isFinite(priceUSD) || priceUSD < 0) {
        return Response.json({ error: "priceUSD must be a finite non-negative number." }, { status: 400 });
      }
      const segment = typeof body.segment === "string" && body.segment.trim() ? body.segment.trim() : "default";
      const effectiveFromMs =
        body.effectiveFromMs === undefined || body.effectiveFromMs === null ? Date.now() : body.effectiveFromMs;
      if (typeof effectiveFromMs !== "number" || !Number.isFinite(effectiveFromMs) || effectiveFromMs < 0) {
        return Response.json({ error: "effectiveFromMs must be a non-negative epoch-ms number." }, { status: 400 });
      }
      const effectiveToMs = body.effectiveToMs ?? null;
      if (
        effectiveToMs !== null &&
        (typeof effectiveToMs !== "number" || !Number.isFinite(effectiveToMs) || effectiveToMs <= effectiveFromMs)
      ) {
        return Response.json(
          { error: "effectiveToMs must be an epoch-ms number after effectiveFromMs when present." },
          { status: 400 },
        );
      }
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!catalogue) {
        return Response.json({ error: "Price catalogue unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      try {
        await ensurePriceCatalogueSchema(catalogue.db);
      } catch (err: any) {
        return Response.json({ error: `Price catalogue unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const entry = await catalogue.createVersion({ family, priceUSD, segment, effectiveFromMs, effectiveToMs });
      ctx.audit("commercial.price.set", "payments", { family: entry.family, priceUSD: entry.priceUSD });
      return Response.json({ entry });
    } catch (err: any) {
      const message = err.message || "Failed to create catalogue version.";
      return Response.json({ error: message }, { status: /Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // POST /payments/agentic/commercial/products/:productId/bulk-move
  // (operator only) — "move all customers to current pricing":
  // every live holder of a non-current version of the product
  // moves to their own segment's current effective version.
  // Body: { segmentScope?: string | null, reason, dryRun?,
  // resumeBulkMoveId?, limit? }. A dry run resolves targets +
  // counts the population and moves nobody (the confirmation
  // screen's data); a resume continues a running bulk move.
  // Runs synchronously with a row cap; per-customer failures
  // are recorded and counted, never fatal. Audited
  // commercial.product.bulk_move (real runs only — a dry run
  // is a read and writes nothing).
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.endsWith("/bulk-move") &&
    request.method === "POST"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
      } catch {
        // Keep the raw segment; the driver 404s on it.
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) {
        return Response.json({ error: "reason is required: a bulk move is an explicit operator action with an audit trail." }, { status: 400 });
      }
      const segmentScope =
        body.segmentScope === undefined || body.segmentScope === null
          ? null
          : typeof body.segmentScope === "string" && body.segmentScope.trim()
            ? body.segmentScope.trim()
            : null;
      if (body.segmentScope !== undefined && body.segmentScope !== null && typeof body.segmentScope !== "string") {
        return Response.json({ error: "segmentScope must be a string or null." }, { status: 400 });
      }
      const dryRun = body.dryRun === true;
      const resumeBulkMoveId =
        typeof body.resumeBulkMoveId === "string" && body.resumeBulkMoveId.trim()
          ? body.resumeBulkMoveId.trim()
          : undefined;
      const limit = body.limit === undefined || body.limit === null ? undefined : body.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
        return Response.json({ error: "limit must be a positive integer." }, { status: 400 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const products = requireProducts();
      if (products instanceof Response) return products;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      try {
        await ensureProductSchema(products.db);
      } catch (err: any) {
        return Response.json({ error: `Product store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const result = await runBulkMove({
        subs,
        store,
        products,
        productId,
        segmentScope,
        movedBy: login,
        reason,
        ...(resumeBulkMoveId ? { resumeBulkMoveId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        dryRun,
      });
      if (!dryRun && result.bulkMove) {
        ctx.audit("commercial.product.bulk_move", "payments", {
          bulkMoveId: result.bulkMove.id,
          productId,
          segmentScope: result.bulkMove.segmentScope,
          movedCount: result.bulkMove.movedCount,
          skippedCount: result.bulkMove.skippedCount,
          failedCount: result.bulkMove.failedCount,
          status: result.bulkMove.status,
          hasMore: result.hasMore,
          movedBy: login,
          reason,
        });
      }
      return Response.json(result);
    } catch (err: any) {
      const message = err.message || "Failed to run bulk move.";
      const status = /No product|No bulk move/.test(message)
        ? 404
        : /only a running bulk move|belongs to product/.test(message)
          ? 409
          : /required|must be|subscription products only/.test(message)
            ? 400
            : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // GET /payments/agentic/commercial/products/:productId/bulk-moves
  // (operator only) — the bulk-move summaries for one product,
  // newest first.
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.endsWith("/bulk-moves") &&
    request.method === "GET"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
      } catch {
        // Keep the raw segment; the lookup below 404s on it.
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      const product = await products.getProduct(productId);
      if (!product) return Response.json({ error: `No product ${productId}.` }, { status: 404 });
      const bulkMoves = await products.listBulkMoves(productId);
      return Response.json({ bulkMoves });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list bulk moves." }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/products/:productId/bulk-moves/:bulkMoveId
  // (operator only) — one bulk-move summary plus its
  // per-customer move rows (the audit that answers "who moved,
  // from what, to what").
  if (
    path.includes("/payments/agentic/commercial/products/") &&
    path.includes("/bulk-moves/") &&
    request.method === "GET"
  ) {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const parts = path.split("/");
      let productId = parts[parts.indexOf("products") + 1] ?? "";
      let bulkMoveId = parts[parts.indexOf("bulk-moves") + 1] ?? "";
      try {
        productId = decodeURIComponent(productId);
        bulkMoveId = decodeURIComponent(bulkMoveId);
      } catch {
        // Keep the raw segments; the lookups below 404 on them.
      }
      const products = requireProducts();
      if (products instanceof Response) return products;
      const bulkMove = await products.getBulkMove(bulkMoveId);
      if (!bulkMove || bulkMove.productId !== productId) {
        return Response.json({ error: `No bulk move ${bulkMoveId} for product ${productId}.` }, { status: 404 });
      }
      const moves = await products.listMovesForBulkMove(bulkMoveId);
      return Response.json({ bulkMove, moves });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read bulk move." }, { status: 500 });
    }
  }

  // Store operator management (#2680) — list/add/remove.
  // All three routes 403 for non-operators. Add/remove are POST
  // actions following the prices-route pattern (not DELETE with
  // a body: the commercial handler's money writes are POST
  // actions, and DELETE bodies are dropped by some proxies).
  // Add is idempotent for an existing store row; a login that
  // is already env-managed is 409 (env rows are managed via
  // dashboard, never via the UI). Remove refuses (409) when it
  // would leave zero effective operators, and 404s when there
  // is no store row to remove. Unbound store is 503 for
  // add/remove (there is nowhere to write) but list still
  // returns the env rows.
  if (path.endsWith("/payments/agentic/commercial/operators") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      let operators: EffectiveOperatorEntry[];
      try {
        operators = await listEffectiveOperators();
      } catch (err: any) {
        return Response.json({ error: `Operator store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      return Response.json({ operators });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list operators" }, { status: 500 });
    }
  }

  if (path.endsWith("/payments/agentic/commercial/operators/add") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { login?: unknown };
      let target: string;
      try {
        target = assertOperatorLogin(body.login);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      if (envOperators.has(target)) {
        return Response.json(
          { error: `Login ${target} is already an env-managed operator: env operators are managed via dashboard, not via the UI.` },
          { status: 409 },
        );
      }
      const adapter = createStoreOperatorsAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!adapter) {
        return Response.json({ error: "Operator store unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      try {
        await ensureStoreOperatorsSchema(adapter.db);
      } catch (err: any) {
        return Response.json({ error: `Operator store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const existing = await adapter.listOperators();
      const already = existing.find((entry) => entry.login === target);
      if (already) {
        return Response.json({ operator: already });
      }
      const operator = await adapter.addOperator({ login: target, addedBy: login });
      ctx.audit("commercial.operator.added", "payments", { operatorLogin: operator.login, addedBy: login });
      return Response.json({ operator });
    } catch (err: any) {
      const message = err.message || "Failed to add operator";
      return Response.json({ error: message }, { status: /must be/.test(message) ? 400 : 500 });
    }
  }

  if (path.endsWith("/payments/agentic/commercial/operators/remove") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { login?: unknown };
      let target: string;
      try {
        target = assertOperatorLogin(body.login);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      const adapter = createStoreOperatorsAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!adapter) {
        return Response.json({ error: "Operator store unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      try {
        await ensureStoreOperatorsSchema(adapter.db);
      } catch (err: any) {
        return Response.json({ error: `Operator store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const storeEntries = await adapter.listOperators();
      const hasStoreRow = storeEntries.some((entry) => entry.login === target);
      if (!hasStoreRow) {
        return Response.json(
          { error: `No store operator row for login ${target}: env-managed operators are removed via dashboard, not via the UI.` },
          { status: 404 },
        );
      }
      // Last-operator guard on FRESH data (not the preloaded
      // set): removal must never leave zero effective operators
      // through the UI. A login that is also env-managed stays
      // effective via env, so removing its store row is safe;
      // the guard only fires when the effective set would empty.
      const effectiveAfter = new Set(envOperators);
      for (const entry of storeEntries) {
        if (entry.login !== target) effectiveAfter.add(entry.login);
      }
      if (effectiveAfter.size === 0) {
        return Response.json(
          { error: "Refusing to remove the last effective operator: the system must never reach zero operators through the UI." },
          { status: 409 },
        );
      }
      const removed = await adapter.removeOperator({ login: target });
      if (!removed) {
        return Response.json({ error: `No store operator row for login ${target}.` }, { status: 404 });
      }
      ctx.audit("commercial.operator.removed", "payments", { operatorLogin: target, addedBy: login });
      return Response.json({ removed: target });
    } catch (err: any) {
      const message = err.message || "Failed to remove operator";
      return Response.json({ error: message }, { status: /must be/.test(message) ? 400 : 500 });
    }
  }

  // Refund routes (#2204, implementation of #2147). Request ->
  // operator approval -> gateway execution, all behind the
  // monetization flag (flag OFF refuses request, approval, and
  // execution). Crypto requests are refused as non-refundable by
  // the service; no route here can widen that. Execution resolves
  // the Stripe payment-intent id from the subscription row (#2200)
  // or fails closed when it cannot resolve one. Policy reads and
  // the operator policy update are NOT flag-gated: operators
  // configure policy before activation.
  if (path.endsWith("/payments/agentic/commercial/refunds") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireRefundFlag();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as {
        kind?: unknown; originalPaymentRef?: unknown; amountUSD?: unknown; reason?: unknown;
        tenantId?: unknown; originalAmountUSD?: unknown; originalPaidAtMs?: unknown;
        rail?: unknown; family?: unknown;
      };
      const ports = requireRefunds();
      if (ports instanceof Response) return ports;
      try {
        await ensureRefundSchema(ports.store.db);
      } catch (err: any) {
        return Response.json({ error: `Refund store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      let resolver: ReturnType<typeof createSubscriptionPaymentResolver> | undefined;
      if (body.kind === "subscription") {
        const store = requireStore();
        if (store instanceof Response) return store;
        const subs = requireSubs();
        if (subs instanceof Response) return subs;
        const ensured = await ensureStores(store, subs);
        if (ensured) return ensured;
        resolver = createSubscriptionPaymentResolver(subs);
      }
      const record = await requestRefund(
        { policyStore: ports.policy, refundStore: ports.store, sourceResolver: resolver },
        {
          kind: body.kind,
          originalPaymentRef: body.originalPaymentRef,
          amountUSD: body.amountUSD,
          reason: body.reason,
          requesterLogin: login,
          isOperator: isStoreOperator(login),
          tenantId: body.tenantId,
          originalAmountUSD: body.originalAmountUSD,
          originalPaidAtMs: body.originalPaidAtMs,
          rail: body.rail,
          family: body.family,
        },
      );
      ctx.audit("commercial.refund.requested", "payments", {
        refundId: record.id,
        userId: record.userId,
        kind: record.kind,
        originalPaymentRef: record.originalPaymentRef,
        amountUSD: record.amountUSD,
      });
      return Response.json({ refund: record });
    } catch (err: any) {
      const message = err.message || "Failed to request refund";
      // Issue #2662: unapproved-kind refusal is a policy-state refusal
      // (422), distinct from a malformed request (400) or a server
      // failure (500).
      const status = /not owner-approved/.test(message)
        ? 422
        : /required|must be|not allowed|exceeds|expired|non-refundable|No subscription|Only the|no stored|determinable|rail is required|resolver/.test(message)
          ? 400
          : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // Operator decision on a requested refund: approve or deny.
  // Approver is operator HITL only (policy enforces the same).
  if (path.endsWith("/payments/agentic/commercial/refunds/approve") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const flag = await requireRefundFlag();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { refundId?: unknown; decision?: unknown; note?: unknown };
      const refundId = typeof body.refundId === "string" ? body.refundId : "";
      if (!refundId) return Response.json({ error: "refundId is required." }, { status: 400 });
      if (body.decision !== "approve" && body.decision !== "deny") {
        return Response.json({ error: "decision must be approve or deny." }, { status: 400 });
      }
      const ports = requireRefunds();
      if (ports instanceof Response) return ports;
      try {
        await ensureRefundSchema(ports.store.db);
      } catch (err: any) {
        return Response.json({ error: `Refund store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const record = await decideRefund(
        { refundStore: ports.store },
        { refundId, decision: body.decision, approverLogin: login, note: typeof body.note === "string" ? body.note : undefined },
      );
      ctx.audit("commercial.refund.decided", "payments", {
        refundId: record.id,
        decision: body.decision,
        approverLogin: login,
      });
      return Response.json({ refund: record });
    } catch (err: any) {
      const message = err.message || "Failed to decide refund";
      const status = /No refund/.test(message) ? 404 : /cannot be decided/.test(message) ? 400 : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // Operator execution of an APPROVED refund via the Stripe
  // payment-intent id. Unapproved, unresolvable, window/amount, and
  // crypto cases are refused by the service before any gateway
  // call; a gateway failure marks execution_failed (retryable).
  if (path.endsWith("/payments/agentic/commercial/refunds/execute") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      if (!flagOn) {
        return Response.json({ error: "monetization flag is OFF; refunds are disabled." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { refundId?: unknown };
      const refundId = typeof body.refundId === "string" ? body.refundId : "";
      if (!refundId) return Response.json({ error: "refundId is required." }, { status: 400 });
      const ports = requireRefunds();
      if (ports instanceof Response) return ports;
      try {
        await ensureRefundSchema(ports.store.db);
      } catch (err: any) {
        return Response.json({ error: `Refund store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const gateway = {
        executeRefund: async (params: {
          transactionId: string; amount: number; gateway: "stripe"; gatewayRef: string; userLogin: string; reason: string;
        }) => {
          const service = new PaymentGatewayService(ctx.env);
          const res = await service.executeRefund(params);
          return { success: res.success, refundId: res.refundId, amountRefunded: res.amountRefunded, message: res.message };
        },
      };
      // Issue #2522: tier-change audit — executeRefund may revoke
      // or cancel subscriptions (dropping the effective tier),
      // so the before rows are read from the refund record ahead
      // of execution and the after rows after it.
      const refundBefore = await ports.store.getRefund(refundId);
      const refundUserId = refundBefore?.userId ?? null;
      const refundBeforeAccount = refundUserId ? await store.getAccount(refundUserId) : null;
      const refundBeforeSubscriptions = refundUserId ? await subs.listSubscriptions(refundUserId) : [];
      // Issue #2204 follow-up: composite resolver — the subscription
      // resolver OR the pay-per-run resolver over the native ledger
      // (charge row, card rail only; null when unresolvable, so an
      // unresolvable run still fails closed exactly as before).
      // The native adapter is null when AGENT_DB is unbound, in
      // which case only the subscription half is wired. The
      // check-payment section below is untouched (draft PR #3106).
      const nativeLedger = createNativeLedgerAdapter(ctx.env as { AGENT_DB?: unknown });
      if (nativeLedger) {
        await ensureNativeLedgerSchema(nativeLedger.db);
      }
      const subscriptionResolver = createSubscriptionPaymentResolver(subs);
      const payPerRunResolver = nativeLedger
        ? createPayPerRunPaymentResolver(nativeLedger)
        : null;
      const sourceResolver = {
        resolve: async (originalPaymentRef: string) =>
          (await subscriptionResolver.resolve(originalPaymentRef)) ??
          (payPerRunResolver ? await payPerRunResolver.resolve(originalPaymentRef) : null),
      };
      const record = await executeRefund(
        {
          policyStore: ports.policy,
          refundStore: ports.store,
          sourceResolver,
          subscriptionStore: subs,
          commercialStore: store,
          // Issue #2549: the XOR guard's failure-credit lookup
          // reads BOTH ledgers — a credit row in either one
          // (native D1 rows, or the cfpay mas_transactions rows
          // the payment workflow writes fail-loud) blocks a cash
          // refund for the same run.
          failureCreditLookup: {
            hasFailureCredit: async (runRequestId: string) => {
              const native = createNativeLedgerAdapter(ctx.env as { AGENT_DB?: unknown });
              if (native) {
                await ensureNativeLedgerSchema(native.db);
                if (await native.findRow(runRequestId, "credit")) return true;
              }
              const sessionId = cfpayLedgerSessionId(runRequestId);
              return ctx
                .getOrm()
                .transactions.findMany()
                .some((t) => t.sessionId === sessionId && t.action === "credit" && isCfpayLedgerRow(t));
            },
          },
          gateway,
          postJournal: (entries) =>
            postJournalBestEffort(async () => {
              const adapter = createJournalAdapter(ctx.env as { AGENT_DB?: unknown });
              if (!adapter) return null;
              try {
                await ensureJournalSchema(adapter.db);
              } catch {
                // Best-effort: the post itself reports the failure.
              }
              return adapter;
            }, entries),
          monetizationEnabled: flagOn,
        },
        { refundId },
      );
      // When the refund carries no userId, no tier fields are
      // claimed — the audit keeps exactly its previous shape.
      const refundTransition = refundUserId
        ? resolveTierTransition(
            refundBeforeAccount,
            refundBeforeSubscriptions,
            await store.getAccount(refundUserId),
            await subs.listSubscriptions(refundUserId),
            Date.now(),
          )
        : null;
      ctx.audit("commercial.refund.executed", "payments", {
        refundId: record.id,
        gatewayRefundId: record.gatewayRefundId,
        amountUSD: record.amountUSD,
        entitlementConsequence: record.entitlementConsequence,
        ...(refundTransition
          ? {
              previousEffectiveTier: refundTransition.previousEffectiveTier,
              newEffectiveTier: refundTransition.newEffectiveTier,
            }
          : {}),
      });
      return Response.json({ refund: record });
    } catch (err: any) {
      const message = err.message || "Failed to execute refund";
      const status = /No refund/.test(message)
        ? 404
        : /Only an approved refund/.test(message)
          ? 409
          : /Gateway refund failed/.test(message)
            ? 502
            : /not resolvable|non-refundable|window expired|not allowed|exceeds|not configured|flag is OFF|already received its automatic replacement-run credit|failure-credit lookup|not owner-approved|cross-tenant/.test(message)
              ? 422
              : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // Refund read: one record by id, or the caller's own list (an
  // operator may list another user's refunds by userId). Reads are
  // not flag-gated: refund status stays readable when the flag is OFF.
  if (path.endsWith("/payments/agentic/commercial/refunds") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const ports = requireRefunds();
      if (ports instanceof Response) return ports;
      try {
        await ensureRefundSchema(ports.store.db);
      } catch (err: any) {
        return Response.json({ error: `Refund store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const refundId = url.searchParams.get("refundId") ?? "";
      if (refundId) {
        const record = await ports.store.getRefund(refundId);
        if (!record) return Response.json({ error: `No refund ${refundId}.` }, { status: 404 });
        if (record.userId !== login && !isStoreOperator(login)) {
          return Response.json({ error: "Forbidden: only the refund owner or a store operator may read a refund." }, { status: 403 });
        }
        return Response.json({ refund: record });
      }
      const userId = url.searchParams.get("userId") ?? "";
      const target = userId && isStoreOperator(login) ? userId : login;
      const refunds = await ports.store.listRefunds(target);
      return Response.json({ refunds });
    } catch {
      return Response.json({ error: "Failed to read refunds." }, { status: 500 });
    }
  }

  // Refund policy read: current operator policy plus the disclosure copy.
  // Issue #2662: the response reports the REAL approval state
  // (approvedKinds/approvedBy/approvedAtMs on the policy row) — never
  // a hardcoded proposed flag. An unapproved kind's values are
  // PROPOSED seeds or operator edits awaiting approval, not an
  // activation.
  if (path.endsWith("/payments/agentic/commercial/refund-policy") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const ports = requireRefunds();
      if (ports instanceof Response) return ports;
      try {
        await ensureRefundSchema(ports.store.db);
      } catch (err: any) {
        return Response.json({ error: `Refund store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const policy = await ports.policy.getPolicy();
      if (!policy) return Response.json({ error: "Refund policy is not configured." }, { status: 503 });
      return Response.json({ policy, disclosure: REFUND_POLICY_COPY });
    } catch {
      return Response.json({ error: "Failed to read refund policy." }, { status: 500 });
    }
  }

  // Operator refund policy update: validated partial update, no
  // code deploy. Not flag-gated (configuration precedes activation).
  if (path.endsWith("/payments/agentic/commercial/refund-policy") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const ports = requireRefunds();
      if (ports instanceof Response) return ports;
      try {
        await ensureRefundSchema(ports.store.db);
      } catch (err: any) {
        return Response.json({ error: `Refund store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      try {
        const policy = await ports.policy.setPolicy(body);
        ctx.audit("commercial.refund.policy.set", "payments", { policy });
        return Response.json({ policy });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to set refund policy" }, { status: 400 });
      }
    } catch {
      return Response.json({ error: "Failed to set refund policy." }, { status: 500 });
    }
  }

  // Issue #2662 — operator refund policy APPROVAL, per kind. Approving
  // a kind's CURRENT values is a separate, audited operator action
  // from editing values: setPolicy always resets approval, and the
  // patch validator rejects approval fields, so approval can never
  // be smuggled in through a value edit and never survives one
  // silently (#2547 rule). Approving a policy is NOT approving any
  // individual refund — each refund still needs operator HITL
  // approve + execute. Not flag-gated (configuration precedes
  // activation, same rule as the policy routes).
  if (path.endsWith("/payments/agentic/commercial/refund-policy/approve") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const ports = requireRefunds();
      if (ports instanceof Response) return ports;
      try {
        await ensureRefundSchema(ports.store.db);
      } catch (err: any) {
        return Response.json({ error: `Refund store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const body = (await request.json().catch(() => ({}))) as { kind?: unknown; approved?: unknown };
      if (body.kind !== "subscription" && body.kind !== "pay_per_run") {
        return Response.json({ error: "kind must be subscription or pay_per_run." }, { status: 400 });
      }
      if (typeof body.approved !== "boolean") {
        return Response.json({ error: "approved must be a boolean." }, { status: 400 });
      }
      try {
        const policy = await ports.policy.setKindApproval(body.kind, body.approved, login);
        ctx.audit("commercial.refund.policy.approved", "payments", {
          kind: body.kind,
          approved: body.approved,
          approverLogin: login,
          approvedKinds: policy.approvedKinds,
        });
        return Response.json({ policy });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to set refund policy approval" }, { status: 400 });
      }
    } catch {
      return Response.json({ error: "Failed to set refund policy approval." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/submission/check-payment — the
  // production mirror of the assurance check-payment, for REAL runs.
  //
  // Issue #2196 (slice 3, #2146): reworked from cfpay to native. The
  // cfpay checkout.status re-read is GONE from this route (the
  // assurance live check-payment is slice 4's scope, untouched here).
  // Native verification re-reads provider state through the checkout
  // ports and delivers payment_verified ONLY when the native rule
  // holds. The wake-up event is never sent for an unverified
  // checkout, and a Stripe return page is never proof (the gate
  // re-checks provider state itself on confirm). Ownership
  // (#2137 follow-up): the "unguessable runRequestId" standard is
  // REPLACED, not supplemented — the verified session login must
  // own the submission being verified, exactly as
  // submission-status enforces. A payment URL is returned ONLY when it is the
  // native checkoutUrl from a retrieved Stripe session; the UI must
  // not invent one, and x402 has no URL at all — it gets a
  // challenge-flow presentation object instead (network, amount,
  // recipient, no link).
  //
  // Session resolution (card): the caller may supply sessionId, or
  // the route reads it from the payment.checkout_created audit
  // payload for this run (the flow audits checkoutId there; audit
  // writes are best-effort, so a missing row means
  // checkout_not_found, never a guessed session). Amount matching
  // uses the STORED catalogue price for the run's family (from the
  // audit row, or the caller's family field); the display seed
  // prices are NEVER used for verification, and a missing catalogue
  // or price fails closed with 503. Card is paid ONLY when the
  // session retrieve reports complete + paid + amount_total ==
  // priceUSD x 100 + client_reference_id == runRequestId — the same
  // four-condition rule the gate applies. Crypto is paid ONLY when
  // the facilitator verifies the supplied proof for this run's amount
  // and recipient (and the claimed payer matches, when supplied).
  if (path.endsWith("/payments/agentic/commercial/submission/check-payment") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        runRequestId?: unknown; sessionId?: unknown; family?: unknown; paymentProof?: unknown; payer?: unknown;
      };
      const runRequestId = typeof body.runRequestId === "string" ? body.runRequestId : "";
      if (!runRequestId) return Response.json({ error: "runRequestId is required." }, { status: 400 });
      const asString = (v: unknown): string | undefined =>
        typeof v === "string" && v.length > 0 ? v : undefined;
      if (
        (body.sessionId !== undefined && typeof body.sessionId !== "string") ||
        (body.family !== undefined && typeof body.family !== "string") ||
        (body.paymentProof !== undefined && typeof body.paymentProof !== "string") ||
        (body.payer !== undefined && typeof body.payer !== "string")
      ) {
        return Response.json({ error: "sessionId, family, paymentProof, and payer must be strings when supplied." }, { status: 400 });
      }
      // Issue #2137 (check-payment ownership hardening): the
      // verified session login must own the submission being
      // verified, before any Stripe retrieve, audit scan, or
      // facilitator call. The submit route records every paid
      // submission (workflowId == runRequestId) under the verified
      // login before the workflow starts, so a record here is the
      // ownership proof: a record owned by another login is
      // refused with 403 — cross-user and cross-tenant alike,
      // because ownership is per-login and a tenant is derived
      // from the login via the platform identity, never from a
      // client-supplied tenantId (no client tenantId is read
      // anywhere in this route). An unbound store fails closed
      // with 503, exactly like submission-status. Residual,
      // stated plainly: when NO record exists (a pre-record
      // legacy run, or the redeemed path's best-effort record
      // failure — redeemed runs start no payment workflow),
      // there is no owner to check against, so the route follows
      // the legacy verify path below; a strict unknown -> 404
      // flip needs the existing check-payment fixtures
      // (tests/commercial_checkout_ui_routes.test.ts, outside
      // this slice's file ownership) to seed a paid submission
      // first, and is left as that follow-up.
      const ownershipStore = requireStore();
      if (ownershipStore instanceof Response) return ownershipStore;
      try {
        await ensureCommercialSchema(ownershipStore.db);
      } catch (err: any) {
        return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      let ownershipSubmission;
      try {
        ownershipSubmission = await ownershipStore.getPaidSubmission(runRequestId);
      } catch (err: any) {
        return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      if (ownershipSubmission && ownershipSubmission.userId !== login) {
        return Response.json({ error: "Forbidden: this submission belongs to another user." }, { status: 403 });
      }
      const envRecord = ctx.env as unknown as Record<string, unknown>;
      const ports = createCheckoutPorts(ctx.env as unknown as CheckoutEnv);
      if (!ports) return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
      // Resolve the card session + family from the checkout_created
      // audit trail when the caller did not supply a session id.
      let sessionId = asString(body.sessionId);
      let family = asString(body.family);
      if (!sessionId && ports.card) {
        try {
          const orm = ctx.getOrm() as unknown as {
            events?: { findMany?: (args: unknown) => Array<{ payload?: unknown }> };
          };
          const rows = orm.events?.findMany?.({ where: { type: "payment.checkout_created" } }) ?? [];
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            const raw = (rows[i] as { payload?: unknown }).payload;
            let payload: Record<string, unknown> = {};
            if (raw && typeof raw === "object") payload = raw as Record<string, unknown>;
            else {
              try {
                payload = JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
              } catch {
                payload = {};
              }
            }
            if (payload.runRequestId === runRequestId) {
              sessionId = asString(payload.checkoutId) ?? sessionId;
              family = family ?? asString(payload.family);
              break;
            }
          }
        } catch {
          // Audit read failure degrades to "no session known", never a crash.
        }
      }
      // Stored catalogue price for verification (fail-closed: never
      // the display seeds). Needed only on the verify paths; the
      // informational paths below may omit the amount instead.
      const resolvePrice = async (): Promise<number | null> => {
        if (!family) return null;
        const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
        if (!catalogue) return null;
        try {
          const price = await catalogue.getPrice(family);
          return price !== null && Number.isFinite(price) && price > 0 ? price : null;
        } catch {
          return null;
        }
      };
      const deliver = async (
        proof: { sessionId?: string; paymentIntentId?: string; paymentProof?: string; payer?: string },
        state: string,
        rail: "stripe" | "x402",
      ) => {
        const binding = ctx.env.PAYMENT_WORKFLOW as unknown as PaymentWorkflowBinding | undefined;
        if (!binding || typeof binding.get !== "function") {
          return Response.json({ runRequestId, paid: true, delivered: false, state, paymentUrl: null, rail });
        }
        try {
          const host: PaymentWorkflowHost = {
            runWorkflow: async (_bindingName: string, params: unknown) => {
              const started = await startPaymentWorkflowViaBinding(binding, params as never);
              return { id: started.workflowId };
            },
            sendWorkflowEvent: async (_bindingName: string, workflowId: string, event: { type: string; payload: unknown }) => {
              const instance = await binding.get(workflowId);
              if (!instance || typeof instance.sendEvent !== "function") {
                throw new Error("Workflow binding cannot deliver events.");
              }
              await instance.sendEvent(event);
            },
          };
          await deliverPaymentVerifiedViaHost(host, runRequestId, proof);
          return Response.json({ runRequestId, paid: true, delivered: true, state, paymentUrl: null, rail });
        } catch {
          return Response.json({ runRequestId, paid: true, delivered: false, state, paymentUrl: null, rail });
        }
      };
      // Card path: a session id is known (caller-supplied or audited).
      if (sessionId) {
        if (!ports.card) return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
        const price = await resolvePrice();
        if (price === null) return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
        let evidence;
        try {
          evidence = await ports.card.retrieveCardSession({ sessionId });
        } catch (err) {
          // #3573: a guard failure (timeout / breaker open) maps to its
          // catalog-coded 503; any other retrieve failure keeps the
          // fixed 503 (unchanged).
          if (isCheckoutPortGuardError(err)) {
            return codedOutcomeResponse(err.outcomeCode);
          }
          return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
        }
        const paid =
          evidence.status === "complete" &&
          evidence.paymentStatus === "paid" &&
          evidence.amountTotalCents === Math.round(price * 100) &&
          evidence.clientReferenceId === runRequestId;
        if (!paid) {
          // Unpaid: present the native checkoutUrl when Stripe still
          // serves one (open session); never invent a link.
          return Response.json({
            runRequestId, paid: false, state: evidence.status || "unknown",
            paymentUrl: evidence.checkoutUrl ?? null, rail: "stripe",
          });
        }
        return deliver(
          { sessionId: evidence.sessionId, paymentIntentId: evidence.paymentIntentId },
          evidence.status,
          "stripe",
        );
      }
      // Crypto path: the caller supplies a payment proof to verify.
      const paymentProof = asString(body.paymentProof);
      if (paymentProof) {
        if (!ports.x402) return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
        const price = await resolvePrice();
        if (price === null) return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
        let verdict;
        try {
          verdict = await ports.x402.verifyCryptoPayment({ paymentProof, expectedAmountUSD: price });
        } catch (err) {
          // #3573: a guard failure (timeout / breaker open) maps to its
          // catalog-coded 503; any other verification failure keeps
          // the fixed 503 (unchanged).
          if (isCheckoutPortGuardError(err)) {
            return codedOutcomeResponse(err.outcomeCode);
          }
          return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
        }
        const payer = asString(body.payer);
        const paid = verdict.verified && (!payer || verdict.payer === payer);
        if (!paid) {
          return Response.json({
            runRequestId, paid: false, state: "unverified", paymentUrl: null, rail: "x402",
          });
        }
        return deliver(
          { paymentProof, payer: verdict.payer ?? payer },
          "verified",
          "x402",
        );
      }
      // Informational path: nothing verifiable was supplied. For the
      // x402-only configuration, present the 402 challenge flow (no
      // URL exists for crypto); for card, report that no checkout
      // session is known yet. Nothing is delivered from this path.
      if (ports.x402 && !ports.card) {
        const price = await resolvePrice();
        const network = deriveNetworkMarker({
          stripeMode: "unconfigured",
          x402Network:
            typeof envRecord.X402_NETWORK === "string" && envRecord.X402_NETWORK.trim().length > 0
              ? (envRecord.X402_NETWORK as string)
              : "base-sepolia",
        });
        return Response.json({
          runRequestId, paid: false, state: "awaiting_proof", paymentUrl: null, rail: "x402",
          challengeFlow: {
            network: network.x402Network,
            ...(price !== null ? { amountUSD: price } : {}),
            currency: "USDC",
            recipient: typeof envRecord.X402_RECIPIENT_ADDRESS === "string" ? envRecord.X402_RECIPIENT_ADDRESS : undefined,
            note: "Crypto payments have no link: complete the 402 payment with your wallet or agent, then verify with your payment proof.",
          },
        });
      }
      return Response.json({
        runRequestId, paid: false, state: "checkout_not_found", paymentUrl: null, rail: "stripe",
      });
    } catch {
      return Response.json({ error: "Failed to check payment." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/goal-command — minimal server-side
  // builder for the checkout UI's goal path. GoalScreenCommand requires
  // a server-built scenario, which the client cannot construct, so this
  // route builds it from goalKind/direction via the same builders the
  // server submission path uses. It starts NOTHING — it only returns a
  // screenerCommand the caller then submits via the paid route (which
  // enforces the gate). userLogin is the verified login, never a
  // caller claim.
  if (path.endsWith("/payments/agentic/commercial/goal-command") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        jobId?: unknown; goalKind?: unknown; direction?: unknown; symbols?: unknown; tenantId?: unknown;
      };
      const jobId = typeof body.jobId === "string" ? body.jobId : "";
      const goalKind = typeof body.goalKind === "string" ? body.goalKind : "";
      const direction = typeof body.direction === "string" ? body.direction : "";
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      const symbols = Array.isArray(body.symbols)
        ? body.symbols.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : undefined;
      if (!jobId) return Response.json({ error: "jobId is required." }, { status: 400 });
      if (!(goalKind in GOAL_TAXONOMY)) return Response.json({ error: "goalKind is not a known goal kind." }, { status: 400 });
      if (!["bullish", "bearish", "range_bound", "volatile", "unknown"].includes(direction)) {
        return Response.json({ error: "direction must be bullish, bearish, range_bound, volatile, or unknown." }, { status: 400 });
      }
      const scenario = buildScenario({
        goalKind: goalKind as keyof typeof GOAL_TAXONOMY,
        portfolioRef: { kind: "hypothetical" },
        direction: direction as "bullish" | "bearish" | "range_bound" | "volatile" | "unknown",
      });
      const screenerCommand = buildGoalScreenCommand({
        jobId,
        source: "manual",
        trigger: "manual",
        userLogin: login,
        tenantId: tenantId || undefined,
        scenario,
        scenarioSource: "built",
        symbols,
      });
      return Response.json({ screenerCommand });
    } catch {
      return Response.json({ error: "Failed to build goal command." }, { status: 500 });
    }
  }

  // Issue #896: BudgetGuard state, derived from the ledger of record on
  // every read — the guard has no second home to diverge into.
  if (path.endsWith("/payments/agentic/ledger/budget-state") && request.method === "GET") {
    try {
      const agentId = url.searchParams.get("agentId");
      const state = deriveBudgetGuardState(ctx.getOrm().transactions.findMany(), agentId);
      return Response.json({ agentId, state });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to derive budget state" }, { status: 500 });
    }
  }

  // Issue #896: PaymentsAgent-origin payments, read back from the ledger.
  if (path.endsWith("/payments/agentic/ledger/payments") && request.method === "GET") {
    try {
      const rawLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 50;
      // Newest first. createdAt is millisecond-resolution, so two
      // payments recorded in the same millisecond tie on timestamp;
      // Array.sort is stable, which would then return them in
      // insertion order (oldest first) and break the newest-first
      // contract. Tie-break on insertion order, latest inserted first.
      const payments = ctx
        .getOrm()
        .transactions.findMany()
        .filter(isPaymentsAgentRow)
        .map((row, index) => ({ row, index }))
        .sort(
          (a, b) =>
            String(b.row.createdAt).localeCompare(String(a.row.createdAt)) ||
            b.index - a.index
        )
        .slice(0, limit)
        .map(({ row }) => toPaymentRecord(row));
      return Response.json({ count: payments.length, payments });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list ledger payments" }, { status: 500 });
    }
  }

  // Agentic Auto-Approve Limit (HITL threshold)
  if (path.endsWith("/payments/agentic/auto-approve-limit") || path.includes("/payments/agentic/auto-approve-limit")) {
    const paymentService = new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId);
    if (request.method === "GET") {
      // #1728: mode "mcp" adopts the MCP status shape (the full
      // wallet status, which carries autoApproveLimitUSD); mode
      // "rest" (legacy) keeps {autoApproveLimitUSD, network}.
      const walletMode = resolveAgenticRouteMode(ctx, "wallet", url.searchParams.get("mode"), "rest");
      if (walletMode === "mcp") {
        const status = await paymentService.getWalletStatus();
        return Response.json({ success: true, ...status });
      }
      return Response.json({
        autoApproveLimitUSD: paymentService.getAutoApproveLimit(),
        network: ctx.env.X402_NETWORK || "base-sepolia",
      });
    }
    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        // #1728: validation (400) and the limit_updated audit run in
        // BOTH modes — they are guards/observability, not presentation.
        // Only the RESPONSE SHAPE is switchable: mode "mcp" returns
        // the MCP set_limit shape (with the message string); mode
        // "rest" (legacy) returns {success, autoApproveLimitUSD}.
        const walletMode = resolveAgenticRouteMode(ctx, "wallet", body.mode, "rest");
        const limit = Number(body.limitUSD !== undefined ? body.limitUSD : body.limit);
        if (isNaN(limit) || limit < 0) {
          return Response.json({ error: "Invalid limitUSD. Must be non-negative number." }, { status: 400 });
        }
        paymentService.setAutoApproveLimit(limit);
        ctx.audit("agentic_payment.limit_updated", "payments", { limitUSD: limit });
        if (walletMode === "mcp") {
          return Response.json({
            success: true,
            message: `Agentic payment auto-approval limit set to $${limit.toFixed(2)} USD.`,
            autoApproveLimitUSD: limit,
          });
        }
        return Response.json({ success: true, autoApproveLimitUSD: limit });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to update limit" }, { status: 500 });
      }
    }
  }

  // ================================================================
  // Lifecycle email + referral credits (#2208, sub-issue of #2012;
  // advances #2021/#2020; source #1076). Session-gated via the
  // verified x-user-login, like the commercial routes above;
  // operator-gated where noted. NOT limited-candidate email:
  // #1076 orders that AFTER subscription + referral credits
  // exist, so it is follow-up work, not a route here.
  // ================================================================

  // GET /payments/agentic/commercial/referral/balance?userId= — own balance or operator.
  if (path.endsWith("/payments/agentic/commercial/referral/balance") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const userId = url.searchParams.get("userId") ?? "";
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) return Response.json({ error: "Forbidden." }, { status: 403 });
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      const [rules, redeemableUSD, earnings, attribution] = await Promise.all([
        lifecycle.getRules(),
        lifecycle.redeemableBalance(userId),
        lifecycle.listEarnings(userId),
        lifecycle.getAttribution(userId),
      ]);
      return Response.json({
        userId,
        redeemableUSD,
        totalEarnedUSD: earnings.reduce((s, e) => s + e.amountUSD, 0),
        // #2657: the referrer this user is attributed to, if any. The
        // attribution row is keyed by referred user, so a referrer's own
        // balance reads null here — their earnings are the list above.
        attribution,
        rules: {
          earnAmountUSD: rules.earnAmountUSD,
          vestingDelayMs: rules.vestingDelayMs,
          redemptionScope: rules.redemptionScope,
        },
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read referral balance" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/referral/record-earn (operator only).
  // The earn event: a referred user's first paid run. Idempotent
  // per referred user; self-referral refused by the port.
  if (path.endsWith("/payments/agentic/commercial/referral/record-earn") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) return Response.json({ error: "Forbidden: operator only." }, { status: 403 });
      const body = (await request.json().catch(() => ({}))) as {
        referrerUserId?: unknown; referredUserId?: unknown; tenantId?: unknown;
      };
      if (typeof body.referrerUserId !== "string" || typeof body.referredUserId !== "string" || typeof body.tenantId !== "string") {
        return Response.json({ error: "referrerUserId, referredUserId, and tenantId are required." }, { status: 400 });
      }
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      const earning = await recordFirstPaidRunEarning(lifecycle, {
        referrerUserId: body.referrerUserId,
        referredUserId: body.referredUserId,
        tenantId: body.tenantId,
      });
      ctx.audit("commercial.referral.earned", "payments", {
        referrerUserId: earning.referrerUserId,
        referredUserId: earning.referredUserId,
        amountUSD: earning.amountUSD,
      });
      return Response.json({ earning });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to record referral earning" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/referral/attribute (operator only).
  // Issue #2657: the durable referrer→referred link #2208 named as
  // follow-up. Set-once per referred user (same referrer replays as a
  // no-op; a different referrer throws — never a silent overwrite).
  // The route always stamps source "operator": referral-code surfaces
  // (e.g. #2468 Phase 4 marketing) will write `code` rows through their
  // own route later; no client input can claim a code source here.
  // Attribution alone earns nothing — it only lets the submit path's
  // automatic earn trigger know whom to credit on first paid run.
  if (path.endsWith("/payments/agentic/commercial/referral/attribute") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) return Response.json({ error: "Forbidden: operator only." }, { status: 403 });
      const body = (await request.json().catch(() => ({}))) as {
        referrerUserId?: unknown; referredUserId?: unknown; tenantId?: unknown;
      };
      if (typeof body.referrerUserId !== "string" || typeof body.referredUserId !== "string" || typeof body.tenantId !== "string") {
        return Response.json({ error: "referrerUserId, referredUserId, and tenantId are required." }, { status: 400 });
      }
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      const attribution = await lifecycle.recordAttribution({
        referrerUserId: body.referrerUserId,
        referredUserId: body.referredUserId,
        tenantId: body.tenantId,
      });
      ctx.audit("commercial.referral.attributed", "payments", {
        referrerUserId: attribution.referrerUserId,
        referredUserId: attribution.referredUserId,
        tenantId: attribution.tenantId,
      });
      return Response.json({ attribution });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to record referral attribution" }, { status: 500 });
    }
  }

  // Issue #3247 (sub-issue of #3241), slice 1 — free-access
  // grant routes (operator grant/revoke; own-or-operator read).
  // A grant is the durable, revocable record of free ACCESS for
  // one login — it confers no tier, no included runs, and makes
  // no run free (the gate never reads it). The grant target must
  // have an account row (400 otherwise — the operator creates
  // the account first, mirroring the #3244 subscription-grant
  // route); the tenant for the audit comes from the target's
  // account row, never from a client-supplied tenantId, and
  // grantedBy is the session-verified operator login, never a
  // client-supplied value. Not gated on the monetization flag:
  // a grant is operator data, like an operator tier grant, not
  // a purchase. No money artifacts: no checkout, no
  // journal/ledger/claim writes.
  const requireFreeAccessGrant = async () => {
    const adapter = createFreeAccessGrantAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Free-access grant store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    try {
      await ensureFreeAccessGrantSchema(adapter.db);
    } catch (err: any) {
      return Response.json({ error: `Free-access grant store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
    }
    return adapter;
  };

  // POST /payments/agentic/commercial/free-access/grant (operator only)
  if (path.endsWith("/payments/agentic/commercial/free-access/grant") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        userId?: unknown; kind?: unknown; expiresAtMs?: unknown; reason?: unknown;
      };
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      // Validate before any write, so a bad grant is 400 and
      // grants nothing. grantedBy is the session login, never
      // read from the body; a client-supplied tenantId is
      // ignored (never read).
      let validated;
      try {
        validated = assertFreeAccessGrantInput(
          { login: userId, kind: body.kind, expiresAtMs: body.expiresAtMs, reason: body.reason, grantedBy: login },
          Date.now(),
        );
      } catch (err: any) {
        return Response.json({ error: err.message || "Invalid free-access grant." }, { status: 400 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      try {
        await ensureCommercialSchema(store.db);
      } catch (err: any) {
        return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const targetAccount = await store.getAccount(userId);
      if (!targetAccount) {
        return Response.json({ error: `No commercial account for user ${userId}. The operator creates the account first.` }, { status: 400 });
      }
      const grants = await requireFreeAccessGrant();
      if (grants instanceof Response) return grants;
      const { granted, replaced } = await grants.grant({ ...validated, nowMs: Date.now() });
      // Audit the replace pair in order: the revoked row first,
      // then the new grant. Audit failure follows the #3245
      // upsert convention: synchronous ctx.audit, unguarded —
      // a failure throws into the catch below.
      if (replaced) {
        ctx.audit("commercial.free_access.revoked", "payments", {
          userId,
          tenantId: targetAccount.tenantId,
          revokedBy: login,
          kind: replaced.kind,
        });
      }
      ctx.audit("commercial.free_access.granted", "payments", {
        userId,
        tenantId: targetAccount.tenantId,
        grantedBy: login,
        kind: granted.kind,
        reason: granted.reason,
        expiresAtMs: granted.expiresAtMs,
      });
      return Response.json({ granted, replaced });
    } catch (err: any) {
      const message = err.message || "Failed to grant free access";
      return Response.json({ error: message }, { status: /requires|Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // POST /payments/agentic/commercial/free-access/revoke (operator only)
  if (path.endsWith("/payments/agentic/commercial/free-access/revoke") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { userId?: unknown; reason?: unknown };
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
        return Response.json({ error: "reason must be a string." }, { status: 400 });
      }
      // An optional reason rides the audit event only — the row
      // carries no revoke reason.
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
      const store = requireStore();
      if (store instanceof Response) return store;
      try {
        await ensureCommercialSchema(store.db);
      } catch (err: any) {
        return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const targetAccount = await store.getAccount(userId);
      if (!targetAccount) {
        return Response.json({ error: `No commercial account for user ${userId}. The operator creates the account first.` }, { status: 400 });
      }
      const grants = await requireFreeAccessGrant();
      if (grants instanceof Response) return grants;
      const revoked = await grants.revokeActive(userId, Date.now());
      if (!revoked) {
        return Response.json({ error: `No active free-access grant for user ${userId}.` }, { status: 404 });
      }
      ctx.audit("commercial.free_access.revoked", "payments", {
        userId,
        tenantId: targetAccount.tenantId,
        revokedBy: login,
        kind: revoked.kind,
        ...(reason !== undefined ? { reason } : {}),
      });
      return Response.json({ revoked });
    } catch (err: any) {
      const message = err.message || "Failed to revoke free access";
      return Response.json({ error: message }, { status: /requires|Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // GET /payments/agentic/commercial/free-access?userId= — own or operator.
  // Mirrors GET /payments/agentic/commercial/referral/balance: the
  // same shape for self and operator reads (it is the subject's
  // own record). No audit event on read.
  if (path.endsWith("/payments/agentic/commercial/free-access") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const userId = url.searchParams.get("userId") ?? "";
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) return Response.json({ error: "Forbidden." }, { status: 403 });
      const grants = await requireFreeAccessGrant();
      if (grants instanceof Response) return grants;
      const nowMs = Date.now();
      const [active, history] = await Promise.all([
        grants.getActiveGrant(userId, nowMs),
        grants.listGrants(userId),
      ]);
      return Response.json({ userId, active, history });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read free-access grants" }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/lifecycle/preferences?userId= — own or operator.
  if (path.endsWith("/payments/agentic/commercial/lifecycle/preferences") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const userId = url.searchParams.get("userId") ?? "";
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!userId || !tenantId) return Response.json({ error: "userId and tenantId are required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) return Response.json({ error: "Forbidden." }, { status: 403 });
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      return Response.json({ preferences: await lifecycle.getPreferences(userId, tenantId) });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read preferences" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/lifecycle/preferences — own or operator.
  // Digest opt-out takes effect on the next send check (same-day).
  if (path.endsWith("/payments/agentic/commercial/lifecycle/preferences") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        userId?: unknown; tenantId?: unknown; digestEnabled?: unknown; welcomeEnabled?: unknown;
      };
      if (typeof body.userId !== "string" || typeof body.tenantId !== "string") {
        return Response.json({ error: "userId and tenantId are required." }, { status: 400 });
      }
      if (!canAccessAccount(login, body.userId)) return Response.json({ error: "Forbidden." }, { status: 403 });
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      const preferences = await lifecycle.setPreferences({
        userId: body.userId,
        tenantId: body.tenantId,
        digestEnabled: body.digestEnabled,
        welcomeEnabled: body.welcomeEnabled,
      });
      return Response.json({ preferences });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to write preferences" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/lifecycle/welcome — own or operator.
  // Best-effort by design: a send failure returns 200 with
  // sent:false, NEVER a 500 — the welcome must never block its
  // provisioning caller. No provisioning path today carries a
  // grantee email (grantMembership takes an internal user id
  // only), so this route is the trigger surface until an
  // email-bearing provisioning path exists.
  if (path.endsWith("/payments/agentic/commercial/lifecycle/welcome") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        userId?: unknown; email?: unknown; tenantId?: unknown;
      };
      if (typeof body.userId !== "string" || typeof body.email !== "string") {
        return Response.json({ error: "userId and email are required." }, { status: 400 });
      }
      if (!canAccessAccount(login, body.userId)) return Response.json({ error: "Forbidden." }, { status: 403 });
      const sender = lifecycleSender();
      if (!sender) return Response.json({ sent: false, reason: "no-email-transport" });
      let preferences;
      const lifecycle = createLifecycleAdapter(ctx.env as { AGENT_DB?: unknown });
      if (lifecycle && typeof body.tenantId === "string" && body.tenantId) {
        try {
          await ensureLifecycleSchema(lifecycle.db);
          preferences = await lifecycle.getPreferences(body.userId, body.tenantId);
        } catch {
          preferences = undefined;
        }
      }
      // Issue #2522: content selection by effective tier. A tier
      // failure is a typed 503, NOT folded into send-failed:
      // the welcome is best-effort about the SEND, but content
      // selection must never guess a tier — sending a full
      // welcome to a Free user (or a limited one to a
      // Subscribed user) on an unknown tier is a wrong-tier
      // send with no audit trail.
      let tier: StoreTier;
      try {
        tier = await resolveEmailTier(body.userId);
      } catch {
        return Response.json({ error: "TierUnavailable: the tier store could not be read; welcome mail was not sent." }, { status: 503 });
      }
      const result = await sendWelcomeBestEffort({
        sender,
        email: body.email,
        userId: body.userId,
        preferences,
        tier,
      });
      // Issue #2659: record the address a successful welcome
      // used, so the scheduled digest pass can reach this
      // subscriber. Persistence never changes the send result.
      if (result.sent && lifecycle && typeof body.tenantId === "string" && body.tenantId) {
        await lifecycle.setSubscriberEmail(body.userId, body.tenantId, body.email).catch(() => {});
      }
      return Response.json(result);
    } catch (err: any) {
      return Response.json({ sent: false, reason: "send-failed" });
    }
  }

  // POST /payments/agentic/commercial/lifecycle/digest/send — own or operator.
  // The guarded send: opt-in check, per-day guard, skip-on-empty.
  // A scheduled trigger is follow-up work; this route is the
  // callable send surface.
  if (path.endsWith("/payments/agentic/commercial/lifecycle/digest/send") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        userId?: unknown; tenantId?: unknown; email?: unknown; items?: unknown;
      };
      if (typeof body.userId !== "string" || typeof body.tenantId !== "string" || typeof body.email !== "string") {
        return Response.json({ error: "userId, tenantId, and email are required." }, { status: 400 });
      }
      if (!canAccessAccount(login, body.userId)) return Response.json({ error: "Forbidden." }, { status: 403 });
      const items = Array.isArray(body.items) ? body.items.filter((i): i is string => typeof i === "string") : [];
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      const sender = lifecycleSender();
      if (!sender) return Response.json({ sent: false, reason: "no-email-transport" });
      const secret = unsubscribeSecret();
      const unsubscribeUrl = secret
        ? `https://agent.openaimp.com/payments/agentic/commercial/lifecycle/unsubscribe?token=${await signUnsubscribeToken(secret, body.userId, body.tenantId)}`
        : undefined;
      // Issue #2522: same fail direction as the welcome route —
      // a tier-store failure refuses with a typed 503 before any
      // send, never a default tier, never a guess.
      let tier: StoreTier;
      try {
        tier = await resolveEmailTier(body.userId);
      } catch {
        return Response.json({ error: "TierUnavailable: the tier store could not be read; digest mail was not sent." }, { status: 503 });
      }
      const result = await sendDailyDigest({
        store: lifecycle,
        sender,
        userId: body.userId,
        tenantId: body.tenantId,
        email: body.email,
        items,
        unsubscribeUrl,
        tier,
      });
      // Issue #2659: record the address a successful digest
      // used, so the scheduled digest pass can reach this
      // subscriber. Persistence never changes the send result.
      if (result.sent) {
        await lifecycle.setSubscriberEmail(body.userId, body.tenantId, body.email).catch(() => {});
      }
      return Response.json(result);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to send digest" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/lifecycle/digest/run-due — SERVICE identity only.
  // Issue #2659 (monetization Phase 2.4): the scheduled digest
  // pass trigger. The 30-minute tick (src/server.ts) calls this route
  // as the service user; it is NOT own-or-operator — a
  // subscriber must never be able to trigger a pass for all
  // subscribers. Auth: the configured SERVICE_USER_LOGIN only;
  // an unconfigured service login fails closed with 401.
  // Semantics: already-ran-today is a 200 with fired:false (the
  // tick calling again is normal); an unbound store or missing
  // transport is a 503 with NO day marker (retry next tick);
  // a thrown pass is a 500 with NO marker (retry next tick;
  // per-user day guards make the retry idempotent). The day
  // marker is written only after a completed pass. The tick
  // supplies no itemsByUser, so scheduled sends use the
  // digest content provider (#2981: tenant projection
  // highlights); an operator/system caller may still supply
  // itemsByUser, which wins per subscriber. A subscriber with
  // no windowed reports honestly skips. No unsubscribe link is attached:
  // the scheduled path has no trustworthy public origin (the
  // tick is a cron event, not a user-facing request) — opt-out
  // remains via the preferences panel and the unsubscribe route.
  if (path.endsWith("/payments/agentic/commercial/lifecycle/digest/run-due") && request.method === "POST") {
    try {
      const login = commercialLogin();
      const serviceLogin = getServiceUserLogin(ctx.env);
      if (!login || !serviceLogin || login !== serviceLogin) {
        return Response.json({ error: "Unauthorized: service identity required." }, { status: 401 });
      }
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      const day = digestDayKey(Date.now());
      if (await lifecycle.hasDigestPassRun(day)) {
        return Response.json({ fired: false, reason: "already-ran-today", dateKey: day });
      }
      const sender = lifecycleSender();
      if (!sender) {
        return Response.json({ error: "Digest pass unavailable: no email transport configured." }, { status: 503 });
      }
      const body = (await request.json().catch(() => ({}))) as { itemsByUser?: unknown };
      const itemsByUser: Record<string, string[]> = {};
      if (body.itemsByUser && typeof body.itemsByUser === "object") {
        for (const [userId, items] of Object.entries(body.itemsByUser)) {
          itemsByUser[userId] = Array.isArray(items)
            ? items.filter((i): i is string => typeof i === "string")
            : [];
        }
      }
      // Issue #2981 (monetization Phase 2.18): the tick's
      // itemsProvider. An operator/system caller may still supply
      // itemsByUser (including an explicit empty override); when
      // no override exists for a subscriber, the digest content
      // provider reads that subscriber's tenant projection
      // (agent_reports via readReports). The provider never
      // invents content: no windowed reports → [] → the pass
      // honestly skips that subscriber.
      const digestContentProvider = createDigestContentProvider((tenantId) =>
        readReports(ctx.env as { AGENT_DB?: unknown }, tenantId),
      );
      const summary = await sendDueDigests({
        store: lifecycle,
        sender,
        tierResolver: (userId) => resolveEmailTier(userId),
        itemsProvider: async (userId, tenantId) =>
          itemsByUser[userId] !== undefined
            ? itemsByUser[userId]
            : digestContentProvider(userId, tenantId),
      });
      await lifecycle.markDigestPassRun(day);
      try {
        await ctx.audit("lifecycle.digest.pass", "payments", {
          day,
          attempted: summary.attempted,
          sent: summary.sent,
          skipped: summary.skipped,
          failed: summary.failed,
        });
      } catch {
        // Audit failure never changes the pass result.
      }
      return Response.json({ fired: true, dateKey: day, summary });
    } catch (err: any) {
      return Response.json({ error: err.message || "Digest pass failed" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/lifecycle/unsubscribe — token
  // is the authentication (no session required: this is the
  // one-click link). Digest ONLY: a non-digest token is a 400,
  // and security mail has no unsubscribe path at all.
  if (path.endsWith("/payments/agentic/commercial/lifecycle/unsubscribe") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { token?: unknown };
      if (typeof body.token !== "string" || !body.token) {
        return Response.json({ error: "token is required." }, { status: 400 });
      }
      const secret = unsubscribeSecret();
      if (!secret) return Response.json({ error: "Unsubscribe is not configured." }, { status: 503 });
      const lifecycle = requireLifecycle();
      if (lifecycle instanceof Response) return lifecycle;
      const ensured = await ensureLifecycle(lifecycle);
      if (ensured) return ensured;
      try {
        const preferences = await applyUnsubscribe(lifecycle, secret, body.token);
        return Response.json({ preferences });
      } catch (err: any) {
        return Response.json({ error: err.message || "Invalid unsubscribe token." }, { status: 400 });
      }
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to unsubscribe" }, { status: 500 });
    }
  }

  return null;
}
