/**
 * Per-Tenant Provider & Broker Credential Store (#4614)
 *
 * Replaces env-global broker/provider credential sharing with an explicit
 * tenant-keyed credential store (`tenantId:kind:providerOrBrokerId`).
 * Credentials are never shared across tenants, and every resolved or
 * migrated credential stamps `provenanceProviderId`.
 */

import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";

export type CredentialKind = "provider" | "broker";

export interface TenantCredentialRecord {
  tenantId: string;
  kind: CredentialKind;
  id: string;
  provenanceProviderId: string;
  apiKey?: string;
  apiSecret?: string;
  oauthToken?: string;
  oauthTokenSecret?: string;
  environment?: string;
  migratedFrom?: string;
  updatedAtMs: number;
}

export interface TenantCredentialInput {
  apiKey?: string;
  apiSecret?: string;
  oauthToken?: string;
  oauthTokenSecret?: string;
  environment?: string;
  migratedFrom?: string;
  provenanceProviderId?: string;
}

export interface TenantCredentialStore {
  getCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
  ): Promise<TenantCredentialRecord | null>;
  setCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
    input: TenantCredentialInput,
  ): Promise<TenantCredentialRecord>;
  deleteCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
  ): Promise<boolean>;
  listTenantCredentials(tenantId: string): Promise<TenantCredentialRecord[]>;
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEY_PREFIX = "tenant_creds:v1";

function requireTenantId(tenantId: string): string {
  const normalized = typeof tenantId === "string" ? tenantId.trim() : "";
  if (!normalized) {
    throw new Error("Tenant credential store requires a non-empty tenantId.");
  }
  return normalized;
}

function normalizeId(id: string): string {
  const normalized = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (!normalized) {
    throw new Error("Tenant credential store requires a non-empty provider/broker id.");
  }
  return normalized;
}

/**
 * Canonical per-tenant key. Never omits tenantId so two tenants can never
 * collide or read each other's credentials.
 */
export function tenantCredentialKey(
  tenantId: string,
  kind: CredentialKind,
  id: string,
): string {
  return `${KEY_PREFIX}:${requireTenantId(tenantId)}:${kind}:${normalizeId(id)}`;
}

function buildRecord(
  tenantId: string,
  kind: CredentialKind,
  id: string,
  input: TenantCredentialInput,
): TenantCredentialRecord {
  const normalizedTenant = requireTenantId(tenantId);
  const normalizedId = normalizeId(id);
  return {
    tenantId: normalizedTenant,
    kind,
    id: normalizedId,
    provenanceProviderId: input.provenanceProviderId?.trim() || normalizedId,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.apiSecret !== undefined ? { apiSecret: input.apiSecret } : {}),
    ...(input.oauthToken !== undefined ? { oauthToken: input.oauthToken } : {}),
    ...(input.oauthTokenSecret !== undefined
      ? { oauthTokenSecret: input.oauthTokenSecret }
      : {}),
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.migratedFrom !== undefined ? { migratedFrom: input.migratedFrom } : {}),
    updatedAtMs: Date.now(),
  };
}

/**
 * In-memory tenant-keyed credential store for local/unit tests.
 */
export class InMemoryTenantCredentialStore implements TenantCredentialStore {
  private readonly records = new Map<string, TenantCredentialRecord>();

  async getCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
  ): Promise<TenantCredentialRecord | null> {
    const key = tenantCredentialKey(tenantId, kind, id);
    const hit = this.records.get(key);
    return hit ? { ...hit } : null;
  }

  async setCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
    input: TenantCredentialInput,
  ): Promise<TenantCredentialRecord> {
    const key = tenantCredentialKey(tenantId, kind, id);
    const rec = buildRecord(tenantId, kind, id, input);
    this.records.set(key, rec);
    return { ...rec };
  }

  async deleteCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
  ): Promise<boolean> {
    const key = tenantCredentialKey(tenantId, kind, id);
    return this.records.delete(key);
  }

  async listTenantCredentials(tenantId: string): Promise<TenantCredentialRecord[]> {
    const normalizedTenant = requireTenantId(tenantId);
    const prefix = `${KEY_PREFIX}:${normalizedTenant}:`;
    const results: TenantCredentialRecord[] = [];
    for (const [k, v] of this.records.entries()) {
      if (k.startsWith(prefix)) {
        results.push({ ...v });
      }
    }
    return results;
  }
}

/**
 * KV-backed per-tenant credential store for Worker runtimes.
 */
export class KvTenantCredentialStore implements TenantCredentialStore {
  constructor(private readonly kv: KvLike) {}

  private indexKey(tenantId: string): string {
    return `${KEY_PREFIX}:index:${requireTenantId(tenantId)}`;
  }

