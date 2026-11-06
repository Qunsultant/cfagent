/**
 * #1729 (parent #1717, slice (i)): goal chain + AgentDB
 * jobs/audit/reports vs live routes unification (scan
 * appendix (i) findings G01–G04) — the PAYMENTS_FLOW_MODE
 * (#1711) / MARKET_DATA_* (#1727) pattern applied to this domain.
 * Pure module: no Cloudflare imports, no I/O, no network —
 * the port is the resolver, and the MCP surface consumes it
 * (port-first, cfagent blueprint #1795/#1798 restated
 * wording: cloud-native but cloud-agnostic).
 *
 * ONE runtime config switch in this slice (Worker env var,
 * non-secret, owner-set; this slice sets NO production value
 * — production values are an owner action):
 *   GOAL_COMPILE_MODE  "auto" | "fresh"  (G01 goal.compile)
 * Values are case-insensitive, surrounding whitespace ignored.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (the MCP
 *   surface's current behavior, "auto").
 * Carriers: run = the per-call `mode` input on goal.compile;
 * session / user = the optional `scopedGoalChainModes`
 * carrier on the execution context (McpToolContext.
 * scopedGoalChainModes, populated by the execution-context
 * owner); global env = the Worker env var. A blank/unset
 * level falls through to the next level. The FIRST non-blank
 * level wins; if that value is unrecognized, the resolution
 * FAILS CLOSED to "auto" (invalid=true, level = the winning
 * level) and does NOT fall through to a lower level. Callers
 * must log + audit `goal.config_error` on invalid.
 *
 * Built-in default = "auto" (recorded explicitly so the
 * owner can overturn it later): bindings present → prior-plan
 * reuse with provenance via compileGoalWithMemory, else a
 * fresh compileGoal — exactly today's goal.compile behavior,
 * so unset switches change nothing.
 *
 * Per-mode behavior (both paths preserved as branches, never
 * deleted; no endpoint removed; no second compiler — both
 * values call the SAME compileGoal / compileGoalWithMemory
 * the planner uses):
 * | mode  | behavior                                              |
 * | auto  | bindings present → compileGoalWithMemory (reuse +    |
 * |       | provenance); bindings absent → compileGoal (fresh).  |
 * | fresh | always compileGoal; reuse is always null, even when   |
 * |       | bindings are present (deterministic fresh compile).  |
 *
 * There is deliberately NO third "reuse" value: reuse-with-
 * fallback is exactly "auto" given the standing fallback rule
 * (a missing binding or a recall failure is never an error),
 * so a separate "reuse" value would be indistinguishable from
 * "auto" — a phantom switch. There is deliberately NO
 * schedule switch and NO execution switch in this module
 * (see the NOT-switched section): exporting one would imply
 * a flippable posture that must not exist.
 *
 * What the switch does NOT govern (ENFORCEMENT / SAFETY,
 * never opt-out, pinned by tests/goal_chain_agentdb_modes_
 * 1729.test.ts):
 * - G02 PENDING-vs-LIVE: goal.schedule ALWAYS returns a
 *   PENDING record only (no `enabled` field, fires:false);
 *   approveSynthesizedRecord is the only path to live, and
 *   it is not an MCP tool. No switch value can flip a
 *   PENDING record live from MCP — that would be the safety
 *   regression the issue forbids, not a unification. The
 *   REST POST /schedules/create ALWAYS creates a LIVE SDK
 *   schedule behind its callback allow-list (400 naming the
 *   list). goal.schedule carries NO `mode` input.
 * - G03 inline-vs-durable: chain.run ALWAYS executes inline
 *   only (scheduledJobCreated:false, no synthesized record,
 *   no async job); a failed or budget-blocked leg always
 *   skips later legs. No switch value can present inline
 *   execution as durable/scheduled execution, or vice versa.
 * - G04 tenant sourcing: there is NO tenant switch. The
 *   tenant comes from IAAA resolution of env
 *   (resolveIaaaTenant) on both surfaces, and no tool schema
 *   carries a tenant field, so a caller can never assert a
 *   tenant the session does not hold. SessionData carries
 *   no tenant field, so a "session tenant" value would
 *   require inventing tenant derivation — out of scope.
 * - G04 source: the four projection pairs (chain.status,
 *   jobs.history, audit.history, reports.list) are already
 *   IDENTICAL on both surfaces (same read port, same tenant
 *   function, same result shape — pinned row-for-row), so
 *   they collapse to a single path with no switch. The
 *   live-vs-projection pairs stay distinct surfaces with
 *   distinct sources and scope keys and are NOT merged:
 *   agentdb.audit.history (AgentDB audit projection,
 *   tenant-scoped) vs GET /api/audit (live mas_events,
 *   session_id-scoped); agentdb.reports.list (AgentDB report
 *   projection, tenant-scoped, bodies never included) vs
 *   GET /api/reports (mas_reports, userLogin-scoped, with
 *   reportUrl). Merging them would serve one store's rows
 *   under another store's scope key.
 * - No REST compile endpoint is added by this slice (G01):
 *   no consumer has proven a need for one, and a new
 *   surface would need the same compiler plus an envelope
 *   for no current caller. If one is ever added, it must
 *   reuse this same compiler (already single) — transport +
 *   envelope only, never a second compiler.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in
 * resolution order and unit-pinned, but in production today
 * only run (per-call `mode`) and global env are settable —
 * the same boundary as #1721/#1722/#1723/#1724/#1725/#1726/
 * #1727/#1728. The route ctx carrier is populated by no
 * production caller yet.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/goalChainModes",
});

export type GoalCompileMode = "auto" | "fresh";

/** One switch's value, as carried at session/user level. */
export interface GoalChainModeValues {
  compile?: unknown;
}

/** Session/user carriers for the goal-chain switches. */
export interface GoalChainScopedModes {
  session?: GoalChainModeValues;
  user?: GoalChainModeValues;
}

/** One level set of the resolution order. Blank/unset falls through. */
export interface GoalChainModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedGoalChainSwitch<T extends string> {
  mode: T;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for logs). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const GOAL_COMPILE_MODE_SWITCH = "GOAL_COMPILE_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function goalConfigErrorEvent(): string {
  return "goal.config_error";
}

function normalizeSwitchValue(raw: unknown, valid: string[]): string | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (valid.includes(normalized)) return normalized;
  return "invalid";
}

function resolveSwitch<T extends string>(
  levels: GoalChainModeScopeLevels,
  legacy: T,
  valid: string[],
  switchName: string,
): ResolvedGoalChainSwitch<T> {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeSwitchValue(value, valid);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      structuredLog.warn(goalConfigErrorEvent(), {
        message: `[${goalConfigErrorEvent()}] ${switchName} unrecognized value at ${level}; failing closed to surface legacy`,
        switch: switchName,
        level,
        raw: typeof value === "string" ? value : undefined,
      });
      return {
        mode: legacy,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized as T, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set for the compile switch from the scoped carrier + run + env. */
export function levelsForGoalCompileSwitch(
  scoped: GoalChainScopedModes | undefined,
  run: unknown,
  envValue: unknown,
): GoalChainModeScopeLevels {
  return { run, session: scoped?.session?.compile, user: scoped?.user?.compile, env: envValue };
}

export function resolveGoalCompileMode(
  levels: GoalChainModeScopeLevels,
  legacy: GoalCompileMode,
): ResolvedGoalChainSwitch<GoalCompileMode> {
  return resolveSwitch(levels, legacy, ["auto", "fresh"], GOAL_COMPILE_MODE_SWITCH);
}
