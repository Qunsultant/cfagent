/**
 * Issue #2903 — Timestamped recommendation portfolios with full lineage, for
 * historical comparison and portfolio construction from any stage at any time
 * without re-fetching, re-analysing from live data, or overwriting source
 * snapshots.
 *
 * Persists snapshots immutably in the existing canonical `mas_reports` store
 * (`source = "recommendation_snapshot"`, `generationId = "rec-snap:<id>"`)
 * via `scheduledReports.ts` so zero new DDL or raw SQL DML is introduced.
 */
import type { SqlStorage } from "../orm";
import {
  ensureScheduledReportsTable,
  listScheduledReports,
  storeReportAtGeneration,
} from "./scheduledReports";

export type RecommendationSnapshotKind =
  | "individual"
  | "combination-template"
  | "portfolio-combination";

export interface RecommendationLeg {
  instrument: string;
  direction: "buy" | "sell";
  strike?: number | null;
  expiry?: string | null;
  quantity: number;
  premium?: number | null;
}

export interface NetGreeksSnapshot {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface RecommendationSnapshotLineage {
  sourceRunId: string;
  captureIds: string[];
  stage: string;
  engineVersion?: string | null;
  templateId?: string | null;
  templateVersion?: string | null;
  derivedFromSnapshotIds?: string[];
}

export interface RecommendationSnapshot {
  snapshotId: string;
  runId: string;
  userLogin: string;
  tenantId: string;
  recommendationId: string;
  kind: RecommendationSnapshotKind;
  symbols: string[];
  thesis: string | null;
  /** Snapshot creation instant in UTC ISO-8601 (never conflated with dataAsOf). */
  capturedAtUtc: string;
  /** As-of date/timestamp of the underlying market data. */
  dataAsOf: string;
  legs: RecommendationLeg[];
  netPremium: number | null;
  netGreeks: NetGreeksSnapshot;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  capitalAtRisk: number | null;
  payoffCurve: Array<{ price: number; pnl: number }>;
  lineage: RecommendationSnapshotLineage;
}

const SNAPSHOT_SOURCE = "recommendation_snapshot";

function parseSnapshot(body: string): RecommendationSnapshot | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as RecommendationSnapshot;
    return parsed && typeof parsed.snapshotId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist an immutable timestamped recommendation snapshot. Idempotent on
 * `snapshotId`: an existing snapshot is never overwritten.
 */
export function createRecommendationSnapshot(
  sql: SqlStorage,
  snapshot: RecommendationSnapshot,
): { snapshotId: string; created: boolean } {
  ensureScheduledReportsTable(sql);
  const stored = storeReportAtGeneration(sql, {
    runId: snapshot.runId,
    generationId: `rec-snap:${snapshot.snapshotId}`,
    title: `Recommendation Snapshot (${snapshot.symbols.join(", ")})`,
    source: SNAPSHOT_SOURCE,
    summary: snapshot.thesis ?? `${snapshot.kind} (${snapshot.legs.length} legs)`,
    body: snapshot as unknown as Record<string, unknown>,
    createdAt: snapshot.capturedAtUtc,
    userLogin: snapshot.userLogin,
  });
  return { snapshotId: snapshot.snapshotId, created: Boolean(stored?.created) };
}

export function getRecommendationSnapshot(
  sql: SqlStorage,
  tenantId: string,
  userLogin: string,
  snapshotId: string,
): RecommendationSnapshot | null {
  return (
    listRecommendationSnapshots(sql, tenantId, userLogin, 200).find(
      (s) => s.snapshotId === snapshotId,
    ) ?? null
  );
}

export function listRecommendationSnapshots(
  sql: SqlStorage,
  tenantId: string,
  userLogin: string,
  limit = 50,
): RecommendationSnapshot[] {
  ensureScheduledReportsTable(sql);
  const hits = listScheduledReports(sql, {
    sourceFilter: SNAPSHOT_SOURCE,
    userLogin,
    limit,
  });
  return hits
    .map((h) => parseSnapshot(h.body))
    .filter(
      (s): s is RecommendationSnapshot =>
        s !== null && s.tenantId === tenantId,
    );
}

function sumNullable(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return finite.length > 0 ? finite.reduce((a, b) => a + b, 0) : null;
}

/**
 * Construct a new immutable portfolio-combination snapshot from ANY stored
 * snapshots at any time, without live fetches or mutating source snapshots.
 */
export function constructPortfolioFromSnapshots(
  sql: SqlStorage,
  input: {
    snapshotId?: string;
    runId: string;
    userLogin: string;
    tenantId: string;
    sourceSnapshotIds: string[];
    thesis?: string | null;
  },
): { ok: true; snapshot: RecommendationSnapshot } | { ok: false; error: string } {
  if (input.sourceSnapshotIds.length === 0) {
    return { ok: false, error: "At least one sourceSnapshotId is required to construct a portfolio." };
  }
  const sources: RecommendationSnapshot[] = [];
  for (const id of input.sourceSnapshotIds) {
    const found = getRecommendationSnapshot(sql, input.tenantId, input.userLogin, id);
    if (!found) {
      return {
        ok: false,
        error: `Source recommendation snapshot "${id}" not found for owner; refusing to construct partial portfolio.`,
      };
    }
    sources.push(found);
  }

  const snapshotId = input.snapshotId?.trim() || `portfolio:${crypto.randomUUID()}`;
  const symbols = Array.from(new Set(sources.flatMap((s) => s.symbols)));
  const legs = sources.flatMap((s) => s.legs);
  const captureIds = Array.from(new Set(sources.flatMap((s) => s.lineage.captureIds)));
  const dataAsOf = sources.map((s) => s.dataAsOf).sort()[0] ?? new Date().toISOString();

  const composite: RecommendationSnapshot = {
    snapshotId,
    runId: input.runId,
    userLogin: input.userLogin,
    tenantId: input.tenantId,
    recommendationId: snapshotId,
    kind: "portfolio-combination",
    symbols,
    thesis: input.thesis ?? (sources.map((s) => s.thesis).filter(Boolean).join(" + ") || null),
    capturedAtUtc: new Date().toISOString(),
    dataAsOf,
    legs,
    netPremium: sumNullable(sources.map((s) => s.netPremium)),
    netGreeks: {
      delta: sumNullable(sources.map((s) => s.netGreeks.delta)),
      gamma: sumNullable(sources.map((s) => s.netGreeks.gamma)),
      theta: sumNullable(sources.map((s) => s.netGreeks.theta)),
      vega: sumNullable(sources.map((s) => s.netGreeks.vega)),
    },
    maxProfit: sumNullable(sources.map((s) => s.maxProfit)),
    maxLoss: sumNullable(sources.map((s) => s.maxLoss)),
    breakevens: Array.from(new Set(sources.flatMap((s) => s.breakevens))).sort((a, b) => a - b),
    capitalAtRisk: sumNullable(sources.map((s) => s.capitalAtRisk)),
    payoffCurve: [],
    lineage: {
      sourceRunId: input.runId,
      captureIds,
      stage: "portfolio-construction",
      derivedFromSnapshotIds: sources.map((s) => s.snapshotId),
    },
  };

  createRecommendationSnapshot(sql, composite);
  return { ok: true, snapshot: composite };
}
