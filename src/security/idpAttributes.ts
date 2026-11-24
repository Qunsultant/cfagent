/**
 * Issue #5160 — IDP attribute handling (pure).
 *
 * The raw userinfo/profile document a provider returns at sign-in
 * is sanitized here and nowhere else: token-ish keys are dropped,
 * the doc is capped (64 KB), and only JSON values survive. The
 * sanitized doc is what the profile store persists — tokens are
 * NEVER stored, and the session still carries no email / no token.
 *
 * Provenance: each stored field carries {source: 'idp'|'user',
 * updatedAtMs}. The three user-editable profile fields map to IDP
 * keys (displayName ← name, phone ← phone_number, email ←
 * email); every other IDP attribute is keyed by its own name.
 * The merge below is the refresh-vs-edit rule: a sign-in refresh
 * writes only IDP-sourced (or unset) fields and records a
 * divergence when a user-owned value hides a different provider
 * value. A user clearing a field wins — the refresh never re-fills
 * it — but the divergence is still recorded, so the Profile view
 * can offer the provider value back.
 */
import type { IdpProfileConfig } from "./idpProfileConfig";

/** Maximum serialized size of a sanitized IDP doc (64 KB). */
export const IDP_ATTRIBUTE_MAX_BYTES = 65536;

/** Profile field → the IDP attribute key that sources it. */
export const IDP_PROFILE_FIELD_KEYS: Record<"displayName" | "phone" | "email", string> = {
  displayName: "name",
  phone: "phone_number",
  email: "email",
};

/** IDP attribute key → the profile field it sources, if any. */
export function profileFieldForIdpKey(key: string): "displayName" | "phone" | "email" | null {
  if (key === "name") return "displayName";
  if (key === "phone_number") return "phone";
  if (key === "email") return "email";
  return null;
}

/** The three user-editable profile fields, in view order. */
export const PROFILE_FIELDS = ["displayName", "phone", "email"] as const;

/** One of the three user-editable profile fields. */
export type ProfileFieldName = (typeof PROFILE_FIELDS)[number];

const TOKENISH_EXACT = new Set([
  "access_token",
  "id_token",
  "refresh_token",
  "client_secret",
  "token",
  "client_assertion",
  "device_code",
  "authorization_code",
]);

function isTokenishKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (TOKENISH_EXACT.has(lower)) return true;
  if (lower.endsWith("_token")) return true;
  if (lower.includes("secret")) return true;
  return false;
}

/**
 * Recursively drop non-JSON values: a nested object keeps its
 * JSON leaves (a function-valued leaf is dropped, not the whole
 * object); an array keeps its JSON items. Returns undefined when
 * the value itself is not JSON (undefined, a function, a bigint,
 * a symbol, a non-finite number).
 */
function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const clean = sanitizeValue(item);
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const clean = sanitizeValue(v);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return undefined;
}

export type SanitizeResult =
  | { ok: true; attributes: Record<string, unknown> }
  | { ok: false; reason: "not-object" | "oversize" };

/**
 * Sanitize a raw IDP userinfo/profile document for storage.
 * Drops token-ish keys and non-JSON values, caps the serialized
 * size, and (when config excludes attributes) drops the excluded
 * keys. Fails closed on a non-object or oversize doc — the caller
 * skips the refresh and audits, never stores a partial doc.
 */
export function sanitizeIdpAttributes(
  raw: unknown,
  config?: Pick<IdpProfileConfig, "excludedAttributes">,
): SanitizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not-object" };
  }
  // The 64 KB cap is measured on the RAW document's JSON form, so
  // a document that cannot be stored whole is refused, never
  // truncated. A document with unserializable values (bigint,
  // function) cannot be measured raw — those values are dropped
  // by the cleaner below, so the cap is then measured on the
  // cleaned form instead.
  let rawSize: number | null = null;
  try {
    rawSize = JSON.stringify(raw).length;
  } catch {
    rawSize = null;
  }
  if (rawSize !== null && rawSize > IDP_ATTRIBUTE_MAX_BYTES) {
    return { ok: false, reason: "oversize" };
  }
  const excluded = new Set((config?.excludedAttributes ?? []).map((s) => s.toLowerCase()));
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isTokenishKey(key)) continue;
    if (excluded.has(key.toLowerCase())) continue;
    const clean = sanitizeValue(value);
    if (clean === undefined) continue;
    attributes[key] = clean;
  }
  if (rawSize === null && JSON.stringify(attributes).length > IDP_ATTRIBUTE_MAX_BYTES) {
    return { ok: false, reason: "oversize" };
  }
  return { ok: true, attributes };
}

