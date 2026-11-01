/**
 * Client for the service-token admin endpoints (issue #2681):
 * GET/POST /api/admin/service-user/tokens,
 * POST /api/admin/service-user/tokens/rotate,
 * POST /api/admin/service-user/tokens/revoke.
 *
 * Service tokens authenticate non-interactive callers as the service
 * identity. The plaintext secret is returned exactly once, by the mint
 * and rotate calls; every other response carries metadata only.
 * All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";

export type ServiceTokenTier = "platform" | "tenant";

/**
 * Presentation of the single role catalog (ALL_ROLES in
 * src/security/authorization.ts) for the token mint form. This is a
 * display list, not a second role system: the server validates every
 * requested role against ALL_ROLES and refuses anything ungrantable.
 * workspace-admin is excluded here because tokens never carry it
 * (no workspace binding exists for them); the server refuses it too.
 */
export const SERVICE_TOKEN_ROLE_OPTIONS = [
  "platform-admin",
  "tenant-admin",
  "member",
  "approver",
  "auditor",
] as const;

export interface ServiceTokenInfo {
  id: string;
  label: string;
  /** Non-secret display prefix, e.g. "svc_Ab3dEf7h". */
  prefix: string;
  serviceLogin: string;
  serviceInternalUserId: string;
  tier: ServiceTokenTier;
  tenantId: string | null;
  roles: string[];
  expiresAtMs: number;
  revokedAtMs: number | null;
  createdBy: string;
  createdAtMs: number;
  lastUsedAtMs: number | null;
}

export interface MintServiceTokenInput {
  label: string;
  tier: ServiceTokenTier;
  tenantId?: string;
  roles: string[];
  expiresAtMs: number;
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchServiceTokens(): Promise<ServiceTokenInfo[]> {
  const data = await send<{ tokens: ServiceTokenInfo[] }>("/api/admin/service-user/tokens");
  // Shape guard (issue #71): never hand the renderer a non-array.
  return Array.isArray(data?.tokens) ? data.tokens : [];
}

export async function mintServiceToken(
  input: MintServiceTokenInput,
): Promise<{ token: ServiceTokenInfo; secret: string }> {
  return send<{ token: ServiceTokenInfo; secret: string }>("/api/admin/service-user/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function rotateServiceToken(
  tokenId: string,
  expiresAtMs: number,
): Promise<{ token: ServiceTokenInfo; secret: string }> {
  return send<{ token: ServiceTokenInfo; secret: string }>(
    "/api/admin/service-user/tokens/rotate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId, expiresAtMs }),
    },
  );
}

export async function revokeServiceToken(tokenId: string): Promise<void> {
  await send<{ ok: boolean }>("/api/admin/service-user/tokens/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId }),
  });
}

/** "2026-10-20 · 14:32" style timestamp; "Never" for unused tokens. */
export function fmtServiceTokenTime(ms: number | null): string {
  if (!ms) return "Never";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
