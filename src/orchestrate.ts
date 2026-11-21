/**
 * PR #1 — True Orchestrator: operation catalog + plan validation.
 *
 * Ported from cfpay's src/orchestrate.ts (battle-tested).
 * The catalog is a view over the one job catalogue
 * (`config/job-catalogue.json`, issue #5880) — the single source of
 * truth for plannable operations. The planner prompt is generated
 * FROM it, so the model can only propose steps that exist.
 *
 * Issue #1441 ([AGENTIC] Phase 2, sub-issue of #1362) extends this
 * compiler with a goal→capability-chain path over the Phase 1 registry
 * (src/agentic/capabilityRegistry.ts): the registry — not a second
 * catalog — is the source of truth for what a chain step may be.
 * Compile outputs only: nothing here executes, schedules, or delivers.
 */

import {
  CAPABILITY_REGISTRY,
  WORKED_EXAMPLES,
  type RegistryStage,
} from "./agentic/capabilityRegistry";
import { getJobCatalogue, getJobCatalogueAgents } from "./config/jobCatalogue";

export interface CatalogEntry {
  agent: string;
  /** Durable Object binding name on the Worker Env. */
  binding: string;
  operations: string[];
  blurb: string;
}

/**
 * Issue #5880 — the operation catalog is a VIEW over the one
 * externalized job catalogue (`config/job-catalogue.json`, read
 * through `src/config/jobCatalogue.ts`), not a second list.
 *
 * The planner prompt is still generated FROM this list, so the model
 * can only propose steps that exist — but the operations, agents,
 * bindings and blurbs now live in the catalogue: one entry per
 * operation, grouped by agent in catalogue order. Adding a plannable
 * operation is one catalogue entry (with its agent's binding and
 * blurb); the per-operation history that used to live in comments on
 * this literal now lives on the catalogue entries themselves
 * (`issue` + `note`). The shape is unchanged — `catalogAgent`,
 * `plannerPrompt`, `validateSteps` and `createJob` read this export
 * exactly as before — and `tests/job_catalogue_5880.test.ts`
 * (5880-P02) pins the derived literal against the pre-#5880 list, so
 * a catalogue edit that drops or reorders an operation fails loudly
 * instead of silently narrowing the planner.
 *
 * Load-time view, the #4253 `DEFAULT_SCHEDULES` precedent: the
 * catalogue is read once at module load. The `setJobCatalogue`
 * override seam (tests only) does not re-derive this export.
 */
export const OPERATION_CATALOG: CatalogEntry[] = (() => {
  const agents = getJobCatalogueAgents();
  const jobs = getJobCatalogue();
  return agents
    .map((agent) => ({
      agent: agent.agent,
      binding: agent.binding,
      operations: jobs
        .filter((job) => job.agent === agent.agent && job.operation)
        .map((job) => job.operation as string),
      blurb: agent.blurb,
    }))
    .filter((entry) => entry.operations.length > 0);
})();

export function catalogAgent(agent: string): CatalogEntry | undefined {
  return OPERATION_CATALOG.find((e) => e.agent === agent);
}

export interface PlanStep {
  id: string;
  agent: string;
  operation: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
}

/** Supervisor bounds: revisions per job, total steps across plan + revisions. */
export const MAX_REVISIONS = 3;
export const MAX_TOTAL_STEPS = 12;
export const MAX_PLAN_STEPS = 8;

export type SupervisorVerdict = "continue" | "stop" | "revise";

/** The planner prompt, generated from the catalog. */
export function plannerPrompt(goal: string, brief?: string): string {
  const lines = OPERATION_CATALOG.map(
    (e) => `- ${e.agent}: ${e.operations.join(", ")} - ${e.blurb}`
  );
  return [
    "You plan work for a multi-agent system. Break the goal into steps, each executed by ONE agent operation from this catalog:",
    ...lines,
    "",
    "Rules:",
    "- Reply with ONLY a JSON array of steps, no prose.",
    '- Each step: {"id": "s1", "agent": "search", "operation": "search.query", "args": {}, "dependsOn": []}.',
    "- Use dependsOn only when a step truly needs an earlier step's result; independent steps run in parallel.",
    `- At most ${MAX_PLAN_STEPS} steps. Prefer the fewest steps that achieve the goal.`,
    ...(brief ? ["", brief] : []),
    "",
    `Goal: ${goal}`,
  ].join("\n");
}

