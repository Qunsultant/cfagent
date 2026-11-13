/**
 * Issue #2186 (slice 10, program #2012) — orchestrator paid-screen seam.
 *
 * Paid screens go gate → payment workflow → screener workflow. This module
 * is the caller-side seam the orchestrator's entries use; it does NOT start
 * a screener itself, and it never starts one for free when monetization is
 * on. The PaymentWorkflow (src/workflows/paymentWorkflow.ts) remains the
 * money path: it gate-checks internally via the STABLE gate interface
 * (check()/confirmPaid()), consumes coverage, and starts the screener
 * workflow itself when covered or paid. Depending only on that stable
 * interface here is what lets this seam survive the native gate swap
 * (#2146): no cfpay client, no checkout construction, and no ledger
 * access live in this file.
 *
 * Port-first (ADR 0002): the decision and account functions below depend
 * only on port interfaces (CommercialStore, SubscriptionStore) and on the
 * existing caller seam (paymentWorkflowSubmission.ts). No domain file here
 * imports a store client, references env.AGENT_DB, or writes SQL. Callers
 * build the ports from the composition roots (createCommercialAdapter,
 * createSubscriptionAdapter — null when unbound) and pass them in; an
 * unbound store fails closed in resolvePaidScreenAccount, never as a
 * free run.
 *
 * Scheduling rules (established, must hold):
 *   - A one-off scheduled run authorized at submission (scheduleKind
 *     "one_off" + authorizedAtSubmission) may checkout: it routes to the
 *     payment workflow, which skips its second approval wait for that
 *     submission approval.
 *   - A recurring scheduled run — or a scheduled run with unstated
 *     scheduleKind, which fails closed to recurring — uses subscription
 *     included usage or prepaid credits only, never an unattended
 *     card/x402 charge. Uncovered, it is SKIPPED, audited, and explained
 *     by the caller; no payment workflow instance is started for it.
 *     The ONE exception is an active unlimited-free grant (#3245):
 *     a grant-covered recurring run routes to the payment workflow
 *     and runs free at price 0, by owner direction.
 *   - Manual runs route to the payment workflow whenever monetization is
 *     on; the workflow itself resolves coverage vs checkout, so the
 *     caller needs no coverage pre-check for them.
 *
 * No double-start on retry: the PaymentWorkflow instance id IS the run
 * request id (buildPaidScreenSubmission carries runRequestId through to
 * buildPaymentWorkflowParams, and the binding start adopts an existing
 * instance for that id), so a retried submission never starts a second
 * screener or a second charge for the same run.
 */

import {
  type CommercialAccount,
  type ScheduleKind,
  type ScreenerFamily,
} from "./cfpayMonetization";
import {
  toCommercialAccount,
  type CommercialAccountRecord,
  type CommercialStore,
} from "../data/commercialPorts";
import {
  resolveEffectiveTier,
  type SubscriptionStore,
} from "../data/subscriptionPorts";
import { buildPaymentWorkflowParams } from "./paymentWorkflowSubmission";
import type { PaymentWorkflowEventParams } from "../workflows/paymentWorkflow";
import type { WorkflowJobCommand } from "../workflows/workflowPorts";
import type { Env } from "../types";

/**
 * The gate's coverage-required reason, mirrored here so the caller's skip
 * explanation and the gate's decision can never drift apart in wording.
 * The gate inside PaymentWorkflow remains authoritative for the run itself;
 * this string is only the caller-side explanation for a skip it already
 * decided from the store snapshot.
 */
export const SCHEDULED_COVERAGE_REQUIRED_REASON =
  "Scheduled runs need subscription included usage or prepaid credits. No unattended card charge is taken.";

/** How a scheduled run is covered, per the gate's coverage rule. */
export type PaidScreenCoverage = "subscription_included" | "credits" | "unlimited_free_grant" | null;

/**
 * Caller-side coverage read from a resolved account snapshot. Mirrors the
 * gate's rule exactly (an active unlimited-free grant first — #3245 — then
 * subscription included runs, then credits at or above price). The gate
 * re-checks inside the payment workflow, so a race between this read and
 * the workflow start can only ever resolve to a coverage_required outcome
 * there — never to a free run or a charge.
 */
