/**
 * Issue #6554 (F1) — the engine's async single-unit capability:
 * the capability domain + the step registry the engine resolves
 * capability handlers from. Every executor capability is one
 * registered engine step, `async.capability.<capability>`, executed
 * by `JobPipelineControl.runAsyncUnit` as an ad-hoc single unit —
 * no registered job definition is needed per submission (the
 * withdrawn "one-stage job per capability" shape is NOT this).
 *
 * The handler itself is a capability leg: it receives the
 * execution carrier (the executor context, the claimed row, the
 * payload, the execution deadline, the queue port) as its step
 * input, in-process — the carrier never persists as an artifact.
 * The engine owns the unit's run record (`async.<capability>`,
 * carrying the dispatching async job's id); the executor keeps
 * the queue claim, the heartbeat, the deadline, and the terminal
 * row. The ledger unification (one canonical run record, #6101 /
 * F5) comes after this hybrid proves out.
 */
import type { AsyncJobPorts } from "../data/createAsyncJobPorts";
import type { AsyncJobsContext } from "../agents/orchestrator/asyncJobs";
import { JobStepRegistry } from "./jobPipelineSteps";

/**
 * The executor's closed capability domain — the same nine the
 * executor dispatched on before this slice. A capability outside
 * this set refuses by name (`async_capability_unknown`) instead
 * of running nowhere.
 */
export const ASYNC_CAPABILITIES = [
  "http.request",
  "mcp.tool",
  "task.draft",
  "followup.report",
  "followup.deliver",
  "followup.notify",
  "shard.execute",
  "feed.snapshot",
  "nlq.execute",
] as const;

export type AsyncCapability = (typeof ASYNC_CAPABILITIES)[number];

export function isAsyncCapability(value: unknown): value is AsyncCapability {
  return (ASYNC_CAPABILITIES as readonly string[]).includes(value as string);
}

/** The engine job id an async unit's run records under. */
export function asyncCapabilityJobId(capability: AsyncCapability): string {
  return `async.${capability}`;
}

/** The registered engine step name a capability executes as. */
export function asyncCapabilityStepName(capability: AsyncCapability): string {
  return `async.capability.${capability}`;
}

/** The claimed queue row a capability leg executes for. */
export type AsyncCapabilityJob = NonNullable<
  ReturnType<AsyncJobPorts["read"]["getClaimed"]>
>;

/**
 * The in-process execution carrier a capability step receives as
 * its step input. The executor builds it per execution from the
 * claimed row; nothing in it is persisted by the engine (the
 * queue row stays the durable truth until the F5 ledger
 * unification).
 */
export interface AsyncCapabilityExecution {
  ctx: AsyncJobsContext;
  job: AsyncCapabilityJob;
  jobId: string;
  payload: Record<string, unknown>;
  /**
   * The executor's execution deadline — the race the leg runs
   * under. Issue #6558: the deadline carries the abort signal
   * (`signal`), aborted with the timeout error when the deadline
   * fires; every leg raced against the deadline threads it, or
   * is recorded as un-abortable with a reason.
   */
  deadline: { promise: Promise<never>; cancel: () => void; signal: AbortSignal };
  /** The queue port the leg records attempts through. */
  queue: AsyncJobPorts["queue"];
}

export interface AsyncCapabilityStepResult {
  result: unknown;
  responseStatus?: number;
}

export type AsyncCapabilityStepHandler = (
  execution: AsyncCapabilityExecution,
) => Promise<AsyncCapabilityStepResult>;

/**
 * Register each capability handler as its engine step. The
 * adapter unpacks the execution carrier from the step input and
 * returns the leg's outcome as the step output, so the engine's
 * run record carries what the leg produced.
 */
export function createAsyncCapabilityStepRegistry(
  handlers: Record<AsyncCapability, AsyncCapabilityStepHandler>,
): JobStepRegistry {
  const registry = new JobStepRegistry();
  for (const capability of ASYNC_CAPABILITIES) {
    const handler = handlers[capability];
    registry.register(asyncCapabilityStepName(capability), async (stepCtx) => {
      const execution = stepCtx.input as AsyncCapabilityExecution | undefined;
      if (
        !execution ||
        typeof execution !== "object" ||
        !execution.ctx ||
        !execution.job ||
        typeof execution.jobId !== "string" ||
        !execution.payload ||
        typeof execution.payload !== "object"
      ) {
        throw new Error(
          `Async capability step "${asyncCapabilityStepName(capability)}" requires an AsyncCapabilityExecution input; refusing rather than running without the executor context.`,
        );
      }
      const out = await handler(execution);
      return {
        output: {
          result: out.result,
          ...(out.responseStatus !== undefined
            ? { responseStatus: out.responseStatus }
            : {}),
        },
      };
    });
  }
  return registry;
}
