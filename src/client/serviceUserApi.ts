/**
 * Client for the service-user administration routes (#2331 slice 1,
 * UI slice #2501): status read + platform-tier provision, plus the
 * service-login E*TRADE authorization client (#4988): start (returns
 * the E*TRADE authorize URL), verifier-PIN completion, token revoke.
 *
 * Status reads go through src/client/apiFetch.ts (the #71 rule).
 * The provision POST deliberately uses raw fetch instead: apiFetch
 * follows 202 responses with up-to-10-minute job polling, which
 * would hide the queued state this UI must render (a 202 means
 * queued-not-done, never success). Raw fetch sends the same
 * same-origin request; apiFetch adds no headers beyond fetch
 * defaults, so nothing is lost by bypassing it here. The server is
 * the gate: a 401 means not signed in, a 403 means the caller is
 * not a platform admin, and this module never decides
 * authorization.
 */

import { apiFetch, csrfHeaders } from "./apiFetch";

export interface ServiceUserPlatformStatus {
  membershipId: string;
  roles: string[];
}

/**
 * Issue #4988 — the provisioning checklist (#1764) as the status
 * route reports it. The client renders it read-only; the token
 * item is presence only (never a value).
 */
export interface ProvisioningChecklistItem {
  id: string;
  label: string;
  status: "pass" | "fail" | "unknown";
  detail?: string;
}

export interface ProvisioningChecklist {
  complete: boolean;
  checklist: ProvisioningChecklistItem[];
  ownerActions: string[];
}

export interface ServiceUserStatus {
  serviceUser: string;
  serviceInternalUserId: string;
  platform: ServiceUserPlatformStatus | null;
  tenants: string[];
  provisioning?: ProvisioningChecklist;
}

/** Error carrying the HTTP status, so the UI can render 401/403/202 distinctly. */
export class ServiceUserApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ServiceUserApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlatformStatus(value: unknown): value is ServiceUserPlatformStatus {
  return (
    isRecord(value) &&
    typeof value.membershipId === "string" &&
    Array.isArray(value.roles) &&
    value.roles.every((r) => typeof r === "string")
  );
}

function isProvisioningChecklist(value: unknown): value is ProvisioningChecklist {
  if (!isRecord(value)) return false;
  if (typeof value.complete !== "boolean") return false;
  if (
    !Array.isArray(value.checklist) ||
    !value.checklist.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.label === "string" &&
        (item.status === "pass" || item.status === "fail" || item.status === "unknown"),
    )
  ) {
    return false;
  }
  if (!Array.isArray(value.ownerActions) || !value.ownerActions.every((a) => typeof a === "string")) {
    return false;
  }
  return true;
}

/** Shape guard: true only for a well-formed status payload. */
export function isServiceUserStatus(value: unknown): value is ServiceUserStatus {
  if (!isRecord(value)) return false;
  if (typeof value.serviceUser !== "string") return false;
  if (typeof value.serviceInternalUserId !== "string") return false;
  if (value.platform !== null && !isPlatformStatus(value.platform)) return false;
  if (!Array.isArray(value.tenants) || !value.tenants.every((t) => typeof t === "string")) {
    return false;
  }
  if (value.provisioning !== undefined && !isProvisioningChecklist(value.provisioning)) {
    return false;
  }
  return true;
}

