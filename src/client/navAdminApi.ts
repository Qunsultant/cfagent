/**
 * #6151 S4 — client wrappers for the nav admin-config routes.
 * Every call goes through apiFetch (the CSRF header for mutations
 * is merged there, and 401/403 keep their codes). A non-2xx
 * response is a thrown Error carrying the body code (or the HTTP
 * status), so the admin panel can surface the exact failure —
 * including the 403 when a tenant admin writes outside their own
 * tenant or beyond the tenant allowance — and revert its
 * optimistic state.
 */
import { apiFetch } from "./apiFetch";
import type {
  PersonaDefaultRecord,
  TenantAllowanceRecord,
  UserAllowlistRecord,
} from "../data/navAdminConfigPorts";
import type { NavPersona } from "./navConfig";

export interface NavAdminPersonaDefaultView {
  persona: NavPersona;
  presetKey: string;
  overridden: boolean;
}

export interface NavAdminTenantMembers {
  tenantId: string;
  userIds: string[];
}

export interface NavAdminConfigResponse {
  ok: boolean;
  scope: "platform" | "tenant";
  tenantId: string;
  allowances: TenantAllowanceRecord[];
  allowlists: UserAllowlistRecord[];
  personaDefaults: NavAdminPersonaDefaultView[];
  tenantMembers: NavAdminTenantMembers[];
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data: unknown = await resp.json().catch(() => null);
  if (!resp.ok) {
    const code =
      data !== null &&
      typeof data === "object" &&
      typeof (data as { code?: unknown }).code === "string"
        ? (data as { code: string }).code
        : `HTTP_${resp.status}`;
    const error = new Error(code);
    (error as Error & { code: string }).code = code;
    throw error;
  }
  return data as T;
}

export async function fetchNavAdminConfig(): Promise<NavAdminConfigResponse> {
  return requestJson<NavAdminConfigResponse>("/api/platform/nav-admin/config");
}

export async function saveTenantAllowance(
  tenantId: string,
  allowedIds: string[],
): Promise<TenantAllowanceRecord> {
  const data = await requestJson<{ allowance: TenantAllowanceRecord }>(
    "/api/platform/nav-admin/tenant-allowance",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, allowedIds }),
    },
  );
  return data.allowance;
}

export async function saveUserAllowlist(
  userId: string,
  input: { tenantId?: string; allowedIds: string[]; savedPresetsAllowed: boolean },
): Promise<UserAllowlistRecord> {
  const data = await requestJson<{ allowlist: UserAllowlistRecord }>(
    "/api/platform/nav-admin/user-allowlist",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, ...input }),
    },
  );
  return data.allowlist;
}

export async function savePersonaDefault(
  persona: NavPersona,
  presetKey: string,
): Promise<PersonaDefaultRecord> {
  const data = await requestJson<{ personaDefault: PersonaDefaultRecord }>(
    "/api/platform/nav-admin/persona-default",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona, presetKey }),
    },
  );
  return data.personaDefault;
}

export async function resetPersonaDefault(
  persona: NavPersona,
): Promise<{ deleted: boolean }> {
  return requestJson<{ ok: boolean; deleted: boolean }>(
    `/api/platform/nav-admin/persona-default/${encodeURIComponent(persona)}`,
    { method: "DELETE" },
  );
}

export type {
  PersonaDefaultRecord,
  TenantAllowanceRecord,
  UserAllowlistRecord,
};
