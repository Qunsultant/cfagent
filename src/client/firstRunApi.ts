/**
 * Issue #2471 (program #2468, Phase 1) — first-run client API.
 *
 * Client-only: this module calls EXISTING routes and creates none.
 * - Identity/tier display: GET /api/payments/agentic/commercial/identity
 *   (the #2219 self-only endpoint). The browser sends the session
 *   cookie; this module NEVER sends an identity header and NEVER reads
 *   tier or tenant from a header or a localStorage claim — identity is
 *   the session, and the server is the authority on tier and tenant
 *   (the commercialApi precedent).
 * - Notification preferences: GET/POST
 *   /api/payments/agentic/commercial/lifecycle/preferences (the
 *   existing NotificationPreferencePort route). The POST forwards only
 *   digestEnabled/welcomeEnabled — that is the route's contract.
 *
 * Completion persistence: the preferences store CANNOT carry a
 * first-run flag — NotificationPreferences has only digestEnabled and
 * welcomeEnabled, and the POST route forwards only those two fields.
 * Adding a flag would require a server/port change, which this slice
 * forbids (zero server files by design, sequenced after #2221 lands).
 * Completion is therefore a per-user localStorage flag, keyed by the
 * server-derived login (never a shared key, never a claim). It
 * persists across sessions on the device; the honest limitation is
 * that a different device re-shows first-run until a server-side flag
 * exists — stated in the PR and the §15 report, not hidden. Marking
 * completion never writes a preference, so it cannot corrupt one.
 *
 * Error contract: every failure surfaces as FirstRunApiError with the
 * HTTP status and, when the outcome is coded, the outcome-catalog
 * code. errorMessageForStatus maps statuses to FIXED caller-facing
 * strings; server error bodies are never rendered — they can carry
 * internal detail. A coded error's message is the catalog's
 * businessMessage, resolved through the single resolver.
 *
 * Issue #3309 — the 202 async-job contract. All first-run calls go
 * through `apiFetch`, which honors the 202 contract (see
 * src/client/apiFetch.ts): a queued request answers 202 with a job
 * receipt and apiFetch polls the job until it completes. The
 * first-run POSTs (setup, onboarding state, notification
 * preferences) are queued by the HTTP-entry door — they are NOT on
 * the immediate/sync prefix list — so a raw fetch that assumes a 200
 * body deterministically throws on every load. `call`/`callAbsolute`
 * therefore never fetch directly, and a job-failed / job-timeout
 * outcome surfaces as a coded error, never the generic dialog text.
 *
 * Issue #3256 (sub-issue of #3241) — Signup → Trial onboarding flow.
 * The same contract extends to the new calls: setupAccount (POST
 * /api/platform/accounts/setup, idempotent, session-scoped), the
 * server-side onboarding state (GET/POST
 * /api/platform/onboarding/state), the live E*TRADE status (GET
 * /api/etrade/oauth/status), and the self account view (GET
 * /api/platform/accounts/self, the summary's subscription source).
 * None of these sends an identity header or a client-supplied
 * tenantId; the session cookie is the identity throughout.
 */
import { apiFetch, asyncJobErrorCode } from "./apiFetch";
import { codedMessage, resolveOutcome } from "../outcomes/outcomeAspects";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

/** The identity shape the #2219 self-only read endpoint returns. */
export interface PlatformIdentityView {
  userLogin: string;
  tenantId: string | null;
  hasAccount: boolean;
  tier: string;
  creditsUSD: number;
  includedRunsRemaining: number;
}

export interface NotificationPreferences {
  userId: string;
  tenantId: string;
  digestEnabled: boolean;
  welcomeEnabled: boolean;
  updatedAtMs: number;
}

export interface SavePreferencesInput {
  userId: string;
  tenantId: string;
  digestEnabled: boolean;
  welcomeEnabled: boolean;
}

