/**
 * PaymentWorkflow — the durable payment wrapper for screener runs
 * (#2014; live — status corrected 2026-11-01, #2551).
 *
 * Follows the repo pattern exactly (ADR 0004 W13):
 *   - extends ThinkWorkflow, NOT WorkflowEntrypoint
 *   - NO new payment agent. PaymentsAgent already exists
 *     (src/agents/payments-agent.ts, #1957, PortThink). This workflow
 *     does not create, extend, or replace it.
 *   - Agent-type parameter: `any`, following the
 *     ScreenerScreenWorkflow precedent, where tracking goes through
 *     D1 projection rows + instance status instead of the SDK's agent
 *     tracking. The workflow does not use this.agent; it delegates
 *     to the flow core, so `any` is the honest choice. (Settled
 *     as built; the draft-era open alternative is closed.)
 *   - OrchestratorAgent is a CALLER, not a base class. Like screener
 *     runs, the orchestrator triggers/creates this workflow instance
 *     and owns the store and deliver seams; this class is not an
 *     OrchestratorAgent subclass and does not extend it.
 *   - Money ops are step.do(), the human gate is waitForEvent
 *     approval before capture (backed by the #1262 approval engine
 *     in production wiring), never step.prompt(). A successful
 *     approval is audited (#2550): exactly one payment.approved
 *     event naming the approver, recorded in a journaled step
 *     before the verified-payment wait; the approved-at-submission
 *     path records payment.approved_at_submission naming its
 *     authorizing principal.
 *   - Thin adapter: run() validates the payload, builds deps from env,
 *     and delegates to runPaymentWorkflowFlow in paymentWorkflowFlow.ts
 *
 * OPERATIONAL STATUS (2026-11-01, #2551 — supersedes the
 * 2026-10-27 draft-era block, whose claims are stale):
 *   - Wrangler binding PAYMENT_WORKFLOW + Env type are live
 *     (wrangler.jsonc, src/types.ts), and routes and doors DO call
 *     this workflow: the submission seams
 *     (src/services/paidScreenSubmission.ts and
 *     src/services/paymentWorkflowSubmission.ts) serve the HTTP
 *     routes (src/agents/routes/agenticPayments.ts and
 *     screenerResearch.ts), the mesh paid door used by chat, and
 *     scheduled tasks. A route must NOT start a screener for free
 *     when monetization is on and the payment workflow cannot
 *     start.
 *   - Gate: NativeMonetizationGate (Stripe card + x402 via
 *     CheckoutPort), constructed by this adapter. x402 proof
 *     redemption is durable (#2548): confirm checks the
 *     proof-redemption store before paying and records the
 *     redemption on success, so a replayed proof is refused
 *     across instances and restarts. The cfpay gate is
 *     deprecated in place, superseded by the native gate (see
 *     src/services/cfpayMonetization.ts); no production route
 *     constructs it.
 *   - Flag: Flagship feature flag "monetization" (#2043), default OFF,
 *     fail-closed. When the FLAGS binding is present, Flagship is
 *     the source of truth: the flag must exist in the Flagship
 *     dashboard with key "monetization", and turning it ON/OFF
 *     there turns monetization ON/OFF — no code change, no env
 *     change. When FLAGS is absent, the env adapter evaluates it
 *     from FEATURE_FLAGS bulk JSON, FEATURE_MONETIZATION, or the
 *     legacy MONETIZATION_ENABLED var, and is otherwise OFF.
 *     Flag OFF in PROD would mean free runs at scale — a revenue
 *     risk, not a charge risk — so PROD enablement needs COO/CTO
 *     sign-off and explicit staging-only enablement first.
 *     Activation also depends on catalogue prices being
 *     approved: approval state is representable and enforced
 *     (#2547) — both gates resolve prices only through
 *     getApprovedPrice and refuse unapproved prices
 *     fail-closed; the approval itself is the operator act
 *     behind the CPO price-approval gate (#951/#1173).
 *   - Account: the subscription/credits store exists (#2015);
 *     the caller resolves the account from it by verified userId
 *     (paidScreenSubmission), and covered runs consume coverage
 *     from the store. Recurring scheduled runs are coverage-only.
 *   - Ledger: durable. Confirmed payments write deduped rows
 *     through the cfpay ledger service (mas_transactions), with
 *     a double-entry journal projection (#2155), and — since
 *     the #2192 gate→native-ledger follow-up — a confirmed
 *     native charge additionally records a best-effort native
 *     D1 ledger row via the flow's nativeLedger dep (a wiring
 *     failure never fails the payment). Failure credits write
 *     the cfpay credit row + D1 claim; a native credit row for
 *     them is a separate follow-up, not this slice. Nothing
 *     about the ledger is in-memory. (recordLedgerPayment is
 *     NOT reused because it builds x402 PaymentsAgent-origin
 *     rows only.)
 *   - Failure credit: IMPLEMENTED (#2019/#2015). A screener
 *     failure after payment issues exactly one replacement-run
 *     credit, deduped in the ledger and recorded as a D1 credit
 *     claim — automatic compensation is the credit, never cash
 *     (#2549). Cash refunds stand as a separate
 *     operator-initiated, approval-gated path, and a run that
 *     already received the failure credit is refused one
 *     (fail-closed XOR, #2549).
 *   - Params carry ids only — never credentials, never secrets, never
 *     a card, never a Stripe key or x402 recipient. Checkout
 *     configuration is read from env in the composition root
 *     (src/services/createCheckoutPorts.ts), never from params, never
 *     logged.
 */

