/**
 * Issue #359-07: payments routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the Multi-Gateway Payments & DID Management API section:
 * GET /payments/gateways|/payments/status, GET /payments/dids,
 * /payments/transactions (ledger with DID provenance), POST /payments/create
 * (#1690: HITL draft via draft_payment — no checkout at create, gateway
 * validation + DID attestation), POST /payments/confirm (HITL authorize &
 * execute via confirm_payment_draft), POST /payments/capture
 * (real capture), POST /payments/webhook (unified HMAC-verified listener).
 *
 * #1711 (owner directive 2026-10-26, verbatim: "never either/or,
 * always configurable"): POST /payments/create and /payments/confirm
 * are CONFIGURABLE via the single Worker env switch
 * PAYMENTS_FLOW_MODE ("hitl" | "immediate", default "hitl", invalid
 * fails closed to "hitl" with a payment.config_error audit — see
 * resolvePaymentsFlowMode below). HITL mode is the unchanged #1690
 * behavior; immediate mode is the pre-#1690 route behavior recovered
 * verbatim from the parent tree of merge 0d538b10 (checkout at
 * create, pending_checkout, PAYMENT_GATEWAY_ERROR at create, confirm
 * creates a checkout only if missing). Neither flow is deleted.
 * Setting the switch is an OWNER action: a plain-text Worker var in
 * wrangler.jsonc `vars` or the Cloudflare dashboard Variables, then
 * redeploy; this slice sets no production value. Per-mode audit
 * vocabularies are kept separate (hitl: payment.awaiting_confirmation
 * + the command's payment.confirmed/payment.rejected; immediate:
 * payment.created + the route's payment.confirmed/payment.rejected
 * with executorDid) — they are not merged.
 *
 * #1735 (parent #1717, slice (o)): the switch's RESOLUTION is now
 * scoped, run > session > user > global env > built-in hitl (see
 * src/config/paymentsFlowModes.ts and flowModeForRequest below).
 * The env value stays the global fallback; the legacy env-only
 * resolver resolvePaymentsFlowMode is kept unchanged for its
 * #1711 pins. The run value is execution-owner-set on the route
 * context, never request input — a caller must not be able to flip
 * their own execution to immediate and bypass the HITL confirm gate.
 * The seven blocks were contiguous in routeRequest (between the
 * referrals+ads handler and the Cloudflare Agentic Payments block), so this
 * module exports ONE handler invoked from routeRequest at the EXACT position
 * the original blocks occupied in the sequential path.endsWith matching
 * sequence. It returns a Response when one of its paths matches, or null
 * when none does — matching order relative to all other handlers is
 * preserved by the call site.
 *
 * Payment routes are money-adjacent; every guard and validation is
 * preserved exactly as written inline: the #156 gateway 400-before-checkout
 * gate, the #148 webhook provider default-deny (401 before verification),
 * signature verification (401 on invalid), and the audit event names
 * (hitl: payment.awaiting_confirmation / payment.confirmed /
 * payment.rejected; immediate: payment.created / payment.confirmed /
 * payment.rejected — #1690 replaced the old payment.created create
 * audit with the draft command's payment.awaiting_confirmation audit
 * in hitl mode only; #1711 restores payment.created in immediate
 * mode. payment.config_error is emitted in either mode when
 * PAYMENTS_FLOW_MODE holds an unrecognized value, before the
 * request proceeds in fail-closed hitl mode / payment.captured /
 * payment.settled_webhook).
 *
 * The PaymentGatewayService and DID helpers stay where they are — this
 * module moves the ROUTE layer only. Handlers that used OrchestratorAgent
 * state receive it via the explicit PaymentsRouteContext parameter; there
 * are no new globals and no back-references into the class.
 */

import {
  PaymentGatewayService,
  normalizeGateway,
  isWebhookGateway,
  isSupportedGateway,
  SUPPORTED_GATEWAYS,
  type SupportedGateway,
} from "../../services/payments";
import { AGENT_DIDS, getUserDid, resolveAgentDidDocument } from "../did";
import {
  SETTLEMENT_OWNER_HEADER,
  registerDraftOwner,
  resolveDraftOwner,
} from "../../payments/draftOwners";
import {
  createNativeLedgerAdapter,
  ensureNativeLedgerSchema,
} from "../../data/createNativeLedgerPorts";
import {
  isNativeScreenerDraft,
  isNativeSubscriptionDraft,
  nativeWebhookRecordInput,
} from "../../services/nativeWebhook";
import type { AgentName, Env, TransactionRecord } from "../../types";
import { DatabaseORM, type SqlStorage } from "../../orm";
import { executeMCPTool } from "../../mcps/openaimp/index";
import { runRestTool } from "./restToolBridge";
import {
  paymentsConfigErrorEvent,
  resolvePaymentsSwitchByKey,
  type PaymentsModeValues,
  type PaymentsScopedModes,
  type PaymentsSurfaceMode,
} from "../../config/agenticPaymentsModes";
import {
  levelsForPaymentsFlowMode,
  resolvePaymentsFlowModeScoped,
  type PaymentsFlowScopedModes,
} from "../../config/paymentsFlowModes";
import { readReceipts, type ReceiptKind } from "../../services/receiptSurface";