/** One onboarding-state row, as the #3256 self-only routes return it. */
export interface OnboardingStateView {
  userLogin: string;
  tenantId: string | null;
  currentStep: number;
  completedAtMs: number | null;
  trialPlanId: string | null;
  trialStartedAtMs: number | null;
  updatedAtMs: number;
}

/** Caller-supplied save fields only — identity is never sent (the server stamps it). */
export interface SaveOnboardingStateInput {
  currentStep: number;
  completed?: boolean;
  trialPlanId?: string;
}

/** Live E*TRADE OAuth status: `authenticated` is the validity verdict. */
export interface ETradeStatusView {
  authenticated: boolean;
  environment?: string;
}

/** One subscription row as the self account view exposes it. */
export interface AccountSubscriptionView {
  id: string;
  planId: string;
  provider: string;
  providerStatus: string | null;
  status: string;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
}

/** The self account view: identity plus subscription rows (the summary's trial source). */
export interface AccountSelfView {
  identity: PlatformIdentityView;
  subscriptions: AccountSubscriptionView[];
  catalogueAvailable: boolean;
}

export class FirstRunApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code?: string) {
    super(
      code && resolveOutcome(code).entry
        ? codedMessage(code)
        : errorMessageForStatus(status),
    );
    this.status = status;
    this.code = code;
  }
}

/** Fixed caller-facing message per HTTP status. No server detail leaks. */
export function errorMessageForStatus(status: number): string {
  switch (status) {
    case 0:
      return "The service could not be reached. Check your connection and try again.";
    case 400:
      return "Some values are missing or invalid. Check the form and try again.";
    case 401:
      return "Sign in again to continue.";
    case 403:
      return "You do not have access to this.";
    case 404:
      return "This service is not deployed yet. Try again after the next release.";
    case 503:
      return "The service is temporarily unavailable. Try again later.";
    default:
      return "Something went wrong. Try again later.";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new FirstRunApiError(0);
  }
  if (!res.ok) {
    const data: unknown = await res.clone().json().catch(() => null);
    throw new FirstRunApiError(res.status, asyncJobErrorCode(res.status, data));
  }
  return (await res.json()) as T;
}

/** Same contract as call(), for routes outside the commercial BASE. */
async function callAbsolute<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new FirstRunApiError(0);
  }
  if (!res.ok) {
    const data: unknown = await res.clone().json().catch(() => null);
    throw new FirstRunApiError(res.status, asyncJobErrorCode(res.status, data));
  }
  return (await res.json()) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentity(value: unknown): PlatformIdentityView {
  if (!isRecord(value)) throw new FirstRunApiError(0);
  if (
    typeof value.userLogin !== "string" ||
    value.userLogin.length === 0 ||
    (value.tenantId !== null && typeof value.tenantId !== "string") ||
    typeof value.hasAccount !== "boolean" ||
    typeof value.tier !== "string" ||
    typeof value.creditsUSD !== "number" ||
    typeof value.includedRunsRemaining !== "number"
  ) {
    throw new FirstRunApiError(0);
  }
  return {
    userLogin: value.userLogin,
    tenantId: value.tenantId as string | null,
    hasAccount: value.hasAccount,
    tier: value.tier,
    creditsUSD: value.creditsUSD,
    includedRunsRemaining: value.includedRunsRemaining,
  };
}

function parsePreferences(value: unknown): NotificationPreferences {
  if (!isRecord(value)) throw new FirstRunApiError(0);
  const prefs = value.preferences;
  if (!isRecord(prefs)) throw new FirstRunApiError(0);
  if (
    typeof prefs.userId !== "string" ||
    typeof prefs.tenantId !== "string" ||
    typeof prefs.digestEnabled !== "boolean" ||
    typeof prefs.welcomeEnabled !== "boolean" ||
    typeof prefs.updatedAtMs !== "number"
  ) {
    throw new FirstRunApiError(0);
  }
  return {
    userId: prefs.userId,
    tenantId: prefs.tenantId,
    digestEnabled: prefs.digestEnabled,
    welcomeEnabled: prefs.welcomeEnabled,
    updatedAtMs: prefs.updatedAtMs,
  };
}

