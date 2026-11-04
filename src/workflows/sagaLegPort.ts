/**
 * Issue #2041 S1 — the cross-workflow leg port (gap G-OBS).
 *
 * What this is NOT: a reuse of the screener's child ops. The
 * screener's fan-out (`screenerWorkflow.ts` child ops) is scoped to
 * that workflow's own binding and its shard children. Starts route
 * through the ONE seam (workflowInstanceSeam) — this port keeps
 * only its leg-scoped status reads and its binding-missing-throws
 * behavior, not a second create → adopt → fallback variant.
 *
 * Idempotent start mirrors `cfWorkflowAdapter.startWorkflowInstance`
 * (both now ride the same seam): creating an instance with an id
 * that already exists adopts it instead of failing, so a retried
 * start (and a saga re-run with the same sagaId) converges on one
 * instance per leg. A create failure with no adoptable instance
 * falls back to a hashed id; a genuine provider outage still fails
 * loudly with the original error preserved (inside the seam's
 * start_failed message).
 *
 * Deliberate difference from the screener's child ops: an absent
 * binding THROWS here instead of returning null. A saga must not
 * burn a poll deadline on a misconfigured binding — the failure
 * is loud at the leg boundary, not a deadline expiry later.
 *
 * Id derivation (gap G-SAGA-ID): ids are derived from the saga id
 * and the leg, never raw concatenations, and stay under the
 * provider's 100-character ceiling (the #2129 lesson). Short ids
 * stay readable (`saga-<leg>-<sanitized>`); long ones hash down
 * to `saga-h-<32 hex>` via two-seed FNV-1a, so the same saga id
 * always maps to the same instance id (retries adopt, never
 * duplicate).
 *
 * Issue #2991 (#2770 Phase A): the closed leg union is now
 * registry entries — this module delegates to legRegistry. The
 * derivation, the adopt/fallback semantics, and every export here
 * are byte-identical in behavior to the pre-registry port; only
 * the construction moved.
 */

import type { WorkflowBindingLike } from "./cfWorkflowAdapter";
import { createLegRegistry, legPortFromRegistry } from "./legRegistry";
import type { WorkflowInstanceStatus } from "./workflowPorts";

/** Saga legs. S1 uses payment + screener; trade arrives with S4. */
export type SagaLeg = "payment" | "screener" | "trade";

/** Workflow binding per leg (wrangler.jsonc). */
export type SagaLegBinding = "PAYMENT_WORKFLOW" | "SCREENER_WORKFLOW" | "TRADE_WORKFLOW";

export const SAGA_LEG_BINDINGS: Record<SagaLeg, SagaLegBinding> = {
  payment: "PAYMENT_WORKFLOW",
  screener: "SCREENER_WORKFLOW",
  trade: "TRADE_WORKFLOW",
};

/** Liveness read for one leg instance. */
export interface SagaLegInstanceStatus {
  status: WorkflowInstanceStatus;
  output?: unknown;
  error?: { message: string };
}

/** The leg port: start + observe, per leg. */
export interface SagaLegPort {
  startLeg(leg: SagaLeg, params: unknown): Promise<{ workflowId: string; existing: boolean }>;
  getLegStatus(leg: SagaLeg, workflowId: string): Promise<SagaLegInstanceStatus | null>;
}

/** Two-seed FNV-1a 64-bit → 32 hex chars (same shape as workflowPorts' job hash). */
function hashSagaId(input: string): string {
  const hash = (seed: bigint): string => {
    let h = seed;
    const prime = 1099511628211n;
    const mask = (1n << 64n) - 1n;
    for (const ch of input) {
      h ^= BigInt(ch.codePointAt(0) as number);
      h = (h * prime) & mask;
    }
    return h.toString(16).padStart(16, "0");
  };
  return hash(14695981039346656037n) + hash(14695981039346656037n ^ 0x9e3779b97f4a7c15n);
}

/**
 * Derive a provider-safe instance id for one saga leg. Sanitizes
 * to [A-Za-z0-9_-]; hashes down when the readable form would exceed
 * the 100-character ceiling. Deterministic: the same saga id + leg
 * always yields the same instance id.
 */
export function sagaLegInstanceId(sagaId: string, leg: SagaLeg): string {
  const sanitized = sagaId.replace(/[^A-Za-z0-9_-]/g, "-");
  const short = `saga-${leg}-${sanitized}`;
  if (short.length <= 100) return short;
  return `saga-h-${hashSagaId(`${sagaId}:${leg}`)}`;
}

/**
 * Build a saga-scoped leg port from the worker environment's
 * workflow bindings. Bindings may be absent (the port throws on
 * use for that leg); the caller never touches a binding directly.
 *
 * #2991: delegates to the leg registry — the three legs below
 * are the saga's registry entries, with the original derivation
 * (including the exact fallback-id formula) carried verbatim.
 */
export function sagaLegPort(
  bindings: Partial<Record<SagaLegBinding, WorkflowBindingLike | undefined>>,
  sagaId: string,
): SagaLegPort {
  const registry = createLegRegistry(
    (["payment", "screener", "trade"] as SagaLeg[]).map((leg) => ({
      id: leg,
      bindingName: SAGA_LEG_BINDINGS[leg],
      parameterSchema: ["runRequestId"],
      stageContract: { observeStages: ["start", "poll"] },
      terminalSemantics: { complete: "SUCCESS" },
      deriveInstanceId: (id: string) => sagaLegInstanceId(id, leg),
      deriveFallbackId: (id: string) => `saga-h-${hashSagaId(`${id}:${leg}:fallback`)}`,
    })),
  );
  return legPortFromRegistry(registry, bindings, sagaId);
}
