/**
 * Issue #3256 (sub-issue of #3241, program #2218) — server-side
 * onboarding state port.
 *
 * One row per verified login: where the user is in the Signup →
 * Trial onboarding flow, whether they finished it, and which trial
 * plan they started from the flow (if any). Keyed by login, never
 * by a client-supplied tenant: the tenantId is stamped server-side
 * from the resolved platform identity at write time.
 *
 * ADR 0002 port-first: domain code depends only on this interface.
 * Only the adapters (Drizzle D1, in-memory) touch a store, and only
 * the composition root (createOnboardingPorts.ts) maps a Worker
 * binding to an adapter. An absent row reads as null: no row means
 * the user never started the flow, and callers fall back to the
 * per-user localStorage completion flag (#2471).
 */
export interface OnboardingState {
  userLogin: string;
  tenantId: string | null;
  /** Current step, 1..5 (1 account, 2 trial, 3 brokerage, 4 preferences, 5 summary). */
  currentStep: number;
  completedAtMs: number | null;
  trialPlanId: string | null;
  trialStartedAtMs: number | null;
  updatedAtMs: number;
}

export interface OnboardingStateStore {
  /** The row for a login, or null when the user never started the flow. */
  getOnboardingState(userLogin: string): Promise<OnboardingState | null>;
  /** Upsert the row for its login and return it. */
  saveOnboardingState(state: OnboardingState): Promise<OnboardingState>;
}
