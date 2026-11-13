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
