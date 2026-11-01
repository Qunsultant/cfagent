/**
 * CrossDomainSagaWorkflow — the durable cross-domain saga wrapper
 * for paid screener runs (issue #2041, S1).
 *
 * Follows the repo pattern exactly (ADR 0004 W13):
 *   - extends ThinkWorkflow, NOT WorkflowEntrypoint
 *   - agent-type parameter: `any`, following the ScreenerScreenWorkflow
 *     and PaymentWorkflow precedent. No Think agent exists for the
 *     saga in S1 (Q8 — a saga DO agent + A2A card is an open
 *     question); this class never uses agent tracking, so `any`
 *     is the honest choice today.
 *   - Thin adapter: run() validates the payload, builds deps from
 *     env, and delegates to runSagaWorkflowFlow in
 *     sagaWorkflowFlow.ts. The adapter is covered by typecheck,
 *     not by unit tests (same stance as the payment workflow).
 *
 * S2 scope: Leg 0 (payment child) + Leg 1 (observe the paid
 * screen to terminal) + Leg 2 (the journey gate after a completed
 * screen). S4 adds Leg 3 (the trading leg: proposeTrade via the
 * TRADING_AGENT stub's typed-RPC door + the trade child through
 * the leg port) + the outcome-notice dep (deliverNotice via
 * postSlackSagaOutcome, best-effort). The entry route is S4
 * (sagaEntry.ts); a route must NOT start a saga for free when
 * monetization is on.
 *
 * S3 adds the compensation deps (issueCredit, getRefundPorts,
 * monetizationEnabled) — see sagaCompensation.ts. The credit dep
 * mirrors the payment workflow's issueFailureCredit exactly
 * (endpoint-mediated DO ledger row, fail-loud, + best-effort D1
 * claim); like S1's audit forwarder it carries the same live-proof
 * caveat (unit-pinned; live proof is owner-side). The S4 deps
 * carry the same caveat: the proposeTrade RPC shape mirrors the
 * trade workflow's settleThroughApprovalDoor addressing, and
 * the notice post mirrors postSlackJourneyPrompt — both are
 * endpoint/RPC-mediated, throwing behavior unit-pinned only,
 * live proof pending an owner run; the workflow is uncalled in
 * prod until the entry route is reviewed, so no prod impact.
 *
 * S2 defaults (not rulings): goal-only first family (Q5 default);
 * workflow-only identity, no DO agent (Q8 open); journey wait
 * 24h (Q2 open); instance-owner-only gate answers (G-APPROVER
 * open, working default).
 * Q4 ruled 2026-11-01: no exclusion, mainnet is in scope — the
 * saga imposes no network restriction and never overrides the
 * payment leg's network; the payment leg's network policy governs.
 *
 * Audit: the recordAudit dep posts saga rows to POST /api/audit/event
 * through the SEARCH_AGENT stub (the same endpoint the payment
 * workflow's recordEvent uses), with agent "saga" for provenance.
 * It is the saga's OWN forwarder — recordCfpayAuditEvent is NOT
 * reused: it hardcodes agent "payments" and the cfpay payload
 * shape. The forwarder THROWS on any non-2xx response, on a
 * missing SEARCH_AGENT binding, or on a missing service identity,
 * so a failed audit write fails the step (durably retried) instead
 * of letting the saga complete with an unrecorded transition.
 * That is the Q7 S2 blocking shape as far as it is reachable
 * from a workflow step — see the reachability note in
 * sagaWorkflowFlow.ts for what is NOT reachable (direct ORM
 * access from the workflow runtime).
 *
 * Params carry ids + caller-supplied identity + the caller-built
 * screener command — never credentials, never secrets, never a
 * card, never a price. The saga never invents a screener command
 * or an account.
 */