import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import {
  NativeMonetizationGate,
  type NativeCommercialAccount,
  type NativeScreenerFamily,
} from "../services/nativeMonetization";
import { createCheckoutPorts } from "../services/createCheckoutPorts";
import {
  PAYMENT_VERIFICATION_TIMEOUT,
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowEvent,
  type PaymentWorkflowOutcome,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "./paymentWorkflowFlow";
import { recordWorkflowTraceHop } from "../observability/meshTrace";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { logAspectEvent } from "../aspects/loggingAspect";
import { meshTraceStoreForEnv } from "../data/createMeshTracePorts";
import {
  listCfpayLedgerRows,
  recordCfpayAuditEvent,
  recordCfpayLedgerRow,
  recordMeterUsageEvent,
  reconcileCfpayRun,
} from "../services/cfpayLedger";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../data/createCommercialPorts";
import {
  createPriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../data/createPriceCataloguePorts";
import {
  createProofRedemptionAdapter,
  ensureProofRedemptionSchema,
} from "../data/createProofRedemptionPorts";
import {
  createJournalAdapter,
  ensureJournalSchema,
} from "../data/createJournalPorts";
import {
  createNativeLedgerAdapter,
  ensureNativeLedgerSchema,
} from "../data/createNativeLedgerPorts";
import {
  createFreeRunCounterAdapter,
  ensureFreeRunCounterSchema,
} from "../data/createFreeRunCounterPorts";
import { createApprovedFreeQuotaAdapter } from "../data/createApprovedFreeQuotaPorts";
import {
  createRunsPackAdapters,
  ensureRunsPackSchema,
} from "../data/createRunsPackPorts";
import type { RunsPackBalancePort } from "../data/runsPackPorts";
import {
  createReferralCodeAdapters,
  ensureReferralCodeSchema,
} from "../data/createReferralCodePorts";
import type { CodeRunsBalancePort } from "../data/referralCodePorts";
import {
  mapChargeToJournalEntries,
  mapFailureCreditToJournalEntries,
} from "../data/journalPorts";
import { postJournalBestEffort } from "../services/journalPosting";
import { createFeatureFlagPort } from "../features/createFeatureFlagPort";
import { createWorkflowPorts, type WorkflowEnv } from "./createWorkflowPorts";
import type { WorkflowJobCommand } from "./workflowPorts";
import { createStageBoundaryEmitter } from "./stageBoundaryEmitter";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/paymentWorkflow",
});

export type { PaymentWorkflowParams, PaymentWorkflowOutcome };

/** Binding name for the payment workflow (wrangler.jsonc). */
export const PAYMENT_WORKFLOW_BINDING = "PAYMENT_WORKFLOW" as const;