  async getCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
  ): Promise<TenantCredentialRecord | null> {
    const raw = await this.kv.get(tenantCredentialKey(tenantId, kind, id));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as TenantCredentialRecord;
      if (parsed.tenantId !== requireTenantId(tenantId)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async setCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
    input: TenantCredentialInput,
  ): Promise<TenantCredentialRecord> {
    const key = tenantCredentialKey(tenantId, kind, id);
    const rec = buildRecord(tenantId, kind, id, input);
    await this.kv.put(key, JSON.stringify(rec));

    const idxKey = this.indexKey(tenantId);
    const existingRaw = await this.kv.get(idxKey);
    let keys: string[] = [];
    if (existingRaw) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (Array.isArray(parsed)) {
          keys = parsed.filter((x): x is string => typeof x === "string");
        }
      } catch {
        keys = [];
      }
    }
    if (!keys.includes(key)) {
      keys.push(key);
      await this.kv.put(idxKey, JSON.stringify(keys));
    }
    return rec;
  }

  async deleteCredential(
    tenantId: string,
    kind: CredentialKind,
    id: string,
  ): Promise<boolean> {
    const key = tenantCredentialKey(tenantId, kind, id);
    const existed = (await this.kv.get(key)) !== null;
    await this.kv.delete(key);
    return existed;
  }

  async listTenantCredentials(tenantId: string): Promise<TenantCredentialRecord[]> {
    const rawIdx = await this.kv.get(this.indexKey(tenantId));
    if (!rawIdx) return [];
    let keys: string[] = [];
    try {
      const parsed = JSON.parse(rawIdx);
      if (Array.isArray(parsed)) {
        keys = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      return [];
    }
    const items = await Promise.all(keys.map((k) => this.kv.get(k)));
    const normalizedTenant = requireTenantId(tenantId);
    const out: TenantCredentialRecord[] = [];
    for (const item of items) {
      if (!item) continue;
      try {
        const rec = JSON.parse(item) as TenantCredentialRecord;
        if (rec.tenantId === normalizedTenant) out.push(rec);
      } catch {
        // skip corrupted entry
      }
    }
    return out;
  }
}

export function createTenantCredentialStore(env: unknown): TenantCredentialStore {
  if (env && typeof env === "object") {
    const rec = env as Record<string, unknown>;
    const kv = (rec.TENANT_CREDENTIALS_KV ?? rec.USER_SESSIONS ?? rec.OAUTH_KV) as
      | KvLike
      | undefined;
    if (kv && typeof kv.get === "function" && typeof kv.put === "function" && typeof kv.delete === "function") {
      return new KvTenantCredentialStore(kv);
    }
  }
  return new InMemoryTenantCredentialStore();
}

function readString(env: Record<string, unknown>, key: string): string | undefined {
  const v = env[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export interface LegacyEnvCredentialSpec {
  kind: CredentialKind;
  id: string;
  apiKeyEnvVars?: readonly string[];
  apiSecretEnvVars?: readonly string[];
  envModeEnvVar?: string;
  defaultEnvironment?: string;
}

export interface LegacyOAuthCredentialInput {
  kind: CredentialKind;
  id: string;
  oauthToken: string;
  oauthTokenSecret: string;
  environment?: string;
  login?: string;
}

export interface LegacyMigrationResult {
  tenantId: string;
  migratedKeys: string[];
}

function firstNonEmptyEnvVar(
  env: Record<string, unknown>,
  names: readonly string[] | undefined,
): { name: string; value: string } | undefined {
  if (!names) return undefined;
  for (const name of names) {
    const value = readString(env, name);
    if (value !== undefined) {
      return { name, value };
    }
  }
  return undefined;
}

/**
 * Migrate legacy env-level broker/provider credentials and optional per-login
 * OAuth tokens into the tenant-keyed credential store.
 */
export async function migrateLegacyEnvCredentialsToTenant(
  store: TenantCredentialStore,
  tenantId: string,
  env: Record<string, unknown>,
  specs: readonly LegacyEnvCredentialSpec[],
  legacyOAuthTokens: readonly LegacyOAuthCredentialInput[] = [],
): Promise<LegacyMigrationResult> {
  const normalizedTenant = requireTenantId(tenantId);
  const migratedKeys: string[] = [];

  for (const spec of specs) {
    const apiKeyHit = firstNonEmptyEnvVar(env, spec.apiKeyEnvVars);
    const apiSecretHit = firstNonEmptyEnvVar(env, spec.apiSecretEnvVars);
    const oauthHit = legacyOAuthTokens.find(
      (t) => t.kind === spec.kind && normalizeId(t.id) === normalizeId(spec.id),
    );
    if (!apiKeyHit && !apiSecretHit && !oauthHit) continue;

    const envMode = spec.envModeEnvVar ? readString(env, spec.envModeEnvVar) : undefined;
    const environment = oauthHit?.environment ?? envMode ?? spec.defaultEnvironment;
    const migratedFrom = oauthHit
      ? `login:${oauthHit.login ?? "legacy"}`
      : `env:${apiKeyHit?.name ?? apiSecretHit?.name ?? spec.id}`;

    await store.setCredential(normalizedTenant, spec.kind, spec.id, {
      ...(apiKeyHit ? { apiKey: apiKeyHit.value } : {}),
      ...(apiSecretHit ? { apiSecret: apiSecretHit.value } : {}),
      ...(oauthHit
        ? {
            oauthToken: oauthHit.oauthToken,
            oauthTokenSecret: oauthHit.oauthTokenSecret,
          }
        : {}),
      ...(environment !== undefined ? { environment } : {}),
      migratedFrom,
      provenanceProviderId: normalizeId(spec.id),
    });
    migratedKeys.push(`${spec.kind}:${normalizeId(spec.id)}`);
  }

  return { tenantId: normalizedTenant, migratedKeys };
}

/**
 * Resolve credentials for the active tenant without ever crossing tenant boundaries.
 */
export async function resolveTenantCredentials(
  env: unknown,
  kind: CredentialKind,
  id: string,
  options?: { store?: TenantCredentialStore; tenantId?: string },
): Promise<TenantCredentialRecord | null> {
  const tenantId = options?.tenantId?.trim() || resolveIaaaTenant(env as never);
  const store = options?.store ?? createTenantCredentialStore(env);
  return store.getCredential(tenantId, kind, id);
}
