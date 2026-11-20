/**
 * Issue #5880 — the one externalized job catalogue.
 *
 * The job universe used to live in five lists that disagree: the
 * create form's 3 hardcoded jobs (`CreatableJob` in
 * `src/client/scheduledOptionsManager/types.ts`), OPERATION_CATALOG's
 * 21 operations (`src/orchestrate.ts`), the 9 seeded goals
 * (`config/builtin-scheduled-goals.json`), the 9 schedule kinds
 * (`src/config/scheduleListModes.ts` + `src/services/scheduleKinds.ts`),
 * and the worker-duty / derived registries
 * (`src/services/scheduleSystems.ts`, the #4237–#4242 derived
 * records). This module is the one reader for the one list:
 * `config/job-catalogue.json` — every schedulable job listed ONCE
 * with a stable unique id, its kind, its operation or callback, its
 * default cadence, and its broker/mode/account requirements.
 *
 * Follows the #4253 precedent (`builtinScheduledGoals.ts`): the list
 * lives in config, this module validates it on every read, and a new
 * job is one catalogue entry — no code change to any picker. Change
 * the JSON to change a default cadence, a label, or a broker
 * requirement; the planner view (`OPERATION_CATALOG` in
 * `src/orchestrate.ts`), the create-form picker, the system-job maps
 * (`src/client/scheduledOptionsManager/systemJobs.ts`) and the
 * Schedules home kind classification (`src/services/scheduleKinds.ts`)
 * all read through here.
 *
 * One id per job: an operation job's id IS its operation, a callback
 * job's id IS its callback, a derived duty's id IS its stable record
 * id. The id resolution work is reused, not reinvented — a job's id
 * resolves through `declaredTaskIdOf` (a code-declared task is
 * identified by its TASK id), the record-id-is-list-id rule, and
 * `canonicalJson` dedupe; see `src/services/jobCatalogueResolution.ts`
 * for the one reader that applies them. This module itself carries no
 * new id scheme: lookups are by the id, callback, operation, or form
 * job the catalogue already names.
 *
 * Fail-closed: the file values are validated on every read, and the
 * override seam (`setJobCatalogue`, used by tests to prove a config
 * change applies without a code change) validates before it replaces
 * anything — an invalid definition throws and the previous values stay
 * in place. The cron-shape check mirrors `isValidCron` in
 * `src/schedule.ts` and is kept local on purpose, the same rationale
 * as `builtinScheduledGoals.ts`: importing it back would be a module
 * cycle for the modules that import this reader.
 *
 * Environment-free: this module imports only the JSON and a type, so
 * the client bundle may import it (the create-form picker and the
 * kind classifier do) exactly like `src/client/navConfig.ts` imports
 * its JSON. Nothing here touches the Worker, the DOM, or node APIs.
 */
import raw from "../../config/job-catalogue.json";
import type { ScheduleListKind } from "./scheduleListModes";
import { isBrokerId, type BrokerId } from "../trading/brokerCatalog";

/** The Schedules home kind family a job belongs to. */
export type JobCatalogueKind = ScheduleListKind;

/** Where a catalogue entry came from — the list it unifies. */
export type JobCatalogueSource =
  | "operation-catalog"
  | "creatable-callback"
  | "internal-callback"
  | "derived-record";

/** A planner agent: the binding and blurb OPERATION_CATALOG renders. */
export interface JobCatalogueAgent {
  agent: string;
  binding: string;
  blurb: string;
}

/**
 * One job, listed once. Exactly one address: an operation job carries
 * `agent` + `operation`; a callback job carries `callback`. `formJob`
 * marks the jobs the create form offers (the `CreatableJob` key);
 * `triggerRoute` marks the jobs with an on-demand trigger route;
 * `broker`/`mode` ride only on jobs that need a broker; `account`
 * names a per-job account requirement when one exists (none does
 * today — the field is the seam, not a value).
 */
