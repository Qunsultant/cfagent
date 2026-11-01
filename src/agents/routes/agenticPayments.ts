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
 *                                                  purchase, cancel, status)
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
import { createBillingCheckoutPorts, type BillingCheckoutEnv } from "../../services/createBillingCheckoutPorts";
import { createBillingPorts, type BillingEnv } from "../../services/createBillingPorts";
import { StripePaymentStrategy } from "../../patterns/paymentStrategies";

import { PROPOSED_SEED_PRICES } from "../../data/priceCataloguePorts";
import {
  createPriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../../data/createPriceCataloguePorts";
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
  mapRedemptionToJournalEntries,
  mapSubscriptionPurchaseToJournalEntries,
} from "../../data/journalPorts";
import { postJournalBestEffort } from "../../services/journalPosting";
import type { D1CommercialAdapter } from "../../data/d1CommercialAdapter";
import { toCommercialAccount, type StoreTier } from "../../data/commercialPorts";
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
import { assertBillingPolicyPartial } from "../../data/billingPolicyPorts";
import {
  applyBillingWebhookEvent,
  cancelBillingAtPeriodEnd,
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
import { PaymentGatewayService } from "../../services/payments";
import type { D1SubscriptionAdapter } from "../../data/d1SubscriptionAdapter";
import { resolveEffectiveTier, resolveTierTransition } from "../../data/subscriptionPorts";
import {
  NO_ACCOUNT_PAID_MESSAGE,
  resolvePlatformIdentity,
  toPlatformIdentityView,
} from "../../services/platformIdentity";
import { activateSubscription } from "../../services/subscriptionActivation";
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
import {
  convertReferralCreditsForRun,
  recordFirstPaidRunEarning,
} from "../../services/referralCredits";
import { createWorkflowPorts, type WorkflowEnv } from "../../workflows/createWorkflowPorts";
import { tryStartScreenerWorkflow } from "../../workflows/screenerWorkflowRoutes";
import type { WorkflowJobCommand } from "../../workflows/workflowPorts";

/** The subset of OrchestratorAgent surface the agentic-payments handlers need. */
export interface AgenticPaymentsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
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
    console.error(
      `[payments] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`
    );
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
  // PaymentWorkflow (via the SEARCH_AGENT channel) records cfpay
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
  // - Operator writes require COMMERCIAL_STORE_OPERATORS (empty =
  //   deny all). The consume/redeem/unredeemed-credit HTTP endpoints
  //   from the earlier DO-store draft are gone: with D1, the
  //   payment adapter and the submit route call the port directly,
  //   so no hop-only endpoint needs to exist.
  // ================================================================
  const commercialLogin = (): string | null => {
    const login = request.headers.get("x-user-login");
    return login && login.trim() ? login.trim() : null;
  };
  const isStoreOperator = (login: string | null): boolean => {
    if (!login) return false;
    const raw = (ctx.env as unknown as Record<string, unknown>)["COMMERCIAL_STORE_OPERATORS"];
    if (typeof raw !== "string" || !raw.trim()) return false;
    return raw.split(",").map((s) => s.trim()).includes(login);
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

  // POST /payments/agentic/commercial/account (operator only)
  if (path.endsWith("/payments/agentic/commercial/account") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        userId?: unknown; tenantId?: unknown; tier?: unknown; creditsUSD?: unknown; includedRuns?: unknown;
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
      const record = await store.upsertAccount({
        userId: upsertUserId,
        tenantId: typeof body.tenantId === "string" ? body.tenantId : "",
        tier: body.tier,
        // An operator write is an operator grant: it survives a
        // lapsed subscription (see resolveEffectiveTier).
        tierSource: "operator",
        creditsUSD: body.creditsUSD,
        includedRuns: body.includedRuns,
      });
      const transition = resolveTierTransition(previousAccount, previousSubscriptions, record, previousSubscriptions, Date.now());
      ctx.audit("commercial.account.upserted", "payments", {
        userId: record.id,
        tenantId: record.tenantId,
        tier: record.tier,
        previousEffectiveTier: transition.previousEffectiveTier,
        newEffectiveTier: transition.newEffectiveTier,
      });
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
          const handle = await tryStartScreenerWorkflow(ctx.env, verifiedCommand);
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
            console.error(`[payments] paid-submission record failed for ${handle.workflowId}: ${err?.message || "unknown error"}`);
            ctx.audit("commercial.submission.record_failed", "payments", { runRequestId, workflowId: handle.workflowId, userId: login });
          }
          // Issue #2155: project the redemption into the D1 journal
          // (Dr 2000 / Cr 4000 — the replacement run is delivered).
          // BEST-EFFORT, never thrown: the run already started and
          // the credit is already claimed; a journal failure is a
          // loud log + a reconcile flag. Posted only on start
          // success, never on the start_failed path above.
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
          }));
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
            console.error(`[payments] paid-submission record failed for ${started.workflowId}: ${recordErr?.message || "unknown error"}`);
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
            console.error(`[payments] referral auto-earn failed for ${login}: ${err?.message ?? "unknown error"}`);
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
      try {
        const instance = await binding.get(workflowId);
        const statusFn = (instance as { status?: unknown }).status;
        if (typeof statusFn === "function") {
          const result = (await (statusFn as () => Promise<unknown>).call(instance)) as { status?: unknown } | string | null;
          status =
            typeof result === "string"
              ? result
              : result && typeof result === "object" && typeof result.status === "string"
                ? result.status
                : "unknown";
        }
      } catch {
        status = "unknown";
      }
      return Response.json({ workflowId, status });
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

  // GET /payments/agentic/commercial/plans — active plans any verified login may buy.
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
      return Response.json({ plans: await subs.listPlans(true) });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list plans" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/plans (operator only) — plans are data, never code: no price is hardcoded anywhere.
  if (path.endsWith("/payments/agentic/commercial/plans") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        id?: unknown; name?: unknown; priceUSD?: unknown; periodDays?: unknown; includedRuns?: unknown;
      };
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.createPlan({
        id: body.id,
        name: body.name,
        priceUSD: body.priceUSD,
        periodDays: body.periodDays,
        includedRuns: body.includedRuns,
      });
      ctx.audit("commercial.plan.created", "payments", { planId: plan.id, priceUSD: plan.priceUSD, periodDays: plan.periodDays, includedRuns: plan.includedRuns });
      return Response.json({ plan });
    } catch (err: any) {
      const message = err.message || "Failed to create plan";
      return Response.json({ error: message }, { status: /required|must be|already exists/.test(message) ? 400 : 500 });
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
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown; tenantId?: unknown; email?: unknown };
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
      return Response.json({
        checkoutRequestId,
        checkoutUrl: created.checkoutUrl,
        checkoutSessionId: created.checkoutId,
        plan: { id: plan.id, name: plan.name, priceUSD: plan.priceUSD, periodDays: plan.periodDays, includedRuns: plan.includedRuns },
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to create subscription checkout" }, { status: 500 });
    }
  }

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
      } catch {
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
        return Response.json({ error: err.message || "Invalid billing policy update." }, { status: 400 });
      }
      const updated = await policy.updatePolicy(partial);
      ctx.audit("commercial.billing.policy_set", "payments", { userId: login, policy: updated });
      return Response.json({ policy: updated });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to handle billing policy" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/subscription/cancel — cancel-at-period-end.
  // Sets every unexpired row canceled; access continues to periodEnd, then stops. No cash refund
  // (deferred #2024). Self-service, or an operator on a user's behalf (body.userId).
  // Issue #2656 (Phase 2.1): Billing-aware. A locally-only cancel of a Billing-managed row would
  // leave Stripe charging while access shows canceled — so Billing rows are provider-canceled
  // FIRST (cancelBillingAtPeriodEnd, provider + local), and repurchase rows are canceled per-row
  // after. Any provider failure refuses with 503 and cancels NOTHING (atomicity: a half-canceled
  // user is worse than an un-canceled one). With no Billing rows, the existing
  // cancelUnexpiredSubscriptions path runs untouched. Cancel uses the Billing port regardless of
  // flag state: cancel STOPS money, never starts it, so the monetization flag (which gates
  // money-starting actions) must never block a user from stopping charges.
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
      const unexpired = (await subs.listSubscriptions(targetUser)).filter(
        (s) => s.status === "active" && s.periodEndMs > nowMs,
      );
      const billingRows = unexpired.filter((s) => isBillingManaged(s));
      let canceled;
      let billingCanceledIds: string[] = [];
      if (billingRows.length === 0) {
        canceled = await subs.cancelUnexpiredSubscriptions(targetUser, nowMs);
      } else {
        const billing = createBillingPorts(ctx.env as unknown as BillingEnv, true);
        if (!billing) {
          return Response.json({ error: "Billing cancel is not configured (Stripe): no subscriptions canceled." }, { status: 503 });
        }
        const billingCanceled = [];
        try {
          for (const row of billingRows) {
            billingCanceled.push(await cancelBillingAtPeriodEnd({ billing, subs, subscriptionId: row.id }));
          }
        } catch (err: any) {
          return Response.json({ error: `Billing cancel failed, no subscriptions canceled: ${err.message || "unknown error"}` }, { status: 503 });
        }
        billingCanceledIds = billingCanceled.map((s) => s.id);
        const repurchaseCanceled = [];
        for (const row of unexpired.filter((s) => !isBillingManaged(s))) {
          const one = await subs.cancelSubscription(row.id, nowMs);
          if (one) repurchaseCanceled.push(one);
        }
        canceled = [...billingCanceled, ...repurchaseCanceled].sort(
          (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      }
      const accessThroughMs = canceled.length > 0 ? Math.max(...canceled.map((s) => s.periodEndMs)) : null;
      // Issue #2522: cancel-at-period-end changes no periodEndMs,
      // so the effective tier is unchanged — the audit states the
      // tier at cancel time (access continues to periodEnd),
      // never a claimed change.
      const cancelAccount = await store.getAccount(targetUser);
      const cancelSubscriptions = await subs.listSubscriptions(targetUser);
      ctx.audit("commercial.subscription.canceled", "payments", {
        userId: targetUser,
        subscriptionIds: canceled.map((s) => s.id),
        billingCanceledIds,
        accessThroughMs,
        effectiveTier: resolveEffectiveTier(cancelAccount, cancelSubscriptions, Date.now()),
      });
      return Response.json({ userId: targetUser, canceled, accessThroughMs });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to cancel subscription" }, { status: 500 });
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
      return Response.json({
        monetizationEnabled,
        prices,
        network: deriveNetworkMarker({ stripeMode, x402Network }),
        browserPaymentScope: resolveBrowserPaymentScope(envRecord.COMMERCIAL_BROWSER_PAYMENT_SCOPE),
        failurePolicy: NATIVE_PAYMENT_DISCLOSURE,
      });
    } catch {
      return Response.json({ error: "Failed to read pricing." }, { status: 500 });
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
      const status = /required|must be|not allowed|exceeds|expired|non-refundable|No subscription|Only the|no stored|determinable|rail is required|resolver/.test(message)
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
      const record = await executeRefund(
        {
          policyStore: ports.policy,
          refundStore: ports.store,
          sourceResolver: createSubscriptionPaymentResolver(subs),
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
            : /not resolvable|non-refundable|window expired|not allowed|exceeds|not configured|flag is OFF|already received its automatic replacement-run credit|failure-credit lookup/.test(message)
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

  // Refund policy read: current operator policy plus the PROPOSED
  // disclosure copy (the UI slice surfaces this copy later).
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
      return Response.json({ policy, disclosure: REFUND_POLICY_COPY, proposed: true });
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
  // re-checks provider state itself on confirm). Ownership:
  // runRequestId is unguessable, the same standard as
  // submission-status. A payment URL is returned ONLY when it is the
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
        } catch {
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
        } catch {
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
      return Response.json(result);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to send digest" }, { status: 500 });
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
