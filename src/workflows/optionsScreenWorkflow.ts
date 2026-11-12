/**
 * Issue #3186 step 2 - the options screen workflow: a THIN composer.
 * Ordered stage Blocks, nothing else. Each stage, in pipeline order:
 *
 *   1. Claim runId+stageId (already claimed -> skip, never re-run).
 *   2. Execute (reads ONLY persisted input, by artifact key).
 *   3. Persist (canonical store) - then publish the stage message
 *      (persist-then-publish; publish never throws, a publish miss is
 *      warned, never a failed run).
 *   4. A stage failure stops the run LOUDLY (failed outcome with
 *      stage + reason, no message for the failed stage, later stages
 *      never run) and releases the failed stage's claim. A risk
 *      violation fails the run closed with reason risk_violation.
 *      Partial and no-contracts are legitimate non-failing outcomes
 *      (#2038: a leg fails by RESULT STATUS; zero hits is a
 *      legitimate complete).
 *
 * Stage logic lives behind the stage ports; production port
 * implementations land in step 3 (entry migration). The composer
 * never calls an engine directly.
 */
import type { StageClaimStore } from "./stageReportConsumer";
import { assertBlockConforms, type BlockDefinition } from "./blocks/blockContract";
import { OPTIONS_BLOCKS } from "./blocks/optionsBlocks";
import { stageIdempotencyKey, type StageMessage } from "./stageMessage";
import { OPTIONS_PIPELINE_STAGES } from "./stageRuntimeIds";
import {
  buildStageBoundaryMessage,
  publishStageBoundaryMessage,
  type StageQueueSend,
} from "./stageQueueTransport";
import type { OptionsStageStorage } from "./optionsScreenPorts";

export interface OptionsStageInput {
  runId: string;
  /** The session login when the caller has one. Optional by design:
   *  the scanner leg's pinned discipline (#27/#103) allows unscoped
   *  runs (no identity -> the persist stage saves unscoped and the
   *  composer skips stage publishing, which requires a real login).
   *  Legs that require an identity fail closed at their own call
   *  site (panel leg, goal leg); the composer never invents one. */
  userLogin?: string;
  stageId: string;
  /** Persisted input, by artifact key - never live data from another stage. */
  artifactKeys: string[];
  request: unknown;
}

export interface OptionsStagePort {
  execute(input: OptionsStageInput): Promise<unknown>;
  /**
   * Persist the stage's output and return its artifact keys. Takes
   * the stage input (for runId/stageId - the artifact key) as well
   * as the output: a persist that cannot name its artifact cannot
   * be resumed or audited. (Step-2's first version took output
   * only; the production ports exposed the gap - a port cannot
   * derive the run's artifact key from the output alone.)
   */
  persist(input: OptionsStageInput, output: unknown): Promise<string[]>;
}

export interface OptionsScreenWorkflowDeps {
  stages: Record<string, OptionsStagePort>;
  claims: StageClaimStore;
  queue?: StageQueueSend | null;
  warn?: (message: string) => void;
}

export type OptionsStageStatus =
  | "completed"
  | "partial"
  | "no_contracts"
  | "skipped-claimed"
  | "failed";

export interface OptionsStageRecord {
  stageId: string;
  status: OptionsStageStatus;
  artifactKeys?: string[];
  reason?: string;
}

export interface OptionsScreenWorkflowOutcome {
  outcome: "completed" | "failed";
  runId: string;
  stages: OptionsStageRecord[];
  published: StageMessage[];
  failedStage?: string;
  reason?: string;
}

function readTerminal(output: unknown, allowed: Set<string>): string {
  if (output && typeof output === "object") {
    const terminal = (output as { terminal?: unknown }).terminal;
    if (typeof terminal === "string") {
      if (!allowed.has(terminal)) {
        throw new Error(`options workflow: unknown terminal "${terminal}"`);
      }
      return terminal;
    }
  }
  return "completed";
}

/**
 * In-memory stage storage for hosts that provide no blob handle
 * (the NLQ legs, the scheduled scan). The durable record for those
 * runs is the persist stage's canonical write (scanRunStore /
 * mas_reports) plus the downstream report/delivery - the stage
 * artifacts themselves live only for the run's duration. Durable
 * claims/storage remain a named follow-up for these legs (the goal
 * leg and the manual entry already wire the durable stores).
 *
 * Issue #4069 (Option B for options): the in-memory checkpoints
 * are an accepted-absent, not a gap to fill here. Checkpoints are
 * run-duration artifacts, not run records — no run history is lost
 * when they evaporate, and making them durable would create a
 * second unit store (ADR D-0 / #3027) that cannot work in workflow
 * residency (no host DO to borrow storage from). Their durable home
 * after onboarding is the engine's job-instance checkpoint
 * (D1 stage_checkpoint_json) once #4068 routes the legs through
 * the engine. The goal leg and the manual entry already wire the
 * durable stores.
 */
export function memoryStageStorage(): OptionsStageStorage {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async <T>(key: string) => map.get(key) as T | undefined,
  };
}

/** In-memory stage claims (durable claims need sql - see above). */
export function memoryStageClaims(): StageClaimStore {
  const claimed = new Set<string>();
  return {
    has: (key) => claimed.has(key),
    add: (key) => {
      claimed.add(key);
    },
    // Issue #4068: a failed stage's claim MUST be releasable — the
    // composer releases it on failure (deps.claims.delete?.(key)),
    // and the engine retries a failed step, so without delete the
    // retry would see the still-held claim and skip the stage as
    // already-claimed instead of re-executing it. The SQL claim
    // store already deletes; the in-memory one must too.
    delete: (key) => {
      claimed.delete(key);
    },
  };
}

