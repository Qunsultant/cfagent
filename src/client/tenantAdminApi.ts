/**
 * Client for the tenant administration endpoints (issue #2221):
 * GET/POST /api/platform-tenants, GET /api/platform-tenants/:id,
 * PATCH /api/platform-tenants/:id/settings.
 *
 * Operator-only: a 403 here means the server refused (the caller
 * is not a store operator), never a client bug. Memberships are
 * NOT fetched here — the panel reads them from the existing IAAA
 * read path (fetchMemberships in iaaaAdminApi.ts) and filters by
 * tenant, so no IAAA state is ever written from this surface.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 *
 * Every call opts into a per-request bound (issue #4513): a
 * request that never returns surfaces ApiFetchTimeoutError
 * instead of leaving the panel spinning forever. The bound
 * changes nothing for other apiFetch callers, which do not
 * opt in.
 */
import { apiFetch } from "./apiFetch";

/**
 * Per-request bound for tenant administration calls (issue
 * #4513). 30 seconds is far above a healthy round trip and
 * short enough that an operator is never left staring at a
 * spinner. The bound is per fetch (see ApiFetchOptions);
 * the panel translates a timeout into a plain retry message.
 */
export const TENANT_ADMIN_REQUEST_TIMEOUT_MS = 30_000;

export interface TenantSettingsView {
  tenantId: string;
  adsEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalS: number;
  dataProviderId: string;
  brokerId: string;
}

export interface TenantListRow extends TenantSettingsView {
  memberCount: number;
}

export interface TenantAccountMember {
  userId: string;
  hasAccount: boolean;
  tenantId: string | null;
  tier: string;
  creditsUSD: number;
  includedRuns: number;
}

export interface TenantDetail extends TenantSettingsView {
  members: TenantAccountMember[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSettings(value: unknown): value is TenantSettingsView {
  if (!isRecord(value)) return false;
  return (
    typeof value.tenantId === "string" &&
    typeof value.adsEnabled === "boolean" &&
    typeof value.autoRefreshEnabled === "boolean" &&
    typeof value.autoRefreshIntervalS === "number" &&
    typeof value.dataProviderId === "string" &&
    typeof value.brokerId === "string"
  );
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init, undefined, { timeoutMs: TENANT_ADMIN_REQUEST_TIMEOUT_MS });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchTenants(): Promise<TenantListRow[]> {
  const data = await send<{ tenants?: unknown }>("/api/platform-tenants");
  if (!Array.isArray(data.tenants)) throw new Error("Unexpected tenant list response.");
  return data.tenants.filter(
    (row): row is TenantListRow => isSettings(row) && typeof (row as { memberCount?: unknown }).memberCount === "number",
  );
}

export async function createTenant(tenantId: string): Promise<TenantSettingsView> {
  const data = await send<{ tenant?: unknown }>("/api/platform-tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId }),
  });
  if (!isSettings(data.tenant)) throw new Error("Unexpected tenant create response.");
  return data.tenant;
}

export async function fetchTenantDetail(tenantId: string): Promise<TenantDetail> {
  const data = await send<{ tenant?: unknown }>(`/api/platform-tenants/${encodeURIComponent(tenantId)}`);
  if (!isSettings(data.tenant) || !Array.isArray((data.tenant as { members?: unknown }).members)) {
    throw new Error("Unexpected tenant detail response.");
  }
  return data.tenant as TenantDetail;
}

export interface TenantSettingsPatch {
  adsEnabled?: boolean;
  autoRefresh?: { enabled: boolean; intervalS: number };
  providers?: { dataProviderId: string; brokerId: string };
}

export async function updateTenantSettings(
  tenantId: string,
  patch: TenantSettingsPatch,
): Promise<TenantSettingsView> {
  const data = await send<{ tenant?: unknown }>(
    `/api/platform-tenants/${encodeURIComponent(tenantId)}/settings`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!isSettings(data.tenant)) throw new Error("Unexpected tenant settings response.");
  return data.tenant;
}