/**
 * Payload for the workflow: ids + caller-supplied account + the
 * caller-built screener command. The account comes from the
 * subscription/credits store (#2015), resolved by the caller from
 * the verified userId — a Subscribed account must come from that
 * store, not from a caller snapshot. Recurring scheduled runs are
 * coverage-only (coverage_required when no coverage remains).
 * The screener command is built by the caller (route / schedule
 * service, e.g. buildGoalScreenCommand) — never invented here.
 */
export interface PaymentWorkflowEventParams extends PaymentWorkflowParams {
  account: NativeCommercialAccount;
  screenerCommand: WorkflowJobCommand;
}

/**
 * Issue #2762 (tracker #2708 A6, S17 #2428): the flow's traceHop
 * dep for one run, built from the run's payload — records each
 * completed step's hop from the params' traceparent into the
 * env-resolved hop store via the landed S17 mechanism
 * (recordWorkflowTraceHop over meshTraceStoreForEnv), agent
 * PaymentWorkflow, jobId = the run's runRequestId. Called by the
 * flow AFTER a step's journaled result returns, never inside a
 * step callback, so durable replay re-records the identical
 * deterministic span and the store converges. Params without a
 * traceparent record nothing (the helper's contract — never
 * minted mid-flight); a store failure is swallowed here:
 * tracing degrades, the payment does not (the #1743 rule).
 * Trace carriage is data only — it never branches the flow,
 * gates a charge, or alters a step input, and the #2550
 * approval audit and the #2547 price gate are untouched.
 */
export function paymentTraceHop(
  env: Env,
  p: {
    traceparent?: string;
    runRequestId: string;
    tenantId: string;
    userId: string;
  },
): NonNullable<PaymentWorkflowDeps["traceHop"]> {
  return async (event) => {
    try {
      await recordWorkflowTraceHop(
        meshTraceStoreForEnv(env),
        {
          traceparent: p.traceparent,
          jobId: p.runRequestId,
          tenantId: p.tenantId,
          userLogin: p.userId,
          agent: "PaymentWorkflow",
        },
        {
          kind: "workflow-step",
          operation: event.operation,
          ...(event.note ? { note: event.note } : {}),
        },
      );
    } catch {
      // Best-effort by design (the #1743 degradation rule).
    }
  };
}

export class PaymentWorkflow extends ThinkWorkflow<
  any,
  PaymentWorkflowEventParams,
  DefaultProgress,
  Env