/** The subset of OrchestratorAgent surface the payments handlers need. */
export interface PaymentsRouteContext {
  /** Worker environment (owner: OrchestratorAgent — was `this.env`). */
  env: Env;
  /** SQLite accessor (owner: OrchestratorAgent — was the routeRequest-local `sql`). */
  ensureTables(): SqlStorage;
  /**
   * #1644: ORM accessor for command execution. Optional — routes without
   * it build a DatabaseORM over ensureTables() (same tables, no seeding).
   */
  getOrm?: () => DatabaseORM;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /**
   * #1728: optional session/user carriers for the payments switches
   * (run comes from the per-request `mode` / `?mode=`, global env
   * from `env`). Populated by the execution-context owner; unset
   * carriers fall through to env. See
   * src/config/agenticPaymentsModes.ts.
   */
  scopedPaymentsModes?: PaymentsScopedModes;
  /**
   * #1735: optional session/user carriers for the PAYMENTS_FLOW_MODE
   * switch (run comes from `paymentsFlowModeRun` below, global env
   * from `env`). Populated by the execution-context owner; unset
   * carriers fall through to env. See
   * src/config/paymentsFlowModes.ts.
   */
  scopedPaymentsFlowModes?: PaymentsFlowScopedModes;
  /**
   * #1735: per-run PAYMENTS_FLOW_MODE override, set by the execution
   * owner for this run only (never parsed from request input — a
   * request-supplied flow value would let a caller flip their own
   * execution to immediate and bypass the HITL confirm gate; see
   * src/config/paymentsFlowModes.ts). Unset falls through to
   * session > user > env > hitl. Never stored on the route or the
   * agent instance: it is a per-call value, so one run's mode can
   * never leak into another run.
   */
  paymentsFlowModeRun?: unknown;
}

/**
 * #1728: resolves one payments switch for a route in run > session
 * > user > env > builtin order. An invalid winning value fails
 * closed to the route legacy and is logged + audited as
 * payment.config_error (agent "payments", the route's audit vocab).
 */