async function readBody(resp: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await resp.json();
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function errorMessage(data: Record<string, unknown>, status: number): string {
  return typeof data.error === "string" ? data.error : `Request failed (${status})`;
}

/** Fetch the status; throws ServiceUserApiError with the HTTP status on failure. */
export async function fetchServiceUserStatus(): Promise<ServiceUserStatus> {
  let resp: Response;
  try {
    resp = await apiFetch("/api/admin/service-user/status");
  } catch {
    throw new ServiceUserApiError(0, "Failed to reach the server.");
  }
  const data = await readBody(resp);
  if (!resp.ok) throw new ServiceUserApiError(resp.status, errorMessage(data, resp.status));
  if (!isServiceUserStatus(data)) {
    throw new ServiceUserApiError(resp.status, "Unexpected service-user status response.");
  }
  return data;
}

export type ProvisionOutcome =
  | { kind: "provisioned"; membershipId: string }
  | { kind: "alreadyProvisioned"; membershipId: string }
  | { kind: "queued"; jobId?: string };

/**
 * Issue #4988 — start the service-login E*TRADE authorization.
 * Returns the E*TRADE authorize URL the owner opens in a new tab
 * (logging in at E*TRADE as the service login); E*TRADE then shows
 * a verifier PIN, completed via completeServiceEtradeAuth. Raw
 * fetch, like provisionPlatformTier: the server is the gate, and a
 * 401 means not signed in, a 403 means not a platform admin, a
 * stale step-up session, or a PDP denial — all surfaced, never
 * silently retried.
 */
export async function startServiceEtradeAuth(): Promise<{
  authorizeUrl: string;
  serviceUser: string;
}> {
  let resp: Response;
  try {
    resp = await globalThis.fetch("/api/admin/service-user/etrade/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({}),
    });
  } catch {
    throw new ServiceUserApiError(0, "Failed to reach the server.");
  }
  const data = await readBody(resp);
  if (!resp.ok) throw new ServiceUserApiError(resp.status, errorMessage(data, resp.status));
  if (typeof data.authorizeUrl !== "string" || typeof data.serviceUser !== "string") {
    throw new ServiceUserApiError(resp.status, "Unexpected authorization response.");
  }
  return { authorizeUrl: data.authorizeUrl, serviceUser: data.serviceUser };
}

/** Complete the service-login authorization with the E*TRADE verifier PIN. */
export async function completeServiceEtradeAuth(verifier: string): Promise<void> {
  let resp: Response;
  try {
    resp = await globalThis.fetch("/api/admin/service-user/etrade/verifier", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ verifier }),
    });
  } catch {
    throw new ServiceUserApiError(0, "Failed to reach the server.");
  }
  const data = await readBody(resp);
  if (!resp.ok) throw new ServiceUserApiError(resp.status, errorMessage(data, resp.status));
  if (data.ok !== true) {
    throw new ServiceUserApiError(resp.status, "Unexpected authorization response.");
  }
}

/** Revoke the service login's stored E*TRADE token (owner's token untouched). */
export async function revokeServiceEtradeToken(): Promise<boolean> {
  let resp: Response;
  try {
    resp = await globalThis.fetch("/api/admin/service-user/etrade/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({}),
    });
  } catch {
    throw new ServiceUserApiError(0, "Failed to reach the server.");
  }
  const data = await readBody(resp);
  if (!resp.ok) throw new ServiceUserApiError(resp.status, errorMessage(data, resp.status));
  if (data.ok !== true) {
    throw new ServiceUserApiError(resp.status, "Unexpected revocation response.");
  }
  return data.deleted === true;
}

/**
 * Provision the platform tier. The 202 outcome is returned, never
 * thrown: a queued provision is not done, and the caller renders
 * queued-not-done guidance instead of success. Only a later status
 * read showing the platform tier provisioned counts as done.
 */
export async function provisionPlatformTier(): Promise<ProvisionOutcome> {
  let resp: Response;
  try {
    resp = await globalThis.fetch("/api/admin/service-user/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ tier: "platform" }),
    });
  } catch {
    throw new ServiceUserApiError(0, "Failed to reach the server.");
  }
  const data = await readBody(resp);
  if (resp.status === 202) {
    return {
      kind: "queued",
      jobId: typeof data.jobId === "string" ? data.jobId : undefined,
    };
  }
  if (!resp.ok) throw new ServiceUserApiError(resp.status, errorMessage(data, resp.status));
  if (data.ok !== true) {
    throw new ServiceUserApiError(resp.status, "Unexpected provision response.");
  }
  const membershipId = typeof data.membershipId === "string" ? data.membershipId : "";
  return data.alreadyProvisioned === true
    ? { kind: "alreadyProvisioned", membershipId }
    : { kind: "provisioned", membershipId };
}
