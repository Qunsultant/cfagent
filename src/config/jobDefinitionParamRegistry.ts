/**
 * Issue #5496 — Declarative parameter registries (enum sources & named
 * derivations) so `JobDefinitionSpec` families bind purely from data with zero
 * per-family binder code.
 *
 * Unknown enumSource or derivation names refuse BY NAME at spec
 * load/validation time, never at run time.
 */
import { researchUniverseIds } from "../trading";
import { shardsForUniverse } from "../workflows/screenExecutionBroker";

export interface ParamDerivationContext {
  specId: string;
  paramName: string;
  params: Record<string, unknown>;
  owner?: string;
}

export type ParamDerivationFn = (
  value: unknown,
  ctx: ParamDerivationContext,
) => Record<string, unknown>;

export const ENUM_SOURCES: Readonly<Record<string, () => string[]>> = {
  // Issue #6032/#6031 — `ALL` is a shard plan, not a selectable universe.
  universes: () => researchUniverseIds(),
};

export const PARAM_DERIVATIONS: Readonly<Record<string, ParamDerivationFn>> = {
  shardsForUniverse: (value) => ({
    shards: shardsForUniverse(String(value)),
  }),
};

export function hasEnumSource(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENUM_SOURCES, name);
}

export function resolveEnumSource(name: string, specId: string): string[] {
  if (!hasEnumSource(name)) {
    throw new Error(
      `Job definition "${specId}" references unknown enumSource "${name}". Available enum sources: ${Object.keys(ENUM_SOURCES).join(", ")}.`,
    );
  }
  return ENUM_SOURCES[name]();
}

export function hasParamDerivation(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PARAM_DERIVATIONS, name);
}

export function resolveParamDerivation(name: string, specId: string): ParamDerivationFn {
  if (!hasParamDerivation(name)) {
    throw new Error(
      `Job definition "${specId}" references unknown derivation "${name}". Available derivations: ${Object.keys(PARAM_DERIVATIONS).join(", ")}.`,
    );
  }
  return PARAM_DERIVATIONS[name];
}