export interface JobCatalogueEntry {
  id: string;
  label: string;
  /**
   * The Schedules-home card label (`systemJobFor` in
   * `src/client/scheduledOptionsManager/systemJobs.ts`). Only the
   * three form jobs carry one: their card label ("Options Market
   * Screen") differs from their picker label ("Autonomous Options
   * Analysis"). Every other entry's card label is its `label`.
   */
  cardLabel?: string;
  description?: string;
  kind: JobCatalogueKind;
  agent?: string;
  operation?: string;
  callback?: string;
  defaultCron?: string;
  defaultTimeZone?: string;
  formJob?: string;
  triggerRoute?: string;
  requiresBroker?: boolean;
  /**
   * Which broker the job needs, when it needs one: a `BrokerId` from
   * the platform's broker registry (`src/trading/brokerCatalog.ts` —
   * the authority, not a second list here), or `"any"` when any
   * registered broker works. Reusing `BrokerId` also keeps this
   * module free of provider-brand literals (neutrality census #3525).
   */
  broker?: BrokerId | "any";
  mode?: "paper" | "live" | "either";
  account?: string;
  source: JobCatalogueSource;
  issue?: number;
  note?: string;
}

/** The catalogue file: planner agents plus the one job list. */
export interface JobCatalogueFile {
  version: number;
  agents: JobCatalogueAgent[];
  jobs: JobCatalogueEntry[];
}

/** The file values, validated once at first read. */
let fileCatalogue: JobCatalogueFile | null = null;

/**
 * The test/override seam: a replacement catalogue (validated), or
 * null to restore the file values. Module-global and reset by
 * `afterEach` in the #5880 pins — never a production input.
 */
let overrideCatalogue: JobCatalogueFile | null = null;

function isValidCronShape(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return fields.every((field, i) => {
    const [min, max] = ranges[i];
    for (const part of field.split(",")) {
      if (part === "") return false;
      const segments = part.split("/");
      if (segments.length > 2) return false;
      const step = segments.length === 2 ? Number(segments[1]) : 1;
      if (!Number.isInteger(step) || step < 1) return false;
      const base = segments[0];
      if (base === "*") continue;
      if (base.includes("-")) {
        const bounds = base.split("-");
        if (bounds.length !== 2) return false;
        const start = Number(bounds[0]);
        const end = Number(bounds[1]);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
        if (start < min || end > max || start > end) return false;
        continue;
      }
      const value = Number(base);
      if (!Number.isInteger(value) || value < min || value > max) return false;
    }
    return true;
  });
}

const SCHEDULE_LIST_KINDS: readonly string[] = [
  "queued",
  "options",
  "strategy",
  "stocks",
  "goal",
  "payment",
  "trading",
  "system",
  "other",
];

const JOB_CATALOGUE_SOURCES: readonly string[] = [
  "operation-catalog",
  "creatable-callback",
  "internal-callback",
  "derived-record",
];

/**
 * Fail-closed validation of a catalogue: every agent needs a
 * non-empty id, binding and blurb; every job needs a non-empty id,
 * label and known kind, exactly one address (an operation job carries
 * an agent, a callback job carries a callback), a valid default cron
 * and known time zone when present, a broker/mode only when it needs
 * a broker, and a description when it carries a trigger route. Ids,
 * operations, callbacks and form jobs must be unique, and every agent
 * must have at least one operation job — an agent with no jobs is a
 * second list waiting to drift. Throws naming the offending field; a
 * rejected catalogue is never installed.
 */
