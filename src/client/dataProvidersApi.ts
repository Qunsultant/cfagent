/**
 * Client for the data-provider lifecycle endpoints (issue #1180,
 * E4 of epic #1116; server: issue #1170 in
 * src/agents/routes/dataProviders.ts):
 *
 *   GET  /api/data-providers
 *   POST /api/data-providers/:id/register|configure|verify|enable|disable|deprovision
 *
 * The view types below mirror the server's GET shapes field-for-field
 * (providerView + routeServability there). The panel renders what the
 * API returns — servability in particular is the registry's own rule
 * computed server-side; nothing here recomputes it.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule — the
 * worker may answer with a 202 async-job stub that only apiFetch
 * resolves).
 */

import { apiFetch } from "./apiFetch";

/** Verification evidence recorded by a passing verify (E3: config.verification). */
export interface DataProviderVerification {
  verifiedAt: string;
  summary: string;
  verifiedBy: string;
}

/**
 * Health status derived server-side from capture records (E6,
 * issue #1235): "no-data" means the provider has no captures at
 * all — an honest unknown, never rendered as healthy.
 */
export type DataProviderHealthStatus = "healthy" | "degraded" | "down" | "no-data";

/** Usage + outcome aggregates over a provider's (or capability's) captures (E6). */
export interface DataProviderCaptureAggregates {
  totalCaptures: number;
  capturedCount: number;
  failedCount: number;
  /** failedCount / totalCaptures; 0 when there are no captures. */
  failureRate: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  /** Bytes actually stored for `captured` records. */
  totalRawBytes: number;
  capturesLast24h: number;
  failuresLast24h: number;
  /**
   * E7 (issue #1248) fetch-outcome fields — OPTIONAL here because
   * an older API response omits them; the panel renders the fetch
   * line only when they are present and never derives them.
   */
  fetchAttempts?: number;
  fetchFailures?: number;
  /** fetchFailures / fetchAttempts; 0 when there were no attempts. */
  fetchFailureRate?: number;
  /** Capture-write failures, reported separately from fetch failures. */
  captureFailures?: number;
  lastFetchFailureAt?: string | null;
  fetchConsecutiveFailures?: number;
  /** The classified kind of the most recent fetch failure. */
  latestFetchFailureKind?: DataProviderFetchFailureKind | null;
}

/** The classified kinds a failed provider fetch can carry (E7). */
export type DataProviderFetchFailureKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "upstream"
  | "parse"
  | "unknown";

/** The E6 health block on each provider view (server-derived; the panel only formats). */
export interface DataProviderHealth extends DataProviderCaptureAggregates {
  status: DataProviderHealthStatus;
  byCapability: Record<string, DataProviderCaptureAggregates>;
}

/** One provider as the E3 GET surface serves it (providerView). */
export interface DataProviderView {
  id: string;
  adapterKind: string;
  lifecycleState: string;
  enabled: boolean;
  precedence: number;
  /** The credential REFERENCE name only — never a secret value. */
  credentialRef: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  declaredCapabilities: string[];
  verification: DataProviderVerification | null;
  /** Whether any capability route currently resolves to this provider. */
  serving: boolean;
  /** Capture-derived health + usage metering (E6, issue #1235). */
  health: DataProviderHealth;
}

/** One capability route as the E3 GET surface serves it (routeServability). */
/** Offering tier a route requires of its callers (E5, issue #1202). */
export type DataProviderTier = "freemium" | "premium";

export interface CapabilityRouteView {
  capability: string;
  primaryProviderId: string;
  gapFillProviderId: string | null;
  /** Minimum caller tier served through this route (E5). */
  minTier: DataProviderTier;
  resolves: boolean;
  resolvedPrimaryId: string | null;
  resolvedGapFillId: string | null;
  error?: string;
}

export interface DataProvidersList {
  providers: DataProviderView[];
  routes: CapabilityRouteView[];
}

export type DataProviderActionName =
  | "configure"
  | "verify"
  | "enable"
  | "disable"
  | "deprovision";

/**
 * The actions the panel offers for a provider, mirroring the legal
 * map the E3 lifecycle service enforces (lifecycle.ts):
 *
 *   configure:   registered | configured
 *   verify:      configured
 *   enable:      verified, or disabled WITH verification evidence
 *   disable:     enabled
 *   deprovision: any state except deprovisioned (terminal)
 *
 * (register is not a per-provider action — it creates the record.)
 * The server remains the authority: it re-checks every move and the
 * panel surfaces its rejection verbatim.
 */
export function providerActions(view: DataProviderView): DataProviderActionName[] {
  switch (view.lifecycleState) {
    case "registered":
      return ["configure", "deprovision"];
    case "configured":
      return ["configure", "verify", "deprovision"];
    case "verified":
      return ["enable", "deprovision"];
    case "enabled":
      return ["disable", "deprovision"];
    case "disabled":
      return view.verification
        ? ["enable", "deprovision"]
        : ["deprovision"];
    default:
      return [];
  }
}

/** Display name: config.displayName when the record carries one, else the id. */
export function providerDisplayName(view: DataProviderView): string {
  const name = view.config?.displayName;
  return typeof name === "string" && name !== "" ? name : view.id;
}

/**
 * One request seam. A failed response carries the server's own explanation
 * when it sent one: the JSON `error`, or — for a body that is not JSON
 * (an edge/error-boundary page, a truncated response) — the first lines of
 * the raw text, clamped. A bare `Request failed (500)` told the operator
 * nothing, which is why the Data Providers surface could not be diagnosed
 * from the UI (issue #2624 fix-up).
 */
async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const raw = await resp.text().catch(() => "");
  let data = {} as T & { error?: string; code?: string };
  if (raw) {
    try {
      data = JSON.parse(raw) as T & { error?: string; code?: string };
    } catch {
      data = {} as T & { error?: string; code?: string };
    }
  }
  if (!resp.ok) {
    const bodyHint = !raw
      ? ""
      : raw.startsWith("<")
        ? " (HTML error page from the edge — see Worker logs)"
        : `: ${raw.replace(/\s+/g, " ").trim().slice(0, 200)}`;
    const message = data.error || `Request failed (${resp.status})${bodyHint}`;
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = resp.status;
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}

export async function fetchDataProviders(): Promise<DataProvidersList> {
  const data = await send<Partial<DataProvidersList>>("/api/data-providers");
  // Shape guard (issue #71): never hand the renderer a non-array.
  return {
    providers: Array.isArray(data?.providers) ? data.providers : [],
    routes: Array.isArray(data?.routes) ? data.routes : [],
  };
}

export async function postDataProviderAction(
  id: string,
  action: DataProviderActionName | "register",
  body?: Record<string, unknown>
): Promise<void> {
  await send<{ provider: unknown }>(
    `/api/data-providers/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      ...(body !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }
  );
}

/** Timestamp rendering, same convention as the API keys panel. */
export function fmtDataProviderTime(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Plain byte-count rendering for the E6 captured-data total (formatting only). */
export function fmtCaptureBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}
