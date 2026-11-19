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
 */
import type { JobDefinitionParameter, JobDefinitionSpec, JobParameterSettingRef } from "../config/jobDefinitionCatalog";
import { resolveEnumSource, resolveParamDerivation } from "../config/jobDefinitionParamRegistry";
import type { JobExecutionMode } from "../data/jobPipelinePorts";
import { assertExecutionModeSupported, resolveExecutionMode } from "./jobPipelineConfig";
import type { JobDefinitionPerStage } from "./jobDefinitionSpecBuilder";

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
  if (typeof raw !== "string") {
    throw new Error(
      `Job definition "${specId}" parameter "${param.name}" must be a string.`,
    );
  }
  const trimmed = raw.trim();
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
  return {
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(modes).length > 0 ? { modes } : {}),
    ...(Object.keys(schedules).length > 0 ? { schedules } : {}),
  };
}
