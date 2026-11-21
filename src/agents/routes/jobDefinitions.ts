/**
 * Issue #4366 ([Stage visibility] UX workflow-definition + scheduling flow)
 * — the definition reads/writes behind the UX.
 *
 *   GET  /api/job-definitions                 the externalized catalogue
 *   POST /api/job-definitions/:id/define      define an engine job from a spec
 *
 * Defining is the first half of the flow; the second half is the schedule
 * itself, created through the existing `POST /api/schedules` with the
 * callback `runPipelineJobSchedule` (the Orchestrator host method that runs
 * one engine job). Reusing that path means the UX flow schedules through the
 * same alarm machinery every other schedule uses.
 */
import { jobDefinitionSpec, listJobDefinitionSpecs, type JobDefinitionSpec } from "../../config/jobDefinitionCatalog";
import { resolveEnumSource } from "../../config/jobDefinitionParamRegistry";
import { RETRY_BUCKET_NAMES, isRetryBucketName } from "../../services/pipelinePolicy";
import { UNIVERSES } from "../../trading";
import type { JobExecutionMode } from "../../data/jobPipelinePorts";
import type { StageRetryBucket } from "../../workflows/stageRunnerPorts";

export interface JobDefinitionDefineResult {
  jobId: string;
  name: string;
  version: number;
  stages: number;
}

export interface JobDefinitionsRouteContext {
  /** The catalogue; defaults to the built-in specs. */
  readDefinitions?: () => JobDefinitionSpec[];
  /** Define the job on the ScheduledAgent; absent = named 503. */
  defineJobFromSpec?: (
    specId: string,
    jobId: string,
    params: Record<string, unknown>,
    /** Issue #4466 — per-stage values, keyed by stage kind. */
    overrides: {
      stageParams?: Record<string, Record<string, unknown>>;
      stageModes?: Record<string, Partial<JobExecutionMode>>;
      stageSchedules?: Record<string, { intervalMinutes?: number; cron?: string }>;
      /** Issue #4775 S1 — per-stage per-unit deadline, in milliseconds. */
      stageTimeouts?: Record<string, number>;
      /** Issue #4781 S2 — per-stage fan-out cap. */
      stageMaxParallel?: Record<string, number>;
      /** Issue #4781 S2 — per-stage retry bucket. */
      stageRetryBuckets?: Record<string, StageRetryBucket>;
      /** Issue #4781 S2 — per-stage processing overrides (checkpoint interval). */
      stageProcessing?: Record<string, { checkpointEverySteps?: number }>;
    },
  ) => Promise<JobDefinitionDefineResult>;
}

const DEFINE_PATH = /(?:^|\/api)\/job-definitions\/([^/]+)\/define$/;
const LIST_PATH = /(?:^|\/api)\/job-definitions$/;

/**
 * Fill a select parameter's options from the registry that owns them
 * (today: the universe ids), so the client never hard-codes a list.
 */
function withSelectOptions(spec: JobDefinitionSpec): JobDefinitionSpec {
  const parameters = spec.parameters?.map((param) => {
    if (param.type !== "select" || (param.options && param.options.length > 0)) return param;
    if (param.enumSource) {
      return { ...param, options: resolveEnumSource(param.enumSource, spec.id) };
    }
    if (param.name === "universe") return { ...param, options: Object.keys(UNIVERSES) };
    return param;
  });
  return parameters ? { ...spec, parameters } : spec;
}

