/**
 * Issue #2989 — the ONE seam for Cloudflare workflow instance starts.
 *
 * Before this module, the create → adopt → fallback algorithm existed
 * in three hand-rolled variants: cfWorkflowAdapter.startWorkflowInstance
 * (derived `workflowIdForJob(jobId)`, fallback `screen-<sha256 40>`),
 * sagaLegPort.startLeg (derived `sagaLegInstanceId`, fallback
 * `saga-h-<hash>`), and the direct binding.create calls in
 * sagaEntry.startSagaViaBinding and
 * paymentWorkflowSubmission.startPaymentWorkflowViaBinding (no
 * fallback). Every one of those now routes through
 * startManagedWorkflowInstance below; no call site touches a
 * workflow binding's create/get for a start anymore. (Status reads
 * stay per-port: CfWorkflowAdapter.status, sagaLegPort.getLegStatus.)
 *
 * The Cloudflare workflow id IS the instance id. binding.create()
 * returns only instance.id (user-provided or auto-generated, up to
 * 100 chars); instance.status() returns only status/output/error;
 * get()/status() address the instance by that id. There is no
 * second Cloudflare-assigned run identifier, so the seam persists
 * the ACTUAL id used at start — derived or fallback — and invents
 * no second field. (Deliberately NOT the aiSearchDispatch /
 * aiSearchPaths correlationId: a per-dispatch randomUUID, unrelated
 * to workflow instances.)
 *
 * Uniform record + read-back: every start path writes the seam's
 * workflowId onto its start-time job record (ShardJobRow.workflowRunId
 * for screener/saga rows; the established audit-payload fields
 * elsewhere — see the naming map in the #2989 report), and
 * resolveWorkflowRunId prefers a stored id over a re-derived one,
 * so a fallback-created instance is never re-addressed by the
 * derived id that was never created.
 *
 * Host-door starts (payment via PaymentWorkflowHost.runWorkflow,
 * trading via the SDK host's runWorkflow) cannot route their create
 * through this seam — the create lives in host/SDK code, not repo
 * code. They ride the seam at the record + resolve steps instead:
 * the host-returned id is recorded under the same convention.
 *
 * Batch creation (Cloudflare createBatch, up to 100 instances per
 * call) is NOT used anywhere in the repo (only the unrelated
 * stageBatching.createBatchCheckpoint), so the seam is per-instance.
 * If createBatch is ever adopted, each returned id must ride the
 * same record field — a future extension, not built here.
 */
import { WorkflowError } from "./workflowPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/workflowInstanceSeam",
});


/** Minimal structural surface the seam needs from a binding (no provider types). */
export interface ManagedWorkflowBindingInstance {
  /** Issue #3955 — the delivery half of the durable event wait; absent on shapes that cannot receive events. */
  sendEvent?: (event: { type: string; payload: unknown }) => Promise<void>;
  /** Issue #5783 — instance control; each is optional because provider shapes differ. */
  pause?: () => Promise<void>;
  resume?: () => Promise<void>;
  terminate?: (options?: { rollback?: boolean }) => Promise<void>;
  restart?: (options?: {
    from?: { name: string; count?: number; type?: "do" | "sleep" | "waitForEvent" };
  }) => Promise<void>;
  id?: string;
  /** Absent on payment-shaped bindings: treated as "not adoptable", never as an adoption. */
  status?: () => Promise<{
    status: string;
    output?: unknown;
    error?: { message: string };
  }>;
}

