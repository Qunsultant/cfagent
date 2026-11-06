/**
 * Issue #1466 ([AGENTIC] Phase 5, sub-issue of #1362) — MCP exposure
 * of the Phase 1–4 definitions.
 *
 * Exactly three tools, registered in McpToolFactory alongside (never
 * instead of, never duplicating) the ~30 single-capability tools:
 *   - `goal.compile`  — Phase 2 compile over the Phase 1 registry,
 *     with Phase 4 prior-plan reuse + provenance when the MCP
 *     context carries the AI + Vectorize bindings.
 *   - `goal.schedule` — Phase 3 synthesis; returns a PENDING record
 *     only. The synthesized record type carries NO `enabled` field
 *     and `approveSynthesizedRecord` is the only path to live, so
 *     there is no MCP path that can enable a schedule.
 *   - `chain.run`     — re-validates the chain (registry, stages,
 *     order, budget) BEFORE reporting any leg, creates no scheduled
 *     job, no synthesized record, and no async job, and performs no
 *     paid action.
 *
 * One definition, two consumers: these tools call the SAME
 * `compileGoal` / `compileChain` / `synthesizeSchedule` /
 * `compileGoalWithMemory` the planner uses — no second compiler,
 * no second validator, no second synthesis record shape.
 *
 * HONESTY RULE for `chain.run`: the existing stage executors (the
 * #1355 shard executors, the async-job followup jobs) need DO/SQL
 * runtime deps the MCP command context does not carry, and invoking
 * them from MCP would create jobs — which this phase forbids. So
 * the MCP command supplies NO leg executor, and every production
 * leg reports as `unimplemented` with the reason, rather than
 * inventing execution. `runChain` itself is executor-agnostic: a
 * caller that DOES supply an executor gets real per-leg dispatch,
 * a failed leg skips later legs, and a paid leg is gated on the
 * existing PaymentsAgent budget-check path — see
 * `RunChainOptions.budgetCheck`. Lane 2 (#1523) supplies that
 * executor as `src/agentic/chainExecutor.ts`
 * (`createChainLegExecutor` over a caller-supplied DO/SQL runtime,
 * wired through the governed firing path in ScheduledAgent) — the
 * MCP command still supplies none, because the MCP context still
 * carries no such runtime. A leg the executor cannot run in its
 * context throws `LegNotExecutableError` and reports as
 * `unimplemented` with the real reason; a serve leg submitted to
 * the async-job rails reports as `submitted`, never `completed`.
 *
 * Auth: none of these tools authenticates anything. The server
 * route (`/mcp`, src/server.ts, #180) rejects callers without an
 * app session or a valid per-user `cfk_` API key before any DO
 * access; these commands ride that path exactly like every other
 * tool in the factory.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  compileChain,
  compileGoal,
  type CompiledChain,
  type CompiledChainStep,
} from "../../orchestrate";
import {
  compileGoalWithMemory,
  describeReuse,
  type PlanReuse,
} from "../../agentic/compositionMemory";
import {
  shouldFireSynthesized,
  synthesizeSchedule,
  type SynthesizedSchedule,
} from "../../agentic/jobSynthesis";
import {
  isLegNotExecutable,
  isSubmittedLeg,
} from "../../agentic/chainExecutor";
import { VectorMemory } from "../../memory/vector-memory";
import {
  GOAL_COMPILE_MODE_SWITCH,
  goalConfigErrorEvent,
  levelsForGoalCompileSwitch,
  resolveGoalCompileMode,
  type GoalCompileMode,
} from "../../config/goalChainModes";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "mcps/openaimp/goalChainCommands",
});

function validBudgetCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function asBudgetCap(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!validBudgetCents(value)) {
    throw new Error("budgetCapCents must be a non-negative integer or null.");
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* goal.compile                                                        */
/* ------------------------------------------------------------------ */

export interface GoalCompileResult {
  recognized: boolean;
  chain: CompiledChain | null;
  reuse: PlanReuse | null;
  reuseDescription: string | null;
}

/**
 * Compile a goal for MCP. With a memory instance this is Phase 4's
 * `compileGoalWithMemory` (recall failure falls back to a fresh
 * compile inside that function); without one it is exactly the
 * Phase 2 compiler. Never throws for an unrecognized goal — that
 * is a null chain, not an error, because the compiler never
 * hallucinates a chain for free text it does not recognize.
 *
 * #1729 (G01): `opts.compileMode` selects the compiler entry
 * point — "auto" (default, current behavior: memory when
 * supplied, fresh otherwise) or "fresh" (always compileGoal,
 * reuse always null, even when a memory instance is supplied).
 * Both values call the SAME compilers the planner uses; there
 * is no second compiler and no "reuse" value (reuse-with-
 * fallback is exactly "auto" — see src/config/goalChainModes.ts).
 */