import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import { getServiceUserLogin, SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import { recordCfpayLedgerRow } from "../services/cfpayLedger";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../data/createCommercialPorts";
import {
  createRefundPorts,
  ensureRefundSchema,
} from "../data/createRefundPorts";
import { createFeatureFlagPort } from "../features/createFeatureFlagPort";
import type { WorkflowBindingLike } from "./cfWorkflowAdapter";
import { sagaLegPort, type SagaLegBinding } from "./sagaLegPort";
import {
  editSlackJourneyPrompt,
  postSlackJourneyPrompt,
  type JourneyGatePrompt,
  type JourneyPromptReceipts,
} from "./sagaJourneyGate";
import {
  postSlackSagaOutcome,
  type SagaOutcomeNotice,
} from "./sagaOutcomeNotice";
import { tradingAgentName } from "../agents/trading-agent";
import type { SagaTradeIntent } from "./sagaTradeLeg";
import {
  runSagaWorkflowFlow,
  type SagaAuditEvent,
  type SagaParams,
  type SagaWorkflowStep,
} from "./sagaWorkflowFlow";

/** Wrangler binding name for the saga workflow (wrangler.jsonc). */
export const SAGA_WORKFLOW_BINDING = "SAGA_WORKFLOW";

interface SagaAuditStub {
  fetch: (req: Request) => Promise<Response>;
}

function sagaAuditStub(env: Env): SagaAuditStub {
  const ns = (env as unknown as Record<string, unknown>)?.SEARCH_AGENT as
    | { idFromName: (name: string) => unknown; get: (id: unknown) => SagaAuditStub }
    | undefined;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw new Error(
      "saga audit unavailable: SEARCH_AGENT (the mas_events audit owner) is not bound",
    );
  }
  return ns.get(ns.idFromName(SHARED_ORCHESTRATOR_INSTANCE));
}

/**
 * Blocking saga audit forwarder: POSTs one saga row and throws
 * unless the endpoint stored it. The endpoint funnels through
 * the single owner recordAudit() into the chained mas_events
 * repo, so a row that lands is hash-linked.
 */
