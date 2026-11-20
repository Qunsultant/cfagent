/**
 * Issue #4775 S1 — the stage deadline budgets, externalized.
 *
 * The stage per-unit deadline (600s) and the feed run deadline
 * (240s) were literals with no decided relationship: a feed job's
 * stage deadline could never fire before the run race, so the
 * 600s bound on a feed job was unreachable dead code. This module
 * is the stage side's home, mirroring the feedJobTimeouts.ts idiom:
 * a defaults table, one env knob, and a fail-closed resolver.
 *
 * - The global default is STAGE_TIMEOUTS.stageMs (600_000, the
 *   recorded DEFAULT_SHARD_TIMEOUT_MS — the single literal home
 *   stays there; this table only references it).
 * - An operator changes the default by setting STAGE_TIMEOUT_MS,
 *   never by editing this file.
 * - Resolution is node → env-resolved default, with the run
 *   deadline clamping the result whenever one applies (Decision 1:
 *   a stage unit can never outlive its run).
 *
 * The settings-map half of pipelinePolicy does NOT resolve here —
 * S3 wires that; this slice's global default is the env knob.
 */
import { DEFAULT_SHARD_TIMEOUT_MS } from "../workflows/workflowPorts";
import type { JobNodeConfig } from "../data/jobPipelinePorts";

/**
 * The DEFAULTS table for the stage per-unit deadline, in
 * milliseconds — the recorded 600s bound, the fallback only:
 * production callers resolve through resolveStageTimeoutMs(env),
 * which reads the knob below and falls back to this table when
 * the knob is absent.
 */
export const STAGE_TIMEOUTS = {
  /** Bound for one stage unit's execution, above a typical screen. */
  stageMs: DEFAULT_SHARD_TIMEOUT_MS,
} as const;

/** The env knob for the global stage default (#4775 S1). Values are milliseconds. */
export const STAGE_TIMEOUT_KNOB = "STAGE_TIMEOUT_MS";

/**
 * Resolve the global stage default from its env knob (#4775 S1),
 * in the feed-knob idiom (an env record passed in, fallback to
 * the recorded default). Absent knob ⇒ the default. A present
 * knob must name a positive finite number of milliseconds;
 * anything else is a configuration error, refused by NAME (naming
 * the knob and the raw value) — never silently treated as the
 * default, another bound, or "no deadline".
 */
export function resolveStageTimeoutMs(env: Record<string, unknown> = {}): number {
  const raw = env[STAGE_TIMEOUT_KNOB];
  if (raw === undefined) return STAGE_TIMEOUTS.stageMs;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const shown = typeof raw === "string" ? `"${raw}"` : String(raw);
    throw new Error(
      `Invalid ${STAGE_TIMEOUT_KNOB} value ${shown}: the bound must be a positive finite number of milliseconds.`,
    );
  }
  return parsed;
}

/**
 * Resolve one node's effective stage deadline (#4775 S1, Decisions
 * 1–2): the node's own timeoutMs wins; absent, the env-resolved
 * global default (`defaultMs` — the caller resolves it through
 * resolveStageTimeoutMs). Whenever a run deadline applies
 * (`runDeadlineMs`, feed jobs), the result is clamped to it: the
 * effective stage deadline is min(node timeout, run deadline),
 * so a hung stage is killed by the decided budget, not by
 * whichever race happens to fire first. Without a run deadline
 * the stage timeout stands alone.
 *
 * An invalid node value is a configuration error, refused by NAME
 * (naming the stage kind and the raw value) — never silently the
 * default. A non-positive or non-finite run bound is treated as
 * "no run deadline" (the run race itself falls back the same way
 * in resolveFeedExecutionDeadlineMs).
 */
export function resolveStageTimeoutMsForNode(
  node: Pick<JobNodeConfig, "kind" | "timeoutMs">,
  defaultMs: number,
  runDeadlineMs?: number,
): number {
  let resolved: number;
  if (node.timeoutMs !== undefined) {
    if (typeof node.timeoutMs !== "number" || !Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0) {
      const shown =
        typeof node.timeoutMs === "string" ? `"${node.timeoutMs}"` : String(node.timeoutMs);
      throw new Error(
        `Stage "${node.kind}" timeoutMs ${shown} must be a positive finite number of milliseconds.`,
      );
    }
    resolved = node.timeoutMs;
  } else {
    resolved = defaultMs;
  }
  if (typeof runDeadlineMs === "number" && Number.isFinite(runDeadlineMs) && runDeadlineMs > 0) {
    resolved = Math.min(resolved, runDeadlineMs);
  }
  return resolved;
}

/**
 * The goal screen's await deadline (#4775 S1, Decision 3): 2x the
 * resolved global stage default — a goal job composes two legs
 * sequentially. No separate knob, no per-job override: this is a
 * screen-flow bound, not a stage bound, so it follows the global
 * default, not any per-job value.
 */
export function resolveGoalScreenAwaitDeadlineMs(env: Record<string, unknown> = {}): number {
  return 2 * resolveStageTimeoutMs(env);
}

/**
 * The stock screen's await deadline (#4775 S1, Decision 3): 1x the
 * resolved global stage default. No separate knob, no per-job
 * override — same reasoning as the goal bound.
 */
export function resolveStockScreenAwaitDeadlineMs(env: Record<string, unknown> = {}): number {
  return resolveStageTimeoutMs(env);
}
