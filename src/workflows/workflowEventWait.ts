/**
 * Issue #3955 — the platform half of the durable event wait.
 *
 * Rules of Workflows (Cloudflare): `step.waitForEvent` is a step-level
 * call. It is invoked on the flow's step object, never inside
 * `step.do`, and the platform journals it under the name it is given —
 * so the SAME name on a replay re-arms the same wait instead of
 * opening a second one. The engine owns that name (see
 * `WAIT_EVENT_STEP` / `JobEventWaitRequest.stepName`); this module
 * never invents one.
 *
 * The platform answers a timeout by THROWING. #3955 requires a timeout
 * to be a declared outcome the job can branch on, so this module is the
 * ONE place that classification lives: a timeout becomes
 * `{outcome: "timeout"}` and the run continues; every other error is
 * rethrown untouched, so a real failure still fails the run.
 */
import type {
  JobEventWaitHandler,
  JobEventWaitOutcome,
  JobEventWaitRequest,
} from "../services/jobPipelineEngine";

/**
 * The structural step surface the wait needs. The SDK's `WorkflowStep`
 * satisfies it; tests pass their own.
 */
export interface WorkflowEventWaitStep {
  waitForEvent?: (
    name: string,
    options: { type: string; timeout?: number },
  ) => Promise<{ payload?: unknown }>;
}

/** The error name the platform's wait timeout carries, where it carries one. */
export const WORKFLOW_WAIT_TIMEOUT_ERROR_NAME = "TimeoutError";

/**
 * True for the platform's wait timeout, false for every other error.
 * Two shapes are recognised — the named error, and a message that names
 * the wait itself — and nothing else: a transport timeout elsewhere
 * must keep failing the run rather than masquerading as a declared
 * outcome.
 */
export function isWorkflowWaitTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shaped = error as { name?: unknown; message?: unknown };
  if (shaped.name === WORKFLOW_WAIT_TIMEOUT_ERROR_NAME) return true;
  return (
    typeof shaped.message === "string" &&
    /waitForEvent[^.]*timed out|timed out waiting for event/i.test(shaped.message)
  );
}

/**
 * Wait once through the platform, returning the engine's declared
 * outcome. The timeout throw never escapes.
 */
export async function waitForWorkflowEvent(
  step: WorkflowEventWaitStep & {
    waitForEvent: NonNullable<WorkflowEventWaitStep["waitForEvent"]>;
  },
  request: JobEventWaitRequest,
): Promise<JobEventWaitOutcome> {
  try {
    const event = await step.waitForEvent(request.stepName, {
      type: request.event,
      ...(request.timeoutMs !== null ? { timeout: request.timeoutMs } : {}),
    });
    return { outcome: "event", payload: event?.payload ?? null };
  } catch (error) {
    if (isWorkflowWaitTimeout(error)) return { outcome: "timeout" };
    throw error;
  }
}

/**
 * The deps fragment a flow injects. Present only when the host's step
 * can wait; a host without one keeps the engine's refusal by name
 * (`stage_port_unavailable`) instead of pretending the wait happened.
 */
export function resolveWorkflowWaitChannel(
  step: WorkflowEventWaitStep,
): { waitForEvent?: JobEventWaitHandler } {
  const wait = step.waitForEvent;
  if (typeof wait !== "function") return {};
  return {
    waitForEvent: (request) =>
      waitForWorkflowEvent(
        {
          waitForEvent: (name, options) => wait.call(step, name, options),
        },
        request,
      ),
  };
}
