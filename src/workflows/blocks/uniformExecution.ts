/**
 * Issue #2991 (#2770 Phase A) — uniform execution: the SAME
 * capability produces the SAME stages, records, messages, and
 * outcomes across execution modes. A mode changes only
 * timing/transport (wait vs poll, in-process vs queued), never
 * behavior. Sync/async, parallel/sequential, batch/online,
 * monolith/sharded, goal/broker/scheduled/manual/NLQ/mesh entry:
 * the same pipeline, persistence, stage messages, delivery,
 * failure semantics, and surfacing.
 *
 * This module is the contract + checker, not a runtime fixer: it
 * asserts a run trace is well-formed and reports divergences
 * between two traces. Where full unification needs another lane's
 * work, the dependency is NAMED below — not built as a parallel
 * pipeline and not taken from another lane.
 */

export interface UniformRunTrace {
  mode: string;
  stageIds: string[];
  recordKeys: string[];
  messageCodes: string[];
  outcomeCode: string;
  failureCode?: string;
}

/**
 * A uniform trace carries stages, a run identity + outcome among
 * its records, and an outcome code. Anything less is not a
 * comparable run.
 */
export function assertUniformRun(trace: UniformRunTrace): void {
  if (trace.stageIds.length === 0) {
    throw new Error(`Uniform run (${trace.mode}): no stages recorded`);
  }
  if (!trace.recordKeys.includes("runId")) {
    throw new Error(`Uniform run (${trace.mode}): records carry no runId`);
  }
  if (!trace.recordKeys.includes("outcome")) {
    throw new Error(`Uniform run (${trace.mode}): records carry no outcome`);
  }
  if (!trace.outcomeCode) {
    throw new Error(`Uniform run (${trace.mode}): no outcomeCode`);
  }
}

/** List the divergences between two traces; empty means uniform. */
export function modeDifferenceReport(
  a: UniformRunTrace,
  b: UniformRunTrace,
): string[] {
  const diffs: string[] = [];
  const onlyIn = (x: string[], y: string[]) => x.filter((v) => !y.includes(v));
  for (const stage of onlyIn(a.stageIds, b.stageIds)) {
    diffs.push(`stage ${stage} present in ${a.mode} but not ${b.mode}`);
  }
  for (const stage of onlyIn(b.stageIds, a.stageIds)) {
    diffs.push(`stage ${stage} present in ${b.mode} but not ${a.mode}`);
  }
  for (const key of onlyIn(a.recordKeys, b.recordKeys)) {
    diffs.push(`record key ${key} present in ${a.mode} but not ${b.mode}`);
  }
  for (const key of onlyIn(b.recordKeys, a.recordKeys)) {
    diffs.push(`record key ${key} present in ${b.mode} but not ${a.mode}`);
  }
  if (a.outcomeCode !== b.outcomeCode) {
    diffs.push(
      `outcome differs: ${a.mode}=${a.outcomeCode} vs ${b.mode}=${b.outcomeCode}`,
    );
  }
  if ((a.failureCode ?? "") !== (b.failureCode ?? "")) {
    diffs.push(
      `failure differs: ${a.mode}=${a.failureCode ?? ""} vs ${b.mode}=${b.failureCode ?? ""}`,
    );
  }
  return diffs;
}

export interface UniformityDependency {
  id: string;
  owner: string;
  blocks: string;
  detail: string;
}

/**
 * Named, not built. Each entry states what it blocks and who owns
 * it; the slice surfaces persisted-today through the #2869
 * contract + canonical store and names the gap.
 */
export const UNIFORMITY_DEPENDENCIES: UniformityDependency[] = [
  {
    id: "2869-runScreenInner-emission",
    owner: "CLO #2869",
    blocks: "per-boundary stage emission inside runScreenInner",
    detail:
      "The monolithic ScreenerAgent.runScreen runs stages in-process and emits no stage messages; the per-boundary emission follow-up inside runScreenInner is CLO-owned work.",
  },
  {
    id: "2869-options-stages",
    owner: "CLO #2869",
    blocks: "options stage ids in the shared stage contract",
    detail:
      "The #2869 stage contract names stock stages only; the options leg's stages are proposed by #2991 and need generalizing into the shared contract.",
  },
  {
    id: "goal-dispatch-migration",
    owner: "follow-up slice (CTO)",
    blocks: "goal dispatch becomes a caller of the one pipeline",
    detail:
      "Guard retirement (#2991) enables it; the migration rewires live goal execution and needs its own slice + battery.",
  },
  {
    id: "goal-work-onto-Q1",
    owner: "Phase 5 Slice 8 follow-up",
    blocks: "goal work on the screener-events queue",
    detail:
      "Putting goal work on Q1 needs new work-item semantics + dispatch + producer + identity rules (code, not a doc change).",
  },
  {
    id: "broker-sync-surfacing",
    owner: "#2786 Part 2 (in flight)",
    blocks: "surfaced record for the sync broker path",
    detail:
      "The broker sync path must write a surfaced record so sync and async runs surface identically.",
  },
];
