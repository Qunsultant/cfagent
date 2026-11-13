/**
 * Issue #4365 ([Stage visibility] externalized stage/job definitions) — the
 * definition substrate.
 *
 * A job is a SPEC, not code: its stages (and sub-stages), each stage's step
 * and parameters, its execution mode, and its schedule defaults live here,
 * are validated on load, and are addressable by id + version. The screener
 * family's six nodes and its mode are the first spec; a family that has no
 * spec refuses by name instead of inventing one.
 *
 * Validation is the contract (#1069): an unknown stage, a missing step, an
 * invalid mode or an empty stage list refuses BY NAME at load/validation
 * time — before any run starts, never as a silent fallback.
 */
import type { JobExecutionMode } from "../data/jobPipelinePorts";
import { assertExecutionModeSupported, resolveExecutionMode } from "../services/jobPipelineConfig";

/** One stage (or sub-stage) of a definition spec. */
export interface JobStageSpec {
  /** The stage kind the engine knows (feed, enrich, analyze, store, serve, deliver, …). */
  kind: string;
  /** The registered step that executes it. */
  step: string;
  /** Stage parameters, merged over the run's parameters. */
  params?: Record<string, unknown>;
  /** Nested sub-stages, when the stage composes others. */
  children?: JobStageSpec[];
}

/** A whole job definition, externalized and versioned. */
export interface JobDefinitionSpec {
  /** Addressable id (the spec's identity, not the per-run job id). */
  id: string;
  name: string;
  /** Bumped whenever the spec changes; the engine versions the resolved definition too. */
  version: number;
  /** Stages in execution order (linear; a stage may carry children). */
  stages: JobStageSpec[];
  /** The family's default execution mode; a run may override axis by axis. */
  executionMode?: Partial<JobExecutionMode>;
  /** Schedule defaults a UX flow may offer (never enabled implicitly). */
  schedule?: { enabled: boolean; cron?: string; intervalSeconds?: number };
  description?: string;
}

/** The built-in catalogue, by id. */
export const JOB_DEFINITION_SPECS: Readonly<Record<string, JobDefinitionSpec>> = {
  screener: {
    id: "screener",
    name: "Stock screener",
    version: 1,
    description:
      "The six-stage stock screen: feed → enrich → analyze → store → serve → deliver. Each stage is one engine node; the run's parameters ride every stage.",
    stages: [
      { kind: "feed", step: "screener.feed" },
      { kind: "enrich", step: "screener.gather" },
      { kind: "analyze", step: "screener.analysis" },
      { kind: "store", step: "screener.store" },
      { kind: "serve", step: "screener.serve" },
      { kind: "deliver", step: "screener.deliver" },
    ],
    executionMode: {
      concurrency: "sequential",
      pacing: "batch",
      delivery: "async",
      shape: "monolith",
    },
    schedule: { enabled: false },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, specId: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Job definition "${specId}" is invalid: ${field} must be a non-empty string — refusing rather than inventing one.`,
    );
  }
  return value.trim();
}

function resolveStage(raw: unknown, specId: string, path: string): JobStageSpec {
  if (!isRecord(raw)) {
    throw new Error(
      `Job definition "${specId}" is invalid: stage ${path} must be an object with kind and step.`,
    );
  }
  const kind = text(raw.kind, `stage ${path} kind`, specId);
  const step = text(raw.step, `stage ${path} step`, specId);
  const children = Array.isArray(raw.children)
    ? raw.children.map((child, i) => resolveStage(child, specId, `${path}.${i}`))
    : undefined;
  const params = isRecord(raw.params) ? raw.params : undefined;
  return {
    kind,
    step,
    ...(params ? { params } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  };
}

/**
 * Validate a raw spec. Every refusal names the spec, the field and the
 * reason; a partially-configured definition never resolves.
 */
export function resolveJobDefinitionSpec(raw: unknown): JobDefinitionSpec {
  if (!isRecord(raw)) {
    throw new Error("Job definition is invalid: the spec must be an object — refusing to define a job from nothing.");
  }
  const id = text(raw.id, "id", "<unknown>");
  const name = text(raw.name, `name (job definition "${id}")`, id);
  const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 1;
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    throw new Error(
      `Job definition "${id}" is invalid: it declares no stages — a job with no stages can never run, so it is refused at load time.`,
    );
  }
  const stages = raw.stages.map((stage, i) => resolveStage(stage, id, String(i)));
  let executionMode: JobExecutionMode | undefined;
  if (raw.executionMode !== undefined) {
    try {
      executionMode = resolveExecutionMode(raw.executionMode);
      assertExecutionModeSupported(executionMode);
    } catch (error) {
      throw new Error(
        `Job definition "${id}" is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const schedule = isRecord(raw.schedule)
    ? {
        enabled: raw.schedule.enabled === true,
        ...(typeof raw.schedule.cron === "string" ? { cron: raw.schedule.cron } : {}),
        ...(typeof raw.schedule.intervalSeconds === "number"
          ? { intervalSeconds: raw.schedule.intervalSeconds }
          : {}),
      }
    : undefined;
  return {
    id,
    name,
    version,
    stages,
    ...(executionMode ? { executionMode } : {}),
    ...(schedule ? { schedule } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
  };
}

/** The validated catalogue, addressable by id. */
export function listJobDefinitionSpecs(): JobDefinitionSpec[] {
  return Object.values(JOB_DEFINITION_SPECS).map((spec) => resolveJobDefinitionSpec(spec));
}

/** One spec by id; an unknown id refuses with the ids that exist. */
export function jobDefinitionSpec(id: string): JobDefinitionSpec {
  const spec = JOB_DEFINITION_SPECS[id];
  if (!spec) {
    throw new Error(
      `No job definition spec with id "${id}" exists. The specs are: ${Object.keys(JOB_DEFINITION_SPECS).join(", ")}.`,
    );
  }
  return resolveJobDefinitionSpec(spec);
}
