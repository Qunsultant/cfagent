/**
 * x402 PaymentsAgent: budget enforcement + facilitator verification.
 *
 * Issue #896 (from the #785 audit): this Durable Object used to own a
 * SECOND payment ledger — one ctx.storage array (`payments`) plus a
 * serialized BudgetGuard blob (`budgetGuard`) — that no reader surface
 * could see and whose read-modify-write lost records under
 * concurrency. That blob ledger is retired as a system of record:
 *
 *   1. BudgetGuard state has a single home: it is DERIVED from
 *      mas_transactions (the ledger of record, owned by the
 *      OrchestratorAgent) on every check/record — see
 *      src/payments/ledger.ts for the attribution rules. Ledger spend
 *      (including agentic-payments micropayments) now moves the guard.
 *   2. processPaidRequest() validates via BudgetGuard (fail-closed),
 *      verifies via the x402 facilitator (fail-closed — issue #161),
 *      then records the payment INTO mas_transactions through the
 *      ledger owner's route. If the ledger cannot be reached it throws
 *      — a verified payment is never recorded into the void.
 *   3. Concurrency safety lives at the ledger owner: its duplicate
 *      check + insert are synchronous inside a single-threaded Durable
 *      Object, so concurrent calls cannot lose updates and a replayed
 *      idempotency key cannot slip past the facilitator await.
 *
 * Pre-existing blob data (the #785 audit found processPaidRequest had
 * no production caller, so the blob is expected empty) is migrated by
 * migrateLegacyLedger() — lossless and idempotent, and the blob keys
 * are deleted only after every record has landed in the ledger.
 */

import { PortThink } from "../actors/thinkAdapter";
import type { A2AAttribution } from "../a2a/meshCredentials";
import {
  dispatchPaymentsA2A,
  paymentsA2AOutcome,
  type PaymentsA2AOutcome,
} from "./payments/a2aDispatch";
import { BudgetGuard, type BudgetGuardState } from "../payments/budget-guard";
import {
  fetchLedgerBudgetState,
  listLedgerPayments,
  recordLedgerPayment,
  type PaymentRecord,
} from "../payments/ledger";

export type { PaymentRecord } from "../payments/ledger";

const GUARD_STORAGE_KEY = "budgetGuard";
const PAYMENTS_STORAGE_KEY = "payments";
/**
 * Operations the budget check permits. ScheduledAgent runs this check
 * for EVERY due goal before dispatch, so a goal operation missing
 * here is skipped every tick with "operation not allowlisted" — the
 * qa.run_sweep precedent (#1655). Exported for the #4411 pin: the
 * monthly Autopilot evaluation must pass the real guard, not a mock.
 */
export const GUARD_ALLOWLIST = [
  "search.query",
  "payments.draft",
  "tasks.create",
  "memory.remember",
  "nlq.execute",
  "qa.run_sweep",
  "search.opportunity_hunt",
  "social.publish",
  "pipeline:social-daily",
  // Issue #4411: the monthly Autopilot evaluation (dry-run only,
  // spends nothing, budgetCents 1) — without this entry the goal
  // would be skipped at every monthly tick.
  "autopilot.evaluate",
];

export class PaymentsAgent extends PortThink {
  // Issue #1957 (think-fleet, tracker #1951, shape (a)): this class
  // is a non-chat, RPC-only actor — it drives no turns, has no chat
  // hooks, and registers no scheduler callbacks — so the migration is
  // the base class alone. PortThink (Think extends Agent) keeps the
  // Durable Object surface, this.env, and this.ctx.storage identical;
  // portHooks is deliberately left unset: there were no port hooks to
  // keep, and a turn driven against this class would have no hooks
  // to run. All domain methods below are unchanged.
  /**
   * Load the BudgetGuard with enforcement state derived from the
   * ledger of record (mas_transactions). Throws when the ledger owner
   * is unreachable — callers fail closed (budgetCheck) or loud
   * (processPaidRequest); the guard NEVER falls back to a stale local
   * copy, because there is no local copy anymore.
   */
  private async getGuard(agentId: string): Promise<BudgetGuard> {
    const state = await fetchLedgerBudgetState(this.env, agentId);
    return BudgetGuard.restore({ allowlist: GUARD_ALLOWLIST }, state);
  }

  /** Total spent today across all agents, in cents — from the ledger. */
  async todaySpent(): Promise<number> {
    const state = await fetchLedgerBudgetState(this.env);
    return state.dailySpend.reduce((sum, [, , cents]) => sum + cents, 0);
  }

