/**
 * Issue #543 — ResearchAgent agent-run fallback observability
 * (cloudflare.md §8C/F, §9E), re-pointed by #1738 at the SDK actor.
 *
 * `OrchestratorAgent.runResearchAndPublish` dispatches options research
 * through the Agent actor (`runAgentTool(ResearchAgent, …)`). When that
 * run does not produce a fresh report, it deliberately falls back to
 * the deterministic pipeline (`agent.runResearch(...)`) so scheduled
 * discovery stays dependable. Before #543 the fallback was silent: a
 * permanently broken agent path would have been masked by successful
 * research output, and logs could not distinguish the two paths.
 *
 * This suite pins the structured warning on the fallback branch: it
 * must exist, it must sit *inside* the fallback branch before the
 * direct pipeline call, and it must carry the correlation identifiers
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

describe("Agent research fallback observability (issue #543)", () => {
  const section = methodSection();

  it("the fallback branch still calls the deterministic pipeline directly", () => {
    expect(section).toContain(
      "const fallback = await agent.runResearch({ trigger, userLogin: login });"
    );
  });

  it("a structured warning marks the Agent bypass on the fallback branch", () => {
    expect(section).toContain(
      "Agent research turn bypassed — falling back to direct pipeline"
    );
    // #3515 S3: the warning travels as a structuredLog.warn event
    // (operation researchPublish.research_agent_turn_bypassed), not a
    // console.warn line — the pin keeps the same strength.
    expect(section).toContain(
      'structuredLog.warn("researchPublish.research_agent_turn_bypassed"'
    );
  });

  it("the warning is emitted before the fallback call, inside the branch", () => {
    const fallbackGuard = section.indexOf('child.status !== "completed"');
    const warnAt = section.indexOf("Agent research turn bypassed");
    const fallbackCall = section.indexOf("const fallback = await agent.runResearch");
    expect(fallbackGuard).toBeGreaterThan(-1);
    expect(warnAt).toBeGreaterThan(fallbackGuard);
    expect(fallbackCall).toBeGreaterThan(warnAt);
  });

  it("the warning carries the correlation identifiers", () => {
    const warnAt = section.indexOf("Agent research turn bypassed");
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

  it("the Agent dispatch remains the primary path (fallback did not replace it)", () => {
    expect(section).toContain("runAgentTool(ResearchAgent");
    expect(section.indexOf("runAgentTool(ResearchAgent")).toBeLessThan(
      section.indexOf("const fallback = await agent.runResearch")
    );
  });
});
