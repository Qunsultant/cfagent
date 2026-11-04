/**
 * Issue #2991 (#2770 Phase A) — leg registry: a workflow registers
 * as a leg with its binding, stage contract, parameter schema,
 * terminal semantics, and saga-derived id derivation (the #2129
 * 100-character lesson). The leg port (startLeg / getLegStatus)
 * is built from the registry; starting delegates to the #2989
 * uniform correlation seam (create → adopt → fallback), the
 * same algorithm the saga's original hand-written port
 * implemented, now shared instead of duplicated.
 *
 * The registry persists NOTHING. startLeg's returned workflowId
 * — the ACTUAL id used, derived or fallback — is the correlation
 * carrier; persisting it onto job records is #2989's uniform
 * correlation seam, which this module accepts through (never a
 * second derivation: the registry never invents an id of its own
 * beyond the entry's derivation).
 */

import { mapInstanceStatus, type WorkflowBindingLike } from "./cfWorkflowAdapter";
import type { SagaLeg, SagaLegPort } from "./sagaLegPort";
import { startManagedWorkflowInstance } from "./workflowInstanceSeam";

export interface LegRegistryEntry {
  id: string;
  /** Workflow binding name (wrangler.jsonc), e.g. PAYMENT_WORKFLOW. */
  bindingName: string;
  /** Parameter field names the leg start accepts. */
  parameterSchema: string[];
  stageContract: { observeStages: string[] };
  /** Terminal name -> outcome catalog code. */
  terminalSemantics: Record<string, string>;
  /** Provider-safe instance id for one saga (the #2129 lesson). */
  deriveInstanceId: (sagaId: string) => string;
  /** Hashed retry id when no instance is adoptable. */
  deriveFallbackId: (sagaId: string) => string;
}

export type LegRegistry = Map<string, LegRegistryEntry>;

/**
 * Build a registry. Duplicate leg ids, missing derivations, and
 * missing stage contracts throw — a half-registered leg is worse
 * than a missing one.
 */
export function createLegRegistry(entries: LegRegistryEntry[]): LegRegistry {
  const registry: LegRegistry = new Map();
  for (const entry of entries) {
    if (registry.has(entry.id)) {
      throw new Error(`Leg registry: duplicate leg id ${entry.id}`);
    }
    if (typeof entry.deriveInstanceId !== "function") {
      throw new Error(`Leg registry: leg ${entry.id} needs deriveInstanceId`);
    }
    if (typeof entry.deriveFallbackId !== "function") {
      throw new Error(`Leg registry: leg ${entry.id} needs deriveFallbackId`);
    }
    if (!entry.stageContract || entry.stageContract.observeStages.length === 0) {
      throw new Error(`Leg registry: leg ${entry.id} needs observeStages`);
    }
    registry.set(entry.id, entry);
  }
  return registry;
}

/**
 * Build a leg port from the registry. Start/adopt/fallback
 * semantics mirror the saga's original port exactly: create under
 * the derived id; on failure adopt the existing instance; with no
 * adoptable instance retry under the fallback id; a genuine
 * provider outage fails loudly with the original error. An absent
 * binding THROWS instead of returning null — a saga must not burn
 * a poll deadline on a misconfigured binding.
 */
export function legPortFromRegistry(
  registry: LegRegistry,
  bindings: Partial<Record<string, WorkflowBindingLike | undefined>>,
  sagaId: string,
): SagaLegPort {
  const entryFor = (leg: SagaLeg): LegRegistryEntry => {
    const entry = registry.get(leg);
    if (!entry) {
      throw new Error(`Leg ${leg} is not registered; cannot start or observe it.`);
    }
    return entry;
  };
  const bindingFor = (entry: LegRegistryEntry): WorkflowBindingLike => {
    const binding = bindings[entry.bindingName];
    if (!binding) {
      throw new Error(
        `Saga leg binding ${entry.bindingName} is not configured; cannot start or observe the ${entry.id} leg.`,
      );
    }
    return binding;
  };

  return {
    async startLeg(
      leg: SagaLeg,
      params: unknown,
    ): Promise<{ workflowId: string; existing: boolean }> {
      const entry = entryFor(leg);
      const binding = bindingFor(entry);
      // Splice note (#2991 ship): starting rides the #2989 seam
      // instead of the hand-rolled create → adopt → fallback this
      // registry originally carried — same algorithm, one shared
      // implementation, so saga legs keep the uniform correlation
      // id (derived or fallback) #2989 persists.
      const started = await startManagedWorkflowInstance(binding, {
        id: entry.deriveInstanceId(sagaId),
        fallbackId: () => entry.deriveFallbackId(sagaId),
        params,
      });
      return { workflowId: started.workflowId, existing: started.existing };
    },

    async getLegStatus(leg: SagaLeg, workflowId: string) {
      const entry = entryFor(leg);
      const binding = bindingFor(entry);
      try {
        const instance = await binding.get(workflowId);
        if (typeof instance.status !== "function") return null;
        const s = await instance.status();
        return {
          status: mapInstanceStatus(s.status),
          ...(s.output !== undefined ? { output: s.output } : {}),
          ...(s.error ? { error: { message: s.error.message } } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}