/** Minimal structural surface of a workflow binding. */
export interface ManagedWorkflowBinding {
  create(options: { id: string; params: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<ManagedWorkflowBindingInstance>;
}

/** The outcome of one managed start: the ACTUAL instance id. */
export interface ManagedWorkflowStart {
  /** The Cloudflare workflow id: the created/adopted instance's id. */
  workflowId: string;
  /** True when an existing instance was adopted instead of created. */
  existing: boolean;
  /** True when the fallback id was used (derived id unusable or unadoptable). */
  adoptedFallbackId?: boolean;
}

/** Provider error text, safe to log (never returned to a client). */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Start one instance idempotently through a binding: create, or
 * adopt the existing instance when create reports the id is taken
 * (any create error falls through to the get — the error shape for
 * a duplicate id is provider detail, and a get whose status()
 * resolves proves the instance exists). When adoption fails and a
 * fallback id is supplied, one retry uses it; a genuine provider
 * outage still fails loudly with both errors named. Without a
 * fallback id, the original create error is rethrown untouched.
 *
 * The returned workflowId is ALWAYS the actual id: the created
 * instance's returned id on create, the requested id on adopt (the
 * instance was fetched by that id), the fallback instance's
 * returned id on fallback-create. Callers must persist exactly
 * this value — never re-derive it — or a fallback-created run
 * becomes unaddressable.
 */
export const DEFAULT_AGENT_BINDING = "ORCHESTRATOR_AGENT";
export const DEFAULT_WORKFLOW_NAME = "JOB_PIPELINE_WORKFLOW";

/**
 * Issues #5776 / #5777 — ensure every `AgentWorkflow` (`PortThinkWorkflow` ->
 * `ThinkWorkflow`) start carries `__agentName`, `__agentBinding`, and
 * `__workflowName` in `params` so `AgentWorkflow._initAgent` succeeds before
 * `run()` regardless of which host/route/broker/cron dispatched the workflow.
 */
export function withAgentWorkflowContext(
  params: unknown,
  opts?: { workflowName?: string; agentBinding?: string },
): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const record = params as Record<string, unknown>;
  const rawName =
    typeof record.__agentName === "string" && record.__agentName.trim()
      ? record.__agentName
      : typeof record.userLogin === "string" && record.userLogin.trim()
        ? record.userLogin.trim()
        : "system";
  const rawBinding =
    typeof record.__agentBinding === "string" && record.__agentBinding.trim()
      ? record.__agentBinding
      : opts?.agentBinding || DEFAULT_AGENT_BINDING;
  const rawWorkflow =
    typeof record.__workflowName === "string" && record.__workflowName.trim()
      ? record.__workflowName
      : opts?.workflowName || DEFAULT_WORKFLOW_NAME;
  return {
    ...record,
    __agentName: rawName,
    __agentBinding: rawBinding,
    __workflowName: rawWorkflow,
  };
}

export async function startManagedWorkflowInstance(
  binding: ManagedWorkflowBinding,
  options: {
    /** First-try id: the path's derived id, or the run-request id for payment. */
    id: string;
    /** Lazy fallback id factory; absent = no fallback (rethrow on adopt failure). */
    fallbackId?: () => Promise<string> | string;
    params: unknown;
    /** Explicit AgentWorkflow binding name (e.g. JOB_PIPELINE_WORKFLOW, SAGA_WORKFLOW). */
    workflowName?: string;
    /** Explicit AgentWorkflow DO binding name (defaults to ORCHESTRATOR_AGENT). */
    agentBinding?: string;
  },
): Promise<ManagedWorkflowStart> {
  const paramsWithContext = withAgentWorkflowContext(options.params, {
    workflowName: options.workflowName,
    agentBinding: options.agentBinding,
  });
  let firstError: unknown = null;
  try {
    const instance = await binding.create({ id: options.id, params: paramsWithContext });
    return { workflowId: instance.id, existing: false };
  } catch (err) {
    firstError = err;
  }
  try {
    const instance = await binding.get(options.id);
    if (typeof instance.status !== "function") throw new Error("instance has no status");
    await instance.status();
    return { workflowId: options.id, existing: true };
  } catch {
    // No adoptable instance: fall through to the fallback-id retry (or rethrow).
  }
  if (!options.fallbackId) throw firstError;
  const fallbackId = await options.fallbackId();
  try {
    const instance = await binding.create({ id: fallbackId, params: paramsWithContext });
    structuredLog.warn("workflowInstanceSeam.start_used_fallback_instance", {
      message: `[workflows] start used fallback instance id ${fallbackId} after id ${options.id} failed: ${errorText(firstError)}`,
      fallbackId,
      id: options.id,
      error: errorText(firstError),
    });
    return { workflowId: instance.id, existing: false, adoptedFallbackId: true };
  } catch (retryErr) {
    throw new WorkflowError(
      "start_failed",
      `Workflow start failed (first attempt: ${errorText(firstError)}; fallback attempt: ${errorText(retryErr)}).`,
    );
  }
}

