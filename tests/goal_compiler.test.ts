/**
 * Issue #1441 ([AGENTIC] Phase 2, sub-issue of #1362) — goal compiler
 * pin test.
 *
 * The compiler EXTENDS src/orchestrate.ts (plannerPrompt / validateSteps /
 * topoWaves); it is not a parallel compiler. The Phase 1 registry
 * (src/agentic/capabilityRegistry.ts) is the source of truth for what a
 * chain step may be: every compiled step resolves to a registry entry,
 * stages follow feed → generate → store → serve → deliver (partial
 * chains allowed), and the compiled chain carries its budget cap.
 *
 * Compile outputs ONLY: compiling must not run a screen, send a
 * message, create a schedule, or touch a job. Execution/scheduling is
 * Phase 3; memory is Phase 4; MCP is Phase 5; governance is Phase 6.
 * No registry shipped/in_flight marking is changed by this phase.
 */
import { describe, it, expect } from "vitest";
import {
  CHAIN_STAGE_ORDER,
  MAX_CHAIN_STEPS,
  OPERATION_CATALOG,
  chainDeliveryChannels,
  chainPlannerPrompt,
  chainStages,
  compileChain,
  compileGoal,
  topoWaves,
  validateChainSteps,
  validateSteps,
} from "../src/orchestrate";
import { WORKED_EXAMPLES } from "../src/agentic/capabilityRegistry";

const FULL_CHAIN_IDS = [
  "feed-dataprovider",
  "feed-screener-pipeline",
  "generate-screener-pdf",
  "generate-screener-xlsx",
  "store-mas-reports",
  "store-r2-binaries",
  "serve-report-pdf",
  "deliver-slack",
];
const SERVE_DELIVER_IDS = [
  "serve-options-latest",
  "serve-report-pdf",
  "deliver-email",
];

function stepsFor(ids: string[]) {
  return ids.map((capabilityId) => ({ capabilityId }));
}

describe("goal compiler (#1441) — worked example 1: NASDAQ100 screen → Slack", () => {
  it("compiles to the FULL chain, Slack only, budget-capped", () => {
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    expect(chain).not.toBeNull();
    expect(chain?.steps.map((s) => s.capabilityId)).toEqual(FULL_CHAIN_IDS);
    expect(chainStages(chain!)).toEqual([
      "feed",
      "generate",
      "store",
      "serve",
      "deliver",
    ]);
    expect(chainDeliveryChannels(chain!)).toEqual(["slack"]);
    expect(chain?.budgetCents).toBe(5000);
    expect(chain?.budgetCapCents).toBe(10000);
    expect(chain?.recurrence).toBe("recurring");
    expect(chain?.reusesStoredReport).toBe(false);
  });

  it("matches the Phase 1 registry worked example, step for step", () => {
    const example = WORKED_EXAMPLES.find(
      (e) => e.id === "example-nasdaq100-slack",
    )!;
    const registryIds = example.steps.flatMap((s) => s.entryIds);
    const chain = compileGoal("NASDAQ100 screen to Slack", {
      budgetCents: 100,
    });
    expect(chain?.steps.map((s) => s.capabilityId)).toEqual(registryIds);
  });

  it("refuses a goal that names both Slack and email (no guessed leg)", () => {
    expect(
      compileGoal("NASDAQ100 screen to Slack and email", {
        budgetCents: 100,
      }),
    ).toBeNull();
  });
});

describe("goal compiler (#1441) — worked example 2: yesterday's report by email", () => {
  it("compiles to serve → deliver ONLY, one-shot, reusing the stored report", () => {
    const chain = compileGoal("Send me yesterday's report by email", {
      budgetCents: 0,
    });
    expect(chain).not.toBeNull();
    expect(chain?.steps.map((s) => s.capabilityId)).toEqual(SERVE_DELIVER_IDS);
    expect(chainStages(chain!)).toEqual(["serve", "deliver"]);
    expect(chainDeliveryChannels(chain!)).toEqual(["email"]);
    expect(chain?.recurrence).toBe("one-shot");
    expect(chain?.reusesStoredReport).toBe(true);
    // No regeneration: no feed, generate, or store leg anywhere.
    for (const s of chain!.steps) {
      expect(["feed", "generate", "store"]).not.toContain(s.stage);
    }
  });

  it("matches the Phase 1 registry worked example, step for step", () => {
    const example = WORKED_EXAMPLES.find(
      (e) => e.id === "example-yesterday-report-email",
    )!;
    const registryIds = example.steps.flatMap((s) => s.entryIds);
    const chain = compileGoal("send yesterday's report by email", {
      budgetCents: 0,
    });
    expect(chain?.steps.map((s) => s.capabilityId)).toEqual(registryIds);
  });
});