export function coverageForAccount(
  account: CommercialAccount,
  priceUSD: number,
  nowMs: number = Date.now(),
): PaidScreenCoverage {
  if (
    account.unlimitedFreeGrant &&
    (account.unlimitedFreeGrant.expiresAtMs === null ||
      account.unlimitedFreeGrant.expiresAtMs > nowMs)
  ) {
    return "unlimited_free_grant";
  }
  if (account.tier === "Subscribed" && account.includedRunsRemaining > 0) {
    return "subscription_included";
  }
  if (account.creditsUSD >= priceUSD) {
    return "credits";
  }
  return null;
}

/** Routing decision for one paid-screen submission. */
export type PaidScreenAction =
  | { action: "free"; reason: string }
  | { action: "start_payment"; reason: string }
  | { action: "skip"; reason: string; priceUSD: number };

/**
 * Pure routing decision. Flag OFF → the existing free path, unchanged.
 * Manual + flag ON → always the payment workflow (it gate-checks
 * internally, so the caller never needs a coverage pre-check). Scheduled
 * + flag ON → covered runs go to the payment workflow; uncovered
 * recurring/unstated runs skip; one-off authorized runs go to the payment
 * workflow, which may checkout at submission.
 */
export function resolvePaidScreenAction(input: {
  monetizationOn: boolean;
  trigger: "manual" | "scheduled";
  scheduleKind?: ScheduleKind;
  authorizedAtSubmission?: boolean;
  coverage: PaidScreenCoverage;
  priceUSD: number;
}): PaidScreenAction {
  if (!input.monetizationOn) {
    return {
      action: "free",
      reason: "Monetization flag is OFF; the existing free path applies.",
    };
  }
  if (input.trigger === "manual") {
    return {
      action: "start_payment",
      reason:
        "Monetization is ON; the run goes through the payment workflow, which gate-checks (coverage first) and starts the screener when covered or paid.",
    };
  }
  const oneOffAuthorized =
    input.scheduleKind === "one_off" && input.authorizedAtSubmission === true;
  if (oneOffAuthorized) {
    return {
      action: "start_payment",
      reason:
        "One-off scheduled run authorized at submission; the payment workflow may checkout and starts the screener when paid.",
    };
  }
  if (input.coverage) {
    return {
      action: "start_payment",
      reason:
        input.coverage === "unlimited_free_grant"
          ? "Scheduled run covered by an active unlimited-free grant (#3245); the payment workflow re-checks the grant against its per-service quota (#3263) and starts the screener with no charge and no deduction within the quota — at the cap the workflow returns quota_exhausted instead of starting."
          : `Scheduled run covered by ${input.coverage}; the payment workflow re-checks, consumes coverage, and starts the screener.`,
    };
  }
  return {
    action: "skip",
    reason: SCHEDULED_COVERAGE_REQUIRED_REASON,
    priceUSD: input.priceUSD,
  };
}

/** Port inputs for account resolution (adapters satisfy these structurally). */
export interface PaidScreenStorePorts {
  commercial: CommercialStore | null;
  subscriptions: SubscriptionStore | null;
}

/**
 * Resolve the verified commercial account for a paid-screen submission,
 * mirroring the submit route's read: stored account + effective tier at
 * read time (a lapsed subscription stops covering even when the stored
 * tier still reads Subscribed). Fail-closed throughout: an unbound store
 * throws (no coverage can be verified), a tenant mismatch throws (no
 * cross-tenant billing), and a subscription-read failure throws (no run
 * starts on unverified coverage). A missing store row is a Free account
 * with no balance, never an error — Free is implicit.
 */
