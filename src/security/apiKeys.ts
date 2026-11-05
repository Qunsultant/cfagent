import type { Env } from "../types";
import {
  createBucketPorts,
  isBucketPortsEnabled,
} from "../data/createBucketPorts";
import { createStoreKv, type DoNamespaceLike } from "../data/durableKv";
import { type KvLike } from "./kvResilience";

/**
 * Per-user API keys for the MCP transport (issue #180).
 *
 * Why: the /mcp transport identified callers by the caller-asserted
 * `x-user-id` header, falling back to a shared "mcp_client" identity —
 * and the asserted string selected the OrchestratorAgent DO instance, so
 * anyone could impersonate any user (their ledger, memory and E*TRADE
 * token context) or run the full tool registry anonymously. The decided
 * design (2026-10-20): identity at the transport is the app session OR a
 * per-user API key presented as `Authorization: Bearer <key>`; the key is
 * bound to the GitHub login that minted it. `x-user-id` is ignored.
 *
 * Storage follows the sessions/E*TRADE pattern (#329/#604): records live
 * in the SessionStore Durable Object (bucket "api_keys") via
 * createStoreKv — never Workers KV. Only the SHA-256 hash of a secret is
 * stored; the plaintext secret exists exactly once, in the mint response.
 *
 * Bucket layout (keys inside the "api_keys" bucket):
 * - `key:<keyId>`   → JSON ApiKeyRecord (includes the secret's hash)
 * - `hash:<sha256>` → keyId (lookup index used by verify)
 * - `user:<login>`  → JSON array of keyIds (the owner's index)
 */

export const API_KEY_PREFIX = "cfk_";
const SECRET_RANDOM_BYTES = 32; // 256 bits of entropy per key
const KEY_ID_RANDOM_BYTES = 8;
const MAX_LABEL_LENGTH = 80;

/** Public metadata for one key — never carries the secret or its hash. */
export interface ApiKeyMetadata {
  id: string;
  label: string;
  /** Non-secret display prefix of the key, e.g. "cfk_Ab3dEf7h". */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ApiKeyRecord extends ApiKeyMetadata {
  login: string;
  /** SHA-256 (hex) of the full secret. The secret itself is never stored. */
  hash: string;
}

const SECRET_PATTERN = /^cfk_[A-Za-z0-9_-]{43}$/;

/**
 * Issue #2436 (#1976 step 5e): the residual bucket family's
 * api-keys store. When BUCKET_PORTS_ENABLED is on, the store
 * is the family's port composition (src/data/
 * createBucketPorts.ts, over the SAME SessionStore DO and
 * kv_store table); when off, this module's direct funnel
 * composition below is the serving path, unchanged.
 * Signatures never change either way — existing callers are
 * untouched.
 */
export function apiKeyStore(env: Env): KvLike {
  if (isBucketPortsEnabled(env)) {
    return createBucketPorts(env).bucketKv("apiKeys");
  }
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "api_keys",
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

const recordKey = (keyId: string) => `key:${keyId}`;
const hashKey = (hash: string) => `hash:${hash}`;
const userKey = (login: string) => `user:${login}`;

async function readRecord(store: KvLike, keyId: string): Promise<ApiKeyRecord | null> {
  const raw = await store.get(recordKey(keyId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ApiKeyRecord;
    if (typeof parsed?.hash !== "string" || typeof parsed?.login !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readUserIndex(store: KvLike, login: string): Promise<string[]> {
  const raw = await store.get(userKey(login));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toMetadata(record: ApiKeyRecord): ApiKeyMetadata {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt ?? null,
  };
}

/**
 * Mints a new key for `login`. Returns the metadata plus the plaintext
 * secret — the secret is returned here and NOWHERE else; only its hash
 * is persisted.
 */
export async function mintApiKey(
  env: Env,
  login: string,
  label: string
): Promise<{ key: ApiKeyMetadata; secret: string }> {
  if (!login) throw new Error("A login is required to mint an API key.");
  const secret = API_KEY_PREFIX + randomBase64Url(SECRET_RANDOM_BYTES);
  const hash = await sha256Hex(secret);
  const keyId = `key_${randomBase64Url(KEY_ID_RANDOM_BYTES)}`;
  const record: ApiKeyRecord = {
    id: keyId,
    login,
    label: (label || "").trim().slice(0, MAX_LABEL_LENGTH) || "API key",
    // The display prefix is not secret material: 8 base64url chars of a
    // 256-bit secret, shown so a user can tell their keys apart.
    prefix: secret.slice(0, API_KEY_PREFIX.length + 8),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    hash,
  };
  const store = apiKeyStore(env);
  await store.put(recordKey(keyId), JSON.stringify(record));
  await store.put(hashKey(hash), keyId);
  const index = await readUserIndex(store, login);
  index.push(keyId);
  await store.put(userKey(login), JSON.stringify(index));
  return { key: toMetadata(record), secret };
}

/**
 * Verifies a presented secret. Returns the bound identity on success and
 * null for EVERY failure — malformed, unknown, and revoked keys are
 * indistinguishable to the caller (constant-shape). The lookup is by
 * hash, so no secret comparison happens server-side at all.
 */
export async function verifyApiKey(
  env: Env,
  presented: string | null | undefined
): Promise<{ login: string; keyId: string } | null> {
  if (typeof presented !== "string" || !SECRET_PATTERN.test(presented)) return null;
  const store = apiKeyStore(env);
  const hash = await sha256Hex(presented);
  const keyId = await store.get(hashKey(hash));
  if (!keyId) return null;
  const record = await readRecord(store, keyId);
  if (!record || record.hash !== hash) return null;

  // Best-effort usage stamp; a failed write must not fail the request.
  try {
    record.lastUsedAt = new Date().toISOString();
    await store.put(recordKey(keyId), JSON.stringify(record));
  } catch {
    /* usage stamping is advisory */
  }
  return { login: record.login, keyId };
}

/** Lists a user's own keys as metadata only — no secrets, no hashes. */
export async function listApiKeys(env: Env, login: string): Promise<ApiKeyMetadata[]> {
  const store = apiKeyStore(env);
  const index = await readUserIndex(store, login);
  const keys: ApiKeyMetadata[] = [];
  const liveIds: string[] = [];
  for (const keyId of index) {
    const record = await readRecord(store, keyId);
    if (!record || record.login !== login) continue;
    keys.push(toMetadata(record));
    liveIds.push(keyId);
  }
  // Self-heal the index if it referenced records that no longer exist.
  if (liveIds.length !== index.length) {
    await store.put(userKey(login), JSON.stringify(liveIds));
  }
  return keys;
}

/**
 * Revokes one of the user's own keys. Returns false when the key does
 * not exist or belongs to someone else — the two cases are deliberately
 * indistinguishable, so key ids cannot be probed across users.
 */
export async function revokeApiKey(env: Env, login: string, keyId: string): Promise<boolean> {
  const store = apiKeyStore(env);
  const record = await readRecord(store, keyId);
  if (!record || record.login !== login) return false;
  await store.delete(recordKey(keyId));
  await store.delete(hashKey(record.hash));
  const index = await readUserIndex(store, login);
  await store.put(userKey(login), JSON.stringify(index.filter((id) => id !== keyId)));
  return true;
}

/** Extracts the Bearer credential from an Authorization header, if any. */
export function bearerKeyFromRequest(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
