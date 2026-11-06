/**
 * Issue #3261 — user profile validation + view shaping (pure).
 *
 * No store access here: this module validates what a client may
 * ask to change and shapes what a read returns. The route handler
 * owns the store calls and the audit.
 *
 * AOP (#1969 program, #2573 precedent): classification is
 * STRUCTURAL. Validation never throws and never invents a message:
 * it returns a result union carrying the failing field and a
 * machine kind (wrongType/empty/tooLong/controlChars/badChars/
 * noDigit/missing). The route maps kind (+section) to the catalog
 * code FAILURE_PROFILE_VALIDATION and renders the catalog
 * businessMessage; the kind reaches logs only, never the client.
 * No raw `throw new Error(...)` in this module.
 *
 * Bounds live in config/profile-limits.json (PROFILE_LIMITS, the
 * single source of truth — session-limits.json precedent). The
 * phone character set is a validation RULE here, not a tunable
 * value, and stays in this module.
 *
 * Fields:
 * - displayName: 1–PROFILE_LIMITS.displayNameMaxLength chars after
 *   trimming, no control characters. Null clears it; absent leaves
 *   it unchanged. Unset displays as the login (PROPOSED default,
 *   display-only, never stored) — the view below carries null and
 *   the client renders the login.
 * - phone: 1–PROFILE_LIMITS.phoneMaxLength chars after trimming;
 *   digits, spaces, and + ( ) - . only; at least one digit. Null
 *   clears it; absent leaves it unchanged. UNVERIFIED contact
 *   field: never used for auth or recovery; no verification is
 *   claimed.
 * - email: NOT a field here at all. Email change touches IAAA /
 *   session / auth and needs CISO review first (#3261 comment
 *   6681436382, refs #945). A client-supplied email is ignored,
 *   never read, never stored.
 * - idempotencyKey: NOT a profile field. The route extracts it
 *   separately (Idempotent Receiver, standards §7.2): a profile
 *   save without one is refused, and a replayed one is a 409.
 */
import type { UserProfile } from "../data/profilePorts";
import { PROFILE_LIMITS } from "../config/profileLimits";

/** A validated partial update: only keys the client sent. */
export type ValidatedProfileInput = {
  displayName?: string | null;
  phone?: string | null;
};

/** Structural failure: which field, and which kind — never a message. */
export type ProfileValidationFailure = {
  field: "displayName" | "phone";
  kind: "wrongType" | "empty" | "tooLong" | "controlChars" | "badChars" | "noDigit";
};

export type ProfileValidationResult =
  | { ok: true; value: ValidatedProfileInput }
  | { ok: false; failure: ProfileValidationFailure };

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

type FieldResult =
  | { ok: true; value: string | null }
  | { ok: false; failure: ProfileValidationFailure };

function validateDisplayName(value: unknown): FieldResult {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, failure: { field: "displayName", kind: "wrongType" } };
  }
  const trimmed = value.trim();
  if (trimmed.length < 1) {
    return { ok: false, failure: { field: "displayName", kind: "empty" } };
  }
  if (trimmed.length > PROFILE_LIMITS.displayNameMaxLength) {
    return { ok: false, failure: { field: "displayName", kind: "tooLong" } };
  }
  if (hasControlCharacter(trimmed)) {
    return { ok: false, failure: { field: "displayName", kind: "controlChars" } };
  }
  return { ok: true, value: trimmed };
}

const PHONE_ALLOWED = /^[0-9+().\- ]+$/;

function validatePhone(value: unknown): FieldResult {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, failure: { field: "phone", kind: "wrongType" } };
  }
  const trimmed = value.trim();
  if (trimmed.length < 1) {
    return { ok: false, failure: { field: "phone", kind: "empty" } };
  }
  if (trimmed.length > PROFILE_LIMITS.phoneMaxLength) {
    return { ok: false, failure: { field: "phone", kind: "tooLong" } };
  }
  if (!PHONE_ALLOWED.test(trimmed)) {
    return { ok: false, failure: { field: "phone", kind: "badChars" } };
  }
  if (!/[0-9]/.test(trimmed)) {
    return { ok: false, failure: { field: "phone", kind: "noDigit" } };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate a profile-update body. Returns only the keys the client
 * sent (absent = unchanged); unknown fields — including any
 * client-supplied email, userLogin, or tenantId — are ignored.
 * The first invalid field fails the whole input (one field error
 * per response; the client marks that field).
 */
export function validateProfileInput(body: unknown): ProfileValidationResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const validated: ValidatedProfileInput = {};
  if ("displayName" in input) {
    const checked = validateDisplayName(input.displayName);
    if (!checked.ok) return checked;
    validated.displayName = checked.value;
  }
  if ("phone" in input) {
    const checked = validatePhone(input.phone);
    if (!checked.ok) return checked;
    validated.phone = checked.value;
  }
  return { ok: true, value: validated };
}

export type IdempotencyKeyResult =
  | { ok: true; key: string }
  | { ok: false; kind: "missing" | "wrongType" };

/**
 * Extract the idempotency key (standards §7.2 Idempotent Receiver):
 * a non-empty string the client generates per save attempt. Absent
 * or non-string is a structural failure, never a throw.
 */
export function extractIdempotencyKey(body: unknown): IdempotencyKeyResult {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!("idempotencyKey" in input)) return { ok: false, kind: "missing" };
  const key = input.idempotencyKey;
  if (typeof key !== "string") return { ok: false, kind: "wrongType" };
  if (key.trim().length === 0) return { ok: false, kind: "missing" };
  return { ok: true, key: key.trim() };
}

/** The profile shape the self-only read endpoint returns. */
export interface UserProfileView {
  userLogin: string;
  displayName: string | null;
  phone: string | null;
  updatedAtMs: number | null;
}

/** Shape a stored row (or its absence) as the read view. */
export function toUserProfileView(userLogin: string, profile: UserProfile | null): UserProfileView {
  if (!profile) {
    return { userLogin, displayName: null, phone: null, updatedAtMs: null };
  }
  return {
    userLogin: profile.userLogin,
    displayName: profile.displayName,
    phone: profile.phone,
    updatedAtMs: profile.updatedAtMs,
  };
}