describe("goal compiler (#1441) — validation", () => {
  it("rejects unknown capability ids", () => {
    expect(
      validateChainSteps([{ capabilityId: "feed-nope" }]),
    ).toBeNull();
  });

  it("rejects planned-only capability ids (news is contract-only)", () => {
    expect(
      validateChainSteps([{ capabilityId: "feed-dataprovider-news" }]),
    ).toBeNull();
  });

  it("rejects out-of-order stages", () => {
    expect(
      validateChainSteps(
        stepsFor(["deliver-slack", "feed-dataprovider"]),
      ),
    ).toBeNull();
    expect(
      validateChainSteps(
        stepsFor(["serve-report-pdf", "generate-screener-pdf"]),
      ),
    ).toBeNull();
  });

  it("allows partial chains: any stage subsequence in order", () => {
    const partial = validateChainSteps(
      stepsFor(["feed-screener-pipeline", "deliver-slack"]),
    );
    expect(partial).not.toBeNull();
    expect(partial?.map((s) => s.stage)).toEqual(["feed", "deliver"]);
    const single = validateChainSteps(stepsFor(["serve-report-pdf"]));
    expect(single).not.toBeNull();
  });

  it("allows same-stage steps in parallel (stage order is non-decreasing)", () => {
    const steps = validateChainSteps(
      stepsFor(["generate-screener-pdf", "generate-screener-xlsx"]),
    );
    expect(steps).not.toBeNull();
    expect(steps?.map((s) => s.stage)).toEqual(["generate", "generate"]);
  });

  it("rejects duplicate capability ids", () => {
    expect(
      validateChainSteps(
        stepsFor(["serve-report-pdf", "serve-report-pdf"]),
      ),
    ).toBeNull();
  });

  it("rejects empty chains, malformed steps, and chains over the step cap", () => {
    expect(validateChainSteps([])).toBeNull();
    expect(validateChainSteps([{ capabilityId: 42 }])).toBeNull();
    expect(validateChainSteps("feed-dataprovider")).toBeNull();
    const thirteen = stepsFor([
      "feed-dataprovider",
      "feed-screener-pipeline",
      "generate-screener-pdf",
      "generate-screener-xlsx",
      "generate-screener-csv",
      "generate-options-pdf",
      "generate-options-xlsx",
      "generate-research-pdf",
      "store-mas-reports",
      "store-r2-binaries",
      "serve-options-latest",
      "serve-report-pdf",
      "deliver-slack",
    ]);
    expect(thirteen.length).toBe(MAX_CHAIN_STEPS + 1);
    expect(validateChainSteps(thirteen)).toBeNull();
  });

  it("derives each step's stage from the registry, not the caller", () => {
    const steps = validateChainSteps(
      stepsFor(["feed-dataprovider", "deliver-email"]),
    );
    expect(steps?.[0].stage).toBe("feed");
    expect(steps?.[1].stage).toBe("deliver");
  });

  it("rejects caller dependencies that point forward or do not resolve", () => {
    expect(
      validateChainSteps([
        { capabilityId: "feed-dataprovider", dependsOn: ["c2"] },
        { capabilityId: "deliver-slack" },
      ]),
    ).toBeNull();
    expect(
      validateChainSteps([
        { capabilityId: "feed-dataprovider", dependsOn: ["missing"] },
      ]),
    ).toBeNull();
  });

  it("rejects over-cap budgets and accepts a budget exactly at the cap", () => {
    expect(
      compileChain({
        goal: "NASDAQ100 screen to Slack",
        steps: stepsFor(["serve-report-pdf"]),
        budgetCents: 10001,
        budgetCapCents: 10000,
      }),
    ).toBeNull();
    expect(
      compileChain({
        goal: "NASDAQ100 screen to Slack",
        steps: stepsFor(["serve-report-pdf"]),
        budgetCents: 10000,
        budgetCapCents: 10000,
      }),
    ).not.toBeNull();
    expect(
      compileChain({
        goal: "NASDAQ100 screen to Slack",
        steps: stepsFor(["serve-report-pdf"]),
        budgetCents: -1,
      }),
    ).toBeNull();
  });

  it("returns null for unrecognized goals rather than hallucinating a chain", () => {
    expect(
      compileGoal("Book me a flight to Paris", { budgetCents: 100 }),
    ).toBeNull();
    expect(compileGoal("", { budgetCents: 100 })).toBeNull();
  });
});

