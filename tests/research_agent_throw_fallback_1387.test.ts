/**
 * Issue #1387 — a THROWN Agent dispatch fails the run with a named
 * error (re-pointed by #6250).
 *
 * `runAgentTool`'s fresh path awaits `subAgent` with no try/catch, and
 * `runResearchAndPublish`'s outer try has only a `finally`. So the SDK
 * bootstrap throw (missing OrchestratorAgent root namespace) skipped
 * the #543 fallback — which triggered only on a returned non-completed
 * status — and failed the whole research run.
 *
 * #543's fix converted a thrown dispatch into an error-status child
 * before the fallback guard, so the fallback branch ran. #6250
 * REMOVED that fallback (one code base, wired only once: OODA runs
 * on j-stack and nowhere else) — so the thrown dispatch now converts
 * to an error-status child before the incomplete guard, which fails
 * the run with the named `research_agent_turn_incomplete` error
 * instead of degrading to a non-engine execution.
 *
 * Issue #5109 Fix 1 narrows (does not remove) the no-direct-call rule:
 * the analyze leg's feed branch executes the pipeline via
 * agent.runResearch on the tenant agent — the leg's PRIMARY execution
 * when the feed stage already ran on J-stack, consuming the engine's
 * persisted stage outputs. It is not a fallback: no turn is dispatched
 * in that branch, so there is no failed turn to degrade from. The
 * no-direct-call rule stands for the dispatch section (from the
 * runAgentTool call to the guard), and the feed branch is pinned
 * positively below. The orchestrator
 * cannot be instantiated under Node, so — following the #543 suite's
 * idiom — the pinned contract is the branch structure itself.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const publish = fs.readFileSync(
  path.resolve(__dirname, "../src/agents/orchestrator/researchPublish.ts"),
  "utf8"
);

function dispatchSection(): string {
  const start = publish.indexOf(
    'executionPath: ResearchExecutionPath = "agent"'
  );
  expect(start).toBeGreaterThan(-1);
  const guard = publish.indexOf('child.status !== "completed"', start);
  expect(guard).toBeGreaterThan(-1);
  return publish.slice(start, guard);
}

describe("Agent dispatch throw fails the run with a named error (#1387, #6250)", () => {
  const section = dispatchSection();

  it("the runAgentTool dispatch is wrapped in try/catch", () => {
    const toolAt = section.indexOf("runAgentTool(ResearchAgent");
    expect(toolAt).toBeGreaterThan(-1);
    expect(section.indexOf("try {")).toBeGreaterThan(-1);
    expect(section.indexOf("try {")).toBeLessThan(toolAt);
    // #5109 Fix 1: the feed branch has its own try/catch before the
    // dispatch, so the catch check is scoped to at/after the tool call.
    expect(section.indexOf("catch", toolAt)).toBeGreaterThan(toolAt);
  });

  it("a thrown dispatch becomes an error-status child carrying the message", () => {
    const toolAt = section.indexOf("runAgentTool(ResearchAgent");
    expect(toolAt).toBeGreaterThan(-1);
    const dispatchSection = section.slice(toolAt);
    expect(dispatchSection).toMatch(/status:\s*"error"/);
    expect(dispatchSection).toMatch(/err(?:or)?\s*instanceof\s*Error\s*\?\s*err\.message/);
  });

  it("no direct-pipeline fallback follows the dispatch — the incomplete guard fails the run", () => {
    // #5109 Fix 1: the feed branch (analyze leg, feed already ran on the
    // engine) executes the pipeline via agent.runResearch — that is the
    // leg's primary execution, not a fallback, and it lives BEFORE the
    // dispatch. The fallback rule stands: the dispatch section itself
    // (from the runAgentTool call to the guard) contains no direct call.
    const dispatchStart = publish.indexOf("runAgentTool(ResearchAgent");
    expect(dispatchStart).toBeGreaterThan(-1);
    const guard = publish.indexOf('child.status !== "completed"', dispatchStart);
    expect(guard).toBeGreaterThan(-1);
    expect(publish.slice(dispatchStart, guard)).not.toContain("agent.runResearch(");
    const failAt = publish.indexOf("failResearchTask", guard);
    expect(failAt).toBeGreaterThan(guard);
    const named = publish.indexOf("research_agent_turn_incomplete", guard);
    expect(named).toBeGreaterThan(guard);
    expect(named).toBeLessThan(publish.indexOf("return { success: false, error: failure", guard));
  });

  it("the feed branch executes the analyze leg on the tenant agent (Fix 1, not a fallback)", () => {
    const feedStart = publish.indexOf("if (effectiveSelection?.feed)");
    expect(feedStart).toBeGreaterThan(-1);
    const dispatchStart = publish.indexOf("runAgentTool(ResearchAgent", feedStart);
    expect(dispatchStart).toBeGreaterThan(feedStart);
    const feedSection = publish.slice(feedStart, dispatchStart);
    expect(feedSection).toContain("agent.runResearch(");
    expect(feedSection).toContain("feed: effectiveSelection.feed");
    // The leg's report is read directly, never re-read from getLatest().
    expect(feedSection).toContain("legReport");
    expect(publish.indexOf("legReport ?? (await agent.getLatest())")).toBeGreaterThan(-1);
  });
});