export async function resolvePaidScreenAccount(
  ports: PaidScreenStorePorts,
  input: { userId: string; email: string; tenantId: string; nowMs: number },
): Promise<{ account: CommercialAccount; stored: CommercialAccountRecord | null }> {
  if (!ports.commercial || !ports.subscriptions) {
    throw new Error(
      "Commercial account store is unavailable; refusing to route a paid screen without verified coverage.",
    );
  }
  const stored = await ports.commercial.getAccount(input.userId);
  if (stored && stored.tenantId !== input.tenantId) {
    throw new Error("Tenant mismatch: run tenant must equal the verified account tenant.");
  }
  let subscriptions: Array<{ periodEndMs: number }>;
  try {
    subscriptions = await ports.subscriptions.listSubscriptions(input.userId);
  } catch (err) {
    throw new Error(
      `Subscription state unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const effectiveTier = resolveEffectiveTier(stored, subscriptions, input.nowMs);
  return {
    account: {
      ...toCommercialAccount(input.userId, stored, input.email, input.tenantId),
      tier: effectiveTier,
    },
    stored,
  };
}

/** Result of tick-tenant resolution (issue #3179). */
export interface TickTenantResolution {
  /**
   * The tenant the tick runs under: the schedule owner's stored
   * account tenant, or the env default when no owner account row
   * exists (see usedEnvDefaultFallback).
   */
  tenantId: string;
  /**
   * True when no stored owner account row existed and the env
   * default was used instead. Callers MUST log this explicitly —
   * the fallback is never silent (#3179 scope).
   */
  usedEnvDefaultFallback: boolean;
}

/**
 * Issue #3179: resolve the tenant a scheduled tick runs under from
 * the schedule OWNER's stored commercial account row — never from
 * the deployment default. The schedule record carries ownerLogin
 * only (UnifiedScheduleRecord has no tenant field), so the owner
 * tenant is derived at tick time from the stored row and threaded
 * through the tick context by the caller.
 *
 * Fallback (issue scope, explicit and logged by the caller): a
 * schedule with NO owner account row — or an unbound store — runs
 * under the deployment default resolved by resolveIaaaTenant
 * (env IAAA_TENANT_ID, else "primary"), with
 * usedEnvDefaultFallback set. The fallback is the ONLY case in
 * which the env default stamps a tick; an owner row always wins,
 * so a mismatched-default deployment no longer fails owner ticks
 * closed on the mismatch throw in resolvePaidScreenAccount (that
 * guard is unchanged — it still throws when a caller passes a
 * tenant that differs from the stored row).
 *
 * A store READ failure propagates: the paid gates fail closed on
 * it (coverage unknown is not a skip), and the free path catches
 * it and falls back explicitly. The helper never invents a tenant
 * beyond the documented env default.
 */
export async function resolveTickTenant(
  commercial: CommercialStore | null,
  input: { userId: string; env: Partial<Env> | null | undefined },
): Promise<TickTenantResolution> {
  const stored = commercial ? await commercial.getAccount(input.userId) : null;
  if (stored) {
    return { tenantId: stored.tenantId, usedEnvDefaultFallback: false };
  }
  // No owner row (or no store): the explicit env-default fallback.
  // Lazy import matches the existing call-site pattern and keeps
  // the IAAA wiring layer out of this seam's static graph.
  const { resolveIaaaTenant } = await import("../security/iaaaGithubEndToEnd");
  return { tenantId: resolveIaaaTenant(input.env), usedEnvDefaultFallback: true };
}

/** Inputs to a paid-screen payment-workflow submission. */
export interface PaidScreenSubmissionInput {
  runRequestId: string;
  family: ScreenerFamily;
  trigger: "manual" | "scheduled";
  scheduleKind?: ScheduleKind;
  authorizedAtSubmission?: boolean;
  tenantId: string;
  userId: string;
  email: string;
  account: CommercialAccount;
  screenerCommand: WorkflowJobCommand;
}

/**
 * Build the payment-workflow params for one paid screen, via the existing
 * caller seam (tenant mismatch and missing identity still throw there).
 * The runRequestId becomes the payment workflow instance id, so a retried
 * submission adopts the existing instance instead of double-starting.
 */
export function buildPaidScreenSubmission(
  input: PaidScreenSubmissionInput,
): PaymentWorkflowEventParams {
  return buildPaymentWorkflowParams({
    runRequestId: input.runRequestId,
    family: input.family,
    trigger: input.trigger,
    scheduleKind: input.scheduleKind,
    authorizedAtSubmission: input.authorizedAtSubmission,
    tenantId: input.tenantId,
    userId: input.userId,
    email: input.email,
    account: input.account,
    screenerCommand: input.screenerCommand,
  });
}