  /**
   * Budget check for a proposed operation. Used by ScheduledAgent
   * and Orchestrator before creating work. Fail-closed: any error
   * (including an unreachable ledger) returns { allowed: false }.
   * Pure: a check never records spend — only processPaidRequest()
   * records, after verification.
   *
   * The caller MUST name itself via agentId (issue #2327): the
   * check is evaluated against that agent's ledger-derived spend,
   * and a missing or blank identity is itself a fail-closed
   * denial — attribution is never defaulted. Callers that gate
   * orchestrator-attributed spend (ScheduledAgent) pass
   * AGENTIC_SPEND_AGENT_ID explicitly.
   */
  async budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    if (typeof req.agentId !== "string" || req.agentId.trim().length === 0) {
      return {
        allowed: false,
        reason:
          "budget check requires an explicit agentId (caller identity) — attribution is never defaulted (issue #2327)",
      };
    }
    const agentId = req.agentId;
    try {
      const guard = await this.getGuard(agentId);
      return guard.check({
        agentId,
        operation: req.operation,
        amountCents: req.amountCents,
        // Pre-flight checks are not payments: use an ephemeral key so a
        // mere check can never consume idempotency or budget.
        idempotencyKey: `check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
    } catch (err) {
      return {
        allowed: false,
        reason: `budget check error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Process a paid request: validate against ledger-derived budget
   * state, verify via facilitator, record in mas_transactions.
   * Fail-closed at every step; fail-LOUD if the verified payment
   * cannot be recorded in the ledger of record.
   */
  async processPaidRequest(req: {
    agentId: string;
    operation: string;
    amountCents: number;
    idempotencyKey: string;
    paymentProof: string;
    /**
     * Two-part attribution, part 2 (issue #2426): the edge-
     * authenticated A2A caller identity, threaded by the dispatch
     * from handleA2A's attribution argument. Recorded with the
     * payment's audit record beside the agentId (part 1). Absent
     * for non-A2A callers, where no edge attribution exists.
     */
    caller?: string;
    /**
     * Issue #2428 (Agent Mesh S17): the W3C trace id of the
     * caller's mesh trace, threaded by the dispatch from
     * handleA2A's traceparent argument. Recorded with the
     * payment's ledger write beside the caller, so the write
     * joins the trace. Absent for untraced callers.
     */
    traceId?: string;
  }): Promise<PaymentRecord> {
    // Issue #3923 (follow-on of #3741): the payments capability
    // requires `state` — on a fully ephemeral instance (state
    // disabled by config for this class) the work-start refuses
    // BY NAME before any guard or ledger work. This is the
    // class's single execution entry: handleA2A's dispatch
    // funnels through here, so both surfaces are covered.
    this.assertPortCapabilityServable("payments");
    const guard = await this.getGuard(req.agentId);
    const paymentReq = {
      agentId: req.agentId,
      operation: req.operation,
      amountCents: req.amountCents,
      idempotencyKey: req.idempotencyKey,
    };

    const budget = guard.check(paymentReq);
    if (!budget.allowed) {
      throw new Error(`Budget denied: ${budget.reason}`);
    }

    const verified = await this.verifyWithFacilitator(req.paymentProof);
    if (!verified) {
      throw new Error("Payment verification failed: facilitator rejected");
    }

    // Only now — validated AND verified — record the spend, in the
    // ledger of record. The record call is idempotent by idempotency
    // key at the (single-threaded) ledger owner: if a concurrent call
    // with the same key landed during the facilitator await, this is
    // a replay and is rejected as such, never double-recorded.
    const proof = parsePaymentProof(req.paymentProof);
    const { record, duplicate } = await recordLedgerPayment(this.env, {
      agentId: req.agentId,
      operation: req.operation,
      amountCents: req.amountCents,
      idempotencyKey: req.idempotencyKey,
      payer: proof?.payer,
      proofSignature: proof?.signature,
      ...(req.caller ? { caller: req.caller } : {}),
      ...(req.traceId ? { traceId: req.traceId } : {}),
    });
    if (duplicate) {
      throw new Error("duplicate idempotency key");
    }
    return record;
  }

  /**
   * Verify a payment proof via the x402 facilitator. Fail-closed:
   * malformed proofs, simulated proofs, facilitator rejections, and any
   * transport error all return false.
   *
   * Issue #161: the previous implementation was `proof.length > 0` — any
   * non-empty string passed as "verified". Simulated proofs (issue #122)
   * are rejected before any network call, matching
   * AgenticPaymentsService.verifyPayment: a locally produced proof is not
   * a payment and must never be redeemable.
   */
  private async verifyWithFacilitator(proof: string): Promise<boolean> {
    try {
      if (!proof || typeof proof !== "string" || proof.length === 0 || proof.length > 100_000) {
        return false;
      }

      // Parse: base64-encoded JSON (PAYMENT-SIGNATURE header) or raw JSON.
      let parsed: any = null;
      let parsedOk = false;
      try {
        parsed = JSON.parse(atob(proof));
        parsedOk = true;
      } catch {
        try {
          parsed = JSON.parse(proof);
          parsedOk = true;
        } catch {
          return false;
        }
      }
      if (!parsedOk || !parsed || typeof parsed !== "object") return false;
      if (parsed.simulated === true) return false;
      if (typeof parsed.signature !== "string" || parsed.signature.length === 0) return false;
      if (typeof parsed.payer !== "string" || parsed.payer.length === 0) return false;

      // Real facilitator verification (x402 /verify). Any non-approval —
      // HTTP error, transport failure, malformed response — denies.
      const facilitatorUrl = (
        this.env.CF_WALLET_FACILITATOR ||
        this.env.X402_FACILITATOR_URL ||
        "https://x402.org/facilitator"
      ).replace(/\/+$/, "");
      const res = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x402Version: 1, paymentPayload: parsed }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { isValid?: boolean } | null;
      return data?.isValid === true;
    } catch {
      return false;
    }
  }

  /** List recent payments (for UX ledger view) — read from the ledger of record. */
  async listPayments(limit: number = 50): Promise<PaymentRecord[]> {
    return listLedgerPayments(this.env, limit);
  }

  /**
   * Issue #2223 (payments slice): A2A door, cfpay signature — the
   * edge dispatcher (src/a2a) resolves the "payments" name to this
   * class on the URL-name instance and calls this with the parsed
   * body + origin (a Request cannot cross the DO RPC boundary).
   * Thin delegation to the dispatch module
   * (./payments/a2aDispatch), which serves this class's four real
   * operations; the bound methods are injected here because they
   * are class-bound. This class is instance-agnostic (all live
   * state derives from the ledger of record), so the URL-name
   * instance serves real data. Returns the collected { text, data }
   * outcome.
   *
   * Issue #2426: the edge passes its two-part attribution as the
   * third argument (the caller its credential authenticated + this
   * surface); the dispatch threads the caller into payments.process
   * so the recorded audit attribution names both parts. In-process
   * callers omit it and no caller part is recorded.
   */
  async handleA2A(
    body: unknown,
    origin: string,
    attribution?: A2AAttribution,
    traceparent?: string,
  ): Promise<PaymentsA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchPaymentsA2A(this.env, body, {
      executor: {
        budgetCheck: (req) => this.budgetCheck(req),
        todaySpent: () => this.todaySpent(),
        listPayments: (limit) => this.listPayments(limit),
        processPaidRequest: (req) => this.processPaidRequest(req),
      },
      ...(attribution ? { attribution } : {}),
      // Issue #2428 (Agent Mesh S17): the edge's mesh trace,
      // threaded beside the attribution so a payments.process
      // records its ledger write under the caller's trace.
      ...(traceparent ? { traceparent } : {}),
    });
    return paymentsA2AOutcome(data);
  }

  /**
   * Issue #896: one-time, idempotent migration of any pre-existing
   * blob-ledger data into mas_transactions. Every verified blob
   * record is recorded through the same ledger path as live traffic
   * (idempotent by idempotency key, original timestamps preserved);
   * the blob keys are deleted ONLY after every record has landed.
   * BudgetGuard blob keys with no corresponding record (spend the old
   * read-modify-write race clobbered) cannot be reconstructed as
   * payments — they are REPORTED in `orphanedGuardKeys`, never
   * silently discarded. Throws (blob untouched) if the ledger is
   * unreachable.
   */
  async migrateLegacyLedger(): Promise<{
    found: number;
    migrated: number;
    duplicates: number;
    orphanedGuardKeys: string[];
  }> {
    const legacy =
      (await this.ctx.storage.get<PaymentRecord[]>(PAYMENTS_STORAGE_KEY)) ?? [];
    const guardState =
      await this.ctx.storage.get<BudgetGuardState>(GUARD_STORAGE_KEY);

    let migrated = 0;
    let duplicates = 0;
    const recordKeys = new Set<string>();
    for (const rec of legacy) {
      if (!rec || typeof rec.idempotencyKey !== "string" || rec.idempotencyKey.length === 0) {
        throw new Error(
          "legacy blob contains a payment record without an idempotency key; refusing to migrate or discard it"
        );
      }
      recordKeys.add(rec.idempotencyKey);
      if (rec.status !== "verified") continue;
      const { duplicate } = await recordLedgerPayment(this.env, {
        agentId: rec.agentId,
        operation: rec.operation,
        amountCents: rec.amountCents,
        idempotencyKey: rec.idempotencyKey,
        createdAt: rec.timestamp,
      });
      if (duplicate) duplicates++;
      else migrated++;
    }

    const orphanedGuardKeys = (guardState?.seenKeys ?? []).filter(
      (k) => !recordKeys.has(k)
    );

    // Every record has landed (or was already there): retire the blob.
    if (legacy.length > 0) await this.ctx.storage.delete(PAYMENTS_STORAGE_KEY);
    if (guardState) await this.ctx.storage.delete(GUARD_STORAGE_KEY);

    return { found: legacy.length, migrated, duplicates, orphanedGuardKeys };
  }
}

/** Best-effort parse of a payment proof for ledger provenance fields. */
function parsePaymentProof(proof: string): { payer?: string; signature?: string } | null {
  try {
    let parsed: any;
    try {
      parsed = JSON.parse(atob(proof));
    } catch {
      parsed = JSON.parse(proof);
    }
    if (!parsed || typeof parsed !== "object") return null;
    return {
      payer: typeof parsed.payer === "string" ? parsed.payer : undefined,
      signature: typeof parsed.signature === "string" ? parsed.signature : undefined,
    };
  } catch {
    return null;
  }
}
