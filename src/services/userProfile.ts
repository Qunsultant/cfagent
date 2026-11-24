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
 * - email: 1–PROFILE_LIMITS.emailMaxLength chars after trimming;
 *   one @, non-empty local part, domain with at least one dot, no
 *   spaces or control characters. Null clears it; absent leaves it
 *   unchanged. CONTACT email only: it never changes the login and
 *   is never used for auth or recovery; no verification is claimed.
 *   Added owner-directed 2026-11-16, the CISO-review deferral
 *   lifted by explicit owner direction (no CISO review happened).
 * - idempotencyKey: NOT a profile field. The route extracts it
 *   separately (Idempotent Receiver, standards §7.2): a profile
 *   save without one is refused, and a replayed one is a 409.
 */
import type { UserProfile } from "../data/profilePorts";
import { PROFILE_LIMITS } from "../config/profileLimits";
import { profileInputSchema, validateRequestShape } from "../api/requestValidation";
import {
  effectiveProfileValue,
  idpFieldValue,
  type FieldProvenance,
  type ProfileFieldName,
} from "../security/idpAttributes";

/** A validated partial update: only keys the client sent. */
export type ValidatedProfileInput = {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
};

/** Structural failure: which field, and which kind — never a message. `body` names a body that is not a JSON object (#5604). */
export type ProfileValidationFailure = {
  field: "displayName" | "phone" | "email" | "body";
  kind: "wrongType" | "empty" | "tooLong" | "controlChars" | "badChars" | "noDigit" | "badFormat";
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

// One @, non-empty local part, domain with at least one dot, no
// whitespace. A pragmatic RFC 5322 subset for a contact address:
// it rejects the typos (missing @, missing domain, missing dot,
// spaces, double @) without pretending to be a full validator.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(value: unknown): FieldResult {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, failure: { field: "email", kind: "wrongType" } };
  }
  const trimmed = value.trim();
  if (trimmed.length < 1) {
    return { ok: false, failure: { field: "email", kind: "empty" } };
  }
  if (trimmed.length > PROFILE_LIMITS.emailMaxLength) {
    return { ok: false, failure: { field: "email", kind: "tooLong" } };
  }
  if (hasControlCharacter(trimmed)) {
    return { ok: false, failure: { field: "email", kind: "controlChars" } };
  }
  if (!EMAIL_SHAPE.test(trimmed)) {
    return { ok: false, failure: { field: "email", kind: "badFormat" } };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate a profile-update body. Returns only the keys the client
 * sent (absent = unchanged); unknown fields — including any
 * client-supplied userLogin or tenantId — are ignored. The first
 * invalid field fails the whole input (one field error per
 * response; the client marks that field).
 *
 * #5604 (G-4 slice 3): the shape gate runs first through the
 * shared helper (`profileInputSchema`, shape-only): a body that is
 * not an object (a scalar, or an array — previously a throw on the
 * `in` operator below, surfacing as a 500) fails as field `body`,
 * wrongType. The business rules below run on the RAW input, so a
 * field present with explicit `undefined` still fails wrongType
 * exactly as before (zod treats it as absent; JSON cannot carry
 * it, but direct callers are pinned). Previously-valid inputs
 * produce identical outcomes.
 */
export function validateProfileInput(body: unknown): ProfileValidationResult {
  // Absent input is no update, exactly as the `(body ?? {})` below
  // always treated null/undefined; only a present non-object body
  // fails the shape gate.
  if (body === null || body === undefined) return { ok: true, value: {} };
  const shape = validateRequestShape(profileInputSchema, body);
  if (!shape.ok) {
    const first = shape.issues[0]!;
    const field =
      first.field === "displayName" || first.field === "phone" || first.field === "email"
        ? first.field
        : "body";
    return { ok: false, failure: { field, kind: "wrongType" } };
  }
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
  if ("email" in input) {
    const checked = validateEmail(input.email);
    if (!checked.ok) return checked;
    validated.email = checked.value;
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
 *
 * #5604: a body that is not an object (a scalar — previously a
 * throw on the `in` operator below) reads as a missing key.
 */
export function extractIdempotencyKey(body: unknown): IdempotencyKeyResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, kind: "missing" };
  }
  const input = body as Record<string, unknown>;
  if (!("idempotencyKey" in input)) return { ok: false, kind: "missing" };
  const key = input.idempotencyKey;
  if (typeof key !== "string") return { ok: false, kind: "wrongType" };
  if (key.trim().length === 0) return { ok: false, kind: "missing" };
  return { ok: true, key: key.trim() };
}

/**
 * The profile shape the self-only read endpoint returns.
 *
 * #5160 — the view carries the EFFECTIVE values (user-edited
 * values where set, otherwise the provider value), so the client
 * pre-fills from the provider and only ever writes user
 * overrides. idpDisplayName/idpPhone/idpEmail are the raw
 * provider values (for the "From your provider" hints); diverged
 * names the fields whose user value hides a different provider
 * value. tenantId is the operating tenant this row belongs to.
 */
export interface UserProfileView {
  userLogin: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  updatedAtMs: number | null;
  tenantId: string | null;
  idpDisplayName: string | null;
  idpPhone: string | null;
  idpEmail: string | null;
  diverged: ProfileFieldName[];
  /** Per-field provenance as stored (the client renders the "From your provider" hints from this). */
  provenance: Record<string, FieldProvenance>;
}

/** Shape a stored row (or its absence) as the read view. */
export function toUserProfileView(
  userLogin: string,
  profile: UserProfile | null,
  tenantId?: string | null,
): UserProfileView {
  if (!profile) {
    return {
      userLogin,
      displayName: null,
      phone: null,
      email: null,
      updatedAtMs: null,
      tenantId: tenantId ?? null,
      idpDisplayName: null,
      idpPhone: null,
      idpEmail: null,
      diverged: [],
      provenance: {},
    };
  }
  const diverged: ProfileFieldName[] = [];
  for (const field of ["displayName", "phone", "email"] as const) {
    const prov = profile.provenance[field];
    if (prov?.source !== "user") continue;
    const idpValue = idpFieldValue(field, profile.idpAttributes);
    if (idpValue !== null && idpValue !== profile[field]) diverged.push(field);
  }
  return {
    userLogin: profile.userLogin,
    displayName: effectiveProfileValue(
      "displayName",
      profile.displayName,
      profile.provenance.displayName,
      profile.idpAttributes,
    ),
    phone: effectiveProfileValue(
      "phone",
      profile.phone,
      profile.provenance.phone,
      profile.idpAttributes,
    ),
    email: effectiveProfileValue(
      "email",
      profile.email,
      profile.provenance.email,
      profile.idpAttributes,
    ),
    updatedAtMs: profile.updatedAtMs,
    tenantId: profile.tenantId ?? tenantId ?? null,
    idpDisplayName: idpFieldValue("displayName", profile.idpAttributes),
    idpPhone: idpFieldValue("phone", profile.idpAttributes),
    idpEmail: idpFieldValue("email", profile.idpAttributes),
    diverged,
    provenance: { ...profile.provenance },
  };
}