export function validateJobCatalogue(value: unknown): JobCatalogueFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("job catalogue: config must be an object");
  }
  const candidate = value as Partial<JobCatalogueFile>;
  if (candidate.version !== 1) {
    throw new Error("job catalogue: version must be 1");
  }
  if (!Array.isArray(candidate.agents) || candidate.agents.length === 0) {
    throw new Error("job catalogue: config must list at least one planner agent");
  }
  if (!Array.isArray(candidate.jobs) || candidate.jobs.length === 0) {
    throw new Error("job catalogue: config must be a non-empty job list");
  }
  const agentIds = new Set<string>();
  for (const agent of candidate.agents as Partial<JobCatalogueAgent>[]) {
    if (!agent || typeof agent !== "object") {
      throw new Error("job catalogue: each agent must be an object");
    }
    if (typeof agent.agent !== "string" || agent.agent.trim() === "") {
      throw new Error("job catalogue: each agent needs a non-empty id");
    }
    if (agentIds.has(agent.agent)) {
      throw new Error(`job catalogue: duplicate agent ${agent.agent}`);
    }
    agentIds.add(agent.agent);
    if (typeof agent.binding !== "string" || agent.binding.trim() === "") {
      throw new Error(`job catalogue: agent ${agent.agent} needs a non-empty binding`);
    }
    if (typeof agent.blurb !== "string" || agent.blurb.trim() === "") {
      throw new Error(`job catalogue: agent ${agent.agent} needs a non-empty blurb`);
    }
  }
  const seenIds = new Set<string>();
  const seenOperations = new Set<string>();
  const seenCallbacks = new Set<string>();
  const seenFormJobs = new Set<string>();
  const agentsWithJobs = new Set<string>();
  for (const job of candidate.jobs as Partial<JobCatalogueEntry>[]) {
    if (!job || typeof job !== "object") {
      throw new Error("job catalogue: each job must be an object");
    }
    if (typeof job.id !== "string" || job.id.trim() === "") {
      throw new Error("job catalogue: each job needs a non-empty id");
    }
    if (seenIds.has(job.id)) {
      throw new Error(`job catalogue: duplicate id ${job.id}`);
    }
    seenIds.add(job.id);
    if (typeof job.label !== "string" || job.label.trim() === "") {
      throw new Error(`job catalogue: job ${job.id} needs a non-empty label`);
    }
    if (job.cardLabel !== undefined) {
      if (typeof job.cardLabel !== "string" || job.cardLabel.trim() === "") {
        throw new Error(`job catalogue: job ${job.id} has an empty cardLabel`);
      }
    }
    if (typeof job.kind !== "string" || !SCHEDULE_LIST_KINDS.includes(job.kind)) {
      throw new Error(`job catalogue: job ${job.id} has an unknown kind ${String(job.kind)}`);
    }
    if (
      typeof job.source !== "string" ||
      !JOB_CATALOGUE_SOURCES.includes(job.source)
    ) {
      throw new Error(`job catalogue: job ${job.id} has an unknown source ${String(job.source)}`);
    }
    const hasOperation = typeof job.operation === "string" && job.operation.trim() !== "";
    const hasCallback = typeof job.callback === "string" && job.callback.trim() !== "";
    if (hasOperation === hasCallback) {
      throw new Error(
        `job catalogue: job ${job.id} needs exactly one of operation or callback`,
      );
    }
    if (hasOperation) {
      if (typeof job.agent !== "string" || job.agent.trim() === "") {
        throw new Error(`job catalogue: operation job ${job.id} needs an agent`);
      }
      if (!agentIds.has(job.agent)) {
        throw new Error(`job catalogue: job ${job.id} names unknown agent ${job.agent}`);
      }
      agentsWithJobs.add(job.agent);
      if (seenOperations.has(job.operation as string)) {
        throw new Error(`job catalogue: duplicate operation ${job.operation}`);
      }
      seenOperations.add(job.operation as string);
    }
    if (hasCallback) {
      if (job.agent !== undefined) {
        throw new Error(`job catalogue: callback job ${job.id} must not carry an agent`);
      }
      if (seenCallbacks.has(job.callback as string)) {
        throw new Error(`job catalogue: duplicate callback ${job.callback}`);
      }
      seenCallbacks.add(job.callback as string);
    }
    if (job.formJob !== undefined) {
      if (typeof job.formJob !== "string" || job.formJob.trim() === "") {
        throw new Error(`job catalogue: job ${job.id} has an empty formJob`);
      }
      if (!hasCallback) {
        throw new Error(`job catalogue: form job ${job.id} needs a callback`);
      }
      if (seenFormJobs.has(job.formJob)) {
        throw new Error(`job catalogue: duplicate formJob ${job.formJob}`);
      }
      seenFormJobs.add(job.formJob);
    }
    if (job.triggerRoute !== undefined) {
      if (typeof job.triggerRoute !== "string" || !job.triggerRoute.startsWith("/api/")) {
        throw new Error(`job catalogue: job ${job.id} has an invalid triggerRoute`);
      }
      if (typeof job.description !== "string" || job.description.trim() === "") {
        throw new Error(
          `job catalogue: job ${job.id} needs a description for its trigger route`,
        );
      }
    }
    if (job.defaultCron !== undefined) {
      if (typeof job.defaultCron !== "string" || !isValidCronShape(job.defaultCron)) {
        throw new Error(`job catalogue: job ${job.id} has an invalid cron`);
      }
    }
    if (job.defaultTimeZone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: job.defaultTimeZone });
      } catch {
        throw new Error(`job catalogue: job ${job.id} has an unknown timeZone`);
      }
    }
    if (job.requiresBroker !== undefined && typeof job.requiresBroker !== "boolean") {
      throw new Error(`job catalogue: job ${job.id} needs a boolean requiresBroker`);
    }
    if (job.broker !== undefined) {
      if (job.requiresBroker !== true) {
        throw new Error(`job catalogue: job ${job.id} names a broker without requiresBroker`);
      }
      if (job.broker !== "any" && !isBrokerId(job.broker)) {
        throw new Error(`job catalogue: job ${job.id} has an unknown broker ${job.broker}`);
      }
    }
    if (job.mode !== undefined) {
      if (job.requiresBroker !== true) {
        throw new Error(`job catalogue: job ${job.id} names a mode without requiresBroker`);
      }
      if (job.mode !== "paper" && job.mode !== "live" && job.mode !== "either") {
        throw new Error(`job catalogue: job ${job.id} has an unknown mode ${job.mode}`);
      }
    }
  }
  for (const agent of agentIds) {
    if (!agentsWithJobs.has(agent)) {
      throw new Error(`job catalogue: agent ${agent} has no operation job`);
    }
  }
  return {
    version: 1,
    agents: (candidate.agents as JobCatalogueAgent[]).map((a) => ({ ...a })),
    jobs: (candidate.jobs as JobCatalogueEntry[]).map((j) => ({ ...j })),
  };
}