/**
 * Normalize a lookup value for exact matching: email is
 * lowercased + trimmed; phone/phone_number keep digits only with
 * a leading + preserved; login is trimmed; other strings are
 * trimmed and stay case-sensitive.
 */
export function normalizeLookupValue(attributeName: string, value: string): string {
  const trimmed = value.trim();
  if (attributeName === "email") return trimmed.toLowerCase();
  if (attributeName === "phone" || attributeName === "phone_number") {
    const digits = trimmed.replace(/[^0-9]/g, "");
    return trimmed.startsWith("+") ? `+${digits}` : digits;
  }
  return trimmed;
}

export type FieldProvenance = { source: "idp" | "user"; updatedAtMs: number };

export interface IdpMergeResult {
  attributes: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
  /** IDP keys whose user-owned value hid a different incoming value. */
  diverged: string[];
  /** IDP-sourced keys dropped because the provider no longer sends them. */
  removed: string[];
}

/**
 * Merge an incoming sanitized IDP doc into the stored attributes.
 * Provenance is keyed by IDP attribute name here. Rules:
 * - provenance 'idp' or unset → write the incoming value.
 * - provenance 'user' → leave the stored value; record a
 *   divergence only when the incoming value differs from it.
 * - an IDP-sourced key absent from the incoming doc is dropped;
 *   a user-owned key absent from the incoming doc is kept.
 * Never throws; the caller treats a merge as a pure function.
 */
export function mergeIdpAttributes(
  current: Record<string, unknown>,
  currentProvenance: Record<string, FieldProvenance>,
  incoming: Record<string, unknown>,
  nowMs: number,
): IdpMergeResult {
  const attributes: Record<string, unknown> = {};
  const provenance: Record<string, FieldProvenance> = {};
  const diverged: string[] = [];
  const removed: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    const prov = currentProvenance[key];
    if (prov?.source === "user") {
      if (key in current) attributes[key] = current[key];
      provenance[key] = prov;
      if (current[key] !== value) diverged.push(key);
      continue;
    }
    attributes[key] = value;
    provenance[key] = { source: "idp", updatedAtMs: nowMs };
  }
  for (const [key, value] of Object.entries(current)) {
    if (key in incoming) continue;
    const prov = currentProvenance[key];
    if (prov?.source === "user") {
      attributes[key] = value;
      provenance[key] = prov;
      continue;
    }
    removed.push(key);
  }
  return { attributes, provenance, diverged, removed };
}