function resolvePaymentsRouteMode(
  ctx: PaymentsRouteContext,
  key: keyof PaymentsModeValues,
  run: unknown,
  legacy: PaymentsSurfaceMode
): PaymentsSurfaceMode {
  const envRecord = ctx.env as unknown as Record<string, unknown> | undefined;
  const { resolved, switchName } = resolvePaymentsSwitchByKey(
    ctx.scopedPaymentsModes,
    key,
    run,
    envRecord?.[PAYMENTS_ROUTE_SWITCH_NAMES[key]],
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
const PAYMENTS_ROUTE_SWITCH_NAMES: Record<keyof PaymentsModeValues, string> = {
  create: "PAYMENTS_CREATE_MODE",
  confirm: "PAYMENTS_CONFIRM_MODE",
  transactions: "PAYMENTS_TRANSACTIONS_MODE",
  wallet: "AGENTIC_WALLET_MODE",
  screener: "PREMIUM_SCREENER_MODE",
  research: "PREMIUM_RESEARCH_MODE",
};

/** The two payments flows behind the #1711 switch. */
export type PaymentsFlowMode = "hitl" | "immediate";

export interface ResolvedPaymentsFlowMode {
  mode: PaymentsFlowMode;
  /** The raw env value, when it was a string (preserved for audit). */
  raw?: string;
  /** True only for an unrecognized non-blank value (fail-closed hitl). */
  invalid: boolean;
}

/**
 * #1711: resolves the ONE payments-flow switch, PAYMENTS_FLOW_MODE.
 * Unset or blank → "hitl" (the #1690 default, NOT invalid).
 * "hitl" / "immediate" (case-insensitive, surrounding whitespace
 * ignored) → that mode. Anything else → "hitl" FAIL-CLOSED with
 * invalid=true; callers must log + audit the config error (see
 * flowModeForRequest) and must NEVER treat an invalid value as
 * immediate. There is no second switch for this choice.
 */
export function resolvePaymentsFlowMode(
  env: { PAYMENTS_FLOW_MODE?: unknown } | null | undefined
): ResolvedPaymentsFlowMode {
  const rawValue = env?.PAYMENTS_FLOW_MODE;
  const raw = typeof rawValue === "string" ? rawValue : undefined;
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return { mode: "hitl", raw, invalid: false };
  if (normalized === "hitl") return { mode: "hitl", raw, invalid: false };
  if (normalized === "immediate") return { mode: "immediate", raw, invalid: false };
  return { mode: "hitl", raw, invalid: true };
}

/**
 * #1735: resolves the flow for one request over run > session >
 * user > global env > built-in hitl (see
 * src/config/paymentsFlowModes.ts). On an invalid winning value,
 * logs and audits the config error BEFORE the request proceeds in
 * fail-closed hitl mode. Auditing here (rather than only logging)
 * makes a misconfigured deployment visible in the audit ledger, not
 * just in Workers Logs. The audit payload keeps the #1711 fields
 * (setting/value/resolved) and adds the winning `level`.
 */
function flowModeForRequest(ctx: PaymentsRouteContext): PaymentsFlowMode {
  const envRecord = ctx.env as unknown as Record<string, unknown> | undefined;
  const resolved = resolvePaymentsFlowModeScoped(
    levelsForPaymentsFlowMode(
      ctx.scopedPaymentsFlowModes,
      ctx.paymentsFlowModeRun,
      envRecord?.PAYMENTS_FLOW_MODE
    )
  );
  if (resolved.invalid) {
    console.error(
      `[payments] invalid PAYMENTS_FLOW_MODE value ${JSON.stringify(resolved.raw)} at ${resolved.level} — failing closed to "hitl"`
    );
    ctx.audit("payment.config_error", "payments", {
      setting: "PAYMENTS_FLOW_MODE",
      value: resolved.raw ?? "",
      resolved: "hitl",
      level: resolved.level,
    });
  }
  return resolved.mode;
}

/**
 * Handles the payments routes. Returns a Response on match, null when
 * no payments path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handlePaymentsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PaymentsRouteContext
): Promise<Response | null> {
  const sql = ctx.ensureTables();
  // #2360 (#1976 step 4d-2, audit R-2): the immediate flows'
  // mas_transactions statements run through the step-3a
  // transaction-ledger port — resolved through the same
  // accessor the delegated handlers below use (the agent's
  // ORM when the context carries one, a fresh DatabaseORM
  // over the same storage otherwise).
  const ledger = () =>
    (ctx.getOrm?.() ?? new DatabaseORM(sql)).transactions;
  // Multi-Gateway Payments & DID Management API
  // ==========================================

  // Gateway status & DID registry
  // #1644: executed through the get_payment_gateways command. The facade
  // delegates to the same PaymentGatewayService the route called, so the
  // data is identical; the route keeps its 3-field shape (the command's
  // extra `count` is presentation the route does not carry).
  if ((path.endsWith("/payments/gateways") || path.endsWith("/payments/status")) && request.method === "GET") {
    const out = await executeMCPTool("get_payment_gateways", {}, {
      env: ctx.env,
      orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
      sessionId,
      audit: (type, agent, payload) => ctx.audit(type, agent, payload),
      // #1744: in-process platform call — the REST route's own auth
      // is the gate here; the MCP gate still enforces + isolates.
      principal: { kind: "system", login: null },
    });
    return Response.json({
      gateways: out.gateways,
      agentDids: out.agentDids,
      userDid: out.userDid,
    });
  }

  // W3C DID Document resolver for agents
  if (path.endsWith("/payments/dids") && request.method === "GET") {
    const didParam = url.searchParams.get("did");
    if (didParam) {
      return Response.json(resolveAgentDidDocument(didParam));
    }
    const didDocs = Object.values(AGENT_DIDS).map((did) => resolveAgentDidDocument(did));
    return Response.json({
      count: didDocs.length,
      documents: didDocs,
    });
  }

  // Transaction ledger with DID provenance
  if (path.endsWith("/payments/transactions")) {
    if (request.method === "GET") {
      try {
        // #1728: the transactions switch. Mode "mcp" adopts the MCP
        // list contract: the query limit + status filter are honored
        // and the command's raw output is returned as-is (no remap,
        // no summary). Mode "rest" (legacy) keeps the route contract
        // below: limit fixed at 50, status ignored, rows remapped,
        // summary added. The resolved mode is passed as the command's
        // run value so the two resolutions cannot disagree.
        const transactionsMode = resolvePaymentsRouteMode(
          ctx, "transactions", url.searchParams.get("mode"), "rest"
        );
        if (transactionsMode === "mcp") {
          const limitParam = url.searchParams.get("limit");
          const statusParam = url.searchParams.get("status");
          const out = await runRestTool("get_transactions", {
            limit: limitParam === null ? 50 : Number(limitParam),
            ...(statusParam ? { status: statusParam } : {}),
            mode: "mcp",
          }, {
            orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
            sessionId,
            audit: (type, agent, payload) => ctx.audit(type, agent, payload),
            scopedPaymentsModes: ctx.scopedPaymentsModes,
          });
          return Response.json(out);
        }
        // #1644: the ledger query (created_at DESC, limit 50) executes
        // through the get_transactions command. The route keeps its row
        // coercions and summary stats as presentation — the command rows
        // already carry the camelCase fields the old raw-SQL mapping built.
        // #1728: in rest mode the command already returns the coerced
        // rows + summary; the remap/summary below are idempotent over
        // them, so the route rest shape and the command rest shape are
        // identical (pinned by the #1728 test).
        const out = (await runRestTool("get_transactions", { limit: 50, mode: "rest" }, {
          orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
          sessionId,
          audit: (type, agent, payload) => ctx.audit(type, agent, payload),
          scopedPaymentsModes: ctx.scopedPaymentsModes,
        })) as { transactions: any[] };

        const transactions = out.transactions.map((t) => ({
          id: String(t.id),
          sessionId: String(t.sessionId),
          action: String(t.action),
          amount: Number(t.amount || 0),
          currency: String(t.currency || "USD"),
          customer: String(t.customer),
          gateway: String(t.gateway || "stripe"),
          gatewayRef: String(t.gatewayRef || ""),
          status: String(t.status),
          checkoutUrl: String(t.checkoutUrl || ""),
          proposerDid: String(t.proposerDid || AGENT_DIDS.PAYMENTS),
          authorizerDid: t.authorizerDid ? String(t.authorizerDid) : undefined,
          proofSignature: String(t.proofSignature || ""),
          note: String(t.note || ""),
          createdAt: String(t.createdAt),
          updatedAt: String(t.updatedAt),
        }));

        const totalVolume = transactions
          .filter((t) => t.status === "completed" || t.status === "authorized")
          .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : -t.amount), 0);

        const pendingCount = transactions.filter((t) => t.status === "awaiting_confirmation").length;
        const completedCount = transactions.filter((t) => t.status === "completed" || t.status === "authorized").length;

        return Response.json({
          count: transactions.length,
          transactions,
          summary: {
            totalVolume: Math.max(0, totalVolume),
            completedCount,
            pendingCount,
            verifiedDidCount: transactions.length,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
      }
    }
  }

  // Receipts read-back (issue #2543): the caller's own meter rows,
  // tier-decision audit rows, and joined gateway rows — NEVER the
  // unscoped transactions list, NEVER another identity key's rows.
  // Read-only: it confirms nothing, moves no funds, replays no charge.
  // The caller is the session login (x-user-login, set by the worker
  // from the verified session; deleted when no session exists).
  if (path.endsWith("/payments/receipts") && request.method === "GET") {
    const login = request.headers.get("x-user-login");
    if (!login) {
      return Response.json(
        {
          error: "ReceiptsLoginRequired",
          statusCode: 401,
          message: "Receipts require a signed-in session (x-user-login).",
        },
        { status: 401 },
      );
    }
    const rawLimit = url.searchParams.get("limit");
    let limit = 50;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return Response.json(
          {
            error: "ReceiptsInvalidLimit",
            statusCode: 400,
            message: "limit must be a positive integer.",
          },
          { status: 400 },
        );
      }
      limit = Math.min(parsed, 100);
    }
    const kindParam = url.searchParams.get("kind") ?? "all";
    if (kindParam !== "all" && kindParam !== "meter" && kindParam !== "tier" && kindParam !== "transaction") {
      return Response.json(
        {
          error: "ReceiptsInvalidKind",
          statusCode: 400,
          message: "kind must be one of meter, tier, transaction, all.",
        },
        { status: 400 },
      );
    }
    try {
      const orm = ctx.getOrm?.() ?? new DatabaseORM(sql);
      const result = readReceipts({ sql, orm }, login, {
        limit,
        kind: kindParam as ReceiptKind | "all",
      });
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to fetch receipts" },
        { status: 500 },
      );
    }
  }

  // Create a payment draft (#1690: delegated to draft_payment — no
  // checkout at create; the checkout happens at confirm).
  if (path.endsWith("/payments/create") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        amount?: number;
        currency?: string;
        customer?: string;
        action?: "charge" | "refund" | "invoice";
        gateway?: string;
        description?: string;
        mode?: string;
      };

      // #524: an omitted or unparseable amount is a validation error, never
      // a silent $10 charge.
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return Response.json(
          { error: "amount is required and must be a positive number" },
          { status: 400 }
        );
      }
      const currency = (body.currency || "USD").toUpperCase();
      // No invented customer name (issue #514): a create that supplies no
      // customer stores "" rather than a fabricated organization.
      const customer = (body.customer || "").trim();
      const action = body.action || "charge";
      // Validate the gateway where caller input enters (issue #156): an
      // unsupported value is rejected with a 400 BEFORE any checkout is
      // attempted and BEFORE any transaction row is written. Normalization
      // matches the webhook verifier (#148), so " Stripe " stores "stripe".
      const gatewayInput =
        body.gateway == null || (typeof body.gateway === "string" && body.gateway.trim() === "")
          ? "stripe"
          : String(body.gateway);
      if (!isSupportedGateway(gatewayInput)) {
        return Response.json({
          success: false,
          error: `Unsupported payment gateway: "${gatewayInput}". Supported gateways: ${SUPPORTED_GATEWAYS.join(", ")}.`,
          code: "UNSUPPORTED_GATEWAY",
        }, { status: 400 });
      }
      const gateway = normalizeGateway(gatewayInput) as SupportedGateway;
      // No invented product description (issue #514): a create that
      // supplies no description stores "" — the caller's text or nothing,
      // never a product line for a product that does not exist.
      const description = (body.description || "").trim();

      // #1711: one switch, two flows. Invalid values fail closed to
      // hitl (with a payment.config_error audit) via flowModeForRequest.
      const flowMode = flowModeForRequest(ctx);

      // #1711 immediate mode: the pre-#1690 route behavior, recovered
      // verbatim from the parent tree of merge 0d538b10 (see the PR
      // body for the diff-verification and the one deliberate
      // non-deviation note: none — the recovered block is unchanged,
      // including its PAYMENT_GATEWAY_ERROR-at-create path and its
      // pending_checkout/completed initial-status rule). The shared
      // #524/#156/#514 validations above run identically in both
      // modes, before either flow's row write.
      if (flowMode === "immediate") {
        const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
        const userDid = getUserDid(sessionId);

        const paymentService = new PaymentGatewayService(ctx.env);
        const checkoutResult = await paymentService.createCheckout({
          draftId,
          amount,
          currency,
          customer,
          description,
          gateway,
          userLogin: sessionId,
        });

        if (!checkoutResult.success) {
          return Response.json({
            success: false,
            error: checkoutResult.message || `Failed to create checkout with ${gateway}`,
            code: "PAYMENT_GATEWAY_ERROR",
          }, { status: 400 });
        }

        const now = new Date().toISOString();
        const initialStatus = checkoutResult.checkoutUrl ? "pending_checkout" : "completed";
        // #2360: the ledger port's create() — the same plain
        // INSERT (insert-or-throw, D-E.1) with the same 16
        // fields in the same order. The cast exists because
        // "pending_checkout" is a stored status the
        // TransactionRecord union predates (it names only the
        // HITL vocabulary); the stored value is unchanged.
        ledger().create({
          id: draftId,
          sessionId,
          action,
          amount,
          currency,
          customer,
          gateway,
          gatewayRef: checkoutResult.gatewayRef || "",
          status: initialStatus,
          checkoutUrl: checkoutResult.checkoutUrl,
          proposerDid: AGENT_DIDS.PAYMENTS,
          authorizerDid: userDid,
          proofSignature: checkoutResult.didAttestation.signature,
          note: description,
          createdAt: now,
          updatedAt: now,
        } as TransactionRecord);

        ctx.audit("payment.created", "payments", {
          draftId,
          amount,
          currency,
          customer,
          gateway,
          proposerDid: AGENT_DIDS.PAYMENTS,
          authorizerDid: userDid,
          proofSignature: checkoutResult.didAttestation.signature,
        });

        // Issue #932: record which instance owns this draft so a gateway
        // settlement webhook — received by the shared
        // system_webhook_receiver instance, not this one — can be routed
        // back here. Written for every draft, whatever its initial status.
        await registerDraftOwner(ctx.env, draftId, sessionId);

        return Response.json({
          success: true,
          transaction: {
            id: draftId,
            sessionId,
            action,
            amount,
            currency,
            customer,
            gateway,
            gatewayRef: checkoutResult.gatewayRef,
            status: initialStatus,
            checkoutUrl: checkoutResult.checkoutUrl,
            proposerDid: AGENT_DIDS.PAYMENTS,
            authorizerDid: userDid,
            proofSignature: checkoutResult.didAttestation.signature,
            note: description,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // #1690 (owner decision: HITL-draft canonical): create executes
      // through the MCP draft_payment command via executeMCPTool — the
      // #1644 pattern, route keeps transport + presentation only. The
      // command mints the draft id + DID attestation, writes the
      // awaiting_confirmation row (checkoutUrl/gatewayRef ""), records
      // the #932 draft owner, and audits payment.awaiting_confirmation.
      // NO checkout is attempted here: the old PAYMENT_GATEWAY_ERROR
      // -at-create path disappears, and checkout failures surface at
      // confirm instead. The gateway 400 above still runs BEFORE any
      // command call (hence before any row write) in both modes: it
      // is the route's guard, and the command's own rest-mode
      // validation (#1728) exists for direct MCP callers, not as a
      // substitute for this check.
      // #1728: the create switch, resolved here (HITL path only —
      // the immediate branch above never delegates, so it never
      // resolves this switch). The route's own gateway 400 above
      // runs in BOTH modes (it is a guard, not a presentation
      // delta), and the description is passed explicitly in both
      // modes, so the resolved mode changes nothing on this route —
      // it is carried as the command's run value so the delegation
      // cannot resolve differently from the route. An invalid value
      // fails closed to "rest" with a payment.config_error audit.
      const createMode = resolvePaymentsRouteMode(ctx, "create", body.mode, "rest");

      const out = await executeMCPTool("draft_payment", {
        amount,
        currency,
        customer,
        action,
        gateway,
        // Explicitly passed even when "" so the command's #1690/#514
        // rule keeps the pinned empty note (an omitted description
        // keeps the command's generic default only for direct MCP
        // callers that omit the field entirely — and only in mcp
        // mode; rest mode stores "" for direct callers too, #1728).
        description,
        mode: createMode,
      }, {
        env: ctx.env,
        orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
        sessionId,
        audit: (type, agent, payload) => ctx.audit(type, agent, payload),
        // #1744: in-process platform call — see get_payment_gateways above.
        principal: { kind: "system", login: null },
      });
      const tx = out.transaction;

      return Response.json({
        success: true,
        transaction: {
          id: String(tx.id),
          sessionId: String(tx.sessionId),
          action: String(tx.action),
          amount: Number(tx.amount),
          currency: String(tx.currency),
          customer: String(tx.customer),
          gateway: String(tx.gateway),
          gatewayRef: String(tx.gatewayRef || ""),
          status: String(tx.status),
          checkoutUrl: String(tx.checkoutUrl || ""),
          proposerDid: String(tx.proposerDid),
          authorizerDid: tx.authorizerDid ? String(tx.authorizerDid) : undefined,
          proofSignature: String(tx.proofSignature || ""),
          note: String(tx.note || ""),
          createdAt: String(tx.createdAt),
          updatedAt: String(tx.updatedAt),
        },
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to create payment" }, { status: 500 });
    }
  }

  // Authorize & Execute a pending payment draft (HITL)
  // #1690 (owner decision: HITL-draft canonical): confirm executes
  // through the MCP confirm_payment_draft command via executeMCPTool —
  // the #1644 pattern, route keeps transport + presentation only.
  // Deltas from the old REST confirm, all owned by the command now:
  // a missing draft THROWS before the decision branch (mapped to 404
  // here — no more silent success); an approved charge/invoice creates
  // a checkout UNCONDITIONALLY via the facade (overwriting any
  // checkoutUrl an old-immediate-checkout row already carries — see
  // the migration note in the issue); note text is the command's
  // ("Approved by human authorizer" / "Rejected by human reviewer");
  // and the confirm/reject audits are the command's payloads
  // (decision/status fields in, executorDid out).
  if (path.endsWith("/payments/confirm") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        draftId?: string;
        decision?: "approved" | "rejected";
        note?: string;
        mode?: string;
      };

      const draftId = (body.draftId || "").trim();
      const decision = body.decision || "approved";
      const note = (body.note || "").trim();

      if (!draftId) {
        return Response.json({ error: "draftId is required" }, { status: 400 });
      }

      // #1711: same single switch as create. Invalid values fail
      // closed to hitl (with a payment.config_error audit).
      const flowMode = flowModeForRequest(ctx);

      // #1711 immediate mode: the pre-#1690 route behavior, recovered
      // verbatim from the parent tree of merge 0d538b10. Deltas from
      // hitl, all preserved deliberately (see the PR body): a missing
      // draft does NOT 404 — the UPDATE matches 0 rows and the route
      // still returns success/completed (the recovered silent-success
      // behavior, kept as recovered, not re-decided here); an approved
      // charge/invoice creates a checkout ONLY if none exists yet
      // (an existing checkoutUrl/gatewayRef is kept, never
      // overwritten); note text is "Confirmed by human authorizer" /
      // "Rejected by reviewer"; audits are the route's own
      // payment.confirmed (with executorDid) / payment.rejected
      // ({draftId, authorizerDid}) payloads.
      if (flowMode === "immediate") {
        const userDid = getUserDid(sessionId);
        const now = new Date().toISOString();

        if (decision === "approved") {
          // Retrieve draft from mas_transactions (via the
          // ledger port's findById — the same row, camelCase).
          const tx = ledger().findById(draftId);
          const paymentService = new PaymentGatewayService(ctx.env);

          let checkoutUrl = tx?.checkoutUrl || "";
          let gatewayRef = tx?.gatewayRef || "";

          if (tx && (tx.action === "charge" || tx.action === "invoice") && !checkoutUrl) {
            const res = await paymentService.createCheckout({
              draftId,
              amount: Number(tx.amount),
              currency: String(tx.currency || "USD"),
              customer: String(tx.customer),
              gateway: tx.gateway as SupportedGateway,
              userLogin: sessionId,
              description: tx.note || "Authorized payment intent",
            });
            checkoutUrl = res.checkoutUrl;
            gatewayRef = res.gatewayRef;
          } else if (tx && tx.action === "refund") {
            const res = await paymentService.executeRefund({
              transactionId: draftId,
              amount: Number(tx.amount),
              gateway: tx.gateway as SupportedGateway,
              gatewayRef: tx.gatewayRef,
              userLogin: sessionId,
              reason: note,
            });
            gatewayRef = res.refundId;
          }

          // #2360: the port's named completion — the same
          // field set and WHERE shape as the raw UPDATE it
          // replaces, no status guard (a missing draft still
          // lands here and matches 0 rows: the recovered
          // silent-success behaviour, pinned as found).
          ledger().completeWithGateway(draftId, {
            gatewayRef,
            checkoutUrl,
            authorizerDid: userDid,
            note: note || "Confirmed by human authorizer",
            updatedAt: now,
          });

          ctx.audit("payment.confirmed", "payments", {
            draftId,
            authorizerDid: userDid,
            executorDid: AGENT_DIDS.ORCHESTRATOR,
            gatewayRef,
            checkoutUrl,
          });

          return Response.json({
            success: true,
            status: "completed",
            draftId,
            checkoutUrl,
            gatewayRef,
            authorizerDid: userDid,
          });
        } else {
          ledger().rejectWithNote(draftId, {
            authorizerDid: userDid,
            note: note || "Rejected by reviewer",
            updatedAt: now,
          });

          ctx.audit("payment.rejected", "payments", { draftId, authorizerDid: userDid });
          return Response.json({ success: true, status: "rejected", draftId });
        }
      }

      // #1728: the confirm switch, resolved here (HITL path only —
      // the immediate branch above returns its verbatim envelope and
      // never resolves this switch). The resolved mode is carried as
      // the command's run value so the delegation cannot resolve
      // differently from the route. Mode "mcp" returns the command's
      // full envelope (with success added); mode "rest" (legacy)
      // returns the historic REST subset. An invalid value fails
      // closed to "rest" with a payment.config_error audit.
      const confirmMode = resolvePaymentsRouteMode(ctx, "confirm", body.mode, "rest");

      let out: any;
      try {
        out = await executeMCPTool("confirm_payment_draft", {
          draftId,
          decision,
          note,
          mode: confirmMode,
        }, {
          env: ctx.env,
          orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
          sessionId,
          audit: (type, agent, payload) => ctx.audit(type, agent, payload),
          // #1744: in-process platform call — see get_payment_gateways above.
          principal: { kind: "system", login: null },
        });
      } catch (err) {
        // The command throws on a missing draft before either decision
        // branch; that is a client error, not a 500 — and it replaces
        // the old route's silent success on a missing draft.
        if (err instanceof Error && /not found/i.test(err.message)) {
          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }

      if (confirmMode === "mcp") {
        return Response.json({ success: true, ...out });
      }
      if (out.status === "completed") {
        return Response.json({
          success: true,
          status: "completed",
          draftId,
          checkoutUrl: out.checkoutUrl || "",
          gatewayRef: out.gatewayRef || "",
          authorizerDid: out.authorizerDid,
        });
      }
      return Response.json({ success: true, status: "rejected", draftId });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to confirm payment draft" }, { status: 500 });
    }
  }

  // Real payment capture endpoint (PayPal & Stripe)
  if (path.endsWith("/payments/capture") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        orderId?: string;
        gateway?: SupportedGateway;
      };
      const orderId = (body.orderId || "").trim();
      const gateway = (body.gateway || "paypal") as SupportedGateway;
      if (!orderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }
      const paymentService = new PaymentGatewayService(ctx.env);
      const result = await paymentService.capturePayment({
        gateway,
        orderId,
        userLogin: sessionId,
      });

      if (result.success) {
        const now = new Date().toISOString();
        // #2360: the port's id-OR-gateway_ref completion —
        // the same statement, the reference bound twice.
        ledger().completeByIdOrGatewayRef(orderId, now);
        ctx.audit("payment.captured", "payments", { orderId, gateway, captureId: result.captureId });
      }

      return Response.json(result);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to capture payment" }, { status: 500 });
    }
  }

  // Unified Payment Webhook listener (Stripe, PayPal, Lemon Squeezy with HMAC Verification)
  if (path.endsWith("/payments/webhook") && request.method === "POST") {
    try {
      const providerParam = url.searchParams.get("provider") || "stripe";
      const provider = normalizeGateway(providerParam) as SupportedGateway;

      // Defence in depth (issue #148): reject unsupported providers at
      // the route, before verification and before any state change. The
      // service's verifier independently default-denies them; a webhook
      // from an unverifiable provider must never settle a transaction.
      if (!isWebhookGateway(provider)) {
        return Response.json({ error: `Unsupported webhook provider: ${providerParam}` }, { status: 401 });
      }

      const rawBody = await request.text();
      const paymentService = new PaymentGatewayService(ctx.env);

      // Verify cryptographic webhook signature
      const verification = await paymentService.verifyWebhookSignature(provider, rawBody, request.headers);
      if (!verification.isValid) {
        return Response.json({ error: verification.reason || "Invalid webhook signature" }, { status: 401 });
      }

      let body: any = {};
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = {};
      }

      const now = new Date().toISOString();

      // Extract reference ID from Stripe / PayPal / Lemon Squeezy payload
      const draftId = body?.data?.object?.client_reference_id ||
        body?.resource?.purchase_units?.[0]?.reference_id ||
        body?.data?.attributes?.checkout_data?.custom?.draftId ||
        body?.draftId;

      if (draftId) {
        // Issue #932: settlement must execute in the instance that OWNS
        // the draft. Webhooks land on the shared system_webhook_receiver
        // instance (src/server.ts interception), but drafts live in
        // per-user instances — the previous code ran the UPDATE against
        // this instance's store, matched 0 rows for every real draft,
        // and still returned { received: true }. Resolution order:
        //   1. a settlement hop (SETTLEMENT_OWNER_HEADER, set only by
        //      the forwarding instance below) settles here only when it
        //      names THIS instance; anything else is a misroute and is
        //      refused loud — an instance never settles on another
        //      tenant's behalf;
        //   2. a draft row in THIS store is owned by possession and
        //      settles here;
        //   3. otherwise the draft-owner registry (written by every
        //      create path — src/payments/draftOwners.ts) names the
        //      owner, and the verified webhook is forwarded to it.
        // A settlement that matches no draft is LOUD (error response +
        // payment.settled_webhook_unmatched audit + console.error),
        // never a silent { received: true }.
        const auditUnmatched = (reason: string, status: number): Response => {
          console.error(
            `[payments] webhook settlement unmatched: draft=${draftId} provider=${provider} reason=${reason}`
          );
          ctx.audit("payment.settled_webhook_unmatched", "payments", {
            draftId,
            provider,
            reason,
            raw: body?.type || body?.event_type,
          });
          return Response.json(
            {
              received: false,
              settled: false,
              unmatched: true,
              draftId,
              error: `Settlement matched no draft (${reason})`,
            },
            { status }
          );
        };
        const settleHere = (): Response => {
          // #2360: existence probe + settle completion via
          // the ledger port (findById / completeById — the
          // same row, the same unguarded UPDATE).
          if (!ledger().findById(draftId)) return auditUnmatched("owner_row_missing", 404);
          ledger().completeById(draftId, now);
          ctx.audit("payment.settled_webhook", "payments", { draftId, provider, raw: body?.type || body?.event_type });
          return Response.json({ received: true, settled: true, draftId });
        };

        // Issue #2192 (native slice 0): a verified native
        // screener settlement is recorded + audited HERE and
        // nowhere else. Recognition is marker-gated (see
        // src/services/nativeWebhook.ts): only a Stripe
        // checkout.session.completed, paid, whose session
        // carries the native metadata marker takes this branch
        // — every existing draft falls through to the
        // settlement path below unchanged. This branch never
        // touches mas_transactions (native rows live in D1),
        // never forwards to a draft owner (native drafts have
        // no registry entry), and never delivers
        // payment_verified to any workflow — that wake-up
        // belongs to slice 1. Until then the arm records and
        // audits only; a settlement it cannot record (unbound
        // store, incomplete session metadata, store error)
        // is audited loud as native_unrecorded and still
        // returns received, because confirm-by-retrieve in
        // slice 1 — not this webhook — is the source of truth.
        if (isNativeScreenerDraft(body, draftId, provider)) {
          // Subscription drafts audit only: purchase recording
          // belongs to slice 2, and a sub- id is not a run.
          if (isNativeSubscriptionDraft(draftId)) {
            ctx.audit("payment.settled_webhook", "payments", {
              draftId,
              provider,
              native: true,
              kind: "subscription",
              raw: body?.type || body?.event_type,
            });
            return Response.json({
              received: true,
              settled: true,
              native: true,
              draftId,
              recorded: false,
              reason: "subscription draft; purchase recording belongs to slice 2",
            });
          }
          const auditNativeUnrecorded = (reason: string): Response => {
            console.error(
              `[payments] native webhook settlement unrecorded: draft=${draftId} reason=${reason}`
            );
            ctx.audit("payment.settled_webhook_native_unrecorded", "payments", {
              draftId,
              provider,
              native: true,
              reason,
              raw: body?.type || body?.event_type,
            });
            return Response.json({
              received: true,
              settled: true,
              native: true,
              draftId,
              recorded: false,
              reason,
            });
          };
          const mapped = nativeWebhookRecordInput(body);
          if ("error" in mapped) return auditNativeUnrecorded(mapped.error);
          const nativeAdapter = createNativeLedgerAdapter(ctx.env as { AGENT_DB?: unknown });
          if (!nativeAdapter) {
            return auditNativeUnrecorded("native ledger unbound (AGENT_DB)");
          }
          try {
            await ensureNativeLedgerSchema(nativeAdapter.db);
            const { row, duplicate } = await nativeAdapter.recordRow(mapped.input);
            ctx.audit("payment.settled_webhook", "payments", {
              draftId,
              provider,
              native: true,
              kind: "run",
              transactionId: row.id,
              duplicate,
              raw: body?.type || body?.event_type,
            });
            return Response.json({
              received: true,
              settled: true,
              native: true,
              draftId,
              recorded: true,
              duplicate,
            });
          } catch (err) {
            return auditNativeUnrecorded(err instanceof Error ? err.message : String(err));
          }
        }

        const routedOwner = request.headers.get(SETTLEMENT_OWNER_HEADER);
        if (routedOwner) {
          if (routedOwner !== sessionId) return auditUnmatched("misrouted", 502);
          return settleHere();
        }

        const localRow = ledger().findById(draftId);
        if (localRow) return settleHere();

        const owner = await resolveDraftOwner(ctx.env, draftId);
        if (!owner) return auditUnmatched("unknown_draft", 404);
        if (owner === sessionId) return settleHere();

        // Forward the verified webhook to the owning instance, which
        // re-verifies the signature and settles against its own store —
        // so the settlement and its audit event land in the owning
        // instance. The owner's response (settled, or loud-unmatched)
        // is propagated to the gateway unchanged.
        try {
          const ns = ctx.env.SEARCH_AGENT;
          const stub = ns.get(ns.idFromString(owner));
          const headers = new Headers(request.headers);
          headers.set(SETTLEMENT_OWNER_HEADER, owner);
          headers.delete("content-length");
          const targetUrl = new URL("/payments/webhook" + url.search, "https://agent.internal");
          return await stub.fetch(
            new Request(targetUrl, { method: "POST", headers, body: rawBody })
          );
        } catch (err) {
          console.error(
            `[payments] webhook settlement routing failed: draft=${draftId} owner=${owner}:`,
            err instanceof Error ? err.message : String(err)
          );
          return auditUnmatched("routing_unavailable", 502);
        }
      }

      return Response.json({ received: true });
    } catch {
      return Response.json({ received: false }, { status: 400 });
    }
  }

  return null;
}

