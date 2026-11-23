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
 * instead of degrading to a non-engine execution. The orchestrator
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
    expect(section).toContain("runAgentTool(ResearchAgent");
    expect(section.indexOf("try {")).toBeGreaterThan(-1);
    expect(section.indexOf("try {")).toBeLessThan(
      section.indexOf("runAgentTool(ResearchAgent")
    );
    expect(section.indexOf("catch")).toBeGreaterThan(
      section.indexOf("runAgentTool(ResearchAgent")
    );
  });

  it("a thrown dispatch becomes an error-status child carrying the message", () => {
    expect(section).toMatch(/status:\s*"error"/);
    expect(section).toMatch(/err(?:or)?\s*instanceof\s*Error\s*\?\s*err\.message/);
  });

  it("no direct-pipeline fallback follows the dispatch — the incomplete guard fails the run", () => {
    expect(publish).not.toContain("agent.runResearch(");
    const guard = publish.indexOf('child.status !== "completed"');
    expect(guard).toBeGreaterThan(-1);
    const failAt = publish.indexOf("failResearchTask", guard);
    expect(failAt).toBeGreaterThan(guard);
    const named = publish.indexOf("research_agent_turn_incomplete", guard);
    expect(named).toBeGreaterThan(guard);
    expect(named).toBeLessThan(publish.indexOf("return { success: false, error: failure", guard));
  });
});
