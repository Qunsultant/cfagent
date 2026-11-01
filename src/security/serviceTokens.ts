import type { Env } from "../types";
import {
  ALL_ROLES,
  authorize,
  canGrantRole,
  createMemoryMembershipStore,
  type AuthorizationDecision,
  type MembershipStore,
  type Permission,
  type Role,
} from "./authorization";
import { createStoreKv, type DoNamespaceLike } from "./durableKv";
import { type KvLike } from "./kvResilience";

/**
 * Tenant-bound service tokens (issue #2681).
 *
 * A service token is a credential FOR a provisioned service identity
 * (src/security/serviceIdentity.ts), not a replacement for
 * provisioning: minting for an unprovisioned identity fails closed,
 * and revoking the identity's memberships implicitly invalidates its
 * tokens (verify re-reads memberships fresh on every use).
 *
 * Storage follows the sessions/E*TRADE/API-key pattern: records live
 * in the SessionStore Durable Object (bucket "service_tokens") via
 * createStoreKv — never Workers KV. Only the SHA-256 hash of a secret
 * is stored; the plaintext secret exists exactly once, in the mint /
 * rotate response. The module clones the apiKeys.ts template with the
 * two deliberate deviations #2681 requires: expiry is REQUIRED at
 * mint (API keys carry no expiry; service tokens never live forever),
 * and every token is bound to exactly one tier — platform, or one
 * tenant — re-checked on every verify, never taken from a request
 * header.
 *
 * Bucket layout (keys inside the "service_tokens" bucket):
 * - `token:<tokenId>` → JSON ServiceTokenRecord (includes the secret's hash)
 * - `hash:<sha256>`   → tokenId (lookup index used by verify)
 * - `subject:<serviceInternalUserId>` → JSON array of tokenIds
 * - `index:all`       → JSON array of tokenIds (admin list)
 *
 * Distinct credential, distinct store bucket, distinct audit type:
 * a service token is never aliased to QA_INVESTIGATE_TOKEN,
 * A2A_API_TOKEN, or a cfk_ API key, and none of those verifies here.
 */

export const SERVICE_TOKEN_PREFIX = "svc_";
const SECRET_RANDOM_BYTES = 32; // 256 bits of entropy per token
const TOKEN_ID_RANDOM_BYTES = 8;
const MAX_LABEL_LENGTH = 80;

export type ServiceTokenTier = "platform" | "tenant";

/** Public metadata for one token — never carries the secret or its hash. */
export interface ServiceTokenMetadata {
  id: string;
  label: string;
  /** Non-secret display prefix of the token, e.g. "svc_Ab3dEf7h". */
  prefix: string;
  serviceLogin: string;
  serviceInternalUserId: string;
  tier: ServiceTokenTier;
  /** Tenant the token is bound to. Null for platform tier. */
  tenantId: string | null;
  roles: Role[];
  expiresAtMs: number;
  revokedAtMs: number | null;
  createdBy: string;
  createdAtMs: number;
  lastUsedAtMs: number | null;
}

interface ServiceTokenRecord extends ServiceTokenMetadata {
  /** SHA-256 (hex) of the full secret. The secret itself is never stored. */
  hash: string;
}

/** A verified token: the identity a Bearer svc_ credential resolves to. */
export interface VerifiedServiceToken {
  tokenId: string;
  serviceLogin: string;
  serviceInternalUserId: string;
  tier: ServiceTokenTier;
  tenantId: string | null;
  roles: Role[];
  prefix: string;
}

export interface MintServiceTokenInput {
  label: string;
  tier: ServiceTokenTier;
  tenantId?: string;
  roles: Role[];
  /** Required: a token without an expiry is never minted. */
  expiresAtMs: number;
  serviceLogin: string;
  serviceInternalUserId: string;
  /** Internal id of the admin granting this token (canGrantRole granter). */
  createdBy: string;
}

const SECRET_PATTERN = /^svc_[A-Za-z0-9_-]{43}$/;
// Role validation uses the single catalog (ALL_ROLES) — never a
// re-declared copy (#2688 consumption contract).
const VALID_ROLES = ALL_ROLES;

