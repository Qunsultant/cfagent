/**
 * Client for the service-user administration routes (#2331 slice 1,
 * UI slice #2501): status read + platform-tier provision.
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

export interface ServiceUserStatus {
  serviceUser: string;
  serviceInternalUserId: string;
  platform: ServiceUserPlatformStatus | null;
  tenants: string[];
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

/** Shape guard: true only for a well-formed status payload. */
export function isServiceUserStatus(value: unknown): value is ServiceUserStatus {
  if (!isRecord(value)) return false;
  if (typeof value.serviceUser !== "string") return false;
  if (typeof value.serviceInternalUserId !== "string") return false;
  if (value.platform !== null && !isPlatformStatus(value.platform)) return false;
  if (!Array.isArray(value.tenants) || !value.tenants.every((t) => typeof t === "string")) {
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