/** Read-only identity + tier for the first-run account step (#2219). */
export async function fetchPlatformIdentity(): Promise<PlatformIdentityView> {
  return parseIdentity(await call<unknown>("/identity"));
}

function parseOnboardingState(value: unknown): OnboardingStateView | null {
  if (!isRecord(value)) throw new FirstRunApiError(0);
  // The routes return the row under a `state` envelope; a null
  // envelope value means the flow never started.
  const state = "state" in value ? value.state : value;
  if (state === null) return null;
  if (!isRecord(state)) throw new FirstRunApiError(0);
  if (
    typeof state.userLogin !== "string" ||
    state.userLogin.length === 0 ||
    (state.tenantId !== null && typeof state.tenantId !== "string") ||
    typeof state.currentStep !== "number" ||
    !Number.isInteger(state.currentStep) ||
    state.currentStep < 1 ||
    state.currentStep > 5 ||
    (state.completedAtMs !== null && typeof state.completedAtMs !== "number") ||
    (state.trialPlanId !== null && typeof state.trialPlanId !== "string") ||
    (state.trialStartedAtMs !== null && typeof state.trialStartedAtMs !== "number") ||
    typeof state.updatedAtMs !== "number"
  ) {
    throw new FirstRunApiError(0);
  }
  return {
    userLogin: state.userLogin,
    tenantId: state.tenantId as string | null,
    currentStep: state.currentStep,
    completedAtMs: state.completedAtMs as number | null,
    trialPlanId: state.trialPlanId as string | null,
    trialStartedAtMs: state.trialStartedAtMs as number | null,
    updatedAtMs: state.updatedAtMs,
  };
}

function parseETradeStatus(value: unknown): ETradeStatusView {
  if (!isRecord(value)) throw new FirstRunApiError(0);
  if (
    typeof value.authenticated !== "boolean" ||
    (value.environment !== undefined && typeof value.environment !== "string")
  ) {
    throw new FirstRunApiError(0);
  }
  return {
    authenticated: value.authenticated,
    environment: value.environment as string | undefined,
  };
}

function parseAccountSelf(value: unknown): AccountSelfView {
  if (!isRecord(value)) throw new FirstRunApiError(0);
  const identity = parseIdentity(value.identity);
  if (!Array.isArray(value.subscriptions)) throw new FirstRunApiError(0);
  const subscriptions: AccountSubscriptionView[] = value.subscriptions.map((row: unknown) => {
    if (!isRecord(row)) throw new FirstRunApiError(0);
    if (
      typeof row.id !== "string" ||
      typeof row.planId !== "string" ||
      typeof row.provider !== "string" ||
      (row.providerStatus !== null && typeof row.providerStatus !== "string") ||
      typeof row.status !== "string" ||
      typeof row.periodStartMs !== "number" ||
      typeof row.periodEndMs !== "number" ||
      (row.canceledAtMs !== null && typeof row.canceledAtMs !== "number")
    ) {
      throw new FirstRunApiError(0);
    }
    return {
      id: row.id,
      planId: row.planId,
      provider: row.provider,
      providerStatus: row.providerStatus as string | null,
      status: row.status,
      periodStartMs: row.periodStartMs,
      periodEndMs: row.periodEndMs,
      canceledAtMs: row.canceledAtMs as number | null,
    };
  });
  return {
    identity,
    subscriptions,
    catalogueAvailable: value.catalogueAvailable === true,
  };
}

/**
 * Create the account for the verified session (#3256 step 1).
 * Idempotent server-side: an existing account returns created
 * false. The session cookie is the identity; no identity header
 * and no client-supplied tenant are sent.
 */
