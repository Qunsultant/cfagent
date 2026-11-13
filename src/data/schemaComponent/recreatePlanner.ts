/**
 * #4282 P0 — recreate planner + report.
 *
 * The planner turns a catalogue into an ordered recreate plan. Ordering
 * rule at P0: schema entries first (catalogue order), then seed entries
 * (catalogue order). The finer rule the later phases need — base
 * CREATE, then ALTER reconciliation, then indexes — is a P3 refinement
 * of this planner, not a P0 claim.
 *
 * The report is the honest-failure artefact: executed, failed, and
 * skipped (steps never reached because an earlier step failed) are
 * listed separately. Layers the component cannot create are reported
 * with a reason and a remedy, never faked as recreated — and the
 * planner does not hard-code that list: the caller supplies the
 * uncreatable layers, so the list stays a deployment fact, not a
 * component constant.
 */
import type { SchemaCatalogue } from "./catalogue";
import type {
  SchemaPlane,
  StatementKind,
} from "./catalogueTypes";
import type { ExecutionReport } from "./executor";

export interface UncreatableLayer {
  /** e.g. "vectorize:vector-memory", "r2:screener:knowledge/". */
  layer: string;
  /** Why the component cannot create it from a route. */
  reason: string;
  /** The step that provides it instead (deploy/provisioning/owner action). */
  remedy: string;
}

export interface RecreateStep {
  code: string;
  kind: StatementKind;
  plane: SchemaPlane;
  table: string;
  /** Position in the plan (0-based). */
  order: number;
}

export interface RecreatePlan {
  steps: RecreateStep[];
  uncreatable: UncreatableLayer[];
  summary: {
    schemaSteps: number;
    seedSteps: number;
    totalSteps: number;
    uncreatableLayers: number;
  };
}

export interface PlanRecreateOptions {
  uncreatableLayers?: UncreatableLayer[];
}

export function planRecreate(
  catalogue: SchemaCatalogue,
  options: PlanRecreateOptions = {},
): RecreatePlan {
  const entries = catalogue.entries();
  const ordered = [
    ...entries.filter((entry) => entry.kind === "schema"),
    ...entries.filter((entry) => entry.kind === "seed"),
  ];
  const steps: RecreateStep[] = ordered.map((entry, index) => ({
    code: entry.code,
    kind: entry.kind,
    plane: entry.plane,
    table: entry.table,
    order: index,
  }));
  const uncreatable = options.uncreatableLayers ?? [];
  return {
    steps,
    uncreatable,
    summary: {
      schemaSteps: steps.filter((step) => step.kind === "schema").length,
      seedSteps: steps.filter((step) => step.kind === "seed").length,
      totalSteps: steps.length,
      uncreatableLayers: uncreatable.length,
    },
  };
}

export interface RecreateReport {
  executed: string[];
  failed: { code: string; error: string }[];
  skipped: string[];
  uncreatable: UncreatableLayer[];
  summary: {
    totalSteps: number;
    executed: number;
    failed: number;
    skipped: number;
    uncreatableLayers: number;
  };
}

/**
 * Build the truthful report for a plan + an execution report. A step
 * is "skipped" when it is in the plan but neither executed nor failed
 * — i.e. the run stopped before reaching it.
 */
export function buildRecreateReport(
  plan: RecreatePlan,
  execution: ExecutionReport,
): RecreateReport {
  const executed = execution.results.map((result) => result.code);
  const failed = execution.failures.map((failure) => ({
    code: failure.code,
    error: failure.error,
  }));
  const settled = new Set([...executed, ...failed.map((f) => f.code)]);
  const skipped = plan.steps
    .map((step) => step.code)
    .filter((code) => !settled.has(code));
  return {
    executed,
    failed,
    skipped,
    uncreatable: plan.uncreatable,
    summary: {
      totalSteps: plan.steps.length,
      executed: executed.length,
      failed: failed.length,
      skipped: skipped.length,
      uncreatableLayers: plan.uncreatable.length,
    },
  };
}