function readStageSchedules(
  value: unknown,
): Record<string, { intervalMinutes?: number; cron?: string }> | undefined {
  const raw = readStageMap(value);
  if (!raw) return undefined;
  const out: Record<string, { intervalMinutes?: number; cron?: string }> = {};
  for (const [kind, entry] of Object.entries(raw)) {
    const next: { intervalMinutes?: number; cron?: string } = {};
    if (typeof entry.intervalMinutes === "number" && Number.isFinite(entry.intervalMinutes)) {
      next.intervalMinutes = entry.intervalMinutes;
    }
    if (typeof entry.cron === "string" && entry.cron.trim()) next.cron = entry.cron.trim();
    if (next.intervalMinutes !== undefined || next.cron) out[kind] = next;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readStageMap(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [kind, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out[kind] = entry as Record<string, unknown>;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Issue #4775 S1 — read the flow's per-stage timeouts, keyed by
 * stage kind. A value is milliseconds, as a number or a numeric
 * string (the flow posts text input). An invalid value is refused
 * by NAME (naming the stage and the raw value) — the caller
 * maps it to 400 — never silently dropped or defaulted.
 */
function readStageTimeouts(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const shown = typeof raw === "string" ? `"${raw}"` : String(raw);
      throw new Error(
        `Stage "${kind}" timeout ${shown} must be a positive finite number of milliseconds.`,
      );
    }
    out[kind] = parsed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Issue #4781 S2 — read the flow's per-stage fan-out caps, keyed by
 * stage kind. A value is a shard count, as a number or a numeric
 * string (the flow posts text input). An invalid value is refused
 * by NAME — the caller maps it to 400 — never silently dropped or
 * defaulted.
 */
function readStageMaxParallel(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      const shown = typeof raw === "string" ? `"${raw}"` : String(raw);
      throw new Error(
        `Stage "${kind}" fan-out cap ${shown} must be a positive integer.`,
      );
    }
    out[kind] = parsed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Issue #4781 S2 — read the flow's per-stage retry buckets, keyed by
 * stage kind. A value must be one of the pipelinePolicy retry keys —
 * the same source the binder and the resolver validate against, so
 * the client never hard-codes a list (the list endpoint carries the
 * names). An invalid value is refused by NAME — the caller maps it
 * to 400 — never silently dropped or defaulted.
 */
function readStageRetryBuckets(
  value: unknown,
): Record<string, StageRetryBucket> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, StageRetryBucket> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isRetryBucketName(raw)) {
      const shown = typeof raw === "string" ? `"${raw}"` : String(raw);
      throw new Error(
        `Stage "${kind}" retryBucket ${shown} is invalid — a stage retries under one of: ${RETRY_BUCKET_NAMES.join(", ")}.`,
      );
    }
    out[kind] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Issue #4781 S2 — read the flow's per-stage processing overrides,
 * keyed by stage kind. An entry is an object; its checkpoint
 * interval is a positive integer, as a number or a numeric string
 * (the flow posts text input). An invalid value is refused by NAME
 * — the caller maps it to 400 — never silently dropped or
 * defaulted.
 */
function readStageProcessing(
  value: unknown,
): Record<string, { checkpointEverySteps?: number }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, { checkpointEverySteps?: number }> = {};
  for (const [kind, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Stage "${kind}" processing override must be an object.`,
      );
    }
    const raw = (entry as Record<string, unknown>).checkpointEverySteps;
    if (raw === undefined) continue;
    const parsed =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      const shown = typeof raw === "string" ? `"${raw}"` : String(raw);
      throw new Error(
        `Stage "${kind}" processing.checkpointEverySteps ${shown} must be a positive integer.`,
      );
    }
    out[kind] = { checkpointEverySteps: parsed };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function handleJobDefinitionsRoutes(
  request: Request,
  url: URL,
  path: string,
  ctx: JobDefinitionsRouteContext,
): Promise<Response | null> {
  const defineMatch = DEFINE_PATH.exec(path);
  const listMatch = defineMatch ? null : LIST_PATH.exec(path);
  if (!defineMatch && !listMatch) return null;

  if (listMatch) {
    if (request.method !== "GET") return null;
    const definitions = (ctx.readDefinitions ?? listJobDefinitionSpecs)().map(withSelectOptions);
    return Response.json({
      count: definitions.length,
      definitions,
      // Issue #4781 S2 — the retry-bucket names the define view
      // offers per stage, from the same source the server validates
      // against (pipelinePolicy retry keys), so the client never
      // hard-codes a list.
      retryBuckets: [...RETRY_BUCKET_NAMES],
    });
  }

  if (request.method !== "POST") return null;
  const specId = decode(defineMatch![1]);
  let spec: JobDefinitionSpec;
  try {
    spec = jobDefinitionSpec(specId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
  if (!ctx.defineJobFromSpec) {
    return Response.json(
      { error: `Defining job "${specId}" is unavailable: this surface has no pipeline host.` },
      { status: 503 },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // An empty body is allowed: the caller may rely on the spec's defaults.
  }
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  if (!jobId) {
    return Response.json(
      {
        error: `Defining the "${specId}" job requires a jobId in the body — one is never invented.`,
      },
      { status: 400 },
    );
  }
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const stageParams = readStageMap(body.stageParams);
  const stageModes = readStageMap(body.stageModes) as
    | Record<string, Partial<JobExecutionMode>>
    | undefined;
  const stageSchedules = readStageSchedules(body.stageSchedules);
  try {
    // Issue #4775 S1 — read inside the try: an invalid timeout
    // refuses by name here and maps to 400 below.
    const stageTimeouts = readStageTimeouts(body.stageTimeouts);
    // Issue #4781 S2 — same: an invalid cap, bucket, or checkpoint
    // interval refuses by name here and maps to 400 below.
    const stageMaxParallel = readStageMaxParallel(body.stageMaxParallel);
    const stageRetryBuckets = readStageRetryBuckets(body.stageRetryBuckets);
    const stageProcessing = readStageProcessing(body.stageProcessing);
    const defined = await ctx.defineJobFromSpec(spec.id, jobId, params, {
      ...(stageParams ? { stageParams } : {}),
      ...(stageModes ? { stageModes } : {}),
      ...(stageSchedules ? { stageSchedules } : {}),
      ...(stageTimeouts ? { stageTimeouts } : {}),
      ...(stageMaxParallel ? { stageMaxParallel } : {}),
      ...(stageRetryBuckets ? { stageRetryBuckets } : {}),
      ...(stageProcessing ? { stageProcessing } : {}),
    });
    return Response.json({
      ...defined,
      specId: spec.id,
      specVersion: spec.version,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /is invalid|must be|requires/.test(message) ? 400 : 503;
    return Response.json({ error: message, specId }, { status });
  }
}
