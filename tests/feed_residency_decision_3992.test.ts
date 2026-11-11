// @vitest-environment node
/**
 * Issue #3992 PR-5 — the feed-run residency decision is pinned, not
 * just written down.
 *
 * The decision doc (docs/architecture/feed-run-residency-and-scheduled-
 * silence-3992.md) records: production pipeline/feed runs STAY resident
 * in the ScheduledAgent host; the JobPipelineWorkflow residency stays
 * provisioned and uncalled; activation happens only under the
 * follow-up issue "Workflow-residency activation for pipeline runs".
 *
 * Pins, in the fleet's doc-pin idiom (cf. platform_decoupling_doc,
 * neutrality_live_docs_3525, alarm_inventory_3026's src walk):
 *  (a) the doc exists with its five section headings;
 *  (b) the doc names the decision, the FEED_DEADLINE_EXCEEDED code,
 *      and #4002's orphan settlement;
 *  (c) CODE INVARIANT: no production caller of startPipelineJobWorkflow
 *      exists in src/ outside its definition file
 *      (src/agents/scheduledTasksPipeline.ts) and the Durable Object
 *      door that wraps it (src/agents/scheduled-agent.ts) — the scan
 *      counts the door file as an allowed holder, so the assertion is
 *      exactly "no caller outside those two files";
 *  (d) CODE INVARIANT: settleOrphanedPipelineRuns remains wired from
 *      ScheduledAgent.onStart.
 *
 * (c)/(d) are invariants, green on the base by design; (a)/(b) are the
 * change pins, red until the doc lands. If a future change activates
 * the workflow residency, (c) goes red first — amend the doc in the
 * same PR, per the doc's own rule.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DOC = join(
  process.cwd(),
  "docs/architecture/feed-run-residency-and-scheduled-silence-3992.md",
);

const read = (p: string) => readFileSync(p, "utf8");

/** Every .ts file under src/, repo-relative with forward slashes. */
function srcFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts")) found.push(path.replace(/\\/g, "/"));
    }
  };
  walk("src");
  return found.sort();
}

describe("#3992 PR-5 — residency decision doc", () => {
  it("(a) exists with the five decision sections", () => {
    expect(existsSync(DOC)).toBe(true);
    const doc = read(DOC);
    expect(doc).toContain(
      "# Feed-run residency and scheduled-silence decision (#3992 PR-5)",
    );
    expect(doc).toContain("## Decision");
    expect(doc).toContain("## Evidence");
    expect(doc).toContain("## Why not move");
    expect(doc).toContain("## Scheduled silence — mechanism");
    expect(doc).toContain("## Consequences");
  });

  it("(b) names the stay decision, the deadline code, and the #4002 orphan settlement", () => {
    const doc = read(DOC);
    expect(doc).toContain("remain resident in the ScheduledAgent host");
    expect(doc).toContain("FEED_DEADLINE_EXCEEDED");
    expect(doc).toContain("settleOrphanedPipelineRuns");
    expect(doc).toContain("#4002");
    expect(doc).toContain("Workflow-residency activation for pipeline runs");
  });
});

describe("#3992 PR-5 — residency code invariants", () => {
  it("(c) no production caller of the workflow start path outside its definition and its DO door", () => {
    const ALLOWED = new Set([
      "src/agents/scheduledTasksPipeline.ts",
      "src/agents/scheduled-agent.ts",
    ]);
    const holders = srcFiles().filter((file) =>
      read(file).includes("startPipelineJobWorkflow"),
    );
    // The scan must actually see the known holders — a scan that
    // finds nothing proves nothing.
    expect(holders).toContain("src/agents/scheduledTasksPipeline.ts");
    expect(holders).toContain("src/agents/scheduled-agent.ts");
    expect(holders.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  it("(d) orphan settlement stays wired from ScheduledAgent.onStart", () => {
    const agent = read("src/agents/scheduled-agent.ts");
    expect(agent).toContain("settleOrphanedPipelineRuns");
    const onStartAt = agent.indexOf("override async onStart");
    expect(onStartAt).toBeGreaterThanOrEqual(0);
    // The settle call must live inside onStart's body — the next
    // door method (runPipelineJob) is the boundary marker.
    const doorAt = agent.indexOf("async runPipelineJob", onStartAt);
    expect(doorAt).toBeGreaterThan(onStartAt);
    expect(
      agent.slice(onStartAt, doorAt),
    ).toContain("settleOrphanedPipelineRuns(this.pipelineContext())");
    // And the helper still delegates to the engine's settle.
    const host = read("src/agents/scheduledTasksPipeline.ts");
    expect(host).toContain("control.settleOrphanedRuns()");
  });
});
