/**
 * Issue #4366 (correction) — from the flow's parameter values to the run
 * parameters a family's steps actually read.
 *
 * A definition spec declares which parameters a caller may supply; this
 * module validates that set (no undeclared key is silently ignored, no
 * required key is silently absent) and binds the family's run parameters.
 * The screener's feed stage needs shards, so `universe` is translated to
 * the broker's own shard derivation — the same function the mesh door uses,
 * never a second shard policy.
 *
 * Issue #5493 — a parameter that names a vocabulary axis resolves through
 * the one reader (#5515) at bind time: an alias binds to its canonical id,
 * an unknown value refuses by name, and a conflated value refuses with the
 * pointer to the axis it belongs to. The family carries no copy of an
 * axis's values, so a data-only vocabulary addition reaches this binder
 * with no code change.
 */
import type { JobDefinitionParameter, JobDefinitionSpec, JobParameterSettingRef } from "../config/jobDefinitionCatalog";
import { resolveEnumSource, resolveParamDerivation } from "../config/jobDefinitionParamRegistry";
import { VOCABULARY_CODES, resolveValue } from "../config/vocabulary";
import type { JobExecutionMode } from "../data/jobPipelinePorts";
import type { DataProviderCapability } from "../trading";
import { assertExecutionModeSupported, resolveExecutionMode } from "./jobPipelineConfig";
import type { JobDefinitionPerStage } from "./jobDefinitionSpecBuilder";
import { dataProviderDeclaredCapabilities } from "./optionsProviderContext";
import { RETRY_BUCKET_NAMES, isRetryBucketName } from "./pipelinePolicy";
import type { StageRetryBucket } from "../workflows/stageRunnerPorts";

export type JobDefinitionParams = Record<string, unknown>;
export type SettingResolver = (settingKey: string) => unknown;

type ParamBinder = (
  spec: JobDefinitionSpec,
  params: JobDefinitionParams,
  owner: string | undefined,
) => JobDefinitionParams;

/**
 * @deprecated Issue #5496 — superseded by `bindJobDefinitionParams` and
 * `src/config/jobDefinitionParamRegistry.ts` (`ENUM_SOURCES`, `PARAM_DERIVATIONS`).
 */
export const BINDERS: Record<string, ParamBinder> = {};

function isSettingRef(value: unknown): value is JobParameterSettingRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as JobParameterSettingRef).setting === "string"
  );
}

/**
 * Issue #5493 — one axis value through the one vocabulary reader. The
 * refusal carries the vocabulary's own code, so the binder, the API and a
 * picker speak the same refusal language, and an alias binds canonically.
 */
function assertAxisValue(specId: string, param: JobDefinitionParameter, raw: string): string {
  if (!param.axis) return raw;
  const resolved = resolveValue(param.axis, raw);
  if (resolved.ok) return resolved.value;
  throw new Error(
    `Job definition "${specId}" parameter "${param.name}" is invalid: ${resolved.code}: ${resolved.message}`,
  );
}

function normalizeDeclaredValue(
  specId: string,
  param: JobDefinitionParameter,
  raw: unknown,
): unknown {
  if (param.type === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(
        `Job definition "${specId}" parameter "${param.name}" must be a finite number.`,
      );
    }
    // Issue #5493 — the spec's declared bounds, never a constant here.
    if (param.minimum !== undefined && raw < param.minimum) {
      throw new Error(
        `Job definition "${specId}" parameter "${param.name}" (${raw}) is below its declared minimum ${param.minimum}.`,
      );
    }
    if (param.maximum !== undefined && raw > param.maximum) {
      throw new Error(
        `Job definition "${specId}" parameter "${param.name}" (${raw}) is above its declared maximum ${param.maximum}.`,
      );
    }
    return raw;
  }
  if (param.type === "boolean") {
    if (typeof raw !== "boolean") {
      throw new Error(
        `Job definition "${specId}" parameter "${param.name}" must be a boolean.`,
      );
    }
    return raw;
  }
  if (param.type === "multi-select" || param.type === "list") {
    if (!Array.isArray(raw)) {
      throw new Error(
        `Job definition "${specId}" parameter "${param.name}" must be an array of strings.`,
      );
    }
    const values: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string" || item.trim() === "") {
        throw new Error(
          `Job definition "${specId}" parameter "${param.name}" must be an array of non-empty strings.`,
        );
      }
      values.push(item.trim());
    }
    if (param.axis) return values.map((value) => assertAxisValue(specId, param, value));
    if (param.options && param.options.length > 0) {
      for (const value of values) {
        if (!param.options.includes(value)) {
          throw new Error(
            `Job definition "${specId}": unknown ${param.name} "${value}". Allowed values: ${param.options.join(", ")}.`,
          );
        }
      }
    }
    return values;
  }
  if (typeof raw !== "string") {
    throw new Error(
      `Job definition "${specId}" parameter "${param.name}" must be a string.`,
    );
  }
  const trimmed = raw.trim();
  // Issue #5493 — an axis value outranks enumSource/options: a parameter
  // declares one source, and the vocabulary is that one list.
  if (param.axis) return assertAxisValue(specId, param, trimmed);
  if (param.enumSource) {
    const allowed = resolveEnumSource(param.enumSource, specId);
    if (!allowed.includes(trimmed)) {
      throw new Error(
        `Job definition "${specId}": unknown ${param.name} "${trimmed}". The ${param.enumSource} are: ${allowed.join(", ")}.`,
      );
    }
  } else if (param.options && param.options.length > 0 && !param.options.includes(trimmed)) {
    throw new Error(
      `Job definition "${specId}": unknown ${param.name} "${trimmed}". Allowed values: ${param.options.join(", ")}.`,
    );
  }
  return trimmed;
}

