// @vitest-environment node
/**
 * Issue #4426 ([Stage visibility] per-stage scheduling for the legacy shard
 * chain) — the recorded decision.
 *
 * The issue allows two outcomes: build chain-stage scheduling, or record that
 * it is mooted by moving the chain onto the engine and route the migration
 * question to the chain's programme. This pin holds the decision that was
 * taken (ADR 0031), the routing, and the honesty of the surfaces:
 *
 *  - 4426-P01 the decision is recorded as an ADR, accepted, and indexed.
 *  - 4426-P02 the ADR names the issue, its parent, and the cutover that
 *    supersedes the gap — so the routing is not a bare "future work" note.
 *  - 4426-P03 the stage-schedule surfaces state their scope (engine job
 *    stages only) and point at the ADR, so a chain stage is never implied to
 *    be schedulable.
 *  - 4426-P04 no chain-stage scheduling model was built: the chain planner
 *    carries no schedule identity, so the decision did not quietly grow a
 *    parallel scheduler.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ADR_PATH = "docs/architecture/adr/0031-legacy-chain-per-stage-scheduling.md";
const adr = readFileSync(ADR_PATH, "utf8");
const index = readFileSync("docs/architecture/adr/README.md", "utf8");
const schedulesRoute = readFileSync("src/agents/routes/schedules.ts", "utf8");
const jobsApi = readFileSync("src/client/jobsApi.ts", "utf8");
const shardJobs = readFileSync("src/services/shardJobs.ts", "utf8");

describe("4426-P01 the decision is recorded and indexed", () => {
  it("is an accepted ADR", () => {
    expect(adr).toContain("# 0031. Legacy shard chain per-stage scheduling");
    expect(adr).toContain("- Status: Accepted");
  });

  it("is listed in the ADR index", () => {
    expect(index).toContain("| [0031](0031-legacy-chain-per-stage-scheduling.md) |");
  });
});

describe("4426-P02 the routing is explicit, not deferred prose", () => {
  it("names the issue, its parent, and the cutover that supersedes it", () => {
    expect(adr).toContain("Qunsultant/cfagent#4426");
    expect(adr).toContain("Qunsultant/cfagent#4366");
    expect(adr).toContain("#4471");
  });

  it("records why building it now would be a second scheduler", () => {
    expect(adr).toContain("second scheduler");
    expect(adr).toContain("## Alternatives considered");
  });
});

describe("4426-P03 the surfaces state their scope", () => {
  it("the stage-schedule route names engine job stages and the ADR", () => {
    expect(schedulesRoute).toContain("Scope is ENGINE job stages");
    expect(schedulesRoute).toContain("ADR 0031");
  });

  it("the client stage-schedule API names engine job stages and the ADR", () => {
    expect(jobsApi).toContain("Scope is ENGINE job stages");
    expect(jobsApi).toContain("ADR 0031");
  });
});

describe("4426-P04 no parallel chain-stage scheduler was built", () => {
  it("the chain planner carries no schedule identity", () => {
    // The decision's whole point: the chain's stages are NOT given a schedule
    // model of their own. A future change that adds one must supersede ADR
    // 0031 — this pin is what makes that deliberate.
    expect(shardJobs).not.toContain("scheduleStage");
    expect(shardJobs).not.toContain("runScheduleId");
    expect(shardJobs).not.toContain("JobScheduleConfig");
  });
});