describe("goal compiler (#1441) — waves and planner prompt on the existing path", () => {
  it("topoWaves on a compiled chain yields one wave per stage, in order", () => {
    const chain = compileGoal("NASDAQ100 screen to Slack", {
      budgetCents: 100,
    })!;
    const waves = topoWaves(chain.steps);
    expect(waves.map((w) => w[0].stage)).toEqual(CHAIN_STAGE_ORDER);
    for (const wave of waves) {
      expect(new Set(wave.map((s) => s.stage)).size).toBe(1);
    }
  });

  it("topoWaves stays backward-compatible for PlanSteps", () => {
    const steps = validateSteps([
      { id: "s1", agent: "search", operation: "search.query" },
      {
        id: "s2",
        agent: "trading",
        operation: "trading.screen_stocks",
        dependsOn: ["s1"],
      },
    ])!;
    expect(topoWaves(steps).map((w) => w.map((s) => s.id))).toEqual([
      ["s1"],
      ["s2"],
    ]);
  });

  it("validateSteps still rejects unknown catalog operations", () => {
    expect(
      validateSteps([
        { id: "s1", agent: "search", operation: "search.nope" },
      ]),
    ).toBeNull();
  });

  it("chain planner prompt lists registry entries and the stage + budget rules", () => {
    const prompt = chainPlannerPrompt("NASDAQ100 screen to Slack");
    expect(prompt).toContain("NASDAQ100 screen to Slack");
    expect(prompt).toContain("feed → generate → store → serve → deliver");
    expect(prompt).toContain("deliver-slack");
    expect(prompt).toContain("budget");
    // Planned-only entries are not offered to the planner.
    expect(prompt).not.toContain("feed-dataprovider-news");
  });

  it("the existing operation catalog is untouched by this phase", () => {
    // #1517 (Lane 1) amends this pin: the catalog gains exactly one
    // entry, the ScheduledAgent-owned `chain.execute` marker for
    // materialized chain goals. No Phase 2 operation is removed or
    // renamed; the marker rides the same precedent as the social
    // entry (a goals-list-valid operation handled by its own agent
    // branch, listed in the planner prompt like social.publish).
    // #1819 rollup slice amends this pin: the catalog gains exactly
    // one entry, the ScheduledAgent-owned `resource` marker for the
    // rollup/alert/comparison goals — same precedent as social and
    // chain (goals-list-valid operations handled by their own agent
    // branch, not orchestrator jobs).
    // #1980 index-list slice amends this pin: the catalog gains
    // exactly one entry, the ScheduledAgent-owned `index` marker
    // for the index-list refresh goals — same precedent.
    // #3787 feed-refresh slice amends this pin: the catalog gains
    // exactly one entry, the ScheduledAgent-owned `feed` marker
    // for the feed-refresh goal (`feed.refresh_all`, dispatched by
    // ScheduledAgent.onCron through the J2 feed jobs) — same
    // precedent.
    // #4306 S2 removes that entry with the goal: feed datasets are
    // produced by the per-job Think scheduled tasks, and the
    // `feed.refresh_all` operation is refused by addGoal.
    expect(OPERATION_CATALOG.map((e) => e.agent)).toEqual([
      "search",
      "payments",
      "tasks",
      "memory",
      "nlq",
      "qa",
      "trading",
      "scheduled",
      "social",
      "resource",
      "index",
    ]);
  });
});
