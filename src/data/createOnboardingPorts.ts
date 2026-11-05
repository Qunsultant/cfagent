/**
 * Issue #3256 — composition root for the onboarding state port.
 * This is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * type, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createOnboardingAdapter` returns null and callers keep their
 * fail direction — the onboarding routes fail closed with 503,
 * never a default state that looks like "not started everywhere".
 */
import {
  createD1OnboardingDb,
  D1OnboardingAdapter,
  type OnboardingDb,
} from "./d1OnboardingAdapter";
import type { OnboardingStateStore } from "./onboardingPorts";

/** Build the onboarding state adapter from Worker env, or null if unbound. */
export function createOnboardingAdapter(env: { AGENT_DB?: unknown }): D1OnboardingAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1OnboardingAdapter(createD1OnboardingDb(env.AGENT_DB as D1Database));
}

export type { OnboardingStateStore, OnboardingDb };
