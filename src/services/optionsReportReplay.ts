/**
 * Issue #2862 — Options report replay: reproduce any report at any time from
 * stored fetched (`mas_data_captures`) and enriched/evaluated data, without
 * re-fetching live data or calling any broker.
 *
 * Refuses loudly (coded outcome) when the source run, its canonical body (for
 * R2-pointer rows with missing/unresolvable objects), or its stored captures
 * are absent. Never overwrites the original run, its artifacts, or deliveries.
 */
import type { SqlStorage } from "../orm";
import { listCapturesByRun } from "../data/doSqliteProviderCaptureAdapter";
import type { DataCaptureRecord } from "../data/providerCapturePorts";
import {
  resolveCanonicalReportBody,
  type ScheduledReportHit,
} from "./scheduledReports";
import {
  recordUnifiedOptionsRun,
  type OptionsCanonicalStore,
} from "./optionsServeRecord";

export type ReplayFailureCode =
  | "FAILURE_REPLAY_RUN_NOT_FOUND"
  | "FAILURE_REPLAY_BODY_UNRESOLVED"
  | "FAILURE_REPLAY_CAPTURES_ABSENT";

export interface ReplayOptionsReportInput {
  sourceRunId: string;
  replayRunId?: string;
  tenantId: string;
  userLogin: string;
  /** Default true: refuse when no stored captures exist for the run. */
  requireCaptures?: boolean;
}

export interface ReplayOptionsReportDeps {
  sql: SqlStorage;
  orm: OptionsCanonicalStore;
  env?: Record<string, unknown>;
  findSourceReport: (sourceRunId: string, userLogin: string) => Promise<ScheduledReportHit | null>;
  listCaptures?: (tenantId: string, runId: string) => DataCaptureRecord[];
  resolveBody?: (hit: ScheduledReportHit) => Promise<string | null>;
}

export type ReplayOptionsReportResult =
  | {
      ok: true;
      replayRunId: string;
      reportId: string | null;
      replayedFrom: {
        runId: string;
        reportId: string;
        captureIds: string[];
        bodyR2Key: string | null;
      };
      captureCount: number;
    }
  | {
      ok: false;
      code: ReplayFailureCode;
      error: string;
    };

export async function replayOptionsReport(
  deps: ReplayOptionsReportDeps,
  input: ReplayOptionsReportInput,
): Promise<ReplayOptionsReportResult> {
  const sourceRunId = input.sourceRunId.trim();
  const hit = await deps.findSourceReport(sourceRunId, input.userLogin);
  if (!hit) {
    return {
      ok: false,
      code: "FAILURE_REPLAY_RUN_NOT_FOUND",
      error: `Replay refused (${sourceRunId}): original report not found for owner.`,
    };
  }

  const rawBody = deps.resolveBody
    ? await deps.resolveBody(hit)
    : await resolveCanonicalReportBody((deps.env ?? {}) as any, hit);
  if (!rawBody) {
    return {
      ok: false,
      code: "FAILURE_REPLAY_BODY_UNRESOLVED",
      error: hit.bodyR2Key
        ? `Replay refused (${sourceRunId}): R2 pointer "${hit.bodyR2Key}" could not be resolved.`
        : `Replay refused (${sourceRunId}): stored canonical body is empty or missing.`,
    };
  }

  let parsedBody: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        code: "FAILURE_REPLAY_BODY_UNRESOLVED",
        error: `Replay refused (${sourceRunId}): stored canonical body is not a JSON object.`,
      };
    }
    parsedBody = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      code: "FAILURE_REPLAY_BODY_UNRESOLVED",
      error: `Replay refused (${sourceRunId}): stored canonical body is invalid JSON.`,
    };
  }

  const captureRunId =
    typeof parsedBody.scanRunId === "string" && parsedBody.scanRunId
      ? parsedBody.scanRunId
      : hit.runId || sourceRunId;
  const captures = deps.listCaptures
    ? deps.listCaptures(input.tenantId, captureRunId)
    : listCapturesByRun(deps.sql, input.tenantId, captureRunId);
  const embeddedCaptureIds = Array.isArray(parsedBody.captureIds)
    ? parsedBody.captureIds.filter((c): c is string => typeof c === "string" && c.length > 0)
    : [];
  const captureIds = Array.from(
    new Set([...captures.map((c) => c.id), ...embeddedCaptureIds]),
  );

  if (input.requireCaptures !== false && captures.length === 0 && captureIds.length === 0) {
    return {
      ok: false,
      code: "FAILURE_REPLAY_CAPTURES_ABSENT",
      error: `Replay refused (${sourceRunId}): no stored mas_data_captures or captureIds found; live re-fetch is forbidden.`,
    };
  }

  const replayRunId = input.replayRunId?.trim() || `replay:${sourceRunId}:${crypto.randomUUID().slice(0, 8)}`;
  const r2Pointer = hit.bodyR2Key ?? null;
  const replayedFrom = {
    runId: sourceRunId,
    reportId: hit.id,
    captureIds,
    bodyR2Key: r2Pointer,
  };

  const recorded = await recordUnifiedOptionsRun(
    deps.orm,
    {
      runId: replayRunId,
      generationId: `replay:${replayRunId}`,
      title: `${hit.title} (Replay)`,
      source: hit.source,
      summary: hit.summary,
      trigger: "manual",
      strategyMode:
        parsedBody.strategyMode === "thesis" ||
        parsedBody.strategyMode === "all" ||
        parsedBody.strategyMode === "no-view"
          ? parsedBody.strategyMode
          : undefined,
      candidateLimit: typeof parsedBody.candidateLimit === "number" ? parsedBody.candidateLimit : undefined,
      alternatives: typeof parsedBody.alternatives === "number" ? parsedBody.alternatives : undefined,
      farDated: typeof parsedBody.farDated === "boolean" ? parsedBody.farDated : undefined,
      allowedStrategiesResolved: Array.isArray(parsedBody.allowedStrategiesResolved)
        ? parsedBody.allowedStrategiesResolved.filter((s): s is string => typeof s === "string")
        : undefined,
      symbol: typeof parsedBody.symbol === "string" ? parsedBody.symbol : undefined,
      thesis: typeof parsedBody.thesis === "string" ? parsedBody.thesis : undefined,
      scanRunId: typeof parsedBody.scanRunId === "string" ? parsedBody.scanRunId : undefined,
      filter: parsedBody.filter,
      result: parsedBody.result && typeof parsedBody.result === "object"
        ? (parsedBody.result as Record<string, unknown>)
        : undefined,
      provenance: {
        ...(parsedBody.provenance && typeof parsedBody.provenance === "object"
          ? (parsedBody.provenance as Record<string, unknown>)
          : {}),
        replayMode: "stored-data-only",
        replayedAt: new Date().toISOString(),
        sourceRunId,
        captureIds,
      },
      replayedFrom,
      createdAt: new Date().toISOString(),
      userLogin: input.userLogin,
    },
    deps.env,
  );

  return {
    ok: true,
    replayRunId,
    reportId: recorded?.reportId ?? null,
    replayedFrom,
    captureCount: captureIds.length,
  };
}
