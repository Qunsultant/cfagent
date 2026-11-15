/**
 * Issue #4622 — per-payer quota for the premium options-scan and
 * market-research routes.
 *
 * Stock-signals already charges the #2842 per-user request quota. The other
 * two premium routes had no quota at all: the only inbound control was the
 * shared per-IP burst cap (and that only in `unified` ingress mode), so one
 * funded payer — or a runaway client loop — could hammer them with only a
 * per-call payment in the way.
 *
 * This module is the one gate for both routes. It does not add a counter:
 * it reuses `checkAndChargeUserRequestQuota` (the #2842 gate, windows and
 * store) with two new consuming kinds, partitioned by tenant + payer, so the
 * per-payer pool is the one the screens already use.
 *
 * Two halves, deliberately:
 *  - `premiumQuotaGate` is pure over an injected port — the testable half;
 *  - `chargePremiumQuota` is the production wiring (policy from env, tenant
 *    from the account store, port from the route's SQL handle).
 *
 * Fail closed on the store: a port throw refuses the request as
 * `quota unavailable` — the same posture stock-signals takes. Tenant
 * attribution is best effort and never a reason to refuse: the payer login is
 * the partition, and an unattributable payer is charged under the explicit
 * `unattributed` segment rather than turned away.
 */
import {
  checkAndChargeUserRequestQuota,
  quotaExceededDetails,
  resolveUserRequestQuota,
  UserRequestQuotaExceededError,
  type QuotaExceededDetails,
  type UserRequestQuotaPolicy,
} from "../security/userRequestQuota";
import type { UserRequestQuotaPort } from "../data/userRequestQuotaPorts";
import { createUserRequestQuotaPort } from "../data/createUserRequestQuotaPorts";
import type { Env } from "../types";
import type { SqlStorage } from "../orm";

/** The two premium capabilities this gate covers (the #2842 kinds). */
export const PREMIUM_QUOTA_KINDS = {
  optionsScan: "optionsScan",
  marketResearch: "marketResearch",
} as const;

export type PremiumQuotaKind = (typeof PREMIUM_QUOTA_KINDS)[keyof typeof PREMIUM_QUOTA_KINDS];

/**
 * Tenant segment used when the deployment cannot attribute a payer to an
 * account tenant. The payer login is still the partition that matters for
 * per-payer isolation; the tenant segment only separates one login's tenants.
 * Never a guessed tenant id.
 */
export const UNATTRIBUTED_PREMIUM_TENANT = "unattributed";

export type PremiumQuotaOutcome =
  | { ok: true; charged: boolean; usage: Record<string, number> }
  | { ok: false; code: "QUOTA_EXCEEDED"; details: QuotaExceededDetails | null }
  | { ok: false; code: "QUOTA_UNAVAILABLE"; reason: string };

/**
 * The pure gate: enforce-before-run over the injected port. No I/O of its
 * own, so the behavior is testable without a route or a database.
 */
export function premiumQuotaGate(input: {
  port: UserRequestQuotaPort;
  policy: UserRequestQuotaPolicy;
  tenantId: string;
  userLogin: string;
  kind: PremiumQuotaKind;
  runId: string;
  nowMs?: number;
}): PremiumQuotaOutcome {
  try {
    const outcome = checkAndChargeUserRequestQuota({
      port: input.port,
      policy: input.policy,
      tenantId: input.tenantId,
      userLogin: input.userLogin,
      kind: input.kind,
      runId: input.runId,
      nowMs: input.nowMs,
    });
    return {
      ok: true,
      charged: outcome.charged,
      usage: Object.fromEntries(
        Object.entries(outcome.usage).filter(([, v]) => typeof v === "number"),
      ) as Record<string, number>,
    };
  } catch (err) {
    if (err instanceof UserRequestQuotaExceededError) {
      return { ok: false, code: "QUOTA_EXCEEDED", details: quotaExceededDetails(err) };
    }
    return {
      ok: false,
      code: "QUOTA_UNAVAILABLE",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Production wiring: policy from env, the payer's tenant from the account
 * store, the port from the route's SQL handle, then the gate.
 */
export async function chargePremiumQuota(input: {
  env: Env;
  sql?: SqlStorage;
  userLogin: string;
  kind: PremiumQuotaKind;
  runId: string;
  nowMs?: number;
}): Promise<PremiumQuotaOutcome> {
  const policy = resolveUserRequestQuota(input.env);
  // A disabled policy is an explicit deployment choice; the gate reports
  // `skipped` and the request proceeds (the caller sees ok:true, charged:false).
  if (!policy.enabled) return { ok: true, charged: false, usage: {} };

  // A host with no storage handle cannot enforce a quota at all. Refusing
  // would take the endpoint down for a capability the host does not have, so
  // the request proceeds unenforced — stated here rather than pretended. Every
  // production host passes ctx.sql (the premium routes already use it for the
  // platform deps), so this branch is the storeless harness/host case only.
  if (!input.sql) {
    return { ok: true, charged: false, usage: {} };
  }
  const port = createUserRequestQuotaPort(input.sql);

  // Tenant attribution is best effort: the payer login is the per-payer
  // partition, so an unattributable request is still charged to that payer
  // under the explicit `unattributed` segment — never refused (a host without
  // the account store must still serve), and never attributed by a guess.
  let tenantId: string = UNATTRIBUTED_PREMIUM_TENANT;
  try {
    const { createCommercialAdapter, ensureCommercialSchema } = await import("../data/createCommercialPorts");
    const { resolveTickTenant } = await import("./paidScreenSubmission");
    const commercial = createCommercialAdapter(input.env as { AGENT_DB?: unknown });
    if (commercial) {
      await ensureCommercialSchema(commercial.db);
      const tenant = await resolveTickTenant(commercial, {
        userId: input.userLogin,
        env: input.env,
      });
      tenantId = tenant.tenantId ?? UNATTRIBUTED_PREMIUM_TENANT;
    }
  } catch {
    tenantId = UNATTRIBUTED_PREMIUM_TENANT;
  }

  return premiumQuotaGate({
    port,
    policy,
    tenantId,
    userLogin: input.userLogin,
    kind: input.kind,
    runId: input.runId,
    nowMs: input.nowMs,
  });
}

/**
 * The refusal body both premium routes return — the same shape the
 * stock-signals quota refusal already uses, so a client sees one contract
 * across the three paid services.
 */
export function premiumQuotaRefusalBody(outcome: Extract<PremiumQuotaOutcome, { ok: false }>): {
  error: string;
  retryable: boolean;
  limit: number | null;
  usage: number | null;
  window: string | null;
  resetAt: string | null;
  resetAtMs: number | null;
} {
  if (outcome.code === "QUOTA_EXCEEDED") {
    return {
      error: "Request quota exceeded.",
      retryable: true,
      limit: outcome.details?.limit ?? null,
      usage: outcome.details?.usage ?? null,
      window: outcome.details?.window ?? null,
      resetAt: outcome.details?.resetAtIso ?? null,
      resetAtMs: outcome.details?.resetAtMs ?? null,
    };
  }
  return {
    error: "Request quota unavailable.",
    retryable: true,
    limit: null,
    usage: null,
    window: null,
    resetAt: null,
    resetAtMs: null,
  };
}
