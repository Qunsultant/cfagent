/**
 * Client for the opportunity scanner and saved strategy profiles —
 * issue #84 slice 1, surfacing the backends from #23 (scan modes),
 * #24 (fit gate) and #28 (saved strategy profiles).
 *
 * Wire shapes, pinned against the server code:
 *  - POST /api/trading/options/unified with action "opportunities"
 *    returns the service's formatForUi() envelope: the whole
 *    OpportunityScanResult spread at the TOP LEVEL of the body, plus
 *    `action`, `meta`, and `success`. A failed profile resolution comes
 *    back as `{ error: "..." }` with success:false at HTTP 200, so the
 *    error FIELD — not just the status — decides failure.
 *  - /api/etrade/options/profiles[/:id] is the #28 CRUD surface: list
 *    returns `{ count, profiles }`; create/update return the stored
 *    profile directly; validation and duplicate-name failures are
 *    400 `{ error: "..." }` whose message is surfaced verbatim.
 *
 * Slice 5 adds the scan-history client for the #27 read API:
 *  - GET /api/etrade/options/scans?limit=&offset= returns
 *    `{ count, scans }` (ScanRunSummary rows, newest first);
 *  - GET /api/etrade/options/scans/:id returns the StoredScanRun
 *    directly (summary fields + the full stored result);
 *  - GET /api/etrade/options/scans/diff?from=&to= returns
 *    `{ from: { id, generatedAt }, to: { id, generatedAt }, diff }`.
 *    The diff route is declared before the by-id route server-side
 *    precisely so "diff" is never read as a run id. Failures are
 *    non-200 `{ error: "..." }` ("scan run not found" when a run was
 *    pruned) whose message is surfaced verbatim. Since issue #103 the
 *    scans handlers scope by the x-user-login header exactly like the
 *    profiles routes: runs saved under a login are visible only to
 *    it, and a run outside the caller's scope reads as the same 404
 *    as a pruned one; legacy runs saved before scoping carry no login
 *    and stay visible to everyone. Summaries also carry the run's
 *    profileRef, so history rows label the profile without a fetch
 *    per row.
 *
 * Type-only imports from the server modules keep the shapes
 * single-sourced (the portfolioRiskApi pattern). All HTTP goes through
 * apiFetch, which transparently polls the worker's 202 async-job stub
 * (issue #71) — never the global fetch.
 */

/**
 * Issue #3295: a coded refusal for a scanner surface with no neutral backend
 * yet. Thrown BEFORE any request, so another broker never reaches
 * `/api/etrade/options/*` and never sees E*TRADE profiles or scan history.
 */
export class ScannerUnavailableError extends Error {
  readonly code = "provider_unsupported";
  constructor(brokerId: string) {
    super(
      `Saved strategy profiles and scan history are not available for the selected broker (${brokerId}); no other broker's runs are shown in their place.`,
    );
    this.name = "ScannerUnavailableError";
  }
}

import { apiFetch } from "./apiFetch";
import type {
  OpportunityScanResult,
  ScanMode,
} from "../trading";
import type {
  StrategyProfile,
  StrategyProfileSpec,
} from "../trading";
import type {
  ScanRunDiff,
  ScanRunSummary,
  StoredScanRun,
} from "../trading";
import type { UnifiedOptionsRequest } from "../trading";

export type {
  OpportunityScanResult,
  ScanMode,
  StrategyProfile,
  StrategyProfileSpec,
  ScanRunDiff,
  ScanRunSummary,
  StoredScanRun,
};

/** The unified route's UI envelope for the opportunities action:
 *  OpportunityScanResult fields at the top level (formatForUi spread),
 *  plus the envelope fields. scanRunId/persisted ride along when the
 *  route's scan-run store saved the run (issue #27). */
export interface OpportunityScanResponse extends OpportunityScanResult {
  action: string;
  success: boolean;
  reportUrl?: string;
  scanRunId?: string;
  persisted?: boolean;
  meta?: {
    generatedAt?: string;
    environment?: string;
    cached?: boolean;
    underlyingsCount?: number;
  };
}