/**
 * Validate and bind one definition's run parameters from its declarative
 * `JobDefinitionParameter` schema. Throws (never returns a partially-bound set)
 * with the spec, the parameter and the reason named.
 */
export function bindJobDefinitionParams(
  spec: JobDefinitionSpec,
  params: JobDefinitionParams,
  owner: string | undefined,
  resolveSetting?: SettingResolver,
): JobDefinitionParams {
  const declared = spec.parameters ?? [];
  const declaredNames = new Set(declared.map((param) => param.name));
  for (const key of Object.keys(params)) {
    if (!declaredNames.has(key)) {
      throw new Error(
        `Job definition "${spec.id}" does not declare the parameter "${key}" — it declares: ${
          declared.map((param) => param.name).join(", ") || "none"
        }.`,
      );
    }
  }
  const bound: JobDefinitionParams = {};
  for (const param of declared) {
    let value = params[param.name];
    let empty = value === undefined || value === null || value === "";
    if (empty && param.default !== undefined) {
      value = isSettingRef(param.default) ? resolveSetting?.(param.default.setting) : param.default;
      empty = value === undefined || value === null || value === "";
    }
    if (empty) {
      if (param.required) {
        throw new Error(
          `Job definition "${spec.id}" requires the "${param.name}" parameter — none was supplied, and one is never invented.`,
        );
      }
      continue;
    }
    const normalized = normalizeDeclaredValue(spec.id, param, value);
    bound[param.name] = normalized;
    if (param.derivation) {
      const derive = resolveParamDerivation(param.derivation, spec.id);
      Object.assign(
        bound,
        derive(normalized, {
          specId: spec.id,
          paramName: param.name,
          params: bound,
          owner,
        }),
      );
    }
  }
  // Issue #5493 — the declared cross-parameter rules. Both read values that
  // were already bound (nothing new is invented): a number may not sit below
  // another bound number, and a provider set may only name providers that
  // serve the requested capability.
  for (const param of declared) {
    const value = bound[param.name];
    if (value === undefined) continue;
    if (param.atLeast !== undefined) {
      const floor = bound[param.atLeast];
      if (typeof floor === "number" && typeof value === "number" && value < floor) {
        throw new Error(
          `Job definition "${spec.id}" parameter "${param.name}" is invalid: ${value} is below "${param.atLeast}" (${floor}) — refusing rather than running an empty range.`,
        );
      }
    }
    if (param.capabilityFrom !== undefined) {
      const capability = bound[param.capabilityFrom];
      if (typeof capability !== "string") continue;
      for (const providerId of Array.isArray(value) ? value : [value]) {
        if (typeof providerId !== "string") continue;
        const declaredCapabilities = dataProviderDeclaredCapabilities(providerId);
        // A provider the declaration projection does not know is left to the
        // run-time registry (#5494): refusing it here would turn a typo in a
        // later adapter into a vocabulary the binder cannot accept, and a
        // data-only vocabulary addition must reach this binder unchanged.
        if (declaredCapabilities === undefined) continue;
        if (!declaredCapabilities.includes(capability as DataProviderCapability)) {
          throw new Error(
            `Job definition "${spec.id}" parameter "${param.name}" is invalid: provider "${providerId}" does not serve "${capability}" (${VOCABULARY_CODES.unsupportedPair}). It declares: ${declaredCapabilities.join(", ") || "nothing"}.`,
          );
        }
      }
    }
  }
  return {
    ...(owner ? { userLogin: owner } : {}),
    trigger: "scheduled",
    ...bound,
  };
}

