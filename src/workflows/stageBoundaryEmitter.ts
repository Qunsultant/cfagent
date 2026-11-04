/**
 * Issue #3073 (S3 under #3069) - the stage-boundary emitter for the durable
 * workflows (payment, saga, trading).
 *
 * The stock seam lives inside `ScreenerAgent.runScreen`, which owns a Durable
 * Object with SQL storage: it persists a boundary summary under a stage key,
 * then publishes a message referencing that key. The durable workflows have
 * no such DO, but they have something equivalent and stronger for this
 * purpose: **a completed `step.do` is already persisted** by the platform
 * before the next line runs. So the artifact key names the step's own
 * durable record (`workflow:<family>:<runId>:<stageId>`) and the publish
 * happens strictly after the step returned - persist-then-publish, with no
 * new store invented.
 *
 * Failure policy, stated plainly (the #1743 rule the repo already uses for
 * trace hops): a boundary that cannot be published NEVER fails the flow. A
 * missing queue binding, a send rejection, a malformed message - all are
 * logged and swallowed, because an observability gap must not stop a payment
 * from settling. `emit` returns what happened so tests and callers can tell
 * "published" from "skipped", and nothing is ever silent.
 */
import { buildStageBoundaryMessage, publishStageBoundaryMessage, type StageQueueSend } from "./stageQueueTransport";
import type { StageFamily } from "./stageMessage";

export type StageBoundaryEmitResult = "published" | "skipped" | "malformed";

export interface StageBoundaryEmitter {
  (input: { stageId: string; summary?: Record<string, unknown> }): Promise<StageBoundaryEmitResult>;
}

/** The artifact key a boundary message references: the step's own durable record. */
export function workflowStageArtifactKey(args: {
  family: StageFamily;
  runId: string;
  stageId: string;
}): string {
  return `workflow:${args.family}:${args.runId}:${args.stageId}`;
}

export interface StageBoundaryEmitterOptions {
  readonly family: StageFamily;
  readonly runId: string;
  /** A real login; the seam refuses "default" and an empty value. */
  readonly userLogin: string;
  readonly queue?: StageQueueSend | null;
  /** Injected for tests; defaults to console.warn. */
  readonly warn?: (message: string) => void;
}

/**
 * Build the emitter for one workflow instance. Cheap: no I/O until called.
 */
export function createStageBoundaryEmitter(options: StageBoundaryEmitterOptions): StageBoundaryEmitter {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return async (input) => {
    const artifactKey = workflowStageArtifactKey({
      family: options.family,
      runId: options.runId,
      stageId: input.stageId,
    });
    try {
      const message = buildStageBoundaryMessage({
        family: options.family,
        runId: options.runId,
        userLogin: options.userLogin,
        stageId: input.stageId,
        artifactKeys: [artifactKey],
      });
      const published = await publishStageBoundaryMessage({ queue: options.queue, message });
      if (!published.published) {
        warn(
          `[stage-seam] ${options.family}/${input.stageId} boundary not published for run ${options.runId}: ${published.reason}`,
        );
        return "skipped";
      }
      return "published";
    } catch (err) {
      // A malformed message means the stage id is not declared for this
      // family - a wiring bug worth a loud line, never a failed run.
      warn(
        `[stage-seam] ${options.family}/${input.stageId} boundary refused for run ${options.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "malformed";
    }
  };
}
