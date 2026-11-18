/**
 * Issue #1737 — the workflow composition root. This is the
 * ONLY module (besides the provider adapter and the workflow
 * class) that touches the workflow binding: it reads the
 * binding out of the environment and builds the provider
 * adapter around it. Domain code imports this helper and the
 * port types, never a binding.
 *
 * Bindings (both required, both fail-open to legacy behavior):
 *  - SCREENER_WORKFLOW: the workflow binding. Absence means
 *    no workflow ports at all (null) — callers keep their
 *    legacy behavior (the synchronous screen).
 *  - AGENT_DB: the projection store. The workflow path
 *    records its job rows and journal through it; without it
 *    the path cannot report progress, so the composition
 *    root returns null rather than running blind. A provider
 *    workflow must never be silently replaced by the
 *    in-memory adapter in production — that would lie about
 *    durability — so the in-memory adapter is constructed
 *    explicitly by its users (tests, local development),
 *    never here.
 */

import { CfWorkflowAdapter, type WorkflowBindingLike } from "./cfWorkflowAdapter";
import type { WorkflowPort } from "./workflowPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/createWorkflowPorts",
});


export interface WorkflowEnv {
  SCREENER_WORKFLOW?: unknown;
  AGENT_DB?: unknown;
}

function asWorkflowBinding(value: unknown): WorkflowBindingLike | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { create?: unknown }).create === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  ) {
    return value as WorkflowBindingLike;
  }
  return null;
}

/**
 * Build workflow ports from the worker environment, or null
 * when the workflow binding or the projection store is not
 * configured. A malformed binding (present but without
 * create/get) also yields null, with a warning — callers
 * fall back to legacy behavior rather than crashing.
 */
/**
 * Issue #2065: why the port cannot be built, as a stable code the
 * callers put in their failure responses — so an operator can tell a
 * missing binding from a rejected start without reading worker logs.
 */
export type WorkflowPortsUnavailableReason = "workflow_binding_unavailable" | "projection_store_unavailable";

export function workflowPortsUnavailableReason(
  env: WorkflowEnv,
): WorkflowPortsUnavailableReason | null {
  if (!asWorkflowBinding(env.SCREENER_WORKFLOW)) return "workflow_binding_unavailable";
  if (!env.AGENT_DB) return "projection_store_unavailable";
  return null;
}

export function createWorkflowPorts(env: WorkflowEnv): WorkflowPort | null {
  const binding = asWorkflowBinding(env.SCREENER_WORKFLOW);
  if (!binding) {
    if (env.SCREENER_WORKFLOW) {
      structuredLog.warn("createWorkflowPorts.workflow_binding_malformed", {
        message: "[workflows] SCREENER_WORKFLOW binding is present but has no create/get capability — workflow ports unavailable.",
      });
    }
    return null;
  }
  if (!env.AGENT_DB) {
    structuredLog.warn("createWorkflowPorts.projection_store_unbound", {
      message: "[workflows] AGENT_DB is not bound — workflow job projection unavailable, workflow ports unavailable.",
    });
    return null;
  }
  return new CfWorkflowAdapter(binding);
}