export async function setupAccount(): Promise<{ created: boolean; identity: PlatformIdentityView }> {
  const body = await callAbsolute<unknown>("/api/platform/accounts/setup", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!isRecord(body) || typeof body.created !== "boolean") throw new FirstRunApiError(0);
  return { created: body.created, identity: parseIdentity(body.identity) };
}

/** Read the server-side onboarding state; null when the flow never started (#3256). */
export async function fetchOnboardingState(): Promise<OnboardingStateView | null> {
  return parseOnboardingState(await callAbsolute<unknown>("/api/platform/onboarding/state"));
}

/**
 * Save the onboarding step (and completion / trial plan). Only the
 * caller-supplied fields are sent — userLogin and tenantId are
 * stamped server-side from the verified session.
 */
export async function saveOnboardingState(
  input: SaveOnboardingStateInput,
): Promise<OnboardingStateView | null> {
  const body: Record<string, unknown> = { currentStep: input.currentStep };
  if (input.completed !== undefined) body.completed = input.completed;
  if (input.trialPlanId !== undefined) body.trialPlanId = input.trialPlanId;
  return parseOnboardingState(
    await callAbsolute<unknown>("/api/platform/onboarding/state", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

/** Live E*TRADE OAuth status for the verified session (#3256 step 3). */
export async function fetchETradeStatus(): Promise<ETradeStatusView> {
  return parseETradeStatus(await callAbsolute<unknown>("/api/etrade/oauth/status"));
}

/**
 * Navigate to the real E*TRADE OAuth start (#3256 step 3). The
 * caller persists the onboarding step first, so the flow resumes
 * at the saved step after the OAuth callback returns to the hub.
 */
export function startETradeOAuth(): void {
  globalThis.location.assign("/api/etrade/oauth/start?mode=redirect");
}

/** Self account view with subscription rows — the summary's trial source (#3256 step 5). */
export async function fetchAccountSelf(): Promise<AccountSelfView> {
  return parseAccountSelf(await callAbsolute<unknown>("/api/platform/accounts/self"));
}

/** Read notification preferences through the existing lifecycle route. */
export async function fetchNotificationPreferences(
  userId: string,
  tenantId: string,
): Promise<NotificationPreferences> {
  const query = `?userId=${encodeURIComponent(userId)}&tenantId=${encodeURIComponent(tenantId)}`;
  return parsePreferences(await call<unknown>(`/lifecycle/preferences${query}`));
}

/** Write notification preferences through the existing lifecycle route. */
export async function saveNotificationPreferences(
  input: SavePreferencesInput,
): Promise<NotificationPreferences> {
  return parsePreferences(
    await call<unknown>("/lifecycle/preferences", {
      method: "POST",
      body: JSON.stringify({
        userId: input.userId,
        tenantId: input.tenantId,
        digestEnabled: input.digestEnabled,
        welcomeEnabled: input.welcomeEnabled,
      }),
    }),
  );
}

// First-run completion -------------------------------------------------------

const STORAGE_PREFIX = "cfagent:first-run-complete:";

export function firstRunStorageKey(userLogin: string): string {
  return `${STORAGE_PREFIX}${userLogin}`;
}

/** True once this user completed first-run (per user, across sessions). */
export function isFirstRunComplete(userLogin: string): boolean {
  try {
    return globalThis.localStorage.getItem(firstRunStorageKey(userLogin)) === "1";
  } catch {
    // Storage unavailable (private mode): never claim completion — the
    // screen re-shows next login rather than silently dropping state.
    return false;
  }
}

/**
 * Persist first-run completion for this user. A storage failure is
 * logged, not swallowed silently, and the screen simply re-shows next
 * login — no preference or membership record is touched either way.
 */
export function markFirstRunComplete(userLogin: string): void {
  try {
    globalThis.localStorage.setItem(firstRunStorageKey(userLogin), "1");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("first-run completion could not be persisted", err);
  }
}
