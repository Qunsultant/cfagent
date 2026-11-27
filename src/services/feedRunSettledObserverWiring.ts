/**
 * Issue #4171 — the one env-based feed run-settled observer wiring.
 *
 * Both residencies (ScheduledAgent host and JobPipelineWorkflow)
 * build their settle observer here, so a settled feed run writes
 * its Job outcomes row through the same Orchestrator door and
 * reads its own feed record through the same dataset adapter,
 * whichever residency executed it.
 */
import { createFeedDatasetAdapter } from "../data/createFeedDatasetPorts";
import type { JobOutcomeInput } from "../data/jobOutcomePorts";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import type { Env } from "../types";
import { actorGateway } from "./cloudflareActorGateway";
import { createFeedRunSettledObserver } from "./feedJobOutcomes";
import { buildFeedJobRegistry, buildFeedStatus } from "./feedJobs";

interface OrchestratorOutcomeDoor {
  recordFeedJobOutcome(input: JobOutcomeInput): Promise<void>;
}

function envStrings(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function feedRunSettledObserverForEnv(env: Env) {
  return createFeedRunSettledObserver({
    readFeedRun: async (jobId, runId) => {
      const datasetStore = createFeedDatasetAdapter(env);
      if (!datasetStore) return null;
      const def = buildFeedJobRegistry(envStrings(env)).get(jobId);
      if (!def) return null;
      const status = await buildFeedStatus(datasetStore, def, Date.now());
      return status.lastRun?.runId === runId ? status.lastRun : null;
    },
    record: async (input) => {
      const door = actorGateway.stub<OrchestratorOutcomeDoor>(
        env.ORCHESTRATOR_AGENT,
        SHARED_ORCHESTRATOR_INSTANCE,
      );
      await door.recordFeedJobOutcome(input);
    },
  });
}
