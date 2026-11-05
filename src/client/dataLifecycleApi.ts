/**
 * Client for the admin data lifecycle endpoints (issue #3250):
 * POST /api/data-lifecycle/clean-state (preview + confirm),
 * GET  /api/data-lifecycle/export (pre-wipe bundle),
 * GET  /api/data-lifecycle/bootstrap (platform check),
 * POST /api/data-lifecycle/bootstrap (platform initialize),
 * POST /api/data-lifecycle/tenant-bootstrap (preview + confirm).
 *
 * Operator-gated server-side (platform scope and the genesis
 * claim additionally require platform-admin); a 403 here means
 * the server refused, never a client bug. Response shapes are
 * validated before use — an unexpected shape is an error, never
 * silently rendered as an empty state.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 */
import { apiFetch } from "./apiFetch";

export type CleanScope = "tenant" | "platform";

export interface CleanTargetPerLogin {
  login: string;
  count?: number;
  deleted?: number;
  error?: string;
}

export interface CleanTarget {
  id: string;
  label: string;
  kind: string;
  count?: number;
  deleted?: number;
  verified?: boolean;
  error?: string;
  perLogin?: CleanTargetPerLogin[];
}

export interface LifecycleAudit {
  funnel: boolean;
  auditLog: { ok: boolean; error?: string };
}

export interface CleanPreview {
  scope: CleanScope;
  tenantId?: string;
  confirmed: false;
  previewToken: string;
  targets: CleanTarget[];
}

export interface CleanResult {
  scope: CleanScope;
  tenantId?: string;
  confirmed: true;
  targets: CleanTarget[];
  audit: LifecycleAudit;
}

export interface ExportBundle {
  scope: CleanScope;
  tenantId?: string;
  exportedAtMs: number;
  targets: CleanTarget[];
  auditLog?: {
    count: number;
    truncated: boolean;
    corruptSegments: number;
    events: unknown[];
  };
}

export type BootstrapElementState =
  | "present"
  | "initialized"
  | "missing"
  | "external"
  | "failed";

export interface BootstrapElement {
  id: string;
  state: BootstrapElementState;
  detail: string;
  source: string;
}

export interface PlatformBootstrapReport {
  tenantId: string;
  elements: BootstrapElement[];
  allPresent?: boolean;
  confirmed?: boolean;
  confirmRequired?: boolean;
  audit?: LifecycleAudit;
}

export type TenantStepStatus =
  | "present"
  | "initialized"
  | "would-initialize"
  | "missing"
  | "not-requested"
  | "skipped"
  | "failed";

export interface TenantBootstrapStep {
  id: string;
  status: TenantStepStatus;
  detail: string;
}

export interface TenantBootstrapSettings {
  adsEnabled: boolean;
  autoRefreshEnabled: boolean;
  dataProviderId: string;
  brokerId: string;
}

export interface TenantBootstrapReport {
  tenantId: string;
  confirmed: boolean;
  outcome?: "complete" | "partial";
  steps: TenantBootstrapStep[];
  settings?: TenantBootstrapSettings;
  audit?: LifecycleAudit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTarget(value: unknown): value is CleanTarget {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string"
  );
}

function isTargets(value: unknown): value is CleanTarget[] {
  return Array.isArray(value) && value.every(isTarget);
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

function postInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function previewCleanState(
  scope: CleanScope,
  tenantId?: string,
): Promise<CleanPreview> {
  const data = await send<Partial<CleanPreview>>(
    "/api/data-lifecycle/clean-state",
    postInit({ scope, ...(tenantId ? { tenantId } : {}) }),
  );
  if (
    data.confirmed !== false ||
    typeof data.previewToken !== "string" ||
    !isTargets(data.targets)
  ) {
    throw new Error("Unexpected clean-state preview response.");
  }
  return data as CleanPreview;
}

export async function confirmCleanState(input: {
  scope: CleanScope;
  tenantId?: string;
  previewToken: string;
  confirmText?: string;
  auditConfirm: boolean;
}): Promise<CleanResult> {
  const data = await send<Partial<CleanResult>>(
    "/api/data-lifecycle/clean-state",
    postInit({
      scope: input.scope,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      confirm: true,
      previewToken: input.previewToken,
      ...(input.confirmText ? { confirmText: input.confirmText } : {}),
      auditConfirm: input.auditConfirm,
    }),
  );
  if (data.confirmed !== true || !isTargets(data.targets) || !isRecord(data.audit)) {
    throw new Error("Unexpected clean-state result response.");
  }
  return data as CleanResult;
}

export async function fetchDataLifecycleExport(
  scope: CleanScope,
  tenantId?: string,
): Promise<ExportBundle> {
  const query =
    scope === "platform"
      ? "scope=platform"
      : `scope=tenant&tenantId=${encodeURIComponent(tenantId ?? "")}`;
  const data = await send<Partial<ExportBundle>>(
    `/api/data-lifecycle/export?${query}`,
  );
  if (!isTargets(data.targets)) {
    throw new Error("Unexpected export bundle response.");
  }
  return data as ExportBundle;
}

export async function checkPlatformBootstrap(): Promise<PlatformBootstrapReport> {
  const data = await send<Partial<PlatformBootstrapReport>>(
    "/api/data-lifecycle/bootstrap",
  );
  if (!Array.isArray(data.elements)) {
    throw new Error("Unexpected platform bootstrap response.");
  }
  return data as PlatformBootstrapReport;
}

export async function initializePlatformBootstrap(): Promise<PlatformBootstrapReport> {
  const data = await send<Partial<PlatformBootstrapReport>>(
    "/api/data-lifecycle/bootstrap",
    postInit({ confirm: true }),
  );
  if (!Array.isArray(data.elements) || data.confirmed !== true) {
    throw new Error("Unexpected platform bootstrap response.");
  }
  return data as PlatformBootstrapReport;
}

export interface TenantBootstrapInput {
  tenantId: string;
  foundingAdminLogin?: string;
  claimGenesis?: boolean;
}

function isSteps(value: unknown): value is TenantBootstrapStep[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        isRecord(s) && typeof s.id === "string" && typeof s.status === "string",
    )
  );
}

async function tenantBootstrap(
  input: TenantBootstrapInput,
  confirm: boolean,
): Promise<TenantBootstrapReport> {
  const data = await send<Partial<TenantBootstrapReport>>(
    "/api/data-lifecycle/tenant-bootstrap",
    postInit({
      tenantId: input.tenantId,
      ...(input.foundingAdminLogin
        ? { foundingAdminLogin: input.foundingAdminLogin }
        : {}),
      ...(input.claimGenesis ? { claimGenesis: true } : {}),
      ...(confirm ? { confirm: true } : {}),
    }),
  );
  if (!isSteps(data.steps)) {
    throw new Error("Unexpected tenant bootstrap response.");
  }
  return data as TenantBootstrapReport;
}

export function previewTenantBootstrap(
  input: TenantBootstrapInput,
): Promise<TenantBootstrapReport> {
  return tenantBootstrap(input, false);
}

export function runTenantBootstrap(
  input: TenantBootstrapInput,
): Promise<TenantBootstrapReport> {
  return tenantBootstrap(input, true);
}
