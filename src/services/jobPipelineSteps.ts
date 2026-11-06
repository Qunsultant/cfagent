/**
 * Issue #3534 (Pipeline J1) — the platform step library: the
 * named step handlers a job's CONFIGURATION references. A job is
 * defined by configuration alone; the steps it names are platform
 * code (the built-ins here, and the stage steps J2–J6 register
 * for feed/enrich/analyze/generate/deliver). An unknown step name
 * at dispatch is a named refusal (`job_step_unknown`) — the
 * engine never guesses.
 *
 * Step contract: a step receives the previous step's output (the
 * persisted hand-off, read back from the artifact store unless
 * the job configured in-memory processing), its configured
 * params, and its item/shard coordinates under the online and
 * sharded modes. It returns the output the next step consumes.
 * Steps are idempotent at their boundaries: a resume may
 * re-invoke a step whose segment was in flight at checkpoint
 * time, and the persisted artifact is simply rewritten.
 */
import { JobPipelineError } from "./jobPipelineConfig";

export interface JobStepContext {
  jobId: string;
  runId: string;
  /** Child-index path of the executing node ("" = root). */
  nodePath: string;
  kind: string;
  stepIndex: number;
  /** Online pacing: the item being processed and its index. Null under batch pacing. */
  item: unknown;
  itemIndex: number | null;
  /** Batch pacing: the full configured item list. Empty under online pacing. */
  items: readonly unknown[];
  /** Sharded shape: the shard key this execution unit owns. Null under monolith. */
  shardKey: string | null;
  params: Record<string, unknown>;
  /** The previous step's output (the hand-off), or the node's input artifact. */
  input: unknown;
  now: string;
}

export interface JobStepResult {
  output?: unknown;
  descriptor?: string;
}

export type JobStepHandler = (ctx: JobStepContext) => Promise<JobStepResult>;

/** The step registry: name → handler. Hosts extend it; the engine resolves through it. */
export class JobStepRegistry {
  private readonly handlers = new Map<string, JobStepHandler>();

  register(name: string, handler: JobStepHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()].sort();
  }

  resolve(name: string): JobStepHandler {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new JobPipelineError(
        "job_step_unknown",
        `Unknown job step "${name}". Registered steps: ${this.names().join(", ") || "(none)"}.`,
      );
    }
    return handler;
  }
}

/**
 * The built-in steps every host gets. `record` is the dummy-work
 * step the foundation's acceptance runs on: it produces a
 * persisted artifact naming what it saw (params, item/shard
 * coordinates, input), so tests and operators can prove what
 * executed without any job code.
 */
export function createBuiltinStepRegistry(): JobStepRegistry {
  const registry = new JobStepRegistry();
  registry.register("noop", async (ctx) => ({ output: ctx.input }));
  registry.register("record", async (ctx) => ({
    output: {
      recordedBy: "record",
      kind: ctx.kind,
      nodePath: ctx.nodePath,
      stepIndex: ctx.stepIndex,
      params: ctx.params,
      item: ctx.item,
      itemIndex: ctx.itemIndex,
      itemCount: ctx.items.length,
      shardKey: ctx.shardKey,
      input: ctx.input ?? null,
      at: ctx.now,
    },
    descriptor: `recorded ${ctx.kind} step ${ctx.stepIndex}`,
  }));
  registry.register("echo", async (ctx) => ({
    output: { echo: ctx.input ?? null, params: ctx.params },
  }));
  registry.register("fail", async (ctx) => {
    const message =
      typeof ctx.params.message === "string" && ctx.params.message
        ? ctx.params.message
        : "Configured step failure (the job's configuration named the \"fail\" step).";
    throw new Error(message);
  });
  return registry;
}
