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
import { assertBlockConforms } from "./blocks/blockContract";
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
  };
}

export async function runOptionsScreenWorkflow(
  params: { runId: string; userLogin?: string; request: unknown },
  deps: OptionsScreenWorkflowDeps,
): Promise<OptionsScreenWorkflowOutcome> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
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
    const block = blocks.get(`options-${stageId}`)!;
    const key = stageIdempotencyKey(params.runId, stageId, "options");
    if (deps.claims.has(key)) {
      stages.push({ stageId, status: "skipped-claimed" });
      continue;
    }
    deps.claims.add(key);
    const port = deps.stages[stageId]!;
    const stageInput: OptionsStageInput = {
      runId: params.runId,
      userLogin: params.userLogin,
      stageId,
      artifactKeys: [...artifactKeys],
      request: params.request,
    };
    let output: unknown;
    try {
      output = await port.execute(stageInput);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.claims.delete?.(key);
      stages.push({ stageId, status: "failed", reason });
      return {
        outcome: "failed",
        runId: params.runId,
        stages,
        published,
        failedStage: stageId,
        reason,
      };
    }
    let terminal: string;
    try {
      terminal = readTerminal(output, new Set(Object.keys(block.stageContract.terminalSemantics)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.claims.delete?.(key);
      stages.push({ stageId, status: "failed", reason });
      return {
        outcome: "failed",
        runId: params.runId,
        stages,
        published,
        failedStage: stageId,
        reason,
      };
    }
    if (terminal === "violation") {
      const reason = "risk_violation: risk limits violated, failing closed";
      deps.claims.delete?.(key);
      stages.push({ stageId, status: "failed", reason });
      return {
        outcome: "failed",
        runId: params.runId,
        stages,
        published,
        failedStage: stageId,
        reason,
      };
    }
    let nextArtifactKeys: string[];
    try {
      nextArtifactKeys = await port.persist(stageInput, output);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.claims.delete?.(key);
      stages.push({ stageId, status: "failed", reason });
      return {
        outcome: "failed",
        runId: params.runId,
        stages,
        published,
        failedStage: stageId,
        reason,
      };
    }
    if (!params.userLogin) {
      // No authenticated identity: stage messages require a real
      // login (stageMessage refuses empty/default), so the run
      // publishes nothing. The stages themselves still ran and
      // their artifacts are the record; the skip is warned, never
      // silent, and never fails the run (the scanner leg's pinned
      // unscoped-run discipline).
      warn(`[options-workflow] ${stageId}: publish skipped (no authenticated identity; the run's stage messages are not published)`);
    } else {
      const message = buildStageBoundaryMessage({
        runId: params.runId,
        family: "options",
        userLogin: params.userLogin,
        stageId,
        artifactKeys: nextArtifactKeys,
      });
      const result = await publishStageBoundaryMessage({ queue: deps.queue ?? null, message });
      if (result.published) {
        published.push(result.message);
      } else {
        warn(`[options-workflow] ${stageId}: publish missed (${result.reason})`);
      }
    }
    const status = (
      terminal === "partial" || terminal === "no_contracts" ? terminal : "completed"
    ) as OptionsStageStatus;
    stages.push({ stageId, status, artifactKeys: nextArtifactKeys });
    artifactKeys = nextArtifactKeys;
  }

  return { outcome: "completed", runId: params.runId, stages, published };
}