> {
  async run(
    event: WorkflowEvent<PaymentWorkflowEventParams>,
    step: WorkflowStep,
  ): Promise<PaymentWorkflowOutcome> {
    const p = event.payload;
    // Issue #1185 discipline: no default identity, fail closed.
    if (!p.userId || !p.email || !p.tenantId) {
      throw new Error(
        "Payment workflow payload is missing verified userId, email, or tenantId (no default identity).",
      );
    }
    if (p.account.tenantId && p.tenantId !== p.account.tenantId) {
      throw new Error("Tenant mismatch: run tenant must equal the verified account tenant.");
    }

    // Issue #2193 (slice 1, #2146): the cfpay gate construction
    // that lived here is deprecated in place, superseded by
    // src/services/nativeMonetization.ts (NativeMonetizationGate +
    // CheckoutPort). The cfpay gate class itself is kept, deprecated
    // in place, for in-flight cfpay runs to drain: the gate is built
    // at workflow-instance start, so a running instance keeps its
    // gate to completion while new submissions use the native gate.
    // No cfpay client is constructed here anymore, and
    // MONETIZATION_NETWORK is no longer read for the gate (the
    // native crypto network is governed by X402_NETWORK inside the
    // x402 adapter). The durable cfpay ledger writes in recordEvent
    // below stay cfpay-era until the ledger slice lands; only the
    // gate — the checkout + confirm path — goes native here.
    const checkoutPorts = createCheckoutPorts(this.env as unknown as {
      STRIPE_SECRET_KEY?: string;
      STRIPE_TEST_SECRET_KEY?: string;
      STRIPE_LIVE_SECRET_KEY?: string;
      STRIPE_MCP_SERVER_URL?: string;
      APP_BASE_URL?: string;
      X402_RECIPIENT_ADDRESS?: string;
      X402_NETWORK?: string;
      X402_FACILITATOR_URL?: string;
    });
    if (!checkoutPorts && p.trigger !== "scheduled") {
      // A checkout path needs a configured native rail; coverage-only
      // scheduled runs do not. Fail closed rather than starting a
      // screener for free at scale.
      throw new Error("Payment workflow: native checkout is not configured (no Stripe key and no X402_RECIPIENT_ADDRESS).");
    }
    // Issue #2185: prices come from the operator catalogue port,
    // never from a code constant. When AGENT_DB is bound the
    // schema is ensured first (migration 0011 seeds the proposed
    // defaults on a fresh store, INSERT OR IGNORE so operator
    // edits survive). When it is unbound the catalogue is null
    // and the gate fails closed on price resolution — a money
    // path never charges without operator price data. The ensure
    // failure is loud for the same reason: a money path must not
    // proceed on an unverified store.
    const priceCatalogue = createPriceCatalogueAdapter(this.env as { AGENT_DB?: unknown });
    if (priceCatalogue) {
      await ensurePriceCatalogueSchema(priceCatalogue.db);
    }
    // #2548: the durable proof-redemption store, wired from the
    // same AGENT_DB binding. This gate instance is fresh for this
    // run (and confirm re-builds it after a durable resume), so
    // the store — not instance memory — is what makes a proof
    // redeem exactly once. Unbound AGENT_DB = no store, and the
    // gate keeps its in-memory guard only.
    const proofRedemptions = createProofRedemptionAdapter(this.env as { AGENT_DB?: unknown });
    if (proofRedemptions) {
      await ensureProofRedemptionSchema(proofRedemptions.db);
    }
    // Issue #3305: the free-run counter, wired from the same
    // AGENT_DB binding. Best-effort like the native ledger (not
    // fatal like the catalogue): a counter that cannot be ensured
    // leaves the gate exactly as today — no free runs, a Free
    // account falls through to the paid path — so a wiring
    // failure never fails a payment and never gives away free
    // runs.
    let freeRunCounter: Awaited<ReturnType<typeof createFreeRunCounterAdapter>> = null;
    try {
      const counter = createFreeRunCounterAdapter(this.env as { AGENT_DB?: unknown });
      if (counter) {
        await ensureFreeRunCounterSchema(counter.db);
        freeRunCounter = counter;
      }
    } catch (err) {
      console.error(
        `[payment-workflow] free-run counter unavailable for run ${p.runRequestId} — gate keeps today's paid behavior for Free accounts:`,
        err instanceof Error ? err.message : String(err),
      );
      freeRunCounter = null;
    }
    // Issue #3263: the approved-free per-service quota, wired from
    // the same AGENT_DB binding. Best-effort like the free-run
    // counter (not fatal like the catalogue): a quota adapter that
    // cannot be ensured leaves the gate exactly as today — a grant
    // account falls through to the normal gate (fail-closed: the
    // Free allowance at most, never an unverified unlimited run) —
    // so a wiring failure never fails a payment and never gives
    // away uncapped free runs.
    let approvedFreeQuota: Awaited<ReturnType<typeof createApprovedFreeQuotaAdapter>> = null;
    try {
      const quota = createApprovedFreeQuotaAdapter(this.env as { AGENT_DB?: unknown });
      if (quota) {
        // Port method, not a store handle: the adapter ensures its
        // own schema (Hexagonal, standards §7.1).
        await quota.ensureSchema();
        approvedFreeQuota = quota;
      }
    } catch (err) {
      // Issue #3263 (CI fix): structured aspect log, not a console call —
      // the #3515 ratchet pins this file's ceiling at 9 and the
      // slice's console call pushed it to 10.
      logAspectEvent({
        aspect: "ApprovedFreeQuota",
        operationName: "wire-quota",
        code: "FAILURE_APPROVED_FREE_QUOTA_UNAVAILABLE",
        level: "warn",
        message: `Approved-free quota unavailable for run ${p.runRequestId} — gate keeps today's behavior for grant accounts.`,
        error: err instanceof Error ? err.message : String(err),
        metadata: { runRequestId: p.runRequestId },
      });
      approvedFreeQuota = null;
    }
    // Issue #3246 slice 3: the runs-pack balance, wired from the
    // same AGENT_DB binding. Best-effort like the quota (not fatal
    // like the catalogue): a pack adapter that cannot be ensured
    // leaves the gate exactly as today — a pack balance simply
    // does not cover the run — so a wiring failure never fails a
    // payment and never grants an unverified pack run. No console
    // call here: the #3515 ratchet pins this file's ceiling at 9.
    let runsPackBalance: RunsPackBalancePort | null = null;
    try {
      const packs = createRunsPackAdapters(this.env as { AGENT_DB?: unknown });
      if (packs) {
        await ensureRunsPackSchema(packs.balance.db);
        runsPackBalance = packs.balance;
      }
    } catch (err) {
      logAspectEvent({
        aspect: "RunsPack",
        operationName: "wire-runs-pack-balance",
        code: "FAILURE_RUNS_PACK_UNAVAILABLE",
        level: "warn",
        message: `Runs-pack balance unavailable for run ${p.runRequestId} — gate keeps today's behavior (no pack coverage).`,
        error: err instanceof Error ? err.message : String(err),
        metadata: { runRequestId: p.runRequestId },
      });
      runsPackBalance = null;
    }
    // Issue #3307 slice 2: the code-runs balance, wired from the
    // same AGENT_DB binding. Best-effort like the pack balance
    // (not fatal like the catalogue): a code adapter that cannot
    // be ensured leaves the gate exactly as today — a code balance
    // simply does not cover the run — so a wiring failure never
    // fails a payment and never grants an unverified code run. No
    // console call here: the #3515 ratchet pins this file's
    // ceiling at 9.
    let codeRunsBalance: CodeRunsBalancePort | null = null;
    try {
      const codes = createReferralCodeAdapters(this.env as { AGENT_DB?: unknown });
      if (codes) {
        await ensureReferralCodeSchema(codes.rules.db);
        codeRunsBalance = codes.balances;
      }
    } catch (err) {
      logAspectEvent({
        aspect: "ReferralCode",
        operationName: "wire-code-runs-balance",
        code: "FAILURE_CODE_RUNS_UNAVAILABLE",
        level: "warn",
        message: `Code-runs balance unavailable for run ${p.runRequestId} — gate keeps today's behavior (no code coverage).`,
        error: err instanceof Error ? err.message : String(err),
        metadata: { runRequestId: p.runRequestId },
      });
      codeRunsBalance = null;
    }
    const gate = new NativeMonetizationGate(
      {
        // Flagship feature flag "monetization" (#2043): OFF = free
        // path (no checkout), ON = payment gate. Fail-closed: an
        // unknown flag, a missing Flagship binding value, or a
        // Flagship error all evaluate to false in the port.
        monetizationEnabled: await createFeatureFlagPort(this.env).isEnabled(
          "monetization",
          { userId: p.userId, userLogin: p.userId },
        ),
        priceCatalogue,
        proofRedemptions,
        freeRunCounter,
        approvedFreeQuota,
        runsPackBalance,
        codeRunsBalance,
        checkout: checkoutPorts,
      },
    );

    // Issue #2192 follow-up: the native ledger port for the flow's
    // best-effort charge-row step. Construction itself is
    // best-effort — an unbound AGENT_DB or a schema failure logs
    // loudly and leaves the dep null, so a wiring failure never
    // fails a payment (the flow's recordNativeLedgerBestEffort
    // swallows record failures the same way).
    let nativeLedger: Awaited<ReturnType<typeof createNativeLedgerAdapter>> = null;
    try {
      const adapter = createNativeLedgerAdapter(this.env as { AGENT_DB?: unknown });
      if (adapter) {
        await ensureNativeLedgerSchema(adapter.db);
        nativeLedger = adapter;
      }
    } catch (err) {
      console.error(
        `[payment-workflow] native ledger port unavailable for run ${p.runRequestId} — charge rows will be skipped, payment unaffected:`,
        err instanceof Error ? err.message : String(err),
      );
      nativeLedger = null;
    }

    const deps = {
      gate,
      account: p.account,
      nativeLedger,
      startScreener: async (params: PaymentWorkflowParams) => {
        // Operational: the caller-supplied screener command goes,
        // unchanged, through the existing screener workflow port
        // (CfWorkflowAdapter, idempotent start by jobId). If the port
        // is unavailable (SCREENER_WORKFLOW or AGENT_DB unbound),
        // fail LOUD — never fall back to a direct screen after
        // payment, which would lose the workflow audit trail.
        // The OrchestratorAgent remains the caller that built this
        // command and owns the store/deliver seams downstream.
        const ports = createWorkflowPorts(this.env as unknown as WorkflowEnv);
        if (!ports) {
          throw new Error(
            `Screener workflow port unavailable for run ${params.runRequestId}: SCREENER_WORKFLOW or AGENT_DB is unbound.`,
          );
        }
        const handle = await ports.start(p.screenerCommand);
        return { workflowId: handle.workflowId };
      },
      recordEvent: async (e: PaymentWorkflowEvent) => {
        // Issue #2019: the durable cfpay ledger + audit trail.
        //
        // A confirmed payment writes ONE mas_transactions row
        // (gateway stripe, action charge, session
        // screener-payment:<runId>) through the ledger owner's
        // record-cfpay endpoint, deduped per run so a retried step
        // can never double-record. The write FAILS LOUD: a payment
        // must never be recorded into the void, and the step retry
        // that follows is safe exactly because of the dedupe. The
        // read-back reconciliation after the write is best-effort
        // (logged, never thrown): the POST result is authoritative,
        // and a verification failure must not fail a paid run.
        //
        // Every event, including the confirmed payment, also appends
        // one mas_events audit row with the same run id, via the
        // audit endpoint. Audit is best-effort with a loud Workers
        // Logs fallback (mirroring the orchestrator's audit()): an
        // audit failure must never fail a paid run's workflow.
        if (e.type === "payment.confirmed") {
          if (e.priceUSD === undefined || !Number.isFinite(e.priceUSD) || e.priceUSD <= 0) {
            throw new Error(
              `Refusing to record a cfpay charge for run ${e.runRequestId} without a positive price.`,
            );
          }
          const { duplicate } = await recordCfpayLedgerRow(this.env, "charge", {
            runRequestId: e.runRequestId,
            userId: p.userId,
            family: p.family,
            priceUSD: e.priceUSD,
            checkoutId: e.checkoutId,
            claimTxHash: e.claimTxHash,
            paymentIntentId: e.paymentIntentId,
            // Issue #3182: the workflow's verified tenant, so the
            // ledger row is tenant-attributed at write time.
            tenantId: p.tenantId,
          });
          if (duplicate) {
            console.log(
              `[payment-workflow] charge row already exists for run=${e.runRequestId} (retried step, deduped)`,
            );
          }
          // Issue #2155: project the charge into the D1 double-entry
          // journal (Dr 1000 / Cr 4000). BEST-EFFORT, never thrown:
          // the DO row above is authoritative and already written;
          // a journal failure is a loud log + a reconcile flag, not
          // a failed payment. Replay is safe: postEntries is a
          // no-op for an already-posted transactionRef.
          // Issue #3289: per-charge recording (§3.9). The charge
          // journal entry needs the gate-check product/version; a
          // cfpay-era confirmation carries none (the draining
          // cfpay gate never resolved a version) — then the
          // journal entry is skipped with a loud log, and the DO
          // row above stays authoritative.
          if (e.productId && e.versionId) {
            await postJournalBestEffort(async () => {
              const adapter = createJournalAdapter(this.env as { AGENT_DB?: unknown });
              if (!adapter) return null;
              await ensureJournalSchema(adapter.db);
              return adapter;
            }, mapChargeToJournalEntries({
              transactionRef: e.runRequestId,
              tenantId: p.tenantId,
              runRequestId: e.runRequestId,
              family: p.family,
              amountUSD: e.priceUSD,
              productId: e.productId,
              versionId: e.versionId,
            }));
          } else {
            structuredLog.error("paymentWorkflow.chargeJournalSkipped", {
              message: `[payment-workflow] charge journal entry skipped for run=${e.runRequestId} (no product/version resolved — cfpay-era confirmation); DO row is authoritative.`,
              runRequestId: e.runRequestId,
            });
          }
          try {
            const rows = await listCfpayLedgerRows(this.env, e.runRequestId);
            const check = reconcileCfpayRun(rows, e.runRequestId, "fulfilled");
            if (!check.matched) {
              console.error(
                `[payment-workflow] ledger reconciliation mismatch for run=${e.runRequestId}: ${check.reasons.join("; ")}`,
              );
            }
          } catch (err) {
            console.error(
              `[payment-workflow] ledger read-back failed for run=${e.runRequestId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        await recordCfpayAuditEvent(this.env, { ...e, family: p.family });
      },
      issueFailureCredit: async (
        runRequestId: string,
        priceUSD: number,
        product?: { productId?: string; versionId?: string },
      ) => {
        // Issue #2019/#2015, combined: issuance writes BOTH records.
        // First the durable DO credit row (gateway stripe, action
        // credit, session screener-payment:<runId>), deduped per
        // run, FAIL-LOUD — the financial audit record must never
        // be recorded into the void. Then, best-effort with loud
        // logging, the D1 redeemable claim (same run id, carrying
        // family natively so redemption never needs an audit-payload
        // family join). A D1 failure must not turn a failed paid
        // run into a workflow error with no credit at all: the DO
        // row above is the operator's re-issue signal. No cash
        // moves here: this path issues the credit only (#2549 —
        // cash refunds are the operator-approved refund service's
        // path, never automatic, and never on top of this credit).
        if (!Number.isFinite(priceUSD) || priceUSD <= 0) {
          throw new Error(
            `Refusing to issue a failure credit for run ${runRequestId} without a positive price.`,
          );
        }
        await recordCfpayLedgerRow(this.env, "credit", {
          runRequestId,
          userId: p.userId,
          family: p.family,
          priceUSD,
          // Issue #3182: see the charge call above.
          tenantId: p.tenantId,
        });
        try {
          const adapter = createCommercialAdapter(this.env as { AGENT_DB?: unknown });
          if (!adapter) {
            console.error(
              `[payment-workflow] D1 credit-claim write skipped for run ${runRequestId} (AGENT_DB unbound); no redeemable claim recorded.`,
            );
            return;
          }
          await ensureCommercialSchema(adapter.db);
          await adapter.recordCreditClaim({
            creditRunId: runRequestId,
            userId: p.userId,
            family: p.family,
            amountUSD: priceUSD,
            // Issue #3289: per-charge recording (§3.9) — which
            // charge the credit replaces.
            productId: product?.productId ?? null,
            versionId: product?.versionId ?? null,
            priceUSD,
          });
        } catch (err) {
          console.error(
            `[payment-workflow] D1 credit-claim write failed for run ${runRequestId} — claim missing, operator must re-issue from the payment record:`,
            err,
          );
        }
        // Issue #2155: project the failure credit into the D1
        // journal (Dr 4000 / Cr 2000), BEST-EFFORT like the claim
        // above and independent of it: the DO credit row is the
        // trigger, and a journal failure never fails the credit.
        // Issue #3289: per-charge recording (§3.9) — the credit
        // carries the product/version of the charge it replaces;
        // without them the journal entry is skipped with a loud
        // log (cfpay-era / pre-0058 runs), never invented.
        if (product?.productId && product?.versionId) {
          await postJournalBestEffort(async () => {
            const adapter = createJournalAdapter(this.env as { AGENT_DB?: unknown });
            if (!adapter) return null;
            await ensureJournalSchema(adapter.db);
            return adapter;
          }, mapFailureCreditToJournalEntries({
            // Distinct from the charge's ref: a failed paid run has
            // BOTH a charge and a credit under one runRequestId, and
            // posting the credit under the charge's ref would be
            // swallowed as a replay (see journalPorts.ts).
            transactionRef: `${runRequestId}:credit`,
            tenantId: p.tenantId,
            runRequestId,
            family: p.family,
            amountUSD: priceUSD,
            productId: product.productId,
            versionId: product.versionId,
          }));
        } else {
          structuredLog.error("paymentWorkflow.failureCreditJournalSkipped", {
            message: `[payment-workflow] failure-credit journal entry skipped for run=${runRequestId} (no product/version resolved); DO credit row is authoritative.`,
            runRequestId,
          });
        }
      },
      consumeCoverage: async (use: { userId: string; paidVia: string; priceUSD: number }) => {
        // Issue #2015: consume the coverage in the D1 account store.
        // Best-effort with loud logging (see the flow dep doc): a
        // store blip must not deny a run the user already covered.
        // free_flag_off / already_paid consume nothing.
        try {
          const adapter = createCommercialAdapter(this.env as { AGENT_DB?: unknown });
          if (!adapter) {
            console.error(
              `[payment-workflow] coverage consumption skipped for user ${use.userId} (AGENT_DB unbound); balance must be reconciled by an operator.`,
            );
            return;
          }
          await ensureCommercialSchema(adapter.db);
          if (use.paidVia === "subscription_included") {
            await adapter.consumeIncludedRun(use.userId);
          } else if (use.paidVia === "code_runs") {
            // Issue #3307 slice 2: the code run was already spent
            // at gate-decision time (consumeCodeRun, applied-check)
            // — the workflow consumes nothing more here, exactly
            // like the runs-pack path. No journal entry: a code
            // run is a granted run, not a purchase.
          } else if (use.paidVia === "runs_pack") {
            // Issue #3246 slice 3: the pack run was already spent
            // at gate-decision time (consumePackRun, applied-check)
            // — the workflow consumes nothing more here, exactly
            // like the quota and free-run counter paths.
          } else if (use.paidVia === "credits") {
            await adapter.consumeCredits(use.userId, use.priceUSD);
          }
        } catch (err) {
          console.error(
            `[payment-workflow] coverage consumption failed for user ${use.userId} paidVia=${use.paidVia} — run proceeds, balance must be reconciled by an operator:`,
            err,
          );
        }
      },
      recordUsage: async (usage: {
        receiptId: string;
        protocol: "stripe" | "x402";
        userLogin: string;
        priceUSD: number;
      }) => {
        // #2041 G-METERING: endpoint-mediated meter write, same
        // ORCHESTRATOR_AGENT channel as the audit forwarder above
        // (workflows run in the Worker with no DO sql accessor).
        // THROWS on any failure (fail-closed) — unlike the
        // best-effort audit write, a meter failure must fail the
        // record-usage step so the run never completes unmetered.
        // The route dedupes on the receipt-scoped id, so a
        // retried step writes exactly one row.
        await recordMeterUsageEvent(this.env, usage);
      },
      // Issue #2762: step hops for this run under the params'
      // traceparent (see paymentTraceHop above). Observational
      // only; the flow calls it after each journaled step.
      traceHop: paymentTraceHop(this.env, p),
      // Issue #3073: one stage-boundary message per completed payment step, on
      // the shared #2869 seam. The emitter persists nothing itself: a completed
      // `step.do` IS the durable record the message references, so the publish
      // always happens after the artifact exists. A missing queue binding or a
      // rejected send degrades to a logged skip - never a failed payment.
      stageBoundary: createStageBoundaryEmitter({
        family: "payment",
        runId: p.runRequestId,
        userLogin: p.email,
        queue: (this.env as { SCREENER_EVENTS?: { send: (body: unknown) => Promise<unknown> } }).SCREENER_EVENTS,
      }),
    };

    if (!p.screenerCommand || typeof p.screenerCommand.jobId !== "string") {
      throw new Error("Payment workflow payload is missing a valid screenerCommand (jobId required).");
    }

    return runPaymentWorkflowFlow(
      {
        runRequestId: p.runRequestId,
        family: p.family as NativeScreenerFamily,
        trigger: p.trigger,
        scheduleKind: p.scheduleKind,
        authorizedAtSubmission: p.authorizedAtSubmission,
        tenantId: p.tenantId,
        userId: p.userId,
        email: p.email,
        screenerCommand: p.screenerCommand,
        // #2041 G-METERING: saga-only. PaymentWorkflowEventParams
        // inherits this optional field from PaymentWorkflowParams;
        // absent for every non-saga caller, so non-saga runs meter
        // nothing. The saga Leg 0 sets it (sagaWorkflowFlow.ts).
        meterContext: p.meterContext,
        // Issue #2762: the run's traceparent, stamped at the
        // submission seam from the screener command (see
        // buildPaymentWorkflowParams); absent → no step hops.
        traceparent: p.traceparent,
      },
      deps,
      step as unknown as PaymentWorkflowStep,
    );
  }
}

export { PAYMENT_VERIFICATION_TIMEOUT };
