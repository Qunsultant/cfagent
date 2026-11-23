/**
 * Issue #543 — ResearchAgent agent-run fallback observability
 * (cloudflare.md §8C/F, §9E), re-pointed by #1738 at the SDK actor
 * and by #6250 at the fallback's removal.
 *
 * `OrchestratorAgent.runResearchAndPublish` dispatches options research
 * through the Agent actor (`runAgentTool(ResearchAgent, …)`). When that
 * run did not produce a fresh report, it deliberately fell back to
 * the deterministic pipeline (`agent.runResearch(...)`) so scheduled
 * discovery stayed dependable. Before #543 the fallback was silent: a
 * permanently broken agent path would have been masked by successful
 * research output, and logs could not distinguish the two paths.
 *
 * #6250 REMOVED the fallback (owner directive 2026-11-23: one code
 * base, wired only once — OODA runs on j-stack and nowhere else).
 * An incomplete agent turn is now a NAMED failure
 * (`research_agent_turn_incomplete`), escalated to a human through
 * the task ledger instead of degrading to a non-engine execution.
 * The observability intent survives the removal: the failure is
 * still marked by a structured warning carrying the correlation
 * identifiers, so a permanently broken agent path is visible in
 * Workers Logs instead of masked by research output.
 *
 * Issue #5109 Fix 1 narrows (does not remove) the no-direct-call rule:
 * the analyze leg's feed branch executes the pipeline via
 * agent.runResearch on the tenant agent — the leg's PRIMARY execution
 * when the feed stage already ran on J-stack, consuming the engine's
 * persisted stage outputs. It is not a fallback: no turn is dispatched
 * in that branch, so there is no failed turn to degrade from. The
 * no-direct-call assertions below are therefore scoped to the dispatch
 * section (from the runAgentTool call to the guard), where the
 * fallback rule stands.
 *
 * This suite pins the structured warning on the incomplete-turn
 * branch: it must exist, it must sit *inside* the branch before the
 * failure return, and it must carry the correlation identifiers
 * (trigger, userLogin, child status/error, previous/latest run ids).
 * Removing or gutting the signal fails the suite. Style follows the
 * repo's source-evidence tests (e.g. tests/agent-conformance.test.ts):
 * the orchestrator cannot be instantiated under Node, so the pinned
 * contract is the branch structure itself.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const orchestrator = fs.readFileSync(
  path.resolve(__dirname, "../src/agents/orchestrator/researchPublish.ts"),
  "utf8"
);

/** The runResearchAndPublish method body, bounded by the next method. */
function methodSection(): string {
  const start = orchestrator.indexOf("function runResearchAndPublish(");
  expect(start).toBeGreaterThan(-1);
  const rest = orchestrator.slice(start);
  const nextMethod = rest.indexOf("\n  async ", 10);
  return nextMethod === -1 ? rest : rest.slice(0, nextMethod);
}

describe("Agent research incomplete-turn observability (issue #543, #6250)", () => {
  const section = methodSection();

  it("no direct-pipeline fallback remains in the publish entry", () => {
    // #5109 Fix 1: the feed branch (analyze leg) executes the pipeline via
    // agent.runResearch as its primary execution — not a fallback. The
    // fallback rule stands: the dispatch section (runAgentTool call to the
    // guard) contains no direct call.
    const dispatchStart = section.indexOf("runAgentTool(ResearchAgent");
    expect(dispatchStart).toBeGreaterThan(-1);
    const guard = section.indexOf('child.status !== "completed"', dispatchStart);
    expect(guard).toBeGreaterThan(-1);
    expect(section.slice(dispatchStart, guard)).not.toContain("agent.runResearch(");
    expect(section).not.toContain('executionPath = "fallback"');
  });

  it("a structured warning marks the incomplete Agent turn", () => {
    expect(section).toContain("Agent research turn incomplete");
    // #3515 S3: the warning travels as a structuredLog.warn event
    // (operation researchPublish.research_agent_turn_incomplete), not a
    // console.warn line — the pin keeps the same strength.
    expect(section).toContain(
      'structuredLog.warn("researchPublish.research_agent_turn_incomplete"'
    );
  });

  it("the warning is emitted before the failure return, inside the incomplete branch", () => {
    const guard = section.indexOf('child.status !== "completed"');
    const warnAt = section.indexOf("Agent research turn incomplete");
    const failAt = section.indexOf("failResearchTask", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(warnAt).toBeGreaterThan(guard);
    expect(failAt).toBeGreaterThan(warnAt);
  });

  it("the warning carries the correlation identifiers", () => {
    const warnAt = section.indexOf("Agent research turn incomplete");
    const statement = section.slice(warnAt, warnAt + 500);
    for (const token of [
      "trigger=${trigger}",
      "userLogin=${login}",
      "childStatus=${child.status}",
      "childError=${child.error",
      "previousRunId=${previousRunId",
      "latestRunId=${report?.runId",
    ]) {
      expect(statement, `warning carries ${token}`).toContain(token);
    }
  });

  it("the Agent dispatch is the only path (no fallback replaced it)", () => {
    expect(section).toContain("runAgentTool(ResearchAgent");
    // #5109 Fix 1: scoped to the dispatch section — the feed branch's
    // primary leg execution lives before the dispatch, not after it.
    const dispatchStart = section.indexOf("runAgentTool(ResearchAgent");
    const guard = section.indexOf('child.status !== "completed"', dispatchStart);
    expect(guard).toBeGreaterThan(-1);
    expect(section.slice(dispatchStart, guard)).not.toContain("agent.runResearch(");
  });
});
