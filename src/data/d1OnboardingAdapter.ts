/**
 * Issue #3256 — Drizzle D1 adapter for the onboarding state port.
 * This module is the ONLY place onboarding-state code touches a
 * store client: all SQL-adjacent code (the Drizzle query builder)
 * lives here, behind the port interface. Single statement ops only
 * (ADR 0002). A read never creates a row: an absent row reads as
 * null, and callers fall back to the per-user localStorage flag.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { agentOnboardingState } from "./drizzleSchema";
import type { OnboardingState, OnboardingStateStore } from "./onboardingPorts";

/** Drizzle D1 database object carrying the onboarding state table. */
export type OnboardingDb = DrizzleD1Database<{
  agentOnboardingState: typeof agentOnboardingState;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1OnboardingDb(d1: D1Database): OnboardingDb {
  return drizzle(d1, {
    schema: { agentOnboardingState },
  });
}

function toState(row: typeof agentOnboardingState.$inferSelect): OnboardingState {
  return {
    userLogin: row.userLogin,
    tenantId: row.tenantId,
    currentStep: row.currentStep,
    completedAtMs: row.completedAtMs,
    trialPlanId: row.trialPlanId,
    trialStartedAtMs: row.trialStartedAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

/** Onboarding state over D1 via Drizzle. */
export class D1OnboardingAdapter implements OnboardingStateStore {
  constructor(readonly db: OnboardingDb) {}

  async getOnboardingState(userLogin: string): Promise<OnboardingState | null> {
    const rows = await this.db
      .select()
      .from(agentOnboardingState)
      .where(eq(agentOnboardingState.userLogin, userLogin));
    if (rows.length === 0) return null;
    return toState(rows[0]);
  }

  async saveOnboardingState(state: OnboardingState): Promise<OnboardingState> {
    await this.db
      .insert(agentOnboardingState)
      .values({
        userLogin: state.userLogin,
        tenantId: state.tenantId,
        currentStep: state.currentStep,
        completedAtMs: state.completedAtMs,
        trialPlanId: state.trialPlanId,
        trialStartedAtMs: state.trialStartedAtMs,
        updatedAtMs: state.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentOnboardingState.userLogin,
        set: {
          tenantId: state.tenantId,
          currentStep: state.currentStep,
          completedAtMs: state.completedAtMs,
          trialPlanId: state.trialPlanId,
          trialStartedAtMs: state.trialStartedAtMs,
          updatedAtMs: state.updatedAtMs,
        },
      });
    return { ...state };
  }
}