/**
 * Issue #4466 — validate the flow's per-stage values against the spec: the
 * stage must exist, every parameter must be declared on that stage, and each
 * mode override must be a supported mode. A refusal names the stage and the
 * offending value; nothing partial is returned.
 */
export function bindStageOverrides(
  spec: JobDefinitionSpec,
  input: {
    stageParams?: Record<string, Record<string, unknown>>;
    stageModes?: Record<string, Partial<JobExecutionMode>>;
    /** Issue #4479 — a stage's cadence, as minutes or a cron expression. */
    stageSchedules?: Record<string, { intervalMinutes?: number; cron?: string }>;
    /** Issue #4775 S1 — a stage's per-unit deadline, in milliseconds. */
    stageTimeouts?: Record<string, number>;
    /** Issue #4781 S2 — a stage's fan-out cap. */
    stageMaxParallel?: Record<string, number>;
    /** Issue #4781 S2 — a stage's retry bucket. */
    stageRetryBuckets?: Record<string, StageRetryBucket>;
    /** Issue #4781 S2 — a stage's processing overrides (checkpoint interval). */
    stageProcessing?: Record<string, { checkpointEverySteps?: number }>;
  },
): JobDefinitionPerStage {
  const stages = new Map(spec.stages.map((stage) => [stage.kind, stage]));
  const params: Record<string, Record<string, unknown>> = {};
  for (const [kind, values] of Object.entries(input.stageParams ?? {})) {
    const stage = stages.get(kind);
    if (!stage) {
      throw new Error(
        `Job definition "${spec.id}" has no stage "${kind}". Its stages are: ${[...stages.keys()].join(", ")}.`,
      );
    }
    const declared = stage.parameters ?? [];
    const declaredNames = new Set(declared.map((param) => param.name));
    for (const key of Object.keys(values)) {
      if (!declaredNames.has(key)) {
        throw new Error(
          `Stage "${kind}" of job definition "${spec.id}" does not declare the parameter "${key}" — it declares: ${
            declared.map((param) => param.name).join(", ") || "none"
          }.`,
        );
      }
    }
    for (const param of declared) {
      const value = values[param.name] ?? stage.params?.[param.name];
      if (param.required && (value === undefined || value === null || value === "")) {
        throw new Error(
          `Stage "${kind}" of job definition "${spec.id}" requires the "${param.name}" parameter — none was supplied, and one is never invented.`,
        );
      }
    }
    params[kind] = { ...values };
  }
  const modes: Record<string, Partial<JobExecutionMode>> = {};
  for (const [kind, mode] of Object.entries(input.stageModes ?? {})) {
    if (!stages.has(kind)) {
      throw new Error(
        `Job definition "${spec.id}" has no stage "${kind}". Its stages are: ${[...stages.keys()].join(", ")}.`,
      );
    }
    try {
      assertExecutionModeSupported(resolveExecutionMode(mode));
    } catch (error) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" has an invalid execution mode: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    modes[kind] = { ...mode };
  }
  const schedules: Record<string, { enabled: boolean; cron?: string; interval?: string }> = {};
  for (const [kind, entry] of Object.entries(input.stageSchedules ?? {})) {
    if (!stages.has(kind)) {
      throw new Error(
        `Job definition "${spec.id}" has no stage "${kind}". Its stages are: ${[...stages.keys()].join(", ")}.`,
      );
    }
    const cron = typeof entry.cron === "string" && entry.cron.trim() ? entry.cron.trim() : undefined;
    const minutes =
      typeof entry.intervalMinutes === "number" && Number.isFinite(entry.intervalMinutes)
        ? entry.intervalMinutes
        : undefined;
    if (cron && minutes !== undefined) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" takes a cron expression or an interval, not both.`,
      );
    }
    if (minutes !== undefined && minutes < 1) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" has an interval below one minute — the engine's floor is one minute.`,
      );
    }
    if (!cron && minutes === undefined) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" declares a cadence with neither a cron expression nor an interval — refusing rather than inventing one.`,
      );
    }
    schedules[kind] = {
      enabled: true,
      ...(cron ? { cron } : {}),
      ...(minutes !== undefined ? { interval: `every ${minutes} minutes` } : {}),
    };
  }
  // Issue #4775 S1 — a stage's per-unit deadline, in milliseconds.
  // Refused by name (unknown stage, or a value that is not a
  // positive finite number); nothing partial is returned.
  const timeouts: Record<string, number> = {};
  for (const [kind, timeoutMs] of Object.entries(input.stageTimeouts ?? {})) {
    if (!stages.has(kind)) {
      throw new Error(
        `Job definition "${spec.id}" has no stage "${kind}". Its stages are: ${[...stages.keys()].join(", ")}.`,
      );
    }
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" has an invalid timeout ${String(timeoutMs)}: the stage timeout must be a positive finite number of milliseconds.`,
      );
    }
    timeouts[kind] = timeoutMs;
  }
  // Issue #4781 S2 — a stage's fan-out cap. Refused by name
  // (unknown stage, or a value that is not a positive integer);
  // nothing partial is returned.
  const maxParallel: Record<string, number> = {};
  for (const [kind, cap] of Object.entries(input.stageMaxParallel ?? {})) {
    if (!stages.has(kind)) {
      throw new Error(
        `Job definition "${spec.id}" has no stage "${kind}". Its stages are: ${[...stages.keys()].join(", ")}.`,
      );
    }
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" has an invalid fan-out cap ${String(cap)}: the stage maxParallel must be a positive integer.`,
      );
    }
    maxParallel[kind] = cap;
  }
  // Issue #4781 S2 — a stage's retry bucket. Refused by name
  // (unknown stage, or a bucket outside the pipelinePolicy retry
  // keys); nothing partial is returned.
  const retryBuckets: Record<string, StageRetryBucket> = {};
  for (const [kind, bucket] of Object.entries(input.stageRetryBuckets ?? {})) {
    if (!stages.has(kind)) {
      throw new Error(
        `Job definition "${spec.id}" has no stage "${kind}". Its stages are: ${[...stages.keys()].join(", ")}.`,
      );
    }
    if (!isRetryBucketName(bucket)) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" has an invalid retryBucket ${JSON.stringify(bucket)}: a stage retries under one of: ${RETRY_BUCKET_NAMES.join(", ")}.`,
      );
    }
    retryBuckets[kind] = bucket;
  }
  // Issue #4781 S2 — a stage's processing overrides (checkpoint
  // interval). Refused by name (unknown stage, or a value that is
  // not a positive integer); nothing partial is returned.
  const processing: Record<string, { checkpointEverySteps?: number }> = {};
  for (const [kind, entry] of Object.entries(input.stageProcessing ?? {})) {
    if (!stages.has(kind)) {
      throw new Error(
        `Job definition "${spec.id}" has no stage "${kind}". Its stages are: ${[...stages.keys()].join(", ")}.`,
      );
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" has an invalid processing override: it must be an object.`,
      );
    }
    const checkpointEverySteps = (entry as { checkpointEverySteps?: unknown }).checkpointEverySteps;
    if (
      checkpointEverySteps !== undefined &&
      (typeof checkpointEverySteps !== "number" ||
        !Number.isInteger(checkpointEverySteps) ||
        checkpointEverySteps < 1)
    ) {
      throw new Error(
        `Stage "${kind}" of job definition "${spec.id}" has an invalid checkpoint interval ${String(checkpointEverySteps)}: processing.checkpointEverySteps must be a positive integer.`,
      );
    }
    processing[kind] = {
      ...(checkpointEverySteps !== undefined ? { checkpointEverySteps } : {}),
    };
  }
  return {
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(modes).length > 0 ? { modes } : {}),
    ...(Object.keys(schedules).length > 0 ? { schedules } : {}),
    ...(Object.keys(timeouts).length > 0 ? { timeouts } : {}),
    ...(Object.keys(maxParallel).length > 0 ? { maxParallel } : {}),
    ...(Object.keys(retryBuckets).length > 0 ? { retryBuckets } : {}),
    ...(Object.keys(processing).length > 0 ? { processing } : {}),
  };
}
