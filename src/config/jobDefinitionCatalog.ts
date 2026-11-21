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
 *
 * Issue #5493 — a spec may also declare the AXES it runs on (provider,
 * dataset, universe, sector, exchange, …). An axis value is never a free
 * string: it resolves through the one vocabulary (#5515) on every read, so
 * an unknown axis or an unknown/conflated value refuses BY NAME with the
 * vocabulary's own code, and a parameter whose value names an axis binds
 * through the same resolver.
 */
import type { JobExecutionMode } from "../data/jobPipelinePorts";
import { assertExecutionModeSupported, resolveExecutionMode } from "../services/jobPipelineConfig";
import { hasEnumSource, hasParamDerivation } from "./jobDefinitionParamRegistry";
import { AXES, isAxis, resolveValue, type Axis } from "./vocabulary";

/** One stage (or sub-stage) of a definition spec. */
export interface JobStageSpec {
  /** The stage kind the engine knows (feed, enrich, analyze, store, serve, deliver, …). */
  kind: string;
  /** The registered step that executes it. */
  step: string;
  /** Stage parameters, merged over the run's parameters. */
  params?: Record<string, unknown>;
  /**
   * Issue #4466 — this stage's declared parameters, surfaced by the UX so a
   * caller can set them per stage. `params` above are the spec's own values;
   * these describe what a caller may override.
   */
  parameters?: JobDefinitionParameter[];
  /**
   * Issue #4466 — per-stage execution-mode override. The engine already
   * merges it over the job's resolved mode (`JobNodeConfig.executionMode` +
   * `effectiveMode`), so this is a surface, not a new capability.
   */
  executionMode?: Partial<JobExecutionMode>;
  /**
   * Issue #4479 — this stage's own cadence. The engine already walks nodes
   * in `registerSchedules` and arms `node.schedule`, so a stage cadence is a
   * surface over an existing capability (one task id per stage:
   * `pipeline:<jobId>:<nodePath>`).
   */
  schedule?: { enabled: boolean; cron?: string; interval?: string };
  /** Nested sub-stages, when the stage composes others. */
  children?: JobStageSpec[];
}

/** Setting reference for declarative parameter defaults (resolved at bind time). */
export interface JobParameterSettingRef {
  setting: string;
}

/** One parameter the UX flow must collect before scheduling a definition. */
export interface JobDefinitionParameter {
  name: string;
  label: string;
  /**
   * `multi-select` and `list` are arrays of strings (#5493): a multi-select
   * is declared over a vocabulary axis (each value resolves through it), a
   * list carries free strings (e.g. shard keys).
   */
  type: "select" | "multi-select" | "text" | "list" | "number" | "boolean";
  required?: boolean;
  description?: string;
  /**
   * Issue #5493 — the vocabulary axis the value names. Resolved through
   * `src/config/vocabulary.ts` at bind time: an alias binds to its canonical
   * id, an unknown value refuses by name, and a conflated value refuses with
   * the pointer to the axis it belongs to. One list, one reader — a
   * parameter never carries its own copy of an axis's values.
   */
  axis?: Axis;
  /** Filled by the API for select parameters whose options come from a registry. */
  options?: string[];
  /** Named enum source in `ENUM_SOURCES` (validated at load time). */
  enumSource?: string;
  /** Literal default or `{ setting: key }` reference resolved at bind time. */
  default?: unknown;
  /** Named derivation in `PARAM_DERIVATIONS` (validated at load time). */
  derivation?: string;
  /** Issue #5493 — inclusive bounds of a number parameter, declared by the spec. */
  minimum?: number;
  maximum?: number;
  /**
   * Issue #5493 — this number parameter may not sit below the named
   * parameter's bound value (`maxDte` never below `minDte`). Enforced only
   * when both are bound; nothing is invented for an absent one.
   */
  atLeast?: string;
  /**
   * Issue #5493 — each value must serve the capability the named parameter
   * names (a provider set against its dataset). Checked at bind time against
   * the adapters' declared capabilities; a provider the declaration
   * projection does not know is left to the run-time registry (#5494).
   */
  capabilityFrom?: string;
}

/** A whole job definition, externalized and versioned. */
export interface JobDefinitionSpec {
  /** Addressable id (the spec's identity, not the per-run job id). */
  id: string;
  /**
   * Issue #4774 — the chain's short id (user ruling, comment 6912854849,
   * 2026-11-16): the alias a run of this spec is named, traced, and
   * surfaced under. The stable `id` is unchanged.
   */
  shortId?: string;
  name: string;
  /** Bumped whenever the spec changes; the engine versions the resolved definition too. */
  version: number;
  /**
   * Issue #5493 — the axes this definition declares (its default subset),
   * resolved through the one vocabulary (#5515) on every read. An axis the
   * vocabulary does not have refuses by name, and so does a value that is
   * unknown or conflated — with the vocabulary's own code.
   */
  axes?: Partial<Record<Axis, string>>;
  /** Stages in execution order (linear; a stage may carry children). */
  stages: JobStageSpec[];
  /** The family's default execution mode; a run may override axis by axis. */
  executionMode?: Partial<JobExecutionMode>;
  /**
   * The run parameters the flow must collect. A declared parameter is the
   * only thing a caller may supply; an undeclared one refuses (no silent
   * ignore), and a required one with no value refuses by name.
   */
  parameters?: JobDefinitionParameter[];
  /** Schedule defaults a UX flow may offer (never enabled implicitly). */
  schedule?: { enabled: boolean; cron?: string; intervalSeconds?: number };
  description?: string;
}

/** The built-in catalogue, by id. */
export const JOB_DEFINITION_SPECS: Readonly<Record<string, JobDefinitionSpec>> = {
  screener: {
    id: "screener",
    shortId: "stockscr",
    name: "Stock screener",
    version: 2,
    description:
      "stockscr — the five-node generic stock screen: feed → enrich → analyze → generate → deliver. Each stage is one engine node running a generic family step; the run's parameters ride every stage, and the builder computes the family job ids per command (provider + universe → feed job → derived chain) and injects them into the per-node params. The deliver node stays the bespoke screener.deliver step until 6c (#5885) flips it.",
    stages: [
      { kind: "feed", step: "feed.pull" },
      { kind: "enrich", step: "enrich.screener" },
      {
        kind: "analyze",
        step: "analyze.screener",
        params: { ruleSets: ["screen", "factors"], inputMode: "handOff" },
      },
      { kind: "generate", step: "generate.apply", params: { reports: ["screener-report"] } },
      { kind: "deliver", step: "screener.deliver" },
    ],
    parameters: [
      {
        name: "universe",
        label: "Universe",
        type: "select",
        required: true,
        enumSource: "universes",
        derivation: "shardsForUniverse",
        description: "The universe the scheduled screen runs over.",
      },
      {
        name: "deliver",
        label: "Deliver",
        type: "boolean",
        required: false,
        default: false,
        description: "Whether to deliver the report automatically after the scheduled screen completes.",
      },
    ],
    executionMode: {
      concurrency: "sequential",
      pacing: "batch",
      delivery: "async",
      shape: "monolith",
    },
    schedule: { enabled: false },
  },
  feed: {
    id: "feed",
    name: "Feed pull",
    version: 1,
    description:
      "The feed family's one stage: feed.pull over a registered feed job, with the run parameters a feed input carries — the job to pull, the universe a parameterized job pulls, the sources and dataset a composing run names, the shard keys, and the chain DTE window.",
    // Issue #5493 — the family's declared axes, resolved through the one
    // vocabulary (#5515) on every read. The provider axis is declared by
    // `sources` below, not here: a job's own source is the feed registry's
    // record, and repeating it as a family default would be a second
    // statement of what the registry already says.
    axes: { dataset: "quotes", universe: "nasdaq100" },
    // The step name is FEED_PULL_STEP (src/services/feedPipelineJobs.ts).
    // Spelled here to keep config free of the services graph; the #5493 pin
    // asserts the two declarations are the same string, so drift fails
    // loudly rather than silently running a non-feed stage.
    stages: [{ kind: "feed", step: "feed.pull" }],
    parameters: [
      {
        name: "feedJobId",
        label: "Feed job",
        type: "text",
        required: true,
        description:
          "The registered feed job the stage pulls (a feed job id, e.g. the default quotes job). An unregistered id refuses at run time by name; one is never invented.",
      },
      {
        name: "universe",
        label: "Universe",
        type: "select",
        axis: "universe",
        description:
          "The stored index list a parameterized feed job pulls. Absent ⇒ the job's own universe; a fixed-universe job refuses a universe input by name.",
      },
      {
        name: "sources",
        label: "Sources",
        type: "multi-select",
        axis: "provider",
        capabilityFrom: "dataset",
        description:
          "The data providers a composing run may pull from. Absent ⇒ the job's registered source. Each named provider must serve the requested dataset.",
      },
      {
        name: "dataset",
        label: "Dataset",
        type: "select",
        axis: "dataset",
        description:
          "The dataset the named sources are asked for. Absent ⇒ the job's registered dataset.",
      },
      {
        name: "shards",
        label: "Shards",
        type: "list",
        description:
          "The shard keys a sharded run partitions the universe by. Absent ⇒ the job's configured processing.shards.",
      },
      {
        name: "minDte",
        label: "Minimum DTE",
        type: "number",
        minimum: 0,
        description: "Options-chains jobs only: the shortest days-to-expiry a chain pull may include.",
      },
      {
        name: "maxDte",
        label: "Maximum DTE",
        type: "number",
        minimum: 0,
        atLeast: "minDte",
        description:
          "Options-chains jobs only: the longest days-to-expiry a chain pull may include; never below minDte.",
      },
    ],
    schedule: { enabled: false },
  },

  goalScreen: {
    id: "goalScreen",
    shortId: "goalscr",
    name: "Goal screen",
    version: 1,
    description:
      "goalscr — the goal screen: feed → enrich → goal → store → serve → deliver. The goal leg's own definition (#5873): the analyze node is the goal dispatch (screener.goal), never the market analyze step — a goal command is a dispatch (quota charge, trade client, goal universe deps, options leg, production goal screen), not a computation expressible as a generic analyze rule set.",
    stages: [
      { kind: "feed", step: "screener.feed" },
      { kind: "enrich", step: "screener.gather" },
      { kind: "analyze", step: "screener.goal" },
      { kind: "store", step: "screener.store" },
      { kind: "serve", step: "screener.serve" },
      { kind: "deliver", step: "screener.deliver" },
    ],
    parameters: [
      {
        name: "deliver",
        label: "Deliver",
        type: "boolean",
        required: false,
        default: false,
        description: "Whether to deliver the report automatically after the goal screen completes.",
      },
    ],
    executionMode: {
      concurrency: "sequential",
      pacing: "batch",
      delivery: "async",
      shape: "monolith",
    },
    schedule: { enabled: false },
  },
  research: {
    id: "research",
    shortId: "oodares",
    name: "Nightly OODA research",
    version: 1,
    description:
      "oodares — the six-stage nightly OODA options research pipeline: feed → enrich → analyze → generate → deliver → evaluate.",
    stages: [
      {
        kind: "research",
        step: "noop",
        children: [
          { kind: "feed", step: "noop" },
          { kind: "enrich", step: "noop" },
          { kind: "analyze", step: "analyze.ooda" },
          { kind: "generate", step: "noop" },
          { kind: "deliver", step: "noop" },
          { kind: "evaluate", step: "evaluate.apply" },
        ],
      },
    ],
    parameters: [
      {
        name: "runId",
        label: "Run ID",
        type: "text",
        required: false,
        description: "Optional run identifier for the research:<runId> engine job.",
      },
      {
        name: "sourceId",
        label: "Source ID",
        type: "text",
        required: false,
        default: "primary-feed",
        description: "Primary market data source id.",
      },
      {
        name: "dataset",
        label: "Dataset",
        type: "text",
        required: false,
        default: "quotes",
        description: "Dataset name fed into the research pipeline.",
      },
      {
        name: "trigger",
        label: "Trigger",
        type: "select",
        required: false,
        options: ["manual", "scheduled"],
        default: "manual",
        description: "How the research run was triggered.",
      },
      {
        name: "cron",
        label: "Cron",
        type: "text",
        required: false,
        description: "Optional cron expression for scheduled runs.",
      },
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
  const parameters = Array.isArray(raw.parameters)
    ? raw.parameters.map((param) => resolveParameter(param, specId))
    : undefined;
  let executionMode: Partial<JobExecutionMode> | undefined;
  if (raw.executionMode !== undefined) {
    try {
      // Validate the axes and the substrate rule now; keep only what was set,
      // so the node's override stays an override (the root supplies the rest).
      assertExecutionModeSupported(resolveExecutionMode(raw.executionMode));
      if (!isRecord(raw.executionMode)) {
        throw new Error("stage executionMode must be an object.");
      }
      executionMode = raw.executionMode as Partial<JobExecutionMode>;
    } catch (error) {
      throw new Error(
        `Job definition "${specId}" stage ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const schedule = isRecord(raw.schedule)
    ? resolveStageSchedule(raw.schedule, specId, path)
    : undefined;
  return {
    kind,
    step,
    ...(params ? { params } : {}),
    ...(parameters && parameters.length > 0 ? { parameters } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(schedule ? { schedule } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  };
}

/**
 * Issue #4479 — one stage's cadence. The engine's own rule (an enabled
 * schedule needs a cron expression or an interval) is enforced here so the
 * refusal happens at load time, and both at once is refused as ambiguous:
 * `registerSchedules` would arm one schedule with two sources.
 */
function resolveStageSchedule(
  raw: Record<string, unknown>,
  specId: string,
  path: string,
): { enabled: boolean; cron?: string; interval?: string } {
  const fail = (reason: string): never => {
    throw new Error(`Job definition "${specId}" stage ${path} schedule is invalid: ${reason}`);
  };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    fail('"enabled" must be a boolean.');
  }
  const enabled = raw.enabled === true;
  const cron = typeof raw.cron === "string" && raw.cron.trim() ? raw.cron.trim() : undefined;
  const interval =
    typeof raw.interval === "string" && raw.interval.trim() ? raw.interval.trim() : undefined;
  if (raw.cron !== undefined && cron === undefined) fail('"cron" must be a non-empty string.');
  if (raw.interval !== undefined && interval === undefined) fail('"interval" must be a non-empty string.');
  if (cron && interval) fail("a stage schedule takes a cron expression or an interval, not both.");
  if (enabled && !cron && !interval) fail("an enabled schedule requires a cron expression or an interval.");
  return {
    enabled,
    ...(cron ? { cron } : {}),
    ...(interval ? { interval } : {}),
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
  // Issue #4774 — the chain short id rides the resolved spec when the
  // raw spec declares one; a non-string value refuses, like any other
  // malformed field, rather than being silently dropped.
  let shortId: string | undefined;
  if (raw.shortId !== undefined) {
    shortId = text(raw.shortId, `shortId (job definition "${id}")`, id);
  }
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
  const axes = resolveSpecAxes(raw.axes, id);
  const parameters = Array.isArray(raw.parameters)
    ? raw.parameters.map((param) => resolveParameter(param, id))
    : undefined;
  // Issue #5493 — a cross-parameter rule may only name a parameter the spec
  // declares; a typo refuses at load time, never as a silently unenforced rule.
  if (parameters) {
    const names = new Set(parameters.map((param) => param.name));
    for (const param of parameters) {
      for (const field of ["atLeast", "capabilityFrom"] as const) {
        const target = param[field];
        if (target !== undefined && !names.has(target)) {
          throw new Error(
            `Job definition "${id}" parameter "${param.name}" ${field} names "${target}", which the definition does not declare — it declares: ${[...names].join(", ")}.`,
          );
        }
      }
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
    ...(shortId ? { shortId } : {}),
    name,
    version,
    stages,
    ...(axes ? { axes } : {}),
    ...(parameters && parameters.length > 0 ? { parameters } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(schedule ? { schedule } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
  };
}

/**
 * Issue #5493 — resolve a spec's declared axis set through the one vocabulary.
 * An unknown axis refuses by name; an unknown or conflated value refuses with
 * the vocabulary's own code, so the spec and the API speak one refusal
 * language. An alias resolves to its canonical id — the spec stores the
 * canonical value, never the spelling a caller happened to use.
 */
function resolveSpecAxes(raw: unknown, specId: string): Partial<Record<Axis, string>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(
      `Job definition "${specId}" is invalid: axes must be an object of axis → value.`,
    );
  }
  const resolved: Partial<Record<Axis, string>> = {};
  for (const [axis, value] of Object.entries(raw)) {
    if (!isAxis(axis)) {
      throw new Error(
        `Job definition "${specId}" is invalid: "${axis}" is not a vocabulary axis (#5515). The axes are: ${AXES.join(", ")}.`,
      );
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `Job definition "${specId}" is invalid: axis "${axis}" must name a value as a non-empty string.`,
      );
    }
    const one = resolveValue(axis, value);
    if (!one.ok) {
      throw new Error(
        `Job definition "${specId}" is invalid: axis "${axis}": ${one.code}: ${one.message}`,
      );
    }
    resolved[axis] = one.value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolveParameter(raw: unknown, specId: string): JobDefinitionParameter {
  if (!isRecord(raw)) {
    throw new Error(`Job definition "${specId}" is invalid: a parameter must be an object.`);
  }
  const name = text(raw.name, "parameter name", specId);
  const rawType = raw.type;
  if (
    rawType !== undefined &&
    rawType !== "select" &&
    rawType !== "multi-select" &&
    rawType !== "text" &&
    rawType !== "list" &&
    rawType !== "number" &&
    rawType !== "boolean"
  ) {
    throw new Error(
      `Job definition "${specId}" parameter "${name}" has unsupported type "${String(rawType)}".`,
    );
  }
  const type = rawType ?? "select";
  const options = Array.isArray(raw.options)
    ? raw.options.filter((option): option is string => typeof option === "string" && option !== "")
    : undefined;
  let enumSource: string | undefined;
  if (raw.enumSource !== undefined) {
    enumSource = text(raw.enumSource, `parameter "${name}" enumSource`, specId);
    if (!hasEnumSource(enumSource)) {
      throw new Error(
        `Job definition "${specId}" parameter "${name}" references unknown enumSource "${enumSource}".`,
      );
    }
  }
  let derivation: string | undefined;
  if (raw.derivation !== undefined) {
    derivation = text(raw.derivation, `parameter "${name}" derivation`, specId);
    if (!hasParamDerivation(derivation)) {
      throw new Error(
        `Job definition "${specId}" parameter "${name}" references unknown derivation "${derivation}".`,
      );
    }
  }
  // Issue #5493 — a parameter that names a vocabulary axis holds only that
  // axis's values: one source per parameter (an axis plus its own
  // options/enumSource would be a second list), and an axis value is a
  // select or a multi-select.
  let axis: Axis | undefined;
  if (raw.axis !== undefined) {
    const axisName = text(raw.axis, `parameter "${name}" axis`, specId);
    if (!isAxis(axisName)) {
      throw new Error(
        `Job definition "${specId}" parameter "${name}" references unknown vocabulary axis "${axisName}". The axes are: ${AXES.join(", ")}.`,
      );
    }
    if (type !== "select" && type !== "multi-select") {
      throw new Error(
        `Job definition "${specId}" parameter "${name}" declares the vocabulary axis "${axisName}" with type "${type}" — an axis value is a select or a multi-select.`,
      );
    }
    if (enumSource !== undefined || (options !== undefined && options.length > 0)) {
      throw new Error(
        `Job definition "${specId}" parameter "${name}" declares both the vocabulary axis "${axisName}" and its own options/enumSource — one source per parameter, and the vocabulary is the one list.`,
      );
    }
    axis = axisName;
  }
  const minimum = resolveNumberField(raw.minimum, specId, name, "minimum");
  const maximum = resolveNumberField(raw.maximum, specId, name, "maximum");
  if ((minimum !== undefined || maximum !== undefined) && type !== "number") {
    throw new Error(
      `Job definition "${specId}" parameter "${name}" declares bounds with type "${type}" — minimum/maximum belong to a number parameter.`,
    );
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new Error(
      `Job definition "${specId}" parameter "${name}" declares minimum ${minimum} above maximum ${maximum} — refusing rather than an empty range.`,
    );
  }
  const atLeast =
    raw.atLeast !== undefined ? text(raw.atLeast, `parameter "${name}" atLeast`, specId) : undefined;
  if (atLeast !== undefined && type !== "number") {
    throw new Error(
      `Job definition "${specId}" parameter "${name}" declares atLeast with type "${type}" — a lower-bound relation belongs to a number parameter.`,
    );
  }
  const capabilityFrom =
    raw.capabilityFrom !== undefined
      ? text(raw.capabilityFrom, `parameter "${name}" capabilityFrom`, specId)
      : undefined;
  let defaultValue = raw.default;
  if (isRecord(defaultValue)) {
    if (typeof defaultValue.setting !== "string" || defaultValue.setting.trim() === "") {
      throw new Error(
        `Job definition "${specId}" parameter "${name}" default setting reference must have a non-empty "setting" key.`,
      );
    }
    defaultValue = { setting: defaultValue.setting.trim() };
  }
  return {
    name,
    label: typeof raw.label === "string" && raw.label ? raw.label : name,
    type,
    ...(raw.required === true ? { required: true } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(axis ? { axis } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(enumSource ? { enumSource } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(derivation ? { derivation } : {}),
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
    ...(atLeast !== undefined ? { atLeast } : {}),
    ...(capabilityFrom !== undefined ? { capabilityFrom } : {}),
  };
}

/** Issue #5493 — a declared numeric bound: absent ⇒ absent; anything else must be finite. */
function resolveNumberField(
  raw: unknown,
  specId: string,
  paramName: string,
  field: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `Job definition "${specId}" parameter "${paramName}" ${field} must be a finite number.`,
    );
  }
  return raw;
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
