/**
 * Issue #3261 — user profile client API (display name + phone).
 *
 * Client-only: this module calls the #3261 self-only routes and
 * creates none.
 * - Profile read/save: GET/POST /api/platform/accounts/profile
 *   (self-only, session-scoped). The browser sends the session
 *   cookie; this module NEVER sends an identity header and NEVER
 *   reads a login from a header or a claim — identity is the
 *   session, and the server is the authority.
 * - Error contract (AOP, #1969 program): every failure surfaces
 *   as ProfileApiError carrying the server's coded body ({code,
 *   message, field?}) — the panel renders the catalog
 *   businessMessage verbatim, never a hand-written variant and
 *   never the raw error field. An uncoded body (or a network
 *   failure) falls back to one fixed generic string per operation
 *   (the #2573 ACCOUNT_PANEL_FALLBACK_MESSAGE precedent).
 * - Idempotent Receiver (standards §7.2): every save carries an
 *   idempotencyKey the caller generates per save attempt. A 409
 *   FAILURE_PROFILE_DUPLICATE means the save already landed, so
 *   this module refetches the profile and returns it with the
 *   duplicate message instead of surfacing an error.
 * - Email: no field, no call. Email change needs CISO review
 *   first (#3261 comment 6681436382, refs #945).
 */
import { apiFetch, asyncJobErrorCode } from "./apiFetch";
import { codedMessage } from "../outcomes/outcomeAspects";

/** One user profile, as the #3261 self-only routes return it. */
export interface UserProfileView {
  userLogin: string;
  displayName: string | null;
  phone: string | null;
  updatedAtMs: number | null;
}

/** Caller-supplied save fields: null clears, absent leaves unchanged. */
export interface SaveProfileInput {
  displayName?: string | null;
  phone?: string | null;
}

/** A saved profile plus the server's coded outcome message. */
export interface SaveProfileResult {
  profile: UserProfileView;
  /** Coded businessMessage from the response (saved, or duplicate). */
  message: string;
  /** True when the save had already landed (409 replay). */
  duplicate: boolean;
}

/**
 * Display name for a profile (PROPOSED default, owner direction
 * 2026-11-06): an unset display name shows as the login.
 * Display-only — the fallback is never stored.
 */
export function displayNameFor(profile: UserProfileView): string {
  return profile.displayName ?? profile.userLogin;
}

/** One idempotency key per save attempt (standards §7.2). */
export function newIdempotencyKey(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** A coded profile failure: the server's code + message, verbatim. */
export class ProfileApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field?: "displayName" | "phone" | "idempotencyKey";

  constructor(message: string, code: string, status: number, field?: ProfileApiError["field"]) {
    super(message);
    this.name = "ProfileApiError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const LOAD_FALLBACK = "Your profile could not be loaded. Check your connection and try again.";
const SAVE_FALLBACK = "Your profile could not be saved. Try again later.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodedError(data: unknown): { code: string; message: string; field?: ProfileApiError["field"] } | null {
  if (!isRecord(data)) return null;
  if (typeof data.code !== "string" || data.code.length === 0) return null;
  if (typeof data.message !== "string" || data.message.length === 0) return null;
  const field =
    data.field === "displayName" || data.field === "phone" || data.field === "idempotencyKey"
      ? data.field
      : undefined;
  return { code: data.code, message: data.message, field };
}

function toProfileApiError(data: unknown, status: number, fallback: string): ProfileApiError {
  const coded = parseCodedError(data);
  if (coded) return new ProfileApiError(coded.message, coded.code, status, coded.field);
  // #3309: a polled async-job outcome (408 still processing / 500 job
  // failed) carries {error, jobId, ...} — the error string is transport
  // detail, never rendered; the coded catalog message is.
  const jobCode = asyncJobErrorCode(status, data);
  if (jobCode) return new ProfileApiError(codedMessage(jobCode), jobCode, status);
  return new ProfileApiError(fallback, "", status);
}

async function callRaw(
  path: string,
  init: RequestInit | undefined,
  fallback: string,
): Promise<{ status: number; data: unknown }> {
  // #3309: via apiFetch, which honors the 202 async-job contract —
  // the profile POST is queued by the HTTP-entry door, so a raw
  // fetch that assumes a 200 body deterministically throws.
  let res: Response;
  try {
    res = await apiFetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ProfileApiError(fallback, "", 0);
  }
  const data: unknown = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function parseUserProfile(value: unknown): UserProfileView {
  if (!isRecord(value)) throw new ProfileApiError(LOAD_FALLBACK, "", 0);
  if (
    typeof value.userLogin !== "string" ||
    value.userLogin.length === 0 ||
    (value.displayName !== null && typeof value.displayName !== "string") ||
    (value.phone !== null && typeof value.phone !== "string") ||
    (value.updatedAtMs !== null && typeof value.updatedAtMs !== "number")
  ) {
    throw new ProfileApiError(LOAD_FALLBACK, "", 0);
  }
  return {
    userLogin: value.userLogin,
    displayName: value.displayName as string | null,
    phone: value.phone as string | null,
    updatedAtMs: value.updatedAtMs as number | null,
  };
}

/** Read the caller's profile; nulls when no profile was ever set. */
export async function fetchProfile(): Promise<UserProfileView> {
  const { status, data } = await callRaw("/api/platform/accounts/profile", undefined, LOAD_FALLBACK);
  if (status !== 200) throw toProfileApiError(data, status, LOAD_FALLBACK);
  return parseUserProfile(data);
}

/**
 * Save profile fields. Only the keys sent change; null clears.
 * The idempotency key identifies this save attempt: the caller
 * reuses the same key when retrying the same attempt, and passes
 * a fresh key for a new attempt. A 409 replay refetches the
 * profile (the save already landed) instead of erroring.
 */
export async function saveProfile(
  input: SaveProfileInput,
  idempotencyKey: string,
): Promise<SaveProfileResult> {
  const body: Record<string, unknown> = { idempotencyKey };
  if (input.displayName !== undefined) body.displayName = input.displayName;
  if (input.phone !== undefined) body.phone = input.phone;
  const { status, data } = await callRaw(
    "/api/platform/accounts/profile",
    { method: "POST", body: JSON.stringify(body) },
    SAVE_FALLBACK,
  );
  if (status === 409) {
    const coded = parseCodedError(data);
    if (coded?.code === "FAILURE_PROFILE_DUPLICATE") {
      try {
        return { profile: await fetchProfile(), message: coded.message, duplicate: true };
      } catch {
        throw new ProfileApiError(coded.message, coded.code, status);
      }
    }
    throw toProfileApiError(data, status, SAVE_FALLBACK);
  }
  if (status !== 200) throw toProfileApiError(data, status, SAVE_FALLBACK);
  const message =
    isRecord(data) && typeof data.message === "string" && data.message.length > 0
      ? data.message
      : SAVE_FALLBACK;
  return { profile: parseUserProfile(data), message, duplicate: false };
}
