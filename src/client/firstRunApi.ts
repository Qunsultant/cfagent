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
 * HTTP status. errorMessageForStatus maps statuses to FIXED
 * caller-facing strings; server error bodies are never rendered — they
 * can carry internal detail.
 */
import { withCsrfInit } from "./apiFetch";

const BASE = "/api/payments/agentic/commercial";

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

export class FirstRunApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(errorMessageForStatus(status));
    this.status = status;
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
    res = await globalThis.fetch(`${BASE}${path}`, withCsrfInit({
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    }));
  } catch {
    throw new FirstRunApiError(0);
  }
  if (!res.ok) throw new FirstRunApiError(res.status);
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