function headers(env: string, userLogin?: string, json = false): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "x-environment": env,
    ...(userLogin ? { "x-user-login": userLogin } : {}),
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Shape guard in the fetchAlerts idiom (issue #71): array fields a
 * partial/odd payload may omit are coerced to [] so the panel renders
 * honest empty states instead of crashing on `.map` of undefined. A
 * body that is not an object at all is an error, never a result.
 */
export function coerceScanResponse(data: unknown): OpportunityScanResponse {
  if (!data || typeof data !== "object") {
    throw new Error("Unexpected scanner response shape — the scan payload was incomplete.");
  }
  const raw = data as Record<string, unknown>;
  return {
    ...(raw as unknown as OpportunityScanResponse),
    opportunities: asArray(raw.opportunities),
    fits: asArray(raw.fits),
    borderline: asArray(raw.borderline),
    skipped: asArray(raw.skipped),
    assumptions: asArray(raw.assumptions),
    matrix: asArray(raw.matrix),
    typeRollup: asArray(raw.typeRollup),
  };
}

/** Run an opportunity scan through the unified options service. The
 *  caller builds the body (mode is always explicit — issue #84's core
 *  acceptance rule); this function pins action "opportunities". */
export async function runOpportunityScan(
  activeEnv: string,
  userLogin: string | undefined,
  body: UnifiedOptionsRequest,
): Promise<OpportunityScanResponse> {
  const resp = await apiFetch("/api/trading/options/unified", {
    method: "POST",
    headers: headers(activeEnv, userLogin, true),
    body: JSON.stringify({ ...body, action: "opportunities", pushToSlack: true }),
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Scanner request failed (${resp.status})`);
  // The unified service reports a failed profile resolution (and other
  // action errors) as an `error` field on a 200 envelope — that is a
  // failed scan, never a result with no rows.
  if (typeof data.error === "string" && data.error) throw new Error(data.error);
  return coerceScanResponse(data);
}

// Saved strategy profiles (issue #28 CRUD) ------------------------------

const PROFILES_PATH = "/api/etrade/options/profiles";

export async function listProfiles(
  activeEnv: string,
  userLogin?: string,
): Promise<StrategyProfile[]> {
  const resp = await apiFetch(PROFILES_PATH, { headers: headers(activeEnv, userLogin) });
  const data = (await resp.json().catch(() => ({}))) as { profiles?: unknown; error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to list strategy profiles (${resp.status})`);
  return asArray<StrategyProfile>(data.profiles);
}

export async function getProfile(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
): Promise<StrategyProfile> {
  const resp = await apiFetch(`${PROFILES_PATH}/${encodeURIComponent(id)}`, {
    headers: headers(activeEnv, userLogin),
  });
  const data = (await resp.json().catch(() => ({}))) as StrategyProfile & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to fetch strategy profile (${resp.status})`);
  return data;
}

export async function createProfile(
  activeEnv: string,
  userLogin: string | undefined,
  name: string,
  spec: StrategyProfileSpec,
): Promise<StrategyProfile> {
  const resp = await apiFetch(PROFILES_PATH, {
    method: "POST",
    headers: headers(activeEnv, userLogin, true),
    body: JSON.stringify({ name, ...spec }),
  });
  const data = (await resp.json().catch(() => ({}))) as StrategyProfile & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to create strategy profile (${resp.status})`);
  return data;
}

export async function updateProfile(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
  name: string,
  spec: StrategyProfileSpec,
): Promise<StrategyProfile> {
  const resp = await apiFetch(`${PROFILES_PATH}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: headers(activeEnv, userLogin, true),
    body: JSON.stringify({ name, ...spec }),
  });
  const data = (await resp.json().catch(() => ({}))) as StrategyProfile & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to update strategy profile (${resp.status})`);
  return data;
}

export async function deleteProfile(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
): Promise<void> {
  const resp = await apiFetch(`${PROFILES_PATH}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(activeEnv, userLogin),
  });
  const data = (await resp.json().catch(() => ({}))) as { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to delete strategy profile (${resp.status})`);
}

// Scan history (issue #27 read API) --------------------------------------

const SCANS_PATH = "/api/etrade/options/scans";

/** A stored scan run ready for display: the summary fields plus the
 *  full result, coerced through the same shape guard as a live scan
 *  response so ScanResultsView gets its guarded shape. */
export interface ScanRunDetail extends ScanRunSummary {
  result: OpportunityScanResponse;
}

/** The diff route's envelope: both runs' stamps plus the diff. */
export interface ScanRunDiffResult {
  from: { id: string; generatedAt: string };
  to: { id: string; generatedAt: string };
  diff: ScanRunDiff;
}

/** Newest-first summaries of the persisted scan runs. */
export async function listScanRuns(
  activeEnv: string,
  userLogin?: string,
  limit?: number,
): Promise<ScanRunSummary[]> {
  const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
  const resp = await apiFetch(`${SCANS_PATH}${query}`, { headers: headers(activeEnv, userLogin) });
  const data = (await resp.json().catch(() => ({}))) as { scans?: unknown; error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to list scan runs (${resp.status})`);
  return asArray<ScanRunSummary>(data.scans);
}

/** One persisted run with its full stored result. A pruned or unknown
 *  id is the route's 404 "scan run not found", surfaced verbatim. */
export async function getScanRun(
  activeEnv: string,
  userLogin: string | undefined,
  id: string,
): Promise<ScanRunDetail> {
  const resp = await apiFetch(`${SCANS_PATH}/${encodeURIComponent(id)}`, {
    headers: headers(activeEnv, userLogin),
  });
  const data = (await resp.json().catch(() => ({}))) as StoredScanRun & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to fetch scan run (${resp.status})`);
  if (!data.result || typeof data.result !== "object") {
    throw new Error("Unexpected scan run shape — the stored run payload was incomplete.");
  }
  return { ...data, result: coerceScanResponse(data.result) };
}

/** Run-over-run diff: `fromId` is the older run (the diff's `a`),
 *  `toId` the newer (its `b`) — newFits are fits in `to` that were not
 *  fits in `from`. Computed server-side by diffScanRuns; the arrays
 *  are shape-guarded here, never recomputed. */
export async function getScanRunDiff(
  activeEnv: string,
  userLogin: string | undefined,
  fromId: string,
  toId: string,
): Promise<ScanRunDiffResult> {
  const params = new URLSearchParams({ from: fromId, to: toId });
  const resp = await apiFetch(`${SCANS_PATH}/diff?${params.toString()}`, {
    headers: headers(activeEnv, userLogin),
  });
  const data = (await resp.json().catch(() => ({}))) as Partial<ScanRunDiffResult> & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Failed to diff scan runs (${resp.status})`);
  if (!data.diff || typeof data.diff !== "object") {
    throw new Error("Unexpected diff shape — the diff payload was incomplete.");
  }
  const diff = data.diff as ScanRunDiff;
  return {
    from: data.from ?? { id: fromId, generatedAt: "" },
    to: data.to ?? { id: toId, generatedAt: "" },
    diff: {
      newFits: asArray(diff.newFits),
      droppedFits: asArray(diff.droppedFits),
      stillFitting: asArray(diff.stillFitting),
      bucketChanges: asArray(diff.bucketChanges),
      addedSymbols: asArray(diff.addedSymbols),
      removedSymbols: asArray(diff.removedSymbols),
    },
  };
}
