/**
 * Issue #3307 (sub-issue of #3241), slice 1 — composition root
 * for the referral-code ports. This is the ONLY module that maps
 * a Worker binding to a referral-code implementation: domain
 * code imports this helper and the port types, never a store
 * client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createReferralCodeAdapters` returns null and the route
 * answers 503 (codes are operator data, not a purchase — the
 * fail direction is "unavailable", never a silent pass). A
 * present-but-unreadable store fails at the call site, where
 * the route decides the direction.
 *
 * This slice builds NO #3247 state: it reads no free-access
 * table, port, or route, and it keeps working if #3247 never
 * lands.
 */
import {
  createD1ReferralCodeDb,
  D1CodeRedemptionAdapter,
  D1CodeRunsBalanceAdapter,
  D1ReferralCodeAdapter,
  D1ReferralCodeRuleAdapter,
  ensureReferralCodeSchema,
  type ReferralCodeDb,
} from "./d1ReferralCodeAdapter";
import type {
  CodeRedemptionStore,
  CodeRunsBalancePort,
  ReferralCodeRuleStore,
  ReferralCodeStore,
} from "./referralCodePorts";

/** The four referral-code adapters, built from one Drizzle D1 database object. */
export interface ReferralCodeAdapters {
  rules: D1ReferralCodeRuleAdapter;
  codes: D1ReferralCodeAdapter;
  redemptions: D1CodeRedemptionAdapter;
  balances: D1CodeRunsBalanceAdapter;
}

/** Build the referral-code adapters from Worker env, or null if unbound. */
export function createReferralCodeAdapters(env: { AGENT_DB?: unknown }): ReferralCodeAdapters | null {
  if (!env.AGENT_DB) return null;
  const db = createD1ReferralCodeDb(env.AGENT_DB as D1Database);
  return {
    rules: new D1ReferralCodeRuleAdapter(db),
    codes: new D1ReferralCodeAdapter(db),
    redemptions: new D1CodeRedemptionAdapter(db),
    balances: new D1CodeRunsBalanceAdapter(db),
  };
}

export { ensureReferralCodeSchema };
export type {
  CodeRedemptionStore,
  CodeRunsBalancePort,
  ReferralCodeDb,
  ReferralCodeRuleStore,
  ReferralCodeStore,
};