/**
 * Read-back rule for a job's workflow id: a stored run id always
 * wins; only when nothing was stored does the caller fall back to
 * its derived id. Stored wins because the derived id is wrong for
 * every fallback-created instance.
 */
/**
 * Issue #3955 — deliver one named event to an instance, through the SAME
 * seam that starts them (this module is the one place that addresses a
 * workflow binding). Refuses by name when the instance cannot receive
 * events: a dropped approval is worse than a failed delivery.
 */
export async function sendManagedWorkflowEvent(
  binding: ManagedWorkflowBinding,
  instanceId: string,
  event: { type: string; payload: unknown },
): Promise<void> {
  const instance = await binding.get(instanceId);
  if (typeof instance.sendEvent !== "function") {
    throw new WorkflowError(
      "send_event_unsupported",
      `Workflow instance "${instanceId}" does not expose sendEvent; event "${event.type}" was not delivered.`,
    );
  }
  await instance.sendEvent(event);
}

/**
 * Issue #5783 — instance control through the SAME seam that starts instances.
 * Each op refuses by name (`instance_control_unsupported`) when the provider's
 * instance shape does not expose it: a control the platform cannot apply must
 * say so, never report success.
 *
 * `pause` / `resume` are the platform's own hold. They are deliberately NOT how
 * the engine pauses a run (see §3.10): the engine settles a paused run at its
 * own step boundary and resumes it as a NEW executor, so a platform-held
 * instance would have no resumer and the two models would deadlock. They exist
 * for a door that holds an instance whose flow it owns.
 */
export async function pauseManagedWorkflowInstance(
  binding: ManagedWorkflowBinding,
  instanceId: string,
): Promise<void> {
  const instance = await binding.get(instanceId);
  if (typeof instance.pause !== "function") {
    throw new WorkflowError(
      "instance_control_unsupported",
      `Workflow instance "${instanceId}" does not expose pause(); the hold was not applied.`,
    );
  }
  await instance.pause();
}

export async function resumeManagedWorkflowInstance(
  binding: ManagedWorkflowBinding,
  instanceId: string,
): Promise<void> {
  const instance = await binding.get(instanceId);
  if (typeof instance.resume !== "function") {
    throw new WorkflowError(
      "instance_control_unsupported",
      `Workflow instance "${instanceId}" does not expose resume(); the hold was not released.`,
    );
  }
  await instance.resume();
}

/**
 * Issue #5783 — stop an instance. `rollback` is REQUIRED at the seam so every
 * call site states its choice instead of inheriting a default: the platform
 * runs registered rollback handlers when it is true, and skips steps that
 * registered none.
 */
export async function terminateManagedWorkflowInstance(
  binding: ManagedWorkflowBinding,
  instanceId: string,
  options: { rollback: boolean },
): Promise<void> {
  const instance = await binding.get(instanceId);
  if (typeof instance.terminate !== "function") {
    throw new WorkflowError(
      "instance_control_unsupported",
      `Workflow instance "${instanceId}" does not expose terminate(); the run was not stopped.`,
    );
  }
  await instance.terminate({ rollback: options.rollback });
}

/**
 * Issue #5783 — restart an instance from its beginning or from a named step.
 * The platform refuses a target that is not in the instance's execution
 * history, so this helper never invents a target.
 */
export async function restartManagedWorkflowInstance(
  binding: ManagedWorkflowBinding,
  instanceId: string,
  options?: { from?: { name: string; count?: number; type?: "do" | "sleep" | "waitForEvent" } },
): Promise<void> {
  const instance = await binding.get(instanceId);
  if (typeof instance.restart !== "function") {
    throw new WorkflowError(
      "instance_control_unsupported",
      `Workflow instance "${instanceId}" does not expose restart(); the restart was not applied.`,
    );
  }
  await instance.restart(options ?? {});
}

export function resolveWorkflowRunId(
  stored: string | undefined,
  derived: string,
): string {
  return stored ?? derived;
}
