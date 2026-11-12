/**
 * Issue #1996 (#1972 slice 1) — goal-screen submission onto
 * the existing ScreenerScreenWorkflow machinery, shared by
 * the manual route and the scheduled service so both entries
 * build the identical command (no divergent second shape).
 *
 * Issue #2065 contract (supersedes the #1996/#1997 null rule):
 * a start failure THROWS a WorkflowError with a stable code —
 * never null, never a generic message. The attempt is wrapped
 * in the withObservability aspect, so exactly one sink event
 * records the outcome (completion with duration, or error with
 * the code plus binding-presence facts). Callers map the code
 * to their surface: the route answers a coded 500, the
 * scheduled service audits the code. The raw message stays in
 * the server-log warn only — never in the client body or the
 * event stream. `createWorkflowPorts` itself is untouched:
 * market callers keep their null-fallback semantics; only the
 * goal start classifies a null port into a thrown code.
 */
import {
  createWorkflowPorts,
  type WorkflowEnv,
} from "../workflows/createWorkflowPorts";
import {
  WorkflowError,
  type WorkflowErrorCode,
  type WorkflowHandle,
  type WorkflowJobCommand,
} from "../workflows/workflowPorts";
import {
  withObservability,
} from "../observability/aspects";
import type { ObservabilitySink } from "../observability/observabilityPorts";
import type { ScenarioDefinition } from "./goalScenarioEngine";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/goalScreenWorkflowSubmission",
});


/** Inputs to a goal-screen workflow submission (both entries build the same shape). */
export interface GoalScreenSubmissionInput {
  /** Idempotency key: the run's key (manual timestamp key, scheduled minute-slot key). */
  jobId: string;
  /** Trigger source for audit (never branched on): "manual" or "scheduled-tasks". */
  source: string;
  trigger: "manual" | "scheduled";
  /** Owner login. Required — fail closed without an identity (#1185). */
  userLogin: string;
  /** Tenant id resolved by the starter (absent → projection best-effort skipped). */
  tenantId?: string;
  /** Resolved scenario (built from goalKind/direction, or restored from a stored record). */
  scenario: ScenarioDefinition;
  scenarioSource: "built" | "stored";
  assetClasses?: ("stocks" | "options")[];
  symbols?: string[];
  /** Delivery channels for the completed run (absent = no delivery step). */
  deliverChannels?: ("slack" | "email" | "webhook" | "voice")[];
  emailTo?: string;
  environment?: "TEST" | "PROD";
  /** Issue #1571: "yahoo" runs the stock leg on the Yahoo engine (scheduled fallback runs). */
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
  /** Issue #4279 ([One engine] #3550 S4): caller base filters, carried onto the goal command (see GoalScreenCommand). */
  baseStockFilter?: import("../types").StockScreenerFilter;
  baseOptionsFilter?: import("../types").OptionScreenerFilter;
}

/**
 * Build the goal-screen parent command. A goal run is a
 * single shard ("goal"): the goal engine screens its own
 * thesis legs internally, so there is nothing to fan out —
 * the parent machinery (poll, collate, project) runs
 * unchanged over one child.
 */
export function buildGoalScreenCommand(
  input: GoalScreenSubmissionInput,
): WorkflowJobCommand {
  return {
    jobId: input.jobId,
    type: "run-screen",
    source: input.source,
    trigger: input.trigger,
    userLogin: input.userLogin,
    role: "parent",
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    shards: [{ shardId: "goal" }],
    ...(input.deliverChannels && input.deliverChannels.length > 0 ? { deliver: true } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    goalScreen: {
      scenario: input.scenario,
      scenarioSource: input.scenarioSource,
      ...(input.assetClasses ? { assetClasses: input.assetClasses } : {}),
      ...(input.symbols ? { symbols: input.symbols } : {}),
      ...(input.deliverChannels && input.deliverChannels.length > 0
        ? { deliver: input.deliverChannels }
        : {}),
      ...(input.emailTo ? { emailTo: input.emailTo } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.providerFallback ? { providerFallback: input.providerFallback } : {}),
      ...(input.baseStockFilter ? { baseStockFilter: input.baseStockFilter } : {}),
      ...(input.baseOptionsFilter ? { baseOptionsFilter: input.baseOptionsFilter } : {}),
    },
  };
}

/** Classify a null port into the thrown code + event facts. Mirrors the composition root's order: binding first, then projection store. */
function classifyPortsFailure(env: WorkflowEnv): {
  code: WorkflowErrorCode;
  workflowBinding: "absent" | "malformed" | "present";
  projectionStore: "bound" | "unbound";
} {
  const binding = env.SCREENER_WORKFLOW;
  const projectionStore = env.AGENT_DB ? "bound" as const : "unbound" as const;
  if (!binding) {
    return { code: "workflow_binding_absent", workflowBinding: "absent", projectionStore };
  }
  const malformed =
    typeof binding !== "object" ||
    typeof (binding as { create?: unknown }).create !== "function" ||
    typeof (binding as { get?: unknown }).get !== "function";
  if (malformed) {
    return { code: "workflow_binding_malformed", workflowBinding: "malformed", projectionStore };
  }
  return { code: "projection_store_unbound", workflowBinding: "present", projectionStore };
}

/**
 * Start a goal-screen workflow. Throws WorkflowError with a
 * stable code on any failure; the aspect records exactly one
 * sink event per attempt. Callers map the code — they never
 * see null and never leak the raw message to the client.
 */
export async function startGoalScreenWorkflow(
  env: WorkflowEnv,
  command: WorkflowJobCommand,
  sink: ObservabilitySink,
): Promise<WorkflowHandle> {
  const ports = createWorkflowPorts(env);
  const failure = ports ? null : classifyPortsFailure(env);
  const facts = failure ?? { workflowBinding: "present" as const, projectionStore: "bound" as const };
  try {
    return await withObservability(
      {
        sink,
        operation: "goal.workflow.start",
        tenantId: command.tenantId ?? null,
        runId: command.jobId,
        fields: facts,
      },
      async () => {
        if (failure) {
          throw new WorkflowError(
            failure.code,
            `Goal workflow start failed: ${failure.code}.`,
          );
        }
        // ports is non-null here: failure is null exactly when
        // the port built (the assertion documents the link).
        try {
          return await ports!.start(command);
        } catch (err) {
          if (err instanceof WorkflowError) throw err;
          throw new WorkflowError(
            "start_failed",
            `Goal workflow start failed for job ${command.jobId}.`,
          );
        }
      },
    );
  } catch (err) {
    // Operator surface only: the code + job id identify the
    // failure in dashboard logs; the message stays out of the
    // client body and the event stream.
    structuredLog.warn("goalScreenWorkflowSubmission.start_failed", {
      message: "[goal-screen-workflow] Start failed",
      code: err instanceof WorkflowError ? err.code : "start_failed",
      jobId: command.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