export async function compileGoalForMcp(
  goal: string,
  budgetCents: number,
  budgetCapCents: number | null,
  memory?: VectorMemory | null,
  opts: { compileMode?: GoalCompileMode } = {},
): Promise<GoalCompileResult> {
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new Error("goal.compile: goal is required.");
  }
  if (!validBudgetCents(budgetCents)) {
    throw new Error("goal.compile: budgetCents must be a non-negative integer.");
  }
  const effectiveMemory = opts.compileMode === "fresh" ? null : memory;
  const { chain, reuse } = effectiveMemory
    ? await compileGoalWithMemory(goal, { budgetCents, budgetCapCents, memory: effectiveMemory })
    : {
        chain: compileGoal(goal, { budgetCents, budgetCapCents }),
        reuse: null as PlanReuse | null,
      };
  return {
    recognized: chain !== null,
    chain,
    reuse,
    reuseDescription: reuse ? describeReuse(reuse) : null,
  };
}

export class GoalCompileCommand implements IMcpToolCommand<{
  goal: string;
  budgetCents: number;
  budgetCapCents?: number | null;
  mode?: string;
}> {
  readonly name = "goal.compile";
  readonly description =
    "Compile a plain-text goal into a validated capability chain over the Phase 1 registry (feed → generate → store → serve → deliver, budget-capped), with any prior-plan reuse from composition memory reported with provenance. Compile output is data, not execution: it runs nothing, sends nothing, and creates no schedule. #1729: the optional `mode` input selects GOAL_COMPILE_MODE (auto | fresh, run > session > user > global env > auto); an unrecognized value fails closed to auto with a goal.config_error audit.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goal: {
        type: "string",
        description:
          "Plain-text goal, e.g. 'Create a NASDAQ100 screen and send it to Slack' or \"Send yesterday's report by email\".",
      },
      budgetCents: {
        type: "integer",
        description: "Declared budget in cents; the compiled budget must not exceed its cap.",
      },
      budgetCapCents: {
        type: "integer",
        description: "Optional budget cap in cents; null when uncapped.",
      },
      mode: {
        type: "string",
        description: "#1729 run-level GOAL_COMPILE_MODE override (auto | fresh)",
      },
    },
    required: ["goal", "budgetCents"],
  };
  readonly zodSchema = z.object({
    goal: z.string().min(1).describe("Plain-text goal to compile"),
    budgetCents: z.number().int().nonnegative().describe("Declared budget in cents"),
    budgetCapCents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Optional budget cap in cents"),
    // Plain optional string (not a zod enum) so an invalid value
    // reaches execute and fails closed instead of dying in schema
    // validation — the #1726/#1727 idiom.
    mode: z.string().optional().describe("#1729 run-level GOAL_COMPILE_MODE override"),
  });

  async execute(
    input: { goal: string; budgetCents: number; budgetCapCents?: number | null; mode?: string },
    context: McpToolContext,
  ): Promise<GoalCompileResult> {
    const cap = asBudgetCap(input.budgetCapCents);
    // #1729 (G01): resolve GOAL_COMPILE_MODE in order run
    // (per-call `mode`) > session > user (context.
    // scopedGoalChainModes) > global env > built-in ("auto").
    // An unrecognized winning value fails closed to "auto",
    // console-logged by the resolver + audited here as
    // goal.config_error, with no fall-through.
    const envForModes = (context.env ?? {}) as unknown as Record<string, unknown>;
    const resolved = resolveGoalCompileMode(
      levelsForGoalCompileSwitch(
        context.scopedGoalChainModes,
        input.mode,
        envForModes[GOAL_COMPILE_MODE_SWITCH],
      ),
      "auto",
    );
    if (resolved.invalid) {
      context.audit(goalConfigErrorEvent(), "mcp", {
        switch: GOAL_COMPILE_MODE_SWITCH,
        raw: resolved.raw,
        level: resolved.level,
        failedClosedTo: resolved.mode,
      });
    }
    // Phase 4 reuse only when the MCP context actually carries the
    // bindings VectorMemory needs; otherwise this is exactly the
    // Phase 2 compiler. A missing binding is not an error.
    // In "fresh" mode the bindings are ignored entirely (see
    // compileGoalForMcp) — deterministic fresh compile.
    const env = (context.env ?? {}) as unknown as Record<string, unknown>;
    const memory =
      env.AI !== undefined &&
      env.AI !== null &&
      env.VECTOR_MEMORY !== undefined &&
      env.VECTOR_MEMORY !== null
        ? new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined)
        : null;
    const result = await compileGoalForMcp(
      input.goal,
      input.budgetCents,
      cap,
      memory,
      { compileMode: resolved.mode },
    );
    context.audit("goal.compile", "mcp", {
      goal: input.goal,
      recognized: result.recognized,
      steps: result.chain?.steps.length ?? 0,
      reused: result.reuse !== null,
      mode: resolved.mode,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* goal.schedule                                                       */
/* ------------------------------------------------------------------ */

export interface GoalScheduleResult {
  record: SynthesizedSchedule;
  /** Always "pending" — synthesis has no path to any other status. */
  status: "pending";
  /** Always false for a pending record, even when its cron is due. */
  fires: false;
}

/**
 * Synthesize a PENDING record from a compiled chain. Defense in
 * depth: if synthesis ever returned anything but pending, this
 * throws rather than handing a live record to an MCP caller.
 */
export function synthesizePendingForMcp(
  chain: CompiledChain,
  opts: { cron?: string | null; id?: string; timeZone?: string } = {},
): GoalScheduleResult {
  const record = synthesizeSchedule(chain, opts);
  if (record.status !== "pending") {
    throw new Error("goal.schedule refused: synthesis returned a non-pending record.");
  }
  return {
    record,
    status: "pending",
    fires: shouldFireSynthesized(record, new Date()) as false,
  };
}

export class GoalScheduleCommand implements IMcpToolCommand<{
  goal?: string;
  chain?: CompiledChain;
  budgetCents?: number;
  budgetCapCents?: number | null;
  cron?: string | null;
}> {
  readonly name = "goal.schedule";
  readonly description =
    "Synthesize a schedule/job record from a compiled chain (or from a goal compiled first). ALWAYS returns a PENDING record only: it never goes live without human confirmation, and the approval step is the only path to live. A pending record never fires, even when its cron is due. This tool creates no scheduled job, no goal-list entry, and no async job.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goal: {
        type: "string",
        description:
          "Plain-text goal to compile first (used when chain is not supplied).",
      },
      chain: {
        type: "object",
        description:
          "A compiled chain (goal.compile output) to synthesize. When supplied, goal/budgetCents are ignored.",
      },
      budgetCents: {
        type: "integer",
        description: "Declared budget in cents, used when compiling from a goal.",
      },
      budgetCapCents: {
        type: "integer",
        description: "Optional budget cap in cents.",
      },
      cron: {
        type: "string",
        description:
          "Cron expression for recurring chains (required); must be absent for one-shot chains.",
      },
    },
  };
  readonly zodSchema = z.object({
    goal: z.string().min(1).optional().describe("Plain-text goal to compile first"),
    chain: z.any().optional().describe("A compiled chain to synthesize"),
    budgetCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Declared budget in cents"),
    budgetCapCents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Optional budget cap in cents"),
    cron: z.string().nullable().optional().describe("Cron for recurring chains"),
  });

  async execute(
    input: {
      goal?: string;
      chain?: CompiledChain;
      budgetCents?: number;
      budgetCapCents?: number | null;
      cron?: string | null;
    },
    context: McpToolContext,
  ): Promise<GoalScheduleResult> {
    let chain = input.chain ?? null;
    if (!chain) {
      if (typeof input.goal !== "string" || input.goal.trim().length === 0) {
        throw new Error("goal.schedule: supply a compiled chain or a goal to compile.");
      }
      if (!validBudgetCents(input.budgetCents)) {
        throw new Error(
          "goal.schedule: budgetCents must be a non-negative integer when compiling from a goal.",
        );
      }
      chain = compileGoal(input.goal, {
        budgetCents: input.budgetCents as number,
        budgetCapCents: asBudgetCap(input.budgetCapCents),
      });
      if (!chain) {
        throw new Error(
          "goal.schedule: goal was not recognized as a compilable chain; nothing was synthesized.",
        );
      }
    }
    const result = synthesizePendingForMcp(chain, {
      ...(input.cron !== undefined ? { cron: input.cron } : {}),
    });
    context.audit("goal.schedule", "mcp", {
      goal: chain.goal,
      kind: result.record.kind,
      status: result.record.status,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* chain.run                                                           */
/* ------------------------------------------------------------------ */

export type ChainLegStatus =
  | "completed"
  | "failed"
  | "blocked"
  | "unimplemented"
  | "submitted"
  | "skipped";

export interface ChainLegResult {
  stepId: string;
  capabilityId: string;
  stage: string;
  status: ChainLegStatus;
  detail: string;
  result?: unknown;
}

export interface ChainRunResult {
  validated: true;
  goal: string;
  budgetCents: number;
  budgetCapCents: number | null;
  legs: ChainLegResult[];
  /** True only when at least one leg actually executed inline. */
  ranAnything: boolean;
  /** True when at least one leg was submitted to the async-job rails for real execution (serve). */
  submittedAnything: boolean;
  /** Always false: chain.run never creates a scheduled job. */
  scheduledJobCreated: false;
  /** Always false from the MCP command (no executor supplied). */
  paidActionPerformed: false;
  ok: boolean;
}

export interface RunChainOptions {
  /**
   * Executor for one validated leg, supplied ONLY by a caller that
   * routes through an existing execution path. The MCP command
   * never supplies one. When absent, every leg reports
   * `unimplemented` — honest, and no execution is invented.
   */
  executeLeg?: (step: CompiledChainStep) => Promise<unknown>;
  /**
   * Existing PaymentsAgent budget-check path: when a leg executor
   * is supplied and the chain carries a positive budget, a false
   * verdict blocks the leg (and skips later legs) instead of
   * performing a paid action. With no executor this gate is moot
   * — no paid action can occur — but the parameter documents the
   * contract any future wiring must satisfy.
   */
  budgetCheck?: (budgetCents: number) => Promise<boolean> | boolean;
  /**
   * Issue #1676: optional completion callback, invoked once
   * per leg that actually ran (completed, submitted, failed).
   * Skipped, blocked, and unimplemented legs are never
   * reported: nothing ran, so there is no job to project.
   * The callback is awaited inside a try/catch — a callback
   * failure never fails the run; the projector reports it
   * and reconciliation converges later. The ScheduledAgent
   * firing path supplies a projector bound to env/tenant;
   * the MCP command never does.
   */
  onLegOutcome?: (leg: ChainLegResult) => Promise<unknown> | unknown;
}

/**
 * Run a compiled chain: re-validate FIRST through the Phase 2
 * `compileChain` (registry ids, registry-derived stages, stage
 * order, budget vs cap), then report one result per leg in chain
 * order. A failed or budget-blocked leg skips every later leg —
 * later legs are never reported as run after an earlier leg did
 * not complete. This function never synthesizes, schedules, or
 * submits anything: no `synthesizeSchedule`, no goal-list write,
 * no async-job submission anywhere in this module.
 *
 * Throws (running nothing) when the chain fails re-validation.
 */
export async function runChain(
  chain: CompiledChain,
  opts: RunChainOptions = {},
): Promise<ChainRunResult> {
  const validated = compileChain({
    goal: chain?.goal,
    steps: Array.isArray(chain?.steps)
      ? chain.steps.map((s) => ({ capabilityId: s.capabilityId, args: s.args }))
      : [],
    budgetCents: chain?.budgetCents,
    budgetCapCents: chain?.budgetCapCents ?? null,
    recurrence: chain?.recurrence ?? "one-shot",
    reusesStoredReport: chain?.reusesStoredReport ?? false,
  });
  if (!validated) {
    throw new Error(
      "chain.run refused: chain failed re-validation (unknown or planned capability, out-of-order stage, duplicate step, or budget over cap); nothing was run.",
    );
  }
  const legs: ChainLegResult[] = [];
  let stopped = false;
  let ranAnything = false;
  let submittedAnything = false;
  let ok = true;
  // Issue #1676: report each ran leg to the optional
  // projector. A callback failure is logged, never thrown:
  // projection is best-effort and must never fail the run.
  const emitOutcome = async (leg: ChainLegResult): Promise<void> => {
    if (!opts.onLegOutcome) return;
    try {
      await opts.onLegOutcome(leg);
    } catch (err) {
      structuredLog.error("chain.leg_outcome_callback_failed", {
        message: "[chain.run] Leg outcome callback failed (run unaffected)",
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
      });
    }
  };
  for (const step of validated.steps) {
    if (stopped) {
      legs.push({
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "skipped",
        detail: "Skipped: an earlier leg did not complete.",
      });
      continue;
    }
    if (!opts.executeLeg) {
      legs.push({
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "unimplemented",
        detail:
          `No executor callable from the MCP command context for ${step.capabilityId}; ` +
          "the real executor is src/agentic/chainExecutor.ts (createChainLegExecutor over a DO/SQL runtime, " +
          "wired through the governed firing path), which the MCP context cannot supply — it carries no DO/SQL runtime.",
      });
      continue;
    }
    // #2840 budget pin: budgetCents is enforced at every
    // user-facing declaration point — compile vs cap (above),
    // and the governed firing paths (ScheduledAgent's
    // PaymentsAgent check before any firing). This per-leg
    // callback is an OPTIONAL caller-supplied gate, not a user
    // declaration: a caller that supplies an executor without
    // a budgetCheck owns the spend decision (pinned by
    // tests/mcp_goal_chain.test.ts), and the MCP tool path
    // supplies no executor at all, so no paid action runs
    // there regardless. Do NOT "fix" this into a required
    // gate without renegotiating those pins.
    if (validated.budgetCents > 0 && opts.budgetCheck) {
      const allowed = await opts.budgetCheck(validated.budgetCents);
      if (!allowed) {
        ok = false;
        stopped = true;
        legs.push({
          stepId: step.id,
          capabilityId: step.capabilityId,
          stage: step.stage,
          status: "blocked",
          detail:
            "Blocked: the existing PaymentsAgent budget check did not allow this chain's budget; no paid action was performed.",
        });
        continue;
      }
    }
    try {
      const result = await opts.executeLeg(step);
      // #1523: a leg the rails will execute is `submitted`, not
      // `completed` — submission is real work queued on the existing
      // path, but claiming completion would be invented execution.
      // A submitted leg does not stop later legs: the rails order
      // serve before the deliver jobs its completion hook plans.
      if (isSubmittedLeg(result)) {
        submittedAnything = true;
        const submittedLeg: ChainLegResult = {
          stepId: step.id,
          capabilityId: step.capabilityId,
          stage: step.stage,
          status: "submitted",
          detail: result.detail,
          result,
        };
        legs.push(submittedLeg);
        await emitOutcome(submittedLeg);
        continue;
      }
      ranAnything = true;
      const completedLeg: ChainLegResult = {
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "completed",
        detail: "Completed via the caller-supplied existing execution path.",
        result,
      };
      legs.push(completedLeg);
      await emitOutcome(completedLeg);
    } catch (err) {
      // #1523: a leg the executor cannot run in this context is
      // `unimplemented` with its real reason — not a failure, and
      // it does not stop the run by itself: each later leg reports
      // its own truth (a downstream leg with no inputs fails on
      // its own terms, as the store/assemble gates do).
      if (isLegNotExecutable(err)) {
        legs.push({
          stepId: step.id,
          capabilityId: step.capabilityId,
          stage: step.stage,
          status: "unimplemented",
          detail: err.message,
        });
        continue;
      }
      ok = false;
      stopped = true;
      const failedLeg: ChainLegResult = {
        stepId: step.id,
        capabilityId: step.capabilityId,
        stage: step.stage,
        status: "failed",
        detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      legs.push(failedLeg);
      await emitOutcome(failedLeg);
    }
  }
  // A run whose legs are all unimplemented did not fail — it
  // reported honestly. `ok` is false only on failed/blocked legs.
  return {
    validated: true,
    goal: validated.goal,
    budgetCents: validated.budgetCents,
    budgetCapCents: validated.budgetCapCents,
    legs,
    ranAnything,
    submittedAnything,
    scheduledJobCreated: false,
    paidActionPerformed: false,
    ok,
  };
}

export class ChainRunCommand implements IMcpToolCommand<{ chain: CompiledChain }> {
  readonly name = "chain.run";
  readonly description =
    "Run a compiled chain: re-validates it first (registry, stages, order, budget), then reports one result per leg in order. Creates no scheduled job and performs no paid action; legs with no executor callable from the MCP context are reported as unimplemented rather than invented. A failed leg skips later legs.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      chain: {
        type: "object",
        description:
          "A compiled chain (goal.compile output): goal, validated steps, budgetCents, budgetCapCents, recurrence, reusesStoredReport.",
      },
    },
    required: ["chain"],
  };
  readonly zodSchema = z.object({
    chain: z.any().describe("A compiled chain to run"),
  });

  async execute(
    input: { chain: CompiledChain },
    context: McpToolContext,
  ): Promise<ChainRunResult> {
    if (!input.chain || typeof input.chain !== "object") {
      throw new Error("chain.run: a compiled chain is required.");
    }
    // Deliberately no executor: the MCP command context carries no
    // DO/SQL runtime for the existing stage executors, and invoking
    // them would create jobs. Legs report honestly as unimplemented.
    const result = await runChain(input.chain);
    context.audit("chain.run", "mcp", {
      goal: result.goal,
      legs: result.legs.length,
      ranAnything: result.ranAnything,
      scheduledJobCreated: false,
    });
    return result;
  }
}