/** The catalogue from config, in config order. A fresh copy on every call. */
export function getJobCatalogue(): JobCatalogueEntry[] {
  const catalogue =
    overrideCatalogue ?? (fileCatalogue ?? (fileCatalogue = validateJobCatalogue(raw)));
  return catalogue.jobs.map((job) => ({ ...job }));
}

/** The planner agents from config, in config order. A fresh copy on every call. */
export function getJobCatalogueAgents(): JobCatalogueAgent[] {
  const catalogue =
    overrideCatalogue ?? (fileCatalogue ?? (fileCatalogue = validateJobCatalogue(raw)));
  return catalogue.agents.map((agent) => ({ ...agent }));
}

/**
 * Override seam for the #5880 pins: install a replacement catalogue
 * (validated — an invalid catalogue throws and the current values
 * stay), or pass null to restore the file values.
 */
export function setJobCatalogue(value: JobCatalogueFile | null): void {
  if (value === null) {
    overrideCatalogue = null;
    return;
  }
  overrideCatalogue = validateJobCatalogue(value);
}

/** The catalogue entry with this stable id, or undefined. */
export function jobCatalogueEntryForId(id: string): JobCatalogueEntry | undefined {
  return getJobCatalogue().find((job) => job.id === id);
}

/** The catalogue entry running under this SDK callback, or undefined. */
export function jobCatalogueEntryForCallback(
  callback: string,
): JobCatalogueEntry | undefined {
  return getJobCatalogue().find((job) => job.callback === callback);
}

/** The catalogue entry for this planner/goal operation, or undefined. */
export function jobCatalogueEntryForOperation(
  operation: string,
): JobCatalogueEntry | undefined {
  return getJobCatalogue().find((job) => job.operation === operation);
}

/** The catalogue entry offered in the create form under this form-job key. */
export function jobCatalogueEntryForFormJob(
  formJob: string,
): JobCatalogueEntry | undefined {
  return getJobCatalogue().find((job) => job.formJob === formJob);
}

/**
 * The jobs the create form offers, in catalogue order: the entries
 * carrying a formJob. Adding a job to the picker is one catalogue
 * entry with a formJob — no code change to the picker.
 */
export function creatableJobCatalogueEntries(): JobCatalogueEntry[] {
  return getJobCatalogue().filter((job) => job.formJob !== undefined);
}
