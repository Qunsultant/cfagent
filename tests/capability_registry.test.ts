/**
 * Issue #1395 ([AGENTIC] Phase 1, sub-issue of #1362) — capability
 * registry pin test.
 *
 * The registry is the planner/validator's source of truth, so its
 * honesty rules are pinned here, not in prose:
 *  - every entry carries the full approved shape;
 *  - shipped means a test passes, not that an interface exists
 *    (same rule as the #1070 F1 registry): a shipped entry MUST
 *    name a verification test file that exists in this repo;
 *  - the two worked examples from #1395 resolve against the registry;
 *  - the known honesty cases stay honest: news is contract-only
 *    (never shipped), CSV ships (the #1346 generator landed after
 *    the #1362 inventory was written), channel delivery ships
 *    (its #1279/#1399 tests are on main), plan-level composition
 *    memory stays planned.
 *
 * Phase 1 scope guard: this test pins the registry ONLY. It does not
 * compile goals (Phase 2), synthesize schedules (Phase 3), or expose
 * MCP tools (Phase 5), and it must not duplicate #1355 or rebuild
 * #1224's executor.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPABILITY_REGISTRY,
  COMPOSITION_MEMORY,
  MCP_CHAIN_STATUS,
  SCHEDULING_SUBSTRATES,
  WORKED_EXAMPLES,
  type CapabilityEntry,
  type RegistryStage,
  type RegistryStatus,
} from "../src/agentic/capabilityRegistry";

const STAGES: RegistryStage[] = [
  "feed",
  "enrich",
  "analyze",
  "generate",
  "store",
  "serve",
  "deliver",
];
const STATUSES: RegistryStatus[] = ["shipped", "in_flight", "planned"];

function assertEntryShape(entry: CapabilityEntry) {
  expect(typeof entry.id, `${entry.id}: id`).toBe("string");
  expect(entry.id.length, `${entry.id}: id non-empty`).toBeGreaterThan(0);
  expect(STAGES, `${entry.id}: stage`).toContain(entry.stage);
  expect(typeof entry.capability, `${entry.id}: capability`).toBe("string");
  expect(typeof entry.source, `${entry.id}: source`).toBe("string");
  expect(Array.isArray(entry.inputs), `${entry.id}: inputs`).toBe(true);
  expect(Array.isArray(entry.outputs), `${entry.id}: outputs`).toBe(true);
  expect(typeof entry.provenance, `${entry.id}: provenance`).toBe("string");
  expect(typeof entry.owner, `${entry.id}: owner`).toBe("string");
  expect(STATUSES, `${entry.id}: status`).toContain(entry.status);
  if (entry.status === "shipped") {
    expect(
      entry.verification,
      `${entry.id}: shipped requires a verification reference (a test passes, not an interface exists)`,
    ).not.toBeNull();
    expect(
      existsSync(resolve(process.cwd(), entry.verification as string)),
      `${entry.id}: verification file must exist: ${entry.verification}`,
    ).toBe(true);
  }
  if (entry.verification !== null) {
    expect(
      existsSync(resolve(process.cwd(), entry.verification)),
      `${entry.id}: verification file must exist: ${entry.verification}`,
    ).toBe(true);
  }
}

describe("capability registry (#1395)", () => {
  it("every entry carries the full approved shape", () => {
    expect(CAPABILITY_REGISTRY.length).toBeGreaterThan(0);
    for (const entry of CAPABILITY_REGISTRY) assertEntryShape(entry);
  });

  it("entry ids are unique", () => {
    const ids = CAPABILITY_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every stage has at least one shipped entry", () => {
    for (const stage of STAGES) {
      const shipped = CAPABILITY_REGISTRY.filter(
        (e) => e.stage === stage && e.status === "shipped",
      );
      expect(
        shipped.length,
        `stage ${stage} needs at least one shipped entry`,
      ).toBeGreaterThan(0);
    }
  });

  it("news stays contract-only: present, never shipped", () => {
    const news = CAPABILITY_REGISTRY.find((e) => e.id === "feed-dataprovider-news");
    expect(news).toBeDefined();
    expect(news?.status).not.toBe("shipped");
    expect(news?.verification).toBeNull();
  });

  it("CSV generation ships: the #1346 generator postdates the inventory", () => {
    const csv = CAPABILITY_REGISTRY.find((e) => e.id === "generate-screener-csv");
    expect(csv).toBeDefined();
    expect(csv?.status).toBe("shipped");
    expect(csv?.verification).toBe("tests/sharded_jobs_p1355.test.ts");
  });

  it("channel delivery ships: #1279/#1399 merged, tests on main", () => {
    const channel = CAPABILITY_REGISTRY.find((e) => e.id === "deliver-channel");
    expect(channel).toBeDefined();
    expect(channel?.status).toBe("shipped");
    expect(channel?.verification).toBe("tests/channel_consolidation.test.ts");
  });

  it("worked examples resolve against the registry", () => {
    for (const example of WORKED_EXAMPLES) {
      for (const step of example.steps) {
        const matches = CAPABILITY_REGISTRY.filter(
          (e) =>
            e.stage === step.stage &&
            step.entryIds.includes(e.id) &&
            (e.status === "shipped" || e.status === "in_flight"),
        );
        expect(
          matches.length,
          `${example.id}: stage ${step.stage} must resolve to a shipped or in-flight entry`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("NASDAQ100 → Slack example delivers via Slack only", () => {
    const example = WORKED_EXAMPLES.find(
      (e) => e.id === "example-nasdaq100-slack",
    );
    expect(example).toBeDefined();
    const deliver = example?.steps.find((s) => s.stage === "deliver");
    expect(deliver?.entryIds).toEqual(["deliver-slack"]);
    expect(example?.steps.map((s) => s.stage)).toEqual([
      "feed",
      "generate",
      "store",
      "serve",
      "deliver",
    ]);
  });

  it("yesterday's report by email is serve → deliver only, no regeneration", () => {
    const example = WORKED_EXAMPLES.find(
      (e) => e.id === "example-yesterday-report-email",
    );
    expect(example).toBeDefined();
    expect(example?.steps.map((s) => s.stage)).toEqual(["serve", "deliver"]);
  });

  it("both scheduling substrates are recorded without picking one (Phase 3 decides)", () => {
    expect(SCHEDULING_SUBSTRATES.map((s) => s.id).sort()).toEqual([
      "schedule-nlq-agents-api",
      "schedule-scheduled-agent",
    ]);
    for (const substrate of SCHEDULING_SUBSTRATES) {
      expect(substrate.decision).toMatch(/Phase 3/);
    }
  });

  it("plan-level composition memory ships with Phase 4 (#1461), vector recall stays unverified", () => {
    const composition = COMPOSITION_MEMORY.find(
      (e) => e.id === "memory-plan-composition",
    );
    // Phase 4 (#1461) implements it: tests/composition_memory.test.ts
    // pins record → recall → reuse + serve-leg resolution.
    expect(composition?.status).toBe("shipped");
    expect(composition?.verification).toBe("tests/composition_memory.test.ts");
    const vectorRecall = COMPOSITION_MEMORY.find(
      (e) => e.id === "memory-vector-recall",
    );
    // Vectors exist in src, but no test exercises recallForPlan
    // itself, so the verification rule forbids marking it shipped.
    expect(vectorRecall?.status).toBe("in_flight");
    expect(vectorRecall?.verification).toBeNull();
  });

  it("composed-chain and goal-compiler MCP tools ship with Phase 5 (#1466)", () => {
    expect(MCP_CHAIN_STATUS.chainTool).toBe("shipped");
    expect(MCP_CHAIN_STATUS.goalTool).toBe("shipped");
  });
});