/**
 * Validate raw step objects against the catalog.
 * Returns the validated steps, or null if unusable.
 */
export function validateSteps(
  parsed: unknown,
  externalIds: Set<string> = new Set()
): PlanStep[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_PLAN_STEPS) {
    return null;
  }
  const steps: PlanStep[] = [];
  const ids = new Set<string>(externalIds);
  for (const item of parsed) {
    const s = item as Partial<PlanStep>;
    if (!s || typeof s.id !== "string" || typeof s.agent !== "string" || typeof s.operation !== "string") {
      return null;
    }
    const entry = catalogAgent(s.agent);
    if (!entry || !entry.operations.includes(s.operation)) return null;
    if (ids.has(s.id)) return null;
    ids.add(s.id);
    steps.push({
      id: s.id,
      agent: s.agent,
      operation: s.operation,
      args: s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {},
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
    });
  }
  // All dependencies must resolve
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (!ids.has(dep)) return null;
    }
  }
  // No cycles (topological check)
  const done = new Set<string>(externalIds);
  let progress = true;
  while (progress && done.size < ids.size) {
    progress = false;
    for (const s of steps) {
      if (!done.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d))) {
        done.add(s.id);
        progress = true;
      }
    }
  }
  if (done.size < ids.size) return null; // cycle
  return steps;
}

/**
 * Topological wave sort: groups steps into parallel-executable waves.
 *
 * Generic over any step shape carrying `id` + `dependsOn` (#1441):
 * PlanSteps and compiled chain steps wave-sort on this same path, so a
 * chain's waves respect its stage order. Existing PlanStep callers are
 * unaffected — PlanStep satisfies the constraint.
 */
export function topoWaves<T extends { id: string; dependsOn?: string[] }>(
  steps: T[],
): T[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const waves: T[][] = [];
  const remaining = new Set(steps.map((s) => s.id));

  while (remaining.size > 0) {
    const wave: T[] = [];
    for (const id of remaining) {
      const step = byId.get(id)!;
      if ((step.dependsOn ?? []).every((d) => done.has(d))) {
        wave.push(step);
      }
    }
    if (wave.length === 0) break;
    for (const s of wave) {
      remaining.delete(s.id);
      done.add(s.id);
    }
    waves.push(wave);
  }
  return waves;
}

// ---------------------------------------------------------------------------
// Goal compiler (#1441, Phase 2 of #1362).
//
// A user goal (plain text) compiles to a validated capability chain OVER
// the Phase 1 registry. The registry is the source of truth: a chain step
// is a registry id, its stage is the registry entry's stage (never
// caller-supplied), and only shipped or in_flight entries may appear —
// planned entries (e.g. contract-only news) are rejected, same honesty
// rule as Phase 1. Stage order is feed → generate → store → serve →
// deliver; partial chains (any stage subsequence, in order) are allowed,
// and steps within one stage run in parallel (one topoWaves wave each).
//
// Compile output is data, not execution: compiling never runs a screen,
// sends a message, creates a schedule, or touches a job. Scheduling is
// Phase 3, memory Phase 4, MCP Phase 5, governance Phase 6.
// ---------------------------------------------------------------------------

/** Canonical stage order for capability chains. */
export const CHAIN_STAGE_ORDER: RegistryStage[] = [
  "feed",
  "generate",
  "store",
  "serve",
  "deliver",
];

/** Max chain steps, mirroring the plan-step bound (MAX_TOTAL_STEPS). */
export const MAX_CHAIN_STEPS = 12;