/** The IDP-sourced value for one profile field, or null. */
export function idpFieldValue(
  field: "displayName" | "phone" | "email",
  attributes: Record<string, unknown>,
): string | null {
  const raw = attributes[IDP_PROFILE_FIELD_KEYS[field]];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

/**
 * The effective value for one profile field: the user-edited value
 * when its provenance is 'user', else the IDP-sourced value, else
 * null. The login fallback for displayName is display-only and
 * lives in the view, never here.
 */
export function effectiveProfileValue(
  field: "displayName" | "phone" | "email",
  userValue: string | null,
  fieldProvenance: FieldProvenance | undefined,
  attributes: Record<string, unknown>,
): string | null {
  if (fieldProvenance?.source === "user") return userValue;
  return idpFieldValue(field, attributes);
}

/** Provenance keyed by IDP attribute name (the merge's convention). */
export function toIdpProvenance(
  provenance: Record<string, FieldProvenance>,
): Record<string, FieldProvenance> {
  const out: Record<string, FieldProvenance> = {};
  for (const [key, value] of Object.entries(provenance)) {
    if (key === "displayName") out.name = value;
    else if (key === "phone") out.phone_number = value;
    else out[key] = value;
  }
  return out;
}

/** Provenance keyed by profile field name (the stored convention). */
export function fromIdpProvenance(
  provenance: Record<string, FieldProvenance>,
): Record<string, FieldProvenance> {
  const out: Record<string, FieldProvenance> = {};
  for (const [key, value] of Object.entries(provenance)) {
    if (key === "name") out.displayName = value;
    else if (key === "phone_number") out.phone = value;
    else out[key] = value;
  }
  return out;
}

/**
 * Phone lookup candidates for one normalized phone value: the
 * number matches modulo the North American country code — a query
 * typed as 10 digits matches a stored +1 number and vice versa.
 * The index stores ONE normalized value per attribute; the lookup
 * tries this small candidate set against it. Non-phone values
 * have exactly one candidate (themselves).
 */
export function lookupCandidates(attributeName: string, normalizedValue: string): string[] {
  if (attributeName !== "phone" && attributeName !== "phone_number") {
    return [normalizedValue];
  }
  const candidates = new Set<string>([normalizedValue]);
  const digits = normalizedValue.replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    candidates.add(digits.slice(1));
    candidates.add(`+${digits}`);
  } else if (digits.length === 10) {
    candidates.add(`+1${digits}`);
    candidates.add(`1${digits}`);
  }
  if (normalizedValue.startsWith("+")) {
    const bare = normalizedValue.slice(1);
    if (bare.length === 11 && bare.startsWith("1")) candidates.add(bare.slice(1));
  }
  return [...candidates];
}

/** The stored row's refresh inputs (the adapter's row, minus keys). */
export interface StoredProfileRefreshInput {
  displayName: string | null;
  phone: string | null;
  email: string | null;
  idpAttributes: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
}

export interface StoredProfileRefreshResult {
  /** The provider's values, always — never a user value. */
  idpAttributes: Record<string, unknown>;
  /** Provenance keyed by profile field name (the stored convention). */
  provenance: Record<string, FieldProvenance>;
  /** Profile field names whose user-owned value hides a different provider value. */
  diverged: string[];
}

/**
 * The sign-in refresh over a stored row, shared by both adapters
 * (the two stores must refresh identically). The merge's `current`
 * is the EFFECTIVE map — a user-owned profile field carries the
 * user column value there, not the stored provider value — so the
 * merge leaves it alone and records the divergence. The stored
 * idpAttributes come back as the PROVIDER's values only: the three
 * profile-field keys are taken from the incoming doc (when the
 * provider still sends them), every other key from the merge
 * output. A provider-dropped profile field leaves the stored map
 * (there is no provider value to diverge from); the user value
 * in the column is untouched either way.
 */
export function refreshStoredProfile(
  current: StoredProfileRefreshInput,
  incoming: Record<string, unknown>,
  nowMs: number,
): StoredProfileRefreshResult {
  const effective: Record<string, unknown> = { ...current.idpAttributes };
  for (const field of PROFILE_FIELDS) {
    if (current.provenance[field]?.source === "user") {
      effective[IDP_PROFILE_FIELD_KEYS[field]] = current[field];
    }
  }
  const merged = mergeIdpAttributes(
    effective,
    toIdpProvenance(current.provenance),
    incoming,
    nowMs,
  );
  const idpAttributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged.attributes)) {
    if (profileFieldForIdpKey(key) !== null) continue;
    idpAttributes[key] = value;
  }
  for (const field of PROFILE_FIELDS) {
    const key = IDP_PROFILE_FIELD_KEYS[field];
    if (key in incoming) idpAttributes[key] = incoming[key];
  }
  const provenance = fromIdpProvenance(merged.provenance);
  const diverged: string[] = [];
  for (const field of PROFILE_FIELDS) {
    const prov = provenance[field];
    if (prov?.source !== "user") continue;
    const idpValue = idpFieldValue(field, idpAttributes);
    if (idpValue !== null && idpValue !== current[field]) diverged.push(field);
  }
  for (const idpKey of merged.diverged) {
    if (profileFieldForIdpKey(idpKey) === null) diverged.push(idpKey);
  }
  return { idpAttributes, provenance, diverged };
}
