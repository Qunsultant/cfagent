/**
 * Issue #3256 — in-memory onboarding state store.
 *
 * A test double with the same port semantics as the D1 adapter. It
 * is NOT a production store and NOT a second source of truth — it
 * exists so the port contract is testable without any store at all,
 * and so route tests can run without a D1 binding. A read never
 * materializes a row.
 */
import type { OnboardingState, OnboardingStateStore } from "./onboardingPorts";

export class InMemoryOnboardingAdapter implements OnboardingStateStore {
  private rows = new Map<string, OnboardingState>();

  async getOnboardingState(userLogin: string): Promise<OnboardingState | null> {
    const row = this.rows.get(userLogin);
    return row ? { ...row } : null;
  }

  async saveOnboardingState(state: OnboardingState): Promise<OnboardingState> {
    const next = { ...state };
    this.rows.set(state.userLogin, next);
    return { ...next };
  }
}