function stageIndex(stage: RegistryStage): number {
  return CHAIN_STAGE_ORDER.indexOf(stage);
}

/** Raw caller input for one chain step; stage is registry-derived. */
export interface ChainStepInput {
  capabilityId: string;
  args?: Record<string, unknown>;
  /** Optional extra edges; must point at earlier-or-equal stages and resolve. */
  dependsOn?: string[];
}

/** A validated chain step: registry id + registry-derived stage. */
export interface CompiledChainStep {
  id: string;
  capabilityId: string;
  stage: RegistryStage;
  args: Record<string, unknown>;
  dependsOn: string[];
}

/**
 * Validate raw chain steps against the registry.
 * Returns the validated steps, or null if unusable. Rejects: unknown
 * ids, planned-only ids, out-of-order stages, duplicate ids, and
 * unresolved / forward / cyclic dependencies. A step depends on every
 * step of an earlier stage, so topoWaves yields one wave per stage.
 */
export function validateChainSteps(
  parsed: unknown,
): CompiledChainStep[] | null {
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_CHAIN_STEPS
  ) {
    return null;
  }
  const steps: CompiledChainStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Partial<ChainStepInput>;
    if (!item || typeof item.capabilityId !== "string") return null;
    const entry = CAPABILITY_REGISTRY.find(
      (e) => e.id === item.capabilityId,
    );
    // Registry is the source of truth, and the Phase 1 honesty rule
    // applies: only shipped or in_flight capabilities may be chained.
    if (!entry || (entry.status !== "shipped" && entry.status !== "in_flight")) {
      return null;
    }
    if (seen.has(item.capabilityId)) return null;
    seen.add(item.capabilityId);
    steps.push({
      id: `c${i + 1}`,
      capabilityId: item.capabilityId,
      stage: entry.stage,
      args:
        item.args && typeof item.args === "object"
          ? (item.args as Record<string, unknown>)
          : {},
      dependsOn: Array.isArray(item.dependsOn)
        ? item.dependsOn.map(String)
        : [],
    });
  }
  // Stage order: non-decreasing along the chain (partial chains allowed).
  for (let i = 1; i < steps.length; i++) {
    if (stageIndex(steps[i].stage) < stageIndex(steps[i - 1].stage)) {
      return null;
    }
  }
  // Stage edges: each step depends on every step of an earlier stage.
  for (const step of steps) {
    const stageDeps = steps
      .filter((s) => stageIndex(s.stage) < stageIndex(step.stage))
      .map((s) => s.id);
    step.dependsOn = [...new Set([...stageDeps, ...step.dependsOn])];
  }
  // Caller dependencies must resolve, must not point at a later stage
  // (that would be an out-of-order edge), and must not cycle.
  const ids = new Set(steps.map((s) => s.id));
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) return null;
      if (stageIndex(byId.get(dep)!.stage) > stageIndex(step.stage)) {
        return null;
      }
    }
  }
  const done = new Set<string>();
  let progress = true;
  while (progress && done.size < ids.size) {
    progress = false;
    for (const s of steps) {
      if (!done.has(s.id) && s.dependsOn.every((d) => done.has(d))) {
        done.add(s.id);
        progress = true;
      }
    }
  }
  if (done.size < ids.size) return null; // cycle
  return steps;
}

/** A compiled goal: validated chain + budget + execution shape (not execution). */
export interface CompiledChain {
  goal: string;
  steps: CompiledChainStep[];
  /** Declared budget in cents. */
  budgetCents: number;
  /** Cap the budget was checked against, or null when uncapped. */
  budgetCapCents: number | null;
  /** "recurring" = synthesized schedule candidate (Phase 3); "one-shot" = single run. */
  recurrence: "recurring" | "one-shot";
  /** True when the chain serves a stored report instead of generating one. */
  reusesStoredReport: boolean;
}

/** Distinct stages of a compiled chain, in chain order. */
export function chainStages(chain: CompiledChain): RegistryStage[] {
  const stages: RegistryStage[] = [];
  for (const step of chain.steps) {
    if (!stages.includes(step.stage)) stages.push(step.stage);
  }
  return stages;
}