async function recordSagaAudit(env: Env, event: SagaAuditEvent): Promise<void> {
  const stub = sagaAuditStub(env);
  // Issue #1185: the forward's identity is the configured service
  // identity — the instance constant above is only the address.
  const serviceLogin = getServiceUserLogin(env);
  if (!serviceLogin) {
    throw new Error(
      "saga audit unavailable: no service identity configured (SERVICE_USER_LOGIN) to forward under",
    );
  }
  let res: Response;
  try {
    res = await stub.fetch(
      new Request(new URL("/api/audit/event", "https://agent.internal"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-login": serviceLogin,
        },
        body: JSON.stringify({
          type: event.type,
          agent: "saga",
          payload: {
            sagaId: event.sagaId,
            runRequestId: event.runRequestId,
            tenantId: event.tenantId,
            userLogin: event.userLogin,
            family: event.family,
            ...(event.rail ? { rail: event.rail } : {}),
            ...(event.leg ? { leg: event.leg } : {}),
            ...(event.outcomeCode ? { outcomeCode: event.outcomeCode } : {}),
            ...(event.screenerWorkflowId ? { screenerWorkflowId: event.screenerWorkflowId } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
            ...(event.refusalReason ? { refusalReason: event.refusalReason } : {}),
            ...(event.existing !== undefined ? { existing: event.existing } : {}),
            ...(event.compensationForm ? { compensationForm: event.compensationForm } : {}),
            ...(event.refundId ? { refundId: event.refundId } : {}),
            ...(event.creditRunId ? { creditRunId: event.creditRunId } : {}),
            ...(event.fallbackReason ? { fallbackReason: event.fallbackReason } : {}),
            ...(event.paidAtMsSource ? { paidAtMsSource: event.paidAtMsSource } : {}),
            ...(event.decidingSurface ? { decidingSurface: event.decidingSurface } : {}),
            ...(event.decision ? { decision: event.decision } : {}),
            ...(event.withdraw ? { withdraw: event.withdraw } : {}),
            ...(event.orderId ? { orderId: event.orderId } : {}),
            ...(event.tradeWorkflowId ? { tradeWorkflowId: event.tradeWorkflowId } : {}),
            ...(event.disclosure ? { disclosure: event.disclosure } : {}),
            ...(event.notice ? { notice: event.notice } : {}),
          },
        }),
      }),
    );
  } catch (err) {
    throw new Error(
      `saga audit unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `saga audit write rejected by /api/audit/event (HTTP ${res.status}); refusing to continue unrecorded`,
    );
  }
}

function asWorkflowBinding(value: unknown): WorkflowBindingLike | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { create?: unknown }).create === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  ) {
    return value as WorkflowBindingLike;
  }
  return null;
}

/** Adapt the provider step to the flow's minimal step surface. */
function adaptStep(step: WorkflowStep): SagaWorkflowStep {
  const s = step as unknown as {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: string): Promise<void>;
    waitForEvent(
      name: string,
      options: { type: string; timeout?: string },
    ): Promise<{ payload: unknown }>;
  };
  return {
    do: (name, fn) => s.do(name, fn),
    // Provider sleep takes whole-second strings (no ms
    // label); ceiling to seconds. Poll granularity only —
    // deadlines are enforced by the flow's clock checks.
    sleep: (name, ms) => s.sleep(name, `${Math.max(1, Math.ceil(ms / 1000))} seconds`),
    waitForEvent: (name, options) => s.waitForEvent(name, options),
  };
}

export class CrossDomainSagaWorkflow extends ThinkWorkflow<any, SagaParams, DefaultProgress, Env> {
  async run(
    event: WorkflowEvent<SagaParams>,
    step: WorkflowStep,
  ): Promise<ReturnType<typeof runSagaWorkflowFlow>> {
    const params = event.payload;
    // Issue #1185 discipline: no default identity, fail closed.
    if (!params?.sagaId || !params?.runRequestId) {
      throw new Error("Saga payload is missing sagaId or runRequestId.");
    }
    if (!params.userLogin || !params.userId || !params.email || !params.tenantId) {
      throw new Error(
        "Saga payload is missing verified userLogin, userId, email, or tenantId (no default identity).",
      );
    }
    if (params.account?.tenantId && params.tenantId !== params.account.tenantId) {
      throw new Error("Tenant mismatch: saga tenant must equal the verified account tenant.");
    }
    if (params.family !== "goal") {
      throw new Error(
        `Saga is goal-only (Q5 default); family "${String(params.family)}" is not accepted yet.`,
      );
    }
    if (!params.screenerCommand || typeof params.screenerCommand.jobId !== "string" || !params.screenerCommand.jobId) {
      throw new Error("Saga payload is missing a valid screenerCommand (jobId required).");
    }

    const bindings: Partial<Record<SagaLegBinding, WorkflowBindingLike | undefined>> = {};
    const paymentBinding = asWorkflowBinding((this.env as Env).PAYMENT_WORKFLOW);
    if (paymentBinding) bindings["PAYMENT_WORKFLOW"] = paymentBinding;
    const screenerBinding = asWorkflowBinding((this.env as Env).SCREENER_WORKFLOW);
    if (screenerBinding) bindings["SCREENER_WORKFLOW"] = screenerBinding;
    const tradeBinding = asWorkflowBinding((this.env as Env).TRADE_WORKFLOW);
    if (tradeBinding) bindings["TRADE_WORKFLOW"] = tradeBinding;

    const deps = {
      legPort: sagaLegPort(bindings, params.sagaId),
      recordAudit: (auditEvent: SagaAuditEvent) => recordSagaAudit(this.env as Env, auditEvent),
      // Prompt delivery (S2): Slack post via the gate module;
      // panel and chat are state-driven off the prompted audit
      // row, so they need no prompt action here.
      deliverPrompts: (prompt: JourneyGatePrompt) =>
        postSlackJourneyPrompt(this.env as Env, prompt),
      // Withdrawal (S2): Slack edit-cleanup via the gate module;
      // panel/chat dismissal is state-driven (a decided gate is
      // no longer pending, so its card disappears on next poll).
      withdrawPrompts: (receipts: JourneyPromptReceipts) =>
        editSlackJourneyPrompt(
          this.env as Env,
          receipts,
          "Journey-gate prompt closed — this saga's journey decision is recorded or expired.",
        ),
      // S3 compensation deps (see sagaCompensation.ts). issueCredit
      // mirrors the payment workflow's issueFailureCredit exactly:
      // durable DO credit row first (fail-loud, endpoint-mediated
      // like the audit forwarder above), then the D1 redeemable
      // claim best-effort with loud logging. No cash moves.
      issueCredit: async (runRequestId: string, priceUSD: number) => {
        if (!Number.isFinite(priceUSD) || priceUSD <= 0) {
          throw new Error(
            `Refusing to issue a failure credit for run ${runRequestId} without a positive price.`,
          );
        }
        await recordCfpayLedgerRow(this.env as Env, "credit", {
          runRequestId,
          userId: params.userId,
          family: params.family,
          priceUSD,
        });
        try {
          const adapter = createCommercialAdapter(this.env as { AGENT_DB?: unknown });
          if (!adapter) {
            console.error(
              `[saga-workflow] D1 credit-claim write skipped for run ${runRequestId} (AGENT_DB unbound); no redeemable claim recorded.`,
            );
            return;
          }
          await ensureCommercialSchema(adapter.db);
          await adapter.recordCreditClaim({
            creditRunId: runRequestId,
            userId: params.userId,
            family: params.family,
            amountUSD: priceUSD,
          });
        } catch (err) {
          console.error(
            `[saga-workflow] D1 credit-claim write failed for run ${runRequestId} — claim missing, operator must re-issue from the payment record:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      },
      // Lazy refund ports: null when AGENT_DB is unbound, so the
      // compensation step falls back to credit (fail-closed).
      getRefundPorts: async () => {
        const ports = createRefundPorts(this.env as { AGENT_DB?: unknown });
        if (!ports) return null;
        await ensureRefundSchema(ports.store.db);
        return ports;
      },
      // Monetization flag, mirroring the operator refund route's
      // requireRefundFlag: flag OFF refuses the refund request
      // path (credit fallback), never the saga itself.
      monetizationEnabled: () =>
        createFeatureFlagPort(this.env as Env).isEnabled("monetization"),
      // S4 trading-leg proposal (see sagaTradeLeg.ts): the
      // typed-RPC door, same instance addressing as the trade
      // workflow's settleThroughApprovalDoor, so the draft lands
      // in the instance store the settle door threads. A missing
      // TRADING_AGENT binding THROWS (config failure, retried);
      // a service refusal returns ok:false with the error's
      // stable token (fallback "proposal_failed"). The service
      // result is preview-only by construction: trade_stock /
      // trade_options return {status: "pending_approval",
      // proposal: draft} and NEVER place an order.
      proposeTrade: async (intent: SagaTradeIntent) => {
        const ns = (this.env as Env).TRADING_AGENT;
        if (!ns) {
          throw new Error(
            "Saga trade proposal unavailable: TRADING_AGENT binding is not bound.",
          );
        }
        const stub = ns.get(
          ns.idFromName(
            tradingAgentName(params.userLogin, getServiceUserLogin(this.env as Env)),
          ),
        ) as unknown as {
          executeService: (call: {
            serviceId: string;
            userLogin: string;
            input: Record<string, unknown>;
          }) => Promise<unknown>;
        };
        const orderTypeMap: Record<string, string> = {
          market: "MARKET",
          limit: "LIMIT",
          stop: "STOP",
          stop_limit: "STOP_LIMIT",
        };
        try {
          const result = (await stub.executeService({
            serviceId:
              intent.kind === "options" ? "options_trading" : "stock_trading",
            userLogin: params.userLogin,
            input: {
              ...(intent.provider ? { provider: intent.provider } : {}),
              userLogin: params.userLogin,
              symbol: intent.symbol,
              action: intent.action === "sell" ? "SELL" : "BUY",
              quantity: intent.quantity,
              ...(intent.orderType && orderTypeMap[intent.orderType]
                ? { orderType: orderTypeMap[intent.orderType] }
                : {}),
              ...(intent.limitPrice !== undefined
                ? { limitPrice: intent.limitPrice }
                : {}),
              ...(intent.stopPrice !== undefined
                ? { stopPrice: intent.stopPrice }
                : {}),
              ...(intent.strategyNetDebit !== undefined
                ? { strategyNetDebit: intent.strategyNetDebit }
                : {}),
              ...(intent.optionLegs ? { optionLegs: intent.optionLegs } : {}),
            },
          })) as {
            status?: unknown;
            proposal?: { orderId?: unknown };
          } | null;
          if (
            result?.status === "pending_approval" &&
            typeof result.proposal?.orderId === "string"
          ) {
            return { ok: true as const, orderId: result.proposal.orderId };
          }
          return { ok: false as const, reason: "proposal_failed" };
        } catch (err) {
          const code = (err as { code?: unknown })?.code;
          return {
            ok: false as const,
            reason: typeof code === "string" && code ? code : "proposal_failed",
          };
        }
      },
      // S4 outcome notice (see sagaOutcomeNotice.ts): Slack post
      // mirroring postSlackJourneyPrompt, best-effort at the
      // adapter level too (a throw degrades to a failed receipt;
      // the flow also guards, so a notice failure never fails
      // the saga).
      deliverNotice: async (notice: SagaOutcomeNotice) => {
        try {
          return await postSlackSagaOutcome(notice, this.env as Env);
        } catch (err) {
          return {
            slack: "failed" as const,
            slackDetail: `Outcome notice delivery threw: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      nowMs: () => Date.now(),
    };
    return runSagaWorkflowFlow(params, deps, adaptStep(step));
  }
}
