/**
 * Issue #3214 — Agentic stage control via chat: parse conversational requests
 * ("re-run the deliver stage of run X", "pause feed and enrich", "retire
 * evaluate for run Y", "cancel all stages") and dispatch uniformly across one,
 * some, or all stages through the J-stack control plane.
 */
import { RESEARCH_PIPELINE_STAGES } from "../workflows/stageRuntimeIds";

export type AgenticStageOp =
  | "run"
  | "rerun"
  | "pause"
  | "cancel"
  | "resume"
  | "stop"
  | "schedule"
  | "retire"
  | "status";

export interface ParsedStageControlIntent {
  op: AgenticStageOp;
  stageIds: string[];
  allStages: boolean;
  runId: string | null;
}

const KNOWN_STAGES = [
  "feed",
  "enrich",
  "gather",
  "analyze",
  "analysis",
  "generate",
  "generation",
  "store",
  "serve",
  "deliver",
  "delivery",
  "evaluate",
] as const;

export function parseStageControlIntent(text: string): ParsedStageControlIntent | null {
  const lower = text.toLowerCase();
  let op: AgenticStageOp | null = null;
  if (/\bre-?run\b/.test(lower)) op = "rerun";
  else if (/\bpause\b/.test(lower)) op = "pause";
  else if (/\bcancel\b/.test(lower)) op = "cancel";
  else if (/\bresume\b/.test(lower)) op = "resume";
  else if (/\bstop\b/.test(lower)) op = "stop";
  else if (/\bschedule\b/.test(lower)) op = "schedule";
  else if (/\bretire\b/.test(lower)) op = "retire";
  else if (/\bstatus\b/.test(lower)) op = "status";
  else if (/\brun\b/.test(lower)) op = "run";
  if (!op) return null;

  const allStages = /\ball\s+stages?\b/.test(lower);
  const stageIds = allStages
    ? [...RESEARCH_PIPELINE_STAGES]
    : KNOWN_STAGES.filter((s) => new RegExp(`\\b${s}\\b`, "i").test(lower));

  if (stageIds.length === 0) return null;

  const runMatch = text.match(/(?<!re-)\b(?:run|job)\s+(?:id\s+)?([a-zA-Z0-9:_-]{3,})\b/i);
  const runId = runMatch?.[1] ?? null;

  return { op, stageIds, allStages, runId };
}

export interface AgenticStageControlTarget {
  runId: string;
  stageIds: string[];
  op: AgenticStageOp;
  executeOne: (runId: string, stageId: string, op: AgenticStageOp) => Promise<Record<string, unknown>>;
}

export async function executeAgenticStageControl(
  target: AgenticStageControlTarget,
): Promise<{
  runId: string;
  op: AgenticStageOp;
  results: Array<{ stageId: string; outcome: Record<string, unknown> }>;
}> {
  if (target.stageIds.length === 0) {
    throw new Error("Agentic stage control requires at least one stageId.");
  }
  const results: Array<{ stageId: string; outcome: Record<string, unknown> }> = [];
  for (const stageId of target.stageIds) {
    const outcome = await target.executeOne(target.runId, stageId, target.op);
    results.push({ stageId, outcome });
  }
  return { runId: target.runId, op: target.op, results };
}