/** Delivery channels a compiled chain uses ("slack" / "email" / "channel"). */
export function chainDeliveryChannels(chain: CompiledChain): string[] {
  const channels: string[] = [];
  for (const step of chain.steps) {
    if (step.stage !== "deliver") continue;
    if (step.capabilityId === "deliver-slack") channels.push("slack");
    else if (step.capabilityId === "deliver-email") channels.push("email");
    else if (step.capabilityId === "deliver-channel") channels.push("channel");
  }
  return channels;
}

function validBudget(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

/**
 * Compile an explicit chain: validate steps against the registry and
 * check the declared budget against the cap. The registry carries no
 * per-capability cost, so the cap is a declared-budget gate
 * (budgetCents ≤ budgetCapCents), not a summed step cost — a cost
 * model, if wanted, is a follow-up decision, not smuggled in here.
 */
export function compileChain(input: {
  goal: string;
  steps: unknown;
  budgetCents: number;
  budgetCapCents?: number | null;
  recurrence?: "recurring" | "one-shot";
  reusesStoredReport?: boolean;
}): CompiledChain | null {
  if (typeof input.goal !== "string" || input.goal.length === 0) return null;
  if (!validBudget(input.budgetCents)) return null;
  const cap = input.budgetCapCents ?? null;
  if (cap !== null && (!validBudget(cap) || input.budgetCents > cap)) {
    return null;
  }
  const steps = validateChainSteps(input.steps);
  if (!steps) return null;
  return {
    goal: input.goal,
    steps,
    budgetCents: input.budgetCents,
    budgetCapCents: cap,
    recurrence: input.recurrence ?? "one-shot",
    reusesStoredReport: input.reusesStoredReport ?? false,
  };
}

/**
 * The chain planner prompt, generated FROM the registry (same pattern as
 * plannerPrompt from OPERATION_CATALOG): only shipped/in-flight entries
 * are offered, with the stage order and budget rules stated so that an
 * LLM-proposed chain is validatable by validateChainSteps.
 */
export function chainPlannerPrompt(goal: string, brief?: string): string {
  const offered = CAPABILITY_REGISTRY.filter(
    (e) => e.status === "shipped" || e.status === "in_flight",
  );
  const lines = CHAIN_STAGE_ORDER.map((stage) => {
    const entries = offered.filter((e) => e.stage === stage);
    return `${stage}: ${entries.map((e) => e.id).join(", ")}`;
  });
  return [
    "You plan work as a capability chain. Break the goal into steps, each a registry capability id from this list, grouped by stage:",
    ...lines,
    "",
    "Rules:",
    "- Reply with ONLY a JSON array of steps, no prose.",
    '- Each step: {"capabilityId": "feed-dataprovider", "args": {}}.',
    "- Stage order is feed → generate → store → serve → deliver; steps must appear in that order, and partial chains (any subsequence in order) are allowed.",
    "- Use only the capability ids listed above; planned capabilities are not offered and must not be used.",
    "- The chain carries a budget in cents; the compiled budget must not exceed its cap.",
    ...(brief ? ["", brief] : []),
    "",
    `Goal: ${goal}`,
  ].join("\n");
}

function stepsFromWorkedExample(exampleId: string): ChainStepInput[] {
  const example = WORKED_EXAMPLES.find((e) => e.id === exampleId);
  if (!example) return [];
  return example.steps.flatMap((step) =>
    step.entryIds.map((capabilityId) => ({ capabilityId })),
  );
}

/**
 * Compile a plain-text goal deterministically. Only the two worked
 * shapes are recognized; anything else returns null rather than a
 * hallucinated chain (general free-text goals go through the planner
 * prompt + validator path, and Phase 3 composition, not keyword
 * guessing). A goal naming both delivery channels is ambiguous and
 * also returns null — the compiler never guesses a leg.
 */
export function compileGoal(
  goalText: string,
  options: { budgetCents: number; budgetCapCents?: number | null },
): CompiledChain | null {
  if (typeof goalText !== "string") return null;
  const normalized = goalText.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  const has = (...words: string[]) => words.every((w) => normalized.includes(w));

  // Worked example 1: NASDAQ100 screen → Slack. Full chain, Slack only.
  if (
    has("nasdaq100") &&
    (has("screen") || normalized.includes("screener")) &&
    has("slack") &&
    !has("email")
  ) {
    return compileChain({
      goal: goalText,
      steps: stepsFromWorkedExample("example-nasdaq100-slack").map((s) => ({
        ...s,
        args:
          s.capabilityId === "feed-dataprovider" ||
          s.capabilityId === "feed-screener-pipeline"
            ? { universe: "NASDAQ100" }
            : s.capabilityId === "deliver-slack"
              ? { channel: "slack" }
              : {},
      })),
      budgetCents: options.budgetCents,
      budgetCapCents: options.budgetCapCents ?? null,
      recurrence: "recurring",
      reusesStoredReport: false,
    });
  }

  // Worked example 2: yesterday's report by email. Serve → deliver
  // only, stored report reused, one-shot, no regeneration.
  if (
    has("yesterday") &&
    has("report") &&
    has("email") &&
    !has("slack") &&
    !has("screen")
  ) {
    return compileChain({
      goal: goalText,
      steps: stepsFromWorkedExample("example-yesterday-report-email").map(
        (s) => ({
          ...s,
          args:
            s.capabilityId === "serve-options-latest" ||
            s.capabilityId === "serve-report-pdf"
              ? { reportRef: "yesterday" }
              : s.capabilityId === "deliver-email"
                ? { channel: "email" }
                : {},
        }),
      ),
      budgetCents: options.budgetCents,
      budgetCapCents: options.budgetCapCents ?? null,
      recurrence: "one-shot",
      reusesStoredReport: true,
    });
  }

  return null;
}

/** Supervisor prompt: review wave results, verdict continue/stop/revise. */
export function supervisorPrompt(
  goal: string,
  completedSteps: { id: string; operation: string; result: string }[],
  revisionCount: number
): string {
  return [
    "You supervise a multi-agent plan. Review the completed steps below.",
    `Goal: ${goal}`,
    "",
    "Completed steps:",
    ...completedSteps.map((s) => `- ${s.id} (${s.operation}): ${s.result.slice(0, 500)}`),
    "",
    `Revisions used: ${revisionCount}/${MAX_REVISIONS}`,
    "",
    "Reply with ONLY one JSON object:",
    '{"verdict": "continue" | "stop" | "revise", "reason": "...", "newSteps": [...]}',
    '"continue": plan is on track, execute remaining steps.',
    '"stop": goal achieved or unachievable; no further steps needed.',
    '"revise": plan needs adjustment; provide newSteps (validated like the original plan).',
  ].join("\n");
}

/**
 * Create an orchestrator job for a scheduled goal.
 * Called by ScheduledAgent.onCron() — validates the goal's operation
 * against the catalog and returns a job descriptor.
 * Full plan execution happens via the worker's orchestration endpoint.
 */
export interface OrchestratorJob {
  jobId: string;
  goalId: string;
  goalName: string;
  operation: string;
  budgetCents: number;
  createdAt: string;
  status: "pending";
}

export async function createJob(
  env: unknown,
  req: {
    goalId: string;
    goalName: string;
    operation: string;
    budgetCents: number;
  }
): Promise<OrchestratorJob> {
  // Validate the operation exists in the catalog
  const entry = OPERATION_CATALOG.find((e) => e.operations.includes(req.operation));
  if (!entry) {
    throw new Error(`Unknown operation: ${req.operation}`);
  }
  return {
    jobId: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    goalId: req.goalId,
    goalName: req.goalName,
    operation: req.operation,
    budgetCents: req.budgetCents,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}
