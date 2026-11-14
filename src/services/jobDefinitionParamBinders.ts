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
import { UNIVERSES } from "../trading";
import { shardsForUniverse } from "../workflows/screenExecutionBroker";
import type { JobDefinitionSpec } from "../config/jobDefinitionCatalog";
import type { JobExecutionMode } from "../data/jobPipelinePorts";
import { assertExecutionModeSupported, resolveExecutionMode } from "./jobPipelineConfig";
import type { JobDefinitionPerStage } from "./jobDefinitionSpecBuilder";

export type JobDefinitionParams = Record<string, unknown>;

type ParamBinder = (
  spec: JobDefinitionSpec,
  params: JobDefinitionParams,
  owner: string | undefined,
) => JobDefinitionParams;

const BINDERS: Record<string, ParamBinder> = {
  screener: (_spec, params, owner) => {
    const universe = typeof params.universe === "string" ? params.universe.trim() : "";
    if (!universe) {
      throw new Error(
        'Job definition "screener" requires the "universe" parameter — the feed stage has no shard to screen without one.',
      );
    }
    if (!(universe in UNIVERSES)) {
      throw new Error(
        `Job definition "screener": unknown universe "${universe}". The universes are: ${Object.keys(UNIVERSES).join(", ")}.`,
      );
    }
    return {
      ...(owner ? { userLogin: owner } : {}),
      trigger: "scheduled",
      universe,
      shards: shardsForUniverse(universe),
      deliver: false,
    };
  },
};

/**
 * Validate and bind one definition's run parameters. Throws (never returns a
 * partially-bound set) with the spec, the parameter and the reason named.
 */
export function bindJobDefinitionParams(
  spec: JobDefinitionSpec,
  params: JobDefinitionParams,
  owner: string | undefined,
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
  for (const param of declared) {
    const value = params[param.name];
    const empty = value === undefined || value === null || value === "";
    if (param.required && empty) {
      throw new Error(
        `Job definition "${spec.id}" requires the "${param.name}" parameter — none was supplied, and one is never invented.`,
      );
    }
  }
  const binder = BINDERS[spec.id];
  const bound = binder
    ? binder(spec, params, owner)
    : { ...(owner ? { userLogin: owner } : {}), trigger: "scheduled", ...params };
  return bound;
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
  return {
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(modes).length > 0 ? { modes } : {}),
  };
}
