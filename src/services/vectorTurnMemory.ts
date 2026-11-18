/**
 * The chat turn's VectorMemory side effect, extracted from
 * `OrchestratorAgent` (#5058): the agent class has a standing size budget,
 * and this is a self-contained best-effort write with its own failure log.
 *
 * Behaviour is unchanged: only when the AI binding and the vector binding
 * are both present; a failure is logged, never thrown.
 */
import type { Env } from "../types";
import { VectorMemory } from "../memory/vector-memory";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/vectorTurnMemory",
});

export async function rememberTurnOutcome(
  env: Env,
  params: {
    requestId: string;
    operation: string;
    summary: string;
    success: boolean;
  },
): Promise<void> {
  const vectorizeBinding = (env as any).VECTOR_MEMORY;
  try {
    if (env.AI && vectorizeBinding) {
      const vm = new VectorMemory(env.AI, vectorizeBinding, undefined);
      await vm.remember({
        jobId: params.requestId,
        operation: params.operation,
        summary: params.summary,
        success: params.success,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    structuredLog.warn("orchestrator.vector_remember_failed", {
      message: "[VectorMemory] remember failed:",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