export interface OptionsStageRunResult {
  record: OptionsStageRecord;
  /** Artifact keys the NEXT stage reads (unchanged on a claim-skip or failure). */
  nextArtifactKeys: string[];
  /** True when the run must stop here (the stage failed or a risk violation fired). */
  failed: boolean;
  reason?: string;
  publishedMessage?: StageMessage;
}

/**
 * Issue #4068 — one stage of the options screen workflow, as a shared
 * function the thin composer AND the engine-routed dispatch both call, so
 * the two paths execute identical stage semantics (claim, execute, terminal
 * read, violation, persist, publish). A stage failure is returned (not
 * thrown) with failed:true so the caller decides how to stop the run: the
 * composer returns the failed outcome; the engine step throws so the engine
 * stops the run and marks it failed. Partial and no-contracts are
 * legitimate non-failing outcomes (#2038).
 */
export async function runOptionsStageOnce(
  input: OptionsStageInput,
  deps: OptionsScreenWorkflowDeps,
  block: BlockDefinition,
): Promise<OptionsStageRunResult> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const stageId = input.stageId;
  const key = stageIdempotencyKey(input.runId, stageId, "options");
  if (deps.claims.has(key)) {
    return {
      record: { stageId, status: "skipped-claimed" },
      nextArtifactKeys: [...input.artifactKeys],
      failed: false,
    };
  }
  deps.claims.add(key);
  const port = deps.stages[stageId];
  if (!port) {
    throw new Error(`options workflow: no port for stage ${stageId}`);
  }
  assertBlockConforms(port as unknown as Record<string, unknown>, block);
  const fail = (reason: string): OptionsStageRunResult => {
    deps.claims.delete?.(key);
    return {
      record: { stageId, status: "failed", reason },
      nextArtifactKeys: [...input.artifactKeys],
      failed: true,
      reason,
    };
  };
  let output: unknown;
  try {
    output = await port.execute(input);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  let terminal: string;
  try {
    terminal = readTerminal(output, new Set(Object.keys(block.stageContract.terminalSemantics)));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (terminal === "violation") {
    return fail("risk_violation: risk limits violated, failing closed");
  }
  let nextArtifactKeys: string[];
  try {
    nextArtifactKeys = await port.persist(input, output);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  let publishedMessage: StageMessage | undefined;
  if (!input.userLogin) {
    // No authenticated identity: stage messages require a real
    // login (stageMessage refuses empty/default), so the run
    // publishes nothing. The stages themselves still ran and
    // their artifacts are the record; the skip is warned, never
    // silent, and never fails the run (the scanner leg's pinned
    // unscoped-run discipline).
    warn(`[options-workflow] ${stageId}: publish skipped (no authenticated identity; the run's stage messages are not published)`);
  } else {
    const message = buildStageBoundaryMessage({
      runId: input.runId,
      family: "options",
      userLogin: input.userLogin,
      stageId,
      artifactKeys: nextArtifactKeys,
    });
    const result = await publishStageBoundaryMessage({ queue: deps.queue ?? null, message });
    if (result.published) {
      publishedMessage = result.message;
    } else {
      warn(`[options-workflow] ${stageId}: publish missed (${result.reason})`);
    }
  }
  const status = (
    terminal === "partial" || terminal === "no_contracts" ? terminal : "completed"
  ) as OptionsStageStatus;
  return {
    record: { stageId, status, artifactKeys: nextArtifactKeys },
    nextArtifactKeys,
    failed: false,
    ...(publishedMessage ? { publishedMessage } : {}),
  };
}

export async function runOptionsScreenWorkflow(
  params: { runId: string; userLogin?: string; request: unknown },
  deps: OptionsScreenWorkflowDeps,
): Promise<OptionsScreenWorkflowOutcome> {
  const blocks = new Map(OPTIONS_BLOCKS.map((block) => [block.id, block]));
  for (const stageId of OPTIONS_PIPELINE_STAGES) {
    const port = deps.stages[stageId];
    if (!port) {
      throw new Error(`options workflow: no port for stage ${stageId}`);
    }
    assertBlockConforms(port as unknown as Record<string, unknown>, blocks.get(`options-${stageId}`)!);
  }

  const stages: OptionsStageRecord[] = [];
  const published: StageMessage[] = [];
  let artifactKeys: string[] = [];

  for (const stageId of OPTIONS_PIPELINE_STAGES) {
    const stageInput: OptionsStageInput = {
      runId: params.runId,
      userLogin: params.userLogin,
      stageId,
      artifactKeys: [...artifactKeys],
      request: params.request,
    };
    const result = await runOptionsStageOnce(stageInput, deps, blocks.get(`options-${stageId}`)!);
    stages.push(result.record);
    if (result.publishedMessage) {
      published.push(result.publishedMessage);
    }
    if (result.failed) {
      return {
        outcome: "failed",
        runId: params.runId,
        stages,
        published,
        failedStage: stageId,
        reason: result.reason,
      };
    }
    artifactKeys = result.nextArtifactKeys;
  }

  return { outcome: "completed", runId: params.runId, stages, published };
}