export function serviceTokenStore(env: Env): KvLike {
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "service_tokens",
    legacyFallback: false,
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const recordKey = (tokenId: string) => `token:${tokenId}`;
const hashKey = (hash: string) => `hash:${hash}`;
const subjectKey = (serviceInternalUserId: string) => `subject:${serviceInternalUserId}`;
const ALL_INDEX_KEY = "index:all";

function isTenantShaped(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512 &&
    !/[\s\x00-\x1F\x7F]/.test(value.trim())
  );
}

async function readRecord(store: KvLike, tokenId: string): Promise<ServiceTokenRecord | null> {
  const raw = await store.get(recordKey(tokenId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceTokenRecord;
    if (typeof parsed?.hash !== "string" || typeof parsed?.serviceInternalUserId !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readIndex(store: KvLike, key: string): Promise<string[]> {
  const raw = await store.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toMetadata(record: ServiceTokenRecord): ServiceTokenMetadata {
  const {
    id,
    label,
    prefix,
    serviceLogin,
    serviceInternalUserId,
    tier,
    tenantId,
    roles,
    expiresAtMs,
    revokedAtMs,
    createdBy,
    createdAtMs,
    lastUsedAtMs,
  } = record;
  return {
    id,
    label,
    prefix,
    serviceLogin,
    serviceInternalUserId,
    tier,
    tenantId,
    roles: [...roles],
    expiresAtMs,
    revokedAtMs: revokedAtMs ?? null,
    createdBy,
    createdAtMs,
    lastUsedAtMs: lastUsedAtMs ?? null,
  };
}

/**
 * The service identity must hold a live member binding for the tier
 * being minted — the platform-tier membership check from
 * serviceDispatch.ts, applied at mint time. A binding counts only
 * when its membership is unrevoked and the binding itself is
 * unexpired.
 */
async function provisioningIsLive(
  memberships: MembershipStore,
  serviceInternalUserId: string,
  tier: ServiceTokenTier,
  tenantId: string | null,
  nowMs: number,
): Promise<boolean> {
  const all = await memberships.getMembershipsByUser(serviceInternalUserId);
  return all.some(
    (m) =>
      m.revokedAtMs === undefined &&
      m.roleBindings.some(
        (b) =>
          b.role === "member" &&
          b.scope === tier &&
          (tier === "platform" || m.tenantId === tenantId) &&
          (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
      ),
  );
}

/**
 * Mints a token. Enforces, in order: shape (label/tier/tenant/roles/
 * expiry), provisioning for the tier, and one canGrantRole check per
 * requested role — a granter who cannot grant a role cannot mint a
 * token carrying it, so no token is ever self-granted. Returns the
 * metadata plus the plaintext secret — the secret is returned here
 * and NOWHERE else; only its hash is persisted.
 */
export async function mintServiceToken(
  store: KvLike,
  memberships: MembershipStore,
  input: MintServiceTokenInput,
  nowMs: number,
): Promise<{ token: ServiceTokenMetadata; secret: string }> {
  const label = (input.label || "").trim().slice(0, MAX_LABEL_LENGTH) || "Service token";
  if (input.tier !== "platform" && input.tier !== "tenant") {
    throw new Error(`Unknown tier: ${String(input.tier)}. Tier must be "platform" or "tenant".`);
  }
  let tenantId: string | null = null;
  if (input.tier === "tenant") {
    if (!isTenantShaped(input.tenantId)) {
      throw new Error("tenantId is required for tenant provisioning.");
    }
    tenantId = (input.tenantId as string).trim();
  }
  if (!Array.isArray(input.roles) || input.roles.length === 0) {
    throw new Error("At least one role is required.");
  }
  for (const role of input.roles) {
    if (!VALID_ROLES.includes(role)) {
      throw new Error(`Unknown role: ${String(role)}.`);
    }
    if (role === "workspace-admin") {
      throw new Error(
        "workspace-admin requires a workspace binding, which service tokens do not carry.",
      );
    }
  }
  if (typeof input.expiresAtMs !== "number" || input.expiresAtMs <= nowMs) {
    throw new Error("expiresAtMs is required and must be in the future.");
  }
  if (
    !(await provisioningIsLive(
      memberships,
      input.serviceInternalUserId,
      input.tier,
      tenantId,
      nowMs,
    ))
  ) {
    throw new Error(
      `Service identity is not provisioned for the ${input.tier} tier.`,
    );
  }
  for (const role of input.roles) {
    const grant = await canGrantRole(memberships, {
      granterInternalUserId: input.createdBy,
      targetTenantId: tenantId ?? "primary",
      targetScope: input.tier,
      targetRole: role,
      nowMs,
    });
    if (grant.decision === "deny") {
      throw new Error(`Cannot grant role ${role}: ${grant.reason}.`);
    }
  }
  const secret = SERVICE_TOKEN_PREFIX + randomBase64Url(SECRET_RANDOM_BYTES);
  const hash = await sha256Hex(secret);
  const id = `svctok_${randomBase64Url(TOKEN_ID_RANDOM_BYTES)}`;
  const record: ServiceTokenRecord = {
    id,
    label,
    // The display prefix is not secret material: 8 base64url chars of
    // a 256-bit secret, shown so an admin can tell tokens apart.
    prefix: secret.slice(0, SERVICE_TOKEN_PREFIX.length + 8),
    serviceLogin: input.serviceLogin,
    serviceInternalUserId: input.serviceInternalUserId,
    tier: input.tier,
    tenantId,
    roles: [...input.roles],
    expiresAtMs: input.expiresAtMs,
    revokedAtMs: null,
    createdBy: input.createdBy,
    createdAtMs: nowMs,
    lastUsedAtMs: null,
    hash,
  };
  await store.put(recordKey(id), JSON.stringify(record));
  await store.put(hashKey(hash), id);
  const subjectIndex = await readIndex(store, subjectKey(input.serviceInternalUserId));
  subjectIndex.push(id);
  await store.put(subjectKey(input.serviceInternalUserId), JSON.stringify(subjectIndex));
  const allIndex = await readIndex(store, ALL_INDEX_KEY);
  allIndex.push(id);
  await store.put(ALL_INDEX_KEY, JSON.stringify(allIndex));
  return { token: toMetadata(record), secret };
}

/**
 * Verifies a presented secret. Returns the bound identity on success
 * and null for EVERY failure — malformed, unknown, expired, revoked,
 * unprovisioned, and cross-tenant tokens are indistinguishable to the
 * caller (constant-shape). The lookup is by hash, so no secret
 * comparison happens server-side at all. Every check reads the store
 * fresh: revocation and membership loss deny on the very next verify
 * (0 ms), with no cache layer between store and gate.
 */
export async function verifyServiceToken(
  store: KvLike,
  memberships: MembershipStore,
  presented: string | null | undefined,
  requestTenantId: string,
  nowMs: number,
): Promise<VerifiedServiceToken | null> {
  if (typeof presented !== "string" || !SECRET_PATTERN.test(presented)) return null;
  const hash = await sha256Hex(presented);
  const tokenId = await store.get(hashKey(hash));
  if (!tokenId) return null;
  const record = await readRecord(store, tokenId);
  if (!record || record.hash !== hash) return null;
  if (record.revokedAtMs !== null && record.revokedAtMs !== undefined) return null;
  if (record.expiresAtMs <= nowMs) return null;
  if (record.tier === "tenant" && record.tenantId !== requestTenantId) return null;
  if (
    !(await provisioningIsLive(
      memberships,
      record.serviceInternalUserId,
      record.tier,
      record.tenantId,
      nowMs,
    ))
  ) {
    return null;
  }
  // Best-effort usage stamp; a failed write must not fail the request.
  try {
    record.lastUsedAtMs = nowMs;
    await store.put(recordKey(record.id), JSON.stringify(record));
  } catch {
    /* usage stamping is advisory */
  }
  return {
    tokenId: record.id,
    serviceLogin: record.serviceLogin,
    serviceInternalUserId: record.serviceInternalUserId,
    tier: record.tier,
    tenantId: record.tenantId,
    roles: [...record.roles],
    prefix: record.prefix,
  };
}

/** Lists all tokens as metadata only — no secrets, no hashes. */
export async function listServiceTokens(store: KvLike): Promise<ServiceTokenMetadata[]> {
  const index = await readIndex(store, ALL_INDEX_KEY);
  const tokens: ServiceTokenMetadata[] = [];
  const liveIds: string[] = [];
  for (const tokenId of index) {
    const record = await readRecord(store, tokenId);
    if (!record) continue;
    tokens.push(toMetadata(record));
    liveIds.push(tokenId);
  }
  // Self-heal the index if it referenced records that no longer exist.
  if (liveIds.length !== index.length) {
    await store.put(ALL_INDEX_KEY, JSON.stringify(liveIds));
  }
  return tokens;
}

/**
 * Rotates a token: mints a new secret for the same record (same id,
 * roles, tier, tenant) and invalidates the old hash immediately, so
 * the old secret denies on its very next use. The new secret is
 * returned here and NOWHERE else. Rotating a revoked or missing token
 * returns null — revocation is terminal.
 */
export async function rotateServiceToken(
  store: KvLike,
  tokenId: string,
  newExpiresAtMs: number,
  nowMs: number,
): Promise<{ token: ServiceTokenMetadata; secret: string } | null> {
  const record = await readRecord(store, tokenId);
  if (!record) return null;
  if (record.revokedAtMs !== null && record.revokedAtMs !== undefined) return null;
  if (typeof newExpiresAtMs !== "number" || newExpiresAtMs <= nowMs) {
    throw new Error("expiresAtMs is required and must be in the future.");
  }
  const secret = SERVICE_TOKEN_PREFIX + randomBase64Url(SECRET_RANDOM_BYTES);
  const hash = await sha256Hex(secret);
  await store.delete(hashKey(record.hash));
  record.hash = hash;
  record.prefix = secret.slice(0, SERVICE_TOKEN_PREFIX.length + 8);
  record.expiresAtMs = newExpiresAtMs;
  record.lastUsedAtMs = null;
  await store.put(recordKey(record.id), JSON.stringify(record));
  await store.put(hashKey(hash), record.id);
  return { token: toMetadata(record), secret };
}

/**
 * Revokes a token. The hash index is deleted so verification fails on
 * the next use (0 ms); the record is kept, marked revoked, so the
 * admin list still shows it. Returns false when the token does not
 * exist or is already revoked — the two cases are deliberately
 * indistinguishable, so token ids cannot be probed.
 */
export async function revokeServiceToken(
  store: KvLike,
  tokenId: string,
  nowMs: number,
): Promise<boolean> {
  const record = await readRecord(store, tokenId);
  if (!record) return false;
  if (record.revokedAtMs !== null && record.revokedAtMs !== undefined) return false;
  await store.delete(hashKey(record.hash));
  record.revokedAtMs = nowMs;
  await store.put(recordKey(record.id), JSON.stringify(record));
  return true;
}

/**
 * Evaluates a permission for a verified token through the real PDP
 * (authorize()), with the token's own roles as the only bindings.
 * This is the seam #945 route wiring consumes: a token's roles are
 * enforced at the authorization gate, never asserted by the caller.
 * A tenant token checked in another tenant denies CROSS_TENANT
 * without reaching the PDP.
 */
export async function authorizeServiceToken(
  verified: VerifiedServiceToken,
  permission: Permission,
  nowMs: number,
  requestTenantId?: string,
): Promise<AuthorizationDecision> {
  if (
    verified.tier === "tenant" &&
    requestTenantId !== undefined &&
    requestTenantId !== verified.tenantId
  ) {
    return {
      decision: "deny",
      reason: "CROSS_TENANT",
      principalId: verified.serviceInternalUserId,
      tenantId: requestTenantId,
      permission: String(permission),
      policyVersion: "iaaa-authorization-1",
    };
  }
  const store = createMemoryMembershipStore();
  await store.put({
    membershipId: `m-svctoken-${verified.tokenId}`,
    internalUserId: verified.serviceInternalUserId,
    tenantId: verified.tenantId ?? "primary",
    roleBindings: verified.roles.map((role) => ({
      role,
      scope: verified.tier,
      grantedBy: "service-token",
    })),
    createdBy: "service-token",
    createdAtMs: nowMs,
  });
  return authorize(store, {
    actorInternalUserId: verified.serviceInternalUserId,
    tenantId: verified.tenantId ?? "primary",
    permission,
    scope: verified.tier,
    nowMs,
  });
}

/** Extracts the Bearer credential from an Authorization header, if any. */
export function bearerTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
