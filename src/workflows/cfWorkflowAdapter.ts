/**
 * Issue #1737 — the provider adapter for the workflow port.
 * Starts route through the ONE seam (workflowInstanceSeam): this
 * module no longer hand-rolls create → adopt → fallback. Domain
 * code imports the port and the composition root, never this
 * module and never a binding.
 *
 * Idempotent start: creating an instance with an id that
 * already exists is an error, not a second run — so a create
 * failure is followed by a get, and an existing instance is
 * adopted (existing:true) instead of failing. This is what
 * makes retried starts (and retried fan-out steps) safe: a
 * create that already landed adopts its own instance.
 */

import {
  assertWorkflowJobCommand,
  workflowIdForJob,
  workflowStatusUrl,
  type WorkflowHandle,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
  type WorkflowPort,
  type WorkflowStatus,
} from "./workflowPorts";

import {
  startManagedWorkflowInstance,
  type ManagedWorkflowBinding,
  type ManagedWorkflowBindingInstance,
} from "./workflowInstanceSeam";

/** Minimal structural surface the adapter needs from a binding (no provider types). */
export type WorkflowBindingInstance = ManagedWorkflowBindingInstance;

/** Minimal structural surface of a workflow binding. */
export type WorkflowBindingLike = ManagedWorkflowBinding;

/** Map a raw instance status onto the port's vocabulary (unknown strings → "unknown"). */
export function mapInstanceStatus(raw: string): WorkflowInstanceStatus {
  switch (raw) {
    case "queued":
    case "running":
    case "paused":
    case "waiting":
    case "waitingForPause":
    case "complete":
    case "errored":
    case "terminated":
      return raw;
    default:
      return "unknown";
  }
}

/**
 * Deterministic short instance id for a job whose derived id the
 * provider would reject (Issue #2065: a 122-char goal job id).
 *
 * Hashing keeps retries idempotent: the same job id always maps to the
 * same fallback instance, so a retried start adopts instead of creating
 * a second run. 40 hex chars + the prefix stay far under the provider's
 * 100-character ceiling.
 */
async function fallbackWorkflowId(jobId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jobId));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `screen-${hex.slice(0, 40)}`;
}

/**
 * Start one instance idempotently via the ONE seam
 * (workflowInstanceSeam): create under the derived id, adopt on
 * collision, one retry under a short provider-safe id when the
 * derived id is unusable (Issue #2065: a 122-char goal job id) or
 * the collision has no adoptable instance. The job id still rides
 * in params, so the run stays traceable, and a genuine provider
 * outage still fails loudly with the original error preserved
 * for the logs (inside the seam's start_failed message).
 */
/**
 * Issue #4140: the binding this adapter drives. ScreenerScreenWorkflow
 * extends ThinkWorkflow, which extends AgentWorkflow - and AgentWorkflow's
 * `_initAgent` runs BEFORE `run()` and throws when the workflow params lack
 * `__agentName`, `__agentBinding` and `__workflowName`. A run started
 * outside an agent (a route, the broker, the retired cron) therefore
 * errored with zero steps and never reached run() - which is what every
 * one of the 324 screener firings did.
 */
const DEFAULT_WORKFLOW_BINDING_NAME = "SCREENER_WORKFLOW";

export async function startWorkflowInstance(
  binding: WorkflowBindingLike,
  command: WorkflowJobCommand,
  workflowName: string = DEFAULT_WORKFLOW_BINDING_NAME,
): Promise<{ workflowId: string; existing: boolean; adoptedFallbackId?: boolean }> {
  return startManagedWorkflowInstance(binding, {
    id: workflowIdForJob(command.jobId),
    fallbackId: () => fallbackWorkflowId(command.jobId),
    // Issue #4140: satisfy AgentWorkflow's init so run() is reached at all.
    // The workflow reads none of these itself; the run's identity is
    // command.userLogin, validated in run() with no default identity
    // (#1185). "system" is only the DO instance name when no login exists,
    // and it never becomes the run owner.
    params: {
      ...command,
      __agentName: command.userLogin || "system",
      __agentBinding: "ORCHESTRATOR_AGENT",
      __workflowName: workflowName,
    },
  });
}

/** Provider adapter: the workflow port over a workflow binding. */
export class CfWorkflowAdapter implements WorkflowPort {
  constructor(private readonly binding: WorkflowBindingLike) {}

  async start(command: WorkflowJobCommand): Promise<WorkflowHandle> {
    assertWorkflowJobCommand(command);
    const { workflowId, existing } = await startWorkflowInstance(
      this.binding,
      command,
    );
    return {
      workflowId,
      jobId: command.jobId,
      status: existing ? "running" : "queued",
      existing,
      statusUrl: workflowStatusUrl(command.jobId),
    };
  }

  async status(workflowId: string): Promise<WorkflowStatus | null> {
    try {
      const instance = await this.binding.get(workflowId);
      if (typeof instance.status !== "function") return null;
      const s = await instance.status();
      return { workflowId, status: mapInstanceStatus(s.status) };
    } catch {
      return null;
    }
  }
}
